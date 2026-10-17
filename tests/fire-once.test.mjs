// A voice order confirmed twice must start once. The page already sends one order per card (one send
// per card id, a lockout before a tap counts, 15 seconds before the same order can be proposed again).
// This is the board's side of it: /api/fire remembers a request id for ten minutes, so a double
// "yes", a tap plus a yes, or a client retry that reaches the board twice still fires one run, files
// one task card or queues one order for the Mac - and answers the second with the first's answer.

import test from 'node:test'
import assert from 'node:assert/strict'
import cloudHandler, { makeHandler } from '../api/fire.js'
import { MAILBOX_QUEUE_PATH } from '../api/_picture-store.js'
import { once } from '../api/_once.js'
import { fakeBlob } from './helpers/fake-blob.mjs'

const FIRE_KEY = ['fk', 'once', 'long', 'enough', 'passphrase', 'for', 'mailbox'].join('-')
const VIEW_KEY = 'vk_fakeViewKeyForTheOnceSuite'
const ROUTINE = (id) => `https://api.anthropic.com/v1/claude_code/routines/trig_${id}/fire`
const TOKEN = ['sk', 'ant', 'oat01', 'fakeOnceTokenThatStaysOnTheServer'].join('-')
const CLOUD = {
  GITHUB_OWNER: 'someone', GITHUB_REPO: 'my-agent-team', VIEW_KEY, FIRE_KEY,
  FIRE_TRIGGERS: JSON.stringify({ 'task-intake': { url: ROUTINE('01Task'), token: TOKEN }, 'monday-brief': { url: ROUTINE('01Monday'), token: TOKEN } })
}
const MAILBOX = {
  GITHUB_OWNER: 'someone', GITHUB_REPO: 'my-agent-team', VIEW_KEY, FIRE_KEY, FIRE_MODE: 'mailbox',
  MAILBOX_SECRET: ['test', 'only', 'once', 'signing', 'value', '0123456789'].join('-'),
  MAILBOX_KEY: ['test', 'only', 'once', 'poll', 'value', 'abcdefghij'].join('-'),
  MAILBOX_POLL_SECONDS: '300', BLOB_STORE_ID: 'store_fake'
}
const SETTING_NAMES = ['FIRE_MODE', 'MAILBOX_SECRET', 'MAILBOX_SECRET_ID', 'MAILBOX_KEY', 'MAILBOX_POLL_SECONDS', 'MAILBOX_RUNNER', 'BLOB_STORE_ID', 'FIRE_TRIGGERS']

let counter = 0
const freshId = () => `card-${process.pid}-${Date.now()}-${++counter}`

const answer = () => ({
  statusCode: null, body: null, headers: {},
  setHeader(key, value) { this.headers[key] = value },
  status(code) { this.statusCode = code; return this },
  json(payload) { this.body = payload; return this }
})

// A routine that answers after a short wait, so two requests can be in flight together.
function stubRoutines(t, { wait = 0, status = 200 } = {}) {
  const original = globalThis.fetch
  const runs = []
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url)
    if (target.startsWith('https://api.github.com')) {
      return target.includes('workflows/monday-brief.yml')
        ? new Response('name: Monday Brief\nowner: research\nsteps: [write-brief]\ntrigger:\n  schedule: "weekly mon 06:00"\n  fire: true\noutput: inbox/{date}/monday-brief.md\n', { status: 200 })
        : new Response('Not Found', { status: 404 })
    }
    runs.push(JSON.parse(options.body).text)
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait))
    return new Response('{}', { status })
  }
  t.after(() => { globalThis.fetch = original })
  return runs
}

async function send(handler, body, env, { key = FIRE_KEY } = {}) {
  const previous = { ...process.env }
  for (const name of SETTING_NAMES) delete process.env[name]
  Object.assign(process.env, env)
  const response = answer()
  try {
    await handler({ method: 'POST', headers: { 'x-view-key': VIEW_KEY, 'x-fire-key': key }, body }, response)
  } finally {
    process.env = previous
  }
  return response
}

const task = (requestId) => ({ action: 'task', title: 'Chase the invoice', ...(requestId === undefined ? {} : { requestId }) })

test('the same request id, sent twice, runs the routine once and answers the second with the first one\'s answer', async (t) => {
  const runs = stubRoutines(t)
  const id = freshId()
  const first = await send(cloudHandler, task(id), CLOUD)
  const second = await send(cloudHandler, task(id), CLOUD)
  assert.equal(first.statusCode, 200)
  assert.equal(runs.length, 1, 'the task card was filed twice')
  assert.equal(second.statusCode, 200)
  assert.deepEqual(second.body, { ...first.body, duplicate: true })
  assert.equal(first.body.duplicate, undefined)
})

test('two requests with the same id in flight together still fire once', async (t) => {
  const runs = stubRoutines(t, { wait: 40 })
  const id = freshId()
  const [one, two] = await Promise.all([send(cloudHandler, task(id), CLOUD), send(cloudHandler, task(id), CLOUD)])
  assert.equal(runs.length, 1, 'a double yes at the same moment fired twice')
  assert.deepEqual([one.statusCode, two.statusCode], [200, 200])
  assert.equal([one.body.duplicate, two.body.duplicate].filter(Boolean).length, 1)
})

test('a run is remembered the same way, and different ids, or no id, are never merged', async (t) => {
  const runs = stubRoutines(t)
  const id = freshId()
  await send(cloudHandler, { workflow: 'monday-brief', action: 'run', requestId: id }, CLOUD)
  await send(cloudHandler, { workflow: 'monday-brief', action: 'run', requestId: id }, CLOUD)
  assert.equal(runs.length, 1)
  await send(cloudHandler, { workflow: 'monday-brief', action: 'run', requestId: freshId() }, CLOUD)
  assert.equal(runs.length, 2, 'a different card was swallowed')
  // The board's own buttons send no id: unchanged, every click is its own request.
  await send(cloudHandler, { workflow: 'monday-brief', action: 'run' }, CLOUD)
  await send(cloudHandler, { workflow: 'monday-brief', action: 'run' }, CLOUD)
  assert.equal(runs.length, 4)
})

