// Usage meters: the readings the collector commits to .agent-team/status/usage/, and what the board
// will and will not say about them.
//
// The collector in the team repo has its own fail-closed gate. This board does not lean on it. The
// file arrives through a repo anybody with push access can edit, and the payload it becomes goes to
// a browser on a board that can be public - so every key, number and name is checked again here,
// and anything that does not pass is dropped rather than shown.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  shapeUsage,
  isUsageFile,
  USAGE_SCHEMA,
  USAGE_FOLDER,
  USAGE_COMPUTER_SLUG,
  USAGE_STALE_AFTER_HOURS,
  USAGE_MAX_FILES,
  USAGE_MAX_STRING,
  USAGE_STATUSES,
  USAGE_SOURCES,
  USAGE_WINDOWS
} from '../api/state.js'

const NOW = Date.parse('2026-10-07T22:00:00Z')
const hoursBefore = (hours) => new Date(NOW - hours * 3600_000).toISOString()
const hoursAfter = (hours) => new Date(NOW + hours * 3600_000).toISOString()

// Assembled at runtime, so no file in this repo carries a token shape a secret scanner would flag.
export const FAKE = {
  token: ['sk', 'ant', 'oat01', 'Zm9vYmFyYmF6cXV4'.repeat(3)].join('-'),
  jwt: 'ey' + 'J' + 'hbGciOiJIUzI1NiJ9.' + 'eyJlbWFpbCI6ImZha2UifQ',
  email: 'fake.person' + '@' + 'example.com',
  bearer: 'Bear' + 'er ' + 'abc123def456',
  uuid: ['5f0c2b1e', '9a7d', '4c3b', '8e21', '0d6f4a9b7c55'].join('-'),
  home: '/Users/' + 'fakeperson',
  windows: 'C:' + '\\Users\\' + 'fakeperson'
}
const PLANTED = Object.values(FAKE)

function reading(over = {}) {
  return {
    schema: USAGE_SCHEMA,
    takenAt: hoursBefore(2),
    computer: 'Mac Mini',
    claude: {
      plan: { status: 'found', name: 'Max 20x' },
      limits: {
        status: 'found',
        source: 'unofficial-live',
        readAt: hoursBefore(2),
        windows: [
          { kind: 'five_hour', usedPercent: 18, resetsAt: hoursAfter(1) },
          { kind: 'weekly_all', usedPercent: 49, resetsAt: hoursAfter(48) },
          { kind: 'weekly_model', model: 'Fable', usedPercent: 2, resetsAt: hoursAfter(48) }
        ]
      },
      activity: {
        status: 'found',
        estimate: true,
        timezone: 'America/New_York',
        days: [
          { day: '2026-10-07', sessions: 4, replies: 120, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, byModel: { opus: 1, sonnet: 0, haiku: 0, other: 0 } },
          { day: '2026-10-06', sessions: 2, replies: 30, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, byModel: { opus: 1, sonnet: 0, haiku: 0, other: 0 } },
          // Outside the last seven days of the reading, so not in the week's count.
          { day: '2026-09-20', sessions: 9, replies: 900, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, byModel: { opus: 1, sonnet: 0, haiku: 0, other: 0 } }
        ]
      }
    },
    codex: {
      plan: { status: 'found', name: 'Pro' },
      limits: {
        status: 'found',
        source: 'codex-session-log',
        readAt: hoursBefore(9),
        windows: [{ kind: 'weekly', usedPercent: 0, resetsAt: hoursAfter(100) }]
      }
    },
    ...over
  }
}

const file = (slug, body) => [`${USAGE_FOLDER}/${slug}.json`, typeof body === 'string' ? body : JSON.stringify(body)]

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

const usageFixtureUrl = new URL('./fixtures/usage-parity.json', import.meta.url)
const usageFixture = JSON.parse(readFileSync(usageFixtureUrl, 'utf8'))

test('usage parity: the board reads the contract the collector writes to', () => {
  assert.equal(USAGE_SCHEMA, usageFixture.schema)
  assert.equal(USAGE_FOLDER, usageFixture.folder)
  assert.equal(USAGE_COMPUTER_SLUG.source, usageFixture.computerSlug)
  assert.equal(USAGE_MAX_STRING, usageFixture.maxStringLength)
  assert.equal(USAGE_STALE_AFTER_HOURS, usageFixture.staleAfterHours)
  assert.equal(USAGE_MAX_FILES, usageFixture.maxFilesRead)
  assert.deepEqual(USAGE_STATUSES, usageFixture.statuses)
  assert.deepEqual(USAGE_SOURCES, usageFixture.sources)
  assert.deepEqual(USAGE_WINDOWS, usageFixture.windows)
})

