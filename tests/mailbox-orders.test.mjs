// Orders by voice in mailbox mode (plan 2026-10-12-mac-mailbox, task C5): on when the Mac mailbox is
// set up and the fire key is long enough, and the jobs offered are the ones the Mac's own status file
// says it will run - never more than 40, sorted. Before the Mac has pushed a status file, task cards
// are on and no job is offered: the board cannot know which jobs the Mac allows.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ordersConfig, ordersView, readMacStatus, MAX_ORDER_JOBS } from '../api/_orders.js'
import { MAILBOX_ORDERS_OFF, ORDERS_OFF } from '../api/_voice.js'
import { shapeMailbox, MAILBOX_FOLDER } from '../api/state.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/mailbox-parity.json', import.meta.url), 'utf8'))
// Made-up values, put together at runtime so nothing here looks like a real secret to a scanner.
const ENV = {
  FIRE_MODE: 'mailbox',
  FIRE_KEY: ['fk', 'mailbox', 'long', 'enough', 'passphrase'].join('-'),
  MAILBOX_SECRET: ['test', 'only', 'mailbox', 'signing', 'value', '0123456789'].join('-'),
  MAILBOX_KEY: ['test', 'only', 'mailbox', 'poll', 'value', 'abcdefghij'].join('-'),
  GITHUB_OWNER: 'ExampleOwner',
  GITHUB_REPO: 'example-team',
  GITHUB_TOKEN: 'ghp_fakeTokenForTheMailboxOrdersSuite',
  BLOB_STORE_ID: 'store_fake'
}
const SAMPLE = fixture.status.sample
const mac = (allows) => ({ computer: 'Mac Mini', runner: 'mac-mini', takenAt: SAMPLE.takenAt, allows, orders: [], hidden: 0 })

test('mailbox mode, set up, before the Mac has reported: task cards on, no job, sent via the Mac', () => {
  const config = ordersConfig(ENV, null)
  assert.equal(config.on, true)
  assert.equal(config.tasks, true)
  assert.deepEqual(config.jobs, [])
  assert.equal(config.via, 'mac')
  assert.equal(config.key, 'fire-key')
  assert.deepEqual(ordersView(config), { on: true, tasks: true, jobs: [], key: 'fire-key', spokenYes: true, jev: false, via: 'mac' })
})

test('the jobs offered are the ones the Mac\'s status says it runs - sorted, at most 40 - and only when it takes runs at all', () => {
  const both = ordersConfig(ENV, mac({ actions: ['task', 'run'], jobs: ['task-sweep', 'morning-intel'] }))
  assert.equal(both.tasks, true)
  assert.deepEqual(both.jobs, ['morning-intel', 'task-sweep'])
  const noRuns = ordersConfig(ENV, mac({ actions: ['task'], jobs: ['morning-intel'] }))
  assert.deepEqual(noRuns.jobs, [], 'jobs were offered from a Mac that takes no runs')
  const noTasks = ordersConfig(ENV, mac({ actions: ['run'], jobs: ['morning-intel'] }))
  assert.equal(noTasks.tasks, false)
  assert.deepEqual(noTasks.jobs, ['morning-intel'])
  const many = ordersConfig(ENV, mac({ actions: ['run'], jobs: Array.from({ length: 45 }, (_, n) => `job-${String(44 - n).padStart(2, '0')}`) }))
  assert.equal(many.jobs.length, MAX_ORDER_JOBS)
  assert.deepEqual(many.jobs, [...many.jobs].sort())
  const nothing = ordersConfig(ENV, mac({ actions: ['move'], jobs: ['morning-intel'] }))
  assert.equal(nothing.on, false)
  assert.equal(nothing.why, MAILBOX_ORDERS_OFF)
})

