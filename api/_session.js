// The "remember this device" session: what the board's sign-in leaves in the browser, and how the
// server decides to believe it (spec 2026-10-10, "Moving from key in the browser + header to a
// cookie"). Starts with "_" so Vercel does not turn it into an endpoint.
//
// The cookie holds three numbers and a signature, nothing else:
//   a - when this device signed in. Kept unchanged when the cookie is renewed, so it is the
//       session's generation: "sign out everywhere" refuses every session signed in before it.
//   i - when this cookie was issued. Renewed once a day while the board is used.
//   e - when it expires: always i + 30 days.
// It is base64url(JSON) + "." + base64url(HMAC-SHA256), the same shape as the voice ticket, under a
// different key and a different label so neither can stand in for the other.
//
// The signing secret is never stored anywhere. It is derived from VIEW_KEY and BOARD_PASSWORD, so
// there is no new secret for anybody to make, and changing either one signs every device out.

import { createHmac, timingSafeEqual } from 'node:crypto'

// __Host-: the browser only accepts it from this exact site, over HTTPS, for the whole site - so
// another site on the same parent domain (anything else on vercel.app) cannot plant one.
export const SESSION_COOKIE = '__Host-cockpit_session'
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
const SESSION_MS = SESSION_MAX_AGE_SECONDS * 1000
// An active phone is never signed out: a cookie more than a day old is replaced on the next load.
export const RENEW_AFTER_MS = 24 * 3600_000
// Servers' clocks differ a little; a cookie issued a few minutes "in the future" is still ours.
const CLOCK_SKEW_MS = 5 * 60_000
const TOKEN_SHAPE = /^([A-Za-z0-9_-]{1,200})\.([A-Za-z0-9_-]{43})$/

function sessionSecret(env = process.env) {
  const viewKey = env?.VIEW_KEY
  if (typeof viewKey !== 'string' || !viewKey) return null
  const password = typeof env.BOARD_PASSWORD === 'string' ? env.BOARD_PASSWORD : ''
  return createHmac('sha256', viewKey).update('agent-cockpit session v1\n').update(password).digest()
}

const mac = (secret, body) => createHmac('sha256', secret).update(`session.v1.${body}`).digest()

// Signs exactly the numbers it is given. What makes a session believable is decided in
// verifySession, never here, so a test can sign something the server would never write and prove
// it is still refused.
export function signSession({ auth, issued, expires = issued + SESSION_MS }, env = process.env) {
  const secret = sessionSecret(env)
  if (!secret) return null
  const body = Buffer.from(JSON.stringify({ a: auth, i: issued, e: expires })).toString('base64url')
  return `${body}.${mac(secret, body).toString('base64url')}`
}

// A device that has just signed in.
export const newSessionToken = (env, now = Date.now()) => signSession({ auth: now, issued: now }, env)

// A fresh cookie for a session in use, once it is a day old: null while it is younger. The sign-in
// time is carried over unchanged, so a renewal by a server that has not yet heard of "sign out
// everywhere" is refused as soon as it has.
export function renewedSessionToken(session, env, now = Date.now()) {
  if (!session || now - session.issued < RENEW_AFTER_MS) return null
  return signSession({ auth: session.auth, issued: now }, env)
}

// { auth, issued, expires } for a session this server signed that is still good, or null. `now` and
// `signedOutBefore` (the moment of the last "sign out everywhere", 0 for never) are handed in.
export function verifySession(token, env = process.env, { now = Date.now(), signedOutBefore = 0 } = {}) {
  if (typeof token !== 'string') return null
  const parts = TOKEN_SHAPE.exec(token)
  const secret = sessionSecret(env)
  if (!parts || !secret) return null
  const given = Buffer.from(parts[2], 'base64url')
  const wanted = mac(secret, parts[1])
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null
  let claims
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
  const { a: auth, i: issued, e: expires } = claims ?? {}
  if (![auth, issued, expires].every(Number.isSafeInteger)) return null
  if (auth > issued || expires !== issued + SESSION_MS) return null
  if (issued > now + CLOCK_SKEW_MS || now >= expires) return null
  if (auth <= signedOutBefore) return null
  return { auth, issued, expires }
}

// The Set-Cookie value that keeps a session on this device, and the one that takes it away.
// Max-Age rather than Expires: it is counted on the device's own clock, not ours.
export const sessionCookie = (token) =>
  `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`
export const clearedSessionCookie = () => `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`

// The session cookie's value from a request's Cookie header, by its exact name, or null.
export function readSessionCookie(headers) {
  const header = headers?.cookie
  if (typeof header !== 'string') return null
  for (const pair of header.split(';')) {
    const at = pair.indexOf('=')
    if (at < 0) continue
    if (pair.slice(0, at).trim() === SESSION_COOKIE) return pair.slice(at + 1).trim() || null
  }
  return null
}
