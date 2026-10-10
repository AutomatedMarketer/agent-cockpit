// The workflow contract: parsing must match the template's yaml-lite subset, validation must
// use the template's words, and the cockpit-side additions — next-run and gone-quiet — must
// be deterministic, so they are all tested against a pinned clock.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseWorkflow,
  normaliseSteps,
  validateWorkflow,
  isValidSchedule,
  scheduleMinutes,
  nextRunAt,
  isGoneQuiet,
  previousRunsAt,
  lateness,
  SLOT_GRACE_MINUTES,
  SLOT_TOLERANCE_MINUTES
} from '../api/workflows.js'
import { RUNNING_GRACE_MINUTES } from '../api/state.js'

// A Monday, 12:00 UTC.
const NOW = Date.parse('2026-08-10T12:00:00Z')

const SOUND = {
  name: 'Monday Brief',
  owner: 'research',
  steps: ['pull-calendar', 'scan-inbox', 'write-brief'],
  trigger: { schedule: 'weekly mon 06:00', fire: true },
  output: 'inbox/{date}/monday-brief.md'
}

/* ---------- parsing ---------- */

test('a workflow file with inline steps parses to the contract shape', () => {
  const data = parseWorkflow(
    'name: Monday Brief\nowner: research\nsteps: [pull-calendar, scan-inbox]\ntrigger:\n  schedule: "weekly mon 06:00"\n  fire: true\noutput: inbox/{date}/monday-brief.md\n'
  )
  assert.equal(data.name, 'Monday Brief')
  assert.deepEqual(data.steps, ['pull-calendar', 'scan-inbox'])
  assert.equal(data.trigger.schedule, 'weekly mon 06:00')
  assert.equal(data.trigger.fire, true)
  assert.equal(data.output, 'inbox/{date}/monday-brief.md')
})

test('dashed step lists parse the same as inline ones', () => {
  const data = parseWorkflow('name: X\nsteps:\n  - one\n  - two\nowner: research\n')
  assert.deepEqual(data.steps, ['one', 'two'])
})

test('the spec form `- skill: name` normalises to plain step names', () => {
  const data = parseWorkflow('name: X\nsteps:\n  - skill: pull-calendar\n  - skill: write-brief\n')
  assert.deepEqual(normaliseSteps(data.steps), ['pull-calendar', 'write-brief'])
})

test('comments and CRLF line endings do not change the parse', () => {
  const data = parseWorkflow('# a comment\r\nname: X\r\nsteps: [a]\r\n')
  assert.equal(data.name, 'X')
  assert.deepEqual(data.steps, ['a'])
})

/* ---------- validation ---------- */

test('a sound workflow has no problems', () => {
  assert.deepEqual(validateWorkflow(SOUND), [])
})

test('missing required fields are each named', () => {
  const problems = validateWorkflow({})
  assert.ok(problems.some((problem) => problem.includes('name is required')))
  assert.ok(problems.some((problem) => problem.includes('owner is required')))
  assert.ok(problems.some((problem) => problem.includes('steps is required')))
  assert.ok(problems.some((problem) => problem.includes('trigger is required')))
  assert.ok(problems.some((problem) => problem.includes('output is required')))
})

test('a schedule below the one-hour routine floor is rejected', () => {
  const problems = validateWorkflow({ ...SOUND, trigger: { schedule: 'every 10 minutes' } })
  assert.ok(problems.some((problem) => problem.includes('60-minute floor')))
})

test('the same fast schedule is fine on github-actions', () => {
  const problems = validateWorkflow({
    ...SOUND,
    runner: 'github-actions',
    trigger: { schedule: 'every 10 minutes' }
  })
  assert.deepEqual(problems, [])
})

test('an unknown owner or step is flagged when the repo contents are known', () => {
  const problems = validateWorkflow(SOUND, { agents: ['email'], skills: ['pull-calendar'] })
  assert.ok(problems.some((problem) => problem.includes('owner "research" is not an agent')))
  assert.ok(problems.some((problem) => problem.includes('step "scan-inbox" is not a skill')))
})

