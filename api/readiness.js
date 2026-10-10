// The Readiness wall: every scheduled job, one light each, NO GO first.
//
// This takes what the board has already read and checked - the workflows and routines from the team
// repo, the Mac's LaunchAgents and Hermes's cron jobs from the status collector, Hermes itself - and
// decides ONE light per job. It reads no file and makes no call. It imports nothing from state.js,
// which imports it.
//
// The rules, first match wins, are written out in the plan (2026-10-09-cockpit-v2-readiness-wall.md,
// section 2) and tested row by row in tests/readiness.test.mjs:
//   NO GO  something is wrong that will not fix itself: nothing fires it, it is not switched on, it was
//          not running, or its last run failed and is recent enough to be the one that matters.
//   SILENT the board cannot vouch for it: it has not reported, it missed its last two slots, or the
//          Mac's reading is too old to say anything.
//   GO     it reported clean on its own schedule, or it is a service and it was running.
// A job whose last report is older than its newest slot but not its second newest is FADED: the same
// light with one more sentence, never a change of colour alone.
//
// Every sentence is built here, deterministically, with no model call, as { text, at }. The page
// replaces {time}, {date} and {hours} from `at` in the reader's own clock. A name that came from a
// repo is cleaned of braces before it is put in a sentence, so it can never be read as one of those.
//
// Green means a verified clean report or a running service, and says which. A process that is up
// proves the process, not today's output; the sentence for it says exactly that (decision D1).
import { lateness, nextRunAt, SLOT_GRACE_MINUTES, SLOT_TOLERANCE_MINUTES } from './workflows.js'

// The Mac's reading goes stale after this long. A test holds it to the jobs contract's own number.
export const READINESS_STALE_HOURS = 8
// The status collector runs every three hours on the Mac; its own card is judged by that.
export const COLLECTOR_EVERY_MINUTES = 180
export const READINESS_NAME_MAX = 80
export const READINESS_SUMMARY_MAX = 160

// The Mac programs that keep their own clock (decision D1): launchd starts each at login and its own
// scheduler decides when to work, so launchd can only prove the program is up, not that today's report
// was written - and the control center, not this board, checks that. By label, from the deploy scripts
// in donna/control-center/data (deploy-managed-*-mac.py set `local.donna.<name>`); the software watch
// is `local.donna.software-skills-watch` in GOAL-PROGRESS.md, which has no deploy script of its own
// in that folder. Any other always-on service is only "was running".
export const MANAGED_OWNER_LABELS = [
  'local.donna.security-changelog',
  'local.donna.model-watch-weekly',
  'local.donna.substack-weekly-briefing',
  'local.donna.team-maintenance-weekly',
  'local.donna.facebook-ads-daily-digest',
  'local.donna.facebook-ads-weekly-report',
  'local.donna.facebook-ads-monitor-account-rules',
  'local.donna.software-skills-watch'
]

export const READINESS_LIGHTS = {
  'no-go': { word: 'NO GO', rank: 0 },
  silent: { word: 'SILENT', rank: 1 },
  go: { word: 'GO', rank: 2 }
}

export const READINESS_WORDS = {
  pill: 'RUNNING',
  faded: 'Its last report is older than its own schedule.',
  unknownSchedule: 'The schedule could not be read, so lateness is not judged.',
  noRecentSlot: 'Nothing has been due to run lately, so lateness is not judged.',
  listUnavailable: "The Mac's list of {what} was not available at {time}: {why}.",
  listUnavailableNoWhy: "The Mac's list of {what} was not available at {time}, and the Mac did not say why.",
  launchdEndedUnknown: '{name} has not said how its last run ended. Its log was last written at {time}.',
  managedOwner: 'Its scheduler is running. Whether its last report was written is checked on the Mac control center, not here.',
  neverReported: 'Has never reported.',
  notReportedSince: 'Has not reported since {date}.',
  lastRunFailed: 'Its last run failed.',
  notChecked: "Not checked since {date}. The Mac's last reading is {hours} h old.",
  declared: '{name} is marked on, but no routine exists, so nothing fires it.',
  unapproved: '{name} is switched off in its file, but a routine is still firing it. It is spending runs nobody approved.',
  routinesUnknown: '{name} is marked on, but the board has no fresh list of routines, so it cannot say whether anything fires it.',
  orphan: '{name} is a routine on your account with no workflow file, so the board has nothing to check it against.',
  notLoaded: "{name} is installed but not switched on in the Mac's scheduler, so it will not run.",
  notRunning: '{name} was not running when the Mac checked at {time}.',
  running: '{name} was running when the Mac checked at {time}.',
  ranClean: '{name} ran clean at {time}.',
  partial: '{name} finished part of the job at {time}.',
  stillGoing: '{name} started a run at {time} and it has not finished yet.',
  endedUnknown: "{name}'s last run, at {time}, never said how it ended.",
  failedFinish: '{name} did not finish at {time}. {summary}',
  noSummary: 'The run did not say why.',
  failedExit: '{name} stopped with error code {code}. The Mac does not say why; its log on the Mac has the reason.',
  hermesFailed: '{name} did not finish at {time}. Hermes keeps the reason; open Hermes to read it.',
  hermesEndedUnknown: "Hermes did not say how {name}'s last run, at {time}, ended.",
  hermesRunning: 'Hermes was running when the Mac checked at {time}.',
  hermesDown: 'Hermes was not running when the Mac checked at {time}.',
  collectorRan: 'The status collector last wrote its readings at {time}.',
  collectorSilent: 'The status collector has not written its readings since {date}, so nothing on the Mac is being checked.',
  never: 'Never'
}

