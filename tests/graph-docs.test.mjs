// What the README says about the memory graph, held to what the board does: the line kinds the page
// draws, what loads when, which vaults are read and what of them reaches GitHub, and where the two
// vendored libraries' notices are.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { script } from './helpers/page-source.mjs'
import { TEAM_EDGE_KINDS, TEAM_CAPS } from '../api/_team-graph.js'
import { VAULTS_LEVELS, VAULTS_STALE_AFTER_DAYS } from '../api/_vaults.js'

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
const section = (heading) => {
  const from = readme.indexOf(`\n${heading}\n`)
  assert.ok(from >= 0, `README.md has no "${heading}" section`)
  const next = readme.slice(from + heading.length + 2).search(/\n#{2,3} /)
  return next < 0 ? readme.slice(from) : readme.slice(from, from + heading.length + 2 + next)
}

test('the README has a memory graph section naming every kind of line the page draws', () => {
  const graph = section('### The memory graph')
  const chips = { link: 'Link', mention: 'Mention', agent: 'Agent', day: 'Same day', tag: 'Same tag' }
  for (const kind of TEAM_EDGE_KINDS) {
    assert.ok(graph.includes(`| **${chips[kind]}** |`), `the README has no row for ${kind} lines`)
    assert.ok(script.includes(`short: '${chips[kind]}'`), `the page no longer calls ${kind} lines "${chips[kind]}"`)
  }
  for (const words of ['lonely', 'missing link', 'Lonely only', '3D | Flat', 'Every dot, as a list', 'legend']) {
    assert.ok(graph.includes(words), `the memory graph section does not say "${words}"`)
  }
})

test('it says what loads when, and the caps the board holds to', () => {
  const graph = section('### The memory graph')
  assert.match(graph, /only the first time you open \*\*Graph\*\*/)
  assert.ok(graph.includes(`up to ${TEAM_CAPS.notes} notes`))
  assert.ok(graph.includes(`${TEAM_CAPS.bytes / 1024} KB`))
  assert.ok(graph.includes('within a minute asks nothing'))
})

test('it says which vaults are read, both levels, and what never leaves the computer', () => {
  const graph = section('### The memory graph')
  for (const words of ['allowed-vaults.yml', 'vaults.yml', 'never widen', ...VAULTS_LEVELS.map((level) => `**${level}**`), 'What a note says', `${['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'][VAULTS_STALE_AFTER_DAYS]} days`]) {
    assert.ok(graph.includes(words), `the memory graph section does not say "${words}"`)
  }
})

test('the screens table and the dependency sentence tell the truth about the graph', () => {
  const memoryRow = readme.split('\n').find((line) => line.startsWith('| **Memory** |'))
  assert.match(memoryRow, /graph/i, 'the screens table does not mention the graph')
  assert.doesNotMatch(memoryRow, /searchable \*\*by page name\*\*/, 'the screens table still says search is by page name only')
  assert.match(readme, /two libraries in `public\/vendor\/`/)
  assert.match(readme, /`public\/vendor\/THIRD-PARTY-LICENSES\.txt`/)
  assert.match(readme, /loaded only when someone opens \*\*Graph\*\*/)
})

test('the README never claims the board has nothing but one dependency in it', () => {
  assert.doesNotMatch(readme, /no other (code|dependenc)/i)
})
