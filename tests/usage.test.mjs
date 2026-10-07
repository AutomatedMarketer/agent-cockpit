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
  shapeSubscriptions,
  isUsageFile,
  USAGE_SCHEMA,
  USAGE_FOLDER,
  USAGE_COMPUTER_SLUG,
  USAGE_STALE_AFTER_HOURS,
  USAGE_MAX_FILES,
  USAGE_MAX_STRING,
  USAGE_STATUSES,
  USAGE_SOURCES,
  USAGE_WINDOWS,
  USAGE_MAX_WINDOWS,
  USAGE_WINDOW_REQUIRED,
  USAGE_WINDOW_OPTIONAL,
  USAGE_MAX_ACTIVITY_DAYS,
  USAGE_MAX_BYTES
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
  assert.equal(USAGE_MAX_WINDOWS, usageFixture.maxWindows)
  assert.deepEqual(USAGE_WINDOW_REQUIRED, usageFixture.windowRequired)
  assert.deepEqual(USAGE_WINDOW_OPTIONAL, usageFixture.windowOptional)
  assert.equal(USAGE_MAX_ACTIVITY_DAYS, usageFixture.maxActivityDays)
})

// A constant that matches the contract proves nothing if the code beside it checks something else.
// So each number and list is also fed through shapeUsage, and what it actually accepts and refuses
// is held to the fixture - read from the fixture here, never from the board's own constants.
const limitsOf = (body) => shapeUsage([file('mac-mini', JSON.parse(JSON.stringify(body)))], NOW).claude.limits
const withWindows = (windows) => {
  const body = reading()
  body.claude.limits.windows = windows
  return body
}
const aWindow = (index) => ({ kind: 'weekly_model', model: `Model ${index}`, usedPercent: index, resetsAt: hoursAfter(48) })

test('usage parity: shapeUsage takes as many windows as the contract allows, and no more', () => {
  const most = usageFixture.maxWindows
  const accepted = limitsOf(withWindows(Array.from({ length: most }, (_, index) => aWindow(index))))
  assert.equal(accepted.status, 'found', `${most} windows were refused`)
  assert.equal(accepted.windows.length, most)
  const refused = limitsOf(withWindows(Array.from({ length: most + 1 }, (_, index) => aWindow(index))))
  assert.equal(refused.status, 'unavailable', `${most + 1} windows were accepted`)
  assert.deepEqual(refused.windows, [])
})

test('usage parity: a window missing a required key is refused, one missing an optional key is not', () => {
  const full = { kind: 'weekly_model', model: 'Fable', usedPercent: 2, resetsAt: hoursAfter(48) }
  assert.deepEqual(Object.keys(full).sort(), [...usageFixture.windowRequired, ...usageFixture.windowOptional].sort(),
    'the contract names a window key this test does not exercise')
  for (const key of usageFixture.windowRequired) {
    const window = { ...full }
    delete window[key]
    assert.equal(limitsOf(withWindows([window])).status, 'unavailable', `a window with no ${key} was accepted`)
  }
  for (const key of usageFixture.windowOptional) {
    const window = { ...full }
    delete window[key]
    const limits = limitsOf(withWindows([window]))
    assert.equal(limits.status, 'found', `a window with no ${key} was refused`)
    assert.equal(limits.windows[0].usedPercent, 2)
  }
})

test('usage parity: stale starts where the contract says it does', () => {
  const hours = usageFixture.staleAfterHours
  const at = (age) => {
    const body = reading({ takenAt: hoursBefore(age) })
    body.claude.limits.readAt = hoursBefore(age)
    return shapeUsage([file('mac-mini', body)], NOW).claude.stale
  }
  assert.equal(at(hours - 0.1), false)
  assert.equal(at(hours + 0.1), true)
})

test('usage parity: shapeUsage reads as many files as the contract says, and counts the rest', () => {
  const most = usageFixture.maxFilesRead
  const files = Array.from({ length: most + 2 }, (_, index) => file(`computer-${index}`, reading()))
  const usage = shapeUsage(files, NOW, files.length)
  assert.equal(usage.read, most)
  assert.equal(usage.skipped, 2)
})

test('usage parity: every source the contract names is accepted, and nothing else', () => {
  for (const source of usageFixture.sources) {
    const body = reading()
    body.claude.limits.source = source
    assert.equal(limitsOf(body).status, 'found', `${source} was refused`)
  }
  const body = reading()
  body.claude.limits.source = 'something-else'
  assert.equal(limitsOf(body).status, 'unavailable')
})

