// The "remember this device" session (spec 2026-10-10, build task 5). A signed-in browser holds a
// cookie the page's scripts cannot read (HttpOnly), the browser never sends to another site
// (SameSite=Strict), and nobody but this server can make (HMAC with a secret derived from VIEW_KEY
// and BOARD_PASSWORD). These tests are the contract for making one and for believing one.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  RENEW_AFTER_MS,
  signSession,
  verifySession,
  newSessionToken,
  renewedSessionToken,
  sessionCookie,
  clearedSessionCookie,
  readSessionCookie
} from '../api/_session.js'

const ENV = { VIEW_KEY: 'vk_fake_view_key_for_the_session_suite', BOARD_PASSWORD: 'a fake board password' }
const NOW = Date.parse('2026-10-10T12:00:00Z')
const DAY = 24 * 3600_000
const flip = (text, at) => text.slice(0, at) + (text[at] === 'A' ? 'B' : 'A') + text.slice(at + 1)

test('a session this server signed is believed, with what it was signed with', () => {
  const token = signSession({ auth: NOW - 1000, issued: NOW }, ENV)
  const session = verifySession(token, ENV, { now: NOW + 5000 })
  assert.deepEqual(session, { auth: NOW - 1000, issued: NOW, expires: NOW + SESSION_MAX_AGE_SECONDS * 1000 })
})

test('a new sign-in is signed in now, and lasts 30 days', () => {
  const session = verifySession(newSessionToken(ENV, NOW), ENV, { now: NOW })
  assert.equal(session.auth, NOW)
  assert.equal(session.issued, NOW)
  assert.equal(session.expires - session.issued, 30 * DAY)
})

test('a changed payload, a changed signature, or one glued to the other is refused', () => {
  const token = newSessionToken(ENV, NOW)
  const other = newSessionToken(ENV, NOW - 3 * DAY)
  const [body, signature] = token.split('.')
  for (let at = 0; at < body.length; at += 7) {
    assert.equal(verifySession(`${flip(body, at)}.${signature}`, ENV, { now: NOW }), null, `payload changed at ${at}`)
  }
  for (let at = 0; at < signature.length; at += 5) {
    assert.equal(verifySession(`${body}.${flip(signature, at)}`, ENV, { now: NOW }), null, `signature changed at ${at}`)
  }
  assert.equal(verifySession(`${body}.${other.split('.')[1]}`, ENV, { now: NOW }), null)
  assert.equal(verifySession(`${other.split('.')[0]}.${signature}`, ENV, { now: NOW }), null)
})

test('a payload the server would never write is refused even when signed', () => {
  // Signed by hand with the server's own secret, to prove the shape is checked after the signature.
  const forge = (claims) => signSession(claims, ENV)
  for (const claims of [
    { auth: NOW, issued: NOW, expires: NOW + 365 * DAY }, // longer than a session lasts
    { auth: NOW + 1, issued: NOW }, // signed in after it was issued
    { auth: 'yesterday', issued: NOW },
    { auth: NOW, issued: NOW + 0.5 }
  ]) {
    assert.equal(verifySession(forge(claims), ENV, { now: NOW }), null, JSON.stringify(claims))
  }
})

test('an expired session is refused, at the very moment it expires', () => {
  const token = newSessionToken(ENV, NOW)
  assert.ok(verifySession(token, ENV, { now: NOW + 30 * DAY - 1 }))
  assert.equal(verifySession(token, ENV, { now: NOW + 30 * DAY }), null)
  assert.equal(verifySession(token, ENV, { now: NOW + 31 * DAY }), null)
})

test('a session issued in the future, past a few minutes of clock difference, is refused', () => {
  assert.ok(verifySession(newSessionToken(ENV, NOW + 60_000), ENV, { now: NOW }))
  assert.equal(verifySession(newSessionToken(ENV, NOW + 3600_000), ENV, { now: NOW }), null)
})

test('"sign out everywhere": a session signed in before it is refused, one signed in after is not', () => {
  const before = newSessionToken(ENV, NOW - 1)
  const atThatMoment = newSessionToken(ENV, NOW)
  const after = newSessionToken(ENV, NOW + 1)
  assert.equal(verifySession(before, ENV, { now: NOW + 10, signedOutBefore: NOW }), null)
  assert.equal(verifySession(atThatMoment, ENV, { now: NOW + 10, signedOutBefore: NOW }), null)
  assert.ok(verifySession(after, ENV, { now: NOW + 10, signedOutBefore: NOW }))
})

