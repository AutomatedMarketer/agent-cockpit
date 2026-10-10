// The Readiness wall's one light per job: NO GO, SILENT or GO, the sentence that says why, and the
// order they are shown in. Every row of the rules table in the plan has a test here, and the
// sentences are pinned word for word - they are what the owner reads, and what a screen reader says.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  shapeReadiness,
  slotsWords,
  cadenceWords,
  workflowScheduleWords,
  workflowClock,
  readableLabel,
  orderCards,
  countCards,
  READINESS_STALE_HOURS,
  READINESS_WORDS,
  MANAGED_OWNER_LABELS,
  COLLECTOR_EVERY_MINUTES,
  SWITCHED_OFF
} from '../api/readiness.js'
import { shapeJobs, shapeJobOverrides, JOBS_FOLDER, JOBS_STALE_AFTER_HOURS, JOBS_GRACE_MINUTES } from '../api/state.js'
import { SLOT_GRACE_MINUTES } from '../api/workflows.js'

const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z')
const at = (value) => Date.parse(value)

/* ---------- workflows: the board's own clock ---------------------------------------------------- */

const MONDAY = at('2026-08-10T12:00:00Z')
const workflow = (patch = {}) => ({
  slug: 'daily-brief',
  name: 'Daily brief',
  owner: 'research',
  ownerSwitchedOff: false,
  schedule: 'daily 06:00',
  arm: 'armed',
  armed: true,
  reason: null,
  fire: false,
  webhook: false,
  lastRun: { started_at: '2026-08-10T06:00:20Z', status: 'ok', summary: 'Wrote the brief. It had nine items.', session_url: null },
  ...patch
})
const wall = (workflows, extra = {}) => shapeReadiness({ workflows, now: MONDAY, ...extra })
const one = (patch, extra) => wall([workflow(patch)], extra).cards[0]
const withRun = (run) => ({ lastRun: { started_at: '2026-08-10T06:00:20Z', status: 'ok', summary: '', session_url: null, ...run } })

test('the stale hours and the grace are the ones the jobs contract and the Workflows screen use', () => {
  assert.equal(READINESS_STALE_HOURS, JOBS_STALE_AFTER_HOURS)
  assert.equal(SLOT_GRACE_MINUTES, JOBS_GRACE_MINUTES)
  assert.equal(COLLECTOR_EVERY_MINUTES, 180)
})

test('workflow, armed, last run clean on its own schedule: GO, with its time, and when it will age', () => {
  const card = one({})
  assert.equal(card.id, 'workflow:daily-brief')
  assert.equal(card.source, 'workflow')
  assert.equal(card.light, 'go')
  assert.equal(card.word, 'GO')
  assert.equal(card.pill, null)
  assert.equal(card.faded, false)
  assert.deepEqual(card.sentence, { text: 'Daily brief ran clean at {time}.', at: '2026-08-10T06:00:20Z' })
  assert.deepEqual(card.schedule, { text: 'Every day at 6:00am UTC', clock: { every: 'day', hour: 6, minute: 0, weekday: null, day: null } })
  assert.deepEqual(card.lastReport, { text: '{time}', at: '2026-08-10T06:00:20Z' })
  assert.equal(card.ref, 'Team repo · daily-brief')
  // Tomorrow's slot plus the 30 minutes of grace, and the one after: when it would fade, then go silent.
  assert.equal(card.fadesAt, '2026-08-11T06:30:00Z')
  assert.equal(card.silentAt, '2026-08-12T06:30:00Z')
  assert.deepEqual(card.silentSentence, { text: 'Has not reported since {date}.', at: '2026-08-10T06:00:20Z' })
})

test('a slot that came due ten minutes ago is still inside its grace, so the card fades at the end of it', () => {
  const card = wall([workflow({ lastRun: { started_at: '2026-08-09T06:00:20Z', status: 'ok', summary: '' } })], { now: at('2026-08-10T06:10:00Z') }).cards[0]
  assert.equal(card.faded, false)
  assert.equal(card.fadesAt, '2026-08-10T06:30:00Z')
  assert.equal(card.silentAt, '2026-08-11T06:30:00Z')
})

test('workflow, last run partial: GO, said as part of the job', () => {
  const card = one(withRun({ status: 'partial' }))
  assert.equal(card.light, 'go')
  assert.equal(card.sentence.text, 'Daily brief finished part of the job at {time}.')
})

test('workflow, last run failed or blocked and recent: NO GO, with the first sentence of the summary', () => {
  for (const status of ['failed', 'blocked']) {
    const card = one(withRun({ status, summary: 'Could not reach the calendar. Tried twice and gave up.' }))
    assert.equal(card.light, 'no-go', status)
    assert.equal(card.word, 'NO GO')
    assert.deepEqual(card.sentence, { text: 'Daily brief did not finish at {time}. Could not reach the calendar.', at: '2026-08-10T06:00:20Z' })
    assert.deepEqual(card.silentSentence, { text: 'Has not reported since {date}. Its last run failed.', at: '2026-08-10T06:00:20Z' })
  }
})

test('workflow, failed with no summary: says the run did not say why, never invents a reason', () => {
  for (const summary of ['', undefined, null, '   ', 7]) {
    const card = one(withRun({ status: 'failed', summary }))
    assert.equal(card.sentence.text, 'Daily brief did not finish at {time}. The run did not say why.', String(summary))
  }
})

test('workflow, a summary is repo text: control characters and braces cannot become a sentence of their own', () => {
  const card = one(withRun({ status: 'failed', summary: 'Broke at {time}\u0007 and\nstopped. Second sentence.' }))
  assert.equal(card.sentence.text, 'Daily brief did not finish at {time}. Broke at time and stopped.')
  const long = one(withRun({ status: 'failed', summary: 'x'.repeat(500) }))
  assert.ok(long.sentence.text.length < 260)
})

test('workflow, failed long ago (it missed both slots): SILENT, and says its last run failed', () => {
  const card = one(withRun({ started_at: '2026-08-07T06:00:20Z', status: 'failed', summary: 'Broke.' }))
  assert.equal(card.light, 'silent')
  assert.deepEqual(card.sentence, { text: 'Has not reported since {date}. Its last run failed.', at: '2026-08-07T06:00:20Z' })
  assert.equal(card.fadesAt, null)
  assert.equal(card.silentAt, null)
})

test('workflow, clean but long ago: SILENT', () => {
  const card = one(withRun({ started_at: '2026-08-07T06:00:20Z' }))
  assert.equal(card.light, 'silent')
  assert.deepEqual(card.sentence, { text: 'Has not reported since {date}.', at: '2026-08-07T06:00:20Z' })
})

test('workflow, never run: SILENT, "Has never reported."', () => {
  const card = one({ lastRun: null })
  assert.equal(card.light, 'silent')
  assert.deepEqual(card.sentence, { text: 'Has never reported.', at: null })
  assert.deepEqual(card.lastReport, { text: 'Never', at: null })
})

test('workflow, missed the newest slot but covered the one before: FADED, the same light with one more sentence', () => {
  const ok = one(withRun({ started_at: '2026-08-09T06:00:20Z' }))
  assert.equal(ok.light, 'go')
  assert.equal(ok.faded, true)
  assert.equal(ok.sentence.text, 'Daily brief ran clean at {time}. Its last report is older than its own schedule.')
  assert.equal(ok.fadesAt, null)
  assert.equal(ok.silentAt, '2026-08-11T06:30:00Z')
  const failed = one(withRun({ started_at: '2026-08-09T06:00:20Z', status: 'failed', summary: 'Could not reach the calendar.' }))
  assert.equal(failed.light, 'no-go')
  assert.equal(failed.faded, true)
  assert.equal(failed.sentence.text, 'Daily brief did not finish at {time}. Could not reach the calendar. Its last report is older than its own schedule.')
})

