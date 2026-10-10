// Workflow parsing, validation, and scheduling — the dashboard's copy of the contract.
//
// Validation is ported from agent-team-template/scripts/lib/workflows.mjs so a workflow
// that passes the template's own checks renders here, and one that fails there is flagged
// here with the same words. Keep the two in lockstep.
//
// nextRunAt and isGoneQuiet are cockpit-side additions: the template validates files, the
// dashboard also has to answer "when does this run next" and "has this gone quiet".

import { parseSimpleYaml } from './yaml-lite.js'

// Routines will not fire more often than once an hour. GitHub Actions will. Anything below
// the floor has to be routed to the runner that can honour it, so the floor lives here
// rather than being remembered.
export const MIN_INTERVAL_MINUTES = { routine: 60, 'github-actions': 5 }
export const RUNNERS = Object.keys(MIN_INTERVAL_MINUTES)

// Schedules are written the way a person says them out loud, because a student never writes
// this file by hand and should never have to read cron.
const SCHEDULE_FORMS = [
  { pattern: /^hourly$/, minutes: 60 },
  { pattern: /^daily \d{2}:\d{2}$/, minutes: 1440 },
  { pattern: /^weekdays \d{2}:\d{2}$/, minutes: 1440 },
  { pattern: /^weekly (sun|mon|tue|wed|thu|fri|sat) \d{2}:\d{2}$/, minutes: 10080 },
  { pattern: /^monthly \d{1,2} \d{2}:\d{2}$/, minutes: 43200 },
  { pattern: /^every \d+ (minutes|hours)$/, minutes: null }
]

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

export const parseWorkflow = parseSimpleYaml

// Steps may be written `- pull-calendar` or `- skill: pull-calendar` — both appear in the
// spec and the template README. Normalise to plain strings before validating or rendering.
export function normaliseSteps(steps) {
  if (!Array.isArray(steps)) return steps
  return steps.map((step) =>
    step && typeof step === 'object' && typeof step.skill === 'string' ? step.skill : step
  )
}

export function scheduleMinutes(schedule) {
  if (typeof schedule !== 'string') return null
  const trimmed = schedule.trim()
  const every = /^every (\d+) (minutes|hours)$/.exec(trimmed)
  if (every) return Number(every[1]) * (every[2] === 'hours' ? 60 : 1)
  const form = SCHEDULE_FORMS.find((candidate) => candidate.pattern.test(trimmed))
  return form ? form.minutes : null
}

export function isValidSchedule(schedule) {
  if (typeof schedule !== 'string') return false
  return SCHEDULE_FORMS.some((form) => form.pattern.test(schedule.trim()))
}

// Returns a list of human-readable problems. Empty means the workflow is sound.
// `known` lets a caller check step and owner names against what the repo actually contains;
// omit it to validate shape only.
export function validateWorkflow(workflow, known = {}) {
  const problems = []
  const { skills, agents } = known

  if (typeof workflow?.name !== 'string' || !workflow.name.trim()) {
    problems.push('name is required and must be a non-empty string')
  }

  if (typeof workflow?.owner !== 'string' || !workflow.owner.trim()) {
    problems.push('owner is required and must name one agent')
  } else if (agents && !agents.includes(workflow.owner)) {
    problems.push(`owner "${workflow.owner}" is not an agent in this repo`)
  }

  const steps = normaliseSteps(workflow?.steps)
  if (!Array.isArray(steps) || steps.length === 0) {
    problems.push('steps is required and must list at least one skill')
  } else {
    steps.forEach((step, index) => {
      if (typeof step !== 'string' || !step.trim()) {
        problems.push(`step ${index + 1} must be a non-empty skill name`)
        return
      }
      if (skills && !skills.includes(step)) {
        problems.push(`step "${step}" is not a skill in this repo`)
      }
    })
    const duplicates = steps.filter((step, index) => steps.indexOf(step) !== index)
    for (const duplicate of new Set(duplicates)) {
      problems.push(`step "${duplicate}" appears more than once`)
    }
  }

  const runner = workflow?.runner ?? 'routine'
  if (!RUNNERS.includes(runner)) {
    problems.push(`runner "${runner}" is not one of: ${RUNNERS.join(', ')}`)
  }

  const trigger = workflow?.trigger
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) {
    problems.push('trigger is required')
  } else {
    if (trigger.schedule === undefined && trigger.fire !== true && trigger.webhook !== true) {
      problems.push('trigger needs at least one of: schedule, fire, webhook')
    }
    if (trigger.schedule !== undefined) {
      if (!isValidSchedule(trigger.schedule)) {
        problems.push(`schedule "${trigger.schedule}" is not a recognised form`)
      } else {
        const minutes = scheduleMinutes(String(trigger.schedule).trim())
        const floor = MIN_INTERVAL_MINUTES[runner] ?? MIN_INTERVAL_MINUTES.routine
        if (minutes !== null && minutes < floor) {
          problems.push(
            `schedule "${trigger.schedule}" runs every ${minutes} minutes, below the ` +
              `${floor}-minute floor for runner "${runner}"`
          )
        }
      }
    }
    if (trigger.fire !== undefined && typeof trigger.fire !== 'boolean') {
      problems.push('trigger.fire must be true or false')
    }
  }

  const output = workflow?.output
  if (typeof output !== 'string' || !output.trim()) {
    problems.push('output is required and must be a path inside the repo')
  } else if (output.startsWith('/') || output.split('/').includes('..')) {
    problems.push(`output "${output}" must stay inside the repo`)
  }

  return problems
}