test('an output that escapes the repo is rejected', () => {
  const escaped = validateWorkflow({ ...SOUND, output: '../outside.md' })
  assert.ok(escaped.some((problem) => problem.includes('must stay inside the repo')))
  const absolute = validateWorkflow({ ...SOUND, output: '/etc/passwd' })
  assert.ok(absolute.some((problem) => problem.includes('must stay inside the repo')))
})

test('schedule forms match the template contract', () => {
  for (const good of ['hourly', 'daily 06:00', 'weekdays 09:30', 'weekly mon 06:00', 'monthly 1 08:00', 'every 2 hours']) {
    assert.ok(isValidSchedule(good), good)
  }
  for (const bad of ['daily 6:00', 'weekly monday 06:00', 'sometimes', '', null]) {
    assert.ok(!isValidSchedule(bad), String(bad))
  }
})

/* ---------- next run ---------- */

test('hourly fires at the next top of the hour', () => {
  assert.equal(nextRunAt('hourly', { now: NOW }), '2026-08-10T13:00:00.000Z')
})

test('daily fires later today if the time has not passed, tomorrow if it has', () => {
  assert.equal(nextRunAt('daily 15:30', { now: NOW }), '2026-08-10T15:30:00.000Z')
  assert.equal(nextRunAt('daily 06:00', { now: NOW }), '2026-08-11T06:00:00.000Z')
})

test('weekdays skips the weekend', () => {
  // NOW is Monday noon; friday 06:00 already passed by Fri … from a Friday-afternoon clock:
  const fridayAfternoon = Date.parse('2026-08-14T15:00:00Z')
  assert.equal(nextRunAt('weekdays 06:00', { now: fridayAfternoon }), '2026-08-17T06:00:00.000Z')
})

test('weekly waits for the named day', () => {
  assert.equal(nextRunAt('weekly mon 06:00', { now: NOW }), '2026-08-17T06:00:00.000Z')
  assert.equal(nextRunAt('weekly tue 06:00', { now: NOW }), '2026-08-11T06:00:00.000Z')
})

test('monthly rolls into next month once the date has passed', () => {
  assert.equal(nextRunAt('monthly 1 08:00', { now: NOW }), '2026-09-01T08:00:00.000Z')
  assert.equal(nextRunAt('monthly 15 08:00', { now: NOW }), '2026-08-15T08:00:00.000Z')
})

test('monthly 31 skips months that do not have a 31st', () => {
  const midSeptember = Date.parse('2026-09-10T12:00:00Z')
  assert.equal(nextRunAt('monthly 31 08:00', { now: midSeptember }), '2026-10-31T08:00:00.000Z')
})

test('every-N schedules anchor on the last run when there is one', () => {
  const lastRun = '2026-08-10T09:30:00Z'
  assert.equal(nextRunAt('every 2 hours', { now: NOW, lastRun }), '2026-08-10T13:30:00.000Z')
  assert.equal(nextRunAt('every 2 hours', { now: NOW }), '2026-08-10T14:00:00.000Z')
})

test('an unrecognised schedule yields null, never a guess', () => {
  assert.equal(nextRunAt('whenever', { now: NOW }), null)
  assert.equal(nextRunAt(null, { now: NOW }), null)
})

/* ---------- gone quiet ---------- */

test('a scheduled workflow that has missed two intervals has gone quiet', () => {
  // daily interval = 1440 min; quiet after 2 days.
  assert.equal(isGoneQuiet('daily 06:00', '2026-08-07T06:00:00Z', NOW), true)
  assert.equal(isGoneQuiet('daily 06:00', '2026-08-09T06:00:00Z', NOW), false)
})

test('a scheduled workflow with no run at all is quiet', () => {
  assert.equal(isGoneQuiet('weekly mon 06:00', null, NOW), true)
})

test('a weekly workflow gets two whole weeks before it counts as quiet', () => {
  // Counted in slots now, and a Monday job's slots are Mondays: a run on the last-but-one Monday
  // still counts for it, a run two Mondays ago does not.
  assert.equal(isGoneQuiet('weekly mon 06:00', '2026-08-03T06:00:00Z', NOW), false)
  assert.equal(isGoneQuiet('weekly mon 06:00', '2026-07-27T06:00:00Z', NOW), true)
  assert.equal(isGoneQuiet('weekly mon 06:00', '2026-07-20T06:00:00Z', NOW), true)
})