test('workflow, armed but nothing fires it: NO GO', () => {
  const card = one({ arm: 'declared' })
  assert.equal(card.light, 'no-go')
  assert.equal(card.sentence.text, 'Daily brief is marked on, but no routine exists, so nothing fires it.')
})

test('workflow, a routine fires it and the file says it is off: NO GO, spending runs nobody approved', () => {
  const card = one({ arm: 'unapproved', armed: false })
  assert.equal(card.light, 'no-go')
  assert.equal(card.sentence.text, 'Daily brief is switched off in its file, but a routine is still firing it. It is spending runs nobody approved.')
})

test('workflow, armed with no fresh list of routines: SILENT, never a claim either way', () => {
  const card = one({ arm: 'unknown' })
  assert.equal(card.light, 'silent')
  assert.equal(card.sentence.text, 'Daily brief is marked on, but the board has no fresh list of routines, so it cannot say whether anything fires it.')
})

test('workflow, a schedule nobody can read: the light comes from the last result alone, and says so', () => {
  const ok = one({ schedule: 'whenever' })
  assert.equal(ok.light, 'go')
  assert.equal(ok.schedule.text, 'Not known')
  assert.equal(ok.sentence.text, 'Daily brief ran clean at {time}. The schedule could not be read, so lateness is not judged.')
  assert.equal(ok.fadesAt, null)
  assert.equal(ok.silentAt, null)
  const failed = one({ schedule: null, ...withRun({ status: 'failed', summary: 'Broke.' }) })
  assert.equal(failed.light, 'no-go')
  assert.equal(failed.schedule.text, 'No schedule')
})

test('workflow, a run still going: GO only while it is inside the grace, otherwise it never said how it ended', () => {
  const going = wall([workflow(withRun({ started_at: '2026-08-10T11:50:00Z', status: 'running' }))]).cards[0]
  assert.equal(going.light, 'go')
  assert.equal(going.sentence.text, 'Daily brief started a run at {time} and it has not finished yet.')
  const hung = one(withRun({ status: 'running' }))
  assert.equal(hung.light, 'silent')
  assert.equal(hung.sentence.text, "Daily brief's last run, at {time}, never said how it ended.")
})

test('workflow, an every-N schedule fades and goes silent N and 2N after its last run, plus the grace', () => {
  const card = one({ schedule: 'every 2 hours', ...withRun({ started_at: '2026-08-10T11:00:00Z' }) })
  assert.equal(card.light, 'go')
  assert.equal(card.schedule.text, 'Every 2 hours')
  assert.equal(card.fadesAt, '2026-08-10T13:35:00Z')
  assert.equal(card.silentAt, '2026-08-10T15:35:00Z')
})

test('workflow, a name with braces cannot make a sentence read as a time', () => {
  const card = one({ name: '{time} Brief {date}' })
  assert.equal(card.name, '{time} Brief {date}')
  assert.equal(card.sentence.text, 'time Brief date ran clean at {time}.')
})

test('workflow, a name is cut to 80 characters and stripped of control characters', () => {
  const card = one({ name: `A\nB\u0000${'x'.repeat(200)}` })
  assert.ok(card.name.length <= 80)
  assert.ok(!/[\u0000-\u001f]/.test(card.name))
})

test('switched off: not armed, with the owner\'s reason when there is one', () => {
  const result = wall([workflow({ arm: 'off', armed: false, reason: 'Off until the pipeline has people in it.' }), workflow({ slug: 'b', name: 'B', arm: 'off', armed: false })])
  assert.deepEqual(result.cards, [])
  assert.deepEqual(result.switchedOff.map((entry) => [entry.id, entry.reason]), [
    ['workflow:b', 'Switched off: it is not armed.'],
    ['workflow:daily-brief', 'Switched off: Off until the pipeline has people in it.']
  ])
  assert.equal(result.counts.switchedOff, 2)
})

test('switched off: its owner agent is switched off, or it only runs from a button or a webhook', () => {
  const owner = wall([workflow({ ownerSwitchedOff: true })]).switchedOff[0]
  assert.equal(owner.reason, 'Switched off: its owner agent is switched off, so it cannot run as written.')
  for (const trigger of [{ fire: true }, { webhook: true }]) {
    const entry = wall([workflow({ schedule: null, arm: 'off', armed: false, ...trigger })]).switchedOff[0]
    assert.equal(entry.reason, 'Switched off: it only runs when a button or a webhook starts it.')
  }
})

test('switched off: hidden in jobs.yml, and a name from jobs.yml replaces the file\'s', () => {
  const overrides = shapeJobOverrides({ jobs: [{ id: 'workflow:daily-brief', hide: true }, { id: 'workflow:b', name: 'Morning brief' }] })
  const result = wall([workflow(), workflow({ slug: 'b', name: 'B' })], { overrides })
  assert.deepEqual(result.switchedOff.map((entry) => [entry.id, entry.reason]), [['workflow:daily-brief', 'Switched off: hidden in jobs.yml.']])
  assert.equal(result.cards[0].name, 'Morning brief')
  assert.equal(result.cards[0].sentence.text, 'Morning brief ran clean at {time}.')
})

/* ---------- routines with no workflow file ------------------------------------------------------ */

test('a routine on the account with no workflow file is SILENT, by name only', () => {
  const routines = { known: true, orphans: [{ id: 'trig_1', name: 'Old experiment' }, { id: null, name: '(unnamed)' }] }
  const result = wall([], { routines })
  assert.deepEqual(result.cards.map((card) => [card.id, card.light, card.source]), [['routine:(unnamed)', 'silent', 'routine'], ['routine:Old experiment', 'silent', 'routine']])
  assert.equal(result.cards[1].sentence.text, 'Old experiment is a routine on your account with no workflow file, so the board has nothing to check it against.')
  assert.equal(result.cards[1].schedule.text, 'Not known')
})

test('routines the board cannot trust are not turned into cards', () => {
  assert.deepEqual(wall([], { routines: { known: false, orphans: [{ id: 'x', name: 'Ghost' }] } }).cards, [])
  assert.deepEqual(wall([], { routines: null }).cards, [])
  assert.equal(wall([], { routines: { known: true, orphans: [] } }).routinesKnown, true)
})

test('an account routine can be renamed or hidden in jobs.yml, whatever case it is written in', () => {
  const routines = { known: true, orphans: [{ id: 'trig_1', name: 'Old Experiment' }, { id: 'trig_2', name: 'Other' }] }
  const overrides = shapeJobOverrides({ jobs: [{ id: 'routine:old experiment', hide: true }, { id: 'routine:other', name: 'Other thing' }] })
  const result = wall([], { routines, overrides })
  assert.deepEqual(result.cards.map((card) => card.name), ['Other thing'])
  assert.deepEqual(result.switchedOff.map((entry) => entry.reason), ['Switched off: hidden in jobs.yml.'])
})

/* ---------- the Mac: the reading's own clock ---------------------------------------------------- */

