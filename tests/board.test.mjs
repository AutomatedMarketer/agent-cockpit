// The Board — shapeBoard's three columns, tested without a network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { shapeBoard } from '../api/state.js'

const NOW = Date.parse('2026-08-20T12:00:00Z')
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString()
const HOUR = 3600_000
const DAY = 86400_000

const workflow = (overrides) => ({
  slug: 'monday-brief',
  name: 'Monday Brief',
  owner: 'research',
  nextRun: null,
  ...overrides
})

test('up next holds only workflows due inside 48 hours, soonest first', () => {
  const { upNext } = shapeBoard(
    [
      workflow({ slug: 'later', name: 'Later', nextRun: iso(40 * HOUR) }),
      workflow({ slug: 'too-far', name: 'Too Far', nextRun: iso(60 * HOUR) }),
      workflow({ slug: 'soon', name: 'Soon', owner: 'email', nextRun: iso(2 * HOUR) }),
      workflow({ slug: 'unscheduled', name: 'Unscheduled', nextRun: null })
    ],
    [],
    [],
    NOW
  )
  assert.deepEqual(upNext.map((card) => card.slug), ['soon', 'later'])
  assert.deepEqual(upNext[0], { slug: 'soon', name: 'Soon', owner: 'email', when: iso(2 * HOUR) })
})

test('a run with status "running" or no status at all is running', () => {
  const { running, done } = shapeBoard(
    [],
    [
      { agent: 'research', workflow: 'monday-brief', status: 'running', started_at: iso(-2 * HOUR), session_url: 'https://claude.ai/code/s1' },
      { agent: 'email', started_at: iso(-5 * HOUR) }
    ],
    [],
    NOW
  )
  assert.deepEqual(running.map((card) => card.name), ['monday-brief', 'email'])
  assert.equal(running[0].session_url, 'https://claude.ai/code/s1')
  assert.equal(running[1].session_url, null)
  assert.deepEqual(done, [])
})

test('a fresh run with a provisional status but no finished_at is still running for 30 minutes', () => {
  const fresh = { agent: 'research', status: 'ok', started_at: iso(-10 * 60_000), summary: 'kicked off' }
  const settled = { agent: 'research', status: 'ok', started_at: iso(-HOUR), summary: 'settled' }
  const { running, done } = shapeBoard([], [fresh, settled], [], NOW)
  assert.deepEqual(running.map((card) => card.started_at), [fresh.started_at])
  assert.deepEqual(done.map((card) => card.summary), ['settled'])
})

test('a stamped finished_at is never running, whatever the status says', () => {
  const { running, done } = shapeBoard(
    [],
    [{ agent: 'research', status: 'running', started_at: iso(-5 * 60_000), finished_at: iso(-60_000), summary: 'over' }],
    [],
    NOW
  )
  assert.deepEqual(running, [])
  assert.deepEqual(done.map((card) => card.summary), ['over'])
})

test('done holds 14 days of finished runs, newest first, with summary and watch link', () => {
  const { done } = shapeBoard(
    [],
    [
      { agent: 'email', status: 'failed', started_at: iso(-3 * DAY), summary: 'Inbox sweep crashed.' },
      { agent: 'research', workflow: 'monday-brief', status: 'ok', started_at: iso(-DAY), summary: 'Brief written.', session_url: 'https://claude.ai/code/s2' },
      { agent: 'research', status: 'ok', started_at: iso(-20 * DAY), summary: 'Ancient history.' }
    ],
    [],
    NOW
  )
  assert.deepEqual(done.map((card) => card.name), ['monday-brief', 'email'])
  assert.deepEqual(done[0], {
    kind: 'run',
    name: 'monday-brief',
    agent: 'research',
    status: 'ok',
    summary: 'Brief written.',
    started_at: iso(-DAY),
    session_url: 'https://claude.ai/code/s2'
  })
  assert.equal(done[1].session_url, null)
})

test('every terminal status lands in done; anything else without a finish does not', () => {
  const runs = ['ok', 'partial', 'blocked', 'failed', 'weird'].map((status) => ({
    agent: 'research',
    status,
    started_at: iso(-DAY),
    summary: status
  }))
  const { running, done } = shapeBoard([], runs, [], NOW)
  assert.deepEqual(done.map((card) => card.status), ['ok', 'partial', 'blocked', 'failed'])
  assert.deepEqual(running, [], 'an hour-old unknown status is neither running nor done')
})

test('empty inputs give four empty columns, not a crash', () => {
  assert.deepEqual(shapeBoard([], [], [], NOW), { todo: [], upNext: [], running: [], done: [], finishedTasks: [] })
})