test('an unscheduled (button-only) workflow can never be quiet', () => {
  assert.equal(isGoneQuiet(null, null, NOW), false)
  assert.equal(isGoneQuiet(undefined, '2026-01-01T00:00:00Z', NOW), false)
})

test('interval minutes cover every named form', () => {
  assert.equal(scheduleMinutes('hourly'), 60)
  assert.equal(scheduleMinutes('daily 06:00'), 1440)
  assert.equal(scheduleMinutes('weekly mon 06:00'), 10080)
  assert.equal(scheduleMinutes('every 90 minutes'), 90)
  assert.equal(scheduleMinutes('every 3 hours'), 180)
  assert.equal(scheduleMinutes('nonsense'), null)
})

/* ---------- the slots a schedule expected, and how many of them were missed ----------------------
   "Gone quiet" used to be two whole intervals since the last run, and a weekday job's interval was a
   day: from Sunday morning until Monday's run, every weekday job read as gone quiet because Friday
   to Sunday is forty-eight hours. Counting the SLOTS the schedule expected fixes that, and is the
   same count the Readiness screen uses, so the two screens cannot disagree. */

const at = (iso) => Date.parse(iso)
const newestFirst = (list) => list.every((value, index) => index === 0 || at(value) < at(list[index - 1]))

test('the grace and the tolerance are the ones the rest of the board uses', () => {
  assert.equal(SLOT_GRACE_MINUTES, 30)
  assert.equal(SLOT_GRACE_MINUTES, RUNNING_GRACE_MINUTES)
  assert.equal(SLOT_TOLERANCE_MINUTES, 5)
})

test('previousRunsAt: hourly slots are on the hour, newest first', () => {
  const slots = (iso) => previousRunsAt('hourly', { now: at(iso), graceMinutes: 0 })
  assert.deepEqual(slots('2026-08-10T12:20:00Z'), ['2026-08-10T12:00:00.000Z', '2026-08-10T11:00:00.000Z'])
  assert.deepEqual(slots('2026-08-10T12:00:00Z'), ['2026-08-10T12:00:00.000Z', '2026-08-10T11:00:00.000Z'])
  assert.deepEqual(slots('2026-08-10T11:59:59Z'), ['2026-08-10T11:00:00.000Z', '2026-08-10T10:00:00.000Z'])
  assert.deepEqual(slots('2026-08-10T00:10:00Z'), ['2026-08-10T00:00:00.000Z', '2026-08-09T23:00:00.000Z'])
})

test('previousRunsAt: the grace moves the limit back, so a slot just passed is not yet expected', () => {
  const now = at('2026-08-10T12:20:00Z')
  assert.deepEqual(previousRunsAt('hourly', { now, graceMinutes: 30 }), ['2026-08-10T11:00:00.000Z', '2026-08-10T10:00:00.000Z'])
  assert.deepEqual(previousRunsAt('hourly', { now, graceMinutes: 20 }), ['2026-08-10T12:00:00.000Z', '2026-08-10T11:00:00.000Z'])
  // The grace defaults to the board's 30 minutes.
  assert.deepEqual(previousRunsAt('hourly', { now }), previousRunsAt('hourly', { now, graceMinutes: 30 }))
})

test('previousRunsAt: daily', () => {
  const slots = (iso) => previousRunsAt('daily 06:15', { now: at(iso), graceMinutes: 0 })
  assert.deepEqual(slots('2026-08-10T12:00:00Z'), ['2026-08-10T06:15:00.000Z', '2026-08-09T06:15:00.000Z'])
  assert.deepEqual(slots('2026-08-10T06:14:59Z'), ['2026-08-09T06:15:00.000Z', '2026-08-08T06:15:00.000Z'])
  assert.deepEqual(slots('2026-08-10T06:15:00Z'), ['2026-08-10T06:15:00.000Z', '2026-08-09T06:15:00.000Z'])
  assert.deepEqual(previousRunsAt('daily 23:59', { now: at('2026-01-01T00:00:00Z'), graceMinutes: 0 }), ['2025-12-31T23:59:00.000Z', '2025-12-30T23:59:00.000Z'])
})