test('a renewed session keeps the time it was signed in, so renewing cannot outlive "sign out everywhere"', () => {
  // The old session is renewed by a server that has not heard of the sign-out yet. The new cookie
  // carries the ORIGINAL sign-in time, so once the sign-out is heard it is refused like the old one.
  const old = verifySession(newSessionToken(ENV, NOW - 2 * DAY), ENV, { now: NOW })
  const renewed = renewedSessionToken(old, ENV, NOW)
  assert.ok(renewed)
  const read = verifySession(renewed, ENV, { now: NOW })
  assert.equal(read.auth, NOW - 2 * DAY)
  assert.equal(read.issued, NOW)
  assert.equal(verifySession(renewed, ENV, { now: NOW, signedOutBefore: NOW - DAY }), null)
})

test('a session is renewed once a day while it is used, not on every request', () => {
  const fresh = verifySession(newSessionToken(ENV, NOW), ENV, { now: NOW })
  assert.equal(renewedSessionToken(fresh, ENV, NOW + RENEW_AFTER_MS - 1), null)
  assert.ok(renewedSessionToken(fresh, ENV, NOW + RENEW_AFTER_MS))
  assert.equal(RENEW_AFTER_MS, DAY)
})

test('changing VIEW_KEY or BOARD_PASSWORD signs every device out', () => {
  const token = newSessionToken(ENV, NOW)
  assert.equal(verifySession(token, { ...ENV, VIEW_KEY: `${ENV.VIEW_KEY}-rotated` }, { now: NOW }), null)
  assert.equal(verifySession(token, { ...ENV, BOARD_PASSWORD: 'a different fake password' }, { now: NOW }), null)
  assert.equal(verifySession(token, { VIEW_KEY: ENV.VIEW_KEY }, { now: NOW }), null, 'removing the password is a change too')
})

test('with no VIEW_KEY there is no secret, so nothing is signed and nothing believed', () => {
  assert.equal(newSessionToken({}, NOW), null)
  assert.equal(verifySession(newSessionToken(ENV, NOW), {}, { now: NOW }), null)
})

test('anything that is not a token is refused without throwing', () => {
  for (const value of [undefined, null, 42, {}, [], '', '.', 'a.b', 'a.b.c', 'x'.repeat(5000), `${'A'.repeat(40)}.${'B'.repeat(43)}`]) {
    assert.doesNotThrow(() => verifySession(value, ENV, { now: NOW }))
    assert.equal(verifySession(value, ENV, { now: NOW }), null, String(value).slice(0, 30))
  }
})

test('the signature is compared in constant time, against a hash-length value', () => {
  // A plain === on the signature leaks, through timing, how many characters a guess got right.
  const source = readFileSync(new URL('../api/_session.js', import.meta.url), 'utf8')
  const verify = source.slice(source.indexOf('export function verifySession'))
  assert.match(verify.slice(0, verify.indexOf('\n}\n')), /timingSafeEqual\(/)
  assert.doesNotMatch(source, /signature\s*===|===\s*signature|expected\s*===|===\s*expected/)
})

/* ---------- the cookie ---------- */

test('the cookie is __Host-, HttpOnly, Secure, SameSite=Strict, the whole site, for 30 days', () => {
  assert.equal(SESSION_COOKIE, '__Host-cockpit_session')
  assert.equal(SESSION_MAX_AGE_SECONDS, 2592000)
  assert.equal(sessionCookie('abc.def'), '__Host-cockpit_session=abc.def; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000')
})

test('signing out sends the same cookie, empty, gone at once', () => {
  assert.equal(clearedSessionCookie(), '__Host-cockpit_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0')
})

test('the session is read from the Cookie header by its exact name, and only that', () => {
  const token = newSessionToken(ENV, NOW)
  assert.equal(readSessionCookie({ cookie: `theme=dark; ${SESSION_COOKIE}=${token}; other=1` }), token)
  assert.equal(readSessionCookie({ cookie: `${SESSION_COOKIE}=${token}` }), token)
  // Without the prefix a cookie can be planted by another site on the same parent domain.
  assert.equal(readSessionCookie({ cookie: `cockpit_session=${token}` }), null)
  assert.equal(readSessionCookie({ cookie: `x__Host-cockpit_session=${token}` }), null)
  assert.equal(readSessionCookie({}), null)
  assert.equal(readSessionCookie({ cookie: 42 }), null)
  assert.equal(readSessionCookie(undefined), null)
})
