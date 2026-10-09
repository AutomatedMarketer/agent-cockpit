// /api/brand: the names, the art style and the assistant's name, kept in the picture store's
// settings.json. GET is how the page learns whether personalising is on at all; POST is the one
// way to change a name or the style, or to put a picture back to the built-in one.
//
// What these tests hold it to: a board with no store says so in one sentence and nothing else
// changes; nothing the person typed reaches the store until it has passed its check; a picture
// is never deleted while settings.json still points at it; and a day's changes are capped.

import test from 'node:test'
import assert from 'node:assert/strict'
import { makeHandler } from '../api/brand.js'
import { NOT_CONNECTED, SETTINGS_PATH, pictureStore } from '../api/_picture-store.js'
import { DEFAULT_ART_STYLE } from '../api/lib.js'
import { BlobServiceNotAvailable, fakeBlob } from './helpers/fake-blob.mjs'
import {
  STORE_ENV,
  NOON,
  webp,
  connectedStore,
  storeCalls,
  asTheBoard,
  call
} from './helpers/personalise-harness.mjs'

const JSON_TYPE = { 'content-type': 'application/json' }

function board({ env = STORE_ENV, now = NOON } = {}) {
  const connected = connectedStore(env)
  const handler = makeHandler({ store: connected.store, env, now })
  const get = () => call(handler, { method: 'GET', headers: asTheBoard() })
  const post = (body) => call(handler, { method: 'POST', headers: asTheBoard(JSON_TYPE), body })
  return { ...connected, handler, get, post }
}

const readSettings = async (fake) => JSON.parse(fake.files.get(SETTINGS_PATH).bytes.toString('utf8'))

/* ---------- no store: one sentence, nothing else ---------- */

test('with no store connected, GET says personalising is off, in the one sentence that says how to switch it on', async () => {
  const handler = makeHandler({ store: null, env: { VIEW_KEY: STORE_ENV.VIEW_KEY }, now: NOON })
  const response = await call(handler, { method: 'GET', headers: asTheBoard() })
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.enabled, false)
  assert.equal(response.body.canGenerate, false)
  assert.equal(response.body.why, NOT_CONNECTED)
  assert.match(NOT_CONNECTED, /Private Blob store/, 'the sentence names the kind of store to make')
  assert.match(NOT_CONNECTED, /redeploy/, 'and the step people forget')
  assert.deepEqual(response.body.names, {})
  assert.deepEqual(response.body.pictures, {})
  assert.equal(response.headers['Cache-Control'], 'no-store')
})

test('with no store in the environment at all, GET is off and the SDK is never loaded', async () => {
  // The default wiring builds the store from the environment; with no store there must be no
  // store object and so no SDK, rather than a request that fails half-way through.
  let loads = 0
  const handler = makeHandler({ env: { VIEW_KEY: STORE_ENV.VIEW_KEY }, now: NOON, loadSdk: async () => { loads += 1 } })
  const response = await call(handler, { method: 'GET', headers: asTheBoard() })
  assert.equal(response.body.enabled, false)
  assert.equal(loads, 0)
})

test('with no store connected, a change is refused with the same sentence', async () => {
  const handler = makeHandler({ store: null, env: { VIEW_KEY: STORE_ENV.VIEW_KEY }, now: NOON })
  const response = await call(handler, {
    method: 'POST',
    headers: asTheBoard(JSON_TYPE),
    body: { change: 'name', slug: 'content', value: 'Penny' }
  })
  assert.equal(response.statusCode, 503)
  assert.equal(response.body.error, NOT_CONNECTED)
})

/* ---------- what GET says when a store is there ---------- */

