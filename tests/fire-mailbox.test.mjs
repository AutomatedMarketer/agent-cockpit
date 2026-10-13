// /api/fire in mailbox mode (plan 2026-10-12-mac-mailbox, task C3): every gate and every check the
// cloud path has, and then the order goes into the board's own queue for the Mac instead of to the
// routines API. No request ever goes to api.anthropic.com, FIRE_TRIGGERS is not needed, and a fire
// key under 24 characters reads as not configured (a placeholder like FILL-ME-IN is no longer
// harmless once FIRE_TRIGGERS is not needed).
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeHandler, taskDispatchPayload, dispatchPayload, armDispatchPayload, moveDispatchPayload, approveDispatchPayload, creationDispatchPayload } from '../api/fire.js'
import { mailboxConfig, verifyOrder } from '../api/_mailbox.js'
import { MAILBOX_QUEUE_PATH, NOT_CONNECTED } from '../api/_picture-store.js'
import { fakeBlob } from './helpers/fake-blob.mjs'
import { HIDDEN_KINDS } from './helpers/hidden-text.mjs'

// Made-up values, put together at runtime so nothing here looks like a real secret to a scanner.
const FIRE_KEY = ['fk', 'mailbox', 'long', 'enough', 'passphrase'].join('-')
const VIEW_KEY = 'vk_fakeViewKeyForTheMailboxSuite'
const GITHUB_TOKEN = 'ghp_thisMustNeverLeaveTheServerEither'
const SECRET = ['test', 'only', 'mailbox', 'signing', 'value', '0123456789'].join('-')
const POLL_KEY = ['test', 'only', 'mailbox', 'poll', 'value', 'abcdefghij'].join('-')
const ENV = {
  GITHUB_OWNER: 'ExampleOwner',
  GITHUB_REPO: 'example-team',
  GITHUB_TOKEN,
  VIEW_KEY,
  FIRE_KEY,
  FIRE_MODE: 'mailbox',
  MAILBOX_SECRET: SECRET,
  MAILBOX_KEY: POLL_KEY,
  MAILBOX_POLL_SECONDS: '300',
  BLOB_STORE_ID: 'store_fake'
}
const MAILBOX_NAMES = ['FIRE_MODE', 'MAILBOX_SECRET', 'MAILBOX_SECRET_ID', 'MAILBOX_KEY', 'MAILBOX_POLL_SECONDS', 'MAILBOX_RUNNER', 'BLOB_STORE_ID', 'BLOB_READ_WRITE_TOKEN', 'FIRE_TRIGGERS', 'PUBLIC_FIRE', 'PUBLIC_DASHBOARD', 'EDIT_KEY']

const FILES = {
  'workflows/morning-intel.yml': 'name: Morning intel\nowner: research\nsteps: [scan]\ntrigger:\n  schedule: "daily 06:00"\n  fire: true\noutput: inbox/{date}/morning-intel.md\n',
  'workflows/no-fire.yml': 'name: No Fire\nowner: research\nsteps: [scan]\ntrigger:\n  schedule: "daily 06:00"\noutput: inbox/{date}/no-fire.md\n',
  '.claude/agents/research.md': '---\nname: research\ndescription: Finds things out.\nmodel: sonnet\n---\n\nYou are the research agent.\n',
  'tasks/2026-08-18-call-supplier.md': '---\nstatus: todo\nfor: research\n---\n\n# Call the supplier\n'
}

async function fire(body, { env = {}, unset = [], headers = {}, fake = fakeBlob() } = {}) {
  const calls = { anthropic: [], github: [], other: [] }
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.startsWith('https://api.github.com')) {
      calls.github.push(target)
      const match = /\/contents\/(.+?)\?ref=/.exec(target)
      const file = match ? FILES[decodeURI(match[1])] : undefined
      return file === undefined ? new Response('Not Found', { status: 404 }) : new Response(file, { status: 200 })
    }
    if (target.includes('anthropic.com')) calls.anthropic.push(target)
    else calls.other.push(target)
    return new Response('{}', { status: 200 })
  }
  const previous = { ...process.env }
  for (const name of MAILBOX_NAMES) delete process.env[name]
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
    const handler = makeHandler({ loadSdk: async () => fake.sdk })
    await handler({ method: 'POST', headers: { 'x-view-key': VIEW_KEY, 'x-fire-key': FIRE_KEY, ...headers }, body }, response)
  } finally {
    globalThis.fetch = original
    process.env = previous
  }
  return { response, calls, fake }
}

