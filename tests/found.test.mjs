// The Connections wall: what each computer has set up, read from the files the collector commits to
// .agent-team/status/connections/, and what the board will and will not say about them.
//
// The collector has its own fail-closed gate. This board does not lean on it, for the reason the
// usage meters do not: the file comes through a repo anybody with push access can edit, and the
// payload goes to a browser on a board that can be public. So every name is checked again here, the
// output is BUILT from the keys the board knows, and "Proved" never comes from this file at all.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  shapeFound,
  matchProved,
  isFoundFile,
  isConnectionName,
  cleanUsageName,
  shapeConnections,
  FOUND_SCHEMA,
  FOUND_FOLDER,
  FOUND_COMPUTER_SLUG,
  FOUND_STALE_AFTER_HOURS,
  FOUND_MAX_FILES,
  FOUND_MAX_BYTES,
  FOUND_MAX_COMPUTERS,
  FOUND_STATUSES,
  FOUND_CAPS,
  FOUND_TOOLS,
  FOUND_TOOL_STATES,
  FOUND_VERSION,
  FOUND_MAX_VERSION_LENGTH,
  FOUND_SCOPES,
  FOUND_TRANSPORTS,
  FOUND_SERVER_STATES,
  FOUND_LIVE_STATES,
  FOUND_CODEX_STATES,
  CONNECTION_NAME
} from '../api/state.js'

const fixtureUrl = new URL('./fixtures/connections-parity.json', import.meta.url)
const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8'))
const NOW = Date.parse(fixture.expectedShape.now)
const clone = (value) => structuredClone(value)
const file = (slug, body) => [`${FOUND_FOLDER}/${slug}.json`, typeof body === 'string' ? body : JSON.stringify(body)]
const sampleAt = (takenAt, over = {}) => ({ ...clone(fixture.sample), takenAt, ...over })
const hoursBefore = (hours) => new Date(NOW - hours * 3600_000).toISOString().replace(/\.\d+Z$/, 'Z')
const shapeOne = (doc, now = NOW) => shapeFound([file('mac-mini', doc)], now)

// Assembled at runtime, so no file in this repo carries a token shape a secret scanner would flag.
const FAKE = {
  token: ['sk', 'ant', 'oat01', 'Zm9vYmFyYmF6cXV4'.repeat(3)].join('-'),
  jwt: 'ey' + 'J' + 'hbGciOiJIUzI1NiJ9.' + 'eyJlbWFpbCI6ImZha2UifQ',
  email: 'fake.person' + '@' + 'example.com',
  bearer: 'Bear' + 'er ' + 'abc123def456',
  uuid: ['5f0c2b1e', '9a7d', '4c3b', '8e21', '0d6f4a9b7c55'].join('-'),
  url: 'https://' + 'mcp.example.com/sse?key=' + 'Zm9vYmFyYmF6cXV4',
  home: '/Users/' + 'fakeperson',
  windows: 'C:' + '\\Users\\' + 'fakeperson'
}
const PLANTED = Object.values(FAKE)

// Every string anywhere in the shaped output, keys included.
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

test('connections parity: the board reads the folder, schema and limits the collector writes to', () => {
  assert.equal(FOUND_SCHEMA, fixture.schema)
  assert.equal(FOUND_FOLDER, fixture.folder)
  assert.equal(FOUND_COMPUTER_SLUG.source, fixture.computerSlug)
  assert.equal(FOUND_STALE_AFTER_HOURS, fixture.staleAfterHours)
  assert.equal(FOUND_MAX_FILES, fixture.maxFilesRead)
  assert.equal(FOUND_MAX_BYTES, fixture.maxFileBytes)
  assert.equal(FOUND_MAX_COMPUTERS, fixture.maxComputersShown)
  assert.deepEqual(FOUND_STATUSES, fixture.statuses)
})

test('connections parity: caps, tools, versions and every word the wall shows match', () => {
  assert.deepEqual(FOUND_CAPS, fixture.caps)
  assert.deepEqual(FOUND_TOOLS, fixture.tools)
  assert.deepEqual(FOUND_TOOL_STATES, fixture.toolStates)
  assert.equal(FOUND_VERSION.source, fixture.versionPattern)
  assert.equal(FOUND_MAX_VERSION_LENGTH, fixture.maxVersionLength)
  assert.deepEqual(FOUND_SCOPES, fixture.scopes)
  assert.deepEqual(FOUND_TRANSPORTS, fixture.transports)
  assert.deepEqual(FOUND_SERVER_STATES, fixture.serverStates)
  assert.deepEqual(FOUND_LIVE_STATES, fixture.liveStates)
  assert.deepEqual(FOUND_CODEX_STATES, fixture.codexStates)
})

