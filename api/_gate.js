// The two gates every endpoint passes through: may this person see the board, and may they change
// it. Starts with "_" so Vercel does not turn it into an endpoint.
//
// Vercel's "Standard Protection" leaves the production address open, so the board closes itself:
// it answers nobody it cannot recognise. (Vercel Authentication on "All Deployments" now closes that
// address too, free on every plan - the README says how - but one dropdown can be switched off
// again, so the board stays locked on its own.)
//
// Someone is recognised by either of two things:
// - the signed-in cookie a browser keeps after the sign-in form (api/_session.js), which the page's
//   own requests carry by themselves because they are same-site;
// - the view key in the x-view-key header, for scripts - and the spare key to sign in with.

import { keysMatch, isSameOriginRequest } from './_lib.js'
import { readSessionCookie, verifySession, renewedSessionToken, sessionCookie } from './_session.js'
import { pictureStore } from './_picture-store.js'

const SIGNED_OUT =
  'Signed out: reload the board and sign in again. (Scripts: send the view key in the x-view-key header.)'

// The moment of the last "sign out everywhere", as this server last read it from the picture store.
//
// Read at most once every SIGN_OUT_RECHECK_MS. Every read of the store is billed - Hobby includes
// 10,000 a month and locks the store for 30 days past them - and a read on every signed-in request
// came to about 1,440 a day with the Readiness wall open (review, 2026-10-10). So another server
// finds out about a press within 10 minutes, plus the store's own minute of caching; the server
// that saved it knows at once (noteSignOut). Changing BOARD_PASSWORD or VIEW_KEY is the instant
// sign-out, and needs no store.
//
// A store that cannot be read is not a reason to lock the owner out of a board whose data comes from
// GitHub, so a failed read keeps the last moment this server saw: "never", until it has seen one.
// It only ever moves forward: an older moment read later - a stale cached copy, another server's
// slow clock - never lets back in a device this server already knows was signed out.
export const SIGN_OUT_RECHECK_MS = 10 * 60_000
let lastSignOutSeen = 0
let lastChecked = -Infinity

export function forgetSignOuts() {
  lastSignOutSeen = 0
  lastChecked = -Infinity
}

// What the server that saved a "sign out everywhere" knows without reading it back.
export function noteSignOut(moment, now = Date.now()) {
  lastSignOutSeen = Math.max(lastSignOutSeen, moment)
  lastChecked = now
}

async function signedOutBefore(env, store, now) {
  if (now - lastChecked < SIGN_OUT_RECHECK_MS) return lastSignOutSeen
  const pictures = store !== undefined ? store : pictureStore(env)
  if (!pictures) return lastSignOutSeen
  // Marked before the read, so requests arriving while it is out use what is known rather than each
  // starting a read of their own; a failed read is not tried again for 10 minutes either.
  lastChecked = now
  try {
    const { settings } = await pictures.readSettings()
    const moment = Number.isSafeInteger(settings?.sessionsValidFrom) ? settings.sessionsValidFrom : 0
    lastSignOutSeen = Math.max(lastSignOutSeen, moment)
  } catch {
    // Kept as it was: see above.
  }
  return lastSignOutSeen
}

// The signed-in session a request carries, or null. Checked first against what this server already
// knows, which costs nothing, so a stranger - with no cookie or a made-up one - never costs a store
// read. Only then, and only when `checkSignOut` is on, is the store asked (at most every 10 minutes).
async function sessionOf(request, env, store, checkSignOut) {
  const token = readSessionCookie(request?.headers)
  if (!token) return null
  const now = Date.now()
  const known = verifySession(token, env, { now, signedOutBefore: lastSignOutSeen })
  if (!known || !checkSignOut) return known
  return verifySession(token, env, { now, signedOutBefore: await signedOutBefore(env, store, now) })
}

