// /api/generate: { slot, description } -> a picture made by OpenAI's image model, in the board's
// art style, sent back to the browser as bytes (spec 5c).
//
// It does not store anything. The browser shrinks the picture and sends it to /api/upload, the
// same way as a picture the owner chose, so every stored picture passes the same checks.
//
// This is the one endpoint that spends the owner's money, so it spends only after every check:
// the write gate, a store (the count lives there), OPENAI_API_KEY, a real slot and description,
// and today's allowance - which is counted BEFORE OpenAI is called, so a failing or slow upstream
// cannot be retried past the cap either. That includes a change left today: a made picture is
// kept by an upload, which is a change, so with none left OpenAI would be paid for a picture the
// board could not keep.
//
// The key goes to OpenAI in one header and nowhere else. Nothing OpenAI sends back is passed on
// as text - every failure is one of our own sentences - and nothing here writes to the logs.

import {
  writeGate,
  readJsonBody,
  parseSlot,
  slotKind,
  cleanDescription,
  sniffImage,
  readCapped,
  DEFAULT_ART_STYLE
} from './lib.js'
import {
  pictureStore,
  NOT_CONNECTED,
  failureAnswer,
  dailyCaps,
  usageDay,
  allowanceLeft,
  spendAllowance,
  PictureStoreError
} from './_picture-store.js'

const ENDPOINT = 'https://api.openai.com/v1/images/generations'
const DEFAULT_MODEL = 'gpt-image-1-mini'
// The whole request - the store save, OpenAI, reading its answer - must end under vercel.json's
// maxDuration of 60 s, so a slow answer ends as our sentence, not the platform's timeout page.
// OpenAI gets whatever is left of this when it is called, not a fixed amount on top of the save.
const HANDLER_BUDGET_MS = 55_000
// Vercel caps a function's response at 4.5 MB.
const MAX_PICTURE_BYTES = 4 * 1024 * 1024
const MAX_BASE64_LENGTH = Math.ceil(MAX_PICTURE_BYTES / 3) * 4
// OpenAI's answer is read no further than the largest picture it may carry plus room for the rest
// of its JSON, so an answer that is too big, or never ends, is never held whole.
const MAX_ANSWER_BYTES = MAX_BASE64_LENGTH + 64 * 1024
const MAX_REFUSAL_BYTES = 64 * 1024

// Reads an answer as JSON, no further than `limit`. Null when it is too big; throws when it is
// not JSON, or when the time ran out while reading.
async function cappedJson(upstream, limit) {
  if (!upstream.body) return undefined
  const text = await readCapped(upstream.body, limit)
  return text === null ? null : JSON.parse(text.toString('utf8'))
}
const timedOut = (error) => error?.name === 'TimeoutError' || error?.name === 'AbortError'

const NO_CHANGE_LEFT =
  'No changes are left today to keep a new picture with, so nothing was made and nothing was ' +
  'spent: try again tomorrow (the count starts again at midnight UTC).'

export const NO_OPENAI_KEY =
  'Making pictures from words needs OPENAI_API_KEY: set it in Vercel (the same key the voice ' +
  'assistant uses) and redeploy.'

const SAY = {
  safety: 'OpenAI would not make that picture because of its safety rules, so describe it differently.',
  refused: 'OpenAI could not make a picture from that description, so try describing it differently.',
  key: 'OpenAI did not accept OPENAI_API_KEY, so check the key in Vercel and redeploy.',
  limit: 'OpenAI says this key has hit its limit or run out of credit, so check your OpenAI account or try again later.',
  slow: 'OpenAI took too long to make the picture, so try again.',
  failed: 'OpenAI did not make the picture, so try again in a minute.',
  notPicture: 'OpenAI sent back something that is not a picture, so try again.',
  tooBig: 'OpenAI sent back a picture too big to pass on, so try again.'
}

// What each kind of picture is asked to be: the shape the page will crop it to, and where the
// page puts words over it. Repeated after the owner's style, because their style may not say it.
const COMPOSITION = {
  portrait: 'Composition: a square portrait of one subject, centred, against a simple background. No text or lettering.',
  banner: 'Composition: a wide 21:9 scene, with calm open space on the left where text will sit. No text or lettering.'
}
const SIZE = { portrait: '1024x1024', banner: '1536x1024' }

// The style first: image models weigh the opening of a prompt most.
export function imagePrompt(style, description, kind) {
  return `${style}\n\nThe picture: ${description}\n\n${COMPOSITION[kind]}`
}

