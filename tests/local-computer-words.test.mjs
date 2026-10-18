// "On my computer" board: no sentence on it talks about "your Mac". A student on Windows (or any computer) reads
// "this computer", and "it starts in a moment" (the board's own runner is kicked at once - local/runner.mjs
// kickAfterOrders). The website board, which really does send orders to the owner's Mac, says what it always said.
// Also: the progress line names what is being done in plain words, not the tool's code name (both boards).

import test from 'node:test'
import assert from 'node:assert/strict'
import { loadPage, flush } from './helpers/page-harness.mjs'
import { basePayload } from './helpers/page-payload.mjs'
import { macOrderSaid, jobStatusAnswer, orderOutcome, instructionsFor, MAILBOX_ORDERS_OFF } from '../api/_voice.js'
import { ordersConfig, ordersView } from '../api/_orders.js'
import { localizeSentence } from '../local/localize.mjs'

const MAC = /\bMac\b/
const NOW = Date.parse('2026-10-18T10:00:00Z')
const ID = '0f1e2d3c4b5a69788796a5b4c3d2e1f0'
const STORE = 'agent-cockpit-mac-orders'
const ZONE = 'UTC'
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')
const reply = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, type: 'basic', headers: { get: () => null }, json: async () => body })

const remembered = (patch = {}) => ({ via: 'mac', id: ID, kind: 'run', label: 'Run monday-brief', sentAt: iso(NOW - 60_000), expiresAt: iso(NOW + 15 * 60_000), pollSeconds: 300, ...patch })
const entry = (patch = {}) => ({ id: ID, action: 'run', state: 'claimed', at: iso(NOW - 50_000), startedAt: null, finishedAt: null, commit: null, why: null, landed: null, ...patch })
const withOrders = (orders, name) => ({
  ...basePayload(),
  mailbox: { status: 'ok', computers: [{ computer: name, runner: 'r', takenAt: iso(NOW), allows: { actions: ['run', 'task'], jobs: ['monday-brief'] }, orders, hidden: 0 }] }
})

function pinnedDate() {
  return class PinnedDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(NOW) }
    static now() { return NOW }
  }
}

// Today, drawn for one remembered order and what the computer's status file says of it.
async function today({ local, log = [remembered()], orders = [], name = local ? 'This computer' : 'My Mac' }) {
  const page = loadPage({
    date: pinnedDate(),
    storage: { [STORE]: JSON.stringify(log) },
    windowExtras: local ? { __BOARD_LOCAL__: true } : {},
    fetch: async (url) => reply(200, url.startsWith('/api/state') ? withOrders(orders, name) : {})
  })
  await flush()
  return page.node('today').innerHTML
}

// Every state the card can be in: [name, remembered order, status-file entries].
const STATES = [
  ['sent', remembered(), []],
  ['sent task', remembered({ kind: 'task', label: 'Add a card' }), []],
  ['waiting', remembered({ sentAt: iso(NOW - 20 * 60_000), expiresAt: iso(NOW + 5 * 60_000) }), []],
  ['expired', remembered({ sentAt: iso(NOW - 30 * 60_000), expiresAt: iso(NOW - 60_000) }), []],
  ['picked up', remembered(), [entry({ state: 'claimed' })]],
  ['running', remembered(), [entry({ state: 'running', startedAt: iso(NOW - 40_000) })]],
  ['refused', remembered(), [entry({ state: 'refused', why: 'expired' })]],
  ['refused, no reason', remembered(), [entry({ state: 'refused', why: null })]],
  ['failed', remembered(), [entry({ state: 'failed', why: 'timed-out' })]],
  ['lost track', remembered(), [entry({ state: 'unknown', landed: null })]],
  ['done', remembered(), [entry({ state: 'ok', startedAt: iso(NOW - 40_000), finishedAt: iso(NOW - 10_000) })]]
]

/* ---------- Today's card ---------- */

test('local: the Today card is titled "This computer" and no state of an order says "Mac"', async () => {
  for (const [label, order, orders] of STATES) {
    const html = await today({ local: true, log: [order], orders })
    assert.match(html, /<h2>This computer<\/h2>/, label)
    assert.doesNotMatch(html, MAC, `${label}: ${html.match(/.{0,60}\bMac\b.{0,60}/)?.[0]}`)
    assert.match(html, /Run monday-brief|Add a card/, `${label}: the order is on the card`)
  }
})

