// The vaults snapshot: the memory graph of each Obsidian vault the owner named, read from the files
// the status collector commits to .agent-team/status/vaults/. The Memory screen draws it beside the
// team repo's own graph.
//
// The same terms as every other status file: it comes through a repo anybody with push access can
// edit, and the payload goes to a browser on a board that can be public. So every name and title is
// checked again here, the answer is BUILT from the keys the board knows, and a vault published at the
// `shape` level never carries a title, a folder, a day or a tag, whatever the file says.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  VAULTS_SCHEMA,
  VAULTS_FOLDER,
  VAULTS_COMPUTER_SLUG,
  VAULTS_STALE_AFTER_DAYS,
  VAULTS_MAX_FILES,
  VAULTS_MAX_BYTES,
  VAULTS_MAX_COMPUTERS,
  VAULTS_STATUSES,
  VAULTS_CAPS,
  VAULTS_LEVELS,
  VAULTS_EDGE_KINDS,
  VAULTS_HUB_KINDS,
  VAULTS_MIN_HUB_NOTES,
  VAULTS_WHY_CODES,
  VAULTS_ALLOWED_KEYS,
  VAULTS_REQUIRED_KEYS,
  NOTE_TITLE_RULE,
  isNoteTitle,
  isVaultName,
  isVaultsFile,
  shapeVaults
} from '../api/_vaults.js'

const fixtureUrl = new URL('./fixtures/vaults-parity.json', import.meta.url)
const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8'))

/* ---------- the shared contract ---------------------------------------------------------------- */

test('vaults parity: the board reads the folder, schema and limits the collector writes to', () => {
  assert.equal(VAULTS_SCHEMA, fixture.schema)
  assert.equal(VAULTS_FOLDER, fixture.folder)
  assert.equal(VAULTS_COMPUTER_SLUG.source, fixture.computerSlug)
  assert.equal(VAULTS_STALE_AFTER_DAYS, fixture.staleAfterDays)
  assert.equal(VAULTS_MAX_FILES, fixture.maxFilesRead)
  assert.equal(VAULTS_MAX_BYTES, fixture.maxFileBytes)
  assert.equal(VAULTS_MAX_COMPUTERS, fixture.maxComputersShown)
  assert.deepEqual(VAULTS_STATUSES, fixture.statuses)
  assert.deepEqual(VAULTS_CAPS, fixture.caps)
  assert.deepEqual(VAULTS_LEVELS, fixture.levels)
  assert.deepEqual(VAULTS_EDGE_KINDS, fixture.edgeKinds)
  assert.deepEqual(VAULTS_HUB_KINDS, fixture.hubKinds)
  assert.equal(VAULTS_MIN_HUB_NOTES, fixture.minHubNotes)
  assert.deepEqual(VAULTS_WHY_CODES, fixture.whyCodes)
  assert.deepEqual(VAULTS_ALLOWED_KEYS, fixture.allowedKeys)
  assert.deepEqual(VAULTS_REQUIRED_KEYS, fixture.requiredKeys)
})

test('vaults parity: the title rule is the contract\'s, value for value', () => {
  const rule = fixture.titleRule
  assert.equal(NOTE_TITLE_RULE.maxLength, rule.maxLength)
  assert.deepEqual(NOTE_TITLE_RULE.never, rule.never)
  assert.equal(NOTE_TITLE_RULE.uuid.source, rule.uuid)
  assert.equal(NOTE_TITLE_RULE.maxSegmentLength, rule.maxSegmentLength)
  assert.equal(NOTE_TITLE_RULE.separatorCharacters, rule.separatorCharacters)
  assert.equal(NOTE_TITLE_RULE.controlCharacters.source, rule.controlCharacters)
  assert.equal(NOTE_TITLE_RULE.invisibleCharacters.source, rule.invisibleCharacters)
  assert.equal(rule.neverIgnoresCase, true)
  assert.equal(rule.separatorsAlsoWhitespace, true)
})