export const SWITCHED_OFF = {
  hidden: 'Switched off: hidden in jobs.yml.',
  owner: 'Switched off: its owner agent is switched off, so it cannot run as written.',
  trigger: 'Switched off: it only runs when a button or a webhook starts it.',
  notArmed: 'Switched off: it is not armed.',
  armedPrefix: 'Switched off: ',
  disabled: "Switched off: turned off on the Mac (its plist says Disabled), so the Mac's scheduler is told not to run it.",
  hermesOff: 'Switched off: turned off in Hermes.'
}

// ---------------------------------------------------------------------------------------------
// words

const clean = (value, max) => {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim() : ''
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}
// The name goes in a sentence, and the page fills {time}, {date} and {hours} in sentences: a name
// holding braces must not be able to look like one.
const inSentence = (name) => name.replace(/[{}]/g, '')
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (whole, key) => (Object.hasOwn(values, key) ? String(values[key]) : whole))

const clock = (hour, minute) => {
  const twelve = hour % 12 === 0 ? 12 : hour % 12
  return `${twelve}:${String(minute).padStart(2, '0')}${hour < 12 ? 'am' : 'pm'}`
}
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'}`
const WEEKDAY_PLURAL = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']
const MAC_TIME = ' (Mac time)'

function everyWords(minutes) {
  if (minutes === 1) return 'Every minute'
  if (minutes < 60) return `Every ${minutes} minutes`
  if (minutes === 60) return 'Every hour'
  if (minutes % 60 === 0) return `Every ${minutes / 60} hours`
  return `Every ${minutes} minutes`
}

// What a schedule is, in the words a person says it. `zone` is what to append to a clock time: the
// Mac's slots are on the Mac's clock, a workflow's are UTC.
export function slotsWords(slots, zone = MAC_TIME) {
  const first = slots[0]
  const same = (key) => slots.every((slot) => slot[key] === first[key])
  if (slots.length === 1 || (same('minute') && same('weekday') && same('day') && same('hour'))) {
    if (first.hour === null) return `Every hour at :${String(first.minute).padStart(2, '0')}`
    const at = `${clock(first.hour, first.minute)}${zone}`
    if (first.day !== null) return `Monthly on the ${ordinal(first.day)} at ${at}`
    if (first.weekday !== null) return `${WEEKDAY_PLURAL[first.weekday]} at ${at}`
    return `Every day at ${at}`
  }
  const noDates = slots.every((slot) => slot.weekday === null && slot.day === null && slot.hour !== null)
  if (noDates && same('minute')) {
    const hours = slots.map((slot) => slot.hour).sort((a, b) => a - b)
    const step = 24 / hours.length
    const evenlySpread = Number.isInteger(step) && hours.every((hour, index) => hour === hours[0] + index * step) && hours[0] < step
    if (evenlySpread) return first.minute === 0 ? `Every ${step} hours` : `Every ${step} hours, at :${String(first.minute).padStart(2, '0')}`
    const times = hours.map((hour) => clock(hour, first.minute))
    return `Every day at ${times.slice(0, -1).join(', ')} and ${times.at(-1)}${zone}`
  }
  // Monday to Friday at one time is the one repeating pattern worth a word of its own.
  const weekdaySet = slots.map((slot) => slot.weekday).sort((a, b) => a - b).join(',')
  if (slots.every((slot) => slot.weekday !== null && slot.day === null && slot.hour !== null) && same('minute') && same('hour') && weekdaySet === '1,2,3,4,5') {
    return `Weekdays at ${clock(first.hour, first.minute)}${zone}`
  }
  return `A custom schedule (${slots.length} times)`
}