test('local: a sent order says it starts in a moment - not that the Mac checks every 5 minutes', async () => {
  const html = await today({ local: true })
  assert.match(html, /Sent to this computer\. It starts in a moment\./)
  assert.doesNotMatch(html, /5 minutes/)
})

test('local: an order that was not picked up in time says so in plain words', async () => {
  const waiting = await today({ local: true, log: [STATES[2][1]] })
  assert.match(waiting, /This computer has not started it yet\. It may be busy with another job\. If it has not started by .*, it will not run at all\./)
  const expired = await today({ local: true, log: [STATES[3][1]] })
  assert.match(expired, /It expired before this computer picked it up, so nothing ran\./)
})

test('local: what the computer did, in "this computer" words', async () => {
  const said = async (index) => today({ local: true, log: [STATES[index][1]], orders: STATES[index][2] })
  assert.match(await said(4), /This computer picked it up at/)
  assert.match(await said(5), /This computer picked it up at .* and is running it\./)
  assert.match(await said(6), /This computer refused it: it expired before this computer picked it up\./)
  assert.match(await said(8), /This computer tried and it failed: it ran past its time limit\. Nothing changed on the board\./)
  assert.match(await said(9), /This computer lost track of this one part-way\./)
  assert.match(await said(10), /This computer finished it at/)
})

test('website: the card is "Your Mac" and every sentence is what it was', async () => {
  const sent = await today({ local: false })
  assert.match(sent, /<h2>Your Mac<\/h2>/)
  assert.match(sent, /Sent to your Mac\. It checks every 5 minutes\./)
  const said = async (index) => today({ local: false, log: [STATES[index][1]], orders: STATES[index][2] })
  assert.match(await said(2), /Your Mac has not picked it up yet\. It may be asleep or offline\. If it has not started by .*, it will not run at all\./)
  assert.match(await said(3), /It expired before your Mac picked it up, so nothing ran\./)
  assert.match(await said(4), /Your Mac picked it up at/)
  assert.match(await said(6), /Your Mac refused it: it expired before your Mac picked it up\./)
  assert.match(await said(8), /Your Mac tried and it failed: it ran past its time limit\. Nothing changed on the board\./)
  assert.match(await said(10), /Your Mac finished it at/)
})

/* ---------- the button notes, and the Codex button ---------- */

const payload = (extra = {}) => ({ ok: true, accepted: true, via: 'mac', orderId: ID, expiresAt: iso(NOW + 17 * 60_000), pollSeconds: 300, ...extra })

async function notes(local) {
  const page = loadPage({
    expose: ['macSentWords'],
    windowExtras: local ? { __BOARD_LOCAL__: true } : {},
    fetch: async (url) => reply(200, url.startsWith('/api/state') ? basePayload() : {})
  })
  await flush()
  return Object.fromEntries(['run', 'pause', 'task', 'move', 'approve', 'arm', 'skill', 'agent'].map((kind) => [kind, page.exposed.macSentWords(kind, payload())]))
}

test('local: every button note says "this computer" and does not promise a 5 minute wait', async () => {
  const said = await notes(true)
  for (const [kind, words] of Object.entries(said)) {
    assert.doesNotMatch(words, MAC, kind)
    assert.doesNotMatch(words, /minutes/, kind)
    assert.match(words, /^Sent to this computer\. /, kind)
  }
  assert.equal(said.run, 'Sent to this computer. It starts in a moment.')
  assert.equal(said.approve, 'Sent to this computer. Nothing has been switched on.')
  assert.equal(said.arm, 'Sent to this computer. It will file a card for you to finish in a Claude session.')
})

test('website: every button note is word for word what it was', async () => {
  const said = await notes(false)
  assert.equal(said.run, 'Sent to your Mac. It should start within about 5 minutes.')
  assert.equal(said.pause, 'Sent to your Mac. It switches the schedule off in the workflow file within about 5 minutes.')
  assert.equal(said.task, 'Sent to your Mac. It checks every 5 minutes, so the card should be on the board in about 6 minutes.')
  assert.equal(said.move, 'Sent to your Mac. It lands in about 6 minutes.')
  assert.equal(said.approve, 'Sent to your Mac. Nothing has been switched on.')
  assert.equal(said.skill, 'Sent to your Mac. It will file a card for you to finish in a Claude session.')
})

