// /api/voice-meter: GET shows the voice spend meter; POST records the conversations a device has in
// its outbox. The page sends token counts and each conversation's ticket; the server checks the
// ticket, the counts and the session id, prices the counts itself, and saves once.
//
// What these tests hold it to: the gates; dollars the page sends are ignored; a conversation is
// counted once however often it is sent; nonsense counts and tickets this server did not sign are
// refused without spoiling the rest of the batch; at the day's meter-write limit everything is KEPT
// for later and nothing is written; with no store nothing is written either; and no answer is ever
// kept by a shared cache.

import test from 'node:test'
import assert from 'node:assert/strict'
import { makeHandler, MAX_REPORTS } from '../api/voice-meter.js'
import { signTicket, newSessionId, costOf, TRANSCRIBE_MODEL } from '../api/_voice.js'
import { VOICE_PRICES, PRICES_CHECKED } from '../api/_voice-prices.js'
import { METER_PATH, SETTINGS_PATH } from '../api/_picture-store.js'
import { STORE_ENV, VIEW_KEY, NOON, connectedStore, storeCalls, asTheBoard, call, everythingSent } from './helpers/personalise-harness.mjs'
import { OPENAI_KEY } from './helpers/voice-fixtures.mjs'

const ENV = { ...STORE_ENV, OPENAI_API_KEY: OPENAI_KEY }
const JSON_TYPE = { 'content-type': 'application/json' }
const NOW = NOON().getTime()
const DOC_COUNTS = { textIn: 55, cachedTextIn: 64, audioIn: 13, cachedAudioIn: 0, textOut: 30, audioOut: 91 }
const MINI = { model: 'gpt-realtime-2.1-mini', transcribeModel: TRANSCRIBE_MODEL }

const ticket = ({ ago = 60_000, mouth = 'openai', model = 'gpt-realtime-2.1-mini', sid = newSessionId() } = {}) =>
  signTicket({ sid, iat: NOW - ago, mouth, model, ...(mouth === 'fish' ? { fishModel: 's2.1-pro-free' } : {}) }, OPENAI_KEY)
const sidOf = (signed) => JSON.parse(Buffer.from(signed.split('.')[0], 'base64url').toString('utf8')).sid

function meter({ env = ENV, store, now = NOON } = {}) {
  const connected = store === undefined ? connectedStore(env) : { store, fake: null }
  const handler = makeHandler({ store: connected.store, env, now })
  const post = (body, headers = asTheBoard(JSON_TYPE)) => call(handler, { method: 'POST', headers, body })
  const get = (headers = asTheBoard()) => call(handler, { method: 'GET', headers })
  return { ...connected, handler, post, get }
}

const noCache = (response, label) => {
  assert.equal(response.headers['Cache-Control'], 'private, no-store', `${label}: not private, no-store`)
  assert.doesNotMatch(JSON.stringify(response.headers), /s-maxage|public/i, `${label}: a shared cache may keep this`)
}
const meterPuts = (fake) => fake.calls.put.filter((put) => put.pathname === METER_PATH).length

/* ---------- recording ---------- */

test('two conversations are priced by the server, counted in their month, and saved in one put', async () => {
  const { post, fake } = meter()
  const first = ticket({ ago: 120_000 })
  const second = ticket({ ago: 60_000 })
  const response = await post({ reports: [
    { ticket: first, counts: DOC_COUNTS },
    { ticket: second, counts: { ...DOC_COUNTS, audioOut: 1200 } }
  ] })
  assert.equal(response.statusCode, 200)
  noCache(response, 'a report')
  assert.deepEqual(response.body.accepted.sort(), [sidOf(first), sidOf(second)].sort())
  assert.deepEqual(response.body.kept, [])
  assert.deepEqual(response.body.refused, [])
  assert.equal(meterPuts(fake), 1)
  assert.equal(fake.calls.put.filter((put) => put.pathname === SETTINGS_PATH).length, 0)

  const expected = costOf(DOC_COUNTS, MINI, VOICE_PRICES).micros + costOf({ ...DOC_COUNTS, audioOut: 1200 }, MINI, VOICE_PRICES).micros
  const saved = JSON.parse(fake.files.get(METER_PATH).bytes.toString('utf8'))
  assert.equal(saved.months['2026-10'].conversations, 2)
  assert.equal(saved.months['2026-10'].micros, expected)
  assert.equal(saved.last.sid, sidOf(second), 'the last conversation is not the newest one')
  assert.equal(response.body.meter.thisMonth.conversations, 2)
  assert.equal(response.body.meter.thisMonth.usd, expected / 1e6)
})