test('connections parity: the connection-name rule is written the same way on this side', () => {
  const rule = fixture.connectionName
  assert.equal(CONNECTION_NAME.characters.source, rule.characters)
  assert.equal(CONNECTION_NAME.characters.flags, rule.flags)
  assert.equal(CONNECTION_NAME.maxLength, rule.maxLength)
  assert.deepEqual(CONNECTION_NAME.never, rule.never)
  assert.equal(CONNECTION_NAME.neverIgnoresCase, rule.neverIgnoresCase)
  assert.equal(CONNECTION_NAME.uuid.source, rule.uuid)
  assert.equal(CONNECTION_NAME.segmentSeparators, rule.segmentSeparators)
  assert.equal(CONNECTION_NAME.maxSegmentLength, rule.maxSegmentLength)
})

test('connection names: every accept example passes and every refuse example is refused', () => {
  for (const name of fixture.connectionName.accept) assert.ok(isConnectionName(name), `refused ${JSON.stringify(name)}`)
  for (const { name, why } of fixture.connectionName.refuse) assert.ok(!isConnectionName(name), `accepted ${JSON.stringify(name)} (${why})`)
  for (const value of [null, undefined, 42, {}, ['github']]) assert.equal(isConnectionName(value), false)
})

test('the board\'s older name rule would refuse a plugin server, which is why connections have their own', () => {
  // `\S{24,}` reads `plugin:marketing:supermetrics` (29 characters, no space) as a token. The
  // contract measures the stretch between separators instead. Other names on the board keep the
  // older rule - the contract only speaks for connection names.
  assert.equal(cleanUsageName('plugin:marketing:supermetrics'), null)
  assert.ok(isConnectionName('plugin:marketing:supermetrics'))
})

test('expectedShape: the sample comes out exactly as the contract says, at the contract\'s now', () => {
  const shaped = shapeFound([file('mac-mini', fixture.sample)], NOW)
  assert.equal(shaped.status, 'ok')
  assert.deepEqual({ now: fixture.expectedShape.now, computers: shaped.computers }, fixture.expectedShape)
})

test('the two repos hold the same connections contract, byte for byte', (t) => {
  const sibling = fileURLToPath(new URL('../../agent-team-template/tests/fixtures/connections-parity.json', import.meta.url))
  if (!existsSync(sibling)) {
    // Skipped, not passed: on a machine without the other repo this check cannot run, and the
    // reason says so in the test output rather than letting a quiet skip read as agreement.
    t.skip(`NOT CHECKED - the connections contract was not compared with the collector's copy, because ${sibling} does not exist (agent-team-template is not checked out beside agent-cockpit)`)
    return
  }
  assert.equal(readFileSync(sibling, 'utf8'), readFileSync(fixtureUrl, 'utf8'),
    'the shared connections contract has been edited on one side only')
})

/* ---------- names: kept, or dropped and counted ------------------------------------------------- */

test('every accept example is kept wherever a name goes', () => {
  for (const name of fixture.connectionName.accept) {
    const doc = clone(fixture.sample)
    doc.claude.servers = [{ name, scope: 'user', transport: 'local', state: 'connected' }]
    doc.codex.servers = [{ name }]
    doc.codex.plugins = [{ name, from: name }]
    const [computer] = shapeOne(doc).computers
    assert.deepEqual(computer.claude.servers.map((server) => server.name), [name])
    assert.deepEqual(computer.codex.servers.map((server) => server.name), [name])
    assert.deepEqual(computer.codex.plugins.map((plugin) => [plugin.name, plugin.from]), [[name, name]])
    assert.equal(computer.claude.hidden, fixture.sample.claude.hidden)
    assert.equal(computer.codex.hidden, fixture.sample.codex.hidden)
  }
})

