// "Mac restarted at ..." on the Readiness wall, and what a job that failed right after it says.
//
// After the power cut of 2026-10-13 the wall showed many red "stopped with error code 1" jobs and no hint
// why. The collector now writes `bootedAt` (when the computer last started, to the minute); the board
//   - reads it like every other time from a repo anybody can push to: a real time, to the whole minute,
//     after 2000, not in the future and not later than the file itself - or it is ignored,
//   - shows "Mac restarted at <time>" at the top of the Readiness screen while the restart is under 7 days old,
//   - and gives a job whose last run failed within 10 minutes AFTER that restart its own sentence, which
//     says "restarted" (what the file shows) and never states a cause it cannot see.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { shapeReadiness, READINESS_WORDS, RESTART_BANNER_DAYS, RESTART_FAILURE_WINDOW_MINUTES } from '../api/_readiness.js'
import { shapeJobs, JOBS_FOLDER, JOBS_BOOT, JOBS_ALLOWED_KEYS, JOBS_REQUIRED_KEYS } from '../api/state.js'
import { loadPage, flush } from './helpers/page-harness.mjs'
import { basePayload } from './helpers/page-payload.mjs'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/jobs-parity.json', import.meta.url), 'utf8'))
const at = (value) => Date.parse(value)
const MINUTE = 60_000

// The shape of 2026-10-13: the Mac started at 19:56 UTC, the readings came 3 hours later.
const BOOT = '2026-10-13T19:56:00Z'
const NOW = at('2026-10-14T13:10:00Z')
const TAKEN = '2026-10-14T13:07:00Z'
const OWNER = 'local.donna.substack-weekly-briefing'
const OWNER_ID = `launchd:${OWNER}`

// A report job that failed with code 1, its log last written `afterBootSeconds` after the boot minute.
const failed = (afterBootSeconds, patch = {}, bootIso = BOOT) => ({
  label: OWNER,
  cadence: { kind: 'unknown' },
  state: 'loaded',
  lastExit: 1,
  lastReportAt: new Date(at(bootIso) + afterBootSeconds * 1000).toISOString().replace('.000Z', 'Z'),
  ...patch
})
// `ABSENT` leaves the key out of the file, as a Mac that cannot say does (undefined would take the default).
const ABSENT = Symbol('absent')
const reading = ({ launchd = [failed(27)], bootedAt = BOOT, taken = TAKEN, computer = 'Mac Mini', timezone = 'America/New_York' } = {}) => ({
  schema: 'agent-status/jobs/v1',
  takenAt: taken,
  computer,
  timezone,
  ...(bootedAt === ABSENT ? {} : { bootedAt }),
  launchd: { status: 'found', items: launchd, hidden: 0, more: 0 },
  hermes: { status: 'found', items: [], hidden: 0, more: 0 }
})
const jobsFrom = (docs, now = NOW) => shapeJobs((Array.isArray(docs) ? docs : [docs]).map((doc, index) => [`${JOBS_FOLDER}/mac-${index}.json`, JSON.stringify(doc)]), now)
const wall = (docs, now = NOW) => shapeReadiness({ jobs: jobsFrom(docs, now), now })
const owner = (docs, now) => wall(docs, now).cards.find((card) => card.id === OWNER_ID)

/* ---------- reading the file ------------------------------------------------------------------ */

test('the shared contract lists bootedAt as an optional file key, and the board mirrors the boot rule', () => {
  assert.ok(JOBS_ALLOWED_KEYS.file.includes('bootedAt'))
  assert.ok(!JOBS_REQUIRED_KEYS.file.includes('bootedAt'))
  const { key, roundedToSeconds, earliest } = fixture.boot
  assert.deepEqual(JOBS_BOOT, { key, roundedToSeconds, earliest })
  assert.ok(fixture.sample.bootedAt)
})

test('a real boot time, to the minute, is read as written; a file without one has none', () => {
  assert.equal(jobsFrom(reading()).computers[0].bootedAt, BOOT)
  assert.equal(jobsFrom(reading({ bootedAt: ABSENT })).computers[0].bootedAt, null)
  assert.equal(jobsFrom(fixture.sample, at('2026-10-09T15:05:00Z')).computers[0].bootedAt, fixture.sample.bootedAt)
})

