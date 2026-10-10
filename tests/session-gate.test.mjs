// The gates believe a signed-in device's cookie OR the old view key header (spec 2026-10-10, build
// task 6). The page stops sending the key: its own requests carry the cookie by themselves, because
// they are same-site fetches. Scripts keep the header. Nothing else in the endpoints changes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { viewGate, writeGate, forgetSignOuts } from '../api/_gate.js'
import { newSessionToken, verifySession, SESSION_COOKIE, RENEW_AFTER_MS } from '../api/_session.js'
import { emptySettings } from '../api/_picture-store.js'

const VIEW = 'vk_fake_view_key_for_the_gate_suite'
const ENV = { VIEW_KEY: VIEW }
const cookieFor = (token) => ({ cookie: `theme=dark; ${SESSION_COOKIE}=${token}` })
const signedIn = (at = Date.now(), env = ENV) => cookieFor(newSessionToken(env, at))
const ours = { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }

// A picture store as far as the gate sees one: its settings, and how many times it was asked.
function storeSaying(sessionsValidFrom, { fails = false } = {}) {
  const store = {
    reads: 0,
    async readSettings() {
      store.reads += 1
      if (fails) throw new Error('the store is not answering')
      return { settings: { ...emptySettings(), sessionsValidFrom }, etag: null }
    }
  }
  return store
}

/* ---------- the view gate ---------- */

test('a signed-in cookie alone gets in', async () => {
  assert.equal(await viewGate({ headers: signedIn() }, ENV), null)
})

test('the view key header alone still gets in, for scripts', async () => {
  assert.equal(await viewGate({ headers: { 'x-view-key': VIEW } }, ENV), null)
})

test('neither is a 401 that says to sign in, and still names the header for scripts', async () => {
  const denied = await viewGate({ headers: {} }, ENV)
  assert.equal(denied.status, 401)
  assert.equal(denied.needs, 'sign-in')
  assert.match(denied.error, /sign in/i)
  assert.match(denied.error, /x-view-key/)
})

test('a cookie this server did not sign, or that has run out, is a 401', async () => {
  const day = 24 * 3600_000
  const cases = {
    'another board': signedIn(Date.now(), { VIEW_KEY: 'vk_some_other_board' }),
    'expired': signedIn(Date.now() - 31 * day),
    'garbage': cookieFor('not-a-session'),
    'empty': cookieFor('')
  }
  for (const [name, headers] of Object.entries(cases)) {
    assert.equal((await viewGate({ headers }, ENV))?.status, 401, name)
  }
})

test('a wrong header with no cookie is still a 401, and a good cookie is not spoiled by a stale header', async () => {
  assert.equal((await viewGate({ headers: { 'x-view-key': 'wrong' } }, ENV))?.status, 401)
  assert.equal(await viewGate({ headers: { ...signedIn(), 'x-view-key': 'an old key' } }, ENV), null)
})

test('no VIEW_KEY is closed, cookie or not - there is no secret to check one with', async () => {
  const denied = await viewGate({ headers: signedIn() }, {})
  assert.equal(denied.status, 503)
})

test('PUBLIC_DASHBOARD=true is open as before, with or without anything', async () => {
  assert.equal(await viewGate({ headers: {} }, { PUBLIC_DASHBOARD: 'true' }), null)
})

/* ---------- sign out everywhere ---------- */

test('a cookie signed in before "sign out everywhere" is refused; one signed in after gets in', async () => {
  const now = Date.now()
  const store = storeSaying(now - 1000)
  assert.equal((await viewGate({ headers: signedIn(now - 5000) }, ENV, { store }))?.status, 401)
  assert.equal(await viewGate({ headers: signedIn(now) }, ENV, { store }), null)
})