test('every refuse example is dropped wherever a name goes, and counted in hidden', () => {
  for (const { name, why } of fixture.connectionName.refuse) {
    const doc = clone(fixture.sample)
    doc.claude.servers[0].name = name
    doc.codex.servers[0].name = name
    doc.codex.plugins[0].name = name
    doc.codex.plugins[1].from = name
    const [computer] = shapeOne(doc).computers
    assert.equal(computer.claude.servers.length, fixture.sample.claude.servers.length - 1, `kept ${JSON.stringify(name)} (${why})`)
    assert.equal(computer.claude.hidden, fixture.sample.claude.hidden + 1)
    assert.equal(computer.codex.servers.length, fixture.sample.codex.servers.length - 1)
    assert.equal(computer.codex.plugins.length, 0, `a plugin from ${JSON.stringify(name)} was kept (${why})`)
    assert.equal(computer.codex.hidden, fixture.sample.codex.hidden + 3)
    assert.ok(!strings(computer).includes(name), `${JSON.stringify(name)} reached the output`)
  }
})

test('a name listed twice is shown once, and the second is counted in hidden', () => {
  const doc = clone(fixture.sample)
  doc.claude.servers.push(clone(doc.claude.servers[0]))
  doc.codex.servers.push({ name: 'playwright', enabled: false })
  doc.codex.plugins.push({ name: 'github', from: 'openai-curated' })
  // The same plugin name from another source is a different plugin.
  doc.codex.plugins.push({ name: 'github', from: 'another-market' })
  const [computer] = shapeOne(doc).computers
  assert.equal(computer.claude.servers.filter((server) => server.name === 'github').length, 1)
  assert.equal(computer.claude.hidden, fixture.sample.claude.hidden + 1)
  assert.equal(computer.codex.servers.filter((server) => server.name === 'playwright').length, 1)
  assert.equal(computer.codex.plugins.length, 3)
  assert.equal(computer.codex.hidden, 2)
})

test('the computer\'s own name is held to the board\'s computer rule, and a bad one is no name', () => {
  for (const bad of [FAKE.email, FAKE.home, FAKE.uuid, 'a'.repeat(30), '']) {
    const [computer] = shapeOne(sampleAt(fixture.sample.takenAt, { computer: bad })).computers
    assert.equal(computer.computer, null)
  }
})

/* ---------- caps and enums ------------------------------------------------------------------- */

test('past a cap, the extra entries are not shown and are counted in more', () => {
  const doc = clone(fixture.sample)
  doc.claude.servers = Array.from({ length: FOUND_CAPS.claudeServers + 3 }, (_, index) => ({ name: `server ${index}`, scope: 'user', transport: 'local', state: 'not checked' }))
  doc.claude.more = 2
  doc.codex.servers = Array.from({ length: FOUND_CAPS.codexServers + 1 }, (_, index) => ({ name: `codex ${index}` }))
  doc.codex.plugins = Array.from({ length: FOUND_CAPS.codexPlugins + 4 }, (_, index) => ({ name: `plugin ${index}`, from: 'market' }))
  doc.tools = Array.from({ length: FOUND_CAPS.tools + 3 }, (_, index) => ({ name: FOUND_TOOLS[index % FOUND_TOOLS.length], state: 'not found' }))
  const [computer] = shapeOne(doc).computers
  assert.equal(computer.claude.servers.length, FOUND_CAPS.claudeServers)
  assert.equal(computer.claude.more, 5)
  assert.equal(computer.codex.servers.length, FOUND_CAPS.codexServers)
  assert.equal(computer.codex.plugins.length, FOUND_CAPS.codexPlugins)
  assert.equal(computer.codex.more, 5)
  assert.ok(computer.tools.length <= FOUND_CAPS.tools)
  // Each tool once: the nine names repeated are still nine tools.
  assert.equal(new Set(computer.tools.map((tool) => tool.name)).size, computer.tools.length)
})

test('every state, scope, transport and live word the contract names comes back with its words', () => {
  for (const [state, label] of Object.entries(FOUND_SERVER_STATES)) {
    for (const [scope, scopeLabel] of Object.entries(FOUND_SCOPES)) {
      for (const [transport, transportLabel] of Object.entries(FOUND_TRANSPORTS)) {
        const doc = clone(fixture.sample)
        doc.claude.servers = [{ name: 'github', scope, transport, state }]
        assert.deepEqual(shapeOne(doc).computers[0].claude.servers[0],
          { name: 'github', scope, scopeLabel, transport, transportLabel, state, stateLabel: label })
      }
    }
  }
  for (const [live, liveLabel] of Object.entries(FOUND_LIVE_STATES)) {
    const doc = clone(fixture.sample)
    doc.claude.live = live
    const { claude } = shapeOne(doc).computers[0]
    assert.equal(claude.live, live)
    assert.equal(claude.liveLabel, liveLabel)
  }
  for (const [state, label] of Object.entries(FOUND_TOOL_STATES)) {
    const doc = clone(fixture.sample)
    doc.tools = [{ name: 'Git', state, ...(state === 'found' ? { version: '2.47.1' } : {}) }]
    assert.deepEqual(shapeOne(doc).computers[0].tools, [{ name: 'Git', state, label, version: state === 'found' ? '2.47.1' : null }])
  }
})