test('vaults parity: the shared contract file is the same bytes the collector holds', (t) => {
  const sibling = fileURLToPath(new URL('../../agent-team-template/tests/fixtures/vaults-parity.json', import.meta.url))
  if (!existsSync(sibling)) {
    // Skipped, not passed: the reason is in the output so a quiet skip never reads as agreement.
    t.skip(`NOT CHECKED - the vaults contract was not compared with the collector's copy, because ${sibling} does not exist (agent-team-template is not checked out beside agent-cockpit)`)
    return
  }
  assert.equal(readFileSync(sibling, 'utf8'), readFileSync(fixtureUrl, 'utf8'), 'the shared vaults contract has been edited on one side only')
})

test('vaults parity: every title the collector publishes, the board shows; every one it refuses, the board refuses', () => {
  for (const title of fixture.titleRule.accept) assert.equal(isNoteTitle(title), true, `${title} should be a title`)
  for (const { title, why } of fixture.titleRule.acceptEdge) assert.equal(isNoteTitle(title), true, `${JSON.stringify(title)} (${why}) should be a title`)
  for (const { title, why } of fixture.titleRule.refuse) assert.equal(isNoteTitle(title), false, `${JSON.stringify(title)} (${why}) should not be`)
})

test('vaults parity: a vault is called by a name the board would print, and by nothing else', () => {
  for (const name of fixture.names.vaultAccept) assert.equal(isVaultName(name), true, `${name} should be a vault name`)
  for (const { name, why } of fixture.names.vaultRefuse) assert.equal(isVaultName(name), false, `${JSON.stringify(name)} (${why}) should not be`)
})

test('vaults parity: only strings are ever a title or a vault name', () => {
  for (const value of [undefined, null, 7, {}, [], ['Weekly plan'], true]) {
    assert.equal(isNoteTitle(value), false)
    assert.equal(isVaultName(value), false)
  }
})

test('a vaults file is one per computer, in the contract\'s folder, named by its slug', () => {
  assert.equal(isVaultsFile(`${VAULTS_FOLDER}/mac-mini.json`), true)
  assert.equal(isVaultsFile(`${VAULTS_FOLDER}/Mac Mini.json`), false)
  assert.equal(isVaultsFile(`${VAULTS_FOLDER}/sub/mac-mini.json`), false)
  assert.equal(isVaultsFile(`${VAULTS_FOLDER}/mac-mini.yml`), false)
  assert.equal(isVaultsFile('.agent-team/status/jobs/mac-mini.json'), false)
  assert.equal(isVaultsFile(`${VAULTS_FOLDER}/${'a'.repeat(33)}.json`), false)
  assert.equal(isVaultsFile(null), false)
})

/* ---------- reading the files: shapeVaults ----------------------------------------------------- */

const TAKEN = fixture.sample.takenAt
const NOW = Date.parse(TAKEN) + 5 * 60_000
const clone = (value) => structuredClone(value)
const file = (slug, body) => [`${VAULTS_FOLDER}/${slug}.json`, typeof body === 'string' ? body : JSON.stringify(body)]
const oneComputer = (doc, now = NOW) => shapeVaults([file('mac-mini', doc)], now, 1).computers[0]
const daysBefore = (days, from = NOW) => new Date(from - days * 86400_000).toISOString().replace(/\.\d+Z$/, 'Z')
const [FIELD, IDEAS] = fixture.sample.vaults.items
// A file with just these vaults in it, everything else as the shared sample has it.
const withVaults = (items, block = {}) => ({ ...clone(fixture.sample), vaults: { status: 'found', items, hidden: 0, more: 0, ...block } })
const itemsOf = (doc) => oneComputer(doc).vaults.items

