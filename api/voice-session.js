// /api/voice-session: the page's WebRTC offer in, as JSON { sdp }, OpenAI's answer out (Phase 10).
//
// This is OpenAI's "unified" way of starting a call: the browser makes an offer, our function sends
// it to OpenAI with the key and the session, and OpenAI's answer goes back to the browser. After that
// the audio and the events go straight between the browser and OpenAI - this function is one hop at
// the start, a few kilobytes, and then it is done. The other way, an ephemeral key handed to the page,
// would put a ten-minute key in the browser and need the page's Content-Security-Policy opened to
// api.openai.com. This way the policy stays exactly as it is and no key of any kind reaches the page.
//
// The order is the contract: the write gate, OPENAI_API_KEY and settings that make sense, a real
// offer, then OpenAI. Starting a call spends the owner's money, so it is held to the write gate like
// Make it is. It never writes the picture store - not a name, not a count - and works without one:
// the store is only asked, from its cached copy, what the assistant is called.
//
// The key goes to OpenAI in one header and nowhere else. Nothing OpenAI sends back is passed on as
// words - every failure is one of our own sentences - and nothing here writes to the logs. Every
// answer, refusals included, carries `private, no-store`: Vercel's CDN keys what it keeps on the URL,
// not on the view key, so anything it kept here could be handed to somebody without one.

import { createHash } from 'node:crypto'
import { writeGate, readJsonBody, readCapped } from './lib.js'
import { pictureStore } from './_picture-store.js'
import { voiceConfig, sessionFor, assistantLabel, signTicket, newSessionId } from './_voice.js'

export const CALLS_URL = 'https://api.openai.com/v1/realtime/calls'
// A browser's offer is 5 to 10 KB. Twice the largest, and nothing like room for anything else.
const MAX_OFFER_BYTES = 16 * 1024
const MAX_ANSWER_BYTES = 64 * 1024
const MAX_REFUSAL_BYTES = 64 * 1024
// Starting a call is one small request; past this the person is better off tapping again.
const OPENAI_TIMEOUT_MS = 15_000
// The assistant's name is worth a short wait and never the call: a slow store costs the name.
const NAME_WAIT_MS = 1500

// Word for word what the plan promises the owner, because the README repeats it.
export const SPEND_LIMIT =
  'OpenAI\'s spending limit for this key is reached, so voice is off until next month or until you raise it.'

const SAY = {
  notOffer: 'That is not a call offer from a browser, so nothing was started. Tap the orb again.',
  tooBig: 'That call offer is far bigger than a browser makes, so nothing was started.',
  key: 'OpenAI did not accept OPENAI_API_KEY for voice, so check the key (and that its project can use the realtime models) in Vercel and redeploy.',
  limit: 'OpenAI says this key has hit its rate limit or run out of credit, so wait a minute or check your OpenAI account.',
  slow: 'OpenAI took too long to start the call, so tap the orb to try again.',
  failed: 'OpenAI did not start the call, so tap the orb to try again in a minute.',
  notAnswer: 'OpenAI answered with something that is not a call, so nothing was started. Tap the orb to try again.'
}

const timedOut = (error) => error?.name === 'TimeoutError' || error?.name === 'AbortError'

// The offer, from { "sdp": "v=0..." } sent as JSON. Not as application/sdp, the type an offer
// usually travels as: Vercel's Node runtime reads every request body before the function runs and
// hands over only the types it parses - JSON, octet-stream, forms and plain text - so an SDP body
// arrives as nothing at all, on a stream that is already empty. JSON is parsed for us, and it is a
// type a cross-site form cannot send without the browser asking first (see writeGate).
function readOffer(request) {
  const body = readJsonBody(request)
  const sdp = body?.sdp
  if (typeof sdp !== 'string') return { error: SAY.notOffer, status: 400 }
  if (Buffer.byteLength(sdp, 'utf8') > MAX_OFFER_BYTES) return { error: SAY.tooBig, status: 413 }
  // Every session description starts with its version line. Beside it, the one other thing read:
  // whether the page is on a computer - exactly true, or it is not - which can only turn the echo
  // guard's transcript on (sessionFor). Anything else in the body is not read at all.
  return /^v=0\r?\n/.test(sdp) ? { offer: sdp, finePointer: body.finePointer === true } : { error: SAY.notOffer, status: 400 }
}