const TAKEN = '2026-10-09T15:00:00Z'
const MAC_NOW = at('2026-10-09T15:05:00Z')
const slot = (hour, minute, extra = {}) => ({ minute, hour, ...extra })
const daily = (hour, minute) => ({ kind: 'slots', slots: [slot(hour, minute)] })
const lj = (patch = {}) => ({ label: 'local.donna.story-belt-daily', cadence: daily(6, 15), state: 'loaded', lastExit: 0, lastReportAt: '2026-10-09T10:15:22Z', dueAt: '2026-10-09T10:15:00Z', dueBeforeAt: '2026-10-08T10:15:00Z', ...patch })
const hj = (patch = {}) => ({ profile: 'default', id: 'a1b2c3d4e5f6', name: 'Hermes job a1b2c3d4e5f6', enabled: true, cadence: daily(6, 30), lastRunAt: '2026-10-09T10:30:04Z', lastResult: 'ok', dueAt: '2026-10-09T10:30:00Z', dueBeforeAt: '2026-10-08T10:30:00Z', ...patch })
const reading = ({ launchd = [lj()], hermes = [], taken = TAKEN, computer = 'Mac Mini', launchdBlock, hermesBlock, hidden = [0, 0] } = {}) => ({
  schema: 'agent-status/jobs/v1',
  takenAt: taken,
  computer,
  timezone: 'America/New_York',
  launchd: launchdBlock ?? { status: 'found', items: launchd, hidden: hidden[0], more: 0 },
  hermes: hermesBlock ?? { status: 'found', items: hermes, hidden: hidden[1], more: 0 }
})
const jobsFrom = (docs, now = MAC_NOW) => shapeJobs((Array.isArray(docs) ? docs : [docs]).map((doc, index) => [`${JOBS_FOLDER}/mac-${index}.json`, JSON.stringify(doc)]), now)
const mac = (doc, extra = {}, now = MAC_NOW) => shapeReadiness({ jobs: jobsFrom(doc, now), now, ...extra })
const cardOf = (result, id) => result.cards.find((card) => card.id === id)
const STORY = 'launchd:local.donna.story-belt-daily'

test('launchd, scheduled, last exit 0 and a log written on its own schedule: GO, ran clean', () => {
  const card = cardOf(mac(reading()), STORY)
  assert.equal(card.light, 'go')
  assert.equal(card.name, 'Story belt daily')
  assert.deepEqual(card.sentence, { text: 'Story belt daily ran clean at {time}.', at: '2026-10-09T10:15:22Z' })
  assert.equal(card.schedule.text, 'Every day at 6:15am (Mac time)')
  assert.deepEqual(card.lastReport, { text: '{time}', at: '2026-10-09T10:15:22Z' })
  assert.equal(card.ref, 'Mac Mini · local.donna.story-belt-daily')
  // A reading judged on the Mac's own clock only changes with the clock when it goes stale.
  assert.equal(card.fadesAt, null)
  assert.equal(card.silentAt, '2026-10-09T23:00:00Z')
  assert.deepEqual(card.silentSentence, { text: READINESS_WORDS.notChecked, at: TAKEN })
})

test('launchd, not loaded: NO GO, it will not run', () => {
  const card = cardOf(mac(reading({ launchd: [lj({ state: 'not loaded', lastExit: undefined })] })), STORY)
  assert.equal(card.light, 'no-go')
  assert.equal(card.sentence.text, "Story belt daily is installed but not switched on in the Mac's scheduler, so it will not run.")
})

test('launchd, always on with a process: GO with the RUNNING pill, and the sentence that says what that proves', () => {
  const card = cardOf(mac(reading({ launchd: [{ label: 'local.donna.security-changelog', cadence: { kind: 'always' }, state: 'running', lastReportAt: '2026-10-09T14:50:02Z' }] })), 'launchd:local.donna.security-changelog')
  assert.equal(card.light, 'go')
  assert.equal(card.pill, 'RUNNING')
  assert.equal(card.name, 'Security changelog')
  assert.deepEqual(card.sentence, {
    text: 'Security changelog was running when the Mac checked at {time}. Its scheduler is running. Whether its last report was written is checked on the Mac control center, not here.',
    at: TAKEN
  })
  assert.equal(card.schedule.text, 'Always on')
})

test('the eight Mac programs that keep their own clock are named by label, from the control center\'s deploy scripts', () => {
  assert.deepEqual([...MANAGED_OWNER_LABELS].sort(), [
    'local.donna.facebook-ads-daily-digest',
    'local.donna.facebook-ads-monitor-account-rules',
    'local.donna.facebook-ads-weekly-report',
    'local.donna.model-watch-weekly',
    'local.donna.security-changelog',
    'local.donna.software-skills-watch',
    'local.donna.substack-weekly-briefing',
    'local.donna.team-maintenance-weekly'
  ])
})

test('launchd, always on: only a managed owner gets the sentence about the control center; any other service is just "was running"', () => {
  const running = (label) => ({ label, cadence: { kind: 'always' }, state: 'running', lastReportAt: '2026-10-09T14:50:02Z' })
  for (const label of MANAGED_OWNER_LABELS) {
    const card = cardOf(mac(reading({ launchd: [running(label)] })), `launchd:${label}`)
    assert.ok(card.sentence.text.endsWith('Its scheduler is running. Whether its last report was written is checked on the Mac control center, not here.'), label)
    assert.equal(card.pill, 'RUNNING')
  }
  for (const label of ['local.donna.nightly-sync', 'com.example.web-server', 'local.donna.security-changelog-extra', 'local.donna.Security-Changelog']) {
    const card = cardOf(mac(reading({ launchd: [running(label)] })), `launchd:${label}`)
    assert.equal(card.light, 'go')
    assert.equal(card.pill, 'RUNNING')
    assert.ok(!card.sentence.text.includes('control center'), `${label} was told about the control center`)
    assert.deepEqual(card.sentence, { text: `${card.name} was running when the Mac checked at {time}.`, at: TAKEN })
  }
})

test('launchd, always on without a process: NO GO, it was not running', () => {
  const card = cardOf(mac(reading({ launchd: [{ label: 'local.donna.security-changelog', cadence: { kind: 'always' }, state: 'loaded' }] })), 'launchd:local.donna.security-changelog')
  assert.equal(card.light, 'no-go')
  assert.equal(card.pill, null)
  assert.deepEqual(card.sentence, { text: 'Security changelog was not running when the Mac checked at {time}.', at: TAKEN })
})

test('launchd, last exit not 0 and recent: NO GO, with the code and an honest "the Mac does not say why"', () => {
  const card = cardOf(mac(reading({ launchd: [lj({ lastExit: 78 })] })), STORY)
  assert.equal(card.light, 'no-go')
  assert.deepEqual(card.sentence, { text: 'Story belt daily stopped with error code 78. The Mac does not say why; its log on the Mac has the reason.', at: '2026-10-09T10:15:22Z' })
  const negative = cardOf(mac(reading({ launchd: [lj({ lastExit: -9 })] })), STORY)
  assert.match(negative.sentence.text, /error code -9\./)
})

test('launchd, failed and then silent for two slots: SILENT, and says its last run failed', () => {
  const card = cardOf(mac(reading({ launchd: [lj({ lastExit: 1, lastReportAt: '2026-10-07T10:15:22Z' })] })), STORY)
  assert.equal(card.light, 'silent')
  assert.deepEqual(card.sentence, { text: 'Has not reported since {date}. Its last run failed.', at: '2026-10-07T10:15:22Z' })
})