test('previousRunsAt: weekdays skip Saturday and Sunday, so Monday morning looks back to Friday', () => {
  const slots = (iso) => previousRunsAt('weekdays 07:00', { now: at(iso), graceMinutes: 0 })
  assert.deepEqual(slots('2026-08-10T06:59:00Z'), ['2026-08-07T07:00:00.000Z', '2026-08-06T07:00:00.000Z'])
  assert.deepEqual(slots('2026-08-10T07:00:00Z'), ['2026-08-10T07:00:00.000Z', '2026-08-07T07:00:00.000Z'])
  assert.deepEqual(slots('2026-08-08T12:00:00Z'), ['2026-08-07T07:00:00.000Z', '2026-08-06T07:00:00.000Z'])
  assert.deepEqual(slots('2026-08-09T12:00:00Z'), ['2026-08-07T07:00:00.000Z', '2026-08-06T07:00:00.000Z'])
  assert.deepEqual(slots('2026-08-11T08:00:00Z'), ['2026-08-11T07:00:00.000Z', '2026-08-10T07:00:00.000Z'])
})

test('previousRunsAt: weekly is the named day', () => {
  const slots = (iso) => previousRunsAt('weekly mon 06:00', { now: at(iso), graceMinutes: 0 })
  assert.deepEqual(slots('2026-08-12T12:00:00Z'), ['2026-08-10T06:00:00.000Z', '2026-08-03T06:00:00.000Z'])
  assert.deepEqual(slots('2026-08-10T05:00:00Z'), ['2026-08-03T06:00:00.000Z', '2026-07-27T06:00:00.000Z'])
  assert.deepEqual(slots('2026-08-10T06:00:00Z'), ['2026-08-10T06:00:00.000Z', '2026-08-03T06:00:00.000Z'])
  assert.deepEqual(previousRunsAt('weekly sun 23:30', { now: at('2026-08-10T12:00:00Z'), graceMinutes: 0 }), ['2026-08-09T23:30:00.000Z', '2026-08-02T23:30:00.000Z'])
})

test('previousRunsAt: monthly skips months that do not have the day, across a year end and a leap day', () => {
  const slots = (schedule, iso) => previousRunsAt(schedule, { now: at(iso), graceMinutes: 0 })
  assert.deepEqual(slots('monthly 31 08:00', '2026-10-09T12:00:00Z'), ['2026-08-31T08:00:00.000Z', '2026-07-31T08:00:00.000Z'])
  assert.deepEqual(slots('monthly 31 08:00', '2026-03-05T12:00:00Z'), ['2026-01-31T08:00:00.000Z', '2025-12-31T08:00:00.000Z'])
  assert.deepEqual(slots('monthly 1 08:00', '2026-08-10T12:00:00Z'), ['2026-08-01T08:00:00.000Z', '2026-07-01T08:00:00.000Z'])
  assert.deepEqual(slots('monthly 1 08:00', '2026-08-01T07:59:00Z'), ['2026-07-01T08:00:00.000Z', '2026-06-01T08:00:00.000Z'])
  assert.deepEqual(slots('monthly 29 08:00', '2028-03-10T12:00:00Z'), ['2028-02-29T08:00:00.000Z', '2028-01-29T08:00:00.000Z'])
  assert.deepEqual(slots('monthly 29 08:00', '2027-03-10T12:00:00Z'), ['2027-01-29T08:00:00.000Z', '2026-12-29T08:00:00.000Z'])
})

test('previousRunsAt: every N has no known phase, so its slots are N and 2N before the limit', () => {
  const now = at('2026-08-10T12:00:00Z')
  assert.deepEqual(previousRunsAt('every 2 hours', { now, graceMinutes: 30 }), ['2026-08-10T09:30:00.000Z', '2026-08-10T07:30:00.000Z'])
  assert.deepEqual(previousRunsAt('every 15 minutes', { now, graceMinutes: 0 }), ['2026-08-10T11:45:00.000Z', '2026-08-10T11:30:00.000Z'])
  assert.deepEqual(previousRunsAt('every 90 minutes', { now, graceMinutes: 0 }), ['2026-08-10T10:30:00.000Z', '2026-08-10T09:00:00.000Z'])
})