test('a connected, empty store reads as the defaults, with the full day\'s allowance', async () => {
  const { get, fake } = board()
  const response = await get()
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['Cache-Control'], 'no-store', 'a cached answer would show a name the owner already changed')
  assert.deepEqual(response.body, {
    enabled: true,
    canGenerate: false,
    why: response.body.why,
    assistantName: '',
    artStyle: '',
    defaultArtStyle: DEFAULT_ART_STYLE,
    names: {},
    pictures: {},
    left: { writes: 20, generated: 10 },
    // Voice rides along; with no OPENAI_API_KEY it is off and says why.
    voice: { on: false, why: response.body.voice.why, mouth: 'openai' }
  })
  assert.match(response.body.voice.why, /OPENAI_API_KEY/)
  assert.equal(fake.calls.get.length, 1, 'a page load is one read of settings.json')
  assert.equal(fake.calls.put.length, 0, 'reading never writes')
})

test('a stranger loading an open board a thousand times costs only cached reads', async () => {
  // From the security review: on a PUBLIC_DASHBOARD board GET needs no key at all, and a read that
  // skips the cache is a cache MISS - one of the 10,000 simple operations Hobby includes a month,
  // and going over locks the store for 30 days. A reload loop must cost cache hits, which are free.
  const env = { PUBLIC_DASHBOARD: 'true', EDIT_KEY: 'owner-only-edit-key-xyz', BLOB_STORE_ID: 'store_fake' }
  const { fake, store } = connectedStore(env)
  const handler = makeHandler({ store, env, now: NOON })
  for (let i = 0; i < 1000; i += 1) {
    const response = await call(handler, { method: 'GET', headers: {} })
    assert.equal(response.statusCode, 200)
    assert.equal(response.body.enabled, true)
  }
  const forced = fake.calls.get.filter((read) => read.options.useCache === false).length
  assert.equal(forced, 0, `${forced} of 1000 page loads skipped the cache`)
})

test('on a fresh store with no settings file yet, a thousand page loads cost one store read per instance', async (t) => {
  // From the second review: before the first change there is no settings.json, and whether the
  // CDN keeps a "not found" could not be checked - if it does not, every load of an open board is
  // a billed miss. GET must never create the file (that would let anyone spend writes), so each
  // instance remembers its last read for 30 s, "not there" included.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-06T12:00:00Z') })
  const env = { PUBLIC_DASHBOARD: 'true', EDIT_KEY: 'owner-only-edit-key-xyz', BLOB_STORE_ID: 'store_fake' }
  const fake = fakeBlob()
  const instances = [1, 2].map(() => makeHandler({ store: pictureStore(env, async () => fake.sdk), env, now: NOON }))
  for (let i = 0; i < 1000; i += 1) {
    const response = await call(instances[i % 2], { method: 'GET', headers: {} })
    assert.equal(response.body.enabled, true)
  }
  assert.equal(fake.calls.get.length, 2, 'more than one read of the missing file per instance')
  assert.equal(fake.calls.put.length, 0, 'a page load wrote to the store')
  t.mock.timers.tick(30_001)
  await call(instances[0], { method: 'GET', headers: {} })
  assert.equal(fake.calls.get.length, 3, 'a remembered read outlived its 30 seconds')
})

test('a change shows on the next page load from the same instance at once, not 30 seconds later', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-06T12:00:00Z') })
  const { get, post } = board()
  assert.deepEqual((await get()).body.names, {})
  await post({ change: 'name', slug: 'content', value: 'Penny' })
  assert.deepEqual((await get()).body.names, { content: 'Penny' }, 'the instance that saved showed what it remembered from before')
})

test('a change is answered with the board as it is now, even while the cache still holds the old copy', async () => {
  // GET may be up to a minute behind; the person who made a change must not be.
  const connected = connectedStore(STORE_ENV, { cdn: true })
  const handler = makeHandler({ store: connected.store, env: STORE_ENV, now: NOON })
  const post = (body) => call(handler, { method: 'POST', headers: asTheBoard(JSON_TYPE), body })
  await post({ change: 'name', slug: 'content', value: 'Penny' })
  await call(handler, { method: 'GET', headers: asTheBoard() }) // the cache keeps this copy
  await post({ change: 'name', slug: 'sales', value: 'Sam' })
  const answer = await post({ change: 'name', slug: 'email', value: 'Eve' })
  assert.equal(answer.statusCode, 200)
  assert.deepEqual(answer.body.names, { content: 'Penny', sales: 'Sam', email: 'Eve' })
})

