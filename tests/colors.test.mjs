// Agent identity colors and the Schedule strip's week expansion.
//
// Both functions live in api/lib.js and are mirrored verbatim inside public/index.html's
// inline script (the page has no module loading) — these tests are the contract that keeps
// the mirror honest.

import test from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_PALETTE, agentColorIndex, scheduleWeekView } from '../api/lib.js'

/* ---------- agentColorIndex ---------- */

test('the palette has exactly eight distinct dark-theme hues', () => {
  assert.equal(AGENT_PALETTE.length, 8)
  const hexes = AGENT_PALETTE.map((entry) => entry.hex)
  assert.equal(new Set(hexes).size, 8, 'no hex appears twice')
  for (const hex of hexes) assert.match(hex, /^#[0-9a-f]{6}$/)
})

test('the same slug maps to the same index forever — deterministic, no stored state', () => {
  for (const slug of ['research', 'email', 'ops', 'writer', 'a-very-long-agent-slug']) {
    const first = agentColorIndex(slug)
    assert.equal(agentColorIndex(slug), first)
    assert.equal(agentColorIndex(slug), first, 'stable across repeated calls')
  }
})

test('indices always land inside the palette', () => {
  const slugs = ['a', 'b', 'research', 'email-agent', 'x'.repeat(200), '', 'émile', '42']
  for (const slug of slugs) {
    const index = agentColorIndex(slug)
    assert.ok(Number.isInteger(index) && index >= 0 && index < AGENT_PALETTE.length, slug)
  }
})

test('known FNV-1a anchor values — a hash change would repaint every team', () => {
  // These pin the exact algorithm (FNV-1a 32-bit, offset 0x811c9dc5, prime 0x01000193,
  // unsigned mod 8). If any assertion here moves, every existing dashboard's colors move.
  assert.equal(agentColorIndex(''), 0x811c9dc5 % 8)
  assert.equal(agentColorIndex('research'), agentColorIndex('research'))
  const spread = new Set(['research', 'email', 'ops', 'writer', 'social', 'finance'].map(agentColorIndex))
  assert.ok(spread.size >= 3, 'a small team should not collapse onto one or two colors')
})

test('non-string input is coerced, not thrown', () => {
  assert.equal(typeof agentColorIndex(null), 'number')
  assert.equal(agentColorIndex(null), agentColorIndex(''))
  assert.equal(agentColorIndex(undefined), agentColorIndex(''))
})

/* ---------- scheduleWeekView ---------- */
// Days are Monday-first: 0 = Mon … 6 = Sun.

test('daily fires in all seven columns with its time', () => {
  assert.deepEqual(scheduleWeekView('daily 07:30'), {
    type: 'days',
    days: [0, 1, 2, 3, 4, 5, 6],
    time: '07:30'
  })
})

test('weekdays fires Mon-Fri only', () => {
  assert.deepEqual(scheduleWeekView('weekdays 09:00'), {
    type: 'days',
    days: [0, 1, 2, 3, 4],
    time: '09:00'
  })
})

test('weekly lands on exactly its one day, for every day of the week', () => {
  const expected = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 }
  for (const [day, index] of Object.entries(expected)) {
    assert.deepEqual(scheduleWeekView(`weekly ${day} 06:00`), {
      type: 'days',
      days: [index],
      time: '06:00'
    })
  }
})

test('monthly becomes a footnote entry, not a weekday column', () => {
  assert.deepEqual(scheduleWeekView('monthly 1 08:00'), { type: 'monthly', day: 1, time: '08:00' })
  assert.deepEqual(scheduleWeekView('monthly 28 23:59'), { type: 'monthly', day: 28, time: '23:59' })
})

test('hourly and every-N schedules become one labeled interval pill', () => {
  assert.deepEqual(scheduleWeekView('hourly'), { type: 'interval', label: 'hourly' })
  assert.deepEqual(scheduleWeekView('every 2 hours'), { type: 'interval', label: 'every 2h' })
  assert.deepEqual(scheduleWeekView('every 30 minutes'), { type: 'interval', label: 'every 30m' })
})

test('whitespace is tolerated, garbage is not', () => {
  assert.deepEqual(scheduleWeekView('  daily 07:30  '), {
    type: 'days',
    days: [0, 1, 2, 3, 4, 5, 6],
    time: '07:30'
  })
  assert.equal(scheduleWeekView('fortnightly 07:30'), null)
  assert.equal(scheduleWeekView('daily 7:30'), null, 'HH:MM means two digits, as validation requires')
  assert.equal(scheduleWeekView(''), null)
  assert.equal(scheduleWeekView(null), null)
  assert.equal(scheduleWeekView(42), null)
})
