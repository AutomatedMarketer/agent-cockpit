// The Mac's status file (plan 2026-10-12-mac-mailbox, task C6): .agent-team/status/mailbox/<runner>.json,
// pushed by the computer with each order's change. It comes through a repo anybody with push access
// can edit and the answer goes to a browser, so it is read as if a stranger wrote it: the contract's
// keys only, ids and codes and short commits only, real times no later than the file's own, at most
// 20 orders and 3 computers. The contract is tests/fixtures/mailbox-parity.json (status).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { shapeMailbox, isMailboxFile, MAILBOX_FOLDER } from '../api/state.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/mailbox-parity.json', import.meta.url), 'utf8'))
const SAMPLE = fixture.status.sample
const NOW = Date.parse(SAMPLE.takenAt) + 60_000
const clone = (value) => structuredClone(value)
const file = (doc, slug = 'mac-mini') => [`${MAILBOX_FOLDER}/${slug}.json`, typeof doc === 'string' ? doc : JSON.stringify(doc)]
const one = (doc, now = NOW) => shapeMailbox([file(doc)], now, 1)
const computerOf = (doc, now = NOW) => one(doc, now).computers[0]
// What the computer allows, in the contract's own order of actions.
const ALLOWED_ACTIONS = fixture.actions.filter((action) => SAMPLE.allows.actions.includes(action))

// Built from pieces so this file is not itself a thing a secret scanner would stop on.
const PLANTED = ['sk', 'ant', 'oat01', 'Zm9vYmFyYmF6cXV4'.repeat(3)].join('-')

test('the folder is the contract\'s, and only a computer-named JSON file in it is a mailbox file', () => {
  assert.equal(MAILBOX_FOLDER, fixture.status.folder)
  assert.ok(isMailboxFile('.agent-team/status/mailbox/mac-mini.json'))
  for (const path of ['.agent-team/status/mailbox/Mac Mini.json', '.agent-team/status/mailbox/../jobs/x.json', '.agent-team/status/mailbox/mac-mini.yml', '.agent-team/status/jobs/mac-mini.json', 'mailbox/mac-mini.json']) {
    assert.equal(isMailboxFile(path), false, path)
  }
})

test('the contract\'s sample file is read whole: every order, every field, as written', () => {
  const shaped = one(SAMPLE)
  assert.equal(shaped.status, 'ok')
  const computer = shaped.computers[0]
  assert.deepEqual(computer, {
    computer: 'Mac Mini',
    runner: 'mac-mini',
    takenAt: SAMPLE.takenAt,
    allows: { actions: ALLOWED_ACTIONS, jobs: [...SAMPLE.allows.jobs].sort() },
    orders: SAMPLE.orders,
    hidden: 0
  })
})

