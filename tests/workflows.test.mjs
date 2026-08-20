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
  isGoneQuiet
} from '../api/workflows.js'

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
  assert.equal(isGoneQuiet('weekly mon 06:00', '2026-07-29T06:00:00Z', NOW), false)
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