test('a boot time that is not what the collector writes is ignored, and the rest of the file is still read', () => {
  const bad = [
    ['seconds that are not :00', '2026-10-13T19:56:07Z'],
    ['milliseconds', '2026-10-13T19:56:00.000Z'],
    ['later than now', '2026-10-14T13:11:00Z'],
    ['later than the file itself', '2026-10-14T13:08:00Z'],
    ['before the year 2000', '1999-12-31T23:59:00Z'],
    ['not a time', 'yesterday'],
    ['not a real day', '2026-02-31T10:00:00Z'],
    ['an offset', '2026-10-13T19:56:00+02:00'],
    ['empty', ''],
    ['a number', 1791920160],
    ['null', null],
    ['an object', { at: BOOT }]
  ]
  for (const [why, bootedAt] of bad) {
    const shaped = jobsFrom(reading({ bootedAt }))
    assert.equal(shaped.status, 'ok', why)
    assert.equal(shaped.computers[0].bootedAt, null, why)
    assert.equal(shaped.computers[0].launchd.items.length, 1, why)
  }
})

/* ---------- the sentence for a job that failed right after the restart ------------------------- */

test('words: the sentence says restarted, as fact, and keeps the power-cut phrasing as guidance only', () => {
  assert.equal(
    READINESS_WORDS.failedAfterRestart,
    '{name} stopped right after the Mac restarted at {time}. Jobs like this need a person to check them after a restart.'
  )
  assert.equal(RESTART_FAILURE_WINDOW_MINUTES, 10)
  assert.equal(RESTART_BANNER_DAYS, 7)
})

test('the incident: a report job whose log was last written 27 seconds after the boot minute gets the new sentence', () => {
  const card = owner(reading())
  assert.equal(card.light, 'no-go')
  assert.deepEqual(card.sentence, {
    text: `Substack weekly briefing stopped right after the Mac restarted at {time}. Jobs like this need a person to check them after a restart. ${READINESS_WORDS.unknownSchedule}`,
    at: BOOT
  })
  // It is still the job's own last report that the card shows.
  assert.deepEqual(card.lastReport, { text: '{time}', at: '2026-10-13T19:56:27Z' })
  assert.ok(!card.sentence.text.includes('error code'))
})

test('the window: from the boot minute to ten minutes after it, both ends included', () => {
  for (const seconds of [0, 27, 5 * 60, 10 * 60]) assert.match(owner(reading({ launchd: [failed(seconds)] })).sentence.text, /stopped right after the Mac restarted/, `${seconds} s`)
  for (const seconds of [10 * 60 + 1, 3600, 6 * 3600]) assert.match(owner(reading({ launchd: [failed(seconds)] })).sentence.text, /stopped with error code 1/, `${seconds} s`)
})

test('a failure logged before the restart is an ordinary failure: nothing about the restart explains it', () => {
  for (const seconds of [-1, -60, -3600]) {
    const card = owner(reading({ launchd: [failed(seconds)] }))
    assert.match(card.sentence.text, /^Substack weekly briefing stopped with error code 1\. The Mac does not say why; its log on the Mac has the reason\./, `${seconds} s`)
  }
})

test('the restart has to be on the wall too: a boot more than 7 days old does not explain a failure, however close the log', () => {
  const day = 86400_000
  const bootAt = (daysAgo, extraMinutes = 0) => new Date(Math.floor((NOW - daysAgo * day) / MINUTE) * MINUTE - extraMinutes * MINUTE).toISOString().replace('.000Z', 'Z')
  const case1 = (bootIso) => owner(reading({ bootedAt: bootIso, taken: TAKEN, launchd: [failed(180, {}, bootIso)] }))
  // 20 days ago, log 3 minutes after, exit 1: the old wording.
  assert.match(case1(bootAt(20)).sentence.text, /^Substack weekly briefing stopped with error code 1. /)
  assert.deepEqual(wall(reading({ bootedAt: bootAt(20), launchd: [failed(180, {}, bootAt(20))] })).restarts, [])
  // Exactly 7 days ago is still on the wall, and still explains it; a minute older is neither.
  assert.match(case1(bootAt(7)).sentence.text, /stopped right after the Mac restarted/)
  assert.match(case1(bootAt(7, 1)).sentence.text, /stopped with error code 1/)
})

test('only a failure gets it: a clean exit, or a job that never said how it ended, keeps its own sentence', () => {
  const clean = owner(reading({ launchd: [failed(27, { lastExit: 0 })] }))
  assert.equal(clean.light, 'go')
  assert.match(clean.sentence.text, /ran clean at/)
  const unknown = owner(reading({ launchd: [failed(27, { lastExit: undefined })] }))
  assert.equal(unknown.light, 'silent')
  assert.ok(!unknown.sentence.text.includes('restarted'))
})

