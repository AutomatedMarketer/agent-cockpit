// The voice spend meter's file in the picture store: agent-cockpit/voice-meter.json, its own file,
// added to pictureStore() as readMeter and saveMeter. Nothing that already existed changed.
//
// What these tests hold it to: a report is one put, into the meter's own file and never into
// settings.json; the meter only ever uses the writes the picture caps leave over (55 a day less
// what the caps can spend), counted in the meter's own file, so pictures, names and Make it carry on
// exactly as before however much talking happens; a damaged meter is refused, never read as zero;
// and a file somebody edited by hand cannot smuggle anything in.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  METER_PATH,
  SETTINGS_PATH,
  emptyMeter,
  meterWritesPerDay,
  meterWritesLeft,
  spendMeterWrite,
  PictureStoreError
} from '../api/_picture-store.js'
import { makeHandler as makeBrand } from '../api/brand.js'
import { makeHandler as makeUpload } from '../api/upload.js'
import { makeHandler as makeGenerate } from '../api/generate.js'
import { STORE_ENV, NOON, webp, connectedStore, asTheBoard, call } from './helpers/personalise-harness.mjs'
import { OPENAI_KEY } from './helpers/voice-fixtures.mjs'

const DAY = '2026-10-06'
const putsTo = (fake, path) => fake.calls.put.filter((put) => put.pathname === path).length
const sid = (n) => n.toString(16).padStart(32, '0')

// One meter report the way /api/voice-meter saves one: the day's meter write counted, then a
// conversation added to its month.
const report = (store, env = STORE_ENV, n = 1) => store.saveMeter((meter) => {
  spendMeterWrite(meter, env, DAY)
  const month = (meter.months['2026-10'] ??= { conversations: 0, micros: 0, incomplete: [], fishBytes: {}, sids: [] })
  month.conversations += 1
  month.micros += 2059
  month.sids.push(sid(n))
})

test('a fresh store has no meter file, and that reads as an empty meter - not a damaged one', async () => {
  const { store } = connectedStore()
  const { meter } = await store.readMeter()
  assert.deepEqual(meter, emptyMeter())
})

test('one report is exactly one put, to the meter\'s own private file, and never to settings.json', async () => {
  const { store, fake } = connectedStore()
  await store.saveSettings((draft) => { draft.assistantName = 'Penny' })
  const settingsPuts = putsTo(fake, SETTINGS_PATH)
  await report(store)
  assert.equal(putsTo(fake, METER_PATH), 1)
  assert.equal(putsTo(fake, SETTINGS_PATH), settingsPuts, 'a meter report wrote settings.json')
  assert.equal(METER_PATH, 'agent-cockpit/voice-meter.json')
  const [put] = fake.calls.put.filter((one) => one.pathname === METER_PATH)
  assert.equal(put.options.access, 'private')
  assert.equal(put.options.allowOverwrite, false, 'the first save may replace a file that appeared meanwhile')
  await report(store, STORE_ENV, 2)
  const second = fake.calls.put.filter((one) => one.pathname === METER_PATH)[1]
  assert.ok(second.options.ifMatch, 'a later save replaces the file without checking it is the one it read')
  const saved = JSON.parse(fake.files.get(METER_PATH).bytes.toString('utf8'))
  assert.equal(saved.months['2026-10'].conversations, 2)
  assert.equal(saved.writes, 2)
  assert.equal(JSON.parse(fake.files.get(SETTINGS_PATH).bytes.toString('utf8')).assistantName, 'Penny')
})

test('the meter may use only what the picture caps leave of 55 writes a day: 5 at the defaults', () => {
  assert.equal(meterWritesPerDay({}), 5)
  assert.equal(meterWritesPerDay({ WRITE_DAILY_CAP: '25', GENERATE_DAILY_CAP: '5' }), 0)
  assert.equal(meterWritesPerDay({ WRITE_DAILY_CAP: '10', GENERATE_DAILY_CAP: '10' }), 25)
  assert.equal(meterWritesPerDay({ WRITE_DAILY_CAP: '27', GENERATE_DAILY_CAP: '0' }), 1)
  // Caps asked for past the budget are clamped, and then nothing is left over for the meter.
  assert.equal(meterWritesPerDay({ WRITE_DAILY_CAP: '500', GENERATE_DAILY_CAP: '500' }), 0)
})