test('dollars the page sends are ignored: money is worked out on the server, from the counts', async () => {
  const { post, fake } = meter()
  await post({ reports: [{ ticket: ticket(), usd: 999, micros: 999e6, counts: { ...DOC_COUNTS, usd: 999, micros: 5 } }] })
  const saved = JSON.parse(fake.files.get(METER_PATH).bytes.toString('utf8'))
  assert.equal(saved.months['2026-10'].micros, costOf(DOC_COUNTS, MINI, VOICE_PRICES).micros)
})

test('a conversation is counted once, however often it is sent - in one batch or the next', async () => {
  const { post, fake } = meter()
  const once = ticket()
  const first = await post({ reports: [{ ticket: once, counts: DOC_COUNTS }, { ticket: once, counts: DOC_COUNTS }] })
  assert.deepEqual(first.body.accepted, [sidOf(once)])
  const puts = meterPuts(fake)
  const again = await post({ reports: [{ ticket: once, counts: DOC_COUNTS }] })
  assert.deepEqual(again.body.accepted, [sidOf(once)], 'a conversation already counted is not cleared from the outbox')
  assert.equal(meterPuts(fake), puts, 'a conversation already counted cost a write')
  const saved = JSON.parse(fake.files.get(METER_PATH).bytes.toString('utf8'))
  assert.equal(saved.months['2026-10'].conversations, 1)
})

test('a conversation is counted in the month it happened, from its ticket, not the month it was sent', async () => {
  const { post, fake } = meter()
  await post({ reports: [{ ticket: ticket({ ago: 10 * 24 * 3600_000 }), counts: DOC_COUNTS }] })
  const saved = JSON.parse(fake.files.get(METER_PATH).bytes.toString('utf8'))
  assert.equal(saved.months['2026-09'].conversations, 1)
  assert.equal(saved.months['2026-10'], undefined)
})

test('Fish characters are counted by model, at $0 on the free one', async () => {
  const { post, get } = meter()
  await post({ reports: [{ ticket: ticket({ mouth: 'fish' }), counts: { textIn: 100, textOut: 40, fishBytes: 8200 } }] })
  const shown = (await get()).body
  assert.deepEqual(shown.thisMonth.fishBytes, { 's2.1-pro-free': 8200 })
  assert.equal(shown.thisMonth.usd, costOf({ textIn: 100, textOut: 40 }, MINI, VOICE_PRICES).usd)
})

/* ---------- refusing ---------- */

test('nonsense counts and tickets this server did not sign are refused one by one, and the rest still count', async () => {
  const { post, fake } = meter()
  const good = ticket()
  const reports = [
    { ticket: good, counts: DOC_COUNTS },
    { ticket: ticket(), counts: { ...DOC_COUNTS, audioOut: -5 } },
    { ticket: ticket(), counts: { ...DOC_COUNTS, textIn: 1.5 } },
    { ticket: ticket(), counts: { ...DOC_COUNTS, audioOut: '91' } },
    { ticket: ticket(), counts: { ...DOC_COUNTS, audioOut: 10_000_000 } },
    { ticket: ticket(), counts: { ...DOC_COUNTS, fishBytes: 100 } },
    { ticket: ticket(), counts: 'lots' },
    { ticket: 'made.up', counts: DOC_COUNTS },
    { ticket: ticket({ ago: 36 * 24 * 3600_000 }), counts: DOC_COUNTS },
    { counts: DOC_COUNTS },
    'not a report'
  ]
  const response = await post({ reports })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.body.accepted, [sidOf(good)])
  assert.deepEqual(response.body.refused.map((one) => one.at), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  for (const one of response.body.refused) assert.equal(typeof one.why, 'string')
  const saved = JSON.parse(fake.files.get(METER_PATH).bytes.toString('utf8'))
  assert.equal(saved.months['2026-10'].conversations, 1)
})

