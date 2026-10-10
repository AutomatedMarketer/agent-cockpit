// "Sign out everywhere" (spec 2026-10-10, build task 8): one press signs every device out, this one
// included. It is kept as a moment in the picture store's settings.json - every session signed in
// before it is refused - so it costs one store write, counted in the day's changes like any other.
// With no store, the way to do the same is to change VIEW_KEY or BOARD_PASSWORD, and the answer says so.
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeHandler } from '../api/logout.js'
import { viewGate, forgetSignOuts } from '../api/_gate.js'
import { newSessionToken, SESSION_COOKIE } from '../api/_session.js'
import { pictureStore, SETTINGS_PATH, dailyCaps } from '../api/_picture-store.js'
import { fakeBlob } from './helpers/fake-blob.mjs'

const VIEW = 'vk_fake_view_key_for_the_sign_out_suite'
const ENV = { VIEW_KEY: VIEW, BLOB_STORE_ID: 'store_fake' }
const ours = { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }
const cookieAt = (at) => ({ cookie: `${SESSION_COOKIE}=${newSessionToken(ENV, at)}` })

function fakeResponse() {
  return {
    statusCode: null,
    body: undefined,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; return this },
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
    end() { return this }
  }
}

function board(env = ENV) {
  const fake = fakeBlob()
  const store = pictureStore(env, async () => fake.sdk)
  return { fake, store }
}

async function press({ store, env = ENV, headers, body = { everywhere: true }, now = new Date() }) {
  forgetSignOuts()
  const response = fakeResponse()
  await makeHandler({ store, env, now: () => now })({ method: 'POST', headers, body }, response)
  return response
}

const settingsPuts = (fake) => fake.calls.put.filter((call) => call.pathname === SETTINGS_PATH).length

test('one press: every session signed in before it is refused, this device signed out, one store write', async () => {
  const { fake, store } = board()
  const pressedAt = new Date()
  const before = cookieAt(pressedAt.getTime() - 5000)
  const response = await press({ store, headers: { ...ours, ...before }, now: pressedAt })
  assert.equal(response.statusCode, 204)
  assert.equal(response.headers['Set-Cookie'], `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`)
  assert.equal(settingsPuts(fake), 1, 'one press, one write')
  const { settings } = await store.readSettings({ fresh: true })
  assert.equal(settings.sessionsValidFrom, pressedAt.getTime())
  assert.equal(settings.usage.writes, 1, 'the press is counted in the day\'s changes')

  // Any device signed in before the press, on any server that reads the store, is out.
  forgetSignOuts()
  assert.equal((await viewGate({ headers: before }, ENV, { store }))?.status, 401)
  assert.equal((await viewGate({ headers: cookieAt(pressedAt.getTime() - 3600_000) }, ENV, { store }))?.status, 401)
  // Signing in again afterwards works, and the view key header was never affected.
  assert.equal(await viewGate({ headers: cookieAt(pressedAt.getTime() + 1000) }, ENV, { store }), null)
  assert.equal(await viewGate({ headers: { 'x-view-key': VIEW } }, ENV, { store }), null)
  forgetSignOuts()
})

test('it needs a signed-in device or the key, like any change - and a stranger writes nothing', async () => {
  const { fake, store } = board()
  const response = await press({ store, headers: ours })
  assert.equal(response.statusCode, 401)
  assert.equal(settingsPuts(fake), 0)
  assert.equal(response.headers['Set-Cookie'], undefined)
})

test('with EDIT_KEY set, a viewer cannot sign everybody else out', async () => {
  const env = { ...ENV, EDIT_KEY: 'ek_fake_edit_key' }
  const { fake, store } = board(env)
  const refused = await press({ store, env, headers: { ...ours, ...cookieAt(Date.now() - 1000) } })
  assert.equal(refused.statusCode, 401)
  assert.equal(refused.body.needs, 'edit-key')
  assert.equal(settingsPuts(fake), 0)
  const allowed = await press({ store, env, headers: { ...ours, ...cookieAt(Date.now() - 1000), 'x-edit-key': 'ek_fake_edit_key' } })
  assert.equal(allowed.statusCode, 204)
})

test('from another site, or not as JSON, it is refused and nothing is written', async () => {
  const { fake, store } = board()
  const cookie = cookieAt(Date.now() - 1000)
  assert.equal((await press({ store, headers: { ...ours, ...cookie, 'sec-fetch-site': 'cross-site' } })).statusCode, 403)
  assert.equal((await press({ store, headers: { ...ours, ...cookie, 'content-type': 'text/plain' } })).statusCode, 415)
  assert.equal(settingsPuts(fake), 0)
})

test('with no picture store, it says how to do the same without one, and signs nobody out', async () => {
  const env = { VIEW_KEY: VIEW }
  const response = await press({ store: null, env, headers: { ...ours, ...cookieAt(Date.now() - 1000) } })
  assert.equal(response.statusCode, 503)
  assert.match(response.body.error, /VIEW_KEY/)
  assert.match(response.body.error, /BOARD_PASSWORD/)
  assert.equal(response.headers['Set-Cookie'], undefined)
})

test('when today\'s changes are used up, it says so, writes nothing, and this device stays signed in', async () => {
  const { fake, store } = board()
  const caps = dailyCaps(ENV)
  const today = new Date()
  await fake.sdk.put(SETTINGS_PATH, JSON.stringify({ version: 1, usage: { day: today.toISOString().slice(0, 10), writes: caps.writes, generated: 0, pending: [] } }), { access: 'private' })
  const puts = settingsPuts(fake)
  const response = await press({ store, headers: { ...ours, ...cookieAt(Date.now() - 1000) }, now: today })
  assert.equal(response.statusCode, 429)
  assert.match(response.body.error, /tomorrow/)
  assert.equal(settingsPuts(fake), puts)
  assert.equal(response.headers['Set-Cookie'], undefined)
  // Refused from the copy this server already has: a refusal costs no billed read of the store.
  assert.equal(fake.calls.get.filter((call) => call.options.useCache === false).length, 0)
})

test('a second press never moves the moment backwards', async () => {
  const { store } = board()
  const later = new Date()
  await press({ store, headers: { ...ours, ...cookieAt(later.getTime() - 1000) }, now: later })
  await press({ store, headers: { ...ours, 'x-view-key': VIEW }, now: new Date(later.getTime() - 60_000) })
  assert.equal((await store.readSettings({ fresh: true })).settings.sessionsValidFrom, later.getTime())
})

test('without "everywhere": this device only, nothing written, no key needed', async () => {
  const { fake, store } = board()
  for (const body of [{}, { everywhere: 'yes' }, { everywhere: 1 }]) {
    const response = await press({ store, headers: ours, body })
    assert.equal(response.statusCode, 204, JSON.stringify(body))
    assert.match(response.headers['Set-Cookie'], /Max-Age=0$/)
  }
  assert.equal(settingsPuts(fake), 0)
})