test('usage parity: every status the contract names comes back as itself, and nothing else does', () => {
  const blocks = {
    found: reading().claude.limits,
    'not found': { status: 'not found' },
    unavailable: { status: 'unavailable', why: 'Signed out.' }
  }
  assert.deepEqual(Object.keys(blocks).sort(), [...usageFixture.statuses].sort(), 'the contract names a status this test does not exercise')
  for (const status of usageFixture.statuses) {
    const body = reading()
    body.claude.limits = blocks[status]
    assert.equal(limitsOf(body).status, status)
  }
  const body = reading()
  body.claude.limits = { ...blocks.found, status: 'fine' }
  assert.equal(limitsOf(body).status, 'unavailable')
})

test('usage parity: the estimate takes as many days as the contract allows, and no more', () => {
  const days = (count) => Array.from({ length: count }, (_, index) => ({
    day: new Date(NOW - index * 86400_000).toISOString().slice(0, 10), sessions: 1, replies: 1
  }))
  const activityWith = (count) => {
    const body = reading()
    body.claude.activity.days = days(count)
    return shapeUsage([file('mac-mini', body)], NOW).claude.activity.status
  }
  assert.equal(activityWith(usageFixture.maxActivityDays), 'found')
  assert.equal(activityWith(usageFixture.maxActivityDays + 1), 'unavailable')
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

// The file is stamped when the collector writes it; the reading inside can be older - a saved copy
// Claude Code kept, or the last limit Codex logged. Its age is the reading's, or a six-hour-old
// figure shows as "1 min ago" and is never flagged stale.
const minutesBefore = (minutes) => new Date(NOW - minutes * 60_000).toISOString()

test('the age and the stale flag come from when the limits were read, not when the file was written', () => {
  const body = reading({ takenAt: minutesBefore(1) })
  body.claude.limits.readAt = hoursBefore(6)
  body.codex.limits.readAt = hoursBefore(9)
  const usage = shapeUsage([file('mac-mini', body)], NOW)
  assert.equal(Math.round(usage.claude.ageHours), 6, 'the age is the file\'s, not the reading\'s')
  assert.equal(usage.claude.stale, false)
  assert.equal(usage.claude.limits.readAt, hoursBefore(6))
  assert.equal(usage.claude.takenAt, minutesBefore(1), 'the file time is still there for the page to name')
  assert.equal(usage.codex.stale, true, 'a nine-hour-old Codex figure in a fresh file was not called stale')
})

test('a reading time the board cannot trust is dropped, and the file time is used instead', () => {
  const cases = {
    'in the future': hoursAfter(1),
    'after the file was written': minutesBefore(30),
    'not a time': 'earlier',
    'missing': undefined
  }
  for (const [label, readAt] of Object.entries(cases)) {
    const body = reading({ takenAt: hoursBefore(1) })
    body.claude.limits.readAt = readAt
    const { claude } = shapeUsage([file('mac-mini', body)], NOW)
    assert.equal(claude.limits.readAt, null, `a reading time ${label} was kept`)
    assert.equal(claude.limits.status, 'found', `a reading time ${label} threw the reading away`)
    assert.equal(Math.round(claude.ageHours), 1, `a reading time ${label} set the age`)
  }
  // A minute or two after the file stamp is two clocks a little apart, not a lie.
  const body = reading({ takenAt: hoursBefore(1) })
  body.claude.limits.readAt = new Date(NOW - 3600_000 + 120_000).toISOString()
  assert.ok(shapeUsage([file('mac-mini', body)], NOW).claude.limits.readAt, 'two minutes of clock drift lost the reading time')
})

test('the freshest reading wins by when it was read, not when its file was written', () => {
  // The laptop wrote its file more recently, but what it holds is a saved copy from six hours ago.
  const laptop = reading({ takenAt: hoursBefore(1), computer: 'Laptop' })
  laptop.claude.limits.readAt = hoursBefore(6)
  laptop.claude.limits.windows[0].usedPercent = 77
  const mac = reading({ takenAt: hoursBefore(3) })
  mac.claude.limits.readAt = hoursBefore(3)
  const usage = shapeUsage([file('laptop', laptop), file('mac-mini', mac)], NOW)
  assert.equal(usage.claude.computer, 'Mac Mini', 'an older reading in a newer file won')
  assert.equal(usage.claude.limits.windows[0].usedPercent, 18)
})

test('a window whose reset has passed shows no percentage', () => {
  const body = reading()
  body.claude.limits.windows[0].resetsAt = hoursBefore(1)
  const [fiveHour, weekly] = shapeUsage([file('mac-mini', body)], NOW).claude.limits.windows
  assert.equal(fiveHour.resetSinceReading, true)
  assert.equal(fiveHour.usedPercent, null, 'a percentage from before the reset is not today\'s')
  assert.equal(weekly.usedPercent, 49)
})

// Claude's address answers `resets_at: null` for a window that has not started - an idle 5-hour
// one, typically - and the collector writes the window without a reset time. That is a real
// reading, so it shows; it just cannot say when it resets.
test('a window with no reset time keeps its percentage, and says the reset is unknown', () => {
  for (const missing of [undefined, null]) {
    const body = reading()
    if (missing === undefined) delete body.claude.limits.windows[0].resetsAt
    else body.claude.limits.windows[0].resetsAt = null
    const { limits } = shapeUsage([file('mac-mini', body)], NOW).claude
    assert.equal(limits.status, 'found', `a ${missing} reset time threw away the whole Claude meter`)
    const [fiveHour, weekly] = limits.windows
    assert.equal(fiveHour.usedPercent, 18)
    assert.equal(fiveHour.resetsAt, null)
    assert.equal(fiveHour.resetSinceReading, false)
    assert.equal(weekly.usedPercent, 49)
  }
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

// The handler passes a file it listed and could not fetch, or would not fetch because the tree says
// it is too big, as no body. That is a file that could not be used - not one past the first five.
test('a file that could not be fetched, or is too big, is counted as unusable, not as left out', () => {
  const usage = shapeUsage([[`${USAGE_FOLDER}/broken.json`, null], file('mac-mini', reading())], NOW, 2)
  assert.equal(usage.status, 'ok')
  assert.equal(usage.unreadable, 1)
  assert.equal(usage.skipped, 0, 'a file that failed to fetch was counted as one past five')
  const huge = JSON.stringify(reading({ padding: 'x'.repeat(USAGE_MAX_BYTES) }))
  const big = shapeUsage([file('mac-mini', huge)], NOW, 1)
  assert.equal(big.status, 'unusable', 'a file over the size limit was read')
  assert.match(big.why, /too big/)
  const missing = shapeUsage([[`${USAGE_FOLDER}/mac-mini.json`, null]], NOW, 1)
  assert.equal(missing.status, 'unusable')
  assert.match(missing.why, /could not be fetched/)
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

/* ---------- subscriptions: what the owner says they pay -----------------------------------------
   Prices come from stack.yml under `subscriptions:`, written by /onboard or by hand. The board
   never converts between currencies - there is no rate it could honestly use - so it keeps one
   total per currency. A yearly price is shown as a month and says so. A line with no price is
   listed and left out of the total, rather than counted as free. */

const subs = (...rows) => ({ subscriptions: rows })
function usageWithPlans(claude, codex) {
  const body = reading()
  body.claude.plan = { status: 'found', name: claude }
  body.codex.plan = { status: 'found', name: codex }
  return shapeUsage([file('mac-mini', body)], NOW)
}

test('no subscriptions recorded is an empty list, not a zero total', () => {
  for (const doc of [null, {}, { subscriptions: [] }, { subscriptions: {} }, { stack: [] }]) {
    const shaped = shapeSubscriptions(doc, null)
    assert.deepEqual(shaped.items, [])
    assert.deepEqual(shaped.totals, [], 'an empty list came with a total')
  }
})

test('monthly prices are added up per currency, never converted', () => {
  const shaped = shapeSubscriptions(subs(
    { name: 'Claude Max', service: 'claude', price: 200, currency: 'USD', per: 'month' },
    { name: 'ChatGPT Pro', service: 'codex', price: 200, currency: 'USD', per: 'month' },
    { name: 'Perplexity', service: 'perplexity', price: '19.99', currency: 'GBP', per: 'month' }
  ), null)
  assert.deepEqual(shaped.totals, [{ currency: 'GBP', monthly: 19.99 }, { currency: 'USD', monthly: 400 }])
  assert.deepEqual(shaped.items.map((item) => [item.name, item.price, item.currency, item.per, item.monthly]), [
    ['Claude Max', 200, 'USD', 'month', 200],
    ['ChatGPT Pro', 200, 'USD', 'month', 200],
    ['Perplexity', 19.99, 'GBP', 'month', 19.99]
  ])
})

test('a yearly price counts as a twelfth a month, to the cent', () => {
  const shaped = shapeSubscriptions(subs(
    { name: 'Domain', service: 'other', price: 99, currency: 'USD', per: 'year' },
    { name: 'Tool', service: 'other', price: '10.10', currency: 'USD', per: 'month' }
  ), null)
  const domain = shaped.items[0]
  assert.equal(domain.per, 'year')
  assert.equal(domain.price, 99)
  assert.equal(domain.monthly, 8.25)
  // In cents, so 8.25 + 10.10 is 18.35 and not 18.349999999999998.
  assert.deepEqual(shaped.totals, [{ currency: 'USD', monthly: 18.35 }])
})

test('a line with no usable price is listed, and left out of the total', () => {
  const shaped = shapeSubscriptions(subs(
    { name: 'Claude Max', service: 'claude', price: 200, currency: 'USD', per: 'month' },
    { name: 'No price', service: 'other' },
    { name: 'Three decimals', price: '1.999', currency: 'USD', per: 'month' },
    { name: 'Negative', price: -5, currency: 'USD', per: 'month' },
    { name: 'No currency', price: 10, per: 'month' },
    { name: 'Lowercase currency', price: 10, currency: 'usd', per: 'month' },
    { name: 'Weekly', price: 10, currency: 'USD', per: 'week' },
    { name: 'A fill marker', price: '<!-- fill: price -->', currency: 'USD', per: 'month' }
  ), null)
  assert.equal(shaped.items.length, 8, 'a line without a price vanished')
  assert.deepEqual(shaped.totals, [{ currency: 'USD', monthly: 200 }])
  assert.equal(shaped.unpriced, 7)
  for (const item of shaped.items.slice(1)) assert.equal(item.monthly, null, `${item.name} was counted`)
})

test('a subscription name that is not plainly a name is not printed', () => {
  const shaped = shapeSubscriptions(subs(
    { name: FAKE.email, price: 10, currency: 'USD', per: 'month' },
    { name: `Claude ${FAKE.token}`, price: 10, currency: 'USD', per: 'month' },
    { name: 'Claude Max', service: FAKE.home, price: 200, currency: 'USD', per: 'month' }
  ), null)
  const out = JSON.stringify(shaped)
  for (const planted of PLANTED) assert.ok(!out.includes(planted), `"${planted.slice(0, 12)}..." reached the payload`)
  assert.deepEqual(shaped.items.map((item) => item.name), ['Claude Max'])
  assert.equal(shaped.items[0].service, null)
  assert.equal(shaped.unreadable, 2, 'the dropped lines were dropped without a word')
  // Dropped lines carry no price into the total either - a total of lines nobody can see is not one.
  assert.deepEqual(shaped.totals, [{ currency: 'USD', monthly: 200 }])
})

test('a subscription the usage reading disagrees with is flagged with the plan it read', () => {
  const usage = usageWithPlans('Max 20x', 'Plus')
  const shaped = shapeSubscriptions(subs(
    { name: 'Claude Pro', service: 'claude', price: 20, currency: 'USD', per: 'month' },
    { name: 'ChatGPT Pro', service: 'chatgpt', price: 200, currency: 'USD', per: 'month' },
    { name: 'Perplexity Pro', service: 'perplexity', price: 20, currency: 'USD', per: 'month' }
  ), usage)
  assert.deepEqual(shaped.items.map((item) => item.planRead), ['Max 20x', 'Plus', null])
  assert.deepEqual(shaped.items.map((item) => item.mismatch), [true, true, false])
})

test('the same plan family is a match, whatever the size after it', () => {
  const usage = usageWithPlans('Max 20x', 'Pro')
  const shaped = shapeSubscriptions(subs(
    { name: 'Claude Max', service: 'claude', price: 200, currency: 'USD', per: 'month' },
    { name: 'ChatGPT Pro', service: 'openai', price: 200, currency: 'USD', per: 'month' }
  ), usage)
  assert.deepEqual(shaped.items.map((item) => item.mismatch), [false, false])
})

test('no reading of the plan is no mismatch - the board does not guess', () => {
  const shaped = shapeSubscriptions(subs({ name: 'Claude Pro', service: 'claude', price: 20, currency: 'USD', per: 'month' }), shapeUsage([], NOW))
  assert.equal(shaped.items[0].mismatch, false)
  assert.equal(shaped.items[0].planRead, null)
  const unrecognised = shapeSubscriptions(subs({ name: 'Claude Pro', service: 'claude' }), usageWithPlans('not recognised', 'Pro'))
  assert.equal(unrecognised.items[0].mismatch, false, 'a tier the collector could not name was called a mismatch')
})
