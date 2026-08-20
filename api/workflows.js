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

// A scheduled workflow that has missed two whole intervals is not "running a little late",
// it has gone quiet — and an agent that silently stopped is worse than no agent.
export function isGoneQuiet(schedule, lastRunIso, now = Date.now()) {
  const interval = scheduleMinutes(schedule)
  if (interval === null || interval === undefined) return false
  if (!lastRunIso) return true
  const last = Date.parse(lastRunIso)
  if (Number.isNaN(last)) return true
  return (now - last) / 60000 > interval * 2
}
