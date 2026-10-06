// /api/art?slot&v&t: one stored picture, from the PRIVATE store, to a viewer with the view key.
//
// An <img> cannot send the view key, so the page fetches each picture with the key and shows it
// from memory. What these tests hold the endpoint to: nothing outside our own path shapes ever
// reaches the store; what is served is re-checked as a picture on the way out, typed by its
// bytes, never by what the store or the URL says; and a version is cached forever because it
// can never change.

import test from 'node:test'
import assert from 'node:assert/strict'
import { makeHandler } from '../api/art.js'
import { NOT_CONNECTED } from '../api/_picture-store.js'
import { BlobServiceNotAvailable } from './helpers/fake-blob.mjs'
import {
  STORE_ENV,
  VIEW_KEY,
  webp,
  png,
  connectedStore,
  storeCalls,
  asTheBoard,
  call
} from './helpers/personalise-harness.mjs'

const V = 'abcdefgh1234'
const FOREVER = 'private, max-age=31536000, immutable'

function board({ env = STORE_ENV } = {}) {
  const connected = connectedStore(env)
  const handler = makeHandler({ store: connected.store, env })
  const fetchArt = (query, headers = asTheBoard()) => call(handler, { method: 'GET', headers, query })
  // Put a file straight into the fake store, as if something other than /api/upload wrote it.
  const plant = (path, bytes, contentType = 'image/webp') =>
    connected.fake.files.set(path, { bytes, contentType, etag: '"planted"', access: 'private' })
  return { ...connected, handler, fetchArt, plant }
}

/* ---------- serving ---------- */

test('a stored picture is served as its bytes, typed by them, cached for good, never sniffed', async () => {
  const { fetchArt, store } = board()
  const bytes = webp(3000)
  await store.putPicture('agent-content', V, bytes, 'image/webp')
  const response = await fetchArt({ slot: 'agent-content', v: V, t: 'webp' })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(Buffer.from(response.sent), bytes)
  assert.equal(response.headers['Content-Type'], 'image/webp')
  assert.equal(response.headers['Cache-Control'], FOREVER,
    'a version never changes, so it is cached forever - privately, because it sits behind the view key')
  assert.equal(response.headers['X-Content-Type-Options'], 'nosniff')
})

test('the Content-Type comes from the bytes, not from the path or what the store says', async () => {
  const { fetchArt, plant } = board()
  plant(`agent-cockpit/art/team/${V}.webp`, png(500), 'image/webp')
  const response = await fetchArt({ slot: 'team', v: V, t: 'webp' })
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['Content-Type'], 'image/png')
})

test('a planted file that is not a picture is refused, and none of it is sent', async () => {
  // Stored with an image content type and an image path, but its bytes are a page with script.
  // Served as-is, a browser opening /api/art directly would get HTML from the board's own origin.
  const { fetchArt, plant } = board()
  plant(`agent-cockpit/art/today/${V}.webp`, Buffer.from('<!doctype html><script>alert(1)</script>'), 'image/webp')
  const response = await fetchArt({ slot: 'today', v: V, t: 'webp' })
  assert.equal(response.statusCode, 502)
  assert.equal(response.sent, null)
  assert.ok(!JSON.stringify(response.body).includes('script'))
  assert.notEqual(response.headers['Cache-Control'], FOREVER, 'a refusal must not be cached as if it were the picture')
})

test('a stored file over the size limit is refused rather than read whole', async () => {
  const { fetchArt, plant } = board()
  plant(`agent-cockpit/art/team/${V}.webp`, webp(111 * 1024))
  const response = await fetchArt({ slot: 'team', v: V, t: 'webp' })
  assert.equal(response.statusCode, 502)
  assert.equal(response.sent, null)
})

test('a picture that is not there is a 404', async () => {
  const { fetchArt } = board()
  const response = await fetchArt({ slot: 'agent-content', v: V, t: 'webp' })
  assert.equal(response.statusCode, 404)
  assert.equal(typeof response.body.error, 'string')
})