test('the day\'s meter writes are counted in the meter file, and stop at the allowance with nothing written', async () => {
  const { store, fake } = connectedStore()
  for (let n = 1; n <= 5; n += 1) await report(store, STORE_ENV, n)
  const puts = fake.calls.put.length
  await assert.rejects(report(store, STORE_ENV, 6), (error) => error instanceof PictureStoreError && error.status === 429)
  assert.equal(fake.calls.put.length, puts, 'a report past the allowance was written')
  assert.equal(meterWritesLeft((await store.readMeter({ fresh: true })).meter, STORE_ENV, DAY), 0)
  // A new UTC day starts the count again.
  assert.equal(meterWritesLeft((await store.readMeter({ fresh: true })).meter, STORE_ENV, '2026-10-07'), 5)
})

test('with the meter\'s writes all spent, uploads, renames and Make it still work exactly as before', async (t) => {
  const env = { ...STORE_ENV, OPENAI_API_KEY: OPENAI_KEY }
  const { store } = connectedStore(env)
  for (let n = 1; n <= 5; n += 1) await report(store, env, n)
  await assert.rejects(report(store, env, 6))

  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ b64_json: webp(500).toString('base64') }] }), { status: 200 })
  t.after(() => { globalThis.fetch = realFetch })

  const json = asTheBoard({ 'content-type': 'application/json' })
  const brand = makeBrand({ store, env, now: NOON })
  const renamed = await call(brand, { method: 'POST', headers: json, body: { change: 'name', slug: 'content', value: 'Penny' } })
  assert.equal(renamed.statusCode, 200, 'a rename was refused after the meter used its writes')
  const made = await call(makeGenerate({ store, env, now: NOON }), { method: 'POST', headers: json, body: { slot: 'today', description: 'a harbour' } })
  assert.equal(made.statusCode, 200, 'Make it was refused after the meter used its writes')
  const kept = await call(makeUpload({ store, env, now: NOON }), {
    method: 'POST', headers: asTheBoard({ 'content-type': 'application/octet-stream' }), query: { slot: 'today' }, body: made.sent
  })
  assert.equal(kept.statusCode, 200, 'an upload was refused after the meter used its writes')
  // And the picture caps are counted exactly as before: the meter took none of them.
  assert.deepEqual(kept.body.left, { writes: 18, generated: 9 })
})

test('a report refused at the allowance costs no read that skips the cache when the cached copy already says so', async () => {
  const { store, fake } = connectedStore()
  for (let n = 1; n <= 5; n += 1) await report(store, STORE_ENV, n)
  const uncached = () => fake.calls.get.filter((read) => read.options.useCache === false).length
  const before = uncached()
  for (let i = 0; i < 50; i += 1) {
    const { meter } = await store.readMeter()
    assert.equal(meterWritesLeft(meter, STORE_ENV, DAY), 0)
  }
  assert.equal(uncached(), before)
})

test('showing the meter is a cached read, and one per instance per 30 seconds at most', async () => {
  const { store, fake } = connectedStore()
  await report(store)
  const reads = fake.calls.get.length
  for (let i = 0; i < 100; i += 1) await store.readMeter()
  assert.ok(fake.calls.get.length - reads <= 1, `${fake.calls.get.length - reads} store reads for 100 views`)
  assert.ok(fake.calls.get.slice(reads).every((read) => read.options.useCache !== false))
})

