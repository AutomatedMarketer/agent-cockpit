// Live progress on the Today card (task T12), rendered by the page's own code in the stand-in DOM, with its clock, its
// timers and its fetch handed in: every second here is a second the test chose.
//
// Local board: the page asks /api/progress for each of ITS OWN orders that is going, every 1.5 s, and stops when the order
// is over, the tab is hidden, Today is not showing, or two hours have passed. Website: no such address exists, so the page
// asks nothing new and says what the Mac's status file says.

import test from 'node:test'
import assert from 'node:assert/strict'
import { loadPage, flush } from './helpers/page-harness.mjs'
import { basePayload } from './helpers/page-payload.mjs'

const NOW = Date.parse('2026-10-17T10:00:00Z')
const ID = '0f1e2d3c4b5a69788796a5b4c3d2e1f0'
const OTHER = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const STORE = 'agent-cockpit-mac-orders'
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')

function fakeTimers() {
  let next = 1
  const pending = new Map()
  return {
    pending,
    setTimeout: (fn, ms) => {
      const id = next++
      pending.set(id, { fn, ms })
      return id
    },
    clearTimeout: (id) => { pending.delete(id) },
    delays: () => [...pending.values()].map((timer) => timer.ms),
    // Runs every waiting timer that was set for `ms`, in order, and lets what they started finish.
    async fire(ms) {
      const due = [...pending].filter(([, timer]) => timer.ms === ms)
      assert.ok(due.length > 0, `no timer waiting for ${ms} ms; waiting: ${JSON.stringify(this.delays())}`)
      for (const [id, timer] of due) {
        pending.delete(id)
        await timer.fn()
      }
      await flush()
    }
  }
}

function clockAt(start = NOW) {
  const clock = { now: start }
  class PinnedDate extends Date {
    constructor(...args) {
      if (args.length) super(...args)
      else super(clock.now)
    }
    static now() { return clock.now }
  }
  return { clock, PinnedDate }
}

const reply = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, type: 'basic', headers: { get: () => null }, json: async () => body })
const doc = (patch = {}) => ({ phase: 'working', steps: 7, lastTool: 'Edit', startedAt: iso(NOW - 125_000), lastEventAt: iso(NOW - 2000), final: false, ...patch })
const remembered = (patch = {}) => ({ via: 'mac', id: ID, kind: 'run', label: 'Run monday-brief', sentAt: iso(NOW - 150_000), expiresAt: iso(NOW + 15 * 60_000), pollSeconds: 300, ...patch })
const entry = (patch = {}) => ({ id: ID, action: 'run', state: 'claimed', at: iso(NOW - 140_000), startedAt: null, finishedAt: null, commit: null, why: null, landed: null, ...patch })
const withOrders = (orders) => ({
  ...basePayload(),
  mailbox: { status: 'ok', computers: [{ computer: 'My Mac', runner: 'my-mac', takenAt: iso(NOW), allows: { actions: ['run'], jobs: ['monday-brief'] }, orders, hidden: 0 }] }
})

// `progress`: what /api/progress answers, per order id: a function (call number) -> reply, or a fixed reply.
function board({ local = true, orders = [entry()], log = [remembered()], progress = {}, hash = '', visibility = 'visible' } = {}) {
  const timers = fakeTimers()
  const { clock, PinnedDate } = clockAt()
  const calls = []
  const page = loadPage({
    hash, timers, date: PinnedDate,
    storage: { [STORE]: JSON.stringify(log) },
    windowExtras: local ? { __BOARD_LOCAL__: true } : {},
    fetch: async (url, init = {}) => {
      if (url.startsWith('/api/progress')) {
        calls.push(url)
        const id = new URL(url, 'http://x').searchParams.get('order')
        const one = progress[id]
        return typeof one === 'function' ? one(calls.length) : one ?? reply(404, { error: 'No progress is kept for that order.' })
      }
      return reply(200, url.startsWith('/api/state') ? withOrders(orders) : {})
    }
  })
  page.document.visibilityState = visibility
  return { page, timers, clock, calls, line: () => page.node(`mac-prog-${ID}`).innerHTML, today: () => `${page.node('today').innerHTML} ${page.node(`mac-prog-${ID}`).innerHTML}`, wait: async (ms) => { clock.now += ms } }
}
const hide = async (page, state) => {
  page.document.visibilityState = state
  for (const { type, handler } of page.documentListeners) if (type === 'visibilitychange') await handler()
  await flush()
}
const progressRequests = (page) => page.requests.filter((request) => request.url.startsWith('/api/progress'))

