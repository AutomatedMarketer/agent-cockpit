// /api/fire and the worker (T14): a run order may say "codex", and the board sends that only when the
// computer's own status file says the job is Codex's and Codex is ready. Every other order is the
// bytes it always was. The cases come from tests/fixtures/mailbox-parity.json (payload.worker).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { makeHandler, dispatchPayload } from '../api/fire.js'
import { mailboxConfig, verifyOrder } from '../api/_mailbox.js'
import { MAILBOX_QUEUE_PATH } from '../api/_picture-store.js'
import { fakeBlob } from './helpers/fake-blob.mjs'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/mailbox-parity.json', import.meta.url), 'utf8'))
const FIRE_KEY = ['fk', 'worker', 'long', 'enough', 'passphrase'].join('-')
const VIEW_KEY = 'vk_fakeViewKeyForTheWorkerSuite'
const SECRET = ['test', 'only', 'worker', 'signing', 'value', '0123456789'].join('-')
const POLL_KEY = ['test', 'only', 'worker', 'poll', 'value', 'abcdefghij'].join('-')
const ENV = {
  GITHUB_OWNER: 'ExampleOwner', GITHUB_REPO: 'example-team', VIEW_KEY, FIRE_KEY, FIRE_MODE: 'mailbox',
  MAILBOX_SECRET: SECRET, MAILBOX_KEY: POLL_KEY, MAILBOX_POLL_SECONDS: '300', BLOB_STORE_ID: 'store_fake'
}
const NAMES = ['FIRE_MODE', 'MAILBOX_SECRET', 'MAILBOX_SECRET_ID', 'MAILBOX_KEY', 'MAILBOX_POLL_SECONDS', 'MAILBOX_RUNNER', 'BLOB_STORE_ID', 'BLOB_READ_WRITE_TOKEN', 'FIRE_TRIGGERS', 'PUBLIC_FIRE', 'PUBLIC_DASHBOARD', 'EDIT_KEY', 'GITHUB_TOKEN', 'REPO_FOLDER', 'REPO_SOURCE']
const STATUS_PATH = `${fixture.status.folder}/mac-mini.json`
const workflowYml = (name) => `name: ${name}\nowner: research\nsteps: [scan]\ntrigger:\n  schedule: "daily 06:00"\n  fire: true\noutput: inbox/{date}/x.md\n`
const WORKFLOWS = { 'workflows/task-sweep.yml': workflowYml('Task sweep'), 'workflows/morning-intel.yml': workflowYml('Morning intel') }

// A status file the way the runner writes it, taken a minute ago.
const statusFile = (allows, extra = {}) => JSON.stringify({
  schema: fixture.status.schema,
  takenAt: new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, 'Z'),
  computer: 'Mac Mini',
  runner: 'mac-mini',
  allows: { actions: ['task', 'run'], jobs: ['morning-intel', 'task-sweep'], ...allows },
  orders: [],
  ...extra
})
const READY = statusFile({ workers: ['claude', 'codex'], codexJobs: ['task-sweep'] })

async function fire(body, { env = {}, unset = [], status = READY, fake = fakeBlob() } = {}) {
  const github = []
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (!target.startsWith('https://api.github.com')) return new Response('{}', { status: 200 })
    github.push(decodeURI(target))
    const match = /\/contents\/(.+?)\?ref=/.exec(target)
    const path = match ? decodeURI(match[1]) : ''
    const file = path === STATUS_PATH ? status : WORKFLOWS[path]
    return file === undefined || file === null ? new Response('Not Found', { status: 404 }) : new Response(file, { status: 200 })
  }
  const previous = { ...process.env }
  for (const name of NAMES) delete process.env[name]
  Object.assign(process.env, ENV, env)
  for (const name of unset) delete process.env[name]
  const response = {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(key, value) { this.headers[key] = value },
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this }
  }
  try {
    await makeHandler({ loadSdk: async () => fake.sdk })({ method: 'POST', headers: { 'x-view-key': VIEW_KEY, 'x-fire-key': FIRE_KEY }, body }, response)
  } finally {
    globalThis.fetch = original
    process.env = previous
  }
  return { response, github, fake, statusReads: github.filter((url) => url.includes(STATUS_PATH)).length }
}
const queued = (fake) => {
  const file = fake.files.get(MAILBOX_QUEUE_PATH)
  return file ? JSON.parse(file.bytes.toString('utf8')).orders : []
}
const orderIn = (fake) => {
  const settings = mailboxConfig({ ...ENV })
  const checked = verifyOrder(queued(fake)[0], { keys: { k1: settings.secret }, repo: settings.repo, runner: settings.runner, now: Date.now() })
  assert.equal(checked.verdict, 'ok')
  return checked.order
}