// Built from pieces so this file is not itself a thing a secret scanner would stop on.
const FAKE = {
  token: ['sk', 'ant', 'oat01', 'Zm9vYmFyYmF6cXV4'.repeat(3)].join('-'),
  jwt: 'ey' + 'J' + 'hbGciOiJIUzI1NiJ9.' + 'eyJlbWFpbCI6ImZha2UifQ',
  email: 'fake.person' + '@' + 'example.com',
  bearer: 'Bear' + 'er ' + 'abc123def456',
  home: '/Users/' + 'fakeperson' + '/Notes',
  windows: 'C:' + String.fromCharCode(92) + 'Users' + String.fromCharCode(92) + 'fakeperson',
  note: 'Diagnosis for the patient, Friday'
}
const PLANTED = Object.values(FAKE)
function strings(value, found = []) {
  if (typeof value === 'string') found.push(value)
  else if (Array.isArray(value)) value.forEach((item) => strings(item, found))
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      found.push(key)
      strings(inner, found)
    }
  }
  return found
}
const leaks = (value) => strings(value).filter((text) => PLANTED.some((fake) => text.includes(fake)))

test('vaults parity: the board reads the shared sample exactly as the contract describes it', () => {
  const shaped = shapeVaults([file('mac-mini', fixture.sample)], NOW, 1)
  assert.equal(shaped.status, 'ok')
  assert.equal(shaped.computers.length, 1)
  const [mac] = shaped.computers
  assert.equal(mac.computer, 'Mac Mini')
  assert.equal(mac.takenAt, TAKEN)
  assert.equal(mac.freshness, 'fresh')
  assert.deepEqual(mac.vaults, {
    status: 'found',
    why: null,
    hidden: 0,
    more: 0,
    items: [
      { name: 'Field Notes', level: 'shape', notes: 6, lines: 5, lonely: 1, hidden: 1, more: 0, moreLines: 0, edges: FIELD.edges },
      {
        name: 'Ideas', level: 'titles', notes: 5, lines: 6, lonely: 2, hidden: 0, more: 0, moreLines: 0, untitled: 1,
        edges: IDEAS.edges,
        nodes: [{ title: 'Shopping list', folder: 'Plans', day: '2026-10-09' }, { title: 'Weekly plan', folder: 'Plans', day: '2026-10-09' }, { title: 'Pasta ideas', folder: 'Recipes' }, { title: 'Soup', folder: 'Recipes' }, {}],
        hubs: [{ kind: 'day', label: '2026-10-09' }, { kind: 'tag', label: 'recipes' }]
      }
    ]
  })
})

test('vaults parity: nothing the board outputs carries a key the contract does not list', () => {
  const [mac] = shapeVaults([file('mac-mini', fixture.sample)], NOW, 1).computers
  const within = (object, keys) => Object.keys(object).forEach((key) => assert.ok(keys.includes(key), `${key} is not a key the contract lists`))
  within(mac.vaults, [...fixture.allowedKeys.blockFound, 'why'])
  for (const vault of mac.vaults.items) {
    within(vault, fixture.allowedKeys.vault)
    for (const node of vault.nodes ?? []) within(node, fixture.allowedKeys.node)
    for (const hub of vault.hubs ?? []) within(hub, fixture.allowedKeys.hub)
  }
})

test('a vault at the shape level never carries a title, a folder, a day or a tag, whatever its file says', () => {
  const hostile = { ...clone(FIELD), hubs: [{ kind: 'tag', label: 'private' }], untitled: 0 }
  hostile.nodes = Array.from({ length: hostile.notes }, () => ({ title: 'Secret plan', folder: 'Private', day: '2026-10-09' }))
  const [vault] = itemsOf(withVaults([hostile]))
  assert.equal(vault.level, 'shape')
  for (const key of ['nodes', 'hubs', 'untitled']) assert.equal(Object.hasOwn(vault, key), false, `a shape vault came out with ${key}`)
  assert.ok(!strings(vault).some((text) => /Secret plan|Private|private|2026-10-09/.test(text)), 'a title reached the page from a shape vault')
})

test('keys the board does not know never reach the page, at any depth, whatever they hold', () => {
  const doc = withVaults([
    { ...clone(FIELD), path: FAKE.home, content: FAKE.note, token: FAKE.token },
    { ...clone(IDEAS), nodes: IDEAS.nodes.map((node) => ({ ...node, path: FAKE.windows, text: FAKE.note, owner: FAKE.email })), hubs: IDEAS.hubs.map((hub) => ({ ...hub, members: [FAKE.jwt] })) }
  ], { message: FAKE.bearer })
  doc.location = FAKE.home
  doc.username = FAKE.email
  const shaped = shapeVaults([file('mac-mini', doc)], NOW, 1)
  assert.deepEqual(leaks(shaped), [])
  assert.equal(shaped.computers[0].vaults.items.length, 2)
})