test('the two repos hold the same usage contract, byte for byte', (t) => {
  const sibling = fileURLToPath(
    new URL('../../agent-team-template/tests/fixtures/usage-parity.json', import.meta.url)
  )
  if (!existsSync(sibling)) {
    t.skip('agent-team-template is not checked out beside this repo')
    return
  }
  assert.equal(
    readFileSync(sibling, 'utf8'),
    readFileSync(usageFixtureUrl, 'utf8'),
    'the shared contract has been edited on one side only - that is the drift, one level up'
  )
})

test('only a file named for one computer in the usage folder is a usage file', () => {
  assert.equal(isUsageFile('.agent-team/status/usage/mac-mini.json'), true)
  for (const path of [
    '.agent-team/status/usage/Mac Mini.json',
    '.agent-team/status/usage/../routines.json',
    '.agent-team/status/usage/nested/mac.json',
    '.agent-team/status/usage/mac.json.bak',
    `.agent-team/status/usage/${'a'.repeat(33)}.json`,
    '.agent-team/status/connections/mac-mini.json',
    'agent-team/status/usage/mac-mini.json'
  ]) {
    assert.equal(isUsageFile(path), false, path)
  }
})

/* ---------- states ---------------------------------------------------------------------------- */

test('no usage files says so, and invents no reading', () => {
  const usage = shapeUsage([], NOW)
  assert.equal(usage.status, 'none')
  assert.match(usage.why, /^No usage reading has been taken yet\.$/)
  assert.equal(usage.claude, null)
  assert.equal(usage.codex, null)
})

test('a fresh reading comes through with its computer, its age and every window', () => {
  const usage = shapeUsage([file('mac-mini', reading())], NOW)
  assert.equal(usage.status, 'ok')
  const claude = usage.claude
  assert.equal(claude.computer, 'Mac Mini')
  assert.equal(claude.stale, false)
  assert.equal(Math.round(claude.ageHours), 2)
  assert.deepEqual(claude.plan, { status: 'found', name: 'Max 20x' })
  assert.equal(claude.limits.status, 'found')
  assert.equal(claude.limits.source, 'unofficial-live')
  assert.deepEqual(claude.limits.windows.map((window) => [window.label, window.usedPercent]), [
    ['5-hour', 18], ['Weekly', 49], ['Weekly, Fable only', 2]
  ])
  assert.ok(claude.limits.windows.every((window) => window.resetSinceReading === false))
  assert.deepEqual(usage.codex.limits.windows.map((window) => [window.kind, window.label, window.usedPercent]), [['weekly', 'Weekly', 0]])
  assert.equal(usage.codex.limits.source, 'codex-session-log')
})

test('the estimate counts the last seven days of the reading and carries no percentage', () => {
  const { activity } = shapeUsage([file('mac-mini', reading())], NOW).claude
  assert.equal(activity.status, 'found')
  assert.equal(activity.estimate, true)
  assert.equal(activity.replies, 150, 'a day from three weeks back was counted in the week')
  assert.equal(activity.sessions, 6)
  assert.ok(!('usedPercent' in activity))
  assert.ok(!strings(activity).includes('America/New_York'), 'the timezone was passed on with nothing on the page to use it')
})

test('a reading older than eight hours is stale, and says how old', () => {
  const usage = shapeUsage([file('mac-mini', reading({ takenAt: hoursBefore(9) }))], NOW)
  assert.equal(usage.status, 'ok')
  assert.equal(usage.claude.stale, true)
  assert.equal(usage.claude.limits.status, 'found', 'stale is said, not hidden - the reading still shows')
  assert.equal(shapeUsage([file('mac-mini', reading({ takenAt: hoursBefore(7.9) }))], NOW).claude.stale, false)
})

test('a window whose reset has passed shows no percentage', () => {
  const body = reading()
  body.claude.limits.windows[0].resetsAt = hoursBefore(1)
  const [fiveHour, weekly] = shapeUsage([file('mac-mini', body)], NOW).claude.limits.windows
  assert.equal(fiveHour.resetSinceReading, true)
  assert.equal(fiveHour.usedPercent, null, 'a percentage from before the reset is not today\'s')
  assert.equal(weekly.usedPercent, 49)
})

