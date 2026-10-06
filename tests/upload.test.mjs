// /api/upload: one picture, already cropped and shrunk by the browser, into the picture store.
//
// The order is the contract: the write gate, then is there a store, then which slot, then are
// these really picture bytes, then are they small enough, then is there allowance left today -
// and only then a write. Each refusal below is checked to have happened before anything was
// written, because "refused, but stored first" is the bug these tests exist to catch.

import test from 'node:test'
import assert from 'node:assert/strict'
import { makeHandler } from '../api/upload.js'
import { makeHandler as makeGenerate } from '../api/generate.js'
import { makeHandler as makeBrand } from '../api/brand.js'
import { NOT_CONNECTED, SETTINGS_PATH, ADVANCED_OPS_PER_DAY, pictureStore } from '../api/_picture-store.js'
import { PICTURE_BUDGET } from '../api/lib.js'
import { BlobServiceNotAvailable, fakeBlob } from './helpers/fake-blob.mjs'
import {
  STORE_ENV,
  NOON,
  webp,
  png,
  jpeg,
  connectedStore,
  storeCalls,
  asTheBoard,
  call
} from './helpers/personalise-harness.mjs'

const BYTES = { 'content-type': 'application/octet-stream' }
const VERSION = /^[a-z0-9]{8,32}$/

function board({ env = STORE_ENV, now = NOON } = {}) {
  const connected = connectedStore(env)
  const handler = makeHandler({ store: connected.store, env, now })
  const upload = (slot, body, extra = {}) =>
    call(handler, { method: 'POST', headers: asTheBoard(BYTES), query: { slot }, body, ...extra })
  return { ...connected, handler, upload }
}

const picturePuts = (fake) => fake.calls.put.filter((put) => put.pathname !== SETTINGS_PATH)
const settingsOf = (fake) => JSON.parse(fake.files.get(SETTINGS_PATH).bytes.toString('utf8'))

/* ---------- the happy path ---------- */

test('a portrait is stored under a version the server made, and settings.json points at it', async () => {
  const { upload, fake } = board()
  const bytes = webp(2048)
  const response = await upload('agent-content', bytes)
  assert.equal(response.statusCode, 200)
  const { v, type } = response.body.picture
  assert.match(v, VERSION)
  assert.equal(type, 'image/webp')
  assert.equal(response.body.slot, 'agent-content')
  assert.deepEqual(response.body.left, { writes: 19, generated: 10 })

  const path = `agent-cockpit/art/agent-content/${v}.webp`
  assert.deepEqual(fake.files.get(path).bytes, bytes, 'the bytes stored are the bytes sent')
  assert.equal(fake.files.get(path).access, 'private')
  assert.deepEqual(settingsOf(fake).pictures['agent-content'], {
    v,
    type: 'image/webp',
    bytes: 2048,
    at: '2026-10-06T12:00:00.000Z'
  })
})

test('a new picture gets a new path, never overwriting, and the old one is removed after', async () => {
  const { upload, fake } = board()
  const first = (await upload('team', jpeg(4096))).body.picture
  const second = (await upload('team', jpeg(4096))).body.picture
  assert.notEqual(first.v, second.v, 'a version is never reused, so a cached copy is never wrong')
  assert.ok(picturePuts(fake).every((put) => put.options.allowOverwrite === false))
  assert.equal(fake.files.has(`agent-cockpit/art/team/${first.v}.jpeg`), false, 'the replaced picture was left behind')
  assert.equal(fake.files.has(`agent-cockpit/art/team/${second.v}.jpeg`), true)
  assert.equal(settingsOf(fake).pictures.team.v, second.v)
})

test('if the old picture cannot be deleted, the upload still succeeds', async () => {
  const { upload, fake } = board()
  await upload('today', webp())
  fake.failNext.del = new BlobServiceNotAvailable()
  const response = await upload('today', webp())
  assert.equal(response.statusCode, 200, 'a leftover file nobody points at is untidy, not a failed upload')
})