export function cadenceWords(cadence) {
  if (cadence?.kind === 'always') return 'Always on'
  if (cadence?.kind === 'every') return everyWords(cadence.minutes)
  if (cadence?.kind === 'slots') return slotsWords(cadence.slots)
  return 'Not known'
}

// A workflow's own schedule strings, in the same words. Routines run in UTC.
export function workflowScheduleWords(schedule) {
  if (typeof schedule !== 'string' || !schedule.trim()) return 'No schedule'
  const text = schedule.trim()
  let match
  if (text === 'hourly') return 'Every hour'
  if ((match = /^every (\d+) (minutes|hours)$/.exec(text))) return everyWords(Number(match[1]) * (match[2] === 'hours' ? 60 : 1))
  if ((match = /^daily (\d{2}):(\d{2})$/.exec(text))) return `Every day at ${clock(Number(match[1]), Number(match[2]))} UTC`
  if ((match = /^weekdays (\d{2}):(\d{2})$/.exec(text))) return `Weekdays at ${clock(Number(match[1]), Number(match[2]))} UTC`
  if ((match = /^weekly (sun|mon|tue|wed|thu|fri|sat) (\d{2}):(\d{2})$/.exec(text))) {
    const day = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(match[1])
    return `${WEEKDAY_PLURAL[day]} at ${clock(Number(match[2]), Number(match[3]))} UTC`
  }
  if ((match = /^monthly (\d{1,2}) (\d{2}):(\d{2})$/.exec(text))) return `Monthly on the ${ordinal(Number(match[1]))} at ${clock(Number(match[2]), Number(match[3]))} UTC`
  return 'Not known'
}

// local.donna.story-belt-daily -> "Story belt daily". The first two dot parts are who made it, not
// what it does. Only a reading aid: jobs.yml can name any job properly.
export function readableLabel(label) {
  const parts = String(label).split('.')
  const rest = parts.length >= 3 ? parts.slice(2).join('.') : parts.length === 2 ? parts[1] : parts[0]
  const words = rest.replace(/[-_.]+/g, ' ').trim()
  return words ? words[0].toUpperCase() + words.slice(1) : String(label)
}

// The first sentence of a run summary, kept short. Repo text: shown with textContent, never markup.
function firstSentence(summary) {
  const text = clean(summary, 400)
  if (!text) return ''
  const end = /[.!?](?:\s|$)/.exec(text)
  return clean(end ? text.slice(0, end.index + 1) : text, READINESS_SUMMARY_MAX)
}

const sentence = (text, at = null) => ({ text, at })
const minutes = (count) => count * 60_000
const isoOf = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z')

// ---------------------------------------------------------------------------------------------
// jobs.yml: names and hiding

const routineKey = (value) => (typeof value === 'string' ? value.trim().normalize('NFC').toLowerCase().replace(/\s+/g, ' ') : '')

function overridesLookup(overrides) {
  const names = new Map()
  const hidden = new Set()
  for (const [id, name] of Object.entries(overrides?.names ?? {})) names.set(id.startsWith('routine:') ? `routine:${routineKey(id.slice(8))}` : id, name)
  for (const id of overrides?.hidden ?? []) hidden.add(id.startsWith('routine:') ? `routine:${routineKey(id.slice(8))}` : id)
  return { names, hidden }
}

// ---------------------------------------------------------------------------------------------
// the cards

function makeCard(fields) {
  return {
    id: fields.id,
    source: fields.source,
    name: fields.name,
    ref: fields.ref,
    light: fields.light,
    word: READINESS_LIGHTS[fields.light].word,
    pill: fields.pill ?? null,
    faded: fields.faded ?? false,
    sentence: fields.sentence,
    schedule: fields.schedule,
    lastReport: fields.lastReport ?? { text: READINESS_WORDS.never, at: null },
    fadesAt: fields.fadesAt ?? null,
    silentAt: fields.silentAt ?? null,
    silentSentence: fields.silentSentence ?? null
  }
}

const withFaded = (base, faded) => (faded ? sentence(`${base.text} ${READINESS_WORDS.faded}`, base.at) : base)
const lastReportOf = (at) => (at ? { text: '{time}', at } : { text: READINESS_WORDS.never, at: null })
const notReportedSince = (at, failed) => sentence(`${READINESS_WORDS.notReportedSince}${failed ? ` ${READINESS_WORDS.lastRunFailed}` : ''}`, at)
// "Not checked since {date}. The Mac's last reading is {hours} h old." - {hours} is worked out by the
// page from the reading's time, so it stays true while the board is left open.
const notChecked = (takenAt) => sentence(READINESS_WORDS.notChecked, takenAt)

// The Mac's reading is older than eight hours: nothing it says can be a light, and nothing about
// it will change until a newer reading arrives.
function staleCard(card, takenAt) {
  return makeCard({ ...card, light: 'silent', pill: null, faded: false, sentence: notChecked(takenAt), fadesAt: null, silentAt: null, silentSentence: null })
}