test('a title, folder or day that fails the rule is dropped on the board too, and the title is counted', () => {
  const titles = clone(IDEAS)
  titles.nodes[0].title = FAKE.email
  titles.nodes[1].folder = FAKE.home
  titles.nodes[2].day = '2026-02-31'
  titles.nodes[3].title = 'Desk-helper'
  // untitled says what the file said; the board counts for itself.
  const [vault] = itemsOf(withVaults([titles]))
  assert.deepEqual(vault.nodes, [{ folder: 'Plans', day: '2026-10-09' }, { title: 'Weekly plan', day: '2026-10-09' }, { title: 'Pasta ideas', folder: 'Recipes' }, { folder: 'Recipes' }, {}])
  assert.equal(vault.untitled, 3)
  assert.deepEqual(leaks(vault), [])
})

test('a hub whose label fails the rule keeps its place, with no label', () => {
  const hubs = clone(IDEAS)
  hubs.hubs[1].label = FAKE.token
  hubs.hubs[0].label = 'not a day'
  const [vault] = itemsOf(withVaults([hubs]))
  assert.deepEqual(vault.hubs, [{ kind: 'day', label: null }, { kind: 'tag', label: null }])
  assert.deepEqual(vault.edges, IDEAS.edges)
})

test('a vault the board cannot vouch for is left out whole and counted, and the others stand', () => {
  const withoutNodes = clone(IDEAS)
  delete withoutNodes.nodes
  const broken = [
    ['a name the board would not print', { ...clone(FIELD), name: FAKE.email }],
    ['a name that is not text', { ...clone(FIELD), name: 7 }],
    ['a level that is not one of the two', { ...clone(FIELD), level: 'everything' }],
    ['more notes than the cap', { ...clone(FIELD), notes: VAULTS_CAPS.notes + 1 }],
    ['a count that is not a whole number', { ...clone(FIELD), hidden: 1.5 }],
    ['a negative count', { ...clone(FIELD), more: -1 }],
    ['edges that are not a list', { ...clone(FIELD), edges: 'all of them' }],
    ['more edges than the cap', { ...clone(FIELD), edges: Array.from({ length: VAULTS_CAPS.lines + 1 }, () => [0, 1, 0]) }],
    ['an edge going backwards', { ...clone(FIELD), edges: [[1, 0, 0]] }],
    ['an edge to itself', { ...clone(FIELD), edges: [[2, 2, 0]] }],
    ['an edge past the last dot', { ...clone(FIELD), edges: [[0, 6, 0]] }],
    ['an edge of a kind there is not', { ...clone(FIELD), edges: [[0, 1, 4]] }],
    ['an edge that is not three whole numbers', { ...clone(FIELD), edges: [[0, '1', 0]] }],
    ['the same line twice', { ...clone(FIELD), edges: [[0, 1, 0], [0, 1, 0]] }],
    ['a day line at the shape level', { ...clone(FIELD), edges: [[0, 1, 2]] }],
    ['a link line to a hub', { ...clone(IDEAS), edges: [[0, 5, 0], ...IDEAS.edges.slice(1)] }],
    ['a day line to a tag hub', { ...clone(IDEAS), edges: [[0, 6, 2], [1, 6, 2], ...IDEAS.edges.filter((edge) => edge[2] !== 2)] }],
    ['day lines to the tag hub and tag lines to the day hub', { ...clone(IDEAS), edges: [[0, 1, 0], [1, 2, 1], [0, 5, 3], [1, 5, 3], [2, 6, 2], [3, 6, 2]] }],
    ['a hub with one line', { ...clone(IDEAS), edges: IDEAS.edges.filter((edge) => !(edge[0] === 3 && edge[2] === 3)) }],
    ['a hub of a kind there is not', { ...clone(IDEAS), hubs: [{ kind: 'person', label: 'Ann' }, IDEAS.hubs[1]] }],
    ['titles with no nodes', withoutNodes],
    ['titles with one node too few', { ...clone(IDEAS), nodes: IDEAS.nodes.slice(1) }],
    ['titles with one node too many', { ...clone(IDEAS), nodes: [...IDEAS.nodes, { title: 'Extra' }] }],
    ['a node that is not an object', { ...clone(IDEAS), nodes: [...IDEAS.nodes.slice(0, 4), 'Soup'] }],
    // Each of these hubs has its two lines, so only the cap is wrong.
    ['more hubs than the cap', { ...clone(IDEAS), hubs: Array.from({ length: VAULTS_CAPS.hubs + 1 }, (_, index) => ({ kind: 'tag', label: `t${index}` })), edges: Array.from({ length: VAULTS_CAPS.hubs + 1 }, (_, index) => [[0, 5 + index, 3], [1, 5 + index, 3]]).flat() }]
  ]
  for (const [why, vault] of broken) {
    const other = vault.name === FIELD.name ? clone(IDEAS) : clone(FIELD)
    const computer = oneComputer(withVaults([vault, other]))
    assert.equal(computer.vaults.items.length, 1, `${why}: the vault was shown`)
    assert.equal(computer.vaults.items[0].name, other.name, `${why}: the good vault went with it`)
    assert.equal(computer.vaults.hidden, 1, `${why}: the vault was not counted`)
    assert.equal(computer.vaults.status, 'found')
  }
})

