// GET /api/mailbox (plan 2026-10-12-mac-mailbox, task C4): the one question the owner's computer asks
// the board - "any orders for me?" - answered only to its own key, compared in constant time, never
// to the view key, a signed-in cookie or any browser, and kept by nobody.
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeHandler } from '../api/mailbox.js'
import { mailboxConfig, queueOrder } from '../api/_mailbox.js'
import { pictureStore, MAILBOX_QUEUE_PATH } from '../api/_picture-store.js'
import { fakeBlob } from './helpers/fake-blob.mjs'

// Made-up values, put together at runtime so nothing here looks like a real secret to a scanner.
const SECRET = ['test', 'only', 'mailbox', 'signing', 'value', '0123456789'].join('-')
const POLL_KEY = ['test', 'only', 'mailbox', 'poll', 'value', 'abcdefghij'].join('-')
const VIEW_KEY = 'vk_fakeViewKeyForTheMailboxEndpoint'
const ENV = {
  VIEW_KEY,
  GITHUB_OWNER: 'ExampleOwner',
  GITHUB_REPO: 'example-team',
  FIRE_MODE: 'mailbox',
  MAILBOX_SECRET: SECRET,
  MAILBOX_KEY: POLL_KEY,
  MAILBOX_POLL_SECONDS: '300',
  BLOB_STORE_ID: 'store_fake'
}
const NOW = new Date('2026-10-12T14:00:00.000Z')
const PAYLOAD = { source: 'agent-cockpit', action: 'task', title: 'Chase the invoice', instruction: 'File one card.' }

async function ask({ env = ENV, headers = { authorization: `Bearer ${POLL_KEY}` }, method = 'GET', fake = fakeBlob(), now = NOW } = {}) {
  const response = {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(key, value) { this.headers[key] = value },
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this }
  }
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('the mailbox called out') }
  try {
    await makeHandler({ env, loadSdk: async () => fake.sdk, now: () => now })({ method, headers, query: {} }, response)
  } finally {
    globalThis.fetch = realFetch
  }
  return { response, fake }
}
async function withOrders(count = 2, env = ENV) {
  const fake = fakeBlob()
  const store = pictureStore(env, async () => fake.sdk)
  for (let n = 0; n < count; n += 1) await queueOrder(store, mailboxConfig(env), { ...PAYLOAD, title: `Card ${n}` }, new Date(NOW.getTime() + n * 1000))
  fake.calls.get.length = 0
  fake.calls.put.length = 0
  return fake
}
const stored = (fake) => JSON.parse(fake.files.get(MAILBOX_QUEUE_PATH).bytes.toString('utf8')).orders
function assertNothingLeaks(response) {
  const text = JSON.stringify(response.body) + JSON.stringify(response.headers)
  assert.ok(!text.includes(SECRET), 'the signing secret reached the answer')
  assert.ok(!text.includes(POLL_KEY), 'the poll key reached the answer')
}

test('the right key gets the waiting orders - the stored envelopes, byte for byte - and the pace, from one fresh read and no write', async () => {
  const fake = await withOrders(2)
  const { response } = await ask({ fake, now: new Date(NOW.getTime() + 60_000) })
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['Cache-Control'], 'private, no-store')
  assert.deepEqual(Object.keys(response.body), ['v', 'pollSeconds', 'orders'])
  assert.equal(response.body.v, 1)
  assert.equal(response.body.pollSeconds, 300)
  assert.deepEqual(response.body.orders, stored(fake))
  assert.equal(fake.calls.get.length, 1)
  assert.equal(fake.calls.get[0].options.useCache, false)
  assert.equal(fake.calls.put.length, 0, 'a poll wrote to the store')
  assertNothingLeaks(response)
  // No queue yet: no orders, and still 200.
  const empty = await ask()
  assert.equal(empty.response.statusCode, 200)
  assert.deepEqual(empty.response.body.orders, [])
  // Expired orders are not served.
  const later = await ask({ fake, now: new Date(NOW.getTime() + 2 * 3600_000) })
  assert.deepEqual(later.response.body.orders, [])
})