// When a card will cross into FADED and SILENT without anyone asking again. null when it already has,
// or when the card is judged against a clock that does not move with the board's (a Mac reading).
function workflowAging(schedule, lastIso, now, missed) {
  const grace = minutes(SLOT_GRACE_MINUTES)
  const tolerance = minutes(SLOT_TOLERANCE_MINUTES)
  const every = /^every (\d+) (minutes|hours)$/.exec(schedule.trim())
  if (every) {
    const step = minutes(Number(every[1]) * (every[2] === 'hours' ? 60 : 1))
    const last = Date.parse(lastIso)
    return {
      fadesAt: missed === 0 && Number.isFinite(last) ? isoOf(last + step + grace + tolerance) : null,
      silentAt: missed < 2 && Number.isFinite(last) ? isoOf(last + 2 * step + grace + tolerance) : null
    }
  }
  // The first slot AFTER the limit (now minus the grace), not after now: a slot that came due ten
  // minutes ago is still inside its grace, and is the one that decides the light at its end.
  const first = nextRunAt(schedule, { now: now - grace })
  if (first === null) return { fadesAt: null, silentAt: null }
  const second = nextRunAt(schedule, { now: Date.parse(first) })
  const atFirst = isoOf(Date.parse(first) + grace)
  const atSecond = second === null ? null : isoOf(Date.parse(second) + grace)
  if (missed === 0) return { fadesAt: atFirst, silentAt: atSecond }
  if (missed === 1) return { fadesAt: null, silentAt: atFirst }
  return { fadesAt: null, silentAt: null }
}

function workflowCard(workflow, ctx) {
  const { now, lookup } = ctx
  const id = `workflow:${workflow.slug}`
  const name = clean(lookup.names.get(id) ?? workflow.name ?? workflow.slug, READINESS_NAME_MAX) || workflow.slug
  const safe = inSentence(name)
  const base = { id, source: 'workflow', name, ref: `Team repo · ${workflow.slug}`, schedule: workflowScheduleWords(workflow.schedule) }
  const say = (template, values = {}, at = null) => sentence(fill(template, { name: safe, ...values }), at)

  if (workflow.arm === 'declared') return makeCard({ ...base, light: 'no-go', sentence: say(READINESS_WORDS.declared), lastReport: lastReportOf(workflow.lastRun?.started_at ?? null) })
  if (workflow.arm === 'unapproved') return makeCard({ ...base, light: 'no-go', sentence: say(READINESS_WORDS.unapproved), lastReport: lastReportOf(workflow.lastRun?.started_at ?? null) })
  if (workflow.arm === 'unknown') return makeCard({ ...base, light: 'silent', sentence: say(READINESS_WORDS.routinesUnknown), lastReport: lastReportOf(workflow.lastRun?.started_at ?? null) })

  const last = workflow.lastRun ?? null
  const startedAt = last && Number.isFinite(Date.parse(last.started_at)) ? isoOf(Date.parse(last.started_at)) : null
  const failed = last?.status === 'failed' || last?.status === 'blocked'
  const judged = workflow.schedule ? lateness(workflow.schedule, startedAt, { now }) : null
  const lastReport = lastReportOf(startedAt)

  if (!last || startedAt === null) {
    return makeCard({ ...base, light: 'silent', sentence: sentence(READINESS_WORDS.neverReported), lastReport })
  }
  if (judged && judged.missed === 2) {
    return makeCard({ ...base, light: 'silent', sentence: notReportedSince(startedAt, failed), lastReport })
  }
  const faded = judged?.missed === 1
  const aging = judged ? workflowAging(workflow.schedule, startedAt, now, judged.missed) : { fadesAt: null, silentAt: null }
  const aged = { ...aging, silentSentence: aging.silentAt ? notReportedSince(startedAt, failed) : null }
  const note = judged ? '' : ` ${READINESS_WORDS.unknownSchedule}`
  const finish = (light, text, extra = {}) => makeCard({
    ...base, light, faded, lastReport, ...aged, ...extra,
    sentence: withFaded(sentence(`${text}${note}`, startedAt), faded)
  })

  if (failed) {
    const summary = firstSentence(last.summary)
    return finish('no-go', fill(READINESS_WORDS.failedFinish, { name: safe, time: '{time}', summary: summary ? inSentence(summary) : READINESS_WORDS.noSummary }))
  }
  if (last.status === 'ok') return finish('go', fill(READINESS_WORDS.ranClean, { name: safe, time: '{time}' }))
  if (last.status === 'partial') return finish('go', fill(READINESS_WORDS.partial, { name: safe, time: '{time}' }))
  // Still going: only a run that started inside the grace can honestly be said to be going.
  if ((last.status == null || last.status === 'running') && now - Date.parse(startedAt) <= minutes(SLOT_GRACE_MINUTES)) {
    return finish('go', fill(READINESS_WORDS.stillGoing, { name: safe, time: '{time}' }))
  }
  return makeCard({ ...base, light: 'silent', lastReport, sentence: sentence(`${fill(READINESS_WORDS.endedUnknown, { name: safe, time: '{time}' })}${note}`, startedAt) })
}

