// The jobs snapshot: every LaunchAgent on a Mac and every Hermes cron job, read from the files the
// status collector commits to .agent-team/status/jobs/. It is the input to the Readiness screen.
//
// The same terms as the Connections wall and the Hermes card: the file comes through a repo anybody
// with push access can edit, and the payload goes to a browser on a board that can be public, so
// every name is checked again here and the output is BUILT from the keys the board knows. Two
// things more. The file never says whether a job is on time or late - the board works that out -
// and a Hermes job is never shown under its stored name: the only name the board accepts from the
// file is "Hermes job <12 hex characters>", so a prompt that leaked into a name never gets here.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  shapeJobs,
  shapeJobOverrides,
  isJobsFile,
  isJobLabel,
  isHermesJobId,
  JOBS_SCHEMA,
  JOBS_FOLDER,
  JOBS_COMPUTER_SLUG,
  JOBS_STALE_AFTER_HOURS,
  JOBS_MAX_FILES,
  JOBS_MAX_BYTES,
  JOBS_MAX_COMPUTERS,
  JOBS_STATUSES,
  JOBS_CAPS,
  JOBS_GRACE_MINUTES,
  JOBS_LOOKBACK_DAYS,
  JOBS_LAUNCHD_STATES,
  JOBS_HERMES_RESULTS,
  JOBS_HERMES_NAME,
  JOBS_WHY_CODES,
  JOBS_EXIT_CODE,
  JOBS_CADENCE,
  JOBS_ALLOWED_KEYS,
  JOBS_REQUIRED_KEYS,
  JOBS_LABEL,
  JOBS_HERMES_ID,
  RUNNING_GRACE_MINUTES
} from '../api/state.js'

const fixtureUrl = new URL('./fixtures/jobs-parity.json', import.meta.url)
const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8'))
const TAKEN = fixture.sample.takenAt
const NOW = Date.parse(TAKEN) + 5 * 60_000
const clone = (value) => structuredClone(value)
const file = (slug, body) => [`${JOBS_FOLDER}/${slug}.json`, typeof body === 'string' ? body : JSON.stringify(body)]
const shapeOne = (doc, now = NOW) => shapeJobs([file('mac-mini', doc)], now)
const oneComputer = (doc, now = NOW) => shapeOne(doc, now).computers[0]
const hoursBefore = (hours, from = NOW) => new Date(from - hours * 3600_000).toISOString().replace(/\.\d+Z$/, 'Z')