/* ---------- refusals, each before anything is written ---------- */

test('a hostile slot is refused before the store is touched', async () => {
  for (const slot of ['agent-../x', '../settings', 'agent-', 'team.webp', 'today/x', '%2e%2e', 'Team', undefined, ['team']]) {
    const { upload, fake } = board()
    const response = await upload(slot, webp())
    assert.equal(response.statusCode, 400, `${JSON.stringify(slot)} was not refused`)
    assert.equal(storeCalls(fake), 0, `${JSON.stringify(slot)} reached the store`)
  }
})

test('bytes that are not a webp, JPEG or PNG are refused, whatever they claim to be', async () => {
  const notPictures = {
    gif: Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'),
    svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'),
    html: Buffer.from('<!doctype html><script>alert(1)</script>'),
    wave: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(16)]),
    empty: Buffer.alloc(0)
  }
  for (const [name, bytes] of Object.entries(notPictures)) {
    const { upload, fake } = board()
    const response = await upload('agent-content', bytes)
    assert.equal(response.statusCode, 415, `${name} was not refused`)
    assert.match(response.body.error, /webp, JPEG or PNG/)
    assert.equal(picturePuts(fake).length, 0, `${name} was stored`)
  }
})

test('a portrait may be exactly 45 KB, and not one byte more', async () => {
  const atLimit = await board().upload('agent-content', webp(PICTURE_BUDGET.portrait))
  assert.equal(atLimit.statusCode, 200)

  const { upload, fake } = board()
  const over = await upload('agent-content', webp(PICTURE_BUDGET.portrait + 1))
  assert.equal(over.statusCode, 413)
  assert.match(over.body.error, /45 KB/)
  assert.equal(picturePuts(fake).length, 0)
})

test('a banner may be exactly 100 KB, and not one byte more', async () => {
  assert.equal((await board().upload('today', webp(PICTURE_BUDGET.banner))).statusCode, 200)
  const over = await board().upload('team', webp(PICTURE_BUDGET.banner + 1))
  assert.equal(over.statusCode, 413)
  assert.match(over.body.error, /100 KB/)
})

test('with no store connected, an upload is refused with the sentence that says how to connect one', async () => {
  const handler = makeHandler({ store: null, env: { VIEW_KEY: STORE_ENV.VIEW_KEY }, now: NOON })
  const response = await call(handler, { method: 'POST', headers: asTheBoard(BYTES), query: { slot: 'team' }, body: webp() })
  assert.equal(response.statusCode, 503)
  assert.equal(response.body.error, NOT_CONNECTED)
})

