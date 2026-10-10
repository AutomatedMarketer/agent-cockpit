// Signing in and out (spec 2026-10-10, build task 7). A real username and password form that phones
// and browsers save, a 30-day cookie, and the view key still working as the spare key. Once a
// memorable password is allowed, guesses have to be limited, so every failure costs a slow hash and
// a fixed wait, and five from one address in 15 minutes stop that address for the rest of them.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { makeHandler, makeLimiter, MIN_PASSWORD_LENGTH, FAIL_WAIT_MS, PASSWORD_HASH } from '../api/login.js'
import logout from '../api/logout.js'
import { verifySession, newSessionToken, SESSION_COOKIE } from '../api/_session.js'

const VIEW = 'vk_fake_view_key_for_the_login_suite'
const PASSWORD = 'correct horse battery staple'
const ENV = { VIEW_KEY: VIEW, BOARD_USERNAME: 'Nuno', BOARD_PASSWORD: PASSWORD }
const NOW = Date.parse('2026-10-10T12:00:00Z')
const ours = { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-real-ip': '203.0.113.7' }

function fakeResponse() {
  return {
    statusCode: null,
    body: undefined,
    ended: false,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; return this },
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
    end() { this.ended = true; return this }
  }
}

// A handler of its own for each test, so one test's wrong guesses never lock another out.
function signIn(body, { env = ENV, headers = ours, now = NOW, limiter = makeLimiter(), waits = [] } = {}) {
  const handler = makeHandler({ env, now: () => now, pause: async (ms) => { waits.push(ms) }, limiter })
  const response = fakeResponse()
  return handler({ method: 'POST', headers, body }, response).then(() => response)
}

const cookieOf = (response) => {
  const set = response.headers['Set-Cookie']
  return typeof set === 'string' ? set.split(';')[0].slice(`${SESSION_COOKIE}=`.length) : null
}

/* ---------- the right answers ---------- */

test('the right username and password: 204 and a 30-day cookie the browser keeps', async () => {
  const response = await signIn({ username: 'Nuno', password: PASSWORD })
  assert.equal(response.statusCode, 204)
  assert.equal(response.ended, true)
  assert.match(response.headers['Set-Cookie'], /; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=2592000$/)
  const session = verifySession(cookieOf(response), ENV, { now: NOW })
  assert.equal(session.auth, NOW)
  assert.equal(response.headers['Cache-Control'], 'private, no-store')
})

test('the username is not fussy about capitals or spaces - a phone capitalises the first letter', async () => {
  for (const username of ['nuno', 'NUNO', '  Nuno ']) {
    assert.equal((await signIn({ username, password: PASSWORD })).statusCode, 204, username)
  }
})

test('the password is exact: no case, no trimming, no prefix', async () => {
  for (const password of [PASSWORD.toUpperCase(), ` ${PASSWORD}`, PASSWORD.slice(0, -1), `${PASSWORD}x`]) {
    assert.equal((await signIn({ username: 'Nuno', password })).statusCode, 401, JSON.stringify(password))
  }
})

test('the spare key (VIEW_KEY) signs in as the password, whatever the username', async () => {
  for (const username of ['Nuno', '', 'anybody']) {
    const response = await signIn({ username, password: VIEW })
    assert.equal(response.statusCode, 204, username)
    assert.ok(verifySession(cookieOf(response), ENV, { now: NOW }))
  }
})

test('with no BOARD_PASSWORD set, only the spare key signs in', async () => {
  const env = { VIEW_KEY: VIEW }
  assert.equal((await signIn({ username: 'x', password: VIEW }, { env })).statusCode, 204)
  assert.equal((await signIn({ username: 'x', password: '' }, { env })).statusCode, 401)
  assert.equal((await signIn({ username: 'x', password: 'anything at all here' }, { env })).statusCode, 401)
})