test('a meter ticket is good for 35 days: one 30 days old still counts', async () => {
  const { post } = meter()
  const old = ticket({ ago: 30 * 24 * 3600_000 })
  assert.deepEqual((await post({ reports: [{ ticket: old, counts: DOC_COUNTS }] })).body.accepted, [sidOf(old)])
})

test(`more than ${20} reports at once are refused whole, and nothing is written`, async () => {
  assert.equal(MAX_REPORTS, 20)
  const { post, fake } = meter()
  const reports = Array.from({ length: 21 }, () => ({ ticket: ticket(), counts: DOC_COUNTS }))
  const response = await post({ reports })
  assert.equal(response.statusCode, 400)
  noCache(response, '21 reports')
  assert.equal(storeCalls(fake), 0)
  for (const body of [{}, { reports: 'x' }, null, []]) {
    assert.equal((await post(body)).statusCode, 400, JSON.stringify(body))
  }
})

/* ---------- kept for later ---------- */

test('at the day\'s meter-write limit every report is kept for later, with no write and no read past the cache', async () => {
  const { post, fake } = meter()
  for (let n = 0; n < 5; n += 1) {
    assert.equal((await post({ reports: [{ ticket: ticket(), counts: DOC_COUNTS }] })).body.accepted.length, 1)
  }
  const puts = fake.calls.put.length
  const uncached = () => fake.calls.get.filter((read) => read.options.useCache === false).length
  const reads = uncached()
  const waiting = [ticket(), ticket()]
  const response = await post({ reports: waiting.map((one) => ({ ticket: one, counts: DOC_COUNTS })) })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.body.accepted, [])
  assert.deepEqual(response.body.kept.sort(), waiting.map(sidOf).sort())
  assert.match(response.body.why, /kept on this device/)
  assert.equal(fake.calls.put.length, puts, 'a report past the limit was written')
  assert.equal(uncached(), reads, 'a report refused at the limit read past the cache')
})

test('with no store connected nothing is written: the reports are kept, and the page keeps the device\'s own total', async () => {
  const { post, get } = meter({ store: null, env: { VIEW_KEY, OPENAI_API_KEY: OPENAI_KEY } })
  const one = ticket()
  const response = await post({ reports: [{ ticket: one, counts: DOC_COUNTS }] })
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.store, false)
  assert.deepEqual(response.body.kept, [sidOf(one)])
  const shown = await get()
  assert.equal(shown.body.store, false)
  assert.equal(shown.body.prices.checked, PRICES_CHECKED)
})

test('a damaged meter file is said, never shown as zero, and reports wait rather than writing over it', async () => {
  const { post, get, fake } = meter()
  await fake.sdk.put(METER_PATH, 'not json', { access: 'private', allowOverwrite: true })
  const puts = fake.calls.put.length
  const shown = (await get()).body
  assert.equal(shown.damaged, true)
  assert.match(shown.why, /voice-meter\.json/)
  assert.equal(shown.thisMonth, undefined, 'a damaged meter was shown with totals')
  const response = await post({ reports: [{ ticket: ticket(), counts: DOC_COUNTS }] })
  assert.equal(response.body.kept.length, 1)
  assert.equal(fake.calls.put.length, puts)
})

/* ---------- showing ---------- */