test('launchd, no log time at all: SILENT, never reported', () => {
  const card = cardOf(mac(reading({ launchd: [lj({ lastReportAt: undefined })] })), STORY)
  assert.equal(card.light, 'silent')
  assert.deepEqual(card.sentence, { text: 'Has never reported.', at: null })
})

test('launchd, its newest slot missed but the one before covered: FADED', () => {
  const card = cardOf(mac(reading({ launchd: [lj({ lastReportAt: '2026-10-08T10:15:22Z' })] })), STORY)
  assert.equal(card.light, 'go')
  assert.equal(card.faded, true)
  assert.equal(card.sentence.text, 'Story belt daily ran clean at {time}. Its last report is older than its own schedule.')
})

test('launchd, a report up to five minutes before the slot counts for it', () => {
  const counts = cardOf(mac(reading({ launchd: [lj({ lastReportAt: '2026-10-09T10:10:00Z' })] })), STORY)
  assert.equal(counts.faded, false)
  const misses = cardOf(mac(reading({ launchd: [lj({ lastReportAt: '2026-10-09T10:09:59Z' })] })), STORY)
  assert.equal(misses.faded, true)
})

test('launchd, the newest expected run missed and no earlier one to count: SILENT, never GO', () => {
  // A monthly job has only one expected run in the look-back. Last run July 1, due October 1: that is
  // a missed run and nothing that covers the one before it, so it is two missed, not one.
  const monthly = { kind: 'slots', slots: [{ minute: 0, hour: 8, day: 1 }] }
  const card = cardOf(mac(reading({ launchd: [lj({ cadence: monthly, lastReportAt: '2026-07-01T08:00:20Z', dueAt: '2026-10-01T08:00:00Z', dueBeforeAt: undefined })] })), STORY)
  assert.equal(card.light, 'silent')
  assert.equal(card.faded, false)
  assert.deepEqual(card.sentence, { text: 'Has not reported since {date}.', at: '2026-07-01T08:00:20Z' })
  assert.equal(card.schedule.text, 'Monthly on the 1st at 8:00am (Mac time)')
  // It never reads as green, faded or not, and the same job that reported on its slot is GO.
  const covered = cardOf(mac(reading({ launchd: [lj({ cadence: monthly, lastReportAt: '2026-10-01T08:00:20Z', dueAt: '2026-10-01T08:00:00Z', dueBeforeAt: undefined })] })), STORY)
  assert.equal(covered.light, 'go')
  assert.equal(covered.faded, false)
  // A failure that is never followed by a report says so too.
  const failed = cardOf(mac(reading({ launchd: [lj({ cadence: monthly, lastExit: 1, lastReportAt: '2026-07-01T08:00:20Z', dueAt: '2026-10-01T08:00:00Z', dueBeforeAt: undefined })] })), STORY)
  assert.equal(failed.sentence.text, 'Has not reported since {date}. Its last run failed.')
})

test('launchd, no exit status for a job that is loaded: SILENT, it has not said how its last run ended', () => {
  // A recent log is not an outcome. The last exit is what says whether the run worked.
  const card = cardOf(mac(reading({ launchd: [lj({ lastExit: undefined })] })), STORY)
  assert.equal(card.light, 'silent')
  assert.equal(card.faded, false)
  assert.deepEqual(card.sentence, { text: 'Story belt daily has not said how its last run ended. Its log was last written at {time}.', at: '2026-10-09T10:15:22Z' })
  // The same for a schedule nobody could read, and for one with nothing due lately.
  const unknown = cardOf(mac(reading({ launchd: [lj({ lastExit: undefined, cadence: { kind: 'unknown' }, dueAt: undefined, dueBeforeAt: undefined })] })), STORY)
  assert.equal(unknown.light, 'silent')
  assert.match(unknown.sentence.text, /has not said how its last run ended/)
  // A job that is running right now has no last exit to give, and is not marked down for it.
  assert.equal(cardOf(mac(reading({ launchd: [lj({ state: 'running', lastExit: undefined })] })), STORY).light, 'go')
  // And one that is not loaded at all is still NO GO for that.
  assert.equal(cardOf(mac(reading({ launchd: [lj({ state: 'not loaded', lastExit: undefined })] })), STORY).light, 'no-go')
})

test('launchd, a schedule the collector could not read: the light comes from the last exit alone, and says so', () => {
  const unknown = { kind: 'unknown' }
  const ok = cardOf(mac(reading({ launchd: [lj({ cadence: unknown, dueAt: undefined, dueBeforeAt: undefined })] })), STORY)
  assert.equal(ok.light, 'go')
  assert.equal(ok.schedule.text, 'Not known')
  assert.equal(ok.sentence.text, 'Story belt daily ran clean at {time}. The schedule could not be read, so lateness is not judged.')
  const failed = cardOf(mac(reading({ launchd: [lj({ cadence: unknown, lastExit: 2 })] })), STORY)
  assert.equal(failed.light, 'no-go')
  assert.match(failed.sentence.text, /error code 2\..*The schedule could not be read/)
  const silent = cardOf(mac(reading({ launchd: [lj({ cadence: unknown, lastReportAt: undefined })] })), STORY)
  assert.equal(silent.sentence.text, 'Has never reported.')
})

test('launchd, a schedule with nothing due in the look-back: judged by the last exit, and says nothing has been due', () => {
  const card = cardOf(mac(reading({ launchd: [lj({ cadence: { kind: 'slots', slots: [{ minute: 0, hour: 8, day: 31 }] }, dueAt: undefined, dueBeforeAt: undefined })] })), STORY)
  assert.equal(card.light, 'go')
  assert.equal(card.sentence.text, 'Story belt daily ran clean at {time}. Nothing has been due to run lately, so lateness is not judged.')
  assert.equal(card.schedule.text, 'Monthly on the 31st at 8:00am (Mac time)')
})

test('launchd, a calendar job that is running right now is GO, said as running', () => {
  const card = cardOf(mac(reading({ launchd: [lj({ state: 'running', lastExit: undefined })] })), STORY)
  assert.equal(card.light, 'go')
  assert.equal(card.pill, null)
  assert.equal(card.sentence.text, 'Story belt daily was running when the Mac checked at {time}.')
})

test('launchd, running right now after a failed run: GO, because the run that is going may be the one that fixes it', () => {
  const card = cardOf(mac(reading({ launchd: [lj({ state: 'running', lastExit: 1 })] })), STORY)
  assert.equal(card.light, 'go')
  assert.equal(card.sentence.text, 'Story belt daily was running when the Mac checked at {time}.')
})

test('launchd, switched off in its plist or hidden in jobs.yml: listed under switched off, not lit', () => {
  const result = mac(reading({ launchd: [lj({ state: 'not loaded', disabled: true, lastExit: undefined }), lj({ label: 'local.donna.other' })] }), { overrides: shapeJobOverrides({ jobs: [{ id: 'launchd:local.donna.other', hide: true }] }) })
  assert.deepEqual(result.cards.filter((card) => card.source === 'launchd'), [])
  assert.deepEqual(result.switchedOff.map((entry) => [entry.id, entry.name, entry.reason]), [
    ['launchd:local.donna.other', 'Other', 'Switched off: hidden in jobs.yml.'],
    [STORY, 'Story belt daily', "Switched off: turned off on the Mac (its plist says Disabled), so the Mac's scheduler is told not to run it."]
  ])
})