test('making pictures from words is on only with OPENAI_API_KEY, and the reason names it', async () => {
  const without = await board().get()
  assert.equal(without.body.canGenerate, false)
  assert.match(without.body.why, /OPENAI_API_KEY/)

  const withKey = await board({ env: { ...STORE_ENV, OPENAI_API_KEY: 'sk-test-never-shown' } }).get()
  assert.equal(withKey.body.canGenerate, true)
  assert.equal(withKey.body.why, undefined)
  assert.ok(!JSON.stringify(withKey.body).includes('sk-test-never-shown'), 'the key itself is never sent')
})

test('the daily caps come from the environment, and a nonsense value keeps the default', async () => {
  const set = await board({ env: { ...STORE_ENV, WRITE_DAILY_CAP: '7', GENERATE_DAILY_CAP: '3' } }).get()
  assert.deepEqual(set.body.left, { writes: 7, generated: 3 })
  const nonsense = await board({ env: { ...STORE_ENV, WRITE_DAILY_CAP: 'lots', GENERATE_DAILY_CAP: '-1' } }).get()
  assert.deepEqual(nonsense.body.left, { writes: 20, generated: 10 })
})

test('GET is behind the view key', async () => {
  const { handler, fake } = board()
  const response = await call(handler, { method: 'GET', headers: {} })
  assert.equal(response.statusCode, 401)
  assert.equal(storeCalls(fake), 0, 'nothing is read for a caller without the key')
})

test('a store that refuses to answer turns personalising off with its sentence, not a broken page', async () => {
  const { get, fake } = board()
  fake.failNext.get = new BlobServiceNotAvailable()
  const response = await get()
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.enabled, false)
  assert.match(response.body.why, /not answering/)
})

/* ---------- names ---------- */

test('a name is saved, shown, and an empty one puts the slug back', async () => {
  const { get, post } = board()
  const saved = await post({ change: 'name', slug: 'content', value: '  Penny  ' })
  assert.equal(saved.statusCode, 200)
  assert.deepEqual(saved.body.names, { content: 'Penny' }, 'the answer to a change is the board as it now is')
  assert.deepEqual((await get()).body.names, { content: 'Penny' })

  await post({ change: 'name', slug: 'content', value: '' })
  assert.deepEqual((await get()).body.names, {}, 'an empty name means "back to the slug"')
})

test('a name that looks like markup is kept as the text it is', async () => {
  // The page escapes every name. Deciding here what markup is "safe" would be a second defence
  // that drifts from the real one - so it is stored exactly, and the render test escapes it.
  const { get, post } = board()
  await post({ change: 'name', slug: 'sales', value: '<img src=x onerror=alert(1)>' })
  assert.equal((await get()).body.names.sales, '<img src=x onerror=alert(1)>')
})

test('an invalid slug, name or change is refused before the store is touched at all', async () => {
  const refusals = [
    { change: 'name', slug: '../settings', value: 'x' },
    { change: 'name', slug: 'Content', value: 'x' },
    { change: 'name', value: 'x' },
    { change: 'name', slug: 'content', value: 'Pen‮ny' },
    { change: 'name', slug: 'content', value: 'x'.repeat(41) },
    { change: 'name', slug: 'content', value: 42 },
    { change: 'assistant', value: 'a'.repeat(41) },
    { change: 'style', value: 's'.repeat(601) },
    { change: 'reset-picture', slot: 'agent-../x' },
    { change: 'reset-picture', slot: 'team.webp' },
    { change: 'rename-everything' },
    {},
    null,
    'name'
  ]
  for (const body of refusals) {
    const { post, fake } = board()
    const response = await post(body)
    assert.equal(response.statusCode, 400, `${JSON.stringify(body)} was not refused`)
    assert.equal(typeof response.body.error, 'string')
    assert.equal(storeCalls(fake), 0, `${JSON.stringify(body)} reached the store before it was checked`)
  }
})

/* ---------- the assistant and the art style ---------- */