test('previousRunsAt: count asks for more or fewer, always in order, always at or before the limit', () => {
  const now = at('2026-08-10T12:00:00Z')
  for (const schedule of ['hourly', 'daily 06:00', 'weekdays 07:00', 'weekly mon 06:00', 'monthly 31 08:00', 'every 3 hours']) {
    for (const count of [1, 2, 3, 5]) {
      const list = previousRunsAt(schedule, { now, count })
      assert.equal(list.length, count, `${schedule} x${count}`)
      assert.ok(newestFirst(list), `${schedule} is newest first`)
      assert.ok(at(list[0]) <= now - SLOT_GRACE_MINUTES * 60_000, `${schedule} is at or before the limit`)
    }
  }
})

test('previousRunsAt: a schedule it cannot read, or a clock time that does not exist, has no slots', () => {
  const now = at('2026-08-10T12:00:00Z')
  for (const schedule of ['whenever', '', null, undefined, 7, {}, 'daily 25:00', 'daily 06:60', 'weekdays 24:00', 'monthly 0 08:00', 'monthly 32 08:00', 'every 0 minutes', 'weekly xxx 06:00']) {
    assert.deepEqual(previousRunsAt(schedule, { now }), [], String(schedule))
  }
  assert.deepEqual(previousRunsAt('daily 06:00', { now: NaN }), [])
})

test('lateness: counts how many of the last two slots the last run missed', () => {
  const state = (schedule, last, iso) => lateness(schedule, last, { now: at(iso) })?.missed
  // daily 06:00, checked at noon: the slots in question are today's and yesterday's.
  assert.equal(state('daily 06:00', '2026-08-10T06:00:20Z', '2026-08-10T12:00:00Z'), 0)
  assert.equal(state('daily 06:00', '2026-08-09T06:00:20Z', '2026-08-10T12:00:00Z'), 1)
  assert.equal(state('daily 06:00', '2026-08-08T06:00:20Z', '2026-08-10T12:00:00Z'), 2)
  // Not yet expected: today's 06:00 slot is inside the 30 minutes of grace at 06:20.
  assert.equal(state('daily 06:00', '2026-08-09T06:00:20Z', '2026-08-10T06:20:00Z'), 0)
  assert.equal(state('daily 06:00', '2026-08-09T06:00:20Z', '2026-08-10T06:31:00Z'), 1)
  // hourly
  assert.equal(state('hourly', '2026-08-10T11:00:05Z', '2026-08-10T12:00:00Z'), 0)
  assert.equal(state('hourly', '2026-08-10T11:00:05Z', '2026-08-10T12:40:00Z'), 1)
  assert.equal(state('hourly', '2026-08-10T10:00:05Z', '2026-08-10T12:40:00Z'), 2)
  // weekly
  assert.equal(state('weekly mon 06:00', '2026-08-10T06:00:10Z', '2026-08-10T12:00:00Z'), 0)
  assert.equal(state('weekly mon 06:00', '2026-08-03T06:00:10Z', '2026-08-10T12:00:00Z'), 1)
  assert.equal(state('weekly mon 06:00', '2026-07-27T06:00:10Z', '2026-08-10T12:00:00Z'), 2)
  // every N: N + grace + tolerance behind the check is on time; 2N + grace + tolerance is the edge of silent
  assert.equal(state('every 2 hours', '2026-08-10T09:25:00Z', '2026-08-10T12:00:00Z'), 0)
  assert.equal(state('every 2 hours', '2026-08-10T09:24:59Z', '2026-08-10T12:00:00Z'), 1)
  assert.equal(state('every 2 hours', '2026-08-10T07:25:00Z', '2026-08-10T12:00:00Z'), 1)
  assert.equal(state('every 2 hours', '2026-08-10T07:24:59Z', '2026-08-10T12:00:00Z'), 2)
})