// Why a workflow is not on the wall, or null when it is.
function workflowSwitchedOff(workflow, lookup) {
  const id = `workflow:${workflow.slug}`
  if (lookup.hidden.has(id)) return SWITCHED_OFF.hidden
  const clocklessTrigger = !(typeof workflow.schedule === 'string' && workflow.schedule.trim()) && (workflow.fire === true || workflow.webhook === true)
  if (workflow.ownerSwitchedOff === true) return SWITCHED_OFF.owner
  if (clocklessTrigger) return SWITCHED_OFF.trigger
  if (workflow.arm === 'off') {
    const reason = clean(workflow.reason, READINESS_SUMMARY_MAX)
    return reason ? `${SWITCHED_OFF.armedPrefix}${reason}` : SWITCHED_OFF.notArmed
  }
  return null
}

// The Mac side. `reading` is one computer from shapeJobs; checkedAt is the reading's own time.
function macContext(computer, now) {
  const takenMs = Date.parse(computer.takenAt)
  const stale = computer.freshness === 'stale'
  const where = computer.computer ?? 'Mac'
  return { computer, takenAt: computer.takenAt, takenMs, stale, where, now }
}

// Of the two most recent expected runs, how many did the last report miss? Tolerance as in workflows.
function missedOf(reportAt, dueAt, dueBeforeAt) {
  if (!dueAt) return null
  const counts = (slot) => reportAt !== null && Date.parse(reportAt) >= Date.parse(slot) - minutes(SLOT_TOLERANCE_MINUTES)
  if (counts(dueAt)) return 0
  if (dueBeforeAt && counts(dueBeforeAt)) return 1
  // The newest expected run was missed and there is no earlier one in the file to say the job was
  // keeping up (a monthly job has one in the look-back): that is two missed, never a green card
  // that was last seen working months ago. The team-repo side counts the same way.
  return 2
}

function launchdCard(job, ctx, lookup) {
  const { now } = ctx
  const id = `launchd:${job.label}`
  const name = clean(lookup.names.get(id) ?? readableLabel(job.label), READINESS_NAME_MAX)
  const safe = inSentence(name)
  const base = { id, source: 'launchd', name, ref: `${ctx.where} · ${job.label}`, schedule: cadenceWords(job.cadence) }
  const say = (template, values = {}, at = null) => sentence(fill(template, { name: safe, time: '{time}', ...values }), at)
  const card = (fields) => (ctx.stale ? staleCard(makeCard({ ...base, ...fields }), ctx.takenAt) : makeCard({ ...base, ...fields }))
  const report = lastReportOf(job.lastReportAt)

  if (job.state === 'not loaded') return card({ light: 'no-go', sentence: say(READINESS_WORDS.notLoaded), lastReport: report })

  if (job.cadence.kind === 'always') {
    if (job.state === 'running') {
      return card({
        light: 'go', pill: READINESS_WORDS.pill, lastReport: report,
        sentence: sentence(`${fill(READINESS_WORDS.running, { name: safe, time: '{time}' })}${MANAGED_OWNER_LABELS.includes(job.label) ? ` ${READINESS_WORDS.managedOwner}` : ''}`, ctx.takenAt),
        silentAt: isoOf(ctx.takenMs + READINESS_STALE_HOURS * 3600_000),
        silentSentence: notChecked(ctx.takenAt)
      })
    }
    return card({
      light: 'no-go', lastReport: report, sentence: say(READINESS_WORDS.notRunning, {}, ctx.takenAt),
      silentAt: isoOf(ctx.takenMs + READINESS_STALE_HOURS * 3600_000),
      silentSentence: notChecked(ctx.takenAt)
    })
  }

  const failed = job.state === 'loaded' && job.lastExit !== null && job.lastExit !== 0
  const missed = job.cadence.kind === 'unknown' ? null : missedOf(job.lastReportAt, job.dueAt, job.dueBeforeAt)
  const note = missed === null ? ` ${job.cadence.kind === 'unknown' ? READINESS_WORDS.unknownSchedule : READINESS_WORDS.noRecentSlot}` : ''
  const stalesAt = isoOf(ctx.takenMs + READINESS_STALE_HOURS * 3600_000)
  const staleWords = notChecked(ctx.takenAt)

  if (job.lastReportAt === null) return card({ light: 'silent', sentence: sentence(READINESS_WORDS.neverReported), lastReport: report })
  if (missed === 2) return card({ light: 'silent', sentence: notReportedSince(job.lastReportAt, failed), lastReport: report })
  const faded = missed === 1
  const shared = { faded, lastReport: report, silentAt: stalesAt, silentSentence: staleWords }
  // A listed job with no last exit has not told the board how its last run went: a log that was
  // written lately is not an outcome. Said as unknown, like a Hermes result the board cannot word.
  if (job.state === 'loaded' && job.lastExit === null) {
    return card({ light: 'silent', lastReport: report, sentence: sentence(`${fill(READINESS_WORDS.launchdEndedUnknown, { name: safe, time: '{time}' })}${note}`, job.lastReportAt) })
  }
  if (failed) {
    return card({ ...shared, light: 'no-go', sentence: withFaded(sentence(`${fill(READINESS_WORDS.failedExit, { name: safe, code: job.lastExit })}${note}`, job.lastReportAt), faded) })
  }
  if (job.state === 'running') {
    return card({ ...shared, light: 'go', sentence: withFaded(sentence(`${fill(READINESS_WORDS.running, { name: safe, time: '{time}' })}${note}`, ctx.takenAt), faded) })
  }
  return card({ ...shared, light: 'go', sentence: withFaded(sentence(`${fill(READINESS_WORDS.ranClean, { name: safe, time: '{time}' })}${note}`, job.lastReportAt), faded) })
}