test('GET shows this month, the last conversation, what is unpriced, writes left today and the price table', async () => {
  const { post, get } = meter()
  await post({ reports: [{ ticket: ticket(), counts: { ...DOC_COUNTS, transcribeTextIn: 3 } }] })
  const response = await get()
  assert.equal(response.statusCode, 200)
  noCache(response, 'GET')
  const shown = response.body
  assert.equal(shown.store, true)
  assert.equal(shown.thisMonth.month, '2026-10')
  assert.equal(shown.thisMonth.conversations, 1)
  assert.deepEqual(shown.thisMonth.incomplete, [`captions (${TRANSCRIBE_MODEL}) text in`])
  assert.equal(shown.last.usd, costOf(DOC_COUNTS, MINI, VOICE_PRICES).usd)
  assert.equal(shown.writesLeftToday, 4)
  assert.equal(shown.prices.checked, PRICES_CHECKED)
  assert.equal(shown.prices.transcribeModel, TRANSCRIBE_MODEL)
  assert.deepEqual(shown.prices.realtime, VOICE_PRICES.realtime)
  assert.equal(shown.thisMonth.sids, undefined, 'session ids are sent to the page')
  assert.ok(!everythingSent(response).includes(OPENAI_KEY))
})

/* ---------- the gates ---------- */

test('GET is behind the view key; POST is behind the write gate; both refuse before the store', async () => {
  const cases = [
    ['GET with no view key', 'GET', {}, ENV, 401],
    ['POST with no view key', 'POST', JSON_TYPE, ENV, 401],
    ['POST with no edit key when one is set', 'POST', asTheBoard(JSON_TYPE), { ...ENV, EDIT_KEY: 'e' }, 401],
    ['POST from another site', 'POST', asTheBoard({ ...JSON_TYPE, 'sec-fetch-site': 'cross-site' }), ENV, 403],
    ['POST as a form', 'POST', asTheBoard({ 'content-type': 'text/plain' }), ENV, 415]
  ]
  for (const [what, method, headers, env, status] of cases) {
    const { handler, fake } = meter({ env })
    const response = await call(handler, { method, headers, body: { reports: [{ ticket: ticket(), counts: DOC_COUNTS }] } })
    assert.equal(response.statusCode, status, what)
    noCache(response, what)
    assert.equal(storeCalls(fake), 0, `${what} reached the store`)
  }
  const { OPENAI_API_KEY, ...noKey } = ENV
  const keyless = await meter({ env: noKey }).post({ reports: [] })
  assert.equal(keyless.statusCode, 503)
  noCache(keyless, 'no key')
  const other = await call(meter().handler, { method: 'PUT', headers: asTheBoard() })
  assert.equal(other.statusCode, 405)
  noCache(other, 'a PUT')
})

test('GET says how many meter writes a day the picture caps leave - none at all when they use the whole budget', async () => {
  assert.equal((await meter().get()).body.writesPerDay, 5)
  const full = await meter({ env: { ...ENV, WRITE_DAILY_CAP: '27' } }).get()
  assert.equal(full.body.writesPerDay, 0)
  assert.equal(full.body.writesLeftToday, 0)
})

test('"last one" is the conversation that happened last, whatever order the reports arrive in', async () => {
  const { post, get } = meter()
  const newer = ticket({ ago: 60_000 })
  const older = ticket({ ago: 3_600_000 })
  const newerCounts = { ...DOC_COUNTS, audioOut: 1200 }
  await post({ reports: [{ ticket: newer, counts: newerCounts }] })
  await post({ reports: [{ ticket: older, counts: DOC_COUNTS }] })
  assert.equal((await get()).body.last.usd, costOf(newerCounts, MINI, VOICE_PRICES).usd, 'an older conversation sent later became "last one"')
  const { post: postBoth, get: getBoth } = meter()
  await postBoth({ reports: [{ ticket: ticket({ ago: 60_000 }), counts: newerCounts }, { ticket: ticket({ ago: 3_600_000 }), counts: DOC_COUNTS }] })
  assert.equal((await getBoth()).body.last.usd, costOf(newerCounts, MINI, VOICE_PRICES).usd)
})