test('the store is asked only about a cookie that is otherwise good - never for a stranger', async () => {
  const store = storeSaying(0)
  await viewGate({ headers: {} }, ENV, { store })
  await viewGate({ headers: cookieFor('forged.thing') }, ENV, { store })
  await viewGate({ headers: { 'x-view-key': VIEW } }, ENV, { store })
  assert.equal(store.reads, 0, 'a request with no good cookie made the board read its store')
  await viewGate({ headers: signedIn() }, ENV, { store })
  assert.equal(store.reads, 1)
})

test('a store that cannot be read keeps the last sign-out this server saw, and never locks the owner out', async () => {
  // A suspended store (Hobby locks it for 30 days past the free allowance) must not sign the owner
  // out of a board whose data comes from GitHub. So an unreadable store means "the last moment this
  // server knew of", which is "never" until it has read one.
  const now = Date.now()

  forgetSignOuts()
  assert.equal(await viewGate({ headers: signedIn(now - 5000) }, ENV, { store: storeSaying(0, { fails: true }) }), null)
  await viewGate({ headers: signedIn(now) }, ENV, { store: storeSaying(now - 1000) })
  assert.equal((await viewGate({ headers: signedIn(now - 5000) }, ENV, { store: storeSaying(0, { fails: true }) }))?.status, 401,
    'a store that stopped answering forgot a sign-out this server had already seen')
  // What this server has seen is kept for the life of the instance; the tests after this one start
  // from a server that has seen none.
  forgetSignOuts()
})

/* ---------- the write gate ---------- */

test('a signed-in cookie from the board itself, sending JSON, may change things', async () => {
  assert.equal(await writeGate({ headers: { ...signedIn(), ...ours } }, ENV), null)
})

test('the cookie never stands in for the other checks: same site, body type, edit key', async () => {
  const cookie = signedIn()
  assert.equal((await writeGate({ headers: { ...cookie, ...ours, 'sec-fetch-site': 'cross-site' } }, ENV))?.status, 403)
  assert.equal((await writeGate({ headers: { ...cookie, ...ours, 'content-type': 'text/plain' } }, ENV))?.status, 415)
  const needsEdit = await writeGate({ headers: { ...cookie, ...ours } }, { ...ENV, EDIT_KEY: 'ek_fake_edit_key' })
  assert.equal(needsEdit?.status, 401)
  assert.equal(needsEdit.needs, 'edit-key')
  assert.equal(await writeGate({ headers: { ...cookie, ...ours, 'x-edit-key': 'ek_fake_edit_key' } }, { ...ENV, EDIT_KEY: 'ek_fake_edit_key' }), null)
})

test('a write with no cookie and no key is refused before anything else', async () => {
  const denied = await writeGate({ headers: ours }, ENV)
  assert.equal(denied.status, 401)
  assert.equal(denied.needs, 'sign-in')
})

/* ---------- every gated endpoint, with the cookie alone ---------- */

const API = fileURLToPath(new URL('../api/', import.meta.url))
const ENDPOINTS = readdirSync(API).filter((name) => name.endsWith('.js') && !name.startsWith('_') && !['login.js', 'logout.js'].includes(name))

function fakeResponse() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; return this },
    getHeader(key) { return this.headers[key] },
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
    send() { return this },
    end() { return this }
  }
}

async function callEach(headersFor) {
  const previous = { ...process.env }
  for (const name of ['PUBLIC_DASHBOARD', 'EDIT_KEY', 'BLOB_STORE_ID', 'BLOB_READ_WRITE_TOKEN', 'OPENAI_API_KEY', 'PUBLIC_FIRE']) delete process.env[name]
  Object.assign(process.env, { VIEW_KEY: VIEW, GITHUB_OWNER: 'someone', GITHUB_REPO: 'my-agent-team', FIRE_KEY: 'fk_fake', FIRE_TRIGGERS: '{}' })
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('Not Found', { status: 404 })
  const answers = {}
  try {
    for (const name of ENDPOINTS) {
      const handler = (await import(pathToFileURL(join(API, name)).href)).default
      for (const method of ['GET', 'POST']) {
        const response = fakeResponse()
        await handler({ method, headers: headersFor(), query: { path: 'README.md', slot: 'team', v: 'abcdefgh1234', t: 'webp' }, body: {} }, response)
        answers[`${name} ${method}`] = response
      }
    }
  } finally {
    globalThis.fetch = realFetch
    process.env = previous
  }
  return answers
}