test('not found and unavailable stay what they are, never a zero', () => {
  const body = reading({
    claude: {
      plan: { status: 'not found' },
      limits: { status: 'unavailable', why: 'The usage address refused the request.' },
      activity: { status: 'not found' }
    },
    codex: { plan: { status: 'not found' }, limits: { status: 'not found' } }
  })
  const usage = shapeUsage([file('mac-mini', body)], NOW)
  assert.deepEqual(usage.claude.plan, { status: 'not found', name: null })
  assert.equal(usage.claude.limits.status, 'unavailable')
  assert.equal(usage.claude.limits.why, 'The usage address refused the request.')
  assert.deepEqual(usage.claude.limits.windows, [])
  assert.equal(usage.claude.activity.status, 'not found')
  assert.equal(usage.codex.limits.status, 'not found')
  assert.ok(!JSON.stringify(usage).includes('usedPercent":0'), 'a missing reading came back as a zero')
})

test('a service the file does not mention is not found, not zero', () => {
  const body = reading()
  delete body.codex
  const usage = shapeUsage([file('mac-mini', body)], NOW)
  assert.equal(usage.codex.limits.status, 'not found')
  assert.equal(usage.codex.plan.status, 'not found')
})

test('a percentage outside a found block is never shown', () => {
  const body = reading()
  body.claude.limits.status = 'unavailable'
  const usage = shapeUsage([file('mac-mini', body)], NOW)
  assert.equal(usage.claude.limits.status, 'unavailable')
  assert.deepEqual(usage.claude.limits.windows, [])
})

test('a reading in a shape the board does not know is unavailable, never partly shown', () => {
  const cases = {
    'a percentage that is text': (body) => { body.claude.limits.windows[1].usedPercent = '49' },
    'a percentage over 1000': (body) => { body.claude.limits.windows[1].usedPercent = 1001 },
    'a negative percentage': (body) => { body.claude.limits.windows[1].usedPercent = -1 },
    'a percentage that is not finite': (body) => { body.claude.limits.windows[1].usedPercent = Number.NaN },
    'an unknown window': (body) => { body.claude.limits.windows[1].kind = 'monthly' },
    'an unreadable reset time': (body) => { body.claude.limits.windows[1].resetsAt = 'soon' },
    'no windows at all': (body) => { body.claude.limits.windows = [] },
    'an unknown source': (body) => { body.claude.limits.source = 'scraped' },
    'an unknown status': (body) => { body.claude.limits.status = 'fine' }
  }
  for (const [label, spoil] of Object.entries(cases)) {
    const body = reading()
    spoil(body)
    const { limits } = shapeUsage([file('mac-mini', JSON.parse(JSON.stringify(body)))], NOW).claude
    assert.equal(limits.status, 'unavailable', label)
    assert.deepEqual(limits.windows, [], `${label}: part of the reading was shown`)
  }
  // Over 100 is a real reading - an account can go past its limit - so it is kept.
  const over = reading()
  over.claude.limits.windows[1].usedPercent = 112
  assert.equal(shapeUsage([file('mac-mini', over)], NOW).claude.limits.windows[1].usedPercent, 112)
})

test('a file the board cannot use is said to be unusable, with the reason', () => {
  const cases = [
    ['{ not json', /could not be read/],
    [JSON.stringify(reading({ schema: 'agent-status/usage/v9' })), /does not know/],
    [JSON.stringify(reading({ takenAt: 'yesterday' })), /does not say when it was taken/],
    [JSON.stringify(reading({ takenAt: hoursAfter(3) })), /stamped in the future/],
    [JSON.stringify([1, 2, 3]), /could not be read/]
  ]
  for (const [body, why] of cases) {
    const usage = shapeUsage([file('mac-mini', body)], NOW)
    assert.equal(usage.status, 'unusable', body.slice(0, 40))
    assert.match(usage.why, why)
    assert.equal(usage.claude, null)
  }
})

/* ---------- which reading wins ---------------------------------------------------------------- */

