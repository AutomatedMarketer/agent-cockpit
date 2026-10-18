// What the board and the voice say about an order sent to the owner's Mac (plan 2026-10-12-mac-mailbox,
// task C7): sent, waiting, picked up, running, done, refused, failed, outcome unknown and expired. "Is
// it done?" reads the Mac's status file first, then the card or the run as before. Every sentence is
// the board's own: an id, a time and a fixed reason - never words that came from the repo.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { jobStatusAnswer, sessionFor, voiceConfig, MAC_REASON_WORDS, macOrderSaid } from '../api/_voice.js'
import { MAILBOX_CONTRACT } from '../api/_mailbox.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/mailbox-parity.json', import.meta.url), 'utf8'))
const ZONE = 'America/New_York'
const SENT = Date.parse('2026-10-12T14:00:00.000Z')
const ID = '0f1e2d3c4b5a69788796a5b4c3d2e1f0'
const at = (minutes) => new Date(SENT + minutes * 60_000).toISOString().replace(/\.\d+Z$/, 'Z')
const clock = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: ZONE, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
const taskOrder = { kind: 'task', title: 'Chase the invoice', sentAt: new Date(SENT).toISOString(), via: 'mac', id: ID, expiresAt: new Date(SENT + 17 * 60_000).toISOString(), pollSeconds: 300 }
const runOrder = { kind: 'run', slug: 'morning-intel', name: 'Morning intel', sentAt: new Date(SENT).toISOString(), via: 'mac', id: ID, expiresAt: new Date(SENT + 17 * 60_000).toISOString(), pollSeconds: 300 }
const entry = (state, over = {}) => ({ id: ID, action: 'task', state, at: at(1), startedAt: null, finishedAt: null, commit: null, why: null, landed: null, ...over })
const board = (entries = [], extra = {}) => ({
  runs: [],
  board: { todo: [], done: [], running: [], finishedTasks: [] },
  workflows: [{ slug: 'morning-intel', name: 'Morning intel' }],
  mailbox: { status: entries.length ? 'ok' : 'none', computers: entries.length ? [{ computer: 'Mac Mini', runner: 'mac-mini', takenAt: at(2), allows: { actions: ['task', 'run'], jobs: ['morning-intel'] }, orders: entries, hidden: 0 }] : [] },
  ...extra
})
const ask = (order, data, minutes) => jobStatusAnswer({ which: 'last order' }, { data, now: SENT + minutes * 60_000, timeZone: ZONE, log: [order], fresh: true })

test('the reasons the Mac gives are said in the contract\'s own words, both kinds', () => {
  // The contract's words, plus the Codex worker's two (status.workers.reasons). One sentence is the board's own: the
  // contract's tool-refused names Claude, and a tool may be refused to Codex too, so the board names neither.
  const expected = {}
  for (const state of ['refused', 'failed']) expected[state] = { ...fixture.status.reasons[state], ...fixture.status.workers.reasons[state] }
  expected.failed['tool-refused'] = 'it tried a tool it may not use'
  assert.deepEqual(MAC_REASON_WORDS, expected)
  assert.deepEqual(MAILBOX_CONTRACT.status.reasons, fixture.status.reasons)
})

test('sent, then waiting after three of its checks, then expired - while the Mac\'s file has nothing for it', () => {
  const sent = ask(taskOrder, board(), 2)
  assert.equal(sent.state, 'sent to your Mac')
  assert.equal(sent.said, 'Sent to your Mac. It checks every 5 minutes, so the card should be on the board in about 6 minutes.')
  assert.equal(sent.title, 'Chase the invoice')
  const run = ask(runOrder, board(), 2)
  assert.equal(run.said, 'Sent to your Mac. It checks every 5 minutes, so it should start within about 5 minutes.')
  const waiting = ask(taskOrder, board(), 16)
  assert.equal(waiting.state, 'waiting for your Mac')
  assert.equal(waiting.said, `Your Mac has not picked it up yet. It may be asleep or offline. If it has not started by ${clock(taskOrder.expiresAt)}, it will not run at all.`)
  assert.equal(ask(taskOrder, board(), 15).state, 'sent to your Mac', 'three checks are 15 minutes at this pace')
  const expired = ask(taskOrder, board(), 17)
  assert.equal(expired.state, 'expired')
  assert.equal(expired.said, 'It expired before your Mac picked it up, so nothing ran.')
  // At the one-minute pace: about two minutes for a card, and "a minute" for a run.
  assert.equal(ask({ ...taskOrder, pollSeconds: 60 }, board(), 0.5).said, 'Sent to your Mac. It checks every minute, so the card should be on the board in about 2 minutes.')
  assert.equal(ask({ ...runOrder, pollSeconds: 60 }, board(), 0.5).said, 'Sent to your Mac. It checks every minute, so it should start within about a minute.')
})