const queued = (fake) => {
  const file = fake.files.get(MAILBOX_QUEUE_PATH)
  return file ? JSON.parse(file.bytes.toString('utf8')).orders : []
}
const config = () => mailboxConfig({ ...ENV })
const orderIn = (fake, n = 0) => {
  const settings = config()
  const checked = verifyOrder(queued(fake)[n], { keys: { k1: settings.secret }, repo: settings.repo, runner: settings.runner, now: Date.now() })
  assert.equal(checked.verdict, 'ok', 'the queued order does not pass the Mac\'s checks')
  return checked.order
}
function assertNothingLeaks(response) {
  const text = JSON.stringify(response.body) + JSON.stringify(response.headers)
  for (const value of [SECRET, POLL_KEY, FIRE_KEY, VIEW_KEY, GITHUB_TOKEN, '"sig"', '"kid"']) {
    assert.ok(!text.includes(value), `${value.slice(0, 12)}... reached the answer`)
  }
}
const mac = (response, echo) => {
  assert.equal(response.statusCode, 200, JSON.stringify(response.body))
  const { orderId, expiresAt, pollSeconds, ...rest } = response.body
  assert.match(orderId, /^[0-9a-f]{32}$/)
  // The pace, so the page and the voice can say when to expect it.
  assert.equal(pollSeconds, 300)
  assert.ok(Date.parse(expiresAt) > Date.now())
  assert.deepEqual(rest, { ok: true, accepted: true, via: 'mac', ...echo })
  assertNothingLeaks(response)
}

/* ---------- every action, into the queue ---------- */

test('in mailbox mode a task goes into the queue, signed, with the very payload the cloud routine gets - and nothing goes to api.anthropic.com', async () => {
  const { response, calls, fake } = await fire({ action: 'task', title: '  Chase the invoice  ', details: 'By Friday', for: 'research', model: 'haiku' })
  mac(response, { title: 'Chase the invoice' })
  assert.equal(calls.anthropic.length, 0)
  assert.equal(calls.other.length, 0)
  assert.equal(calls.github.length, 1, 'the named agent was not checked against the repo')
  const order = orderIn(fake)
  assert.equal(order.id, response.body.orderId)
  assert.equal(order.expiresAt, response.body.expiresAt)
  assert.deepEqual(order.payload, taskDispatchPayload({ title: 'Chase the invoice', details: 'By Friday', for: 'research', model: 'haiku' }))
  assert.equal(order.repo, 'ExampleOwner/example-team')
  assert.equal(order.runner, 'mac-mini')
})

test('every other action goes into the queue too, after the same repo checks, with the cloud payload and its own echo', async () => {
  const cases = [
    [{ action: 'skill', title: 'Summarise a call' }, { title: 'Summarise a call' }, creationDispatchPayload('skill', { title: 'Summarise a call' })],
    [{ action: 'agent', title: 'A bookkeeper', details: 'Receipts' }, { title: 'A bookkeeper' }, creationDispatchPayload('agent', { title: 'A bookkeeper', details: 'Receipts' })],
    [{ action: 'move', task: '2026-08-18-call-supplier', status: 'done' }, { task: '2026-08-18-call-supplier', status: 'done' }, moveDispatchPayload({ task: '2026-08-18-call-supplier', status: 'done' })],
    [{ action: 'arm', workflow: 'task-sweep' }, { workflow: 'task-sweep', action: 'arm' }, armDispatchPayload('task-sweep')],
    [{ action: 'approve', task: 'Weekly brief' }, { task: 'Weekly brief' }, approveDispatchPayload('Weekly brief')],
    [{ action: 'run', workflow: 'morning-intel' }, { workflow: 'morning-intel', action: 'run' }, dispatchPayload('morning-intel', 'run')],
    [{ action: 'pause', workflow: 'morning-intel' }, { workflow: 'morning-intel', action: 'pause' }, dispatchPayload('morning-intel', 'pause')]
  ]
  for (const [body, echo, payload] of cases) {
    const { response, calls, fake } = await fire(body)
    mac(response, echo)
    assert.equal(calls.anthropic.length, 0, body.action)
    assert.deepEqual(orderIn(fake).payload, payload, body.action)
  }
})

