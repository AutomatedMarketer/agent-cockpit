import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseFrontmatter,
  daysSince,
  stateFor,
  fillMarkers,
  sortRunsNewestFirst
} from '../api/lib.js'

const NOW = Date.parse('2026-08-10T12:00:00Z')
const at = (iso, extra = {}) => ({ started_at: iso, status: 'ok', ...extra })

test('frontmatter yields the model alias and description', () => {
  const data = parseFrontmatter('---\nname: research\nmodel: sonnet\ndescription: Looks things up.\n---\n\n# Research\n')
  assert.equal(data.name, 'research')
  assert.equal(data.model, 'sonnet')
  assert.equal(data.description, 'Looks things up.')
})

test('frontmatter survives CRLF checkouts', () => {
  const data = parseFrontmatter('---\r\nname: sales\r\nmodel: opus\r\n---\r\n\r\nbody')
  assert.equal(data.model, 'opus')
})

test('a file with no frontmatter yields an empty object rather than throwing', () => {
  assert.deepEqual(parseFrontmatter('# Just a heading'), {})
  assert.deepEqual(parseFrontmatter(null), {})
})

test('an agent with no runs is never-run, not stale', () => {
  assert.equal(stateFor([], NOW), 'never-run')
})

test('an agent that ran today is working', () => {
  assert.equal(stateFor([at('2026-08-10T06:00:00Z')], NOW), 'working')
})

test('an agent that last ran nine days ago is stale', () => {
  assert.equal(stateFor([at('2026-08-01T06:00:00Z')], NOW), 'stale')
})

test('a recent run that ended blocked needs a look', () => {
  assert.equal(stateFor([at('2026-08-10T06:00:00Z', { status: 'blocked' })], NOW), 'attention')
})

test('staleness wins over status, because an old failure is an old problem', () => {
  assert.equal(stateFor([at('2026-07-01T06:00:00Z', { status: 'failed' })], NOW), 'stale')
})

test('an unparseable timestamp does not crash the page', () => {
  assert.equal(daysSince('not a date'), null)
  assert.equal(stateFor([at('not a date')], NOW), 'working')
})

test('fill markers are reported by name, not just counted', () => {
  assert.deepEqual(fillMarkers('# Brain\n<!-- fill: primary-offer -->\n<!-- fill:  pricing  -->'), [
    'primary-offer',
    'pricing'
  ])
  assert.deepEqual(fillMarkers('nothing here'), [])
})

test('runs sort newest first by started_at', () => {
  const sorted = sortRunsNewestFirst([
    at('2026-08-01T06:00:00Z'),
    at('2026-08-09T06:00:00Z'),
    at('2026-08-05T06:00:00Z')
  ])
  assert.deepEqual(
    sorted.map((run) => run.started_at),
    ['2026-08-09T06:00:00Z', '2026-08-05T06:00:00Z', '2026-08-01T06:00:00Z']
  )
})