const flow = (slug, name) => ({
  slug, path: `workflows/${slug}.yml`, name, owner: 'research', steps: ['scan'], runner: 'routine', schedule: 'daily 06:30',
  armed: false, arm: 'off', reason: null, routineId: null, fire: true, webhook: false, output: 'inbox/x.md', problems: [],
  lastRun: null, nextRun: null, state: 'never-run'
})

test('a Codex job whose Codex is not ready: "this computer" on the local board, "your Mac" on the website', async () => {
  const box = { status: 'ok', why: null, read: 1, skipped: 0, unreadable: 0, notShown: 0, computers: [{ computer: 'X', runner: 'x', takenAt: iso(NOW), allows: { actions: ['task', 'run'], jobs: ['task-sweep'], workers: ['claude'], codexJobs: ['task-sweep'] }, orders: [], hidden: 0 }] }
  for (const local of [true, false]) {
    const page = loadPage({
      windowExtras: local ? { __BOARD_LOCAL__: true } : {},
      fetch: async (url) => reply(200, url.startsWith('/api/state') ? { ...basePayload(), workflows: [flow('task-sweep', 'Task sweep')], mailbox: box } : {})
    })
    await flush()
    const markup = page.node('today').innerHTML
    assert.match(markup, local ? /Codex is not ready on this computer/ : /Codex is not ready on your Mac/)
    if (local) assert.doesNotMatch(markup, MAC)
  }
})

/* ---------- voice: the lines the page builds ---------- */

test('local: the voice cards and notes say "this computer"; the website\'s are as they were', async () => {
  const read = async (local) => {
    const page = loadPage({
      expose: ['VOICE_ORDER', 'macOutcomeWords'],
      windowExtras: local ? { __BOARD_LOCAL__: true } : {},
      fetch: async (url) => reply(200, url.startsWith('/api/state') ? basePayload() : {})
    })
    await flush()
    const { VOICE_ORDER: words, macOutcomeWords } = page.exposed
    return {
      taskWhat: words.taskWhatMac,
      runWhat: words.runWhatMac,
      sentTask: words.sentTaskMac(5),
      sentRun: words.sentRunMac('morning-intel', 5),
      shownTask: macOutcomeWords({ kind: 'task', title: 'Draft it' }, 5),
      shownRun: macOutcomeWords({ kind: 'run', name: 'Morning intel' }, 5)
    }
  }
  const local = await read(true)
  for (const words of Object.values(local)) assert.doesNotMatch(words, MAC)
  assert.equal(local.taskWhat, 'A task card goes to this computer, which files it for your team. It shows on the board soon after you say yes.')
  assert.equal(local.runWhat, 'This computer runs this job on your own Claude plan, a moment after you say yes.')
  assert.equal(local.sentTask, 'The owner said yes. It was sent to this computer, which starts it in a moment: the card should be on the board soon. It is not done yet.')
  assert.equal(local.sentRun, 'The owner said yes. The job morning-intel was sent to this computer, which starts it in a moment. It has not started yet.')
  assert.equal(local.shownTask, 'Sent to this computer: "Draft it". It starts in a moment, and the card should be on the board soon.')
  assert.equal(local.shownRun, 'Sent to this computer: Morning intel. It starts in a moment.')
  const site = await read(false)
  assert.equal(site.taskWhat, 'A task card goes to your Mac, which files it for your team. It shows on the board a few minutes after you say yes.')
  assert.equal(site.runWhat, 'Your Mac runs this job on your own Claude plan, a few minutes after you say yes.')
  assert.equal(site.sentTask, 'The owner said yes. It was sent to their Mac, which checks every 5 minutes: the card should be on the board in about 6 minutes. It is not done yet.')
  assert.equal(site.sentRun, 'The owner said yes. The job morning-intel was sent to their Mac, which checks every 5 minutes: it should start within about 5 minutes. It has not started yet.')
  assert.equal(site.shownTask, 'Sent to your Mac: "Draft it". It checks every 5 minutes, so the card should be on the board in about 6 minutes.')
  assert.equal(site.shownRun, 'Sent to your Mac: Morning intel. It should start within about 5 minutes.')
})

/* ---------- voice: the lines the server and the shared block build ---------- */