test('picked up, running, refused, failed and outcome unknown: from the Mac\'s file, in the board\'s own words', () => {
  assert.deepEqual(macPart(ask(taskOrder, board([entry('claimed')]), 3)), { state: 'picked up by your Mac', said: `Your Mac picked it up at ${clock(at(1))}.` })
  assert.deepEqual(macPart(ask(runOrder, board([entry('running', { action: 'run', startedAt: at(1) })]), 3)), { state: 'running on your Mac', said: `Your Mac picked it up at ${clock(at(1))} and is running it.` })
  assert.deepEqual(macPart(ask(runOrder, board([entry('refused', { action: 'run', why: 'job-not-allowed' })]), 3)), { state: 'refused by your Mac', said: 'Your Mac refused it: that job is not on its list.' })
  assert.deepEqual(macPart(ask(taskOrder, board([entry('failed', { why: 'push-failed' })]), 3)), { state: 'failed on your Mac', said: 'Your Mac tried and it failed: the change could not be pushed. Nothing changed on the board.' })
  const lost = 'Your Mac lost track of this one part-way. It will not run it again by itself.'
  assert.equal(ask(taskOrder, board([entry('unknown', { landed: true, commit: '3b717814fb34' })]), 3).said, `${lost} Checked afterwards: the change is on the board.`)
  assert.equal(ask(taskOrder, board([entry('unknown', { landed: false })]), 3).said, `${lost} Checked afterwards: the change is not on the board.`)
  assert.equal(ask(taskOrder, board([entry('unknown')]), 3).said, `${lost} It has not checked yet whether the change landed.`)
  assert.equal(ask(taskOrder, board([entry('unknown')]), 3).state, 'outcome unknown')
  // A "landed" that is not true, false or null is not a check anybody made.
  assert.equal(ask(taskOrder, board([entry('unknown', { landed: 'yes' })]), 3).said, `${lost} It has not checked yet whether the change landed.`)
  // Matched by id: another order's entry is not this one's.
  const other = entry('refused', { id: 'ab'.repeat(16), why: 'daily-limit' })
  assert.equal(ask(taskOrder, board([other, entry('claimed')]), 3).state, 'picked up by your Mac')
  // The Mac's file first: a run log after the order (the job's own schedule, say) is not this order's
  // run when the Mac refused it, and an older card with the same title is not this order's card.
  const refusedRun = board([entry('refused', { action: 'run', why: 'job-not-allowed' })], { runs: [{ workflow: 'morning-intel', started_at: at(1), finished_at: at(2), status: 'ok', summary: 'Cloud run.' }] })
  assert.equal(ask(runOrder, refusedRun, 3).state, 'refused by your Mac')
  const refusedTask = board([entry('refused', { why: 'daily-limit' })], { board: { todo: [{ title: 'Chase the invoice', doing: false }], done: [], running: [], finishedTasks: [] } })
  assert.equal(ask(taskOrder, refusedTask, 3).state, 'refused by your Mac')
  // Even past its expiry, what the Mac said wins: it picked it up in time.
  assert.equal(ask(taskOrder, board([entry('claimed')]), 40).state, 'picked up by your Mac')
})

test('done on the Mac: the card or the run as before, and until the board shows it, that it is on its way', () => {
  const ok = entry('ok', { commit: '3b717814fb34', finishedAt: at(2) })
  const onBoard = ask(taskOrder, board([ok], { board: { todo: [{ title: 'Chase the invoice', doing: false }], done: [], running: [], finishedTasks: [] } }), 4)
  assert.equal(onBoard.state, 'to do')
  assert.equal(onBoard.said, undefined)
  const notYet = ask(taskOrder, board([ok]), 4)
  assert.equal(notYet.state, 'done on your Mac')
  assert.equal(notYet.said, `Your Mac finished it at ${clock(at(2))}. It shows on the board after the next refresh.`)
  const ran = ask(runOrder, board([{ ...ok, action: 'run' }], { runs: [{ workflow: 'morning-intel', started_at: at(1), finished_at: at(2), status: 'ok', summary: 'Wrote the brief.' }] }), 4)
  assert.equal(ran.state, 'finished')
})

test('an order sent through the cloud is answered exactly as before', () => {
  const cloud = { kind: 'task', title: 'Chase the invoice', sentAt: new Date(SENT).toISOString() }
  assert.equal(ask(cloud, board([entry('refused', { why: 'expired' })]), 3).state, 'not filed yet')
  assert.equal(macOrderSaid(cloud, board(), SENT, ZONE), null)
})

test('an id, a pace or a time that is not the board\'s own shape is never trusted: no Mac answer for it', () => {
  for (const odd of [{ id: 'Chase the invoice' }, { id: ID.toUpperCase() }, { expiresAt: 'soon' }, { via: 'cloud' }]) {
    assert.equal(macOrderSaid({ ...taskOrder, ...odd }, board([entry('claimed')]), SENT + 60_000, ZONE), null, JSON.stringify(odd))
  }
  // An odd pace is read as the default ten minutes, never as a number it was not.
  for (const pollSeconds of [5, 99999, '300', null]) {
    assert.match(macOrderSaid({ ...taskOrder, pollSeconds }, board(), SENT + 60_000, ZONE).said, /checks every 10 minutes/, String(pollSeconds))
  }
})

test('a call on a mailbox board is told the orders go to the owner\'s Mac - never about a task-intake routine or trigger links', () => {
  const config = voiceConfig({ OPENAI_API_KEY: 'sk-fake' })
  const orders = { on: true, tasks: true, jobs: ['morning-intel'], key: 'fire-key', spokenYes: true, jev: false, via: 'mac' }
  const words = (given) => sessionFor(config, 'Penny', { orders: given }).instructions
  assert.match(words(orders), /owner's Mac/)
  assert.match(words(orders), /checks for orders every few minutes/)
  for (const given of [orders, { ...orders, tasks: false }, { ...orders, jobs: [] }]) {
    assert.doesNotMatch(words(given), /task-intake routine|trigger link/i)
  }
  assert.match(words({ ...orders, tasks: false }), /the owner's Mac does not take task cards/)
  assert.match(words({ ...orders, jobs: [] }), /the owner's Mac has not listed any job it will run/)
})

function macPart(answer) {
  return { state: answer.state, said: answer.said }
}