test('lateness: a monthly job on the 31st has two slots to miss, however far apart they are', () => {
  const state = (last, iso) => lateness('monthly 31 08:00', last, { now: at(iso) })?.missed
  assert.equal(state('2026-08-31T08:00:30Z', '2026-10-09T12:00:00Z'), 0)
  assert.equal(state('2026-07-31T08:00:30Z', '2026-10-09T12:00:00Z'), 1)
  assert.equal(state('2026-06-30T08:00:30Z', '2026-10-09T12:00:00Z'), 2)
  assert.equal(state(null, '2026-10-09T12:00:00Z'), 2)
})

test('lateness: a run up to five minutes before a slot counts for it, a minute more does not', () => {
  const now = at('2026-08-10T12:00:00Z')
  assert.equal(lateness('daily 06:00', '2026-08-10T05:55:00Z', { now }).missed, 0)
  assert.equal(lateness('daily 06:00', '2026-08-10T05:54:59Z', { now }).missed, 1)
})

test('lateness: no run at all, or a time nobody can read, has missed both', () => {
  const now = at('2026-08-10T12:00:00Z')
  for (const last of [null, undefined, '', 'yesterday', 7, {}]) assert.equal(lateness('daily 06:00', last, { now }).missed, 2, String(last))
})

test('lateness: says which slots it counted, newest first, so a sentence can name them', () => {
  const result = lateness('daily 06:00', '2026-08-09T06:00:20Z', { now: at('2026-08-10T12:00:00Z') })
  assert.deepEqual(result, { expected: ['2026-08-10T06:00:00.000Z', '2026-08-09T06:00:00.000Z'], missed: 1 })
})

test('lateness: a button-only workflow, or a schedule nobody can read, is not judged', () => {
  const now = at('2026-08-10T12:00:00Z')
  for (const schedule of [null, undefined, '', 'whenever', 'daily 25:00']) assert.equal(lateness(schedule, '2026-08-01T00:00:00Z', { now }), null, String(schedule))
})

test('weekday jobs are not silent on the weekend or on Monday morning (they were: 48 hours is two intervals)', () => {
  const lastRun = '2026-08-07T07:00:20Z' // Friday, on time
  for (const [when, expected] of [
    ['2026-08-07T12:00:00Z', false], // Friday afternoon
    ['2026-08-08T12:00:00Z', false], // Saturday
    ['2026-08-09T07:01:00Z', false], // Sunday, 48 hours and a minute after the run
    ['2026-08-09T23:59:00Z', false], // Sunday night
    ['2026-08-10T06:59:00Z', false], // Monday, a minute before the slot
    ['2026-08-10T07:00:00Z', false], // Monday at the slot
    ['2026-08-10T07:29:00Z', false], // Monday, still inside the grace
    ['2026-08-10T07:31:00Z', false], // Monday, one slot missed (Friday still counts)
    ['2026-08-11T06:59:00Z', false], // Tuesday, a minute before the slot
    ['2026-08-11T07:31:00Z', true], // Tuesday, two slots missed
    ['2026-08-12T12:00:00Z', true]
  ]) {
    assert.equal(isGoneQuiet('weekdays 07:00', lastRun, at(when)), expected, when)
  }
})

test('isGoneQuiet agrees with lateness: quiet is exactly "missed both slots"', () => {
  const lasts = [null, '2026-08-10T06:00:10Z', '2026-08-09T06:00:10Z', '2026-08-07T06:00:10Z', '2026-07-01T00:00:00Z', 'nonsense']
  const clocks = ['2026-08-10T05:00:00Z', '2026-08-10T06:10:00Z', '2026-08-10T12:00:00Z', '2026-08-11T06:45:00Z', '2026-08-15T00:00:00Z']
  for (const schedule of ['hourly', 'daily 06:00', 'weekdays 06:00', 'weekly mon 06:00', 'monthly 15 06:00', 'every 3 hours']) {
    for (const last of lasts) {
      for (const clock of clocks) {
        assert.equal(isGoneQuiet(schedule, last, at(clock)), lateness(schedule, last, { now: at(clock) }).missed === 2, `${schedule} / ${last} / ${clock}`)
      }
    }
  }
})

test('isGoneQuiet: nothing to judge is not quiet', () => {
  assert.equal(isGoneQuiet('daily 25:00', null, NOW), false)
  assert.equal(isGoneQuiet('whenever', null, NOW), false)
})