test('with no BOARD_USERNAME set, any username goes with the right password', async () => {
  const env = { VIEW_KEY: VIEW, BOARD_PASSWORD: PASSWORD }
  assert.equal((await signIn({ username: 'whoever', password: PASSWORD }, { env })).statusCode, 204)
  assert.equal((await signIn({ password: PASSWORD }, { env })).statusCode, 204)
})

/* ---------- the wrong answers say nothing about which part was wrong ---------- */

test('wrong password, wrong username, missing password, missing everything: the same 401, the same words, no cookie', async () => {
  const answers = []
  for (const body of [
    { username: 'Nuno', password: 'wrong password entirely' },
    { username: 'someone', password: PASSWORD },
    { username: 'Nuno' },
    { username: 'Nuno', password: '' },
    {},
    { username: 42, password: ['x'] },
    null
  ]) {
    const waits = []
    const response = await signIn(body, { waits })
    assert.equal(response.statusCode, 401, JSON.stringify(body))
    assert.equal(response.headers['Set-Cookie'], undefined, 'a refused sign-in set a cookie')
    assert.deepEqual(waits, [FAIL_WAIT_MS], 'a failure did not wait')
    assert.equal(response.body.needs, undefined)
    answers.push(response.body.error)
  }
  assert.equal(new Set(answers).size, 1, `the refusals differ: ${[...new Set(answers)].join(' | ')}`)
  assert.doesNotMatch(answers[0], /username is|password is|no such|unknown user/i)
  assert.ok(!answers[0].includes(PASSWORD) && !answers[0].includes('Nuno') && !answers[0].includes(VIEW))
})

test('a success does not wait', async () => {
  const waits = []
  await signIn({ username: 'Nuno', password: PASSWORD }, { waits })
  assert.deepEqual(waits, [])
})

test('a password over 1,024 characters is a wrong password, not work for the server - even a matching one', async () => {
  assert.equal((await signIn({ username: 'Nuno', password: PASSWORD + 'x'.repeat(2000) })).statusCode, 401)
  const long = 'y'.repeat(1025)
  assert.equal((await signIn({ username: 'Nuno', password: long }, { env: { ...ENV, BOARD_PASSWORD: long } })).statusCode, 401)
  const longest = 'y'.repeat(1024)
  assert.equal((await signIn({ username: 'Nuno', password: longest }, { env: { ...ENV, BOARD_PASSWORD: longest } })).statusCode, 204)
})

/* ---------- configuration ---------- */

test(`a BOARD_PASSWORD under ${MIN_PASSWORD_LENGTH} characters is never accepted, and the answer says so plainly`, async () => {
  assert.equal(MIN_PASSWORD_LENGTH, 12)
  const env = { VIEW_KEY: VIEW, BOARD_PASSWORD: 'hunter2' }
  const response = await signIn({ username: 'x', password: 'hunter2' }, { env })
  assert.equal(response.statusCode, 503)
  assert.equal(response.headers['Set-Cookie'], undefined)
  assert.match(response.body.error, /BOARD_PASSWORD/)
  assert.match(response.body.error, /12 characters/)
  assert.match(response.body.error, /spare key/i)
  assert.equal((await signIn({ username: 'x', password: VIEW }, { env })).statusCode, 204, 'the spare key stopped working too')
})

test('no VIEW_KEY: closed, with the sentence that says what to set', async () => {
  const response = await signIn({ username: 'Nuno', password: PASSWORD }, { env: { BOARD_PASSWORD: PASSWORD } })
  assert.equal(response.statusCode, 503)
  assert.match(response.body.error, /VIEW_KEY/)
  assert.equal(response.headers['Set-Cookie'], undefined)
})

test('a board open to everyone has nothing to sign in to', async () => {
  const response = await signIn({ username: 'Nuno', password: PASSWORD }, { env: { ...ENV, PUBLIC_DASHBOARD: 'true' } })
  assert.equal(response.statusCode, 400)
  assert.equal(response.headers['Set-Cookie'], undefined)
})