test('no key, a wrong key, the view key, a cookie or another scheme: 401 with no detail, and the store is never asked', async () => {
  const cases = [
    {},
    { authorization: 'Bearer wrong-key-that-is-long-enough-to-look-real' },
    { authorization: `Bearer ${POLL_KEY}x` },
    { authorization: `Basic ${Buffer.from(`mac:${POLL_KEY}`).toString('base64')}` },
    { authorization: `bearer${POLL_KEY}` },
    { authorization: `Token ${POLL_KEY}` },
    { authorization: POLL_KEY },
    { authorization: `Bearer ${VIEW_KEY}` },
    { 'x-view-key': VIEW_KEY },
    { authorization: `Bearer ${SECRET}` },
    { cookie: 'cockpit_session=anything' }
  ]
  for (const headers of cases) {
    const fake = await withOrders(1)
    const { response } = await ask({ headers, fake })
    assert.equal(response.statusCode, 401, JSON.stringify(headers))
    assert.deepEqual(response.body, { error: 'Missing or wrong mailbox key.' })
    assert.equal(response.headers['Cache-Control'], 'private, no-store')
    assert.equal(fake.calls.get.length, 0, `${JSON.stringify(headers)}: the store was read before the key was checked`)
  }
})

test('a browser never reads the queue, even with the right key: anything that carries Sec-Fetch-Site or Origin is refused', async () => {
  for (const extra of [{ 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' }, { 'sec-fetch-site': 'cross-site' }, { origin: 'https://agent-cockpit.example' }]) {
    const fake = await withOrders(1)
    const { response } = await ask({ headers: { authorization: `Bearer ${POLL_KEY}`, ...extra }, fake })
    assert.equal(response.statusCode, 403, JSON.stringify(extra))
    assert.match(response.body.error, /only your computer/)
    assert.equal(fake.calls.get.length, 0)
  }
  // What Node's own fetch sends (Sec-Fetch-Mode, no Sec-Fetch-Site, no Origin) is the Mac, and is fine.
  const mac = await ask({ headers: { authorization: `Bearer ${POLL_KEY}`, 'sec-fetch-mode': 'cors', 'user-agent': 'node' } })
  assert.equal(mac.response.statusCode, 200)
})

test('not in mailbox mode, or not set up: 503, and nothing about the settings or their values', async () => {
  for (const env of [{ ...ENV, FIRE_MODE: undefined }, { ...ENV, FIRE_MODE: 'cloud' }, { ...ENV, MAILBOX_SECRET: undefined }, { ...ENV, MAILBOX_KEY: 'short' }, { ...ENV, BLOB_STORE_ID: undefined }]) {
    const { response, fake } = await ask({ env })
    assert.equal(response.statusCode, 503)
    assert.match(response.body.error, /The Mac mailbox is not switched on for this board/)
    assert.ok(!/MAILBOX_|FIRE_MODE|BLOB/.test(response.body.error), 'a setting was named to a stranger')
    assert.equal(fake.calls.get.length, 0)
    assertNothingLeaks(response)
  }
})

test('GET only: anything else is 405 with Allow: GET, before the key or the store', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
    const { response, fake } = await ask({ method })
    assert.equal(response.statusCode, 405, method)
    assert.equal(response.headers.Allow, 'GET')
    assert.equal(response.headers['Cache-Control'], 'private, no-store')
    assert.equal(fake.calls.get.length + fake.calls.put.length, 0)
  }
})

test('a store that will not answer is one plain sentence, never the SDK\'s words', async () => {
  const fake = await withOrders(1)
  fake.failNext.get = new fake.sdk.BlobServiceNotAvailable()
  const { response } = await ask({ fake })
  assert.equal(response.statusCode, 503)
  assert.match(response.body.error, /picture store is not answering/)
  assertNothingLeaks(response)
})