test('a picture that declares more than 2048 pixels on a side is refused before the store is touched', async () => {
  // From the security review (bomb.mjs): a 10 KB webp declaring 16383 x 16383 - about a gigabyte
  // once a browser decodes it - was stored, for every viewer's browser to open. The board's own
  // pictures are at most 1600 wide, so 2048 is room to spare; anything bigger, or a size that
  // cannot be read, is not one of them.
  const vp8l = (side) => {
    const bits = (side - 1) | ((side - 1) << 14)
    return Buffer.concat([Buffer.from('RIFF'), Buffer.from([26, 0, 0, 0]), Buffer.from('WEBPVP8L'), Buffer.from([10, 0, 0, 0]),
      Buffer.from([0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff]), Buffer.alloc(10_000)])
  }
  for (const [what, body] of [
    ['the review\'s 16383 x 16383 webp', vp8l(16383)],
    ['a 2049 pixel webp', webp(2000, 2049)],
    ['a 5000 pixel PNG', png(2000, 5000)],
    ['a 3000 pixel JPEG', jpeg(2000, 3000)]
  ]) {
    const { upload, fake } = board()
    const response = await upload('agent-content', body)
    assert.equal(response.statusCode, 413, `${what} was not refused`)
    assert.match(response.body.error, /2048/)
    assert.equal(storeCalls(fake), 0, `${what} reached the store`)
  }
  const unreadable = Buffer.concat([Buffer.from('RIFF'), Buffer.from([26, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(40)])
  const { upload, fake } = board()
  assert.equal((await upload('team', unreadable)).statusCode, 415, 'a picture whose size cannot be read was kept')
  assert.equal(storeCalls(fake), 0)
  assert.equal((await upload('team', webp(2000, 2048))).statusCode, 200, 'a 2048 pixel picture was refused')
})

test('the stored type comes from the bytes, never from what the request says it is', async () => {
  // A PNG sent with every hint saying webp. The path, the stored content type and the pointer
  // must all say PNG: /api/art will re-check the bytes, but nothing should disagree with them.
  const { upload, fake } = board()
  const response = await upload('agent-content', png(1024), {
    query: { slot: 'agent-content', type: 'image/webp', t: 'webp' },
    headers: asTheBoard({ ...BYTES, 'x-picture-type': 'image/webp' })
  })
  assert.equal(response.statusCode, 200)
  const { v, type } = response.body.picture
  assert.equal(type, 'image/png')
  const [put] = picturePuts(fake)
  assert.equal(put.pathname, `agent-cockpit/art/agent-content/${v}.png`)
  assert.equal(put.options.contentType, 'image/png')
  assert.equal(settingsOf(fake).pictures['agent-content'].type, 'image/png')
})

test('at the daily cap an upload is refused before the picture is stored', async () => {
  const { upload, fake } = board({ env: { ...STORE_ENV, WRITE_DAILY_CAP: '1' } })
  assert.equal((await upload('team', webp())).statusCode, 200)
  const refused = await upload('today', webp())
  assert.equal(refused.statusCode, 429)
  assert.match(refused.body.error, /tomorrow/)
  assert.equal(picturePuts(fake).length, 1, 'a refused upload still spent an advanced operation on the picture')
  assert.equal(settingsOf(fake).pictures.today, undefined)
})

test('uploads refused at the cap cost no read that skips the cache', async () => {
  const { upload, fake } = board({ env: { ...STORE_ENV, WRITE_DAILY_CAP: '1' } })
  assert.equal((await upload('team', webp())).statusCode, 200)
  const uncached = ((fake) => fake.calls.get.filter((read) => read.options.useCache === false).length)
  const before = uncached(fake)
  for (let i = 0; i < 100; i += 1) assert.equal((await upload('today', webp())).statusCode, 429)
  assert.equal(uncached(fake) - before, 0, 'refused uploads skipped the cache')
})

test('if settings.json cannot be saved, no picture is stored and the old one stays in use', async () => {
  const { upload, fake } = board()
  const old = (await upload('team', webp())).body.picture
  const realPut = fake.sdk.put
  fake.sdk.put = async (pathname, ...rest) => {
    if (pathname === SETTINGS_PATH) throw new BlobServiceNotAvailable()
    return realPut(pathname, ...rest)
  }
  const picturesBefore = picturePuts(fake).length
  const response = await upload('team', webp())
  assert.equal(response.statusCode, 503)
  assert.match(response.body.error, /not answering/)
  assert.equal(picturePuts(fake).length, picturesBefore, 'a picture was stored before the change was counted')
  const kept = [...fake.files.keys()].filter((path) => path.startsWith('agent-cockpit/art/team/'))
  assert.deepEqual(kept, [`agent-cockpit/art/team/${old.v}.webp`], 'the old picture was lost')
  assert.equal(settingsOf(fake).pictures.team.v, old.v)
})

test('if the picture cannot be stored, the slot points at the old picture again, and the change stays counted', async () => {
  // The change is counted and the slot pointed at the new version BEFORE the picture is stored,
  // so no picture is ever stored uncounted. If storing it then fails, the pointer goes back to the
  // old picture. The change is not given back: giving it back would be one more write, and a
  // store that keeps failing could then be tried forever without the count ever moving.
  const { upload, fake } = board()
  const old = (await upload('team', webp())).body.picture
  const realPut = fake.sdk.put
  fake.sdk.put = async (pathname, ...rest) => {
    if (pathname.includes('/art/')) throw new BlobServiceNotAvailable()
    return realPut(pathname, ...rest)
  }
  const response = await upload('team', webp())
  assert.equal(response.statusCode, 503)
  assert.match(response.body.error, /not answering/)
  const settings = settingsOf(fake)
  assert.equal(settings.pictures.team.v, old.v, 'the slot points at a picture that was never stored')
  assert.ok(fake.files.has(`agent-cockpit/art/team/${old.v}.webp`), 'the old picture was removed')
  assert.equal(settings.usage.writes, 2, 'the failed attempt was not counted')
})

// The fake's SDK with every call held up a little at random, so requests made together
// interleave the way real ones do.
function jittery(fake) {
  const sdk = { ...fake.sdk }
  for (const method of ['get', 'put', 'del']) {
    sdk[method] = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 3))
      return fake.sdk[method](...args)
    }
  }
  return sdk
}