test('a server with a state, scope or transport the contract does not name is dropped and counted', () => {
  for (const change of [
    (server) => { server.state = 'Connected' },
    (server) => { server.state = 'working' },
    (server) => { server.scope = 'project' },
    (server) => { server.transport = 'stdio' },
    (server) => { delete server.state },
    (server) => { server.scope = 'toString' }
  ]) {
    const doc = clone(fixture.sample)
    change(doc.claude.servers[0])
    const { claude } = shapeOne(doc).computers[0]
    assert.equal(claude.servers.length, fixture.sample.claude.servers.length - 1)
    assert.equal(claude.hidden, fixture.sample.claude.hidden + 1)
  }
})

test('Codex: enabled false is Turned off; true or missing is Found; anything else is dropped', () => {
  const doc = clone(fixture.sample)
  doc.codex.servers = [{ name: 'a', enabled: true }, { name: 'b' }, { name: 'c', enabled: false }, { name: 'd', enabled: 'yes' }, { name: 'e', enabled: 0 }]
  const { codex } = shapeOne(doc).computers[0]
  assert.deepEqual(codex.servers, [
    { name: 'a', state: 'found', label: 'Found' },
    { name: 'b', state: 'found', label: 'Found' },
    { name: 'c', state: 'turned off', label: 'Turned off' }
  ])
  assert.equal(codex.hidden, 2)
})

test('a version is shown only for a tool that was found, and only when it is a version number', () => {
  const doc = clone(fixture.sample)
  doc.tools = [
    { name: 'Claude Code', state: 'found', version: 'v2.1.293' },
    { name: 'Codex', state: 'found', version: `${'1'.repeat(31)}.1` },
    { name: 'Git', state: 'not found', version: '2.47.1' },
    { name: 'Node.js', state: 'found' },
    { name: 'Hermes', state: 'found', version: FAKE.token },
    { name: 'Docker', state: 'found', version: '1.2.3' },
    { name: 'Tailscale', state: 'Found', version: '1.2.3' }
  ]
  const { tools } = shapeOne(doc).computers[0]
  assert.deepEqual(tools, [
    { name: 'Claude Code', state: 'found', label: 'Found', version: null },
    { name: 'Codex', state: 'found', label: 'Found', version: null },
    { name: 'Git', state: 'not found', label: 'Not found', version: null },
    { name: 'Node.js', state: 'found', label: 'Found', version: null },
    { name: 'Hermes', state: 'found', label: 'Found', version: null }
  ])
})

test('a block that found nothing says so, and carries no list and no zero', () => {
  const doc = clone(fixture.sample)
  doc.claude = { status: 'not found' }
  doc.codex = { status: 'unavailable', why: 'could not be read' }
  const computer = shapeOne(doc).computers[0]
  assert.deepEqual(computer.claude, { status: 'not found', why: null })
  assert.deepEqual(computer.codex, { status: 'unavailable', why: 'could not be read' })
  // A block missing from the file is not found, not empty.
  const missing = clone(fixture.sample)
  delete missing.codex
  assert.deepEqual(shapeOne(missing).computers[0].codex, { status: 'not found', why: null })
  // A why that is not plainly a sentence is no why.
  const leaky = clone(fixture.sample)
  leaky.codex = { status: 'unavailable', why: FAKE.home }
  assert.deepEqual(shapeOne(leaky).computers[0].codex, { status: 'unavailable', why: null })
})

test('a found block in a shape the board does not know is unavailable, never partly shown', () => {
  for (const change of [
    (doc) => { doc.claude.live = 'ok' },
    (doc) => { delete doc.claude.live },
    (doc) => { doc.claude.servers = 'github' },
    (doc) => { doc.claude.projectServers = -1 },
    (doc) => { doc.claude.hidden = 1.5 },
    (doc) => { delete doc.claude.more },
    (doc) => { doc.claude.status = 'maybe' }
  ]) {
    const doc = clone(fixture.sample)
    change(doc)
    const { claude } = shapeOne(doc).computers[0]
    assert.equal(claude.status, 'unavailable')
    assert.equal(claude.servers, undefined)
  }
  for (const change of [(doc) => { doc.codex.plugins = null }, (doc) => { doc.codex.more = '2' }]) {
    const doc = clone(fixture.sample)
    change(doc)
    assert.equal(shapeOne(doc).computers[0].codex.status, 'unavailable')
  }
})