test('the assistant\'s name and the art style are saved, and empty means the default', async () => {
  const { get, post } = board()
  await post({ change: 'assistant', value: 'Ada' })
  await post({ change: 'style', value: 'Soft watercolour animals, morning light.' })
  let shown = (await get()).body
  assert.equal(shown.assistantName, 'Ada')
  assert.equal(shown.artStyle, 'Soft watercolour animals, morning light.')
  assert.equal(shown.defaultArtStyle, DEFAULT_ART_STYLE, 'the default is still offered, to go back to')

  await post({ change: 'style', value: '' })
  await post({ change: 'assistant', value: '' })
  shown = (await get()).body
  assert.equal(shown.artStyle, '')
  assert.equal(shown.assistantName, '')
})

// Found clicking through the preview 2026-10-07: Save the style on an untouched box sent the
// default back, and the panel then called it "Your own style" with the default printed twice.
test('saving the default style word for word keeps it the default', async () => {
  const { get, post } = board()
  await post({ change: 'style', value: `  ${DEFAULT_ART_STYLE}  ` })
  assert.equal((await get()).body.artStyle, '')
})

/* ---------- putting a picture back to the built-in one ---------- */

async function withPicture() {
  const setup = board()
  const v = 'abcdefgh1234'
  const path = await setup.store.putPicture('agent-content', v, webp(), 'image/webp')
  await setup.store.saveSettings((settings) => {
    settings.pictures['agent-content'] = { v, type: 'image/webp', bytes: 64, at: '2026-10-06T11:00:00.000Z' }
  })
  return { ...setup, v, path }
}

test('back to the default removes the pointer and then the picture', async () => {
  const { post, get, fake, path } = await withPicture()
  assert.deepEqual((await get()).body.pictures, { 'agent-content': { v: 'abcdefgh1234', type: 'image/webp' } },
    'GET shows which version to fetch and its type, nothing more')
  const response = await post({ change: 'reset-picture', slot: 'agent-content' })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.body.pictures, {})
  assert.deepEqual((await readSettings(fake)).pictures, {})
  assert.equal(fake.files.has(path), false, 'the picture itself is gone, not left to fill the store')
})

test('if the pointer cannot be removed, the picture it points at survives', async () => {
  // Pointer first, picture second. The other order, with a failed save, leaves settings.json
  // pointing at a file that no longer exists: a broken picture on every page load.
  const { post, fake, path, v } = await withPicture()
  fake.failNext.put = new BlobServiceNotAvailable()
  const response = await post({ change: 'reset-picture', slot: 'agent-content' })
  assert.equal(response.statusCode, 503)
  assert.match(response.body.error, /not answering/)
  assert.equal(fake.files.has(path), true, 'the picture was deleted while settings.json still pointed at it')
  assert.equal((await readSettings(fake)).pictures['agent-content'].v, v)
  assert.equal(fake.calls.del.length, 0)
})

test('if the picture cannot be deleted after the pointer is gone, the reset still succeeds', async () => {
  const { post, fake } = await withPicture()
  fake.failNext.del = new BlobServiceNotAvailable()
  const response = await post({ change: 'reset-picture', slot: 'agent-content' })
  assert.equal(response.statusCode, 200, 'a leftover file nobody points at is untidy, not broken')
  assert.deepEqual(response.body.pictures, {})
})