test('launchd, a name from jobs.yml replaces the readable label', () => {
  const overrides = shapeJobOverrides({ jobs: [{ id: STORY, name: 'Story belt, daily' }] })
  const card = cardOf(mac(reading(), { overrides }), STORY)
  assert.equal(card.name, 'Story belt, daily')
  assert.equal(card.sentence.text, 'Story belt, daily ran clean at {time}.')
})

test('launchd, readable labels: the first two parts are who made it, not what it does', () => {
  for (const [label, name] of [
    ['local.donna.story-belt-daily', 'Story belt daily'],
    ['com.donna.blog-watch', 'Blog watch'],
    ['ai.hermes.gateway-donna', 'Gateway donna'],
    ['com.example.Weekly_Report', 'Weekly Report'],
    ['com.donna', 'Donna'],
    ['nightly-brief', 'Nightly brief'],
    ['a1b2c3d4e5f6', 'A1b2c3d4e5f6'],
    ['local.donna.a.b.c', 'A b c']
  ]) assert.equal(readableLabel(label), name, label)
})

test('a Mac reading older than eight hours: every Mac card is SILENT with how old the reading is, never a light', () => {
  const now = at('2026-10-10T00:30:00Z')
  const result = shapeReadiness({
    jobs: jobsFrom(reading({
      launchd: [lj(), { label: 'local.donna.security-changelog', cadence: { kind: 'always' }, state: 'running' }, lj({ label: 'local.donna.off', state: 'not loaded', disabled: true })],
      hermes: [hj(), hj({ id: 'b2c3d4e5f6a1', name: 'Hermes job b2c3d4e5f6a1', enabled: false })]
    }), now),
    now
  })
  assert.ok(result.cards.length >= 4)
  for (const card of result.cards) {
    assert.equal(card.light, 'silent', card.id)
    assert.equal(card.pill, null)
    assert.equal(card.faded, false)
    assert.equal(card.silentAt, null)
    // The collector's own card says the more useful thing: it has not written, so nothing is checked.
    if (card.source === 'collector') assert.equal(card.sentence.text, 'The status collector has not written its readings since {date}, so nothing on the Mac is being checked.')
    else assert.deepEqual(card.sentence, { text: READINESS_WORDS.notChecked, at: TAKEN }, card.id)
  }
  assert.equal(READINESS_WORDS.notChecked, "Not checked since {date}. The Mac's last reading is {hours} h old.")
  // Switched off stays switched off, however old the reading.
  assert.deepEqual(result.switchedOff.map((entry) => entry.id).sort(), ['hermes:default/b2c3d4e5f6a1', 'launchd:local.donna.off'])
})

test('a Mac reading just inside eight hours still gives lights', () => {
  const now = at('2026-10-09T22:59:00Z')
  const result = shapeReadiness({ jobs: jobsFrom(reading({ launchd: [lj({ dueAt: '2026-10-09T10:15:00Z' })] }), now), now })
  assert.notEqual(cardOf(result, STORY).sentence.text, READINESS_WORDS.notChecked)
})

/* ---------- the status collector's own card ---------------------------------------------------- */

const SELF = { label: 'local.donna.agent-status-collector', cadence: { kind: 'slots', slots: [0, 3, 6, 9, 12, 15, 18, 21].map((hour) => slot(hour, 0)) }, state: 'loaded', lastExit: 0, self: true }

test('the collector row: GO when it wrote inside every three hours, its own launchd row dropped', () => {
  const result = mac(reading({ launchd: [SELF, lj()] }))
  assert.equal(result.cards.some((card) => card.id === 'launchd:local.donna.agent-status-collector'), false)
  const card = cardOf(result, 'collector:Mac Mini')
  assert.equal(card.light, 'go')
  assert.equal(card.source, 'collector')
  assert.equal(card.name, 'Status collector')
  assert.deepEqual(card.sentence, { text: 'The status collector last wrote its readings at {time}.', at: TAKEN })
  assert.equal(card.schedule.text, 'Every 3 hours')
  assert.equal(card.ref, 'Mac Mini · status collector')
  assert.equal(card.fadesAt, '2026-10-09T18:35:00Z')
  assert.equal(card.silentAt, '2026-10-09T21:35:00Z')
})

test('the collector row: faded after three hours and a half, silent after six and a half', () => {
  const faded = shapeReadiness({ jobs: jobsFrom(reading({ launchd: [SELF] }), at('2026-10-09T19:00:00Z')), now: at('2026-10-09T19:00:00Z') })
  const fadedCard = cardOf(faded, 'collector:Mac Mini')
  assert.equal(fadedCard.light, 'go')
  assert.equal(fadedCard.faded, true)
  assert.equal(fadedCard.sentence.text, 'The status collector last wrote its readings at {time}. Its last report is older than its own schedule.')
  const silent = shapeReadiness({ jobs: jobsFrom(reading({ launchd: [SELF] }), at('2026-10-09T22:00:00Z')), now: at('2026-10-09T22:00:00Z') })
  const silentCard = cardOf(silent, 'collector:Mac Mini')
  assert.equal(silentCard.light, 'silent')
  assert.deepEqual(silentCard.sentence, { text: 'The status collector has not written its readings since {date}, so nothing on the Mac is being checked.', at: TAKEN })
})

/* ---------- a list the Mac could not give ----------------------------------------------------- */

const UNAVAILABLE = (why) => ({ status: 'unavailable', ...(why === undefined ? {} : { why }) })

test('a LaunchAgents list the Mac could not give is a SILENT card with the fixed reason, counted in the badge', () => {
  const result = mac(reading({ launchdBlock: UNAVAILABLE('refused by the safety check') }))
  const card = cardOf(result, 'jobs-list:Mac Mini:launchd')
  assert.equal(card.light, 'silent')
  assert.equal(card.source, 'jobs-list')
  assert.equal(card.name, 'Mac LaunchAgents')
  assert.deepEqual(card.sentence, { text: "The Mac's list of LaunchAgents was not available at {time}: refused by the safety check.", at: TAKEN })
  assert.equal(card.ref, 'Mac Mini · LaunchAgents list')
  assert.equal(result.counts.silent >= 1, true)
  assert.equal(result.badge, result.counts.noGo + result.counts.silent)
  assert.ok(result.badge >= 1, 'a list that could not be read left the tab at zero')
})

test('a Hermes list the Mac could not give is its own SILENT card, and a reason that is not given is said so', () => {
  const unreadable = cardOf(mac(reading({ hermesBlock: UNAVAILABLE('could not be read') })), 'jobs-list:Mac Mini:hermes')
  assert.equal(unreadable.name, 'Hermes cron jobs')
  assert.equal(unreadable.sentence.text, "The Mac's list of Hermes cron jobs was not available at {time}: could not be read.")
  const noReason = cardOf(mac(reading({ hermesBlock: UNAVAILABLE() })), 'jobs-list:Mac Mini:hermes')
  assert.equal(noReason.sentence.text, "The Mac's list of Hermes cron jobs was not available at {time}, and the Mac did not say why.")
})

test('a jobs file the safety check refused leaves both lists unavailable, and still has its collector card', () => {
  const result = mac(reading({ launchdBlock: UNAVAILABLE('refused by the safety check'), hermesBlock: UNAVAILABLE('refused by the safety check') }))
  assert.deepEqual(result.cards.map((card) => card.id).sort(), ['collector:Mac Mini', 'jobs-list:Mac Mini:hermes', 'jobs-list:Mac Mini:launchd'])
  assert.equal(cardOf(result, 'collector:Mac Mini').light, 'go')
  assert.equal(result.badge, 2)
})