// Built from pieces so this file is not itself a thing a secret scanner would stop on.
const FAKE = {
  token: ['sk', 'ant', 'oat01', 'Zm9vYmFyYmF6cXV4'.repeat(3)].join('-'),
  jwt: 'ey' + 'J' + 'hbGciOiJIUzI1NiJ9.' + 'eyJlbWFpbCI6ImZha2UifQ',
  email: 'fake.person' + '@' + 'example.com',
  bearer: 'Bear' + 'er ' + 'abc123def456',
  uuid: ['5f0c2b1e', '9a7d', '4c3b', '8e21', '0d6f4a9b7c55'].join('-'),
  url: 'https://' + 'api.example.com/v1?key=' + 'Zm9vYmFyYmF6cXV4',
  home: '/Users/' + 'fakeperson' + '/.hermes',
  windows: 'C:' + '\\Users\\' + 'fakeperson' + '\\AppData',
  prompt: 'Dr Smith HIV test results for the patient on Friday'
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
// Names come back on a bare object, so that "__proto__" is just a key; a copy is an ordinary object to compare.
const plain = (shaped) => ({ ...shaped, names: { ...shaped.names } })
const leaks = (value) => strings(value).filter((text) => PLANTED.some((fake) => text.includes(fake)))

const launchd = (patch = {}) => ({ label: 'local.donna.story-belt-daily', cadence: { kind: 'slots', slots: [{ minute: 15, hour: 6 }] }, state: 'loaded', lastExit: 0, lastReportAt: '2026-10-09T10:15:22Z', dueAt: '2026-10-09T10:15:00Z', dueBeforeAt: '2026-10-08T10:15:00Z', ...patch })
const hermesJob = (patch = {}) => ({ profile: 'default', id: 'a1b2c3d4e5f6', name: 'Hermes job a1b2c3d4e5f6', enabled: true, cadence: { kind: 'slots', slots: [{ minute: 30, hour: 6 }] }, lastRunAt: '2026-10-09T10:30:04Z', lastResult: 'ok', dueAt: '2026-10-09T10:30:00Z', dueBeforeAt: '2026-10-08T10:30:00Z', ...patch })
// A file with just these jobs in it, everything else as the shared sample has it.
const withJobs = ({ launchdItems = [launchd()], hermesItems = [hermesJob()], ...rest } = {}) => ({
  ...clone(fixture.sample),
  launchd: { status: 'found', items: launchdItems, hidden: 0, more: 0 },
  hermes: { status: 'found', items: hermesItems, hidden: 0, more: 0 },
  ...rest
})

/* ---------- the shared contract ---------------------------------------------------------------- */

test('jobs parity: the board reads the folder, schema and limits the collector writes to', () => {
  assert.equal(JOBS_SCHEMA, fixture.schema)
  assert.equal(JOBS_FOLDER, fixture.folder)
  assert.equal(JOBS_COMPUTER_SLUG.source, fixture.computerSlug)
  assert.equal(JOBS_STALE_AFTER_HOURS, fixture.staleAfterHours)
  assert.equal(JOBS_MAX_FILES, fixture.maxFilesRead)
  assert.equal(JOBS_MAX_BYTES, fixture.maxFileBytes)
  assert.equal(JOBS_MAX_COMPUTERS, fixture.maxComputersShown)
  assert.deepEqual(JOBS_STATUSES, fixture.statuses)
  assert.deepEqual(JOBS_CAPS, fixture.caps)
  assert.equal(JOBS_GRACE_MINUTES, fixture.graceMinutes)
  assert.equal(JOBS_LOOKBACK_DAYS, fixture.lookbackDays)
  assert.deepEqual(JOBS_LAUNCHD_STATES, fixture.launchdStates)
  assert.deepEqual(JOBS_HERMES_RESULTS, fixture.hermesResults)
  assert.equal(JOBS_HERMES_NAME, fixture.hermesJobName)
  assert.deepEqual(JOBS_WHY_CODES, fixture.whyCodes)
  assert.deepEqual(JOBS_EXIT_CODE, fixture.exitCode)
  assert.deepEqual(JOBS_CADENCE, {
    kinds: fixture.cadence.kinds,
    everyMinutes: fixture.cadence.everyMinutes,
    slot: fixture.cadence.slot
  })
  assert.deepEqual(JOBS_ALLOWED_KEYS, fixture.allowedKeys)
  assert.deepEqual(JOBS_REQUIRED_KEYS, fixture.requiredKeys)
  assert.equal(JOBS_LABEL.source, fixture.names.label)
  assert.equal(JOBS_HERMES_ID.source, fixture.names.hermesId)
})

test('jobs parity: the running grace is the one the Workflows screen already uses', () => {
  assert.equal(JOBS_GRACE_MINUTES, RUNNING_GRACE_MINUTES)
})

test('jobs parity: the shared contract file is the same bytes the collector holds', (t) => {
  const sibling = fileURLToPath(new URL('../../agent-team-template/tests/fixtures/jobs-parity.json', import.meta.url))
  if (!existsSync(sibling)) {
    // Skipped, not passed: the reason is in the output so a quiet skip never reads as agreement.
    t.skip(`NOT CHECKED - the jobs contract was not compared with the collector's copy, because ${sibling} does not exist (agent-team-template is not checked out beside agent-cockpit)`)
    return
  }
  assert.equal(readFileSync(sibling, 'utf8'), readFileSync(fixtureUrl, 'utf8'), 'the shared jobs contract has been edited on one side only')
})

test('jobs parity: every Hermes id and label the collector accepts, the board accepts; every one it refuses, the board refuses', () => {
  for (const id of fixture.names.hermesIdAccept) assert.equal(isHermesJobId(id), true, `${id} should be a Hermes id`)
  for (const { id, why } of fixture.names.hermesIdRefuse) assert.equal(isHermesJobId(id), false, `${JSON.stringify(id)} (${why}) should not be`)
  for (const label of fixture.names.labelAccept) assert.equal(isJobLabel(label), true, `${label} should be a label`)
  for (const { name, why } of fixture.names.labelRefuse) assert.equal(isJobLabel(name), false, `${JSON.stringify(name)} (${why}) should not be`)
})

test('jobs parity: only strings are ever a Hermes id or a label', () => {
  for (const value of [undefined, null, 7, {}, [], ['a1b2c3d4e5f6'], true]) {
    assert.equal(isHermesJobId(value), false)
    assert.equal(isJobLabel(value), false)
  }
})

test('jobs parity: the board reads the shared sample exactly as the contract describes it', () => {
  const shaped = shapeJobs([file('mac-mini', fixture.sample)], NOW)
  assert.equal(shaped.status, 'ok')
  assert.equal(shaped.computers.length, 1)
  const [mac] = shaped.computers
  assert.equal(mac.computer, 'Mac Mini')
  assert.equal(mac.takenAt, TAKEN)
  assert.equal(mac.freshness, 'fresh')
  assert.equal(mac.timezone, 'America/New_York')
  assert.equal(mac.launchd.status, 'found')
  assert.equal(mac.launchd.hidden, 1)
  assert.equal(mac.launchd.more, 0)
  assert.deepEqual(mac.launchd.items.map((item) => item.label), fixture.sample.launchd.items.map((item) => item.label))
  assert.deepEqual(mac.hermes.items.map((item) => `${item.profile}/${item.id}`), ['default/a1b2c3d4e5f6', 'donna/b2c3d4e5f6a1', 'donna/c3d4e5f6a1b2'])
  assert.deepEqual(mac.hermes.items.map((item) => item.name), fixture.sample.hermes.items.map((item) => item.name))
  // The row the collector marks as its own, the paused one, and the one that is not loaded: each
  // keeps the facts it was written with and nothing is invented for the rest.
  const byLabel = Object.fromEntries(mac.launchd.items.map((item) => [item.label, item]))
  assert.deepEqual(byLabel['local.donna.agent-status-collector'].self, true)
  assert.deepEqual(byLabel['local.donna.story-belt-daily'], {
    label: 'local.donna.story-belt-daily',
    cadence: { kind: 'slots', slots: [{ minute: 15, hour: 6, weekday: null, day: null }] },
    state: 'loaded',
    lastExit: 0,
    lastReportAt: '2026-10-09T10:15:22Z',
    dueAt: '2026-10-09T10:15:00Z',
    dueBeforeAt: '2026-10-08T10:15:00Z',
    self: false,
    disabled: false
  })
  assert.deepEqual(byLabel['local.donna.security-changelog'], {
    label: 'local.donna.security-changelog',
    cadence: { kind: 'always' },
    state: 'running',
    lastExit: null,
    lastReportAt: '2026-10-09T14:50:02Z',
    dueAt: null,
    dueBeforeAt: null,
    self: false,
    disabled: false
  })
  assert.equal(byLabel['local.donna.paused-draft'].disabled, true)
  assert.equal(byLabel['local.donna.paused-draft'].dueAt, null)
  assert.deepEqual(mac.hermes.items[2], {
    profile: 'donna',
    id: 'c3d4e5f6a1b2',
    name: 'Hermes job c3d4e5f6a1b2',
    enabled: false,
    cadence: { kind: 'unknown' },
    lastRunAt: null,
    lastResult: 'unknown',
    dueAt: null,
    dueBeforeAt: null
  })
})

test('jobs parity: nothing the board outputs carries a key the contract does not list', () => {
  const [mac] = shapeJobs([file('mac-mini', fixture.sample)], NOW).computers
  const allowedItem = (keys) => (item) => assert.deepEqual(Object.keys(item).sort(), [...keys].sort())
  mac.launchd.items.forEach(allowedItem(fixture.allowedKeys.launchdItem))
  mac.hermes.items.forEach(allowedItem(fixture.allowedKeys.hermesItem))
  for (const item of [...mac.launchd.items, ...mac.hermes.items]) {
    if (item.cadence.kind === 'slots') item.cadence.slots.forEach((slot) => assert.deepEqual(Object.keys(slot).sort(), [...fixture.allowedKeys.slot].sort()))
  }
})

test('jobs parity: the file name is the computer, in the form the collector writes it', () => {
  assert.equal(isJobsFile(`${JOBS_FOLDER}/mac-mini.json`), true)
  assert.equal(isJobsFile(`${JOBS_FOLDER}/Mac Mini.json`), false)
  assert.equal(isJobsFile(`${JOBS_FOLDER}/${'a'.repeat(33)}.json`), false)
  assert.equal(isJobsFile(`${JOBS_FOLDER}/mac-mini.txt`), false)
  assert.equal(isJobsFile('.agent-team/status/hermes/mac-mini.json'), false)
  assert.equal(isJobsFile(`${JOBS_FOLDER}/sub/mac-mini.json`), false)
  assert.equal(isJobsFile(undefined), false)
})

/* ---------- the envelope: the same rules as every other reading ------------------------------- */

test('no jobs files at all reads as none, with a sentence', () => {
  for (const files of [[], undefined, null]) {
    const shaped = shapeJobs(files, NOW, 0)
    assert.equal(shaped.status, 'none')
    assert.match(shaped.why, /No jobs reading has been taken yet\./)
    assert.deepEqual(shaped.computers, [])
  }
})

test('a file that could not be used says which way, in a finished sentence', () => {
  const cases = [
    [null, /could not be fetched, or was too big/],
    ['{ not json', /could not be read/],
    ['[]', /could not be read/],
    [JSON.stringify({ ...fixture.sample, schema: 'agent-status/jobs/v2' }), /format this board does not know/],
    [JSON.stringify({ ...fixture.sample, takenAt: undefined }), /does not say when it was taken/],
    [JSON.stringify({ ...fixture.sample, takenAt: 'yesterday' }), /does not say when it was taken/],
    [JSON.stringify({ ...fixture.sample, takenAt: hoursBefore(-1) }), /stamped in the future/]
  ]
  for (const [body, pattern] of cases) {
    // A null body is a file the tree listed and the fetch could not return, not the text "null".
    const shaped = shapeJobs([body === null ? [`${JOBS_FOLDER}/mac-mini.json`, null] : file('mac-mini', body)], NOW, 1)
    assert.equal(shaped.status, 'unusable', String(body).slice(0, 40))
    assert.match(shaped.why, pattern)
    assert.match(shaped.why, /^A jobs file /)
    assert.deepEqual(shaped.computers, [])
    assert.equal(shaped.unreadable, 1)
  }
})

test('a file over 64 KB is refused whatever it holds, and one under it is read', () => {
  const big = JSON.stringify({ ...fixture.sample, padding: 'x'.repeat(JOBS_MAX_BYTES) })
  assert.ok(Buffer.byteLength(big) > JOBS_MAX_BYTES)
  assert.match(shapeJobs([file('mac-mini', big)], NOW).why, /too big to read/)
  assert.equal(shapeJobs([file('mac-mini', fixture.sample)], NOW).status, 'ok')
})

test('a reading older than eight hours is stale: shown as not checked, never as a fresh one', () => {
  const eightHours = oneComputer({ ...clone(fixture.sample), takenAt: hoursBefore(8) })
  assert.equal(eightHours.freshness, 'fresh')
  const older = oneComputer({ ...clone(fixture.sample), takenAt: hoursBefore(8, NOW - 1000) })
  assert.equal(older.freshness, 'stale')
  assert.equal(JOBS_STALE_AFTER_HOURS, 8)
})

test('only the first five files are read, in name order, and the rest are counted', () => {
  const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((slug) => file(slug, { ...clone(fixture.sample), computer: `Mac ${slug}` }))
  const shaped = shapeJobs(files.reverse(), NOW, 7)
  assert.equal(shaped.read, JOBS_MAX_FILES)
  assert.equal(shaped.skipped, 2)
  assert.equal(shaped.computers.length, JOBS_MAX_COMPUTERS)
  assert.equal(shaped.notShown, 2)
})

test('the newest three computers are shown, newest first', () => {
  const stamp = (minutes) => new Date(Date.parse(TAKEN) - minutes * 60_000).toISOString().replace('.000Z', 'Z')
  const files = [['a', 40], ['b', 10], ['c', 30], ['d', 20]].map(([slug, minutes]) => file(slug, { ...clone(fixture.sample), computer: `Mac ${slug}`, takenAt: stamp(minutes) }))
  const shaped = shapeJobs(files, NOW, 4)
  assert.deepEqual(shaped.computers.map((computer) => computer.computer), ['Mac b', 'Mac d', 'Mac c'])
  assert.equal(shaped.notShown, 1)
})

test('one unusable file among good ones is counted, and the good ones still show', () => {
  const shaped = shapeJobs([file('a', '{ broken'), file('b', fixture.sample)], NOW, 2)
  assert.equal(shaped.status, 'ok')
  assert.equal(shaped.unreadable, 1)
  assert.equal(shaped.computers.length, 1)
})

/* ---------- blocks and the reasons they give --------------------------------------------------- */

test('a block that found nothing carries a status and, at most, one of the two fixed reasons', () => {
  const computer = oneComputer(withJobs({
    launchd: { status: 'unavailable', why: JOBS_WHY_CODES.refused },
    hermes: { status: 'not found' }
  }))
  assert.deepEqual(computer.launchd, { status: 'unavailable', why: 'refused by the safety check', items: [], hidden: 0, more: 0 })
  assert.deepEqual(computer.hermes, { status: 'not found', why: null, items: [], hidden: 0, more: 0 })
})

test('a reason that is not one of the two fixed ones is never passed on, whatever it says', () => {
  for (const why of [FAKE.prompt, FAKE.home, 'Error: ' + FAKE.token, '', 7, null, { code: 'could not be read' }]) {
    const computer = oneComputer(withJobs({ launchd: { status: 'unavailable', why }, hermes: { status: 'unavailable', why } }))
    assert.equal(computer.launchd.why, null)
    assert.equal(computer.hermes.why, null)
    assert.equal(computer.launchd.status, 'unavailable')
  }
})

test('a status the board does not know is unavailable, and a missing block is not found', () => {
  const unknown = oneComputer(withJobs({ launchd: { status: 'toString' }, hermes: { status: 'maybe', items: [hermesJob()] } }))
  assert.equal(unknown.launchd.status, 'unavailable')
  assert.equal(unknown.hermes.status, 'unavailable')
  assert.deepEqual(unknown.hermes.items, [])
  const doc = withJobs()
  delete doc.launchd
  doc.hermes = 'found'
  const missing = oneComputer(doc)
  assert.equal(missing.launchd.status, 'not found')
  assert.equal(missing.hermes.status, 'unavailable')
})

test('a found block whose counts or list are the wrong shape is not a list the board can vouch for', () => {
  for (const block of [
    { status: 'found', items: 'nope', hidden: 0, more: 0 },
    { status: 'found', items: [], hidden: -1, more: 0 },
    { status: 'found', items: [], hidden: 0, more: 1.5 },
    { status: 'found', items: [], hidden: 0 },
    { status: 'found', items: [], hidden: 1e9, more: 0 }
  ]) {
    const computer = oneComputer(withJobs({ launchd: block }))
    assert.equal(computer.launchd.status, 'unavailable', JSON.stringify(block))
    assert.deepEqual(computer.launchd.items, [])
  }
})

test('hidden and more are the collector\'s counts plus what the board itself refuses or cuts', () => {
  const doc = withJobs({ launchdItems: [launchd(), launchd({ label: 'local.' + FAKE.email })] })
  doc.launchd.hidden = 2
  doc.launchd.more = 3
  const computer = oneComputer(doc)
  assert.equal(computer.launchd.items.length, 1)
  assert.equal(computer.launchd.hidden, 3)
  assert.equal(computer.launchd.more, 3)
})

test('past the cap, jobs are counted in more and the file\'s own order stands', () => {
  const many = Array.from({ length: JOBS_CAPS.launchd + 5 }, (_, index) => launchd({ label: `local.donna.job-${String(index).padStart(3, '0')}` }))
  const computer = oneComputer(withJobs({ launchdItems: many }))
  assert.equal(computer.launchd.items.length, JOBS_CAPS.launchd)
  assert.equal(computer.launchd.more, 5)
  assert.equal(computer.launchd.items[0].label, 'local.donna.job-000')
  const hexes = Array.from({ length: JOBS_CAPS.hermes + 2 }, (_, index) => {
    const id = index.toString(16).padStart(12, '0')
    return hermesJob({ id, name: `Hermes job ${id}` })
  })
  const hermes = oneComputer(withJobs({ hermesItems: hexes })).hermes
  assert.equal(hermes.items.length, JOBS_CAPS.hermes)
  assert.equal(hermes.more, 2)
})

test('a job listed twice is shown once and the second is counted as hidden', () => {
  const computer = oneComputer(withJobs({ launchdItems: [launchd(), launchd({ state: 'running' })], hermesItems: [hermesJob(), hermesJob({ enabled: false })] }))
  assert.equal(computer.launchd.items.length, 1)
  assert.equal(computer.launchd.items[0].state, 'loaded')
  assert.equal(computer.launchd.hidden, 1)
  assert.equal(computer.hermes.items.length, 1)
  assert.equal(computer.hermes.hidden, 1)
})

test('the same Hermes id under two profiles is two jobs, and the same label under two computers is two', () => {
  const computer = oneComputer(withJobs({ hermesItems: [hermesJob(), hermesJob({ profile: 'donna' })] }))
  assert.equal(computer.hermes.items.length, 2)
  assert.equal(computer.hermes.hidden, 0)
})

/* ---------- names: nothing that could be a secret or a prompt gets through -------------------- */

test('a label that is not plainly a label is dropped and counted, and the rest of the list stands', () => {
  const bad = [
    'local.' + FAKE.email, FAKE.token, FAKE.jwt, FAKE.bearer, FAKE.uuid, FAKE.url, FAKE.home, FAKE.windows,
    'local.desk-helper', 'local.donna job', '', ' local.donna.x', 'x'.repeat(61), 'local.' + 'a'.repeat(24)
  ]
  const computer = oneComputer(withJobs({ launchdItems: [launchd(), ...bad.map((label) => launchd({ label }))] }))
  assert.deepEqual(computer.launchd.items.map((item) => item.label), ['local.donna.story-belt-daily'])
  assert.equal(computer.launchd.hidden, bad.length)
  assert.deepEqual(leaks(computer), [])
})

test('a Hermes job is shown only under the name "Hermes job <id>", whatever the file says', () => {
  const stored = [FAKE.prompt, 'Hermes job', 'Hermes job b2c3d4e5f6a1', 'hermes job a1b2c3d4e5f6', 'Hermes job a1b2c3d4e5f6 ', 'Hermes job a1b2c3d4e5f6\n' + FAKE.prompt, 'YouTube morning brief', '', null, undefined, 7]
  const computer = oneComputer(withJobs({ hermesItems: [hermesJob(), ...stored.map((name, index) => hermesJob({ id: `00000000000${index.toString(16)}`, name }))] }))
  assert.deepEqual(computer.hermes.items.map((item) => item.name), ['Hermes job a1b2c3d4e5f6'])
  assert.equal(computer.hermes.hidden, stored.length)
  assert.deepEqual(leaks(computer), [])
})

test('a Hermes id that is not the 12 lowercase hex characters Hermes makes is dropped and counted', () => {
  const ids = fixture.names.hermesIdRefuse.map((entry) => entry.id)
  const items = [hermesJob(), ...ids.map((id) => hermesJob({ id, name: `Hermes job ${id}` }))]
  const computer = oneComputer(withJobs({ hermesItems: items }))
  assert.deepEqual(computer.hermes.items.map((item) => item.id), ['a1b2c3d4e5f6'])
  assert.equal(computer.hermes.hidden, ids.length)
  // The block stands: one withheld job does not turn the others into "unavailable".
  assert.equal(computer.hermes.status, 'found')
})

test('a Hermes profile that is not plainly a profile name is dropped and counted', () => {
  const profiles = ['', 'Donna', 'a/b', FAKE.email, FAKE.token, 'x'.repeat(65), '../x', 'sk-profile']
  const computer = oneComputer(withJobs({ hermesItems: [hermesJob(), ...profiles.map((profile) => hermesJob({ profile }))] }))
  assert.deepEqual(computer.hermes.items.map((item) => item.profile), ['default'])
  assert.equal(computer.hermes.hidden, profiles.length)
})

test('the computer\'s name is held to the same rule, and is no name when it fails', () => {
  assert.equal(oneComputer({ ...clone(fixture.sample), computer: FAKE.email }).computer, null)
  assert.equal(oneComputer({ ...clone(fixture.sample), computer: 'Mac Mini' }).computer, 'Mac Mini')
})

test('planted secrets in keys the board does not know never reach the output', () => {
  const doc = withJobs()
  doc.extra = FAKE.token
  doc.launchd.note = FAKE.prompt
  doc.launchd.items[0].ProgramArguments = ['--token', FAKE.token]
  doc.launchd.items[0].EnvironmentVariables = { KEY: FAKE.token }
  doc.launchd.items[0].path = FAKE.home
  doc.launchd.items[0].cadence.note = FAKE.prompt
  doc.hermes.items[0].prompt = FAKE.prompt
  doc.hermes.items[0].last_error = `${FAKE.windows} ${FAKE.bearer}`
  doc.hermes.items[0].cadence.slots[0].note = FAKE.prompt
  const computer = oneComputer(doc)
  assert.deepEqual(leaks(computer), [])
  assert.deepEqual(Object.keys(computer.launchd.items[0]).sort(), [...fixture.allowedKeys.launchdItem].sort())
})

test('a key that is also an object method is not a state, a result or a kind', () => {
  const computer = oneComputer(withJobs({
    launchdItems: [launchd({ state: 'toString' }), launchd({ label: 'local.donna.b', state: '__proto__' })],
    hermesItems: [hermesJob({ lastResult: 'constructor' })]
  }))
  assert.deepEqual(computer.launchd.items, [])
  assert.equal(computer.launchd.hidden, 2)
  assert.deepEqual(computer.hermes.items, [])
  const kind = oneComputer(withJobs({ launchdItems: [launchd({ cadence: { kind: 'toString' } })] }))
  assert.deepEqual(kind.launchd.items[0].cadence, { kind: 'unknown' })
})

/* ---------- facts: states, exit codes, times, cadences ----------------------------------------- */

test('a launchd job with a state the contract does not name is not shown', () => {
  const computer = oneComputer(withJobs({ launchdItems: [launchd({ state: 'crashed' }), launchd({ label: 'local.donna.b', state: undefined })] }))
  assert.deepEqual(computer.launchd.items, [])
  assert.equal(computer.launchd.hidden, 2)
})

test('a last exit code is a whole number from -255 to 255, only for a job launchctl lists', () => {
  const exit = (state, lastExit) => oneComputer(withJobs({ launchdItems: [launchd({ state, lastExit })] })).launchd.items[0].lastExit
  assert.equal(exit('loaded', 0), 0)
  assert.equal(exit('loaded', 78), 78)
  assert.equal(exit('loaded', -255), -255)
  assert.equal(exit('loaded', 255), 255)
  assert.equal(exit('running', 1), 1)
  for (const bad of [256, -256, 19968, 1.5, '1', null, NaN, Infinity, true]) assert.equal(exit('loaded', bad), null, String(bad))
  // A job that is not listed has no last exit to report.
  assert.equal(exit('not loaded', 1), null)
})

test('a time is read as the collector writes it, and a time that cannot be right is no time', () => {
  const times = (patch) => oneComputer(withJobs({ launchdItems: [launchd(patch)], hermesItems: [] })).launchd.items[0]
  assert.equal(times({ lastReportAt: '2026-10-09T10:15:22Z' }).lastReportAt, '2026-10-09T10:15:22Z')
  assert.equal(times({ lastReportAt: '2026-10-09T06:15:22-04:00' }).lastReportAt, '2026-10-09T10:15:22Z')
  for (const bad of ['yesterday', '7 Oct', 1760000000, null, {}, hoursBefore(-2), '2026-10-09']) assert.equal(times({ lastReportAt: bad }).lastReportAt, null, String(bad))
})

test('expected-run times: kept only where the contract gives them, and never in the future or past the look-back', () => {
  const due = (patch, extra = {}) => oneComputer(withJobs({ launchdItems: [launchd(patch)], hermesItems: [], ...extra })).launchd.items[0]
  assert.deepEqual([due({}).dueAt, due({}).dueBeforeAt], ['2026-10-09T10:15:00Z', '2026-10-08T10:15:00Z'])
  // dueBeforeAt is always earlier than dueAt, and has no meaning without it.
  assert.equal(due({ dueBeforeAt: '2026-10-09T11:00:00Z' }).dueBeforeAt, null)
  assert.equal(due({ dueBeforeAt: '2026-10-09T10:15:00Z' }).dueBeforeAt, null)
  const noAt = due({ dueAt: undefined })
  assert.deepEqual([noAt.dueAt, noAt.dueBeforeAt], [null, null])
  // The latest expected run is at or before the check minus the grace.
  const late = due({ dueAt: '2026-10-09T14:30:00Z', dueBeforeAt: '2026-10-09T10:15:00Z' })
  assert.deepEqual([late.dueAt, late.dueBeforeAt], ['2026-10-09T14:30:00Z', '2026-10-09T10:15:00Z'])
  const tooNear = due({ dueAt: '2026-10-09T14:30:01Z', dueBeforeAt: '2026-10-09T10:15:00Z' })
  assert.deepEqual([tooNear.dueAt, tooNear.dueBeforeAt], [null, null])
  const future = due({ dueAt: '2026-10-10T10:15:00Z', dueBeforeAt: '2026-10-09T10:15:00Z' })
  assert.deepEqual([future.dueAt, future.dueBeforeAt], [null, null])
  const ancient = due({ dueAt: '2026-08-01T10:15:00Z', dueBeforeAt: '2026-07-31T10:15:00Z' })
  assert.deepEqual([ancient.dueAt, ancient.dueBeforeAt], [null, null])
  const notTimes = due({ dueAt: 'soon', dueBeforeAt: 5 })
  assert.deepEqual([notTimes.dueAt, notTimes.dueBeforeAt], [null, null])
})

test('a job with no schedule to judge has no expected-run times, even if the file gave some', () => {
  const given = { dueAt: '2026-10-09T10:15:00Z', dueBeforeAt: '2026-10-08T10:15:00Z' }
  for (const cadence of [{ kind: 'always' }, { kind: 'unknown' }, { kind: 'toString' }, null, 'daily']) {
    const item = oneComputer(withJobs({ launchdItems: [launchd({ cadence, ...given })], hermesItems: [] })).launchd.items[0]
    assert.deepEqual([item.dueAt, item.dueBeforeAt], [null, null], JSON.stringify(cadence))
  }
  const disabled = oneComputer(withJobs({ launchdItems: [launchd({ state: 'not loaded', disabled: true, ...given })], hermesItems: [] })).launchd.items[0]
  assert.deepEqual([disabled.dueAt, disabled.dueBeforeAt], [null, null])
  const off = oneComputer(withJobs({ hermesItems: [hermesJob({ enabled: false, ...given })] })).hermes.items[0]
  assert.deepEqual([off.dueAt, off.dueBeforeAt], [null, null])
})

test('"disabled" counts only for a job launchctl does not list, and "self" only as true', () => {
  const item = (patch) => oneComputer(withJobs({ launchdItems: [launchd(patch)], hermesItems: [] })).launchd.items[0]
  assert.equal(item({ state: 'not loaded', disabled: true }).disabled, true)
  assert.equal(item({ state: 'loaded', disabled: true }).disabled, false)
  assert.equal(item({ state: 'running', disabled: true }).disabled, false)
  assert.equal(item({ state: 'not loaded', disabled: 'true' }).disabled, false)
  assert.equal(item({ self: true }).self, true)
  for (const bad of [false, 'true', 1, null, {}]) assert.equal(item({ self: bad }).self, false)
})

test('a cadence the board can read is kept in full; one it cannot is "unknown", never guessed at', () => {
  const cadence = (value) => oneComputer(withJobs({ launchdItems: [launchd({ cadence: value })], hermesItems: [] })).launchd.items[0].cadence
  assert.deepEqual(cadence({ kind: 'always' }), { kind: 'always' })
  assert.deepEqual(cadence({ kind: 'every', minutes: 15 }), { kind: 'every', minutes: 15 })
  assert.deepEqual(cadence({ kind: 'every', minutes: 1 }), { kind: 'every', minutes: 1 })
  assert.deepEqual(cadence({ kind: 'every', minutes: 44640 }), { kind: 'every', minutes: 44640 })
  assert.deepEqual(cadence({ kind: 'slots', slots: [{ minute: 45, hour: 7, weekday: 1 }, { minute: 0, day: 31 }, { minute: 5 }] }), {
    kind: 'slots',
    slots: [
      { minute: 45, hour: 7, weekday: 1, day: null },
      { minute: 0, hour: null, weekday: null, day: 31 },
      { minute: 5, hour: null, weekday: null, day: null }
    ]
  })
  assert.deepEqual(cadence({ kind: 'unknown' }), { kind: 'unknown' })
  const unknown = { kind: 'unknown' }
  for (const bad of [
    { kind: 'every', minutes: 0 }, { kind: 'every', minutes: 44641 }, { kind: 'every', minutes: 1.5 }, { kind: 'every', minutes: '15' }, { kind: 'every' },
    { kind: 'slots' }, { kind: 'slots', slots: [] }, { kind: 'slots', slots: 'x' }, { kind: 'slots', slots: [null] },
    { kind: 'slots', slots: [{ hour: 6 }] },
    { kind: 'slots', slots: [{ minute: 60 }] }, { kind: 'slots', slots: [{ minute: -1 }] }, { kind: 'slots', slots: [{ minute: '0' }] },
    { kind: 'slots', slots: [{ minute: 0, hour: 24 }] }, { kind: 'slots', slots: [{ minute: 0, weekday: 7 }] }, { kind: 'slots', slots: [{ minute: 0, day: 0 }] },
    { kind: 'slots', slots: [{ minute: 0, day: 32 }] }, { kind: 'slots', slots: [{ minute: 0, weekday: 1, day: 1 }] },
    { kind: 'slots', slots: Array.from({ length: 49 }, () => ({ minute: 0 })) },
    { kind: 'slots', slots: [{ minute: 0 }, { minute: 99 }] },
    'daily', 7, [], null, undefined, {}
  ]) assert.deepEqual(cadence(bad), unknown, JSON.stringify(bad))
  assert.equal(JOBS_CAPS.slots, 48)
  assert.deepEqual(cadence({ kind: 'slots', slots: Array.from({ length: 48 }, (_, minute) => ({ minute })) }).slots.length, 48)
})

test('a Hermes job needs its on/off flag and its last result, and keeps what the collector wrote', () => {
  const items = oneComputer(withJobs({ hermesItems: [hermesJob({ enabled: 'yes', id: '000000000001', name: 'Hermes job 000000000001' }), hermesJob({ lastResult: 'failed', id: '000000000002', name: 'Hermes job 000000000002' }), hermesJob()] })).hermes
  assert.deepEqual(items.items.map((item) => item.id), ['a1b2c3d4e5f6'])
  assert.equal(items.hidden, 2)
  const [job] = items.items
  assert.deepEqual(job, {
    profile: 'default',
    id: 'a1b2c3d4e5f6',
    name: 'Hermes job a1b2c3d4e5f6',
    enabled: true,
    cadence: { kind: 'slots', slots: [{ minute: 30, hour: 6, weekday: null, day: null }] },
    lastRunAt: '2026-10-09T10:30:04Z',
    lastResult: 'ok',
    dueAt: '2026-10-09T10:30:00Z',
    dueBeforeAt: '2026-10-08T10:30:00Z'
  })
  for (const result of fixture.hermesResults) {
    const shown = oneComputer(withJobs({ hermesItems: [hermesJob({ lastResult: result })] })).hermes.items[0]
    assert.equal(shown.lastResult, result)
  }
})

test('the time zone is carried only when it is one this runtime knows', () => {
  assert.equal(oneComputer({ ...clone(fixture.sample), timezone: 'Europe/Lisbon' }).timezone, 'Europe/Lisbon')
  assert.equal(oneComputer({ ...clone(fixture.sample), timezone: 'UTC' }).timezone, 'UTC')
  for (const bad of ['Mars/Olympus_Mons', FAKE.email, 'EST5EDT; drop', '', null, 7, undefined]) assert.equal(oneComputer({ ...clone(fixture.sample), timezone: bad }).timezone, null, String(bad))
})

/* ---------- the owner's names and hiding: jobs.yml -------------------------------------------- */

test('jobs.yml: a name or a hide, by the id the starter file explains', () => {
  const doc = {
    jobs: [
      { id: 'hermes:default/a1b2c3d4e5f6', name: 'YouTube morning brief' },
      { id: 'launchd:local.donna.story-belt-daily', name: 'Story belt, daily' },
      { id: 'hermes:donna/b2c3d4e5f6a1', hide: true },
      { id: 'workflow:weekly-review', name: 'Weekly review' },
      { id: 'routine:old-experiment', hide: true },
      { id: 'routine:Old experiment', name: 'Old one' }
    ]
  }
  const shaped = shapeJobOverrides(doc)
  assert.deepEqual({ ...shaped.names }, {
    'hermes:default/a1b2c3d4e5f6': 'YouTube morning brief',
    'launchd:local.donna.story-belt-daily': 'Story belt, daily',
    'workflow:weekly-review': 'Weekly review',
    'routine:Old experiment': 'Old one'
  })
  assert.deepEqual(shaped.hidden.sort(), ['hermes:donna/b2c3d4e5f6a1', 'routine:old-experiment'])
  assert.equal(shaped.ignored, 0)
})

test('jobs.yml: an empty or missing file changes nothing', () => {
  for (const doc of [null, undefined, {}, { jobs: [] }, { jobs: 'x' }, { jobs: {} }, [], 'jobs: []']) {
    assert.deepEqual(plain(shapeJobOverrides(doc)), { names: {}, hidden: [], ignored: 0 })
  }
})

test('jobs.yml: an entry the board cannot use is ignored and counted, and the rest still apply', () => {
  const ok = { id: 'launchd:local.donna.good', name: 'Good' }
  const doc = {
    jobs: [
      ok,
      null,
      'launchd:local.donna.x',
      7,
      { name: 'No id' },
      { id: 7, name: 'Number id' },
      { id: 'launchd:', name: 'Empty label' },
      { id: 'launchd:local donna', name: 'Spaced label' },
      { id: 'launchd:local.' + FAKE.email, name: 'Email label' },
      { id: 'hermes:default/not-hex', name: 'Word-like Hermes id' },
      { id: 'hermes:Default/a1b2c3d4e5f6', name: 'Capital profile' },
      { id: 'hermes:a1b2c3d4e5f6', name: 'No profile' },
      { id: 'cron:daily', name: 'Another kind of id' },
      { id: 'workflow:', name: 'Empty slug' },
      { id: 'workflow:has space', name: 'Spaced slug' },
      { id: 'routine:', hide: true },
      { id: 'routine:' + 'x'.repeat(101), hide: true },
      { id: 'routine:badname', hide: true },
      { id: 'launchd:local.donna.nothing' },
      { id: 'launchd:local.donna.falsy', hide: false },
      { id: 'launchd:local.donna.good', name: 'Second try' }
    ]
  }
  const shaped = shapeJobOverrides(doc)
  assert.deepEqual({ ...shaped.names }, { 'launchd:local.donna.good': 'Good' })
  assert.deepEqual(shaped.hidden, [])
  assert.equal(shaped.ignored, doc.jobs.length - 1)
})

test('jobs.yml: a name that could be a secret or markup is dropped, and a hide beside it still applies', () => {
  const bad = ['x'.repeat(61), FAKE.email, FAKE.token, FAKE.bearer, FAKE.uuid, FAKE.url, FAKE.home, 'a/b', '<b>bold</b>x', 'desk-helper sk-1', '', '   ', 7, true, {}, ['a']]
  for (const name of bad) {
    const shaped = shapeJobOverrides({ jobs: [{ id: 'launchd:local.donna.x', name, hide: true }] })
    assert.deepEqual({ ...shaped.names }, {}, String(name))
    assert.deepEqual(shaped.hidden, ['launchd:local.donna.x'])
    assert.equal(shaped.ignored, 1)
    assert.deepEqual(leaks(shaped), [])
  }
})

test('jobs.yml: a name that is also a hide is a hide, and nothing else is read from an entry', () => {
  const shaped = shapeJobOverrides({ jobs: [{ id: 'workflow:weekly-review', name: 'Weekly review', hide: true, color: 'red', prompt: FAKE.prompt }] })
  assert.deepEqual(shaped.hidden, ['workflow:weekly-review'])
  assert.deepEqual({ ...shaped.names }, { 'workflow:weekly-review': 'Weekly review' })
  assert.deepEqual(leaks(shaped), [])
})

test('jobs.yml: an id that is also an object method is no special case', () => {
  const shaped = shapeJobOverrides({ jobs: [{ id: 'workflow:__proto__', name: 'Proto' }, { id: 'workflow:constructor', name: 'Ctor' }, { id: 'workflow:toString', hide: true }] })
  assert.equal(Object.getPrototypeOf(shaped.names), null)
  assert.deepEqual(Object.keys(shaped.names).sort(), ['workflow:__proto__', 'workflow:constructor'])
  assert.deepEqual(shaped.hidden, ['workflow:toString'])
  assert.equal(({}).polluted, undefined)
})

test('jobs.yml: only the first two hundred entries are read', () => {
  const jobs = Array.from({ length: 205 }, (_, index) => ({ id: `launchd:local.donna.job-${index}`, name: `Job ${index}` }))
  const shaped = shapeJobOverrides({ jobs })
  assert.equal(Object.keys(shaped.names).length, 200)
  assert.equal(shaped.ignored, 5)
})