// The assistant's name from the store's cached copy, or '' - which the session calls "your
// assistant" - when there is no store, it fails, or it is slow. Never a write.
async function nameFrom(pictures, waitMs) {
  if (!pictures) return ''
  let timer
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(''), waitMs)
    timer.unref?.()
  })
  try {
    const read = pictures.readSettings().then(({ settings }) => settings?.assistantName ?? '', () => '')
    return await Promise.race([read, late])
  } finally {
    clearTimeout(timer)
  }
}

// OpenAI asks for a stable, non-identifying id for whoever is using the app. One board is one owner,
// so it is a hash of the repo the board reads: the same every call, and not the repo's name.
const safetyIdentifier = (env) =>
  createHash('sha256').update(`${env.GITHUB_OWNER ?? ''}/${env.GITHUB_REPO ?? ''}`).digest('hex')

// OpenAI's error answer is read only to choose one of our sentences, never to repeat it.
async function refusalFor(upstream) {
  let detail = {}
  try {
    const text = upstream.body ? await readCapped(upstream.body, MAX_REFUSAL_BYTES) : null
    detail = text ? JSON.parse(text.toString('utf8'))?.error ?? {} : {}
  } catch {
    detail = {}
  }
  if (upstream.status === 429) {
    const spendLimit = [detail.code, detail.type].includes('project_spend_limit_exceeded')
    return { status: 429, error: spendLimit ? SPEND_LIMIT : SAY.limit }
  }
  if (upstream.status === 401 || upstream.status === 403) return { status: 502, error: SAY.key }
  return { status: 502, error: SAY.failed }
}

// `store` is injected by the tests; left undefined, it is built from the environment on each request
// (null when no store is connected). `sessionId` and `nameWaitMs` are injectable for the same reason.
export function makeHandler({ store, env, now = () => new Date(), loadSdk, sessionId = newSessionId, nameWaitMs = NAME_WAIT_MS } = {}) {
  return async function handler(request, response) {
    const environment = env ?? process.env
    // First, before any answer can be sent: nothing this endpoint says may be kept by a shared cache.
    response.setHeader('Cache-Control', 'private, no-store')
    if (String(request?.method ?? 'GET').toUpperCase() !== 'POST') {
      response.setHeader('Allow', 'POST')
      response.status(405).json({ error: 'POST { "sdp": "<the browser\'s call offer>" } as application/json.' })
      return
    }

    const denied = writeGate(request, environment)
    if (denied) {
      const { status, ...answer } = denied
      response.status(status).json(answer)
      return
    }
    const config = voiceConfig(environment)
    if (!config.on) {
      response.status(503).json({ error: config.why })
      return
    }
    const read = readOffer(request)
    if (read.error) {
      response.status(read.status).json({ error: read.error })
      return
    }

    const pictures = store !== undefined ? store : pictureStore(environment, loadSdk)
    const name = assistantLabel(await nameFrom(pictures, nameWaitMs))
    const apiKey = environment.OPENAI_API_KEY

    const form = new FormData()
    form.set('sdp', read.offer)
    form.set('session', JSON.stringify(sessionFor(config, name, { finePointer: read.finePointer })))
    let upstream
    try {
      upstream = await fetch(CALLS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'OpenAI-Safety-Identifier': safetyIdentifier(environment) },
        body: form,
        signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS)
      })
    } catch (error) {
      // The error's own message is not looked at: it can carry whatever the request carried.
      const slow = timedOut(error)
      response.status(slow ? 504 : 502).json({ error: slow ? SAY.slow : SAY.failed })
      return
    }
    if (!upstream.ok) {
      const { status, error } = await refusalFor(upstream)
      response.status(status).json({ error })
      return
    }

    let answer = null
    try {
      const bytes = upstream.body ? await readCapped(upstream.body, MAX_ANSWER_BYTES) : null
      answer = bytes ? bytes.toString('utf8') : null
    } catch (error) {
      const slow = timedOut(error)
      response.status(slow ? 504 : 502).json({ error: slow ? SAY.slow : SAY.notAnswer })
      return
    }
    // An answer is a session description, and never one that carries the key back to the page.
    if (!answer || !/^v=0\r?\n/.test(answer) || answer.includes(apiKey)) {
      response.status(502).json({ error: SAY.notAnswer })
      return
    }

    const ticket = signTicket({
      sid: sessionId(),
      iat: now().getTime(),
      mouth: config.mouth,
      model: config.model,
      ...(config.mouth === 'fish' ? { fishModel: config.fishModel } : {})
    }, apiKey)
    response.status(200).json({
      sdp: answer,
      ticket,
      mouth: config.mouth,
      model: config.model,
      name,
      idleMinutes: config.idleMinutes,
      captions: config.captions,
      echoGuard: config.echoGuard
    })
  }
}

export default makeHandler()
