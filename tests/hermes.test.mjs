// The Hermes card: Hermes's version, whether it is running, and each profile's model, skills and
// last week, read from the files the collector commits to .agent-team/status/hermes/.
//
// The same terms as the Connections wall: the file comes through a repo anybody with push access
// can edit, and the payload goes to a browser on a board that can be public, so every name is
// checked again here and the output is BUILT from the keys the board knows. And one thing more:
// the board works out Running or Down ITSELF, from the times in the file. A yes/no flag in the
// file is never read - a file that says "alive: true" about a stopped Hermes still reads Down.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  shapeHermes,
  isHermesFile,
  isProfileName,
  hermesModelName,
  isConnectionName,
  HERMES_SCHEMA,
  HERMES_FOLDER,
  HERMES_COMPUTER_SLUG,
  HERMES_STALE_AFTER_HOURS,
  HERMES_MAX_FILES,
  HERMES_MAX_BYTES,
  HERMES_MAX_COMPUTERS,
  HERMES_STATUSES,
  HERMES_CAPS,
  HERMES_DEFAULT_PROFILE,
  HERMES_SESSION_DAYS,
  HERMES_GATEWAY_STATES,
  HERMES_ALIVE,
  HERMES_WORDS,
  HERMES_PROFILE_NAME
} from '../api/state.js'

const fixtureUrl = new URL('./fixtures/hermes-parity.json', import.meta.url)
const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8'))
const NOW = Date.parse(fixture.expectedShape.now)
const clone = (value) => structuredClone(value)
const file = (slug, body) => [`${HERMES_FOLDER}/${slug}.json`, typeof body === 'string' ? body : JSON.stringify(body)]
const shapeOne = (doc, now = NOW) => shapeHermes([file('mac-mini', doc)], now)
const oneComputer = (doc, now = NOW) => shapeOne(doc, now).computers[0]
const hoursBefore = (hours) => new Date(NOW - hours * 3600_000).toISOString().replace(/\.\d+Z$/, 'Z')

