// The Readiness wall's "Mac mailbox" light (plan 2026-10-12-mac-mailbox, task C8): one card per computer
// that reports on its orders. NO GO when an order failed, or was lost part-way and did not land, in the
// last 24 hours; SILENT when the computer has not reported on an order for a day; GO otherwise. From the
// Mac's status file as the board shaped it (data.mailbox) - ids, states and times only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { shapeReadiness, READINESS_WORDS, MAILBOX_SILENT_HOURS } from '../api/_readiness.js'

const NOW = Date.parse('2026-10-12T15:00:00Z')
const iso = (hoursAgo) => new Date(NOW - hoursAgo * 3600_000).toISOString().replace(/\.\d+Z$/, 'Z')
const order = (state, hoursAgo, over = {}) => ({ id: `${state}${hoursAgo}`.padEnd(32, '0').replace(/[^0-9a-f]/g, 'a').slice(0, 32), action: 'task', state, at: iso(hoursAgo), startedAt: null, finishedAt: null, commit: null, why: null, landed: null, ...over })
const mailbox = (orders, takenHoursAgo = 0.5, computer = 'Mac Mini') => ({
  status: 'ok',
  computers: [{ computer, runner: 'mac-mini', takenAt: iso(takenHoursAgo), allows: { actions: ['task'], jobs: [] }, orders, hidden: 0 }]
})
const cardOf = (box) => shapeReadiness({ mailbox: box, now: NOW }).cards.find((card) => card.source === 'mailbox')

test('a computer whose orders all went well is GO, with when it last reported', () => {
  const card = cardOf(mailbox([order('ok', 1, { commit: '3b717814fb34', finishedAt: iso(1) }), order('refused', 2, { why: 'daily-limit' })]))
  assert.equal(card.light, 'go')
  assert.equal(card.name, 'Mac mailbox')
  assert.equal(card.ref, 'Mac Mini · Mac mailbox')
  assert.equal(card.id, 'mailbox:mac-mini')
  assert.equal(card.sentence.text, READINESS_WORDS.mailboxFine)
  assert.equal(card.sentence.at, iso(0.5))
  assert.deepEqual(card.lastReport, { text: '{time}', at: iso(0.5) })
  assert.equal(card.silentAt, new Date(Date.parse(iso(0.5)) + MAILBOX_SILENT_HOURS * 3600_000).toISOString().replace('.000Z', 'Z'))
})

test('an order that failed, or was lost part-way and did not land, in the last 24 hours is NO GO - and says which, when', () => {
  const failed = cardOf(mailbox([order('failed', 3, { why: 'push-failed' }), order('ok', 1, { commit: '3b717814fb34', finishedAt: iso(1) })]))
  assert.equal(failed.light, 'no-go')
  assert.equal(failed.sentence.text, READINESS_WORDS.mailboxFailed)
  assert.equal(failed.sentence.at, iso(3))
  for (const landed of [false, null]) {
    const lost = cardOf(mailbox([order('unknown', 2, { landed })]))
    assert.equal(lost.light, 'no-go', String(landed))
    assert.equal(lost.sentence.text, READINESS_WORDS.mailboxLost)
  }
  // Lost, but the change landed: nothing is wrong on the board.
  assert.equal(cardOf(mailbox([order('unknown', 2, { landed: true, commit: '3b717814fb34' })])).light, 'go')
  // More than a day ago: not the one that matters now.
  assert.equal(cardOf(mailbox([order('failed', 25, { why: 'push-failed' })], 0.5)).light, 'go')
  // The newest of two failures is the one it names.
  assert.equal(cardOf(mailbox([order('failed', 5, { why: 'timed-out' }), order('failed', 2, { why: 'push-failed' })])).sentence.at, iso(2))
})

test('a computer that has not reported on an order for a day is SILENT', () => {
  const card = cardOf(mailbox([order('ok', 30, { commit: '3b717814fb34', finishedAt: iso(30) })], 30))
  assert.equal(card.light, 'silent')
  assert.equal(card.sentence.text, READINESS_WORDS.mailboxSilent)
  assert.equal(card.sentence.at, iso(30))
})

test('no Mac mailbox file, or one the board could not use: no card at all', () => {
  for (const box of [null, { status: 'none', computers: [] }, { status: 'unusable', why: 'x', computers: [] }]) {
    assert.equal(cardOf(box), undefined)
  }
  const two = shapeReadiness({ mailbox: { status: 'ok', computers: [...mailbox([]).computers, { ...mailbox([]).computers[0], runner: 'old-imac', computer: null }] }, now: NOW })
  assert.deepEqual(two.cards.filter((card) => card.source === 'mailbox').map((card) => card.ref).sort(), ['Mac · Mac mailbox', 'Mac Mini · Mac mailbox'].sort())
})
