// A real-machine test of the board on this computer found these (task "run-refresh"):
//   1. After Run (or Add task), the card for the order did not appear, and nothing asked how far the run had got, until a reload.
//   2. The live card and the reloaded card gave two different lengths for the same run.
//   3. "From your always-on computer" over Plan limits; the used-link page said "start the board again"; /api/progress answered
//      404 (a red console error) for an order the board had just queued but the runner had not started.
// The page runs in the stand-in DOM with its own clock, timers and fetch.

import test from 'node:test'
import assert from 'node:assert/strict'
import { loadPage, flush } from './helpers/page-harness.mjs'
import { basePayload } from './helpers/page-payload.mjs'
import { progressHandler, queuedOrders, rememberQueuedOrders } from '../local/progress.mjs'

const NOW = Date.parse('2026-10-18T10:00:00Z')
const ID = '0f1e2d3c4b5a69788796a5b4c3d2e1f0'
const STORE = 'agent-cockpit-mac-orders'
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')
const reply = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, type: 'basic', headers: { get: () => null }, json: async () => body })

function fakeTimers() {
  let next = 1
  const pending = new Map()
  return {
    pending,
    setTimeout: (fn, ms) => { const id = next++; pending.set(id, { fn, ms }); return id },
    clearTimeout: (id) => { pending.delete(id) },
    delays: () => [...pending.values()].map((timer) => timer.ms),
    async fire(ms) {
      const due = [...pending].filter(([, timer]) => timer.ms === ms)
      assert.ok(due.length > 0, `no timer waiting for ${ms} ms; waiting: ${JSON.stringify(this.delays())}`)
      for (const [id, timer] of due) { pending.delete(id); await timer.fn() }
      await flush()
    }
  }
}
function clockAt() {
  const clock = { now: NOW }
  class PinnedDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(clock.now) }
    static now() { return clock.now }
  }
  return { clock, PinnedDate }
}
const entry = (patch = {}) => ({ id: ID, action: 'run', state: 'claimed', at: iso(NOW - 140_000), startedAt: null, finishedAt: null, commit: null, why: null, landed: null, ...patch })
const mailbox = (orders) => ({ status: 'ok', computers: [{ computer: 'This computer', runner: 'this-computer', takenAt: iso(NOW), allows: { actions: ['run', 'task'], jobs: ['monday-brief'] }, orders, hidden: 0 }] })
const sentAnswer = { ok: true, accepted: true, via: 'mac', orderId: ID, expiresAt: iso(NOW + 15 * 60_000), pollSeconds: 300 }
const doc = (patch = {}) => ({ phase: 'working', steps: 7, lastTool: 'Edit', startedAt: iso(NOW - 125_000), lastEventAt: iso(NOW - 2000), final: false, ...patch })

// A page with nothing remembered yet. `state()` is what /api/state answers (a function, so a test can change it), `progress()` what /api/progress answers.
function freshBoard({ local = true, state = () => reply(200, { ...basePayload(), mailbox: mailbox([]) }), progress = () => reply(404, {}), log = [] } = {}) {
  const timers = fakeTimers()
  const { clock, PinnedDate } = clockAt()
  const calls = { progress: [], state: 0 }
  const page = loadPage({
    expose: ['fireWorkflow', 'macNote'],
    timers, date: PinnedDate,
    storage: { [STORE]: JSON.stringify(log) },
    windowExtras: local ? { __BOARD_LOCAL__: true } : {},
    fetch: async (url) => {
      if (url.startsWith('/api/progress')) { calls.progress.push(url); return progress(calls.progress.length) }
      if (url === '/api/fire') return reply(200, sentAnswer)
      if (url.startsWith('/api/state')) { calls.state += 1; return state(calls.state) }
      return reply(200, {})
    }
  })
  const run = async () => {
    const note = { className: '', textContent: '', innerHTML: '' }
    await page.exposed.fireWorkflow({ dataset: { fire: 'monday-brief', action: 'run' }, parentElement: { querySelector: () => note }, innerHTML: 'Run', disabled: false })
    await flush()
    return note
  }
  return { page, timers, clock, calls, run, card: () => page.node('mac-orders').innerHTML, line: () => page.node(`mac-prog-${ID}`).innerHTML, said: () => page.node(`mac-said-${ID}`).textContent }
}

/* ---------- 1. the card and the live progress appear right after Run, with no reload ---------- */

test('local: pressing Run draws the order on the card at once and starts asking how far it has got', async () => {
  const b = freshBoard()
  await flush()
  assert.equal(b.calls.progress.length, 0, 'nothing sent yet, nothing asked')
  assert.equal(b.card(), '', 'no card before any order')
  const note = await b.run()
  assert.match(note.textContent, /Sent to this computer/)
  assert.match(b.card(), /Run monday-brief/, 'the card shows the order without a reload')
  assert.match(b.card(), /This computer/)
  assert.deepEqual(b.calls.progress, [`/api/progress?order=${ID}`], 'the first look at progress is made straight away')
})