/* ---------- local: what the card shows ------------------------------------------------------- */

test('local: a running order of this page shows its phase, step count, last tool and a clock since it started', async () => {
  const { page, today, calls } = board({ progress: { [ID]: reply(200, doc()) } })
  await flush()
  assert.deepEqual(calls, [`/api/progress?order=${ID}`])
  assert.match(today(), /Working/)
  assert.match(today(), /7 steps so far/)
  assert.match(today(), /last used Edit/)
  assert.match(today(), /2m 05s/, 'the clock reads from the start time the runner wrote')
  assert.match(today(), /Run monday-brief/, 'still the existing Your Mac card')
  assert.equal(progressRequests(page)[0].init.cache, 'no-store')
})

test('local: the phases and the one-step and no-step cases are said in plain words', async () => {
  const cases = [
    [doc({ phase: 'started', steps: 0, lastTool: null }), /Starting up/, /no steps yet/],
    [doc({ phase: 'working', steps: 1, lastTool: 'Read' }), /Working/, /1 step so far/],
    [doc({ phase: 'finishing', steps: 12, lastTool: 'unknown' }), /Finishing up/, /last used a tool/]
  ]
  for (const [one, phase, steps] of cases) {
    const { today } = board({ progress: { [ID]: reply(200, one) } })
    await flush()
    assert.match(today(), phase)
    assert.match(today(), steps)
    assert.doesNotMatch(today(), /last used null|undefined|NaN/)
  }
})

test('local: the clock ticks every second without asking the board for anything', async () => {
  const { page, timers, clock, today } = board({ progress: { [ID]: reply(200, doc()) } })
  await flush()
  const before = progressRequests(page).length
  assert.ok(timers.delays().includes(1000), `a one-second clock is waiting: ${JSON.stringify(timers.delays())}`)
  clock.now += 1000
  await timers.fire(1000)
  assert.equal(page.node(`mac-clock-${ID}`).textContent, '2m 06s')
  clock.now += 60_000
  await timers.fire(1000)
  assert.equal(page.node(`mac-clock-${ID}`).textContent, '3m 06s')
  assert.equal(progressRequests(page).length, before, 'ticking made no request')
  assert.match(today(), /2m 05s/, 'the drawn card is not redrawn by the tick')
})

test('local: the answer is checked again on the page; a tool name that is markup is shown as "a tool", never as markup', async () => {
  const { line } = board({ progress: { [ID]: reply(200, doc({ lastTool: '<img src=x onerror=alert(1)>', extra: '<b>x</b>' })) } })
  await flush()
  assert.doesNotMatch(line(), /onerror|<img|<b>x/)
  assert.match(line(), /last used a tool/)
  const bad = board({ progress: { [ID]: reply(200, doc({ steps: 'lots' })) } })
  await flush()
  assert.doesNotMatch(bad.today(), /lots|NaN/)
})

test('local: a finished answer says so, with the steps and how long it took, and the polling stops', async () => {
  const { page, timers, today, calls } = board({ progress: { [ID]: reply(200, doc({ final: true, outcome: 'ok', steps: 12, startedAt: iso(NOW - 200_000), lastEventAt: iso(NOW - 5000) })) } })
  await flush()
  assert.match(today(), /Finished: 12 steps in 3m 15s/)
  assert.equal(calls.length, 1)
  assert.deepEqual(timers.delays(), [], 'no poll and no clock is left running')
  assert.equal(progressRequests(page).length, 1)
  const stopped = board({ progress: { [ID]: reply(200, doc({ final: true, outcome: 'failed', steps: 3 })) } })
  await flush()
  assert.match(stopped.today(), /Stopped after 3 steps/)
})