function hermesJobCard(job, ctx, lookup) {
  const { now } = ctx
  const id = `hermes:${job.profile}/${job.id}`
  const name = clean(lookup.names.get(id) ?? job.name, READINESS_NAME_MAX)
  const safe = inSentence(name)
  const base = { id, source: 'hermes', name, ref: `${ctx.where} · Hermes · ${job.profile} · ${job.id}`, schedule: cadenceWords(job.cadence) }
  const card = (fields) => (ctx.stale ? staleCard(makeCard({ ...base, ...fields }), ctx.takenAt) : makeCard({ ...base, ...fields }))
  const report = lastReportOf(job.lastRunAt)
  const failed = job.lastResult === 'error'
  const missed = job.cadence.kind === 'slots' || job.cadence.kind === 'every' ? missedOf(job.lastRunAt, job.dueAt, job.dueBeforeAt) : null
  const note = missed === null ? ` ${job.cadence.kind === 'unknown' ? READINESS_WORDS.unknownSchedule : READINESS_WORDS.noRecentSlot}` : ''
  const stalesAt = isoOf(ctx.takenMs + READINESS_STALE_HOURS * 3600_000)
  const staleWords = notChecked(ctx.takenAt)

  if (job.lastRunAt === null) return card({ light: 'silent', sentence: sentence(READINESS_WORDS.neverReported), lastReport: report })
  if (missed === 2) return card({ light: 'silent', sentence: notReportedSince(job.lastRunAt, failed), lastReport: report })
  const faded = missed === 1
  const shared = { faded, lastReport: report, silentAt: stalesAt, silentSentence: staleWords }
  const say = (template) => withFaded(sentence(`${fill(template, { name: safe, time: '{time}' })}${note}`, job.lastRunAt), faded)
  if (failed) return card({ ...shared, light: 'no-go', sentence: say(READINESS_WORDS.hermesFailed) })
  if (job.lastResult === 'ok') return card({ ...shared, light: 'go', sentence: say(READINESS_WORDS.ranClean) })
  return card({ light: 'silent', lastReport: report, sentence: say(READINESS_WORDS.hermesEndedUnknown) })
}

// Hermes itself, one card per computer, from the rule the Hermes card already uses.
function hermesServiceCards(hermes) {
  if (!hermes || hermes.status !== 'ok') return []
  return hermes.computers.filter((computer) => computer.install?.status === 'found').map((computer) => {
    const where = computer.computer ?? 'Mac'
    const takenMs = Date.parse(computer.takenAt)
    const base = {
      id: `hermes-service:${where}`, source: 'hermes-service', name: 'Hermes', ref: `${where} · Hermes`, schedule: 'Always on',
      lastReport: lastReportOf(computer.takenAt)
    }
    const stalesAt = computer.alive === 'stale' ? null : isoOf(takenMs + READINESS_STALE_HOURS * 3600_000)
    const staleWords = notChecked(computer.takenAt)
    if (computer.alive === 'stale') {
      return staleCard(makeCard({ ...base, light: 'silent', sentence: sentence('', computer.takenAt) }), computer.takenAt)
    }
    if (computer.alive === 'running') {
      return makeCard({ ...base, light: 'go', pill: READINESS_WORDS.pill, sentence: sentence(READINESS_WORDS.hermesRunning, computer.takenAt), silentAt: stalesAt, silentSentence: staleWords })
    }
    return makeCard({ ...base, light: 'no-go', sentence: sentence(READINESS_WORDS.hermesDown, computer.takenAt), silentAt: stalesAt, silentSentence: staleWords })
  })
}