test('a list that is simply not there is not a problem: no card for "not found", on any computer', () => {
  const result = mac(reading({ launchdBlock: { status: 'not found' }, hermesBlock: { status: 'not found' } }))
  assert.deepEqual(result.cards.map((card) => card.id), ['collector:Mac Mini'])
  assert.equal(result.badge, 0)
})

test('a list that could not be given, in a reading that is old, says how old - not that it was unavailable at a time long gone', () => {
  const now = at('2026-10-10T00:30:00Z')
  const result = shapeReadiness({ jobs: jobsFrom(reading({ launchdBlock: UNAVAILABLE('could not be read') }), now), now })
  const card = cardOf(result, 'jobs-list:Mac Mini:launchd')
  assert.deepEqual(card.sentence, { text: READINESS_WORDS.notChecked, at: TAKEN })
  assert.equal(card.light, 'silent')
})

test('each computer\'s lists are named by that computer', () => {
  const result = mac([reading({ launchdBlock: UNAVAILABLE('could not be read') }), reading({ computer: 'Laptop', launchdBlock: UNAVAILABLE('could not be read') })])
  assert.deepEqual(result.cards.filter((card) => card.source === 'jobs-list').map((card) => card.id).sort(), ['jobs-list:Laptop:launchd', 'jobs-list:Mac Mini:launchd'])
})

test('the collector row without its own launchd row still exists, on the three-hour schedule', () => {
  const card = cardOf(mac(reading({ launchd: [lj()] })), 'collector:Mac Mini')
  assert.equal(card.schedule.text, 'Every 3 hours')
})

/* ---------- Hermes: the gateway, and its cron jobs --------------------------------------------- */

const hermesReading = (patch = {}) => ({
  status: 'ok',
  computers: [{ computer: 'Mac Mini', takenAt: TAKEN, alive: 'running', install: { status: 'found' }, ...patch }]
})
const GATEWAY = { label: 'ai.hermes.gateway-donna', cadence: { kind: 'always' }, state: 'running' }

test('Hermes itself: GO and RUNNING when it was running, and its gateway LaunchAgent is not shown a second time', () => {
  const result = mac(reading({ launchd: [GATEWAY, lj()] }), { hermes: hermesReading() })
  assert.equal(result.cards.some((card) => card.id === 'launchd:ai.hermes.gateway-donna'), false)
  const card = cardOf(result, 'hermes-service:Mac Mini')
  assert.equal(card.light, 'go')
  assert.equal(card.pill, 'RUNNING')
  assert.equal(card.name, 'Hermes')
  assert.deepEqual(card.sentence, { text: 'Hermes was running when the Mac checked at {time}.', at: TAKEN })
  assert.equal(card.silentAt, '2026-10-09T23:00:00Z')
})

test('Hermes itself: NO GO when it was not running, SILENT when the reading is old, nothing when it is not installed', () => {
  const down = cardOf(mac(reading(), { hermes: hermesReading({ alive: 'down' }) }), 'hermes-service:Mac Mini')
  assert.equal(down.light, 'no-go')
  assert.equal(down.sentence.text, 'Hermes was not running when the Mac checked at {time}.')
  const stale = cardOf(mac(reading(), { hermes: hermesReading({ alive: 'stale' }) }), 'hermes-service:Mac Mini')
  assert.equal(stale.light, 'silent')
  assert.deepEqual(stale.sentence, { text: READINESS_WORDS.notChecked, at: TAKEN })
  const none = mac(reading(), { hermes: hermesReading({ install: { status: 'not found' } }) })
  assert.equal(none.cards.some((card) => card.source === 'hermes-service'), false)
  assert.equal(mac(reading(), { hermes: { status: 'none', computers: [] } }).cards.some((card) => card.source === 'hermes-service'), false)
})

test('with no Hermes reading the gateway LaunchAgent keeps its own card, because it is all there is', () => {
  const card = cardOf(mac(reading({ launchd: [GATEWAY] }), { hermes: { status: 'none', computers: [] } }), 'launchd:ai.hermes.gateway-donna')
  assert.equal(card.light, 'go')
  assert.equal(card.pill, 'RUNNING')
})

test('Hermes cron job, clean on its own schedule: GO, under the standard name', () => {
  const card = cardOf(mac(reading({ launchd: [], hermes: [hj()] })), 'hermes:default/a1b2c3d4e5f6')
  assert.equal(card.light, 'go')
  assert.equal(card.name, 'Hermes job a1b2c3d4e5f6')
  assert.deepEqual(card.sentence, { text: 'Hermes job a1b2c3d4e5f6 ran clean at {time}.', at: '2026-10-09T10:30:04Z' })
  assert.equal(card.schedule.text, 'Every day at 6:30am (Mac time)')
  assert.equal(card.ref, 'Mac Mini · Hermes · default · a1b2c3d4e5f6')
})

test('Hermes cron job, its last run ended in an error and is recent: NO GO, and Hermes keeps the reason', () => {
  const card = cardOf(mac(reading({ launchd: [], hermes: [hj({ lastResult: 'error' })] })), 'hermes:default/a1b2c3d4e5f6')
  assert.equal(card.light, 'no-go')
  assert.deepEqual(card.sentence, { text: 'Hermes job a1b2c3d4e5f6 did not finish at {time}. Hermes keeps the reason; open Hermes to read it.', at: '2026-10-09T10:30:04Z' })
})

test('Hermes cron job: never run, or silent for two slots, or a result Hermes did not word: SILENT', () => {
  const never = cardOf(mac(reading({ launchd: [], hermes: [hj({ lastRunAt: undefined, lastResult: 'unknown' })] })), 'hermes:default/a1b2c3d4e5f6')
  assert.deepEqual(never.sentence, { text: 'Has never reported.', at: null })
  const old = cardOf(mac(reading({ launchd: [], hermes: [hj({ lastRunAt: '2026-10-07T10:30:04Z', lastResult: 'error' })] })), 'hermes:default/a1b2c3d4e5f6')
  assert.equal(old.light, 'silent')
  assert.equal(old.sentence.text, 'Has not reported since {date}. Its last run failed.')
  const unsaid = cardOf(mac(reading({ launchd: [], hermes: [hj({ lastResult: 'unknown' })] })), 'hermes:default/a1b2c3d4e5f6')
  assert.equal(unsaid.light, 'silent')
  assert.equal(unsaid.sentence.text, "Hermes did not say how Hermes job a1b2c3d4e5f6's last run, at {time}, ended.")
})

test('Hermes cron job, the newest expected run missed and no earlier one: SILENT, never GO', () => {
  const monthly = { kind: 'slots', slots: [{ minute: 0, hour: 8, day: 1 }] }
  const card = cardOf(mac(reading({ launchd: [], hermes: [hj({ cadence: monthly, lastRunAt: '2026-07-01T08:00:04Z', dueAt: '2026-10-01T08:00:00Z', dueBeforeAt: undefined })] })), 'hermes:default/a1b2c3d4e5f6')
  assert.equal(card.light, 'silent')
  assert.equal(card.sentence.text, 'Has not reported since {date}.')
})