test('two hundred uploads at once store no more pictures than the day allows', async () => {
  // From the security review: the allowance used to be checked on a copy, then the picture
  // stored, then the change counted - so uploads arriving together all passed the check and
  // all stored a picture (200 pictures against a cap of 25). Each picture is an advanced
  // operation, 2,000 a month on Hobby, and going over locks the store for 30 days.
  //
  // Four stores over one fake, as four function instances over one Blob store would be.
  const fake = fakeBlob()
  const sdk = jittery(fake)
  const env = { ...STORE_ENV, WRITE_DAILY_CAP: '25' }
  const handlers = Array.from({ length: 4 }, () => makeHandler({ store: pictureStore(env, async () => sdk), env, now: NOON }))
  const N = 200
  const results = await Promise.all(Array.from({ length: N }, (_, index) =>
    call(handlers[index % 4], { method: 'POST', headers: asTheBoard(BYTES), query: { slot: 'today' }, body: webp(2000) })))

  const stored = results.filter((result) => result.statusCode === 200).length
  const pictures = picturePuts(fake).length
  assert.ok(pictures <= 25, `${pictures} pictures were stored against a cap of 25`)
  assert.equal(pictures, stored, 'a picture was stored for an upload that was refused')
  assert.equal(settingsOf(fake).usage.writes, stored, 'what was counted is not what was stored')
  assert.ok(results.every((result) => [200, 409, 429].includes(result.statusCode)), 'an upload failed some other way')
  // Each request may try its settings write three times when it collides; never more, and no
  // picture on top of that unless it was counted.
  assert.ok(fake.calls.put.length <= 3 * N + 25, `${fake.calls.put.length} writes for ${N} uploads`)
})

test('a burst of uploads to one instance spends no writes on settings saves that collide', async () => {
  // Every put is an advanced operation, the failed ifMatch ones included. Saves made at the same
  // moment by one function instance take turns, so two hundred uploads there cost the 25 counted
  // changes and their 25 pictures - not three colliding settings writes each (the review measured
  // 593 of them for one burst before the turns).
  const fake = fakeBlob()
  const env = { ...STORE_ENV, WRITE_DAILY_CAP: '25' }
  const handler = makeHandler({ store: pictureStore(env, async () => jittery(fake)), env, now: NOON })
  const results = await Promise.all(Array.from({ length: 200 }, () =>
    call(handler, { method: 'POST', headers: asTheBoard(BYTES), query: { slot: 'today' }, body: webp(2000) })))
  assert.equal(results.filter((result) => result.statusCode === 200).length, 25)
  assert.ok(results.every((result) => [200, 429].includes(result.statusCode)), 'an upload failed some other way')
  assert.equal(fake.calls.put.length, 50, 'writes were spent on saves that collided')
})