/* ---------- local: when it asks ---------------------------------------------------------------- */

test('local: it asks again 1.5 s after each answer while the run goes, and not after the last one', async () => {
  let answers = 0
  const { timers, calls } = board({
    progress: { [ID]: () => { answers += 1; return reply(200, doc({ steps: answers, final: answers >= 3, ...(answers >= 3 ? { outcome: 'ok' } : {}) })) } }
  })
  await flush()
  assert.equal(calls.length, 1)
  assert.ok(timers.delays().includes(1500))
  await timers.fire(1500)
  assert.equal(calls.length, 2)
  await timers.fire(1500)
  assert.equal(calls.length, 3)
  assert.equal(timers.delays().includes(1500), false, 'final: stopped')
})

test('local: an order that has not started yet is asked after more slowly (5 s), then 1.5 s once there is a file', async () => {
  let answers = 0
  const { timers, calls } = board({ progress: { [ID]: () => { answers += 1; return answers < 3 ? reply(404, {}) : reply(200, doc()) } } })
  await flush()
  assert.deepEqual(timers.delays().filter((ms) => ms !== 1000), [5000])
  await timers.fire(5000)
  assert.deepEqual(timers.delays().filter((ms) => ms !== 1000), [5000])
  await timers.fire(5000)
  assert.equal(calls.length, 3)
  assert.deepEqual(timers.delays().filter((ms) => ms !== 1000), [1500])
})

test('local: signed out (401) or a network failure never ends in a tight loop', async () => {
  const signedOut = board({ progress: { [ID]: reply(401, { needs: 'sign-in' }) } })
  await flush()
  assert.equal(signedOut.timers.delays().includes(1500), false)
  assert.equal(signedOut.timers.delays().includes(5000), false, 'a signed-out board is not asked again')
  const failing = board({ progress: { [ID]: () => { throw new TypeError('network') } } })
  await flush()
  assert.deepEqual(failing.timers.delays().filter((ms) => ms !== 1000), [5000])
})

test('local: nothing is asked when this page has sent no order', async () => {
  const { page, timers } = board({ log: [], orders: [] })
  await flush()
  assert.equal(progressRequests(page).length, 0)
  assert.deepEqual(timers.delays().filter((ms) => ms === 1500 || ms === 5000), [])
})

test('local: nothing is asked for an order that already ended in the Mac\'s status file, or one that ran out before it started', async () => {
  for (const orders of [
    [entry({ state: 'ok', startedAt: iso(NOW - 100_000), finishedAt: iso(NOW - 10_000), commit: 'abc123456789', landed: true })],
    [entry({ state: 'failed', startedAt: iso(NOW - 100_000), finishedAt: iso(NOW - 10_000), why: 'claude-failed' })],
    [entry({ state: 'refused', why: 'not-allowed' })]
  ]) {
    const { page } = board({ orders })
    await flush()
    assert.equal(progressRequests(page).length, 0, orders[0].state)
  }
  const expired = board({ orders: [], log: [remembered({ sentAt: iso(NOW - 40 * 60_000), expiresAt: iso(NOW - 20 * 60_000) })] })
  await flush()
  assert.equal(progressRequests(expired.page).length, 0)
})

test('local: it gives up two hours after the order was sent', async () => {
  const late = board({ orders: [entry({ state: 'running', startedAt: iso(NOW - 3 * 3600_000) })], log: [remembered({ sentAt: iso(NOW - 2 * 3600_000 - 60_000), expiresAt: iso(NOW + 3600_000) })] })
  await flush()
  assert.equal(progressRequests(late.page).length, 0)
  let answers = 0
  const { timers, clock, calls } = board({ log: [remembered({ sentAt: iso(NOW - 3600_000), expiresAt: iso(NOW + 3600_000) })], progress: { [ID]: () => { answers += 1; return reply(200, doc()) } } })
  await flush()
  assert.equal(calls.length, 1)
  clock.now += 61 * 60_000
  await timers.fire(1500)
  assert.equal(calls.length, 1, 'past the cap: the look is not made')
  assert.equal(timers.delays().includes(1500), false)
})