test('Hermes cron job, faded and unjudged', () => {
  const faded = cardOf(mac(reading({ launchd: [], hermes: [hj({ lastRunAt: '2026-10-08T10:30:04Z' })] })), 'hermes:default/a1b2c3d4e5f6')
  assert.equal(faded.faded, true)
  const unknown = cardOf(mac(reading({ launchd: [], hermes: [hj({ cadence: { kind: 'unknown' }, dueAt: undefined, dueBeforeAt: undefined })] })), 'hermes:default/a1b2c3d4e5f6')
  assert.equal(unknown.light, 'go')
  assert.match(unknown.sentence.text, /The schedule could not be read, so lateness is not judged\.$/)
})

test('Hermes cron job, switched off in Hermes or hidden in jobs.yml: listed under switched off; a name from jobs.yml replaces the standard one', () => {
  const result = mac(reading({ launchd: [], hermes: [hj({ enabled: false }), hj({ id: 'b2c3d4e5f6a1', name: 'Hermes job b2c3d4e5f6a1' }), hj({ profile: 'donna', id: 'c3d4e5f6a1b2', name: 'Hermes job c3d4e5f6a1b2' })] }), {
    overrides: shapeJobOverrides({ jobs: [{ id: 'hermes:default/b2c3d4e5f6a1', hide: true }, { id: 'hermes:donna/c3d4e5f6a1b2', name: 'YouTube morning brief' }] })
  })
  assert.deepEqual(result.switchedOff.map((entry) => [entry.id, entry.reason]).sort(), [
    ['hermes:default/a1b2c3d4e5f6', 'Switched off: turned off in Hermes.'],
    ['hermes:default/b2c3d4e5f6a1', 'Switched off: hidden in jobs.yml.']
  ])
  const named = cardOf(result, 'hermes:donna/c3d4e5f6a1b2')
  assert.equal(named.name, 'YouTube morning brief')
  assert.equal(named.sentence.text, 'YouTube morning brief ran clean at {time}.')
})

/* ---------- what the wall says about what it could not see -------------------------------------- */

test('no jobs file yet: no Mac cards, and the wall says why', () => {
  const result = shapeReadiness({ workflows: [workflow()], jobs: shapeJobs([], MONDAY), now: MONDAY })
  assert.deepEqual(result.cards.map((card) => card.source), ['workflow'])
  assert.deepEqual(result.jobs, { status: 'none', why: 'No jobs reading has been taken yet.' })
  assert.equal(result.macCheckedAt, null)
  const unusable = shapeReadiness({ jobs: shapeJobs([[`${JOBS_FOLDER}/a.json`, '{ broken']], MONDAY), now: MONDAY })
  assert.equal(unusable.jobs.status, 'unusable')
  assert.match(unusable.jobs.why, /could not be read/)
})

test('a missing jobs argument and an empty call both give an empty wall', () => {
  for (const result of [shapeReadiness(), shapeReadiness({ now: MONDAY }), wall([], {})]) {
    assert.deepEqual(result.cards, [])
    assert.deepEqual(result.switchedOff, [])
    assert.equal(result.badge, 0)
    assert.deepEqual(result.counts, { noGo: 0, silent: 0, go: 0, faded: 0, switchedOff: 0, hiddenBySafety: 0 })
  }
})

test('how many jobs the safety rule kept off the wall is counted, and the newest Mac reading is named', () => {
  const second = reading({ computer: 'Laptop', taken: '2026-10-09T14:00:00Z', hidden: [2, 3] })
  const result = mac([reading({ hidden: [1, 0] }), second])
  assert.equal(result.counts.hiddenBySafety, 6)
  assert.equal(result.macCheckedAt, TAKEN)
})

test('each Mac is judged by its own reading', () => {
  const result = mac([reading(), reading({ computer: 'Laptop', taken: '2026-10-09T05:00:00Z', launchd: [lj({ label: 'local.donna.laptop-job' })] })])
  assert.equal(cardOf(result, 'launchd:local.donna.laptop-job').light, 'silent')
  assert.equal(cardOf(result, STORY).light, 'go')
  assert.equal(cardOf(result, 'collector:Laptop').light, 'silent')
})

test('a computer with no name is still a card, shown as "Mac"', () => {
  const result = mac(reading({ computer: '' }))
  assert.equal(cardOf(result, STORY).ref, 'Mac · local.donna.story-belt-daily')
})

/* ---------- order and counts -------------------------------------------------------------------- */

test('order: NO GO, then SILENT, then GO; faded last inside each; then by name', () => {
  const result = wall([
    workflow({ slug: 'z-ok', name: 'Zed' }),
    workflow({ slug: 'a-ok', name: 'Ada' }),
    workflow({ slug: 'faded-ok', name: 'Aaa faded', ...withRun({ started_at: '2026-08-09T06:00:20Z' }) }),
    workflow({ slug: 'never', name: 'Never run', lastRun: null }),
    workflow({ slug: 'declared-b', name: 'Bravo', arm: 'declared' }),
    workflow({ slug: 'declared-a', name: 'Alpha', arm: 'declared' }),
    workflow({ slug: 'failed-faded', name: 'Aaa failed', ...withRun({ started_at: '2026-08-09T06:00:20Z', status: 'failed', summary: 'Broke.' }) })
  ])
  assert.deepEqual(result.cards.map((card) => [card.name, card.light, card.faded]), [
    ['Alpha', 'no-go', false],
    ['Bravo', 'no-go', false],
    ['Aaa failed', 'no-go', true],
    ['Never run', 'silent', false],
    ['Ada', 'go', false],
    ['Zed', 'go', false],
    ['Aaa faded', 'go', true]
  ])
  assert.deepEqual(result.counts, { noGo: 3, silent: 1, go: 3, faded: 2, switchedOff: 0, hiddenBySafety: 0 })
  assert.equal(result.badge, 4)
})

test('a wall like the reference: 2 NO GO, 5 SILENT, 23 GO', () => {
  const rows = [
    ...Array.from({ length: 2 }, (_, index) => workflow({ slug: `declared-${index}`, name: `Declared ${index}`, arm: 'declared' })),
    ...Array.from({ length: 5 }, (_, index) => workflow({ slug: `never-${index}`, name: `Never ${index}`, lastRun: null })),
    ...Array.from({ length: 23 }, (_, index) => workflow({ slug: `ok-${String(index).padStart(2, '0')}`, name: `Ok ${String(index).padStart(2, '0')}` }))
  ]
  const result = wall(rows)
  assert.deepEqual(result.counts, { noGo: 2, silent: 5, go: 23, faded: 0, switchedOff: 0, hiddenBySafety: 0 })
  assert.equal(result.badge, 7)
  assert.deepEqual(result.cards.slice(0, 2).map((card) => card.light), ['no-go', 'no-go'])
  assert.deepEqual(result.cards.slice(2, 7).map((card) => card.light), ['silent', 'silent', 'silent', 'silent', 'silent'])
  assert.equal(result.cards.length, 30)
})

test('orderCards and countCards are the rule the page uses again when a card ages', () => {
  const cards = [{ light: 'go', faded: false, name: 'B', id: 'b' }, { light: 'no-go', faded: true, name: 'A', id: 'a' }, { light: 'silent', faded: false, name: 'C', id: 'c' }]
  assert.deepEqual(orderCards(cards).map((card) => card.id), ['a', 'c', 'b'])
  assert.deepEqual(countCards(cards), { noGo: 1, silent: 1, go: 1, faded: 1 })
  assert.deepEqual(cards.map((card) => card.id), ['b', 'a', 'c'], 'the input is not reordered')
})