test('renaming day after day can never grow settings.json past what it can hold, and the owner\'s names survive', async () => {
  // From the security review (overflow.mjs): long slugs and long emoji names, within the daily
  // cap, over a fortnight - until settings.json passed 64 KB, read back as the defaults, and the
  // next change wiped the assistant's name and every name with it.
  const { fake, store } = connectedStore()
  let day = 0
  const now = () => new Date(Date.UTC(2026, 9, 6 + day, 12))
  const handler = makeHandler({ store, env: STORE_ENV, now })
  const post = (body) => call(handler, { method: 'POST', headers: asTheBoard(JSON_TYPE), body })
  await post({ change: 'assistant', value: 'Donna' })
  await post({ change: 'name', slug: 'content', value: 'Penny' })
  let refused = null
  for (let i = 0; i < 400 && !refused; i += 1) {
    const slug = `${'x'.repeat(96)}${String(i).padStart(4, '0')}`
    const answer = await post({ change: 'name', slug, value: '\u{1F600}'.repeat(20) })
    if (answer.statusCode === 429) {
      day += 1
      i -= 1
    } else if (answer.statusCode !== 200) refused = answer
  }
  assert.ok(refused, 'four hundred names were all accepted')
  assert.equal(refused.statusCode, 413)
  assert.match(refused.body.error, /64 agents/)
  assert.ok(fake.files.get(SETTINGS_PATH).bytes.length <= 64 * 1024, 'settings.json grew past what it can read back')
  const shown = (await call(handler, { method: 'GET', headers: asTheBoard() })).body
  assert.equal(shown.enabled, true)
  assert.equal(shown.assistantName, 'Donna', 'the assistant\'s name was lost')
  assert.equal(shown.names.content, 'Penny', 'the owner\'s names were lost')
  assert.equal((await post({ change: 'name', slug: 'content', value: 'Pen' })).statusCode, 200, 'renaming an agent already named was refused')
})

test('a damaged settings file turns personalising off with a sentence saying what to do, and is left alone', async () => {
  const { get, post, fake } = board()
  await fake.sdk.put(SETTINGS_PATH, '{ "names": { "content": "Pen', { access: 'private', allowOverwrite: false })
  const before = fake.files.get(SETTINGS_PATH).bytes
  const shown = await get()
  assert.equal(shown.statusCode, 200)
  assert.equal(shown.body.enabled, false)
  assert.equal(shown.body.fault, true, 'the page cannot tell a broken store from one never connected')
  assert.match(shown.body.why, /settings/)
  assert.match(shown.body.why, /delete/)
  const change = await post({ change: 'assistant', value: 'Donna' })
  assert.equal(change.statusCode, 502)
  assert.deepEqual(fake.files.get(SETTINGS_PATH).bytes, before, 'a change wrote the defaults over the file')
})

/* ---------- the daily cap ---------- */

test('changes stop at the daily cap with a sentence, and nothing is written past it', async () => {
  const { post, get, fake } = board({ env: { ...STORE_ENV, WRITE_DAILY_CAP: '2' } })
  assert.equal((await post({ change: 'name', slug: 'content', value: 'One' })).statusCode, 200)
  assert.equal((await post({ change: 'name', slug: 'sales', value: 'Two' })).statusCode, 200)
  assert.equal((await get()).body.left.writes, 0)
  const puts = fake.calls.put.length

  const refused = await post({ change: 'name', slug: 'email', value: 'Three' })
  assert.equal(refused.statusCode, 429)
  assert.match(refused.body.error, /tomorrow/)
  // Raising the cap used to be the advice. Past the budget that is the advice that locks the store,
  // so the sentence says why the limit is there instead.
  assert.match(refused.body.error, /Vercel/, 'the sentence does not say whose allowance the limit protects')
  assert.match(refused.body.error, /30 days/, 'the sentence does not say what passing it costs')
  assert.doesNotMatch(refused.body.error, /raise|WRITE_DAILY_CAP/i, 'the owner is told to raise the cap')
  assert.equal(fake.calls.put.length, puts, 'a refused change wrote nothing')
  assert.equal((await readSettings(fake)).names.email, undefined)
})

test('a thousand changes refused at the cap cost no read that skips the cache', async () => {
  // From the second review (attack2, part A): every save began with an uncached read - one of the
  // 10,000 simple operations a month - before the cap was checked, so changes refused at the cap
  // still ran the meter. The cached copy is checked first: it can only be behind (counts only
  // rise, the day only moves forward), so when it says the day is spent, the day is spent.
  const { post, fake } = board()
  for (let i = 0; i < 20; i += 1) assert.equal((await post({ change: 'name', slug: 'content', value: `N${i}` })).statusCode, 200)
  const uncached = ((fake) => fake.calls.get.filter((read) => read.options.useCache === false).length)
  const before = uncached(fake)
  const puts = fake.calls.put.length
  for (let i = 0; i < 1000; i += 1) assert.equal((await post({ change: 'name', slug: 'content', value: 'x' })).statusCode, 429)
  assert.equal(uncached(fake) - before, 0, 'refused changes skipped the cache')
  assert.equal(fake.calls.put.length, puts)
})