// When does this schedule fire next? All arithmetic in UTC, which is what routines run in.
// `lastRun` only matters for `every N …` schedules, which have no fixed anchor of their own.
// Returns an ISO string, or null for anything unrecognised.
export function nextRunAt(schedule, { now = Date.now(), lastRun = null } = {}) {
  if (typeof schedule !== 'string') return null
  const trimmed = schedule.trim()
  let match

  if ((match = /^every (\d+) (minutes|hours)$/.exec(trimmed))) {
    const stepMs = Number(match[1]) * (match[2] === 'hours' ? 3600000 : 60000)
    const anchor = lastRun ? Date.parse(lastRun) : NaN
    if (!Number.isNaN(anchor) && anchor <= now) {
      const intervals = Math.floor((now - anchor) / stepMs) + 1
      return new Date(anchor + intervals * stepMs).toISOString()
    }
    return new Date(now + stepMs).toISOString()
  }

  if (trimmed === 'hourly') {
    const next = new Date(now)
    next.setUTCMinutes(0, 0, 0)
    next.setTime(next.getTime() + 3600000)
    return next.toISOString()
  }

  const todayAt = (hours, minutes) => {
    const candidate = new Date(now)
    candidate.setUTCHours(hours, minutes, 0, 0)
    return candidate
  }

  if ((match = /^daily (\d{2}):(\d{2})$/.exec(trimmed))) {
    const candidate = todayAt(Number(match[1]), Number(match[2]))
    if (candidate.getTime() <= now) candidate.setUTCDate(candidate.getUTCDate() + 1)
    return candidate.toISOString()
  }

  if ((match = /^weekdays (\d{2}):(\d{2})$/.exec(trimmed))) {
    const candidate = todayAt(Number(match[1]), Number(match[2]))
    while (candidate.getTime() <= now || candidate.getUTCDay() === 0 || candidate.getUTCDay() === 6) {
      candidate.setUTCDate(candidate.getUTCDate() + 1)
    }
    return candidate.toISOString()
  }

  if ((match = /^weekly (sun|mon|tue|wed|thu|fri|sat) (\d{2}):(\d{2})$/.exec(trimmed))) {
    const target = DAYS.indexOf(match[1])
    const candidate = todayAt(Number(match[2]), Number(match[3]))
    while (candidate.getUTCDay() !== target || candidate.getTime() <= now) {
      candidate.setUTCDate(candidate.getUTCDate() + 1)
    }
    return candidate.toISOString()
  }

  if ((match = /^monthly (\d{1,2}) (\d{2}):(\d{2})$/.exec(trimmed))) {
    const day = Number(match[1])
    const base = new Date(now)
    // Walk forward month by month until the date exists (no 31st of February) and is ahead.
    for (let offset = 0; offset < 25; offset += 1) {
      const candidate = new Date(
        Date.UTC(
          base.getUTCFullYear(),
          base.getUTCMonth() + offset,
          day,
          Number(match[2]),
          Number(match[3])
        )
      )
      if (candidate.getUTCDate() === day && candidate.getTime() > now) return candidate.toISOString()
    }
    return null
  }

  return null
}

// How late a run may be, and how far a run may come before its slot, and still count for it. The
// grace is the board's running grace (RUNNING_GRACE_MINUTES in state.js; a test holds the two
// together): a slot that came due a minute ago has not been missed yet.
export const SLOT_GRACE_MINUTES = 30
export const SLOT_TOLERANCE_MINUTES = 5

const MINUTE_MS = 60_000
const clockTime = (hours, minutes) => {
  const hour = Number(hours)
  const minute = Number(minutes)
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : null
}