const sentOrder = (patch = {}) => ({ kind: 'run', slug: 'morning-intel', name: 'Morning intel', sentAt: iso(NOW - 60_000), via: 'mac', id: ID, expiresAt: iso(NOW + 17 * 60_000), pollSeconds: 300, ...patch })
const board = (entries = []) => ({
  runs: [], board: { todo: [], done: [], running: [], finishedTasks: [] }, workflows: [{ slug: 'morning-intel', name: 'Morning intel' }],
  mailbox: { status: entries.length ? 'ok' : 'none', computers: entries.length ? [{ computer: 'This computer', runner: 'this-computer', takenAt: iso(NOW), allows: { actions: ['task', 'run'], jobs: ['morning-intel'] }, orders: entries, hidden: 0 }] : [] }
})

test('local: "is it done?" never says Mac, in any state', () => {
  const orders = [...STATES.map(([name, one, list]) => [name, { ...sentOrder(), ...one, name: 'Morning intel', slug: 'morning-intel' }, list]), ['task', sentOrder({ kind: 'task', title: 'Draft it' }), []]]
  for (const [label, order, entries] of orders) {
    const answer = jobStatusAnswer({ which: 'last order' }, { data: board(entries), now: NOW, timeZone: ZONE, log: [order], fresh: true, local: true })
    assert.doesNotMatch(JSON.stringify(answer), MAC, label)
  }
  const sent = jobStatusAnswer({ which: 'last order' }, { data: board(), now: NOW, timeZone: ZONE, log: [sentOrder()], fresh: true, local: true })
  assert.equal(sent.state, 'sent to this computer')
  assert.equal(sent.said, 'Sent to this computer. It starts in a moment.')
})

test('website: "is it done?" is word for word what it was', () => {
  const sent = jobStatusAnswer({ which: 'last order' }, { data: board(), now: NOW, timeZone: ZONE, log: [sentOrder()], fresh: true })
  assert.equal(sent.state, 'sent to your Mac')
  assert.equal(sent.said, 'Sent to your Mac. It checks every 5 minutes, so it should start within about 5 minutes.')
  assert.deepEqual(macOrderSaid(sentOrder(), board(), NOW, ZONE, false), macOrderSaid(sentOrder(), board(), NOW, ZONE))
})

test('local: the voice is told an order ended without the word Mac', () => {
  for (const entries of [[entry({ state: 'refused', why: 'expired' })], [entry({ state: 'failed', why: 'timed-out' })], [entry({ state: 'unknown' })]]) {
    const ended = orderOutcome(sentOrder(), board(entries), NOW, ZONE, [], true)
    assert.ok(ended, 'an ended order')
    assert.doesNotMatch(JSON.stringify(ended), MAC)
  }
  assert.match(orderOutcome(sentOrder(), board([entry({ state: 'refused', why: 'expired' })]), NOW, ZONE).summary, /Your Mac refused it/)
})