const FAKE = {
  token: ['sk', 'ant', 'oat01', 'Zm9vYmFyYmF6cXV4'.repeat(3)].join('-'),
  jwt: 'ey' + 'J' + 'hbGciOiJIUzI1NiJ9.' + 'eyJlbWFpbCI6ImZha2UifQ',
  email: 'fake.person' + '@' + 'example.com',
  bearer: 'Bear' + 'er ' + 'abc123def456',
  uuid: ['5f0c2b1e', '9a7d', '4c3b', '8e21', '0d6f4a9b7c55'].join('-'),
  url: 'https://' + 'api.example.com/v1?key=' + 'Zm9vYmFyYmF6cXV4',
  home: '/Users/' + 'fakeperson' + '/.hermes',
  windows: 'C:' + '\\Users\\' + 'fakeperson' + '\\AppData'
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

/* ---------- the shared contract ---------------------------------------------------------------- */

test('hermes parity: the board reads the folder, schema and limits the collector writes to', () => {
  assert.equal(HERMES_SCHEMA, fixture.schema)
  assert.equal(HERMES_FOLDER, fixture.folder)
  assert.equal(HERMES_COMPUTER_SLUG.source, fixture.computerSlug)
  assert.equal(HERMES_STALE_AFTER_HOURS, fixture.staleAfterHours)
  assert.equal(HERMES_MAX_FILES, fixture.maxFilesRead)
  assert.equal(HERMES_MAX_BYTES, fixture.maxFileBytes)
  assert.equal(HERMES_MAX_COMPUTERS, fixture.maxComputersShown)
  assert.deepEqual(HERMES_STATUSES, fixture.statuses)
  assert.deepEqual(HERMES_CAPS, fixture.caps)
  assert.equal(HERMES_DEFAULT_PROFILE, fixture.defaultProfile)
  assert.equal(HERMES_SESSION_DAYS, fixture.sessionDays)
})

test('hermes parity: gateway words, the alive rule and every sentence the card says match', () => {
  assert.deepEqual(HERMES_GATEWAY_STATES, fixture.gatewayStates)
  assert.equal(HERMES_ALIVE.withinSeconds, fixture.alive.withinSeconds)
  assert.deepEqual(HERMES_ALIVE.gatewayStates, fixture.alive.gatewayStates)
  assert.deepEqual(HERMES_ALIVE.words, fixture.alive.words)
  assert.deepEqual(HERMES_WORDS, fixture.words)
  assert.equal(HERMES_PROFILE_NAME.source, fixture.names.profile)
})

test('expectedShape: the sample comes out exactly as the contract says, at the contract\'s now', () => {
  const shaped = shapeOne(fixture.sample)
  assert.equal(shaped.status, 'ok')
  assert.deepEqual({ now: fixture.expectedShape.now, computers: shaped.computers }, fixture.expectedShape)
})

test('the two repos hold the same Hermes contract, byte for byte', (t) => {
  const sibling = fileURLToPath(new URL('../../agent-team-template/tests/fixtures/hermes-parity.json', import.meta.url))
  if (!existsSync(sibling)) {
    // Skipped, not passed: the reason is in the output so a quiet skip never reads as agreement.
    t.skip(`NOT CHECKED - the Hermes contract was not compared with the collector's copy, because ${sibling} does not exist (agent-team-template is not checked out beside agent-cockpit)`)
    return
  }
  assert.equal(readFileSync(sibling, 'utf8'), readFileSync(fixtureUrl, 'utf8'), 'the shared Hermes contract has been edited on one side only')
})

/* ---------- alive: worked out here, never read ------------------------------------------------- */

function aliveDoc(example) {
  const doc = clone(fixture.sample)
  doc.takenAt = example.takenAt
  doc.gateway = clone(example.gateway)
  doc.profiles.items = doc.profiles.items.map((item, index) => ({
    ...item,
    scheduler: example.schedulerBeats[index] ? { status: 'found', beatAt: example.schedulerBeats[index] } : { status: 'not found' }
  }))
  return doc
}

test('every alive example the contract gives comes out Running or Down as it says', () => {
  assert.equal(fixture.aliveExamples.length, 11)
  for (const example of fixture.aliveExamples) {
    const computer = oneComputer(aliveDoc(example), Date.parse(example.takenAt) + 3600_000)
    assert.equal(computer.alive, example.alive ? 'running' : 'down', example.why)
    assert.equal(computer.aliveLabel, example.alive ? 'Running' : 'Down at last check', example.why)
  }
})

test('every word example: Down at last check, and Not checked for N h in whole hours', () => {
  for (const example of fixture.wordExamples) {
    const doc = clone(fixture.sample)
    doc.takenAt = example.takenAt
    if (example.down) {
      doc.gateway = { status: 'found', state: 'stopped', beatAt: example.takenAt }
      doc.profiles.items = doc.profiles.items.map((item) => ({ ...item, scheduler: { status: 'not found' } }))
    }
    const computer = oneComputer(doc, Date.parse(example.now))
    assert.equal(computer.aliveLabel, example.aliveLabel, example.why)
    assert.equal(computer.freshness, example.freshness, example.why)
  }
})

test('a yes/no flag in the file is never read: a stopped Hermes that says it is alive is Down', () => {
  const doc = clone(fixture.sample)
  doc.gateway = { status: 'found', state: 'stopped', beatAt: doc.takenAt, alive: true, running: true }
  doc.profiles.items = doc.profiles.items.map((item) => ({ ...item, scheduler: { status: 'not found' }, alive: true }))
  Object.assign(doc, { alive: true, running: true, status: 'running' })
  const computer = oneComputer(doc)
  assert.equal(computer.alive, 'down')
  // And a beat the board could not read is no proof either.
  const unreadable = clone(fixture.sample)
  unreadable.gateway.beatAt = '8 Oct, about three'
  unreadable.profiles.items[0].scheduler.beatAt = 'just now'
  assert.equal(oneComputer(unreadable).alive, 'down')
})

/* ---------- names ------------------------------------------------------------------------------- */

test('profile names: every accept example is kept and every refuse example dropped and counted', () => {
  for (const name of fixture.names.profileAccept) assert.ok(isProfileName(name), `refused ${JSON.stringify(name)}`)
  for (const { name, why } of fixture.names.profileRefuse) assert.ok(!isProfileName(name), `accepted ${JSON.stringify(name)} (${why})`)
  for (const { name } of fixture.names.profileRefuse) {
    const doc = clone(fixture.sample)
    doc.profiles.items[1].name = name
    const { profiles } = oneComputer(doc)
    assert.deepEqual(profiles.items.map((item) => item.name), ['default', 'coder'])
    assert.equal(profiles.hidden, fixture.sample.profiles.hidden + 1)
  }
})

test('models: a shown model is kept; anything the collector would not write is Model not known', () => {
  for (const { shown } of fixture.names.modelAccept) assert.equal(hermesModelName(shown), shown)
  for (const { raw, why } of fixture.names.modelRefuse) {
    assert.equal(hermesModelName(raw), null, `${JSON.stringify(raw)} (${why})`)
    const doc = clone(fixture.sample)
    doc.profiles.items[0].model = raw
    const [item] = oneComputer(doc).profiles.items
    assert.deepEqual([item.model, item.provider, item.modelLabel], [null, null, 'Model not known'], why)
  }
})

test('providers: accepted ones show as "via", refused ones are dropped and the model stays', () => {
  for (const name of fixture.names.providerAccept) {
    const doc = clone(fixture.sample)
    doc.profiles.items[0].provider = name
    assert.equal(oneComputer(doc).profiles.items[0].modelLabel, `claude-opus-5-5 via ${name}`)
  }
  for (const { name, why } of fixture.names.providerRefuse) {
    assert.equal(isConnectionName(name), false, why)
    const doc = clone(fixture.sample)
    doc.profiles.items[0].provider = name
    const [item] = oneComputer(doc).profiles.items
    assert.deepEqual([item.provider, item.modelLabel], [null, 'claude-opus-5-5'], why)
  }
  // A provider with no model has nothing to be "via".
  const doc = clone(fixture.sample)
  delete doc.profiles.items[0].model
  assert.deepEqual(oneComputer(doc).profiles.items[0].modelLabel, 'Model not known')
})

/* ---------- blocks, counts, caps ---------------------------------------------------------------- */

test('Hermes not on the computer at all is said, and nothing is invented', () => {
  const doc = clone(fixture.sample)
  doc.install = { status: 'not found' }
  doc.gateway = { status: 'not found' }
  doc.profiles = { status: 'not found' }
  const computer = oneComputer(doc)
  assert.deepEqual(computer.install, { status: 'not found', version: null, updateAvailable: null, label: 'Hermes not found' })
  assert.deepEqual(computer.gateway, { status: 'not found', state: null, stateLabel: null, beatAt: null })
  assert.deepEqual(computer.profiles, { status: 'not found', items: [], hidden: 0, more: 0 })
  assert.equal(computer.alive, 'down')
})

test('the install line: version, up to date, update available, no version, unreadable', () => {
  const label = (install) => oneComputer({ ...clone(fixture.sample), install }).install.label
  assert.equal(label({ status: 'found', version: '0.21.3', updateAvailable: false }), 'Hermes 0.21.3 - up to date')
  assert.equal(label({ status: 'found', version: '0.21.3' }), 'Hermes 0.21.3')
  assert.equal(label({ status: 'found' }), 'Hermes, version not known')
  assert.equal(label({ status: 'found', version: '0.21.3 (git)', updateAvailable: 'yes' }), 'Hermes, version not known')
  assert.equal(label({ status: 'unavailable', why: 'could not be read' }), 'Hermes could not be read')
  assert.equal(label({ status: 'something else' }), 'Hermes could not be read')
})

test('the gateway: every state word, and a state the contract does not name is unavailable', () => {
  for (const [state, stateLabel] of Object.entries(HERMES_GATEWAY_STATES)) {
    const doc = clone(fixture.sample)
    doc.gateway.state = state
    assert.equal(oneComputer(doc).gateway.stateLabel, stateLabel)
  }
  for (const state of ['Running', 'draining', 'toString', undefined]) {
    const doc = clone(fixture.sample)
    doc.gateway.state = state
    assert.deepEqual(oneComputer(doc).gateway, { status: 'unavailable', state: null, stateLabel: null, beatAt: null })
  }
})

test('sessions: found counts as written; not found and unavailable say so in words, never zero', () => {
  const sessions = (value) => {
    const doc = clone(fixture.sample)
    doc.profiles.items[0].sessions = value
    return oneComputer(doc).profiles.items[0].sessions
  }
  assert.deepEqual(sessions({ status: 'not found' }), { status: 'not found', label: 'No sessions recorded' })
  assert.deepEqual(sessions({ status: 'unavailable', why: 'needs a newer Node' }), { status: 'unavailable', label: 'Not available (needs a newer Node)' })
  // A reason that is not plainly a sentence is no reason, and no empty brackets either.
  assert.deepEqual(sessions({ status: 'unavailable', why: FAKE.home }), { status: 'unavailable', label: 'Not available' })
  assert.deepEqual(sessions({ status: 'unavailable' }), { status: 'unavailable', label: 'Not available' })
  for (const bad of [
    { status: 'found', days: 30, conversations: 1, scheduled: 1 },
    { status: 'found', days: 7, conversations: -1, scheduled: 1 },
    { status: 'found', days: 7, conversations: 1.5, scheduled: 1 },
    { status: 'found', days: 7, conversations: 1 }
  ]) assert.deepEqual(sessions(bad), { status: 'unavailable', label: 'Not available' })
  assert.equal(sessions({ status: 'found', days: 7, conversations: 1, scheduled: 2, lastActiveAt: 'today' }).lastActiveAt, null)
})

test('skills: a count when found, otherwise none rather than zero', () => {
  for (const [skills, expected] of [[{ status: 'found', count: 0 }, 0], [{ status: 'found', count: -2 }, null], [{ status: 'not found' }, null], [{ status: 'found' }, null], ['89', null]]) {
    const doc = clone(fixture.sample)
    doc.profiles.items[0].skills = skills
    assert.equal(oneComputer(doc).profiles.items[0].skills, expected, JSON.stringify(skills))
  }
})

test('profiles past twelve are counted in more; a name twice is shown once and counted in hidden', () => {
  const item = (name) => ({ name, skills: { status: 'not found' }, sessions: { status: 'not found' }, scheduler: { status: 'not found' } })
  const doc = clone(fixture.sample)
  doc.profiles.items = [item('default'), ...Array.from({ length: HERMES_CAPS.profiles + 2 }, (_, index) => item(`p${index}`)), item('p0')]
  doc.profiles.more = 1
  doc.profiles.hidden = 0
  const { profiles } = oneComputer(doc)
  assert.equal(profiles.items.length, HERMES_CAPS.profiles)
  assert.equal(profiles.more, 4)
  assert.equal(profiles.hidden, 1)
  // The file's own order stands: default first, as the collector writes it.
  assert.equal(profiles.items[0].name, 'default')
})

test('a profiles block in a shape the board does not know is unavailable, never partly shown', () => {
  for (const change of [(doc) => { doc.profiles.items = 'default' }, (doc) => { doc.profiles.hidden = -1 }, (doc) => { delete doc.profiles.more }]) {
    const doc = clone(fixture.sample)
    change(doc)
    assert.deepEqual(oneComputer(doc).profiles, { status: 'unavailable', items: [], hidden: 0, more: 0 })
  }
})

/* ---------- files ------------------------------------------------------------------------------- */

test('only a file named for one computer in the Hermes folder is a Hermes file', () => {
  assert.ok(isHermesFile('.agent-team/status/hermes/mac-mini.json'))
  for (const path of ['.agent-team/status/hermes/Mac Mini.json', '.agent-team/status/hermes/a/b.json', '.agent-team/status/connections/mac-mini.json', null]) {
    assert.equal(isHermesFile(path), false, String(path))
  }
})

test('no Hermes file says so; a file the board cannot use says why', () => {
  assert.equal(shapeHermes([], NOW).status, 'none')
  for (const [body, why] of [
    [null, /could not be fetched, or was too big/],
    ['x'.repeat(HERMES_MAX_BYTES + 1), /too big/],
    ['{ nope', /could not be read/],
    [JSON.stringify({ ...fixture.sample, schema: 'agent-status/hermes/v2' }), /format this board does not know/],
    [JSON.stringify({ ...fixture.sample, takenAt: 'today' }), /does not say when/],
    [JSON.stringify({ ...fixture.sample, takenAt: '2026-10-08T17:00:00Z' }), /future/]
  ]) {
    const shaped = shapeHermes([[`${HERMES_FOLDER}/mac-mini.json`, body]], NOW)
    assert.equal(shaped.status, 'unusable')
    assert.match(shaped.why, why)
    assert.deepEqual(shaped.computers, [])
  }
})

test('computers are newest first, three at most, the rest counted; five files read', () => {
  const docs = ['Studio', 'Mac Mini', 'Old laptop', 'Work PC', 'Spare', 'Sixth'].map((computer, index) =>
    file(`c${index}`, { ...clone(fixture.sample), computer, takenAt: hoursBefore(6 - index) }))
  const shaped = shapeHermes(docs, NOW)
  assert.equal(shaped.read, 5)
  assert.equal(shaped.skipped, 1)
  assert.equal(shaped.notShown, 2)
  assert.deepEqual(shaped.computers.map((computer) => computer.computer), ['Spare', 'Work PC', 'Old laptop'])
})

/* ---------- nothing planted gets through -------------------------------------------------------- */

test('only the keys the board knows come out: argv, pid, base urls, titles and paths are never read', () => {
  const doc = clone(fixture.sample)
  const extra = { argv: ['hermes', FAKE.home], pid: 4242, baseUrl: FAKE.url, base_url: FAKE.url, secrets: { key: FAKE.token }, titles: [FAKE.email], cwd: FAKE.windows, behind: 12389 }
  Object.assign(doc, extra)
  for (const block of [doc.install, doc.gateway, doc.profiles]) Object.assign(block, extra)
  for (const item of doc.profiles.items) {
    Object.assign(item, extra)
    for (const inner of [item.skills, item.sessions, item.scheduler]) Object.assign(inner, extra)
  }
  const shaped = shapeOne(doc)
  assert.deepEqual(shaped.computers, fixture.expectedShape.computers, 'an unknown key changed the shape')
  for (const value of [...PLANTED, 'argv', 'pid', 'baseUrl', 'secrets', 'titles', 'cwd', 'behind']) {
    assert.ok(!strings(shaped).includes(value), `${value} came out of shapeHermes`)
  }
})

test('a planted token, email, address or path in any field never comes out the other side', () => {
  for (const planted of PLANTED) {
    const doc = clone(fixture.sample)
    doc.computer = planted
    doc.install.version = planted
    doc.install.why = planted
    doc.gateway.state = planted
    doc.profiles.items[0].model = planted
    doc.profiles.items[0].provider = planted
    doc.profiles.items[1].name = planted
    doc.profiles.items[2].sessions.why = planted
    doc.profiles.items[2].skills = { status: 'unavailable', why: planted }
    const text = JSON.stringify(shapeOne(doc))
    assert.ok(!text.includes(planted), `"${planted.slice(0, 12)}..." came out of shapeHermes`)
  }
})