test('every endpoint lets a signed-in cookie past its gate, and refuses a stranger with private, no-store', async () => {
  const withCookie = await callEach(() => ({ ...signedIn(), ...ours }))
  const stranger = await callEach(() => ({ ...ours }))
  for (const [call, response] of Object.entries(withCookie)) {
    if (response.statusCode === 405) continue
    const refusal = response.body?.needs === 'sign-in' || /signed out|sign in/i.test(response.body?.error ?? '')
    assert.ok(!refusal, `${call} refused a signed-in cookie: ${response.statusCode} ${response.body?.error}`)
  }
  for (const [call, response] of Object.entries(stranger)) {
    if (response.statusCode === 405) continue
    assert.equal(response.statusCode, 401, `${call} answered a stranger ${response.statusCode}`)
    assert.equal(response.headers['Cache-Control'], 'private, no-store', call)
  }
})

/* ---------- staying signed in ---------- */

async function stateWith(headers) {
  const { default: handler } = await import('../api/state.js')
  const previous = { ...process.env }
  delete process.env.PUBLIC_DASHBOARD
  Object.assign(process.env, { VIEW_KEY: VIEW, GITHUB_OWNER: 'someone', GITHUB_REPO: 'my-agent-team' })
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('Not Found', { status: 404 })
  const response = fakeResponse()
  try {
    await handler({ method: 'GET', headers }, response)
  } finally {
    globalThis.fetch = realFetch
    process.env = previous
  }
  return response
}

test('loading the board with a cookie over a day old hands back a fresh one, still signed in at the same moment', async () => {
  const signedInAt = Date.now() - RENEW_AFTER_MS - 60_000
  const response = await stateWith(signedIn(signedInAt))
  const set = response.headers['Set-Cookie']
  assert.ok(set, 'a day-old cookie was not renewed, so an active phone would be signed out after 30 days')
  assert.match(set, /^__Host-cockpit_session=[^;]+; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=2592000$/)
  const renewed = verifySession(set.split(';')[0].split('=')[1], { VIEW_KEY: VIEW })
  assert.equal(renewed.auth, signedInAt)
  assert.ok(renewed.issued > signedInAt + RENEW_AFTER_MS)
})

test('a cookie under a day old, the view key header, or a refusal hands back no cookie', async () => {
  assert.equal((await stateWith(signedIn())).headers['Set-Cookie'], undefined)
  assert.equal((await stateWith({ 'x-view-key': VIEW })).headers['Set-Cookie'], undefined)
  const refused = await stateWith({})
  assert.equal(refused.statusCode, 401)
  assert.equal(refused.headers['Set-Cookie'], undefined)
})

test('the sign-out kept in the store\'s settings file is the one the gate honours, and nonsense there is not', async () => {
  const { fakeBlob } = await import('./helpers/fake-blob.mjs')
  const { pictureStore, SETTINGS_PATH } = await import('../api/_picture-store.js')
  const now = Date.now()
  const read = async (sessionsValidFrom) => {
    forgetSignOuts()
    const fake = fakeBlob()
    await fake.sdk.put(SETTINGS_PATH, JSON.stringify({ ...emptySettings(), sessionsValidFrom }), { access: 'private' })
    const store = pictureStore({ BLOB_STORE_ID: 'store_fake' }, () => fake.sdk)
    return (await viewGate({ headers: signedIn(now - 5000) }, ENV, { store }))?.status ?? 'in'
  }
  assert.equal(await read(now - 1000), 401)
  assert.equal(await read(now - 60_000), 'in')
  for (const nonsense of ['soon', -5, 1.5, null, { at: now }]) {
    assert.equal(await read(nonsense), 'in', `${JSON.stringify(nonsense)} was read as a sign-out`)
  }
  forgetSignOuts()
})