/* ---------- the words -------------------------------------------------------------------------- */

test('schedule words, from a cadence', () => {
  const words = (cadence) => cadenceWords(cadence)
  assert.equal(words({ kind: 'always' }), 'Always on')
  assert.equal(words({ kind: 'unknown' }), 'Not known')
  assert.equal(words({ kind: 'every', minutes: 1 }), 'Every minute')
  assert.equal(words({ kind: 'every', minutes: 15 }), 'Every 15 minutes')
  assert.equal(words({ kind: 'every', minutes: 60 }), 'Every hour')
  assert.equal(words({ kind: 'every', minutes: 180 }), 'Every 3 hours')
  assert.equal(words({ kind: 'every', minutes: 90 }), 'Every 90 minutes')
  const s = (...slots) => ({ kind: 'slots', slots: slots.map((entry) => ({ hour: null, weekday: null, day: null, ...entry })) })
  assert.equal(words(s({ minute: 15, hour: 6 })), 'Every day at 6:15am (Mac time)')
  assert.equal(words(s({ minute: 0, hour: 0 })), 'Every day at 12:00am (Mac time)')
  assert.equal(words(s({ minute: 0, hour: 12 })), 'Every day at 12:00pm (Mac time)')
  assert.equal(words(s({ minute: 5, hour: 23 })), 'Every day at 11:05pm (Mac time)')
  assert.equal(words(s({ minute: 15 })), 'Every hour at :15')
  assert.equal(words(s({ minute: 0, hour: 9, weekday: 1 })), 'Mondays at 9:00am (Mac time)')
  assert.equal(words(s({ minute: 0, hour: 9, weekday: 0 })), 'Sundays at 9:00am (Mac time)')
  assert.equal(words(s(...[1, 2, 3, 4, 5].map((weekday) => ({ minute: 45, hour: 7, weekday })))), 'Weekdays at 7:45am (Mac time)')
  assert.equal(words(s({ minute: 0, hour: 8, day: 31 })), 'Monthly on the 31st at 8:00am (Mac time)')
  assert.equal(words(s({ minute: 0, hour: 8, day: 1 })), 'Monthly on the 1st at 8:00am (Mac time)')
  assert.equal(words(s({ minute: 0, hour: 8, day: 22 })), 'Monthly on the 22nd at 8:00am (Mac time)')
  assert.equal(words(s({ minute: 0, hour: 8, day: 13 })), 'Monthly on the 13th at 8:00am (Mac time)')
  assert.equal(words(s(...[0, 3, 6, 9, 12, 15, 18, 21].map((hour) => ({ minute: 0, hour })))), 'Every 3 hours')
  assert.equal(words(s(...[0, 6, 12, 18].map((hour) => ({ minute: 30, hour })))), 'Every 6 hours, at :30')
  assert.equal(words(s(...[6, 12, 18].map((hour) => ({ minute: 0, hour })))), 'Every day at 6:00am, 12:00pm and 6:00pm (Mac time)')
  assert.equal(words(s({ minute: 0, hour: 6 }, { minute: 30, hour: 7, weekday: 2 })), 'A custom schedule (2 times)')
  assert.equal(slotsWords([{ minute: 15, hour: 6, weekday: null, day: null }], ' UTC'), 'Every day at 6:15am UTC')
})

test('schedule words, from a workflow\'s own schedule', () => {
  for (const [schedule, text] of [
    ['hourly', 'Every hour'],
    ['daily 06:15', 'Every day at 6:15am UTC'],
    ['weekdays 07:45', 'Weekdays at 7:45am UTC'],
    ['weekly mon 09:00', 'Mondays at 9:00am UTC'],
    ['weekly sun 23:30', 'Sundays at 11:30pm UTC'],
    ['monthly 31 08:00', 'Monthly on the 31st at 8:00am UTC'],
    ['every 15 minutes', 'Every 15 minutes'],
    ['every 2 hours', 'Every 2 hours'],
    ['every 1 hours', 'Every hour'],
    ['whenever', 'Not known'],
    ['', 'No schedule'],
    [null, 'No schedule'],
    [undefined, 'No schedule']
  ]) assert.equal(workflowScheduleWords(schedule), text, String(schedule))
})

test('a workflow\'s clock, for the page to put in the reader\'s own time', () => {
  const clock = (every, hour, minute, extra = {}) => ({ every, hour, minute, weekday: null, day: null, ...extra })
  assert.deepEqual(workflowClock('daily 06:15'), clock('day', 6, 15))
  assert.deepEqual(workflowClock('weekdays 07:45'), clock('weekdays', 7, 45))
  assert.deepEqual(workflowClock('weekly mon 09:00'), clock('weekly', 9, 0, { weekday: 1 }))
  assert.deepEqual(workflowClock('weekly sun 23:30'), clock('weekly', 23, 30, { weekday: 0 }))
  assert.deepEqual(workflowClock('monthly 31 08:00'), clock('monthly', 8, 0, { day: 31 }))
  for (const none of ['hourly', 'every 2 hours', 'every 15 minutes', 'whenever', '', null, undefined, 7, 'daily 25:00', 'daily 06:60', 'monthly 0 08:00', 'monthly 32 08:00', 'weekly xxx 06:00']) {
    assert.equal(workflowClock(none), null, String(none))
  }
})

test('a clock time that does not exist is "Not known", never a made-up hour', () => {
  for (const schedule of ['daily 25:00', 'daily 06:60', 'weekdays 24:00', 'weekly mon 12:99', 'monthly 31 24:00', 'monthly 40 08:00']) {
    assert.equal(workflowScheduleWords(schedule), 'Not known', schedule)
  }
})

test('every card has a schedule that is text, and only a workflow\'s has a clock', () => {
  const result = mac(reading({ launchd: [SELF, lj()], hermes: [hj()] }), { workflows: [workflow(), workflow({ slug: 'every', name: 'Every', schedule: 'every 2 hours' })], hermes: hermesReading() })
  for (const card of result.cards) {
    assert.equal(typeof card.schedule.text, 'string', card.id)
    if (card.id === 'workflow:daily-brief') assert.equal(card.schedule.clock.every, 'day')
    else assert.equal(card.schedule.clock, null, card.id)
  }
})

test('the switched-off reasons are finished sentences', () => {
  for (const reason of Object.values(SWITCHED_OFF)) assert.match(reason, /^Switched off: |: $/)
  for (const word of Object.values(READINESS_WORDS)) assert.ok(typeof word === 'string' && word.length > 0)
})

test('nothing time-dependent is baked into a sentence: the page fills {time}, {date} and {hours}', () => {
  const result = mac(reading({ launchd: [lj(), lj({ label: 'local.donna.b', state: 'not loaded' })], hermes: [hj()] }), { hermes: hermesReading() })
  for (const card of result.cards) {
    assert.doesNotMatch(card.sentence.text, /\b20\d\d\b/, card.id)
    assert.doesNotMatch(card.sentence.text, /\d{1,2}:\d{2}\s?(am|pm)?\b(?! \(Mac)/i, `${card.id}: ${card.sentence.text}`)
  }
})

test('the output holds nothing but data: no function, no undefined, and it survives a round trip through JSON', () => {
  const result = mac(reading({ launchd: [SELF, lj()], hermes: [hj()] }), { hermes: hermesReading() })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
})