test('a Codex job with Codex ready is queued with worker "codex", and the payload is the fixture\'s shape', async () => {
  const { response, fake } = await fire({ action: 'run', workflow: 'task-sweep', worker: 'codex' })
  assert.equal(response.statusCode, 200, JSON.stringify(response.body))
  const { ok, via, workflow, action, worker } = response.body
  assert.deepEqual({ ok, via, workflow, action, worker }, { ok: true, via: 'mac', workflow: 'task-sweep', action: 'run', worker: 'codex' })
  const order = orderIn(fake)
  assert.deepEqual(order.payload, { source: 'agent-cockpit', action: 'run', workflow: 'task-sweep', worker: 'codex' })
  const sample = fixture.payload.worker.cases.find((one) => one.name === 'run, codex').payload
  assert.deepEqual(Object.keys(order.payload).filter((key) => key !== 'source'), Object.keys(sample))
  assert.deepEqual(order.payload, dispatchPayload('task-sweep', 'run', 'codex'))
})

test('an order for Claude is the bytes it always was: no worker key, no read of the status file', async () => {
  const bare = await fire({ action: 'run', workflow: 'morning-intel' })
  const claude = await fire({ action: 'run', workflow: 'morning-intel', worker: 'claude' })
  for (const one of [bare, claude]) {
    assert.equal(one.response.statusCode, 200)
    assert.equal(one.statusReads, 0, 'the status file was read for an order that needs no worker')
    assert.equal(one.github.length, 1)
    assert.equal(Object.hasOwn(orderIn(one.fake).payload, 'worker'), false)
    assert.equal(Object.hasOwn(one.response.body, 'worker'), false)
  }
  assert.deepEqual(orderIn(bare.fake).payload, orderIn(claude.fake).payload)
  assert.deepEqual(dispatchPayload('morning-intel', 'run'), { source: 'agent-cockpit', action: 'run', workflow: 'morning-intel' })
  assert.deepEqual(dispatchPayload('morning-intel', 'run', 'claude'), { source: 'agent-cockpit', action: 'run', workflow: 'morning-intel' })
})

test('every fixture case with a worker gets the contract\'s verdict from the board', async () => {
  for (const { name, payload, verdict } of fixture.payload.worker.cases) {
    const { source, ...body } = payload
    const { response, fake } = await fire(body)
    if (verdict === 'ok') {
      assert.equal(response.statusCode, 200, `${name}: ${JSON.stringify(response.body)}`)
      assert.equal(queued(fake).length, 1, name)
    } else {
      assert.equal(response.statusCode, 400, name)
      assert.match(response.body.error, /worker/i, name)
      assert.equal(fake.calls.put.length, 0, `${name}: queued`)
    }
  }
})

test('a Codex order is refused, in plain words and unqueued, when the computer does not say yes', async () => {
  const body = { action: 'run', workflow: 'task-sweep', worker: 'codex' }
  const cases = [
    ['no status file', { status: null }, 409, /has not (said|reported)/],
    ['a status file from before Codex', { status: statusFile({}) }, 409, /not set to Codex/],
    ['the job is Claude\'s', { status: statusFile({ workers: ['claude', 'codex'], codexJobs: ['morning-intel'] }) }, 409, /not set to Codex/],
    ['Codex is not ready', { status: statusFile({ workers: ['claude'], codexJobs: ['task-sweep'] }) }, 409, /Codex is not ready/],
    ['no worker is ready', { status: statusFile({ workers: [], codexJobs: ['task-sweep'] }) }, 409, /Codex is not ready/],
    ['a malformed worker list', { status: statusFile({ workers: ['codex', 'codex'], codexJobs: ['task-sweep'] }) }, 409, /not set to Codex/],
    ['a file that is not JSON', { status: '{not json' }, 409, /has not (said|reported)/]
  ]
  for (const [why, options, status, words] of cases) {
    const { response, fake } = await fire(body, options)
    assert.equal(response.statusCode, status, why)
    assert.match(response.body.error, words, why)
    assert.equal(fake.calls.put.length, 0, `${why}: queued`)
    assert.ok(!/<|>|claude\.ai/.test(response.body.error), why)
  }
})

test('Codex needs the Mac mailbox: on a cloud board a Codex order is refused before anything is read or fired', async () => {
  const triggers = JSON.stringify({ 'task-sweep': { url: 'https://api.anthropic.com/v1/claude_code/routines/trig_1/fire', token: 'sk-ant-oat01-fakeTokenForTheWorkerSuite' } })
  const { response, github, fake } = await fire({ action: 'run', workflow: 'task-sweep', worker: 'codex' }, { unset: ['FIRE_MODE'], env: { FIRE_TRIGGERS: triggers } })
  assert.equal(response.statusCode, 400)
  assert.match(response.body.error, /mailbox/i)
  assert.equal(github.length, 0)
  assert.equal(fake.calls.put.length, 0)
})

test('the same request id twice queues once; the same id with another worker is not the same order', async () => {
  const fake = fakeBlob()
  const first = await fire({ requestId: 'req-worker-0001', action: 'run', workflow: 'task-sweep', worker: 'codex' }, { fake })
  const second = await fire({ requestId: 'req-worker-0001', action: 'run', workflow: 'task-sweep', worker: 'codex' }, { fake })
  assert.equal(first.response.statusCode, 200)
  assert.equal(second.response.statusCode, 200)
  assert.equal(queued(fake).length, 1)
  const other = await fire({ requestId: 'req-worker-0001', action: 'run', workflow: 'task-sweep' }, { fake })
  assert.notEqual(other.response.statusCode, 200, 'the same id with a different order was answered as the first')
})