test('a whole day of everything, with the caps set as high as they go, asks the store for at most 55 writes', async (t) => {
  // The budget is counted in puts, so it is proved in puts: pictures from words until refused,
  // then uploads until refused, then renames until refused - every put the store was asked for.
  const env = { ...STORE_ENV, OPENAI_API_KEY: 'sk-test', WRITE_DAILY_CAP: '1000', GENERATE_DAILY_CAP: '1000' }
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ b64_json: webp(500).toString('base64') }] }), { status: 200 })
  t.after(() => { globalThis.fetch = realFetch })
  const { fake, store } = connectedStore(env)
  const generate = makeGenerate({ store, env, now: NOON })
  const upload = makeHandler({ store, env, now: NOON })
  const brand = makeBrand({ store, env, now: NOON })
  const json = asTheBoard({ 'content-type': 'application/json' })
  const until = async (send) => {
    for (let i = 0; i < 1000; i += 1) if ((await send(i)).statusCode !== 200) return
  }
  await until(() => call(generate, { method: 'POST', headers: json, body: { slot: 'today', description: 'a harbour' } }))
  await until(() => call(upload, { method: 'POST', headers: asTheBoard(BYTES), query: { slot: 'today' }, body: webp(500) }))
  await until((i) => call(brand, { method: 'POST', headers: json, body: { change: 'name', slug: 'content', value: `Penny ${i}` } }))
  assert.ok(fake.calls.put.length <= ADVANCED_OPS_PER_DAY, `one day asked the store for ${fake.calls.put.length} writes`)
})

/* ---------- the body, however it arrives ---------- */

function streamOf(bytes, chunkSize = 1000) {
  let pulled = 0
  const request = {
    method: 'POST',
    headers: asTheBoard(BYTES),
    query: { slot: 'agent-content' },
    pulled: () => pulled,
    async *[Symbol.asyncIterator]() {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        pulled += 1
        yield bytes.subarray(offset, offset + chunkSize)
      }
    }
  }
  return request
}

test('a body that arrives as a stream is read', async () => {
  const { handler, fake } = board()
  const bytes = webp(5000)
  const response = await call(handler, streamOf(bytes))
  assert.equal(response.statusCode, 200)
  const [put] = picturePuts(fake)
  assert.deepEqual(fake.files.get(put.pathname).bytes, bytes)
})

test('a stream that runs past the size limit is refused without being read to the end', async () => {
  const { handler, fake } = board()
  const request = streamOf(webp(1024 * 1024))
  const response = await call(handler, request)
  assert.equal(response.statusCode, 413)
  assert.ok(request.pulled() < 100, `read ${request.pulled()} chunks of a 1 MB body to refuse it at 45 KB`)
  assert.equal(picturePuts(fake).length, 0)
})

test('no body at all is refused as not a picture', async () => {
  const { upload } = board()
  assert.equal((await upload('team', undefined)).statusCode, 415)
  assert.equal((await upload('team', 'RIFF....WEBPVP8 ')).statusCode, 415, 'a string is not bytes')
})

/* ---------- the rest of the contract ---------- */

test('only POST is answered', async () => {
  const { handler } = board()
  const response = await call(handler, { method: 'GET', headers: asTheBoard(), query: { slot: 'team' } })
  assert.equal(response.statusCode, 405)
  assert.equal(response.headers.Allow, 'POST')
})

test('an upload goes through the write gate: a JSON body type is refused before the store', async () => {
  const { handler, fake } = board()
  const response = await call(handler, {
    method: 'POST',
    headers: asTheBoard({ 'content-type': 'application/json' }),
    query: { slot: 'team' },
    body: webp()
  })
  assert.equal(response.statusCode, 415)
  assert.match(response.body.error, /application\/octet-stream/)
  assert.equal(storeCalls(fake), 0)
})