test('local: the live line then follows the run, and the card words change with it (never "Sent to..." beside "Working")', async () => {
  let answers = 0
  const b = freshBoard({ progress: () => { answers += 1; return answers === 1 ? reply(200, { state: 'waiting' }) : reply(200, doc({ steps: answers })) } })
  await flush()
  await b.run()
  assert.match(b.said(), /Sent to this computer\. It starts in a moment\./)
  await b.timers.fire(5000)
  assert.match(b.line(), /Working/)
  assert.match(b.said(), /This computer is running it/)
  assert.doesNotMatch(b.said(), /Sent to|checks every/)
})

test('local: any button that queues an order redraws the card (Add task goes through the same path)', async () => {
  const b = freshBoard()
  await flush()
  const note = { textContent: '' }
  b.page.exposed.macNote(note, 'task', 'Task: call the supplier', sentAnswer)
  await flush()
  assert.match(b.card(), /Task: call the supplier/)
  assert.equal(b.calls.progress.length, 1)
})

test('local: an order sent from another screen is on the card, and asked after, when Today comes back', async () => {
  const b = freshBoard()
  b.page.location.hash = '#team'
  await flush()
  await b.run()
  assert.match(b.card(), /Run monday-brief/, 'the card is already drawn, only hidden')
  assert.equal(b.calls.progress.length, 0, 'not asked while Today is not showing')
  b.page.location.hash = ''
  for (const { type, handler } of b.page.windowListeners) if (type === 'hashchange') await handler()
  await flush()
  assert.equal(b.calls.progress.length, 1)
})

test('website: pressing Run draws no card of its own and asks nothing new (it is as it was)', async () => {
  const b = freshBoard({ local: false })
  await flush()
  await b.run()
  assert.equal(b.calls.progress.length, 0)
  assert.doesNotMatch(b.page.node('today').innerHTML, /id="mac-orders"|mac-said-/)
})

/* ---------- 2. one run, one length ---------- */

const final = (patch = {}) => doc({ final: true, outcome: 'ok', steps: 12, startedAt: iso(NOW - 100_000), lastEventAt: iso(NOW - 35_000), ...patch })
const finishedEntry = entry({ state: 'ok', startedAt: iso(NOW - 102_000), finishedAt: iso(NOW - 17_000), steps: 12 })

test('local: a finished run gives no length until the Mac file has one, and then the same length a reload gives', async () => {
  let orders = [entry({ state: 'running', startedAt: iso(NOW - 102_000) })]
  const stateGate = { open: null }
  const gate = new Promise((resolve) => { stateGate.open = resolve })
  const b = freshBoard({
    log: [{ kind: 'run', label: 'Run monday-brief', sentAt: iso(NOW - 150_000), via: 'mac', id: ID, expiresAt: iso(NOW + 15 * 60_000), pollSeconds: 300 }],
    state: (call) => (call === 1 ? reply(200, { ...basePayload(), mailbox: mailbox(orders) }) : gate.then(() => reply(200, { ...basePayload(), mailbox: mailbox(orders) }))),
    progress: () => reply(200, final())
  })
  await flush()
  assert.match(b.line(), /Finished: 12 steps\./, 'finished, and no length yet')
  assert.doesNotMatch(b.line(), /1m 05s|\d+m \d\ds/, 'the progress file\'s own length is not shown while the Mac file is on its way')
  assert.doesNotMatch(b.said(), /Sent to|picked it up|is running it/, 'the words beside it agree: it is over')
  orders = [finishedEntry]
  stateGate.open()
  await flush()
  assert.match(b.line(), /Took 1m 25s, 12 steps\./)
  // The same card drawn after a reload.
  const reloaded = freshBoard({
    log: [{ kind: 'run', label: 'Run monday-brief', sentAt: iso(NOW - 150_000), via: 'mac', id: ID, expiresAt: iso(NOW + 15 * 60_000), pollSeconds: 300 }],
    state: () => reply(200, { ...basePayload(), mailbox: mailbox(orders) })
  })
  await flush()
  const reloadedToday = reloaded.page.node('today').innerHTML
  assert.match(reloadedToday, /Took 1m 25s, 12 steps\./)
  assert.ok(reloadedToday.includes(b.card()), 'the reloaded Today holds exactly the card the live page drew')
})