// The status collector's own card: judged by when it last wrote, every three hours, on the board's
// clock, because it is the one thing that tells the board anything about the Mac.
function collectorCard(computer, now) {
  const where = computer.computer ?? 'Mac'
  const takenMs = Date.parse(computer.takenAt)
  const grace = minutes(SLOT_GRACE_MINUTES)
  const tolerance = minutes(SLOT_TOLERANCE_MINUTES)
  const step = minutes(COLLECTOR_EVERY_MINUTES)
  const judged = lateness(`every ${COLLECTOR_EVERY_MINUTES / 60} hours`, computer.takenAt, { now })
  const self = computer.launchd.items.find((item) => item.self === true)
  const base = {
    id: `collector:${where}`, source: 'collector', name: 'Status collector', ref: `${where} · status collector`,
    schedule: self && self.cadence.kind !== 'unknown' ? cadenceWords(self.cadence) : everyWords(COLLECTOR_EVERY_MINUTES),
    lastReport: lastReportOf(computer.takenAt)
  }
  const silentWords = sentence(READINESS_WORDS.collectorSilent, computer.takenAt)
  if (judged.missed === 2) return makeCard({ ...base, light: 'silent', sentence: silentWords })
  const faded = judged.missed === 1
  return makeCard({
    ...base, light: 'go', faded,
    sentence: withFaded(sentence(READINESS_WORDS.collectorRan, computer.takenAt), faded),
    fadesAt: judged.missed === 0 ? isoOf(takenMs + step + grace + tolerance) : null,
    silentAt: isoOf(takenMs + 2 * step + grace + tolerance),
    silentSentence: silentWords
  })
}

const GATEWAY_LABEL = /^ai\.hermes\.gateway/

// A list the collector wrote as "unavailable": the Mac was asked for it and could not give it (it
// could not be read, or the safety check refused the file). That is not an empty list. It is a hole
// in the wall, and it is a card of its own - SILENT, so it counts in the tab - with the collector's
// fixed reason, never the file's own words.
const LIST_WORDS = { launchd: { name: 'Mac LaunchAgents', what: 'LaunchAgents', ref: 'LaunchAgents list' }, hermes: { name: 'Hermes cron jobs', what: 'Hermes cron jobs', ref: 'Hermes cron jobs list' } }

function listUnavailableCard(computer, which, ctx) {
  const words = LIST_WORDS[which]
  const block = computer[which]
  const text = block.why
    ? fill(READINESS_WORDS.listUnavailable, { what: words.what, time: '{time}', why: block.why })
    : fill(READINESS_WORDS.listUnavailableNoWhy, { what: words.what, time: '{time}' })
  const card = makeCard({
    id: `jobs-list:${ctx.where}:${which}`, source: 'jobs-list', name: words.name, ref: `${ctx.where} · ${words.ref}`,
    light: 'silent', sentence: sentence(text, ctx.takenAt), schedule: 'Not known', lastReport: lastReportOf(ctx.takenAt)
  })
  return ctx.stale ? staleCard(card, ctx.takenAt) : card
}

function switchedOffEntry(id, source, name, ref, reason) {
  return { id, source, name, ref, reason }
}

// ---------------------------------------------------------------------------------------------

const byOrder = (a, b) => {
  if (a.light !== b.light) return READINESS_LIGHTS[a.light].rank - READINESS_LIGHTS[b.light].rank
  if (a.faded !== b.faded) return a.faded ? 1 : -1
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
}

// Sorts and counts the cards the way the screen shows them. The page calls this again when a card
// ages into the next light, so the order and the numbers are the server's own rule in both places.
export function orderCards(cards) {
  return [...cards].sort(byOrder)
}

export function countCards(cards) {
  const counts = { noGo: 0, silent: 0, go: 0, faded: 0 }
  for (const card of cards) {
    if (card.light === 'no-go') counts.noGo += 1
    else if (card.light === 'silent') counts.silent += 1
    else counts.go += 1
    if (card.faded) counts.faded += 1
  }
  return counts
}