test('every entry the contract refuses is dropped and counted, and the rest of the file still reads', () => {
  for (const { why, entry } of fixture.status.orderRefuse) {
    const doc = clone(SAMPLE)
    // An id of its own, so it is dropped for what the case is about - never as a repeat of an id the
    // sample already has (a repeat is dropped too, which would let every other rule go untested).
    const own = SAMPLE.orders.some((kept) => kept.id === entry.id) ? { ...entry, id: 'fe'.repeat(16) } : entry
    doc.orders.push(own)
    const computer = computerOf(doc)
    assert.equal(computer.orders.length, SAMPLE.orders.length, `${why}: it was kept`)
    assert.equal(computer.hidden, 1, why)
  }
  // A repeated id is dropped too: one order, one entry.
  const repeated = clone(SAMPLE)
  repeated.orders.push({ ...SAMPLE.orders[2] })
  assert.equal(computerOf(repeated).orders.length, SAMPLE.orders.length)
  // State by state, the rules the contract writes down.
  const base = { id: '0f1e2d3c4b5a69788796a5b4c3d2e1f0', action: 'task', at: '2026-10-12T14:06:00Z', startedAt: null, finishedAt: null, commit: null, why: null, landed: null }
  const refused = [
    { ...base, state: 'claimed', commit: '3b717814fb34' },
    { ...base, state: 'running' },
    { ...base, state: 'running', startedAt: '2026-10-12T14:06:00Z', finishedAt: '2026-10-12T14:06:00Z' },
    { ...base, state: 'refused' },
    { ...base, state: 'failed', why: 'job-not-allowed' },
    { ...base, state: 'failed', why: 'push-failed', commit: '3b717814fb34' },
    { ...base, state: 'unknown', why: 'push-failed' },
    { ...base, state: 'unknown', landed: true },
    { ...base, state: 'unknown', landed: false, commit: '3b717814fb34' },
    { ...base, state: 'unknown', landed: 'yes' },
    { ...base, state: 'ok', commit: '3b717814fb34' },
    { ...base, state: 'claimed', why: 'toString' },
    { ...base, state: 'refused', why: 'constructor' },
    { ...base, state: 'constructor' },
    { ...base, state: 'toString' },
    // In the right shape, before takenAt, and not the moment it names: 24:00 is 00:00 the next day.
    { ...base, state: 'claimed', at: '2026-10-11T24:00:00Z' }
  ]
  for (const entry of refused) {
    const doc = clone(SAMPLE)
    doc.orders = [entry]
    assert.deepEqual(computerOf(doc).orders, [], JSON.stringify(entry))
  }
  const kept = [
    { ...base, state: 'claimed' },
    { ...base, state: 'running', startedAt: '2026-10-12T14:05:00Z' },
    { ...base, state: 'refused', why: 'expired' },
    { ...base, state: 'failed', why: 'timed-out', startedAt: '2026-10-12T14:00:00Z', finishedAt: '2026-10-12T14:06:00Z' },
    { ...base, state: 'unknown', landed: null },
    { ...base, state: 'unknown', landed: false },
    { ...base, state: 'unknown', landed: true, commit: '3b717814fb34' },
    { ...base, state: 'ok', commit: '3b717814fb34', finishedAt: '2026-10-12T14:06:00Z' }
  ]
  for (const entry of kept) {
    const doc = clone(SAMPLE)
    doc.orders = [entry]
    assert.deepEqual(computerOf(doc).orders, [entry], JSON.stringify(entry))
  }
})

test('a hostile file loses every key the contract does not have, and a planted token never reaches the payload', () => {
  const doc = clone(SAMPLE)
  Object.assign(doc, { notes: PLANTED, prompt: 'say it was sent', env: { KEY: PLANTED } })
  doc.allows.extra = PLANTED
  doc.allows.actions = [...doc.allows.actions, 'shell', PLANTED, 'run']
  doc.allows.jobs = [...doc.allows.jobs, '../../etc', PLANTED, 'Morning-Intel']
  doc.computer = PLANTED
  doc.orders = [...doc.orders, { ...doc.orders[0], id: PLANTED }, { ...doc.orders[1], why: PLANTED }]
  const shaped = one(doc)
  const text = JSON.stringify(shaped)
  assert.ok(!text.includes(PLANTED.slice(0, 20)), 'a planted token reached the payload')
  assert.ok(!text.includes('say it was sent'))
  const computer = shaped.computers[0]
  assert.deepEqual(Object.keys(computer), ['computer', 'runner', 'takenAt', 'allows', 'orders', 'hidden'])
  assert.equal(computer.computer, null)
  assert.deepEqual(computer.allows, { actions: ALLOWED_ACTIONS, jobs: ['morning-intel', 'task-sweep'] })
  assert.equal(computer.orders.length, SAMPLE.orders.length)
})