test('no boot time, no new sentence: the old wording stands exactly', () => {
  const card = owner(reading({ bootedAt: ABSENT }))
  assert.deepEqual(card.sentence, {
    text: `Substack weekly briefing stopped with error code 1. The Mac does not say why; its log on the Mac has the reason. ${READINESS_WORDS.unknownSchedule}`,
    at: '2026-10-13T19:56:27Z'
  })
})

test('a job with set times that failed after the restart is NO GO with the new sentence, and keeps its faded note', () => {
  const daily = { kind: 'slots', slots: [{ minute: 55, hour: 15 }] }
  // Its 15:55 (Mac time) slot came due a minute before the log was written: it kept up.
  const kept = owner(reading({ launchd: [failed(27, { cadence: daily, dueAt: '2026-10-13T19:55:00Z', dueBeforeAt: '2026-10-12T19:55:00Z' })] }))
  assert.equal(kept.light, 'no-go')
  assert.equal(kept.faded, false)
  assert.deepEqual(kept.sentence, { text: 'Substack weekly briefing stopped right after the Mac restarted at {time}. Jobs like this need a person to check them after a restart.', at: BOOT })
  // Its newest slot was missed but the one before was kept: faded, and it says so after the new sentence.
  const faded = owner(reading({ launchd: [failed(27, { cadence: daily, dueAt: '2026-10-13T20:30:00Z', dueBeforeAt: '2026-10-13T19:55:00Z' })] }))
  assert.equal(faded.light, 'no-go')
  assert.equal(faded.faded, true)
  assert.equal(faded.sentence.text, `Substack weekly briefing stopped right after the Mac restarted at {time}. Jobs like this need a person to check them after a restart. ${READINESS_WORDS.faded}`)
  // Both of its last slots missed: the board cannot vouch for it, as before this change.
  const lost = owner(reading({ launchd: [failed(27, { cadence: daily, dueAt: '2026-10-13T22:00:00Z', dueBeforeAt: '2026-10-13T21:00:00Z' })] }))
  assert.equal(lost.light, 'silent')
  assert.match(lost.sentence.text, /^Has not reported since /)
})

test('the same job on a reading that is stale is "not checked", as before; the sentence does not outlive its reading', () => {
  const card = owner(reading({ taken: '2026-10-14T01:00:00Z' }), NOW)
  assert.equal(card.light, 'silent')
  assert.match(card.sentence.text, /^Not checked since /)
})

test('a job name with braces cannot be read as a placeholder in the new sentence', () => {
  const result = shapeReadiness({
    jobs: jobsFrom(reading({ launchd: [failed(27, { label: 'local.donna.x' })] })),
    now: NOW,
    overrides: { names: { 'launchd:local.donna.x': 'Brief {time}{hours}' }, hidden: [] }
  })
  const card = result.cards.find((entry) => entry.id === 'launchd:local.donna.x')
  assert.ok(card.sentence.text.startsWith('Brief timehours stopped right after the Mac restarted at {time}.'), card.sentence.text)
})

/* ---------- the banner's data ---------------------------------------------------------------- */

test('the wall carries one restart per computer that reported a boot time, with the sentence and the time', () => {
  const result = wall(reading())
  assert.deepEqual(result.restarts, [{ where: 'Mac Mini', text: READINESS_WORDS.restartedAt, at: BOOT }])
  assert.equal(READINESS_WORDS.restartedAt, 'Mac restarted at {stamp}')
})

test('nothing is said without a boot time, without a Mac reading, or when the restart is older than 7 days', () => {
  assert.deepEqual(wall(reading({ bootedAt: ABSENT })).restarts, [])
  assert.deepEqual(shapeReadiness({ now: NOW }).restarts, [])
  assert.deepEqual(shapeReadiness({ jobs: { status: 'none', why: null, computers: [] }, now: NOW }).restarts, [])
  const old = reading({ bootedAt: '2026-10-07T13:09:00Z' })
  assert.deepEqual(wall(old).restarts, [], 'seven days and a minute ago')
  const edge = reading({ bootedAt: '2026-10-07T13:10:00Z' })
  assert.equal(wall(edge).restarts.length, 1, 'exactly seven days ago is still shown')
})

test('the 7 days are counted from the board\'s own clock, not from the file\'s', () => {
  const old = reading({ bootedAt: '2026-10-05T11:42:00Z', taken: '2026-10-09T15:00:00Z' })
  assert.equal(wall(old, at('2026-10-09T15:05:00Z')).restarts.length, 1)
  assert.equal(wall(old, at('2026-10-14T13:10:00Z')).restarts.length, 0)
})