test('when another instance used up the day, this one pays for at most one read that skips the cache', async () => {
  // From the third review (attack4, part E): instance A remembered a copy with room in it, so
  // every change sent to A passed the cached check, reached the save, read the file fresh, found
  // the day spent and was refused - and that fresh read never replaced A's copy, so the next one
  // did it all again: 1,000 refusals, 1,000 billed reads. Every fresh read now replaces the copy.
  const fake = fakeBlob({ cdn: true })
  const instanceA = makeHandler({ store: pictureStore(STORE_ENV, async () => fake.sdk), env: STORE_ENV, now: NOON })
  const instanceB = makeHandler({ store: pictureStore(STORE_ENV, async () => fake.sdk), env: STORE_ENV, now: NOON })
  const post = (handler, body) => call(handler, { method: 'POST', headers: asTheBoard(JSON_TYPE), body })
  await post(instanceB, { change: 'assistant', value: 'Donna' })
  await call(instanceA, { method: 'GET', headers: asTheBoard() }) // A now remembers 1 of 20 used
  for (let i = 0; i < 19; i += 1) assert.equal((await post(instanceB, { change: 'name', slug: 'content', value: `n${i}` })).statusCode, 200)
  const uncached = () => fake.calls.get.filter((read) => read.options.useCache === false).length
  const before = uncached()
  for (let i = 0; i < 1000; i += 1) assert.equal((await post(instanceA, { change: 'name', slug: 'sales', value: 'x' })).statusCode, 429)
  assert.ok(uncached() - before <= 1, `${uncached() - before} reads skipped the cache for 1000 refusals on one instance`)
})

test('the day the cap counts is the UTC day: it starts again at midnight UTC', async () => {
  let clock = new Date('2026-10-06T23:59:00Z')
  const { post } = board({ env: { ...STORE_ENV, WRITE_DAILY_CAP: '1' }, now: () => clock })
  assert.equal((await post({ change: 'assistant', value: 'Ada' })).statusCode, 200)
  assert.equal((await post({ change: 'assistant', value: 'Bea' })).statusCode, 429)
  clock = new Date('2026-10-07T00:01:00Z')
  const nextDay = await post({ change: 'assistant', value: 'Cy' })
  assert.equal(nextDay.statusCode, 200)
  assert.equal(nextDay.body.left.writes, 0)
})

test('a change that started just before midnight cannot start the new day\'s count again', async () => {
  // A request whose clock read 23:59:59 can reach the store after another request has already
  // started the new day's count. Resetting the count to "its" day would hand the new day's
  // allowance back: the day only ever moves forward.
  const { post, store, fake } = board({ env: { ...STORE_ENV, WRITE_DAILY_CAP: '2' }, now: () => new Date('2026-10-06T23:59:59Z') })
  await store.saveSettings((draft) => { draft.usage = { day: '2026-10-07', writes: 2, generated: 0 } })
  const late = await post({ change: 'assistant', value: 'Ada' })
  assert.equal(late.statusCode, 429, 'a request from yesterday reset today\'s count')
  assert.deepEqual((await readSettings(fake)).usage, { day: '2026-10-07', writes: 2, generated: 0, pending: [] })
  const shown = await call(makeHandler({ store, env: { ...STORE_ENV, WRITE_DAILY_CAP: '2' }, now: () => new Date('2026-10-06T23:59:59Z') }),
    { method: 'GET', headers: asTheBoard() })
  assert.equal(shown.body.left.writes, 0, 'yesterday\'s screen is told today\'s changes are all there')
})

/* ---------- the rest of the contract ---------- */

test('only GET and POST are answered', async () => {
  const { handler } = board()
  const response = await call(handler, { method: 'DELETE', headers: asTheBoard(JSON_TYPE) })
  assert.equal(response.statusCode, 405)
  assert.equal(response.headers.Allow, 'GET, POST')
})