test('FIRE_TRIGGERS is not needed in mailbox mode, and is never used if it is there', async () => {
  const triggers = JSON.stringify({ 'task-intake': { url: 'https://api.anthropic.com/v1/claude_code/routines/trig_01X/fire', token: 'sk-ant-oat01-fakeTokenForTheMailboxSuite' } })
  for (const env of [{}, { FIRE_TRIGGERS: triggers }]) {
    const { response, calls } = await fire({ action: 'task', title: 'Chase the invoice' }, { env })
    assert.equal(response.statusCode, 200)
    assert.equal(response.body.via, 'mac')
    assert.equal(calls.anthropic.length, 0)
  }
})

/* ---------- the same refusals as the cloud ---------- */

test('mailbox mode refuses exactly what the cloud refuses, and queues nothing when it does', async () => {
  const cases = [
    [{ action: 'task', title: 'ab' }, 400, /title must be 3 to 200/],
    [{ action: 'task', title: HIDDEN_KINDS[0][1] }, 400, /cannot be seen/],
    [{ action: 'task', title: 'Chase it', for: 'nobody-here' }, 400, /must name an agent that exists/],
    [{ action: 'move', task: '2026-01-01-not-there', status: 'done' }, 400, /not in the team repo/],
    [{ action: 'move', task: '../x', status: 'done' }, 400, /filename slug/],
    [{ action: 'approve', task: 'Weekly\nbrief' }, 400, /control characters/],
    [{ action: 'arm', workflow: 'Not A Slug' }, 400, /kebab-case/],
    [{ action: 'run', workflow: 'no-fire' }, 403, /trigger\.fire: true/],
    [{ action: 'run', workflow: 'ghost' }, 404, /not a workflow in the team repo/],
    [{ action: 'pause', workflow: '../etc' }, 400, /kebab-case/],
    [{ action: 'delete' }, 400, /action must be/]
  ]
  for (const [body, status, why] of cases) {
    const { response, calls, fake } = await fire(body)
    assert.equal(response.statusCode, status, JSON.stringify(body))
    assert.match(response.body.error, why, JSON.stringify(body))
    assert.equal(fake.calls.put.length, 0, `${JSON.stringify(body)} was queued`)
    assert.equal(calls.anthropic.length, 0)
  }
})