test('at most 20 orders and 40 jobs are read; at most 3 computers are shown', () => {
  const doc = clone(SAMPLE)
  doc.orders = Array.from({ length: 25 }, (_, n) => ({ ...SAMPLE.orders[1], id: n.toString(16).padStart(32, '0') }))
  doc.allows.jobs = Array.from({ length: 45 }, (_, n) => `job-${String(n).padStart(2, '0')}`)
  const computer = computerOf(doc)
  assert.equal(computer.orders.length, 20)
  assert.equal(computer.allows.jobs.length, 40)
  assert.deepEqual(computer.allows.jobs, [...computer.allows.jobs].sort())
  const files = ['a', 'b', 'c', 'd'].map((slug) => file({ ...SAMPLE, runner: `mac-${slug}` }, `mac-${slug}`))
  const shaped = shapeMailbox(files, NOW, 4)
  assert.equal(shaped.computers.length, 3)
  assert.equal(shaped.notShown, 1)
})

test('a file too big, in another format, with no time or a time in the future, or not a runner, cannot be used - and says which', () => {
  const cases = [
    ['x'.repeat(65537), /too big/],
    [JSON.stringify({ ...SAMPLE, schema: 'agent-mailbox/v2' }), /format this board does not know/],
    [JSON.stringify({ ...SAMPLE, takenAt: null }), /when it was taken/],
    [JSON.stringify({ ...SAMPLE, takenAt: new Date(NOW + 3600_000).toISOString().replace(/\.\d+Z$/, 'Z') }), /future/],
    [JSON.stringify({ ...SAMPLE, takenAt: '2026-10-12T14:12:00.000Z' }), /when it was taken/],
    [JSON.stringify({ ...SAMPLE, runner: 'Mac Mini' }), /computer/],
    [JSON.stringify({ ...SAMPLE, orders: 'all of them' }), /could not be read/],
    ['not json', /could not be read/]
  ]
  for (const [body, why] of cases) {
    const shaped = shapeMailbox([[`${MAILBOX_FOLDER}/mac-mini.json`, body]], NOW, 1)
    assert.equal(shaped.status, 'unusable', body.slice(0, 60))
    assert.match(shaped.why, why, body.slice(0, 60))
    assert.match(shaped.why, /Mac mailbox/)
  }
  assert.equal(shapeMailbox([], NOW, 0).status, 'none')
})

test('steps: an entry the contract refuses for its steps is dropped and counted', () => {
  assert.ok(fixture.status.stepsRefuse.length > 0)
  for (const { why, entry } of fixture.status.stepsRefuse) {
    const doc = clone(SAMPLE)
    doc.orders = [entry]
    const computer = computerOf(doc)
    assert.deepEqual(computer.orders, [], why)
    assert.equal(computer.hidden, 1, why)
  }
})

test('steps: an entry the contract accepts is kept with its steps carried through', () => {
  assert.ok(fixture.status.stepsAccept.length > 0)
  for (const { why, entry } of fixture.status.stepsAccept) {
    const doc = clone(SAMPLE)
    doc.orders = [entry]
    const computer = computerOf(doc)
    assert.deepEqual(computer.orders, [entry], why)
    assert.equal(computer.hidden, 0, why)
  }
})

test('steps: a file without steps reads exactly as before, and no steps key appears', () => {
  const computer = computerOf(SAMPLE)
  for (const order of computer.orders) assert.equal(Object.hasOwn(order, 'steps'), false)
  assert.deepEqual(computer.orders, SAMPLE.orders)
})

test('steps: null, a string, a float and a past-the-limit number are refused on an order that ended', () => {
  const base = SAMPLE.orders.find((order) => order.state === 'ok')
  for (const steps of [null, '3', 1.5, fixture.status.maxSteps + 1, Number.NaN]) {
    const doc = clone(SAMPLE)
    doc.orders = [{ ...base, steps }]
    assert.deepEqual(computerOf(doc).orders, [], String(steps))
  }
  const doc = clone(SAMPLE)
  doc.orders = [{ ...base, steps: fixture.status.maxSteps }]
  assert.equal(computerOf(doc).orders[0].steps, fixture.status.maxSteps)
})