test('the lines and the lonely count are the board\'s own, counted from the edges', () => {
  const lying = { ...clone(FIELD), lines: 99, lonely: 0 }
  const [vault] = itemsOf(withVaults([lying]))
  assert.equal(vault.lines, 5)
  assert.equal(vault.lonely, 1)
  const quiet = { ...clone(FIELD), edges: [], lines: 0, lonely: 0 }
  assert.equal(itemsOf(withVaults([quiet]))[0].lonely, 6, 'a vault with no lines is all lonely dots')
  // Day and tag lines are not links: a note joined to the others only through a hub is still lonely.
  const ideas = itemsOf(withVaults([{ ...clone(IDEAS), edges: IDEAS.edges.filter((edge) => edge[2] >= 2) }]))[0]
  assert.equal(ideas.lonely, 5)
})

test('three vaults at most, in the file\'s order; the rest, and any name given twice, are counted', () => {
  const named = (name) => ({ ...clone(FIELD), name })
  const computer = oneComputer(withVaults([named('One'), named('Two'), named('two'), named('Two'), named('Three'), named('Four')], { hidden: 2, more: 1 }))
  assert.deepEqual(computer.vaults.items.map((vault) => vault.name), ['One', 'Two', 'two'])
  assert.equal(computer.vaults.hidden, 3)
  assert.equal(computer.vaults.more, 3)
})

test('a block that found nothing carries a status and, at most, one of the two fixed reasons', () => {
  const refused = oneComputer({ ...clone(fixture.sample), vaults: { status: 'unavailable', why: VAULTS_WHY_CODES.refused } })
  assert.deepEqual(refused.vaults, { status: 'unavailable', why: 'refused by the safety check', items: [], hidden: 0, more: 0 })
  const none = oneComputer({ ...clone(fixture.sample), vaults: { status: 'not found' } })
  assert.deepEqual(none.vaults, { status: 'not found', why: null, items: [], hidden: 0, more: 0 })
  for (const why of [FAKE.note, FAKE.home, 'Error: ' + FAKE.token, '', 7, null]) {
    assert.equal(oneComputer({ ...clone(fixture.sample), vaults: { status: 'unavailable', why } }).vaults.why, null)
  }
  const missing = clone(fixture.sample)
  delete missing.vaults
  assert.equal(oneComputer(missing).vaults.status, 'not found')
  assert.equal(oneComputer({ ...clone(fixture.sample), vaults: 'found' }).vaults.status, 'unavailable')
  assert.equal(oneComputer({ ...clone(fixture.sample), vaults: { status: 'toString' } }).vaults.status, 'unavailable')
  const noList = oneComputer({ ...clone(fixture.sample), vaults: { status: 'found', items: 'x', hidden: 0, more: 0 } })
  assert.equal(noList.vaults.status, 'unavailable')
})