export function shapeReadiness({ workflows = [], routines = null, jobs = null, hermes = null, overrides = null, now = Date.now() } = {}) {
  const lookup = overridesLookup(overrides)
  const cards = []
  const switchedOff = []

  for (const workflow of Array.isArray(workflows) ? workflows : []) {
    const reason = workflowSwitchedOff(workflow, lookup)
    if (reason) {
      const name = clean(lookup.names.get(`workflow:${workflow.slug}`) ?? workflow.name ?? workflow.slug, READINESS_NAME_MAX) || workflow.slug
      switchedOff.push(switchedOffEntry(`workflow:${workflow.slug}`, 'workflow', name, `Team repo · ${workflow.slug}`, reason))
    } else {
      cards.push(workflowCard(workflow, { now, lookup }))
    }
  }

  if (routines?.known === true) {
    for (const routine of routines.orphans ?? []) {
      const key = `routine:${routineKey(routine?.name)}`
      const raw = clean(routine?.name, READINESS_NAME_MAX) || '(unnamed)'
      const name = clean(lookup.names.get(key) ?? raw, READINESS_NAME_MAX)
      if (lookup.hidden.has(key)) {
        switchedOff.push(switchedOffEntry(`routine:${raw}`, 'routine', name, `Account routine · ${raw}`, SWITCHED_OFF.hidden))
        continue
      }
      cards.push(makeCard({
        id: `routine:${raw}`, source: 'routine', name, ref: `Account routine · ${raw}`, light: 'silent',
        sentence: sentence(fill(READINESS_WORDS.orphan, { name: inSentence(name) })), schedule: 'Not known'
      }))
    }
  }

  const service = hermesServiceCards(hermes)
  cards.push(...service)
  // The computers that have a Hermes card of their own. Their gateway's LaunchAgent would say the
  // same thing a second time, in a worse way, so it is dropped; a computer the Hermes reading does
  // not cover keeps its gateway row, because then it is the only thing that says anything.
  const hermesComputers = new Set(service.map((card) => card.ref.replace(/ · Hermes$/, '').toLowerCase()))
  const replacesGateway = (computer) => service.length > 0 && (computer.computer === null || hermesComputers.has(computer.computer.toLowerCase()) || hermesComputers.has('mac'))

  const computers = jobs?.status === 'ok' ? jobs.computers : []
  let hiddenBySafety = 0
  for (const computer of computers) {
    const ctx = macContext(computer, now)
    // Whatever else the reading holds, the collector wrote it: its own card is always there.
    cards.push(collectorCard(computer, now))
    for (const which of ['launchd', 'hermes']) if (computer[which].status === 'unavailable') cards.push(listUnavailableCard(computer, which, ctx))
    hiddenBySafety += computer.launchd.hidden + computer.hermes.hidden
    if (computer.launchd.status === 'found') {
      for (const job of computer.launchd.items) {
        if (job.self) continue
        const id = `launchd:${job.label}`
        const display = clean(lookup.names.get(id) ?? readableLabel(job.label), READINESS_NAME_MAX)
        if (GATEWAY_LABEL.test(job.label) && replacesGateway(computer)) continue
        const off = lookup.hidden.has(id) ? SWITCHED_OFF.hidden : job.disabled ? SWITCHED_OFF.disabled : null
        if (off) switchedOff.push(switchedOffEntry(id, 'launchd', display, `${ctx.where} · ${job.label}`, off))
        else cards.push(launchdCard(job, ctx, lookup))
      }
    }
    if (computer.hermes.status === 'found') {
      for (const job of computer.hermes.items) {
        const id = `hermes:${job.profile}/${job.id}`
        const display = clean(lookup.names.get(id) ?? job.name, READINESS_NAME_MAX)
        const off = lookup.hidden.has(id) ? SWITCHED_OFF.hidden : job.enabled === false ? SWITCHED_OFF.hermesOff : null
        if (off) switchedOff.push(switchedOffEntry(id, 'hermes', display, `${ctx.where} · Hermes · ${job.profile} · ${job.id}`, off))
        else cards.push(hermesJobCard(job, ctx, lookup))
      }
    }
  }

  const ordered = orderCards(cards)
  const counts = countCards(ordered)
  const newest = computers.length ? computers.reduce((best, computer) => (Date.parse(computer.takenAt) > Date.parse(best) ? computer.takenAt : best), computers[0].takenAt) : null
  return {
    checkedAt: isoOf(now),
    macCheckedAt: newest,
    badge: counts.noGo + counts.silent,
    counts: { ...counts, switchedOff: switchedOff.length, hiddenBySafety },
    cards: ordered,
    switchedOff: switchedOff.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    jobs: { status: jobs?.status ?? 'none', why: jobs?.why ?? null },
    routinesKnown: routines?.known === true,
    fadedNote: READINESS_WORDS.faded
  }
}