test('local: what the voice model is told about orders says "this computer"; the website\'s is as it was', () => {
  const orders = { on: true, tasks: true, jobs: ['morning-intel'], key: 'fire-key', via: 'mac' }
  const site = instructionsFor('Jarvis', null, orders)
  assert.match(site, /Orders on this board go to the owner's Mac, which checks for orders every few minutes/)
  assert.match(site, /Only the jobs in its list run on the owner's Mac\./)
  const local = instructionsFor('Jarvis', null, { ...orders, local: true })
  assert.doesNotMatch(local, MAC)
  assert.match(local, /Orders on this board run on this computer, which starts them at once: a sent order is not done yet\./)
  assert.match(local, /Only the jobs in its list run on this computer\./)
  const noTasks = instructionsFor('Jarvis', null, { ...orders, tasks: false, jobs: [], local: true })
  assert.doesNotMatch(noTasks, MAC)
  assert.match(noTasks, /this computer does not take task cards/)
  assert.match(noTasks, /this computer has not listed any job it will run/)
})

test('the board marks its orders local only when the runner is the one on this computer', () => {
  // Made-up values, put together at runtime so nothing here looks like a real secret to a scanner.
  const env = (runner) => ({
    FIRE_MODE: 'mailbox',
    FIRE_KEY: ['fk', 'mailbox', 'long', 'enough', 'passphrase'].join('-'),
    MAILBOX_SECRET: ['test', 'only', 'mailbox', 'signing', 'value', '0123456789'].join('-'),
    MAILBOX_KEY: ['test', 'only', 'mailbox', 'poll', 'value', 'abcdefghij'].join('-'),
    MAILBOX_RUNNER: runner,
    GITHUB_OWNER: 'ExampleOwner',
    GITHUB_REPO: 'example-team',
    GITHUB_TOKEN: 'ghp_fakeTokenForTheLocalWordsSuite',
    BLOB_STORE_ID: 'store_fake'
  })
  const mac = { allows: { actions: ['task', 'run'], jobs: ['morning-intel'] } }
  const here = ordersConfig(env('this-computer'), mac)
  assert.equal(here.on, true, JSON.stringify(here))
  assert.equal(here.local, true)
  const there = ordersConfig(env('mac-mini'), mac)
  assert.equal(there.on, true, JSON.stringify(there))
  assert.equal(Object.hasOwn(there, 'local'), false)
  assert.equal(there.via, 'mac')
  assert.equal(ordersView(here).local, true)
  assert.equal(Object.hasOwn(ordersView(there), 'local'), false)
})

test('the sentences the server sends a local board talk about this computer', () => {
  const full = '10 orders are already waiting for your Mac, so nothing was sent: check that your Mac is on and awake, then try again.'
  assert.doesNotMatch(localizeSentence(MAILBOX_ORDERS_OFF), MAC)
  assert.doesNotMatch(localizeSentence(full), MAC)
  assert.match(localizeSentence(full), /^10 orders are already waiting/)
  assert.doesNotMatch(localizeSentence('Codex is not ready on your Mac, so that job cannot be started from here.'), MAC)
  assert.equal(localizeSentence('Two things are due today.'), 'Two things are due today.')
})

/* ---------- the progress line: what is being done, in plain words (both boards) ---------- */

const doc = (patch = {}) => ({ phase: 'working', steps: 7, lastTool: 'Edit', startedAt: iso(NOW - 125_000), lastEventAt: iso(NOW - 2000), final: false, ...patch })

test('the tool names become plain words', async () => {
  const page = loadPage({ expose: ['progressToolWords'], fetch: async (url) => reply(200, url.startsWith('/api/state') ? basePayload() : {}) })
  await flush()
  const words = page.exposed.progressToolWords
  const cases = {
    Read: 'reading files', NotebookRead: 'reading files',
    Edit: 'editing a file', Write: 'editing a file', MultiEdit: 'editing a file', NotebookEdit: 'editing a file', apply_patch: 'editing a file',
    Bash: 'running a command', Shell: 'running a command', shell: 'running a command', PowerShell: 'running a command',
    Plan: 'planning', ExitPlanMode: 'planning', EnterPlanMode: 'planning',
    Grep: 'searching', Glob: 'searching',
    WebFetch: 'looking something up', WebSearch: 'looking something up',
    TodoWrite: 'working', Task: 'working', mcp__thing__go: 'working', unknown: 'working', '': 'working'
  }
  for (const [tool, want] of Object.entries(cases)) assert.equal(words(tool), want, tool)
})

test('the progress line reads like "Working · 7 steps so far · editing a file · 2m 05s", on the local board', async () => {
  const page = loadPage({
    date: pinnedDate(),
    storage: { [STORE]: JSON.stringify([remembered({ sentAt: iso(NOW - 150_000) })]) },
    windowExtras: { __BOARD_LOCAL__: true },
    fetch: async (url) => {
      if (url.startsWith('/api/progress')) return reply(200, doc())
      return reply(200, url.startsWith('/api/state') ? withOrders([entry()], 'This computer') : {})
    }
  })
  await flush()
  const line = page.node(`mac-prog-${ID}`).innerHTML
  assert.equal(line, `<b>Working</b> · 7 steps so far · editing a file · <span id="mac-clock-${ID}">2m 05s</span>`)
  assert.doesNotMatch(line, /last used|Edit\b/)
})

test('a tool name that is markup is shown as plain "working", never as markup', async () => {
  const page = loadPage({
    date: pinnedDate(),
    storage: { [STORE]: JSON.stringify([remembered()]) },
    windowExtras: { __BOARD_LOCAL__: true },
    fetch: async (url) => {
      if (url.startsWith('/api/progress')) return reply(200, doc({ lastTool: '<img src=x onerror=alert(1)>' }))
      return reply(200, url.startsWith('/api/state') ? withOrders([entry()], 'This computer') : {})
    }
  })
  await flush()
  const line = page.node(`mac-prog-${ID}`).innerHTML
  assert.doesNotMatch(line, /onerror|<img/)
  assert.match(line, /7 steps so far · working · /)
})