test('the freshest found reading wins, and names the computer it came from', () => {
  const laptop = reading({ takenAt: hoursBefore(5), computer: 'Laptop' })
  laptop.claude.limits.windows[0].usedPercent = 77
  const mac = reading({ takenAt: hoursBefore(1) })
  mac.claude.limits = { status: 'unavailable' }
  const usage = shapeUsage([file('laptop', laptop), file('mac-mini', mac)], NOW)
  assert.equal(usage.claude.computer, 'Laptop', 'a newer file with no reading beat an older one with a reading')
  assert.equal(usage.claude.limits.windows[0].usedPercent, 77)
  // Codex was found on both, so the newer one wins there.
  assert.equal(usage.codex.computer, 'Mac Mini')
})

test('with no found reading anywhere, the freshest file says why', () => {
  const older = reading({ takenAt: hoursBefore(5), computer: 'Laptop' })
  older.claude.limits = { status: 'not found' }
  const newer = reading({ takenAt: hoursBefore(1) })
  newer.claude.limits = { status: 'unavailable', why: 'Signed out.' }
  const usage = shapeUsage([file('laptop', older), file('mac-mini', newer)], NOW)
  assert.equal(usage.claude.computer, 'Mac Mini')
  assert.equal(usage.claude.limits.status, 'unavailable')
})

test('at most five files are read, and the rest are counted, not ignored silently', () => {
  const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((slug) => file(slug, reading({ computer: slug.toUpperCase() })))
  const usage = shapeUsage(files, NOW, files.length)
  assert.equal(usage.read, USAGE_MAX_FILES)
  assert.equal(usage.skipped, 2)
})

test('an unusable file next to a good one is counted, and the good one still shows', () => {
  const usage = shapeUsage([file('broken', '{'), file('mac-mini', reading())], NOW)
  assert.equal(usage.status, 'ok')
  assert.equal(usage.unreadable, 1)
  assert.equal(usage.claude.computer, 'Mac Mini')
})

/* ---------- re-checked, not trusted ----------------------------------------------------------- */

test('a planted token, email or path in any field never comes out the other side', () => {
  for (const planted of PLANTED) {
    const body = reading({ computer: planted, extra: planted, [planted]: 'key' })
    body.claude.plan.name = planted
    body.claude.plan.secret = planted
    body.claude.limits.windows[2].model = planted
    body.claude.limits.windows[0].note = planted
    body.claude.limits.token = planted
    body.claude.activity.timezone = planted
    body.claude.activity.days[0].project = planted
    body.codex.limits = { status: 'unavailable', why: planted }
    body.codex.plan = { status: 'found', name: `Pro ${planted}` }
    const usage = shapeUsage([file('mac-mini', body)], NOW)
    const out = JSON.stringify(usage)
    assert.ok(!out.includes(planted), `"${planted.slice(0, 12)}..." reached the payload: ${out.slice(0, 200)}`)
  }
})

test('a name that is not plainly a name is dropped, and the reading around it kept', () => {
  const body = reading({ computer: FAKE.email })
  body.claude.limits.windows[2].model = FAKE.token
  const usage = shapeUsage([file('mac-mini', body)], NOW)
  assert.equal(usage.claude.computer, null, 'an email was kept as a computer name')
  assert.equal(usage.claude.limits.status, 'found', 'a bad model name threw away a good reading')
  assert.equal(usage.claude.limits.windows[2].label, 'Weekly, one model only')
  assert.equal(usage.claude.limits.windows[2].usedPercent, 2)
})

test('a name longer than the contract allows is dropped', () => {
  const usage = shapeUsage([file('mac-mini', reading({ computer: 'M'.repeat(USAGE_MAX_STRING + 1) }))], NOW)
  assert.equal(usage.claude.computer, null)
  assert.equal(shapeUsage([file('mac-mini', reading({ computer: 'Nuno\'s Mac Mini (office)' }))], NOW).claude.computer, 'Nuno\'s Mac Mini (office)')
})

test('only the keys the board knows come out', () => {
  const body = reading({ hostname: 'box', username: 'someone' })
  body.claude.limits.windows[0].raw = { anything: 1 }
  const usage = shapeUsage([file('mac-mini', body)], NOW)
  const keys = new Set(strings(usage).filter((value) => /^[a-zA-Z]+$/.test(value)))
  for (const unwanted of ['hostname', 'username', 'raw', 'anything', 'timezone', 'byModel', 'tokens', 'schema']) {
    assert.ok(!keys.has(unwanted), `${unwanted} came through`)
  }
})