/* ---------- files ------------------------------------------------------------------------------ */

test('only a file named for one computer in the connections folder is a connections file', () => {
  assert.ok(isFoundFile('.agent-team/status/connections/mac-mini.json'))
  for (const path of [
    '.agent-team/status/connections/Mac Mini.json',
    '.agent-team/status/connections/a/b.json',
    '.agent-team/status/connections/.json',
    '.agent-team/status/usage/mac-mini.json',
    `.agent-team/status/connections/${'a'.repeat(33)}.json`,
    '.agent-team/status/connections/mac-mini.yml',
    null
  ]) assert.equal(isFoundFile(path), false, String(path))
})

test('no connections file says so, and invents nothing', () => {
  const shaped = shapeFound([], NOW)
  assert.equal(shaped.status, 'none')
  assert.deepEqual(shaped.computers, [])
  assert.match(shaped.why, /Nothing has been found yet/)
})

test('a file the board cannot use is said to be unusable, with the reason', () => {
  const cases = [
    [null, /could not be fetched, or was too big/],
    ['x'.repeat(FOUND_MAX_BYTES + 1), /too big/],
    ['{ not json', /could not be read/],
    ['[1]', /could not be read/],
    [JSON.stringify({ ...fixture.sample, schema: 'agent-status/connections/v2' }), /format this board does not know/],
    [JSON.stringify({ ...fixture.sample, takenAt: '8 Oct' }), /does not say when/],
    [JSON.stringify({ ...fixture.sample, takenAt: '2026-10-08T17:00:00Z' }), /future/]
  ]
  for (const [body, why] of cases) {
    const shaped = shapeFound([[`${FOUND_FOLDER}/mac-mini.json`, body]], NOW)
    assert.equal(shaped.status, 'unusable')
    assert.match(shaped.why, why)
    assert.equal(shaped.unreadable, 1)
    assert.deepEqual(shaped.computers, [])
  }
})

test('a list older than eight hours is still shown, marked stale', () => {
  const at = (hours) => shapeOne(sampleAt(hoursBefore(hours))).computers[0].freshness
  assert.equal(at(FOUND_STALE_AFTER_HOURS), 'fresh')
  assert.equal(at(FOUND_STALE_AFTER_HOURS + 0.01), 'stale')
  assert.equal(at(30), 'stale')
})

test('computers are newest first, at most three are shown, and the rest are counted', () => {
  const files = [
    file('a', sampleAt(hoursBefore(5), { computer: 'Old laptop' })),
    file('b', sampleAt(hoursBefore(1), { computer: 'Mac Mini' })),
    file('c', sampleAt(hoursBefore(3), { computer: 'Work PC' })),
    file('d', sampleAt(hoursBefore(2), { computer: 'Studio' })),
    file('e', '{ broken')
  ]
  const shaped = shapeFound(files, NOW, 7)
  assert.equal(shaped.status, 'ok')
  assert.deepEqual(shaped.computers.map((computer) => computer.computer), ['Mac Mini', 'Studio', 'Work PC'])
  assert.equal(shaped.notShown, 1, 'a fourth good computer was dropped without a word')
  assert.equal(shaped.read, FOUND_MAX_FILES)
  assert.equal(shaped.skipped, 2)
  assert.equal(shaped.unreadable, 1)
})

test('only the first five files, in name order, are read', () => {
  const files = ['g', 'f', 'e', 'd', 'c', 'b', 'a'].map((slug, index) => file(slug, sampleAt(hoursBefore(index + 1), { computer: `Computer ${slug}` })))
  const shaped = shapeFound(files, NOW)
  assert.equal(shaped.read, 5)
  assert.equal(shaped.skipped, 2)
  // a-e are read; f and g are the newest and are still not read - the cap is on files, not age.
  assert.deepEqual(shaped.computers.map((computer) => computer.computer), ['Computer e', 'Computer d', 'Computer c'])
})

/* ---------- nothing planted gets through ---------------------------------------------------- */