// Returns null when the request may proceed, or {status, error, needs?} to send back. Closed is the
// default: a deployment with no VIEW_KEY refuses to serve rather than serving a private repo to the
// open web - the failure mode has to be silence, not exposure. PUBLIC_DASHBOARD=true is the
// deliberate, documented way out.
//
// `store` is the picture store, where "sign out everywhere" is kept (the endpoints that already have
// one hand it in; left out, it is built from the environment). `response`, when given, receives a
// fresh cookie for a session over a day old, so an active phone never reaches its 30 days.
//
// `checkSignOut: false` is for one answer only: /api/state's "nothing has changed since the commit
// you hold", which carries no board at all. It still refuses a session this server already knows
// was signed out; it just does not ask the store, and it never renews a cookie.
export async function viewGate(request, env = process.env, { store, response, checkSignOut = true } = {}) {
  if (env.PUBLIC_DASHBOARD === 'true') return null
  if (!env.VIEW_KEY) {
    return {
      status: 503,
      error:
        'This dashboard is not configured. Set VIEW_KEY in your hosting environment and ' +
        'redeploy, or set PUBLIC_DASHBOARD=true if this repo is genuinely public.'
    }
  }
  const provided = request?.headers?.['x-view-key'] ?? request?.headers?.['X-View-Key']
  if (typeof provided === 'string' && provided && keysMatch(provided, env.VIEW_KEY)) return null
  const session = await sessionOf(request, env, store, checkSignOut)
  if (!session) return { status: 401, needs: 'sign-in', error: SIGNED_OUT }
  const renewed = response && checkSignOut ? renewedSessionToken(session, env) : null
  if (renewed) response.setHeader('Set-Cookie', sessionCookie(renewed))
  return null
}

// --- the write gate ----------------------------------------------------------------
// The board's only write power is over its own picture store (spec 5c): pictures, names, the
// art style. Never the business repo - the GitHub token stays read-only. Even so, a write is
// held to more than a read, in this order, and the order is part of the contract: a stranger
// with no key learns only that a key is missing, never which later check they would also fail.
//
// 1. The view gate. Anyone who can read the board is, by default, trusted to dress it: they can
//    already read the business repo, and the worst a write does is change pictures the owner sees.
// 2. EDIT_KEY, when set, so an owner can share a read-only board. When the board is open to
//    everyone (PUBLIC_DASHBOARD=true) there is no first key at all, so writes stay off until
//    EDIT_KEY is set - otherwise anyone with the URL could spend the owner's OpenAI money.
// 3. Same origin, so another site's page cannot ride a viewer's browser into a write. With the
//    signed-in cookie this matters more, not less: the browser proves who you are by itself. The
//    cookie is SameSite=Strict as well, so it is not even sent from another site.
// 4. The exact body type the endpoint reads. text/plain, urlencoded and multipart are what a
//    cross-site form can send without the browser asking us first; JSON and octet-stream make
//    the browser ask (a CORS preflight), and this board never answers yes.
//
// Returns null when the write may go ahead, or {status, error, needs?} to send back. `needs`
// is how the page knows to ask for the edit key - and the only time it should.
export async function writeGate(request, env = process.env, bodyType = 'application/json', { store } = {}) {
  const denied = await viewGate(request, env, { store })
  if (denied) return denied
  const headers = request?.headers ?? {}
  if (env.EDIT_KEY) {
    const provided = headers['x-edit-key']
    if (!keysMatch(typeof provided === 'string' ? provided : '', env.EDIT_KEY)) {
      return {
        status: 401,
        needs: 'edit-key',
        error: 'Missing or wrong edit key. Send it in the x-edit-key header.'
      }
    }
  } else if (env.PUBLIC_DASHBOARD === 'true') {
    return {
      status: 403,
      error:
        'This board is open to everyone, so changes are off. Set EDIT_KEY in your hosting ' +
        'environment and redeploy to turn them on.'
    }
  }
  if (!isSameOriginRequest(headers)) {
    return { status: 403, error: 'Changes are only accepted from the board itself.' }
  }
  const essence = String(headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (essence !== bodyType) {
    return { status: 415, error: `Send this as Content-Type: ${bodyType}.` }
  }
  return null
}
