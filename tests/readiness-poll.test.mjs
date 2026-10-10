// Keeping the Readiness screen current: a check every 60 seconds while somebody is looking, through
// the one-call "has anything changed?" answer, and lights that age on their own in between.
//
// The page is booted for real in the stand-in DOM, with its clock, its timers and its fetch handed
// in, so every minute here is a minute the test chose.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadPage, flush, script } from './helpers/page-harness.mjs'
import { basePayload } from './helpers/page-payload.mjs'
import { shapeReadiness } from '../api/readiness.js'

const NOW = Date.parse('2026-10-09T15:00:00Z')
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const NEWER = 'f0e1d2c3b4a5968778695a4b3c2d1e0f98765432'
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')
const walk = (node, found = []) => {
  found.push(node)
  for (const child of node.children ?? []) walk(child, found)
  return found
}
const withClass = (root, name) => walk(root).filter((node) => (node.className ?? '').split(/\s+/).includes(name))
const flat = (text) => text.replace(/\s+/g, ' ').trim()

const workflow = (patch = {}) => ({
  slug: 'daily-brief', name: 'Daily brief', owner: 'research', ownerSwitchedOff: false, schedule: 'daily 06:00',
  arm: 'armed', armed: true, reason: null, fire: false, webhook: false,
  lastRun: { started_at: iso(NOW - 3600_000), status: 'ok', summary: '', session_url: null },
  ...patch
})
// A board whose one card is GO now, fades at +10 minutes and goes silent at +40.
const boardAt = (commit, workflows = [workflow()], now = NOW) => ({
  ...basePayload(),
  commit,
  generatedAt: iso(now),
  readiness: shapeReadiness({ workflows, routines: { known: true, orphans: [] }, now })
})
const ageing = (commit = SHA) => {
  const payload = boardAt(commit)
  Object.assign(payload.readiness.cards[0], { fadesAt: iso(NOW + 10 * 60_000), silentAt: iso(NOW + 40 * 60_000), silentSentence: { text: 'Has not reported since {date}.', at: iso(NOW - 3600_000) } })
  return payload
}

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
    // Runs the one timer that is waiting, and lets whatever it started finish.
    async fire() {
      assert.equal(pending.size, 1, `${pending.size} timers are waiting, not one`)
      const [id, timer] = [...pending][0]
      pending.delete(id)
      await timer.fn()
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

// What the page asks for, and what the test answers, in order. A function answers /api/state with
// whatever it is handed; everything else (/api/brand) gets an empty object.
function board({ answers, hash = '#readiness', storage = {}, after = '', scrollY = 0 } = {}) {
  const timers = fakeTimers()
  const { clock, PinnedDate } = clockAt()
  const queue = [...answers]
  const page = loadPage({
    hash, storage, scrollY, timers, date: PinnedDate,
    after: `readinessClock.locale = 'en-US'; readinessClock.zone = 'UTC'; ${after}`,
    expose: ['readinessWatching', 'checkReadiness', 'data'],
    fetch: async (url) => {
      if (!String(url).startsWith('/api/state')) return { ok: true, status: 200, json: async () => ({}) }
      const answer = queue.length > 1 ? queue.shift() : queue[0]
      if (answer instanceof Error) throw answer
      return { ok: answer.status ? answer.status < 400 : true, status: answer.status ?? 200, json: async () => answer.body ?? answer }
    }
  })
  const stateRequests = () => page.requests.filter((request) => request.url.startsWith('/api/state'))
  return { page, timers, clock, stateRequests, readiness: () => page.node('readiness') }
}
const hashChange = async (page, hash) => {
  page.location.hash = hash
  for (const { type, handler } of page.windowListeners) if (type === 'hashchange') await handler()
  await flush()
}
const visibility = async (page, state) => {
  page.document.visibilityState = state
  for (const { type, handler } of page.documentListeners) if (type === 'visibilitychange') await handler()
  await flush()
}

/* ---------- when it watches ------------------------------------------------------------------- */

test('it watches while the Readiness screen is showing, the tab is in front, and the server named its commit', async () => {
  const { page, timers } = board({ answers: [ageing()] })
  await flush()
  assert.deepEqual(timers.delays(), [60_000])
  assert.equal(page.exposed.readinessWatching(), true)
})

test('it does not watch from another screen, on a hidden tab, or from a server that names no commit', async () => {
  for (const [label, options] of [
    ['another screen', { hash: '#today', answers: [ageing()] }],
    ['no hash at all', { hash: '', answers: [ageing()] }],
    ['a hidden tab', { answers: [ageing()], after: "document.visibilityState = 'hidden'" }],
    ['no commit', { answers: [ageing(null)] }],
    ['an old server', { answers: [{ ...basePayload(), generatedAt: iso(NOW) }] }]
  ]) {
    const { timers, stateRequests } = board(options)
    await flush()
    assert.equal(timers.pending.size, 0, `${label}: a timer is waiting`)
    assert.equal(stateRequests().length, 1, `${label}: more than the one load`)
  }
})

test('boot is untouched: the first request is the plain /api/state, with no since', async () => {
  const { stateRequests } = board({ answers: [ageing()] })
  await flush()
  assert.equal(stateRequests()[0].url, '/api/state')
  const boot = /async function boot\(\) \{([\s\S]*?)\n\}\n\nboot\(\)/.exec(script)[1]
  assert.ok(!/since|readiness|Readiness/.test(boot), 'boot() knows about the Readiness screen')
})

/* ---------- the check ------------------------------------------------------------------------- */

test('a check sends the commit it holds, and the view key, and nothing else', async () => {
  const { timers, stateRequests } = board({ answers: [ageing(), { unchanged: true, commit: SHA }], storage: { 'agent-cockpit-view-key': 'the-key' } })
  await flush()
  await timers.fire()
  assert.equal(stateRequests().length, 2)
  assert.equal(stateRequests()[1].url, `/api/state?since=${SHA}`)
  assert.equal(stateRequests()[1].init.headers['x-view-key'], 'the-key')
})

test('unchanged: no new board is drawn, the lights age by the clock, and the next check is a minute away', async () => {
  const { page, timers, clock, readiness } = board({ answers: [ageing(), { unchanged: true, commit: SHA }] })
  await flush()
  const todayBefore = page.node('today').innerHTML
  assert.equal(withClass(readiness(), 'rd-counters')[0].textContent, '0 NO GO · 0 SILENT · 1 GO')
  assert.equal(page.node('count-readiness').textContent, '')
  clock.now = NOW + 11 * 60_000
  await timers.fire()
  assert.equal(withClass(readiness(), 'rd-card')[0].className.includes('rd-faded'), true, 'the card did not fade')
  assert.match(withClass(readiness(), 'rd-note')[0].textContent, /1 faded/)
  assert.equal(page.node('today').innerHTML, todayBefore, 'another screen was redrawn for an unchanged answer')
  assert.deepEqual(timers.delays(), [60_000])
  clock.now = NOW + 41 * 60_000
  await timers.fire()
  assert.equal(withClass(readiness(), 'rd-counters')[0].textContent, '0 NO GO · 1 SILENT · 0 GO')
  assert.equal(page.node('count-readiness').textContent, '1', 'the tab badge did not follow the lights')
  assert.match(withClass(readiness(), 'rd-sentence')[0].textContent, /^Has not reported since /)
})

test('changed: the new board replaces the old, the reader keeps their place, and the next check asks about the new commit', async () => {
  const second = boardAt(NEWER, [workflow(), workflow({ slug: 'declared', name: 'Declared', arm: 'declared' })])
  const { page, timers, readiness, stateRequests } = board({ answers: [ageing(), second, { unchanged: true, commit: NEWER }], scrollY: 480 })
  await flush()
  assert.equal(withClass(readiness(), 'rd-card').length, 1)
  await timers.fire()
  assert.equal(withClass(readiness(), 'rd-card').length, 2)
  assert.equal(withClass(readiness(), 'rd-counters')[0].textContent, '1 NO GO · 0 SILENT · 1 GO')
  assert.equal(page.node('count-readiness').textContent, '1')
  assert.deepEqual(page.scrolls.at(-1), [0, 480])
  assert.deepEqual(timers.delays(), [60_000], 'one timer, not two')
  await timers.fire()
  assert.equal(stateRequests().at(-1).url, `/api/state?since=${NEWER}`)
})

test('a check that fails says so, keeps the lights as they were, and tries again', async () => {
  for (const failure of [{ status: 500, body: { error: 'no' } }, new TypeError('offline')]) {
    const { timers, readiness } = board({ answers: [ageing(), failure, { unchanged: true, commit: SHA }] })
    await flush()
    await timers.fire()
    assert.match(withClass(readiness(), 'rd-stamp')[0].textContent, /COULD NOT CHECK$/)
    assert.equal(withClass(readiness(), 'rd-card').length, 1)
    assert.deepEqual(timers.delays(), [60_000], 'it gave up')
    await timers.fire()
    assert.doesNotMatch(withClass(readiness(), 'rd-stamp')[0].textContent, /COULD NOT CHECK/)
  }
})

test('a refused check asks for the view key again and stops asking', async () => {
  const { page, timers } = board({ answers: [ageing(), { status: 401, body: { error: 'Missing or wrong view key.' } }], storage: { 'agent-cockpit-view-key': 'old-key' } })
  await flush()
  await timers.fire()
  assert.match(page.node('body').innerHTML, /Locked/)
  assert.equal(page.storage.getItem('agent-cockpit-view-key'), null)
  assert.equal(timers.pending.size, 0)
})

test('two checks never overlap', async () => {
  let release
  const slow = new Promise((resolve) => { release = resolve })
  const timers = fakeTimers()
  const { PinnedDate } = clockAt()
  let calls = 0
  const page = loadPage({
    hash: '#readiness', timers, date: PinnedDate, expose: ['checkReadiness'],
    after: "readinessClock.locale = 'en-US'; readinessClock.zone = 'UTC'",
    fetch: async (url) => {
      if (!String(url).startsWith('/api/state')) return { ok: true, status: 200, json: async () => ({}) }
      calls += 1
      if (calls === 1) return { ok: true, status: 200, json: async () => ageing() }
      await slow
      return { ok: true, status: 200, json: async () => ({ unchanged: true, commit: SHA }) }
    }
  })
  await flush()
  const first = page.exposed.checkReadiness()
  const second = page.exposed.checkReadiness()
  await flush()
  assert.equal(calls, 2, 'a second check was sent while the first was out')
  release()
  await Promise.all([first, second])
})

/* ---------- only while somebody is looking ------------------------------------------------------ */

test('leaving the screen stops the checks; coming back checks at once, then every minute', async () => {
  const { page, timers, stateRequests } = board({ answers: [ageing(), { unchanged: true, commit: SHA }] })
  await flush()
  assert.equal(timers.pending.size, 1)
  await hashChange(page, '#today')
  assert.equal(timers.pending.size, 0, 'a check is still waiting on a screen that is not showing')
  await hashChange(page, '#readiness')
  assert.deepEqual(timers.delays(), [0])
  await timers.fire()
  assert.equal(stateRequests().length, 2)
  assert.deepEqual(timers.delays(), [60_000])
})

test('a hidden tab stops the checks; a visible one checks at once', async () => {
  const { page, timers, stateRequests } = board({ answers: [ageing(), { unchanged: true, commit: SHA }] })
  await flush()
  await visibility(page, 'hidden')
  assert.equal(timers.pending.size, 0)
  assert.equal(stateRequests().length, 1)
  await visibility(page, 'visible')
  assert.deepEqual(timers.delays(), [0])
  await timers.fire()
  assert.equal(stateRequests().length, 2)
})

test('opening another screen never starts anything', async () => {
  const { page, timers, stateRequests } = board({ hash: '#today', answers: [ageing()] })
  await flush()
  await hashChange(page, '#workflows')
  await visibility(page, 'hidden')
  await visibility(page, 'visible')
  assert.equal(timers.pending.size, 0)
  assert.equal(stateRequests().length, 1)
})

/* ---------- the stamp and the button ------------------------------------------------------------ */

test('the stamp says how it is kept current, and when the board was last checked', async () => {
  const { timers, clock, readiness } = board({ answers: [ageing(), { unchanged: true, commit: SHA }] })
  await flush()
  assert.match(flat(withClass(readiness(), 'rd-stamp')[0].textContent), /^JOBS CHECKED NEVER · BOARD READ 3:00 PM · REFRESH 60 s auto$/)
  clock.now = NOW + 5 * 60_000
  await timers.fire()
  assert.equal(flat(withClass(readiness(), 'rd-stamp')[0].textContent), 'JOBS CHECKED NEVER · BOARD READ 3:00 PM · CHECKED 3:05 PM · REFRESH 60 s auto')
  const old = board({ answers: [ageing(null)] })
  await flush()
  assert.match(flat(withClass(old.readiness(), 'rd-stamp')[0].textContent), /REFRESH BY BUTTON$/)
})

test('Refresh is the same check: one small request when the commit is known, a full load when it is not', async () => {
  const withCommit = board({ answers: [ageing(), { unchanged: true, commit: SHA }] })
  await flush()
  withClass(withCommit.readiness(), 'rd-refresh')[0].listeners.click[0]()
  await flush()
  assert.deepEqual(withCommit.stateRequests().map((request) => request.url), ['/api/state', `/api/state?since=${SHA}`])
  assert.match(withClass(withCommit.readiness(), 'rd-stamp')[0].textContent, /CHECKED/)
  const without = board({ answers: [ageing(null), ageing(null)] })
  await flush()
  withClass(without.readiness(), 'rd-refresh')[0].listeners.click[0]()
  await flush()
  assert.deepEqual(without.stateRequests().map((request) => request.url), ['/api/state', '/api/state'])
})

test('the checking is its own code: it sits beside the Readiness screen and nowhere else in the page', () => {
  const block = script.slice(script.indexOf('/* ---------- Readiness: begin'), script.indexOf('/* ---------- Readiness: end ---------- */'))
  for (const name of ['READINESS_POLL_MS', 'readinessWatching', 'checkReadiness', 'readinessSync']) assert.ok(block.includes(name), `${name} is not in the Readiness block`)
  const elsewhere = script.replace(block, '')
  assert.ok(!/READINESS_POLL_MS|checkReadiness|readinessSync/.test(elsewhere), 'the polling leaked out of its block')
  assert.match(block, /const READINESS_POLL_MS = 60_000/)
})