test('local: if the Mac file never gets the run, the card falls back to the progress file\'s length after a few tries and stops asking', async () => {
  const b = freshBoard({
    log: [{ kind: 'run', label: 'Run monday-brief', sentAt: iso(NOW - 150_000), via: 'mac', id: ID, expiresAt: iso(NOW + 15 * 60_000), pollSeconds: 300 }],
    state: () => reply(200, { ...basePayload(), mailbox: mailbox([entry({ state: 'running', startedAt: iso(NOW - 102_000) })]) }),
    progress: () => reply(200, final())
  })
  await flush()
  assert.match(b.line(), /Finished: 12 steps\./)
  for (let attempt = 0; attempt < 6 && b.timers.delays().includes(3000); attempt += 1) await b.timers.fire(3000)
  assert.equal(b.timers.delays().includes(3000), false, 'it stops asking')
  assert.ok(b.calls.state <= 6, `asked the board at most a handful of times (${b.calls.state})`)
  assert.match(b.line(), /Finished: 12 steps in 1m 05s\./)
})

test('local: a failed run says "Stopped after N steps" with no length while it waits for the Mac file', async () => {
  const b = freshBoard({
    log: [{ kind: 'run', label: 'Run monday-brief', sentAt: iso(NOW - 150_000), via: 'mac', id: ID, expiresAt: iso(NOW + 15 * 60_000), pollSeconds: 300 }],
    state: (call) => (call === 1 ? reply(200, { ...basePayload(), mailbox: mailbox([entry({ state: 'running', startedAt: iso(NOW - 102_000) })]) }) : new Promise(() => {})),
    progress: () => reply(200, final({ outcome: 'failed', steps: 3 }))
  })
  await flush()
  assert.match(b.line(), /Stopped after 3 steps\./)
  assert.match(b.said(), /stopped/i)
})

/* ---------- 3a. wording in local mode ---------- */

test('local: Plan limits is headed "From this computer", not "always-on computer"; the website keeps its words', async () => {
  const local = freshBoard()
  await flush()
  assert.doesNotMatch(local.page.node('today').innerHTML, /always-on computer|computer that is always on/)
  assert.match(local.page.node('today').innerHTML, /From this computer/)
  const web = freshBoard({ local: false })
  await flush()
  assert.match(web.page.node('today').innerHTML, /From your always-on computer/)
  assert.match(web.page.node('today').innerHTML, /computer that is always on/)
})

/* ---------- 3b. the progress address: waiting vs unknown ---------- */

const ask = async (handler, query) => {
  let sent = { status: 200 }
  const response = { setHeader() {}, status(code) { sent = { status: code }; return this }, json(value) { sent = { ...sent, body: value }; return this } }
  await handler({ method: 'GET', query }, response)
  return sent
}

test('progress: an order the board queued but the runner has not started answers 200 "waiting"; an id it never queued stays 404', async () => {
  const queued = queuedOrders()
  const handler = progressHandler({ stateDir: () => 'C:/nowhere/at/all', queued })
  assert.equal((await ask(handler, { order: ID })).status, 404)
  queued.note(ID)
  const waiting = await ask(handler, { order: ID })
  assert.equal(waiting.status, 200)
  assert.deepEqual(waiting.body, { state: 'waiting' })
  assert.equal((await ask(handler, { order: 'a'.repeat(32) })).status, 404, 'another id is still unknown')
  assert.equal((await ask(handler, { order: 'nope' })).status, 400, 'a bad id is still refused first')
})

test('progress: the board remembers only the last 200 queued orders, and only well-formed ids', () => {
  const queued = queuedOrders()
  queued.note('not an id')
  queued.note(5)
  assert.equal(queued.size(), 0)
  for (let index = 0; index < 205; index += 1) queued.note(index.toString(16).padStart(32, '0'))
  assert.equal(queued.size(), 200)
  assert.equal(queued.has((0).toString(16).padStart(32, '0')), false, 'the oldest went')
  assert.equal(queued.has((204).toString(16).padStart(32, '0')), true)
})

test('progress: the fire wrapper notes the order id of a queued order, and nothing else', async () => {
  const queued = queuedOrders()
  const answerWith = (status, value) => async (request, response) => { response.statusCode = status; response.json(value) }
  const response = () => { const r = { statusCode: 200, json() { return this } }; return r }
  await rememberQueuedOrders(answerWith(200, { ok: true, via: 'mac', orderId: ID }), queued)({}, response())
  assert.equal(queued.has(ID), true)
  const other = queuedOrders()
  await rememberQueuedOrders(answerWith(401, { ok: true, via: 'mac', orderId: ID }), other)({}, response())
  await rememberQueuedOrders(answerWith(200, { ok: false, orderId: ID }), other)({}, response())
  await rememberQueuedOrders(answerWith(200, { ok: true, via: 'cloud', orderId: ID }), other)({}, response())
  assert.equal(other.size(), 0)
})