test('in mailbox mode orders are off - in the mailbox\'s own sentence - when it is not set up or the fire key is short', () => {
  for (const [what, env] of [
    ['no signing secret', { ...ENV, MAILBOX_SECRET: undefined }],
    ['no picture store', { ...ENV, BLOB_STORE_ID: undefined }],
    ['a fire key under 24 characters', { ...ENV, FIRE_KEY: 'FILL-ME-IN' }],
    ['no fire key', { ...ENV, FIRE_KEY: undefined }],
    ['a long placeholder fire key', { ...ENV, FIRE_KEY: 'your-long-passphrase-goes-here' }],
    ['a FIRE_MODE that is neither', { ...ENV, FIRE_MODE: 'mac' }]
  ]) {
    const config = ordersConfig(env, null)
    assert.equal(config.on, false, what)
    assert.equal(config.why, MAILBOX_ORDERS_OFF, what)
    assert.deepEqual(ordersView(config), { on: false }, what)
  }
  assert.match(MAILBOX_ORDERS_OFF, /your Mac/)
  assert.match(MAILBOX_ORDERS_OFF, /Orders on your own computer/)
  assert.doesNotMatch(MAILBOX_ORDERS_OFF, /FIRE_TRIGGERS|task-intake routine/)
  // PUBLIC_FIRE waives the fire key, as in the cloud.
  const open = ordersConfig({ ...ENV, FIRE_KEY: undefined, PUBLIC_FIRE: 'true' }, null)
  assert.equal(open.on, true)
  assert.equal(open.key, 'public')
  // The cloud is as it was.
  assert.equal(ordersConfig({}, null).why, ORDERS_OFF)
  assert.equal(ordersView(ordersConfig({ FIRE_KEY: 'k', FIRE_TRIGGERS: '{}' })).via, undefined)
})

test('the Mac\'s status is read from the repo once, shaped by the contract, and anything wrong reads as none', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const asked = []
  const answerWith = (status, body) => {
    globalThis.fetch = async (url, options = {}) => {
      asked.push({ url: String(url), options })
      return new Response(body, { status })
    }
  }
  answerWith(200, JSON.stringify(SAMPLE))
  const read = await readMacStatus(ENV, 'mac-mini', Date.parse(SAMPLE.takenAt) + 60_000)
  assert.deepEqual(read, shapeMailbox([[`${MAILBOX_FOLDER}/mac-mini.json`, JSON.stringify(SAMPLE)]], Date.parse(SAMPLE.takenAt) + 60_000, 1).computers[0])
  assert.equal(asked.length, 1)
  assert.equal(asked[0].url, 'https://api.github.com/repos/ExampleOwner/example-team/contents/.agent-team/status/mailbox/mac-mini.json?ref=main')
  assert.equal(asked[0].options.headers.Authorization, `Bearer ${ENV.GITHUB_TOKEN}`)
  assert.ok(asked[0].options.signal, 'a slow GitHub could hold the call up forever')
  for (const [status, body] of [[404, 'Not Found'], [200, 'not json'], [200, JSON.stringify({ ...SAMPLE, schema: 'other' })], [200, 'x'.repeat(70_000)]]) {
    answerWith(status, body)
    assert.equal(await readMacStatus(ENV, 'mac-mini', Date.now()), null, `${status} ${body.slice(0, 20)}`)
  }
  globalThis.fetch = async () => { throw new Error('offline') }
  assert.equal(await readMacStatus(ENV, 'mac-mini', Date.now()), null)
  // A runner that is not a runner is never put in a path.
  asked.length = 0
  answerWith(200, JSON.stringify(SAMPLE))
  assert.equal(await readMacStatus(ENV, '../jobs/x', Date.now()), null)
  assert.equal(asked.length, 0)
})

test('a call on a mailbox board is told the orders the Mac takes: read from its status file, never a key or the secret', async (t) => {
  const { makeHandler } = await import('../api/voice-session.js')
  const { STORE_ENV, NOON, connectedStore, asTheBoard, call } = await import('./helpers/personalise-harness.mjs')
  const { OPENAI_KEY, SDP_OFFER, SDP_ANSWER } = await import('./helpers/voice-fixtures.mjs')
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const asked = []
  globalThis.fetch = async (url) => {
    asked.push(String(url))
    if (String(url).startsWith('https://api.github.com')) return new Response(JSON.stringify(SAMPLE), { status: 200 })
    return new Response(SDP_ANSWER, { status: 201, headers: { 'content-type': 'application/sdp' } })
  }
  const env = { ...STORE_ENV, ...ENV, OPENAI_API_KEY: OPENAI_KEY }
  const handler = makeHandler({ store: connectedStore(env).store, env, now: NOON })
  const response = await call(handler, { method: 'POST', headers: asTheBoard({ 'content-type': 'application/json' }), body: { sdp: SDP_OFFER } })
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.orders.via, 'mac')
  assert.deepEqual(response.body.orders.jobs, ['morning-intel', 'task-sweep'])
  assert.equal(asked.filter((url) => url.startsWith('https://api.github.com')).length, 1)
  const text = JSON.stringify(response.body)
  for (const value of [ENV.MAILBOX_SECRET, ENV.MAILBOX_KEY, ENV.FIRE_KEY, ENV.GITHUB_TOKEN]) assert.ok(!text.includes(value))
})