test('only the keys the board knows come out, so a planted url, command or env is never read', () => {
  const doc = clone(fixture.sample)
  const extra = { url: FAKE.url, command: FAKE.home, args: [FAKE.token], env: { KEY: FAKE.token }, headers: { Authorization: FAKE.bearer }, proved: true }
  Object.assign(doc, extra)
  Object.assign(doc.claude, extra)
  Object.assign(doc.codex, extra)
  doc.tools.forEach((tool) => Object.assign(tool, extra))
  doc.claude.servers.forEach((server) => Object.assign(server, extra))
  doc.codex.servers.forEach((server) => Object.assign(server, extra))
  doc.codex.plugins.forEach((plugin) => Object.assign(plugin, extra))
  const shaped = shapeOne(doc)
  assert.deepEqual(shaped.computers, fixture.expectedShape.computers, 'an unknown key changed the shape')
  for (const value of [...PLANTED, 'url', 'command', 'args', 'env', 'headers', 'proved']) {
    assert.ok(!strings(shaped).includes(value), `${value} came out of shapeFound`)
  }
})

test('a planted token, email, address or path in any field never comes out the other side', () => {
  for (const planted of PLANTED) {
    const doc = clone(fixture.sample)
    doc.computer = planted
    doc.tools[0].version = planted
    doc.tools[1].name = planted
    doc.tools[2].state = planted
    doc.claude.live = 'checked'
    doc.claude.servers[0].name = planted
    doc.claude.servers[1].scope = planted
    doc.claude.servers[2].transport = planted
    doc.claude.servers[3].state = planted
    doc.codex.servers[0].name = planted
    doc.codex.plugins[0].from = planted
    doc.codex.plugins[1].name = planted
    const text = JSON.stringify(shapeOne(doc))
    assert.ok(!text.includes(planted), `"${planted.slice(0, 12)}..." came out of shapeFound`)
    const unavailable = clone(fixture.sample)
    unavailable.claude = { status: 'unavailable', why: planted }
    assert.ok(!JSON.stringify(shapeOne(unavailable)).includes(planted))
  }
})

/* ---------- Proved comes only from the register --------------------------------------------- */

const register = (...entries) => shapeConnections({ connections: entries })

test('a found tile is Proved only when the register proved it, matched by name', () => {
  const shaped = shapeOne(fixture.sample)
  const proved = matchProved(shaped, register(
    { name: 'GitHub', slug: 'github', verified: '2026-08-20', proof: 'Listed my repos' },
    { name: 'Gmail', slug: 'gmail', verified: '2026-08-20', proof: 'Read three subjects' },
    { name: 'Supermetrics', verified: '2026-08-20', proof: 'Pulled last week' },
    // In the register, but with no proof: a claim, so no badge.
    { name: 'n8n MCP', slug: 'n8n-mcp', verified: '2026-08-20' }
  ))
  const [computer] = proved.computers
  const servers = Object.fromEntries(computer.claude.servers.map((server) => [server.name, server.proved]))
  assert.deepEqual(servers, {
    github: true,
    'n8n-mcp': false,
    'plugin:context7:context7': false,
    'plugin:marketing:supermetrics': true,
    'claude.ai Gmail': true,
    'claude.ai Google Drive': false,
    'team-tools': false
  })
  assert.deepEqual(computer.codex.plugins.map((plugin) => plugin.proved), [false, true])
  assert.deepEqual(computer.codex.servers.map((server) => server.proved), [false, false, false])
  // The shape the contract fixes is not changed underneath the badge.
  assert.deepEqual(shaped.computers, fixture.expectedShape.computers)
})

test('found is never proved: with no register, nothing gets a badge, whatever the file says', () => {
  const doc = clone(fixture.sample)
  doc.claude.servers.forEach((server) => { server.proved = true; server.verified = '2026-08-20'; server.proof = 'trust me' })
  const proved = matchProved(shapeOne(doc), [])
  const all = [...proved.computers[0].claude.servers, ...proved.computers[0].codex.servers, ...proved.computers[0].codex.plugins]
  assert.ok(all.length > 0)
  assert.ok(all.every((entry) => entry.proved === false))
})

test('matchProved leaves a wall with nothing found exactly as it was', () => {
  const none = shapeFound([], NOW)
  assert.deepEqual(matchProved(none, register({ name: 'GitHub', verified: '2026-08-20', proof: 'x' })), none)
  const notFound = clone(fixture.sample)
  notFound.claude = { status: 'not found' }
  notFound.codex = { status: 'unavailable', why: 'could not be read' }
  const shaped = shapeOne(notFound)
  assert.deepEqual(matchProved(shaped, []).computers[0].claude, { status: 'not found', why: null })
})
