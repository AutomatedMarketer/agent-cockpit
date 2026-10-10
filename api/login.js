// Signing in: a username and password - or the spare key - in, a "remember this device" cookie out
// (spec 2026-10-10, "Login"). POST { "username": "...", "password": "..." } as JSON from the board's
// own page. 204 with the cookie when it matches; 401 with one sentence when it does not.
//
// What it accepts:
// - BOARD_USERNAME and BOARD_PASSWORD, set in Vercel. The username is checked only when it is set,
//   and is not fussy about capitals or spaces (a phone capitalises the first letter). The password
//   is exact. A BOARD_PASSWORD under MIN_PASSWORD_LENGTH characters is never accepted.
// - VIEW_KEY as the password, whatever the username: the spare key, for a lost password, a new
//   device, and the board's own move from the old saved key to the cookie.
//
// What it does about guessing, since a memorable password can be guessed and a 40-character key
// cannot (audit finding #3):
// - every check is a slow hash (scrypt, about 100 ms) compared in constant time, never plain text;
// - every failure waits FAIL_WAIT_MS more before it answers;
// - five failures from one address in 15 minutes stop that address for the rest of the 15 minutes,
//   the right password included. This count lives in this server's memory, so on its own it is
//   weak (each instance counts separately): the README's Vercel firewall rule on /api/login is the
//   layer in front of it, and Vercel Authentication the layer in front of that;
// - every refusal is the same sentence, so nothing says which part was wrong.
//
// It also refuses any request that did not come from the board itself, so another site cannot sign
// the owner in to a session of its choosing, and anything that is not JSON, which is what a plain
// HTML form on another site could send without the browser asking first.

import { scrypt, createHash, timingSafeEqual, randomBytes } from 'node:crypto'
import { keysMatch, isSameOriginRequest, readJsonBody } from './_lib.js'
import { newSessionToken, sessionCookie } from './_session.js'

export const MIN_PASSWORD_LENGTH = 12
export const FAIL_WAIT_MS = 400
// scrypt's recommended interactive cost: 16 MB of memory and about 100 ms a guess.
export const PASSWORD_HASH = { N: 16384, r: 8, p: 1, keylen: 32 }
const MAX_FIELD_LENGTH = 1024
const LIMIT = { failures: 5, windowMs: 15 * 60_000 }

const WRONG = 'That username and password did not match. Check them and try again, or use the spare key.'
const TOO_MANY = 'Too many wrong tries from here, so signing in is paused for 15 minutes. Try again after that.'
const NOT_CONFIGURED =
  'This dashboard is not configured. Set VIEW_KEY in your hosting environment and redeploy, or set ' +
  'PUBLIC_DASHBOARD=true if this repo is genuinely public.'
const PASSWORD_TOO_SHORT =
  `BOARD_PASSWORD is shorter than ${MIN_PASSWORD_LENGTH} characters, so the board will not use it: set a ` +
  `longer one in Vercel and redeploy. Until then, sign in with the spare key (your VIEW_KEY).`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function slowHash(text, salt) {
  return new Promise((resolve, reject) => {
    const { N, r, p, keylen } = PASSWORD_HASH
    scrypt(text, salt, keylen, { N, r, p }, (error, key) => (error ? reject(error) : resolve(key)))
  })
}

// The salt is this deployment's own, from VIEW_KEY: the same password on two boards hashes apart.
const saltFor = (env) => createHash('sha256').update('agent-cockpit board password\n').update(env.VIEW_KEY).digest()

// The hash of BOARD_PASSWORD is worked out once per server, not once per guess. With none set, a
// random stand-in is hashed instead, so a guess costs the same either way and can never match it.
let expected = { id: null, hash: null }
async function expectedHash(password, salt) {
  const set = typeof password === 'string' && password !== ''
  const id = set ? createHash('sha256').update(salt).update(password).digest('hex') : 'none'
  if (expected.id !== id) expected = { id, hash: await slowHash(set ? password : randomBytes(32), salt) }
  return expected.hash
}

// A BOARD_PASSWORD too short to trust is never accepted, whatever is typed.
const passwordUsable = (env) => typeof env.BOARD_PASSWORD === 'string' && env.BOARD_PASSWORD.length >= MIN_PASSWORD_LENGTH

const cleanUsername = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '')
const field = (value) => (typeof value === 'string' && value.length <= MAX_FIELD_LENGTH ? value : '')

// Every part is worked out, whichever one fails, so how long the answer takes says nothing about
// which part was wrong.
async function matches(body, env) {
  const salt = saltFor(env)
  const password = field(body?.password)
  const [given, wanted] = await Promise.all([slowHash(password, salt), expectedHash(env.BOARD_PASSWORD, salt)])
  const passwordRight = timingSafeEqual(given, wanted)
  const usernameRight = env.BOARD_USERNAME ? keysMatch(cleanUsername(field(body?.username)), cleanUsername(env.BOARD_USERNAME)) : true
  const spareKey = keysMatch(password.trim(), env.VIEW_KEY)
  return spareKey || (passwordUsable(env) && passwordRight && usernameRight)
}