test('two computers: each says its own restart, the newest first, and a name that fails the board\'s checks is "Mac"', () => {
  const a = reading({ computer: 'Mac Mini', bootedAt: '2026-10-13T19:56:00Z' })
  const b = reading({ computer: 'Studio', bootedAt: '2026-10-14T08:00:00Z' })
  const c = reading({ computer: 'someone@example.com', bootedAt: '2026-10-12T08:00:00Z' })
  const { restarts } = wall([a, b, c])
  assert.deepEqual(restarts.map((entry) => [entry.where, entry.at]), [['Studio', '2026-10-14T08:00:00Z'], ['Mac Mini', '2026-10-13T19:56:00Z'], ['Mac', '2026-10-12T08:00:00Z']])
})

test('each computer\'s jobs are judged against that computer\'s own restart, not another\'s', () => {
  const a = reading({ computer: 'Mac Mini', bootedAt: BOOT, launchd: [failed(27)] })
  const b = reading({ computer: 'Studio', bootedAt: '2026-10-14T08:00:00Z', launchd: [failed(27, { label: 'local.donna.other' })] })
  const result = wall([a, b])
  assert.match(result.cards.find((card) => card.id === OWNER_ID).sentence.text, /restarted at/)
  assert.match(result.cards.find((card) => card.id === 'launchd:local.donna.other').sentence.text, /stopped with error code 1/, 'its log was written 12 hours before Studio started')
})

/* ---------- the screen ------------------------------------------------------------------------ */

// The page ages cards by the real clock, so the screen is tested with readings taken just now: the Mac
// started three hours ago (to the minute) and its job's log was written 27 seconds after that.
const isoOf = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z')
function live({ bootedAt, now = Date.now() } = {}) {
  const bootIso = typeof bootedAt === 'string' ? bootedAt : isoOf(Math.floor((now - 3 * 3600_000) / MINUTE) * MINUTE)
  const doc = reading({ bootedAt: bootedAt === ABSENT ? ABSENT : bootIso, taken: isoOf(now - 5 * MINUTE), launchd: [failed(27, {}, bootIso)] })
  return { now, bootIso, doc }
}
const CLOCK = "readinessClock.locale = 'en-US'; readinessClock.zone = 'UTC'"
const payloadFor = ({ doc, now }) => ({ ...basePayload(), generatedAt: isoOf(now), readiness: shapeReadiness({ jobs: jobsFrom(doc, now), now }) })
async function boot(payload) {
  const page = loadPage({ payload, hash: '#readiness', after: CLOCK, expose: ['renderReadiness', 'readinessClock', 'readinessSentence', 'readinessWhen'] })
  await flush()
  return page
}
const walk = (node, found = []) => {
  found.push(node)
  for (const child of node.children ?? []) walk(child, found)
  return found
}
const withClass = (root, name) => walk(root).filter((node) => (node.className ?? '').split(/\s+/).includes(name))
const textOf = (node) => `${node.textContent ?? ''}${(node.children ?? []).map(textOf).join('')}`.replace(/\s+/g, ' ').trim()
// The banner's own wording in en-US and UTC: "7:56 PM on Tue, Oct 13".
const stampOf = (iso) => {
  const ms = Date.parse(iso)
  const clock = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' }).format(ms)
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(ms)
  return `${clock} on ${day}`
}

test('the Readiness screen opens with "Mac restarted at <time> on <short date>", in the readers own clock', async () => {
  const { bootIso, ...rest } = live()
  const page = await boot(payloadFor({ ...rest, doc: rest.doc }))
  const lines = withClass(page.node('readiness'), 'rd-restart')
  assert.equal(lines.length, 1)
  assert.equal(textOf(lines[0]), `Mac restarted at ${stampOf(bootIso)}`)
  assert.match(textOf(lines[0]), /^Mac restarted at \d{1,2}:\d{2} [AP]M on [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}$/)
  // At the top: before the counters and the stamp.
  const head = withClass(page.node('readiness'), 'rd-head')[0]
  assert.equal(head.children[0].children[0], lines[0])
  assert.ok(!head.children[0].hidden, 'the holder is shown when there is a line')
})

test('the failed job on the screen reads the new sentence, with the restart time in the same clock', async () => {
  const { bootIso, now, doc } = live()
  const page = await boot(payloadFor({ now, doc }))
  const card = withClass(page.node('readiness'), 'rd-card').find((node) => node.attributes['data-id'] === OWNER_ID)
  assert.ok(card, 'the card is on the wall')
  const when = page.exposed.readinessWhen(bootIso, 'time', Date.now())
  assert.equal(textOf(withClass(card, 'rd-sentence')[0]), `Substack weekly briefing stopped right after the Mac restarted at ${when}. Jobs like this need a person to check them after a restart. ${READINESS_WORDS.unknownSchedule}`)
})