test('local: only orders of this page are asked for, however many the Mac lists', async () => {
  const { calls } = board({ orders: [entry(), entry({ id: OTHER })], progress: { [ID]: reply(200, doc()), [OTHER]: reply(200, doc()) } })
  await flush()
  assert.deepEqual(calls, [`/api/progress?order=${ID}`])
})

test('local: a hidden tab asks nothing; coming back asks again; another screen asks nothing', async () => {
  const { page, timers, calls } = board({ progress: { [ID]: reply(200, doc()) } })
  await flush()
  assert.equal(calls.length, 1)
  await hide(page, 'hidden')
  assert.equal(timers.delays().includes(1500), false, 'the waiting look was cancelled')
  assert.equal(timers.delays().includes(1000), false, 'and so was the clock')
  await hide(page, 'visible')
  assert.equal(calls.length, 2, 'back in front: it looks straight away')
  assert.ok(timers.delays().includes(1500))
  // From another screen.
  page.location.hash = '#team'
  for (const { type, handler } of page.windowListeners) if (type === 'hashchange') await handler()
  await flush()
  assert.equal(timers.delays().includes(1500), false)
  const hiddenAtStart = board({ progress: { [ID]: reply(200, doc()) }, visibility: 'hidden' })
  await flush()
  assert.equal(hiddenAtStart.calls.length, 0)
  const elsewhere = board({ progress: { [ID]: reply(200, doc()) }, hash: '#workflows' })
  await flush()
  assert.equal(elsewhere.calls.length, 0)
})

/* ---------- website ----------------------------------------------------------------------------- */

test('website: it never asks /api/progress, whatever the Mac\'s file says', async () => {
  const running = board({ local: false, orders: [entry({ state: 'running', startedAt: iso(NOW - 240_000) })] })
  await flush()
  const waiting = board({ local: false })
  await flush()
  for (const one of [running, waiting]) {
    assert.equal(progressRequests(one.page).length, 0)
    assert.equal(one.timers.delays().includes(1500), false)
    assert.equal(one.timers.delays().includes(5000), false)
  }
})

test('website: a run the Mac has picked up says when, with a clock that ticks, from the status file', async () => {
  const { page, timers, clock, today } = board({ local: false, orders: [entry({ state: 'running', startedAt: iso(NOW - 252_000) })] })
  await flush()
  assert.match(today(), /<div class="small muted" id="mac-prog-[0-9a-f]{32}">Picked up <span id="mac-clock-[0-9a-f]{32}">4m 12s<\/span> ago, running\.<\/div>/)
  assert.doesNotMatch(today(), /steps so far|last used/)
  clock.now += 3000
  await timers.fire(1000)
  assert.equal(page.node(`mac-clock-${ID}`).textContent, '4m 15s')
})

test('website: a finished run says how many steps it took, when the status file carries them', async () => {
  const done = entry({ state: 'ok', startedAt: iso(NOW - 200_000), finishedAt: iso(NOW - 20_000), commit: 'abc123456789', landed: true, steps: 12 })
  const { today, timers } = board({ local: false, orders: [done] })
  await flush()
  assert.match(today(), /Took 3m 00s, 12 steps/)
  assert.deepEqual(timers.delays().filter((ms) => ms === 1000), [], 'a finished run has no clock')
  const none = board({ local: false, orders: [{ ...done, steps: undefined }] })
  await flush()
  assert.doesNotMatch(none.today(), /steps/)
  const one = board({ local: false, orders: [{ ...done, steps: 1 }] })
  await flush()
  assert.match(one.today(), /Took 3m 00s, 1 step\b/)
})

test('website: a run that is only sent or picked up shows no progress line, and a run in a status file that is not the board\'s shape shows none', async () => {
  const sent = board({ local: false, orders: [] })
  await flush()
  assert.doesNotMatch(sent.today(), /Picked up .* ago, running|steps/)
})