test('a request that did not go through is not remembered: the retry fires', async (t) => {
  const id = freshId()
  // The fire key was wrong the first time (the page then asks for it), so nothing was sent.
  const runs = stubRoutines(t)
  const wrong = await send(cloudHandler, task(id), CLOUD, { key: 'not-the-key' })
  assert.equal(wrong.statusCode, 401)
  const retry = await send(cloudHandler, task(id), CLOUD)
  assert.equal(retry.statusCode, 200)
  assert.equal(runs.length, 1)
  assert.equal(retry.body.duplicate, undefined)
  // The routine refused the first time: the same card may be tried again.
  const failId = freshId()
  stubRoutines(t, { status: 500 })
  const failed = await send(cloudHandler, task(failId), CLOUD)
  assert.equal(failed.statusCode, 502)
  const again = stubRoutines(t)
  const worked = await send(cloudHandler, task(failId), CLOUD)
  assert.equal(worked.statusCode, 200)
  assert.equal(again.length, 1)
})

test('a request id that is not a plain short id is refused before anything is sent', async (t) => {
  const runs = stubRoutines(t)
  for (const bad of ['', 'x', 'a'.repeat(65), 'has space in it', '../../etc', { id: 1 }, 12345678, null]) {
    const response = await send(cloudHandler, task(bad), CLOUD)
    assert.equal(response.statusCode, 400, `${JSON.stringify(bad)} was accepted`)
    assert.match(response.body.error, /requestId/)
  }
  assert.equal(runs.length, 0)
})

test('in mailbox mode the same id queues one order for the Mac, and the repeats carry the first order id', async (t) => {
  stubRoutines(t)
  const fake = fakeBlob()
  const handler = makeHandler({ loadSdk: async () => fake.sdk })
  const id = freshId()
  const first = await send(handler, task(id), MAILBOX)
  const second = await send(handler, task(id), MAILBOX)
  const [third] = await Promise.all([send(handler, task(id), MAILBOX)])
  const queue = () => JSON.parse(fake.files.get(MAILBOX_QUEUE_PATH).bytes.toString('utf8'))
  assert.equal(first.statusCode, 200, JSON.stringify(first.body))
  assert.equal(queue().orders.length, 1, 'the Mac was sent two orders for one card')
  assert.equal(queue().count, 1, 'the day\'s allowance was used twice for one card')
  assert.equal(second.body.orderId, first.body.orderId)
  assert.equal(third.body.orderId, first.body.orderId)
  await send(handler, task(freshId()), MAILBOX)
  assert.equal(queue().orders.length, 2)
})

test('the same id with a different order is a conflict: 409, and nothing runs', async (t) => {
  const runs = stubRoutines(t)
  const id = freshId()
  const first = await send(cloudHandler, task(id), CLOUD)
  assert.equal(first.statusCode, 200)
  const other = await send(cloudHandler, { action: 'task', title: 'Something else entirely', requestId: id }, CLOUD)
  assert.equal(other.statusCode, 409)
  assert.match(other.body.error, /conflict/i)
  assert.equal(runs.length, 1)
  // The same order with its keys in another order is still the same order.
  const same = await send(cloudHandler, { requestId: id, title: 'Chase the invoice', action: 'task' }, CLOUD)
  assert.equal(same.statusCode, 200)
  assert.equal(same.body.duplicate, true)
  // In flight together, too.
  const slow = stubRoutines(t, { wait: 40 })
  const id2 = freshId()
  const [one, two] = await Promise.all([
    send(cloudHandler, task(id2), CLOUD),
    send(cloudHandler, { action: 'task', title: 'Different', requestId: id2 }, CLOUD)
  ])
  assert.deepEqual([one.statusCode, two.statusCode].sort(), [200, 409])
  assert.equal(slow.length, 1)
})

// The memory itself, with a clock the test holds.
const quick = () => ({ statusCode: null, body: null, setHeader() {}, status(c) { this.statusCode = c; return this }, json(b) { this.body = b; return this } })
const ok = async (response) => { response.status(200).json({ ok: true }) }

test('an answer is remembered for ten minutes and then forgotten', async () => {
  let clock = 1_000_000
  const id = freshId()
  let ran = 0
  const go = async () => { const r = quick(); await once(id, 'f1', r, async (x) => { ran += 1; await ok(x) }, () => clock); return r }
  await go()
  clock += 9 * 60_000
  assert.equal((await go()).body.duplicate, true)
  assert.equal(ran, 1)
  clock += 2 * 60_000
  assert.equal((await go()).body.duplicate, undefined, 'an id older than ten minutes was still remembered')
  assert.equal(ran, 2)
})

test('past 200 remembered ids the oldest is forgotten first', async () => {
  const clock = 5_000_000
  const base = freshId()
  let ran = 0
  const run = async (x) => { ran += 1; await ok(x) }
  for (let n = 0; n < 201; n += 1) await once(`${base}-${n}`, 'f', quick(), run, () => clock + n)
  assert.equal(ran, 201)
  await once(`${base}-200`, 'f', quick(), run, () => clock + 300)
  assert.equal(ran, 201, 'the newest id was forgotten')
  await once(`${base}-0`, 'f', quick(), run, () => clock + 301)
  assert.equal(ran, 202, 'the oldest id was kept past 200')
})