test('without a boot time, or with an old one, the screen has no restart line', async () => {
  const now = Date.now()
  const old = isoOf(Math.floor((now - 8 * 86400_000) / MINUTE) * MINUTE)
  for (const bootedAt of [ABSENT, old]) {
    const page = await boot(payloadFor(live({ bootedAt, now })))
    assert.equal(withClass(page.node('readiness'), 'rd-restart').length, 0)
  }
  const none = await boot({ ...basePayload(), readiness: shapeReadiness({ now }) })
  assert.equal(withClass(none.node('readiness'), 'rd-restart').length, 0)
})

test('an older server that sends no restarts at all still draws the screen', async () => {
  const payload = payloadFor(live())
  delete payload.readiness.restarts
  const page = await boot(payload)
  assert.equal(withClass(page.node('readiness'), 'rd-restart').length, 0)
  assert.ok(withClass(page.node('readiness'), 'rd-card').length > 0)
})

test('the restart line is text, never markup, whatever the sentence holds', async () => {
  const live1 = live()
  const payload = payloadFor(live1)
  payload.readiness.restarts = [{ where: '<img src=x onerror=alert(1)>', text: 'Mac restarted at {stamp} <b>now</b>', at: live1.bootIso }]
  const page = await boot(payload)
  const [line] = withClass(page.node('readiness'), 'rd-restart')
  assert.equal(textOf(line), `Mac restarted at ${stampOf(live1.bootIso)} <b>now</b>`)
  for (const node of walk(page.node('readiness'))) assert.equal(node.innerHTML, '', 'an element on this screen was written to as markup')
  assert.equal(walk(page.node('readiness')).filter((node) => ['B', 'IMG'].includes(node.tagName)).length, 0)
})

test('a restart entry the page cannot read is not drawn', async () => {
  const live1 = live()
  for (const restarts of [[{ text: 'Mac restarted at {stamp}', at: 'soon' }], [{ text: 'Mac restarted at {stamp}' }], [{ at: live1.bootIso }], [null], 'nope', {}]) {
    const payload = payloadFor(live1)
    payload.readiness.restarts = restarts
    const page = await boot(payload)
    assert.equal(withClass(page.node('readiness'), 'rd-restart').length, 0, JSON.stringify(restarts))
    assert.ok(withClass(page.node('readiness'), 'rd-card').length > 0)
  }
})

test('the restart line goes once it is more than 7 days old by the readers clock, even on a board left open', async () => {
  const page = await boot(payloadFor(live()))
  assert.equal(withClass(page.node('readiness'), 'rd-restart').length, 1)
  page.exposed.renderReadiness(Date.now() + 8 * 24 * 3600_000)
  assert.equal(withClass(page.node('readiness'), 'rd-restart').length, 0)
})

test('with two computers each line starts with its name; with one it does not', async () => {
  const base = live()
  const second = isoOf(Math.floor((base.now - 5 * 3600_000) / MINUTE) * MINUTE)
  const payload = payloadFor(base)
  payload.readiness.restarts = [
    { where: 'Studio', text: 'Mac restarted at {stamp}', at: base.bootIso },
    { where: 'Mac Mini', text: 'Mac restarted at {stamp}', at: second }
  ]
  const page = await boot(payload)
  const lines = withClass(page.node('readiness'), 'rd-restart').map(textOf)
  assert.deepEqual(lines, [`Studio: Mac restarted at ${stampOf(base.bootIso)}`, `Mac Mini: Mac restarted at ${stampOf(second)}`])
  // One of the two too old by the reader's clock: the other is the only line, so it has no name in front.
  payload.readiness.restarts[1].at = isoOf(base.now - 9 * 86400_000)
  const one = await boot(payload)
  assert.deepEqual(withClass(one.node('readiness'), 'rd-restart').map(textOf), [`Mac restarted at ${stampOf(base.bootIso)}`])
})

test('the holder for the restart lines is hidden when there is no line, and shown when there is', async () => {
  const none = await boot(payloadFor(live({ bootedAt: ABSENT })))
  const [emptyHolder] = withClass(none.node('readiness'), 'rd-restarts')
  assert.equal(emptyHolder.hidden, true)
  assert.equal(emptyHolder.children.length, 0)
  const some = await boot(payloadFor(live()))
  const [holder] = withClass(some.node('readiness'), 'rd-restarts')
  assert.equal(holder.hidden, false)
  assert.equal(holder.children.length, 1)
})