test('the gates come first: a wrong fire key, or another site, queues nothing and reads nothing', async () => {
  const wrong = await fire({ action: 'task', title: 'Chase the invoice' }, { headers: { 'x-fire-key': 'wrong' } })
  assert.equal(wrong.response.statusCode, 401)
  assert.equal(wrong.response.body.needs, 'fire-key')
  const crossSite = await fire({ action: 'task', title: 'Chase the invoice' }, { headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(crossSite.response.statusCode, 403)
  const noView = await fire({ action: 'task', title: 'Chase the invoice' }, { headers: { 'x-view-key': 'nope' } })
  assert.equal(noView.response.statusCode, 401)
  for (const { fake, calls } of [wrong, crossSite, noView]) {
    assert.equal(fake.calls.put.length + fake.calls.get.length, 0, 'the store was touched before the gates passed')
    assert.equal(calls.github.length, 0)
  }
})

/* ---------- what is not configured, said plainly ---------- */

test('in mailbox mode a fire key under 24 characters is not configured - the placeholder FILL-ME-IN above all', async () => {
  // A short key that is no placeholder holds the length rule to account; spaces round a key are not part of it.
  for (const short of ['FILL-ME-IN', 'x'.repeat(23), 'abcdefghij', `abcdefghij${' '.repeat(14)}`, ' '.repeat(24)]) {
    const { response, fake } = await fire({ action: 'task', title: 'Chase the invoice' }, { env: { FIRE_KEY: short }, headers: { 'x-fire-key': short } })
    assert.equal(response.statusCode, 503, short)
    assert.match(response.body.error, /FIRE_KEY must be 24 characters or more/)
    assert.ok(!response.body.error.includes(short), 'the key was echoed')
    assert.equal(fake.calls.put.length, 0)
  }
  // Long, and still a placeholder: the same rule MAILBOX_SECRET and MAILBOX_KEY are held to.
  // A long key of a handful of different characters is a filler, not a passphrase.
  for (const placeholder of ['FILL-ME-IN-FILL-ME-IN-FILL-ME-IN', 'your-long-passphrase-goes-here', 'replace-me-with-a-long-passphrase', 'an-example-fire-key-of-some-length',
    'FILL-IN-FILL-IN-FILL-IN-FILL-IN', 'insert-key-here-insert-key', 'REPLACE_THIS_WITH_A_KEY_123', 'changeit-changeit-changeit-1',
    'TODO-TODO-TODO-TODO-TODO-TODO', 'set-me-set-me-set-me-set-me', '*'.repeat(24), 'y'.repeat(24),
    // A placeholder word among plenty of different characters: the word alone has to catch it.
    'fill-in-abcdefghijklmnopqrstuvwxyz']) {
    const { response, fake } = await fire({ action: 'task', title: 'Chase the invoice' }, { env: { FIRE_KEY: placeholder }, headers: { 'x-fire-key': placeholder } })
    assert.equal(response.statusCode, 503, placeholder)
    assert.match(response.body.error, /FIRE_KEY must be 24 characters or more, and not a placeholder/)
    assert.ok(!response.body.error.includes(placeholder), 'the key was echoed')
    assert.equal(fake.calls.put.length, 0)
  }
  const exactly = 'k7Qm2xLp9vRt4wNs8bYc3hJd'
  assert.equal(exactly.length, 24)
  const ok = await fire({ action: 'task', title: 'Chase the invoice' }, { env: { FIRE_KEY: exactly }, headers: { 'x-fire-key': exactly } })
  assert.equal(ok.response.statusCode, 200)
  // PUBLIC_FIRE waives the fire key, as in the cloud: then no key, short or long, is needed.
  const open = await fire({ action: 'task', title: 'Chase the invoice' }, { env: { FIRE_KEY: 'FILL-ME-IN', PUBLIC_FIRE: 'true' }, headers: { 'x-fire-key': '', 'sec-fetch-site': 'same-origin' } })
  assert.equal(open.response.statusCode, 200)
})

test('a mailbox that is not set up, a FIRE_MODE that is neither, or no picture store: a plain 503 and nothing queued', async () => {
  const cases = [
    [{ unset: ['MAILBOX_SECRET'] }, /MAILBOX_SECRET/],
    [{ env: { MAILBOX_KEY: SECRET } }, /MAILBOX_KEY/],
    [{ env: { FIRE_MODE: 'mac' } }, /FIRE_MODE must be cloud or mailbox/],
    [{ unset: ['BLOB_STORE_ID'] }, new RegExp(NOT_CONNECTED.slice(0, 30))]
  ]
  for (const [options, why] of cases) {
    const { response, fake, calls } = await fire({ action: 'task', title: 'Chase the invoice' }, options)
    assert.equal(response.statusCode, 503, JSON.stringify(options))
    assert.match(response.body.error, why)
    assert.equal(fake.calls.put.length, 0)
    assert.equal(calls.anthropic.length, 0)
    assertNothingLeaks(response)
  }
})

test('the ninth order of a day is refused with the queue\'s own sentence', async () => {
  const fake = fakeBlob()
  for (let n = 0; n < 8; n += 1) {
    const { response } = await fire({ action: 'task', title: `Card number ${n}` }, { fake })
    assert.equal(response.statusCode, 200)
  }
  const { response } = await fire({ action: 'task', title: 'One too many' }, { fake })
  assert.equal(response.statusCode, 429)
  assert.match(response.body.error, /all 8 orders it allows today/)
  assert.equal(queued(fake).length, 8)
})

test('the cloud is unchanged: FIRE_MODE unset still needs FIRE_TRIGGERS, and a short fire key still works there', async () => {
  const { response, fake } = await fire({ action: 'task', title: 'Chase the invoice' }, { unset: ['FIRE_MODE'], env: { FIRE_KEY: 'short-cloud-key' }, headers: { 'x-fire-key': 'short-cloud-key' } })
  assert.equal(response.statusCode, 503)
  assert.match(response.body.error, /FIRE_TRIGGERS/)
  assert.equal(fake.calls.put.length + fake.calls.get.length, 0)
})