/* ---------- refusals before the store ---------- */

const HOSTILE = [
  { slot: 'agent-content', v: '../settings', t: 'webp' },
  { slot: 'agent-content', v: 'ABCDEFGH1234', t: 'webp' },
  { slot: 'agent-content', v: 'short', t: 'webp' },
  { slot: 'agent-content', v: 'a'.repeat(33), t: 'webp' },
  { slot: 'agent-content', v: `${V}.json`, t: 'webp' },
  { slot: 'agent-../x', v: V, t: 'webp' },
  { slot: '../settings.json', v: V, t: 'webp' },
  { slot: 'team', v: V, t: 'svg' },
  { slot: 'team', v: V, t: 'html' },
  { slot: 'team', v: V, t: 'image/webp' },
  { slot: 'team', v: V, t: 'json' },
  { slot: 'team', v: V },
  { slot: 'team', t: 'webp' },
  { v: V, t: 'webp' },
  { slot: ['team'], v: V, t: 'webp' },
  { slot: 'team', v: [V], t: 'webp' }
]

test('a bad version, slot or type is refused before the store is touched', async () => {
  for (const query of HOSTILE) {
    const { fetchArt, fake } = board()
    const response = await fetchArt(query)
    assert.equal(response.statusCode, 400, `${JSON.stringify(query)} was not refused`)
    assert.equal(storeCalls(fake), 0, `${JSON.stringify(query)} reached the store`)
  }
})

test('a bad request is a 400 even with no store connected', async () => {
  // The shape of a request is judged on its own; "no store" must not hide "you asked for a path".
  const handler = makeHandler({ store: null, env: { VIEW_KEY } })
  const response = await call(handler, { method: 'GET', headers: asTheBoard(), query: HOSTILE[0] })
  assert.equal(response.statusCode, 400)
})

test('with no store connected, a good request gets the sentence that says how to connect one', async () => {
  const handler = makeHandler({ store: null, env: { VIEW_KEY } })
  const response = await call(handler, { method: 'GET', headers: asTheBoard(), query: { slot: 'team', v: V, t: 'webp' } })
  assert.equal(response.statusCode, 503)
  assert.equal(response.body.error, NOT_CONNECTED)
})

/* ---------- the gate ---------- */

test('no view key is a 401, and the store is not touched', async () => {
  const { fetchArt, fake, store } = board()
  await store.putPicture('team', V, webp(), 'image/webp')
  const before = storeCalls(fake)
  const response = await fetchArt({ slot: 'team', v: V, t: 'webp' }, {})
  assert.equal(response.statusCode, 401)
  assert.equal(response.sent, null)
  assert.equal(storeCalls(fake), before)
})

test('showing a picture is a read: an edit key does not stand in its way', async () => {
  const { fetchArt, store } = board({ env: { ...STORE_ENV, EDIT_KEY: 'an-edit-key-for-changes-only' } })
  await store.putPicture('team', V, webp(), 'image/webp')
  const response = await fetchArt({ slot: 'team', v: V, t: 'webp' })
  assert.equal(response.statusCode, 200)
})

/* ---------- the rest of the contract ---------- */

test('a store that will not answer gives its sentence', async () => {
  const { fetchArt, fake } = board()
  fake.failNext.get = new BlobServiceNotAvailable()
  const response = await fetchArt({ slot: 'team', v: V, t: 'webp' })
  assert.equal(response.statusCode, 503)
  assert.match(response.body.error, /not answering/)
})

test('only GET is answered', async () => {
  const { handler } = board()
  const response = await call(handler, { method: 'POST', headers: asTheBoard(), query: { slot: 'team', v: V, t: 'webp' } })
  assert.equal(response.statusCode, 405)
  assert.equal(response.headers.Allow, 'GET')
})