test('a change goes through the write gate: the wrong body type is refused before the store', async () => {
  const { handler, fake } = board()
  const response = await call(handler, {
    method: 'POST',
    headers: asTheBoard({ 'content-type': 'text/plain' }),
    body: '{"change":"name","slug":"content","value":"Penny"}'
  })
  assert.equal(response.statusCode, 415)
  assert.equal(storeCalls(fake), 0)
})

test('a JSON body that arrives as a string is read the same way', async () => {
  const { handler, get } = board()
  const response = await call(handler, {
    method: 'POST',
    headers: asTheBoard(JSON_TYPE),
    body: JSON.stringify({ change: 'name', slug: 'content', value: 'Penny' })
  })
  assert.equal(response.statusCode, 200)
  assert.equal((await get()).body.names.content, 'Penny')
})

/* ---------- voice: whether the orb shows, and which mouth speaks ---------- */
// The page learns whether to show the orb from this answer, so it needs no extra request. Voice does
// not need the picture store, so it is reported the same with personalising on or off.

const OPENAI_KEY = ['sk', 'test', 'brandVoiceKey'].join('-')
const FISH_KEY = ['fish', 'test', 'brandVoiceKey'].join('_')
const FISH_VOICE = '0123456789abcdef'.repeat(2)

test('voice is on with OPENAI_API_KEY, in OpenAI\'s own voice, and the answer says so', async () => {
  const response = await board({ env: { ...STORE_ENV, OPENAI_API_KEY: OPENAI_KEY } }).get()
  assert.deepEqual(response.body.voice, { on: true, mouth: 'openai' })
})

test('voice is on without a picture store too', async () => {
  const handler = makeHandler({ store: null, env: { VIEW_KEY: STORE_ENV.VIEW_KEY, OPENAI_API_KEY: OPENAI_KEY }, now: NOON })
  const response = await call(handler, { method: 'GET', headers: asTheBoard() })
  assert.equal(response.body.enabled, false)
  assert.deepEqual(response.body.voice, { on: true, mouth: 'openai' })
})

test('voice off says why: no OPENAI_API_KEY, or an open board without EDIT_KEY', async () => {
  const noKey = (await board().get()).body.voice
  assert.equal(noKey.on, false)
  assert.match(noKey.why, /OPENAI_API_KEY/)
  const handler = makeHandler({ store: null, env: { PUBLIC_DASHBOARD: 'true', OPENAI_API_KEY: OPENAI_KEY }, now: NOON })
  const open = (await call(handler, { method: 'GET', headers: {} })).body.voice
  assert.equal(open.on, false)
  assert.match(open.why, /EDIT_KEY/)
})

test('the mouth is Fish only with both Fish settings, and a half-set Fish is explained', async () => {
  const fish = { ...STORE_ENV, OPENAI_API_KEY: OPENAI_KEY, FISH_API_KEY: FISH_KEY, FISH_VOICE_ID: FISH_VOICE }
  assert.equal((await board({ env: fish }).get()).body.voice.mouth, 'fish')
  const { FISH_VOICE_ID, ...half } = fish
  const halfSet = (await board({ env: half }).get()).body.voice
  assert.equal(halfSet.mouth, 'openai')
  assert.match(halfSet.note, /FISH_VOICE_ID/)
})

test('a change is answered with voice too, and no key or voice id is ever in the answer', async () => {
  const env = { ...STORE_ENV, OPENAI_API_KEY: OPENAI_KEY, FISH_API_KEY: FISH_KEY, FISH_VOICE_ID: FISH_VOICE }
  const { get, post } = board({ env })
  const changed = await post({ change: 'assistant', value: 'Penny' })
  assert.deepEqual(changed.body.voice, { on: true, mouth: 'fish' })
  for (const response of [changed, await get()]) {
    const sent = JSON.stringify(response.body)
    for (const secret of [OPENAI_KEY, FISH_KEY, FISH_VOICE]) assert.ok(!sent.includes(secret), 'a key or voice id reached the page')
  }
})