test('a damaged meter file is refused with a sentence saying how to start again, never read as zero, and left alone', async () => {
  for (const damage of ['not json', '[1,2,3]', '"a string"', 'null', '{"version":1', 'x'.repeat(600 * 1024)]) {
    const { store, fake } = connectedStore()
    await fake.sdk.put(METER_PATH, damage, { access: 'private', allowOverwrite: true })
    const puts = fake.calls.put.length
    await assert.rejects(store.readMeter({ fresh: true }), (error) => {
      assert.equal(error.status, 502)
      assert.match(error.message, /voice-meter\.json/)
      assert.match(error.message, /delete/)
      return true
    })
    await assert.rejects(report(store))
    assert.equal(fake.calls.put.length, puts, `a report was written over a damaged meter (${damage.slice(0, 12)})`)
  }
})

test('a meter file edited by hand keeps only what the board itself writes', async () => {
  const { store, fake } = connectedStore()
  const months = {}
  for (let m = 1; m <= 20; m += 1) {
    const key = `20${m > 12 ? 26 : 25}-${String(((m - 1) % 12) + 1).padStart(2, '0')}`
    months[key] = { conversations: m, micros: 100 * m, incomplete: ['x'], fishBytes: { 's2.1-pro-free': 10 }, sids: [], extra: '<script>' }
  }
  months['2026-08'].sids = Array.from({ length: 600 }, (unused, n) => sid(n))
  months['2026-08'].conversations = -4
  months['2026-08'].micros = 1.5
  months['2026-08'].incomplete = ['ok', 42, 'y'.repeat(200), 'ok']
  months['2026-08'].fishBytes = { 's2.1-pro-free': 5, '../evil': 7, 's2.1-pro': -1 }
  months['not-a-month'] = { conversations: 99 }
  const hostile = {
    version: 1, day: '2026-10-06', writes: 'many', months, owner: 'mallory',
    last: { sid: 'nope', at: 'yesterday', micros: 5, extra: 1 }
  }
  // A month called __proto__ only exists as an own key when it arrives as text, the way a file does.
  const text = JSON.stringify(hostile).replace('"months":{', '"months":{"__proto__":{"conversations":1},')
  await fake.sdk.put(METER_PATH, text, { access: 'private', allowOverwrite: true })
  const { meter } = await store.readMeter({ fresh: true })
  assert.deepEqual(Object.keys(meter).sort(), ['day', 'last', 'months', 'version', 'writes'])
  assert.equal(meter.writes, 0)
  assert.equal(meter.last, null)
  const kept = Object.keys(meter.months)
  assert.equal(kept.length, 13, 'more than 13 months are kept')
  assert.deepEqual(kept, [...kept].sort().reverse(), 'months are not newest first')
  assert.equal(kept[0], '2026-08')
  const august = meter.months['2026-08']
  assert.deepEqual(Object.keys(august).sort(), ['conversations', 'fishBytes', 'incomplete', 'micros', 'sids'])
  assert.equal(august.conversations, 0)
  assert.equal(august.micros, 0)
  assert.deepEqual(august.incomplete, ['ok'])
  assert.deepEqual(august.fishBytes, { 's2.1-pro-free': 5 })
  assert.equal(august.sids.length, 500)
  assert.equal(august.sids.at(-1), sid(599), 'the newest session ids are not the ones kept')
})

test('a report builds on the latest meter, never on the copy a cache is still holding', async () => {
  // Two instances on one store, with the CDN in front keeping the first copy it saw.
  const { fakeBlob } = await import('./helpers/fake-blob.mjs')
  const { pictureStore } = await import('../api/_picture-store.js')
  const fake = fakeBlob({ cdn: true })
  const one = pictureStore(STORE_ENV, async () => fake.sdk)
  const two = pictureStore(STORE_ENV, async () => fake.sdk)
  await report(one, STORE_ENV, 1)
  await two.readMeter() // the CDN now holds the meter with one conversation
  await report(one, STORE_ENV, 2)
  await report(two, STORE_ENV, 3)
  const saved = JSON.parse(fake.files.get(METER_PATH).bytes.toString('utf8'))
  assert.equal(saved.months['2026-10'].conversations, 3, 'a report was built on an old copy and a conversation was lost')
})