// Who is asking, as Vercel saw them: x-real-ip, else the first x-forwarded-for. Vercel sets both
// itself and overwrites what a caller sends. Missing (a local run) is one shared address.
function addressOf(headers = {}) {
  const real = headers['x-real-ip']
  if (typeof real === 'string' && real.trim()) return real.trim()
  const forwarded = headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim()
  return 'unknown'
}

// Tries per address, in this server's memory, in fixed 15-minute windows from the first one.
//
// A try is TAKEN before anything is awaited, and a try still being checked counts against the
// limit until it is known not to have failed. Reading the count before the slow hash and writing
// it after let a burst through: 400 guesses sent at the same moment all read "no failures yet",
// and all were checked (review, 2026-10-10). Now the sixth of a burst is refused at once.
//
// Bounded: past maxAddresses the oldest is forgotten, so a flood of addresses cannot grow it.
export function makeLimiter({ failures = LIMIT.failures, windowMs = LIMIT.windowMs, maxAddresses = 10_000 } = {}) {
  const seen = new Map()
  const entryFor = (address, now) => {
    const entry = seen.get(address)
    // The window is over: failures start again from nothing; tries still in flight still count.
    if (entry && now - entry.first >= windowMs) {
      entry.first = now
      entry.count = 0
    }
    return entry ?? null
  }
  const create = (address, now) => {
    const entry = { first: now, count: 0, inFlight: 0 }
    seen.set(address, entry)
    while (seen.size > maxAddresses) seen.delete(seen.keys().next().value)
    return entry
  }
  return {
    // Takes one try for this address and returns 0, or returns the seconds it must wait. Never awaits.
    reserve(address, now) {
      const entry = entryFor(address, now) ?? create(address, now)
      if (entry.count >= failures) return Math.max(1, Math.ceil((entry.first + windowMs - now) / 1000))
      // Under the limit on failures, but this many are still being checked: a second will settle it.
      if (entry.count + entry.inFlight >= failures) return 1
      entry.inFlight += 1
      return 0
    },
    // A try that was taken turned out wrong.
    failed(address, now) {
      const entry = entryFor(address, now) ?? create(address, now)
      entry.inFlight = Math.max(0, entry.inFlight - 1)
      entry.count += 1
    },
    // A try that was taken turned out right: its place is given back and the failures forgotten.
    succeeded(address) {
      const entry = seen.get(address)
      if (!entry) return
      entry.inFlight = Math.max(0, entry.inFlight - 1)
      entry.count = 0
      if (entry.inFlight === 0) seen.delete(address)
    },
    size: () => seen.size
  }
}

const sharedLimiter = makeLimiter()

// `env`, `now`, `pause` and `limiter` are handed in by the tests; left out, they are the real ones.
export function makeHandler({ env, now = () => Date.now(), pause = sleep, limiter = sharedLimiter } = {}) {
  return async function handler(request, response) {
    const environment = env ?? process.env
    response.setHeader('Cache-Control', 'private, no-store')
    if (String(request?.method ?? 'GET').toUpperCase() !== 'POST') {
      response.setHeader('Allow', 'POST')
      response.status(405).json({ error: 'POST { "username": "...", "password": "..." } from the board\'s sign-in form.' })
      return
    }
    if (environment.PUBLIC_DASHBOARD === 'true') {
      response.status(400).json({ error: 'This board is open to everyone, so there is nothing to sign in to.' })
      return
    }
    if (!environment.VIEW_KEY) {
      response.status(503).json({ error: NOT_CONFIGURED })
      return
    }
    const headers = request?.headers ?? {}
    if (!isSameOriginRequest(headers)) {
      response.status(403).json({ error: 'Signing in is only accepted from the board itself.' })
      return
    }
    const essence = String(headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (essence !== 'application/json') {
      response.status(415).json({ error: 'Send this as Content-Type: application/json.' })
      return
    }

    const address = addressOf(headers)
    const moment = now()
    // Taken here, before the first await, so tries sent together cannot all read "none used yet".
    const wait = limiter.reserve(address, moment)
    if (wait > 0) {
      response.setHeader('Retry-After', String(wait))
      response.status(429).json({ error: TOO_MANY })
      return
    }

    let right = false
    try {
      right = await matches(readJsonBody(request), environment)
    } catch {
      // A hash that could not be worked out is a wrong answer, and the try it took is spent.
    }
    if (right) {
      limiter.succeeded(address)
      // Always a new session, never one the request brought with it.
      response.setHeader('Set-Cookie', sessionCookie(newSessionToken(environment, moment)))
      response.status(204).end()
      return
    }

    limiter.failed(address, moment)
    await pause(FAIL_WAIT_MS)
    const tooShort = typeof environment.BOARD_PASSWORD === 'string' && environment.BOARD_PASSWORD.length > 0 &&
      environment.BOARD_PASSWORD.length < MIN_PASSWORD_LENGTH
    // A password too short to use is never accepted, so saying so tells a guesser nothing they could
    // use - and it is the only way the owner finds out why their password does not work.
    if (tooShort) response.status(503).json({ error: PASSWORD_TOO_SHORT })
    else response.status(401).json({ error: WRONG })
  }
}

export default makeHandler()
