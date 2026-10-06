// /api/brand: the board's own names for things, kept in its picture store (spec 5c).
//
// GET is how the page learns whether personalising is on at all, and what it should show: each
// agent's display name, the assistant's name, the art style, which pictures the owner has put in
// (by version, so each one can be fetched from /api/art and cached forever), and how much of
// today's allowance is left. One read of settings.json per page load, from the CDN's copy: a
// cache hit is free, and on an open board anyone can load the page as often as they like. That
// copy can be up to a minute behind a change made elsewhere; a POST is always answered from the
// state it just saved, so the person who made the change sees it at once.
//
// POST makes one change: { change: 'name' | 'assistant' | 'style' | 'reset-picture', slug?,
// slot?, value? }. An empty value means "back to the default" - the slug, no assistant name, the
// built-in art style. Every value is checked before the store is touched; a refused change costs
// nothing. The slug stays the routing key everywhere else - a display name only changes what a
// person sees, never which agent a job reaches.

import {
  viewGate,
  writeGate,
  readJsonBody,
  isValidSlug,
  parseSlot,
  cleanName,
  cleanStyle,
  DEFAULT_ART_STYLE
} from './lib.js'
import {
  pictureStore,
  emptySettings,
  NOT_CONNECTED,
  failureAnswer,
  dailyCaps,
  usageDay,
  allowanceLeft,
  spendAllowance,
  refuseIfSpent
} from './_picture-store.js'

export const NO_OPENAI =
  'Making pictures from words is off: set OPENAI_API_KEY in Vercel (the same key the voice ' +
  'assistant uses) and redeploy. Choosing your own picture still works.'

const CHANGES = 'change must be "name", "assistant", "style" or "reset-picture".'

// What the page is told. Pictures carry only what it needs to fetch one - never a store path
// or URL, which stay on the server.
function brandView(settings, { env, caps, day }) {
  const canGenerate = Boolean(env.OPENAI_API_KEY)
  const pictures = {}
  for (const [slot, picture] of Object.entries(settings.pictures)) {
    pictures[slot] = { v: picture.v, type: picture.type }
  }
  return {
    enabled: true,
    canGenerate,
    ...(canGenerate ? {} : { why: NO_OPENAI }),
    assistantName: settings.assistantName,
    artStyle: settings.artStyle,
    defaultArtStyle: DEFAULT_ART_STYLE,
    names: { ...settings.names },
    pictures,
    left: allowanceLeft(settings, caps, day)
  }
}

// Personalising off, with the reason. Same shape as on, so the page has one thing to read.
// `fault` marks a store that is connected but failing (a damaged settings file, a public store):
// the page shows that sentence, because "connect a store" would not be the fix.
function offView(why, context, fault = false) {
  return { ...brandView(emptySettings(), context), enabled: false, canGenerate: false, why, ...(fault ? { fault: true } : {}) }
}

// A value that is missing, null or only spaces means "back to the default", returned as ''.
// A value that is there must pass its check; null means it did not.
function cleanedOrDefault(value, clean) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') return null
  if (!value.trim()) return ''
  return clean(value)
}

// Turns a request body into a change to make, or a sentence saying why not. Pure, and run
// before the store is touched: nothing the person typed reaches the store unchecked.
export function planChange(body) {
  if (!body) return { error: `Send one change as JSON: ${CHANGES}` }
  switch (body.change) {
    case 'name': {
      if (!isValidSlug(body.slug)) return { error: 'slug must be the agent\'s slug, like "content".' }
      const name = cleanedOrDefault(body.value, cleanName)
      if (name === null) return { error: 'A name is 1 to 40 characters of plain text.' }
      const slug = body.slug
      return {
        apply(settings) {
          if (name) settings.names[slug] = name
          else delete settings.names[slug]
        }
      }
    }
    case 'assistant': {
      const name = cleanedOrDefault(body.value, cleanName)
      if (name === null) return { error: 'The assistant\'s name is 1 to 40 characters of plain text.' }
      return { apply(settings) { settings.assistantName = name } }
    }
    case 'style': {
      const style = cleanedOrDefault(body.value, cleanStyle)
      if (style === null) return { error: 'The art style is up to 600 characters of plain text.' }
      return { apply(settings) { settings.artStyle = style } }
    }
    case 'reset-picture': {
      const slot = parseSlot(body.slot)
      if (!slot) return { error: 'slot must be "today", "team" or "agent-<slug>".' }
      return {
        slot,
        apply(settings) {
          const removed = settings.pictures[slot] ?? null
          delete settings.pictures[slot]
          return removed
        }
      }
    }
    default:
      return { error: CHANGES }
  }
}

// `store` is injected by the tests; left undefined, it is built from the environment on each
// request (null when no store is connected). `loadSdk` is passed through to that build.
export function makeHandler({ store, env, now = () => new Date(), loadSdk } = {}) {
  return async function handler(request, response) {
    const environment = env ?? process.env
    const method = String(request?.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'POST') {
      response.setHeader('Allow', 'GET, POST')
      response.status(405).json({ error: 'GET to read the board\'s names and pictures, POST to change one.' })
      return
    }
    // The answer is the board as it is right now; a cached one would show an old name.
    response.setHeader('Cache-Control', 'no-store')

    // The gate comes before anything else, the store included.
    const denied = method === 'GET' ? viewGate(request, environment) : writeGate(request, environment)
    if (denied) {
      const { status, ...answer } = denied
      response.status(status).json(answer)
      return
    }

    const context = { env: environment, caps: dailyCaps(environment), day: usageDay(now()) }
    const pictures = store !== undefined ? store : pictureStore(environment, loadSdk)

    if (method === 'GET') {
      if (!pictures) {
        response.status(200).json(offView(NOT_CONNECTED, context))
        return
      }
      try {
        const { settings } = await pictures.readSettings()
        response.status(200).json(brandView(settings, context))
      } catch (error) {
        // A store that will not answer turns personalising off with its reason - the board's
        // built-in pictures and slugs still show, which is what "off" looks like.
        response.status(200).json(offView(failureAnswer(error).error, context, true))
      }
      return
    }

    if (!pictures) {
      response.status(503).json({ error: NOT_CONNECTED })
      return
    }
    const plan = planChange(readJsonBody(request))
    if (plan.error) {
      response.status(400).json({ error: plan.error })
      return
    }

    try {
      let removed = null
      const charge = (settings) => spendAllowance(settings, 'writes', context.caps, context.day)
      await refuseIfSpent(pictures, charge)
      const saved = await pictures.saveSettings((draft) => {
        charge(draft)
        removed = plan.apply(draft) ?? null
      })
      // Pointer first, picture second, and only once the pointer is gone. The other order, if
      // the save then failed, would leave settings.json pointing at a deleted file. A delete
      // that fails here leaves a file nobody points at: untidy, never broken.
      if (removed) await pictures.dropPicture(plan.slot, removed.v, removed.type).catch(() => {})
      response.status(200).json(brandView(saved, context))
    } catch (error) {
      const { status, error: sentence } = failureAnswer(error)
      response.status(status).json({ error: sentence })
    }
  }
}

export default makeHandler()