// The `count` most recent times this schedule was expected to run, at or before `now` minus the
// grace, newest first, all in UTC like nextRunAt. [] for a schedule it cannot read or a clock time
// that does not exist (daily 25:00), and for a clock that is not a number.
//
// An `every N` schedule has no fixed phase - nothing in the file says when it started - so its
// slots are N, 2N, ... before the limit. That is the same rule the Mac collector uses for a launchd
// job with an interval, so the two kinds of job are judged the same way.
export function previousRunsAt(schedule, { now = Date.now(), count = 2, graceMinutes = SLOT_GRACE_MINUTES } = {}) {
  if (typeof schedule !== 'string' || !Number.isFinite(now)) return []
  const limit = now - graceMinutes * MINUTE_MS
  const trimmed = schedule.trim()
  const found = []
  const done = () => found.length >= count
  let match

  if ((match = /^every (\d+) (minutes|hours)$/.exec(trimmed))) {
    const stepMs = Number(match[1]) * (match[2] === 'hours' ? 60 : 1) * MINUTE_MS
    if (!(stepMs > 0)) return []
    for (let back = 1; !done(); back += 1) found.push(limit - back * stepMs)
  } else if (trimmed === 'hourly') {
    const hour = 60 * MINUTE_MS
    for (let at = Math.floor(limit / hour) * hour; !done(); at -= hour) found.push(at)
  } else if ((match = /^monthly (\d{1,2}) (\d{2}):(\d{2})$/.exec(trimmed))) {
    const day = Number(match[1])
    const minutes = clockTime(match[2], match[3])
    if (day < 1 || day > 31 || minutes === null) return []
    const base = new Date(limit)
    // Walk back month by month; a month without that date (no 31st of September) is skipped.
    for (let back = 0; back < 120 && !done(); back += 1) {
      const candidate = Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - back, day, Math.floor(minutes / 60), minutes % 60)
      if (new Date(candidate).getUTCDate() === day && candidate <= limit) found.push(candidate)
    }
  } else {
    // The three day-based forms: a clock time on every day, on Monday to Friday, or on one weekday.
    let minutes = null
    let onDay = () => true
    if ((match = /^daily (\d{2}):(\d{2})$/.exec(trimmed))) minutes = clockTime(match[1], match[2])
    else if ((match = /^weekdays (\d{2}):(\d{2})$/.exec(trimmed))) {
      minutes = clockTime(match[1], match[2])
      onDay = (weekday) => weekday !== 0 && weekday !== 6
    } else if ((match = /^weekly (sun|mon|tue|wed|thu|fri|sat) (\d{2}):(\d{2})$/.exec(trimmed))) {
      minutes = clockTime(match[2], match[3])
      onDay = (weekday) => weekday === DAYS.indexOf(match[1])
    }
    if (minutes === null) return []
    const dayMs = 24 * 60 * MINUTE_MS
    const midnight = Math.floor(limit / dayMs) * dayMs
    for (let back = 0; back < 400 && !done(); back += 1) {
      const day = midnight - back * dayMs
      const candidate = day + minutes * MINUTE_MS
      if (candidate <= limit && onDay(new Date(day).getUTCDay())) found.push(candidate)
    }
  }
  return found.map((ms) => new Date(ms).toISOString())
}

// Of the last two slots this schedule expected, how many did the last run miss? A run counts for a
// slot when it came no more than the tolerance before it, or at any time after. `missed` is 0 (on
// time), 1 (late - the older slot is covered, the newer is not) or 2 (silent: both missed, or never
// ran). null when there is no schedule to judge, which is a button-only workflow.
export function lateness(schedule, lastRunIso, { now = Date.now(), graceMinutes = SLOT_GRACE_MINUTES } = {}) {
  const expected = previousRunsAt(schedule, { now, count: 2, graceMinutes })
  if (expected.length < 2) return null
  const last = typeof lastRunIso === 'string' ? Date.parse(lastRunIso) : NaN
  const counts = (slot) => Number.isFinite(last) && last >= Date.parse(slot) - SLOT_TOLERANCE_MINUTES * MINUTE_MS
  return { expected, missed: counts(expected[0]) ? 0 : counts(expected[1]) ? 1 : 2 }
}

// A scheduled workflow that has missed two slots is not "running a little late", it has gone
// quiet - and an agent that silently stopped is worse than no agent.
//
// Counted in SLOTS, not in minutes since the last run. It used to be two whole intervals, and a
// weekday job's interval was a day: from Sunday morning until Monday's run, every weekday job read
// as gone quiet, because Friday to Sunday is forty-eight hours. The Readiness screen counts the
// same slots, so the two screens agree.
export function isGoneQuiet(schedule, lastRunIso, now = Date.now()) {
  return lateness(schedule, lastRunIso, { now })?.missed === 2
}