// OpenAI's error answer is read only to choose one of our sentences, never to repeat it.
async function refusalFor(upstream) {
  let detail = {}
  try {
    detail = (await cappedJson(upstream, MAX_REFUSAL_BYTES))?.error ?? {}
  } catch {
    detail = {}
  }
  if (upstream.status === 400) {
    const said = `${detail.code ?? ''} ${detail.type ?? ''} ${detail.message ?? ''}`
    return { status: 400, error: /moderation|safety/i.test(said) ? SAY.safety : SAY.refused }
  }
  if (upstream.status === 401 || upstream.status === 403) return { status: 502, error: SAY.key }
  if (upstream.status === 429) return { status: 429, error: SAY.limit }
  return { status: 502, error: SAY.failed }
}

// The picture's bytes out of a successful answer, or a sentence saying why not.
async function pictureFrom(upstream) {
  let encoded
  try {
    const answer = await cappedJson(upstream, MAX_ANSWER_BYTES)
    if (answer === null) return { status: 502, error: SAY.tooBig }
    encoded = answer?.data?.[0]?.b64_json
  } catch (error) {
    return timedOut(error) ? { status: 504, error: SAY.slow } : { status: 502, error: SAY.notPicture }
  }
  if (typeof encoded !== 'string' || !encoded) return { status: 502, error: SAY.notPicture }
  if (encoded.length > MAX_BASE64_LENGTH + 4) return { status: 502, error: SAY.tooBig }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length > MAX_PICTURE_BYTES) return { status: 502, error: SAY.tooBig }
  const type = sniffImage(bytes)
  if (!type) return { status: 502, error: SAY.notPicture }
  return { bytes, type }
}

// `store` is injected by the tests; left undefined, it is built from the environment on each
// request (null when no store is connected).
export function makeHandler({ store, env, now = () => new Date(), loadSdk } = {}) {
  return async function handler(request, response) {
    const started = now().getTime()
    const environment = env ?? process.env
    if (String(request?.method ?? 'GET').toUpperCase() !== 'POST') {
      response.setHeader('Allow', 'POST')
      response.status(405).json({ error: 'POST { "slot": "<slot>", "description": "<what to paint>" }.' })
      return
    }
    // A made picture is for this one request; the browser keeps it, nothing else should.
    response.setHeader('Cache-Control', 'no-store')

    const denied = writeGate(request, environment)
    if (denied) {
      const { status, ...answer } = denied
      response.status(status).json(answer)
      return
    }

    const pictures = store !== undefined ? store : pictureStore(environment, loadSdk)
    if (!pictures) {
      response.status(503).json({ error: NOT_CONNECTED })
      return
    }
    const apiKey = environment.OPENAI_API_KEY
    if (!apiKey) {
      response.status(503).json({ error: NO_OPENAI_KEY })
      return
    }

    const body = readJsonBody(request)
    const slot = parseSlot(body?.slot)
    if (!slot) {
      response.status(400).json({ error: 'slot must be "today", "team" or "agent-<slug>".' })
      return
    }
    const description = cleanDescription(body.description)
    if (!description) {
      response.status(400).json({ error: 'Describe the picture in 3 to 400 characters of plain text.' })
      return
    }

    const kind = slotKind(slot)
    let style
    try {
      const caps = dailyCaps(environment)
      const day = usageDay(now())
      await pictures.saveSettings((draft) => {
        // Checked in the same save that counts the picture, so it is the count as it is now.
        if (allowanceLeft(draft, caps, day).writes === 0) throw new PictureStoreError(429, NO_CHANGE_LEFT)
        spendAllowance(draft, 'generated', caps, day)
        style = draft.artStyle || DEFAULT_ART_STYLE
      })
    } catch (error) {
      const { status, error: sentence } = failureAnswer(error)
      response.status(status).json({ error: sentence })
      return
    }

    // The save above may have been slow; OpenAI gets only what is left of the budget.
    const left = HANDLER_BUDGET_MS - (now().getTime() - started)
    if (left <= 0) {
      response.status(504).json({ error: SAY.slow })
      return
    }
    let upstream
    try {
      upstream = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: environment.OPENAI_IMAGE_MODEL || DEFAULT_MODEL,
          prompt: imagePrompt(style, description, kind),
          size: SIZE[kind],
          quality: 'medium',
          output_format: 'webp',
          output_compression: 80,
          n: 1
        }),
        signal: AbortSignal.timeout(left)
      })
    } catch (error) {
      // The error's own message is not looked at: it can carry whatever the request carried.
      const slow = timedOut(error)
      response.status(slow ? 504 : 502).json({ error: slow ? SAY.slow : SAY.failed })
      return
    }

    const made = upstream.ok ? await pictureFrom(upstream) : await refusalFor(upstream)
    if (!made.bytes) {
      response.status(made.status).json({ error: made.error })
      return
    }
    response.setHeader('Content-Type', made.type)
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.status(200).end(made.bytes)
  }
}

export default makeHandler()