test('no vaults files at all reads as none, with a sentence', () => {
  for (const files of [[], undefined, null]) {
    const shaped = shapeVaults(files, NOW, 0)
    assert.equal(shaped.status, 'none')
    assert.match(shaped.why, /No vault has been read yet\./)
    assert.deepEqual(shaped.computers, [])
  }
})

test('a file that could not be used says which way, in a finished sentence', () => {
  const cases = [
    [null, /could not be fetched, or was too big/],
    ['{ not json', /could not be read/],
    [JSON.stringify({ ...fixture.sample, schema: 'agent-status/vaults/v2' }), /format this board does not know/],
    [JSON.stringify({ ...fixture.sample, takenAt: 'yesterday' }), /does not say when it was taken/],
    [JSON.stringify({ ...fixture.sample, takenAt: daysBefore(-1) }), /stamped in the future/]
  ]
  for (const [body, pattern] of cases) {
    const shaped = shapeVaults([body === null ? [`${VAULTS_FOLDER}/mac-mini.json`, null] : file('mac-mini', body)], NOW, 1)
    assert.equal(shaped.status, 'unusable', String(body).slice(0, 40))
    assert.match(shaped.why, pattern)
    assert.match(shaped.why, /^A vaults file /)
  }
})

test('a file over 256 KB is refused whatever it holds, and one under it is read', () => {
  const big = JSON.stringify({ ...fixture.sample, padding: 'x'.repeat(VAULTS_MAX_BYTES) })
  assert.ok(Buffer.byteLength(big) > VAULTS_MAX_BYTES)
  assert.match(shapeVaults([file('mac-mini', big)], NOW, 1).why, /too big to read/)
  assert.equal(shapeVaults([file('mac-mini', fixture.sample)], NOW, 1).status, 'ok')
})

test('a reading older than seven days is stale: shown as not updated, never as the current graph', () => {
  assert.equal(oneComputer({ ...clone(fixture.sample), takenAt: daysBefore(7) }).freshness, 'fresh')
  assert.equal(oneComputer({ ...clone(fixture.sample), takenAt: daysBefore(7, NOW - 1000) }).freshness, 'stale')
})

test('the newest three computers are shown, newest first, and only five files are read', () => {
  const stamp = (minutes) => new Date(Date.parse(TAKEN) - minutes * 60_000).toISOString().replace('.000Z', 'Z')
  const files = [['a', 40], ['b', 10], ['c', 30], ['d', 20], ['e', 50], ['f', 5], ['g', 1]].map(([slug, minutes]) => file(slug, { ...clone(fixture.sample), computer: `Mac ${slug}`, takenAt: stamp(minutes) }))
  const shaped = shapeVaults(files, NOW, 7)
  assert.equal(shaped.read, VAULTS_MAX_FILES)
  assert.equal(shaped.skipped, 2)
  assert.deepEqual(shaped.computers.map((computer) => computer.computer), ['Mac b', 'Mac d', 'Mac c'])
  assert.equal(shaped.notShown, 2)
})

test('a computer name the board would not print is no name at all', () => {
  assert.equal(oneComputer({ ...clone(fixture.sample), computer: FAKE.email }).computer, null)
})

test('a titles vault at the caps is read whole: two hundred hubs, each with its two lines', () => {
  const full = { ...clone(IDEAS), hubs: Array.from({ length: VAULTS_CAPS.hubs }, (_, index) => ({ kind: 'tag', label: `t${index}` })), edges: Array.from({ length: VAULTS_CAPS.hubs }, (_, index) => [[0, 5 + index, 3], [1, 5 + index, 3]]).flat() }
  const [vault] = itemsOf(withVaults([full]))
  assert.equal(vault.hubs.length, VAULTS_CAPS.hubs)
  assert.equal(vault.lines, VAULTS_CAPS.hubs * 2)
})
