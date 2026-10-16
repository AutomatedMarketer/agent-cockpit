// "Once per request id" for /api/fire. Starts with "_" so Vercel does not turn it into an endpoint.
//
// A voice order has a card id, and the page sends it as `requestId`. If the same id reaches the board
// twice - a double spoken yes, a tap plus a yes, a client retry after a slow answer - the second is
// answered with the first one's answer and nothing is fired, filed or queued again.
//
// Only an answer that went through (a 2xx) is remembered. A refusal is forgotten at once, so the
// retry after "wrong fire key" or "the routine said no" still goes. A request already running when
// its twin arrives is waited for, then answered the same way.
//
// The id alone is not enough: it is remembered with a fingerprint (a hash) of the whole order. The same id
// with the same order replays the first answer. The same id with a different order is a conflict (409)
// and nothing runs - an id never stands in for an order it was not made for.
//
// Memory, not a store: it is kept by the running function instance for ten minutes. Vercel does not
// promise that two requests land on the same warm instance, so this catches a double send that does, but
// is not a promise across a cold start or a second instance. The page's own one-send-per-card guard is
// the first line; this is the second.

export const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/
import { createHash } from 'node:crypto'

export const REQUEST_ID_WORDS = 'requestId must be 8 to 64 letters, numbers, dashes or underscores.'
const KEEP_MS = 10 * 60 * 1000
const MAX_KEPT = 200

const seen = new Map()
export const CONFLICT_WORDS = 'Conflict: that request id was already used for a different order, so nothing was sent.'

// The same order gives the same fingerprint whatever order its keys were written in.
const stable = (value) => (Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value)
export const fingerprintOf = (order) => createHash('sha256').update(JSON.stringify(stable(order))).digest('hex')

// undefined: no id sent (the board's own buttons). null: one was sent and is not a plain short id.
export function readRequestId(value) {
  if (value === undefined) return undefined
  return typeof value === 'string' && REQUEST_ID.test(value) ? value : null
}

function prune(now) {
  for (const [id, entry] of seen) {
    if (entry.answer && now - entry.at > KEEP_MS) seen.delete(id)
  }
  while (seen.size > MAX_KEPT) seen.delete(seen.keys().next().value)
}

// Runs `run(response)` for the first request with this id; any other gets the first one's answer.
export async function once(id, fingerprint, response, run, now = () => Date.now()) {
  for (;;) {
    prune(now())
    const known = seen.get(id)
    if (!known) break
    if (known.fingerprint !== fingerprint) {
      response.status(409).json({ error: CONFLICT_WORDS })
      return
    }
    if (known.answer) {
      response.status(known.answer.status).json({ ...known.answer.body, duplicate: true })
      return
    }
    await known.settled
  }

  let settle
  const entry = { at: now(), fingerprint, answer: null, settled: new Promise((resolve) => { settle = resolve }) }
  seen.set(id, entry)
  const seenAnswer = { status: null, body: null }
  // The same three calls the handler makes on a response, each also written down.
  const tee = {
    setHeader: (name, value) => response.setHeader(name, value),
    status(code) {
      seenAnswer.status = code
      return this
    },
    json(payload) {
      seenAnswer.body = payload
      response.status(seenAnswer.status).json(payload)
      return this
    }
  }
  try {
    await run(tee)
  } finally {
    const went = Number.isInteger(seenAnswer.status) && seenAnswer.status >= 200 && seenAnswer.status < 300 && seenAnswer.body
    if (went) entry.answer = { status: seenAnswer.status, body: seenAnswer.body }
    else seen.delete(id)
    settle()
  }
}