/* ---------- only from the board itself, only as JSON, only POST ---------- */

test('another site cannot sign the owner in (or out) behind their back: 403', async () => {
  for (const extra of [{ 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': undefined, origin: 'https://evil.example', host: 'board.example' }]) {
    const response = await signIn({ username: 'Nuno', password: PASSWORD }, { headers: { ...ours, ...extra } })
    assert.equal(response.statusCode, 403, JSON.stringify(extra))
    assert.equal(response.headers['Set-Cookie'], undefined)
  }
})

test('anything but JSON is 415, and a form post is one of them', async () => {
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', undefined]) {
    const response = await signIn({ username: 'Nuno', password: PASSWORD }, { headers: { ...ours, 'content-type': type } })
    assert.equal(response.statusCode, 415, String(type))
  }
})

test('anything but POST is 405', async () => {
  const handler = makeHandler({ env: ENV, limiter: makeLimiter() })
  const response = fakeResponse()
  await handler({ method: 'GET', headers: ours }, response)
  assert.equal(response.statusCode, 405)
  assert.equal(response.headers.Allow, 'POST')
  assert.equal(response.headers['Cache-Control'], 'private, no-store')
})

/* ---------- guessing ---------- */

test('five wrong guesses from one address stop that address for 15 minutes - the right password included', async () => {
  const limiter = makeLimiter()
  for (let guess = 0; guess < 5; guess += 1) {
    assert.equal((await signIn({ username: 'Nuno', password: `guess number ${guess}` }, { limiter })).statusCode, 401)
  }
  const waits = []
  const blocked = await signIn({ username: 'Nuno', password: PASSWORD }, { limiter, waits })
  assert.equal(blocked.statusCode, 429)
  assert.equal(blocked.headers['Set-Cookie'], undefined, 'a blocked address signed in')
  assert.equal(blocked.headers['Retry-After'], String(15 * 60))
  assert.match(blocked.body.error, /15 minutes|try again/i)
  // Another address is not affected, and the same one is let back in once the time is up.
  assert.equal((await signIn({ username: 'Nuno', password: PASSWORD }, { limiter, headers: { ...ours, 'x-real-ip': '198.51.100.9' } })).statusCode, 204)
  assert.equal((await signIn({ username: 'Nuno', password: PASSWORD }, { limiter, now: NOW + 15 * 60_000 })).statusCode, 204)
})

test('the address comes from Vercel\'s own headers, and a missing one still counts', async () => {
  const limiter = makeLimiter()
  const viaForwarded = { ...ours, 'x-real-ip': undefined, 'x-forwarded-for': '192.0.2.1, 10.0.0.1' }
  for (let guess = 0; guess < 5; guess += 1) await signIn({ username: 'Nuno', password: 'wrong guess here' }, { limiter, headers: viaForwarded })
  assert.equal((await signIn({ username: 'Nuno', password: PASSWORD }, { limiter, headers: viaForwarded })).statusCode, 429)
  // Another first address in x-forwarded-for is another person, and x-real-ip wins when both are sent.
  assert.equal((await signIn({ username: 'Nuno', password: PASSWORD }, { limiter, headers: { ...viaForwarded, 'x-forwarded-for': '192.0.2.2' } })).statusCode, 204)
  assert.equal((await signIn({ username: 'Nuno', password: PASSWORD }, { limiter, headers: { ...viaForwarded, 'x-real-ip': '192.0.2.3' } })).statusCode, 204)
  const nowhere = { ...ours, 'x-real-ip': undefined }
  for (let guess = 0; guess < 5; guess += 1) await signIn({ username: 'Nuno', password: 'wrong guess here' }, { limiter, headers: nowhere })
  assert.equal((await signIn({ username: 'Nuno', password: PASSWORD }, { limiter, headers: nowhere })).statusCode, 429)
})

test('after the 15 minutes the count starts again - and five more wrong guesses stop the address again', async () => {
  const limiter = makeLimiter()
  for (let guess = 0; guess < 5; guess += 1) await signIn({ username: 'Nuno', password: 'a wrong guess' }, { limiter })
  const later = NOW + 15 * 60_000
  for (let guess = 0; guess < 5; guess += 1) {
    assert.equal((await signIn({ username: 'Nuno', password: 'a wrong guess' }, { limiter, now: later })).statusCode, 401)
  }
  const blocked = await signIn({ username: 'Nuno', password: PASSWORD }, { limiter, now: later + 1000 })
  assert.equal(blocked.statusCode, 429, 'an address that waited once was never stopped again')
  assert.equal(blocked.headers['Retry-After'], String(15 * 60 - 1))
})

test('signing in clears that address\'s count', async () => {
  const limiter = makeLimiter()
  for (let guess = 0; guess < 4; guess += 1) await signIn({ username: 'Nuno', password: 'a wrong guess' }, { limiter })
  assert.equal((await signIn({ username: 'Nuno', password: PASSWORD }, { limiter })).statusCode, 204)
  for (let guess = 0; guess < 4; guess += 1) await signIn({ username: 'Nuno', password: 'a wrong guess' }, { limiter })
  assert.equal((await signIn({ username: 'Nuno', password: PASSWORD }, { limiter })).statusCode, 204)
})

test('the count of addresses is held in a bounded amount of memory', () => {
  const limiter = makeLimiter({ maxAddresses: 3 })
  for (let at = 0; at < 10; at += 1) limiter.failed(`192.0.2.${at}`, NOW)
  assert.ok(limiter.size() <= 3)
})

/* ---------- how the password is checked ---------- */

test('the password is checked as a slow hash, compared in constant time - never as plain text', () => {
  const source = readFileSync(new URL('../api/login.js', import.meta.url), 'utf8')
  assert.match(source, /\bscrypt\b/)
  assert.match(source, /timingSafeEqual\(/)
  // No plain compare of a password with anything but its type or the empty string.
  assert.doesNotMatch(source, /[!=]==\s*(?:env|environment)\.BOARD_PASSWORD|(?<!typeof (?:env|environment)\.)BOARD_PASSWORD\s*[!=]==|(?<!typeof )\bpassword\s*[!=]==(?!\s*'')|[!=]==\s*password\b/)
  // About 100 ms a guess on a server: scrypt's own recommended interactive cost.
  assert.ok(PASSWORD_HASH.N >= 16384 && PASSWORD_HASH.r >= 8)
})

/* ---------- a fresh session every time ---------- */

test('signing in always makes a new session, whatever cookie came with the request', async () => {
  const old = newSessionToken(ENV, NOW - 10 * 24 * 3600_000)
  const response = await signIn({ username: 'Nuno', password: PASSWORD }, { headers: { ...ours, cookie: `${SESSION_COOKIE}=${old}` } })
  const fresh = cookieOf(response)
  assert.notEqual(fresh, old)
  assert.equal(verifySession(fresh, ENV, { now: NOW }).auth, NOW)
})

/* ---------- signing out on this device ---------- */

async function signOut(headers = ours, body = {}) {
  const response = fakeResponse()
  await logout({ method: 'POST', headers, body }, response)
  return response
}

test('signing out takes the cookie away on this device', async () => {
  const response = await signOut()
  assert.equal(response.statusCode, 204)
  assert.equal(response.headers['Set-Cookie'], `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`)
  assert.equal(response.headers['Cache-Control'], 'private, no-store')
})

test('signing out is only from the board itself, as JSON, by POST', async () => {
  assert.equal((await signOut({ ...ours, 'sec-fetch-site': 'cross-site' })).statusCode, 403)
  assert.equal((await signOut({ ...ours, 'content-type': 'text/plain' })).statusCode, 415)
  const response = fakeResponse()
  await logout({ method: 'GET', headers: ours }, response)
  assert.equal(response.statusCode, 405)
  assert.equal(response.headers.Allow, 'POST')
})
