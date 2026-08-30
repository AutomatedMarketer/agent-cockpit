import { createHash, timingSafeEqual } from 'node:crypto'

// --- the read gate -----------------------------------------------------------------
// Vercel's own "Standard Protection" exempts production domains, and closing that gap on
// their side costs $150/month. This closes it in the app instead, for nothing: the two
// read endpoints serve a private repo, so they answer nobody without the key.
//
// Hash both sides to a fixed length first so timingSafeEqual never throws on a length
// mismatch - a plain length check would itself leak the key's length through timing.
export function keysMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false
  return timingSafeEqual(
    createHash('sha256').update(provided).digest(),
    createHash('sha256').update(expected).digest()
  )
}

// Returns null when the request may proceed, or {status, error} to send back.
// Closed is the default. A deployment with no VIEW_KEY refuses to serve rather than
// serving a private repo to the open web - the failure mode has to be silence, not
// exposure. PUBLIC_DASHBOARD=true is the deliberate, documented way out.
export function viewGate(request, env = process.env) {
  if (env.PUBLIC_DASHBOARD === 'true') return null
  const expected = env.VIEW_KEY
  if (!expected) {
    return {
      status: 503,
      error:
        'This dashboard is not configured. Set VIEW_KEY in your hosting environment and ' +
        'redeploy, or set PUBLIC_DASHBOARD=true if this repo is genuinely public.'
    }
  }
  const provided = request?.headers?.['x-view-key'] ?? request?.headers?.['X-View-Key']
  if (!keysMatch(typeof provided === 'string' ? provided : '', expected)) {
    return { status: 401, error: 'Missing or wrong view key. Send it in the x-view-key header.' }
  }
  return null
}

// Pure helpers, kept out of the handler so they can be tested without a network.

export const STALE_AFTER_DAYS = 7
export const HEARTBEAT_STALE_AFTER_MINUTES = 30
export const OVERNIGHT_HOURS = 24

// Flat `key: value` frontmatter is all an agent file uses.
export function parseFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source ?? '')
  if (!match) return {}
  const data = {}
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (pair) data[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, '')
  }
  return data
}

export function daysSince(iso, now = Date.now()) {
  if (!iso) return null
  const parsed = new Date(iso).getTime()
  if (Number.isNaN(parsed)) return null
  return Math.floor((now - parsed) / 86400000)
}

export function minutesSince(iso, now = Date.now()) {
  if (!iso) return null
  const parsed = new Date(iso).getTime()
  if (Number.isNaN(parsed)) return null
  return (now - parsed) / 60000
}

// An agent switched off on purpose and one nobody has got to yet both had no runs, so both read
// "Never run" on the Team screen and both counted against "N of 8 agents working". They are not
// the same thing: sales and customer-service usually never apply to someone who works for the
// business rather than owning it, and the course says so on day one.
//
// KEEP IN SYNC with agent-team-template's scripts/lib/knowledge.mjs, which makes the same
// judgement for check:arming and the matcher. Mirrored rather than imported because the two repos
// deploy separately; if this regex changes, change it there in the same breath.
//
// The signal is the knowledge file having been ANSWERED with a refusal - no fill markers left,
// AND a first-person negation. Both halves are needed: the shipped template quotes "I do not
// sell" inside its own guidance paragraph, so matching the phrase alone marks every fresh clone
// as not in use.
const NOT_IN_USE = /\b(?:i|we)\s+do\s+not\s+(?:sell|deal\s+with\s+customers|have\s+customers)\b/i

export function notInUse(knowledgeBody) {
  if (typeof knowledgeBody !== 'string' || !knowledgeBody) return false
  if (fillMarkers(knowledgeBody).length) return false
  return NOT_IN_USE.test(knowledgeBody)
}

// runs must be newest first. States match the Team screen: working / attention / quiet /
// never-run / not-in-use. "Quiet" is the one that matters — an agent that silently stopped is
// worse than no agent, because you were counting on it.
export function stateFor(runs, now = Date.now(), isNotInUse = false) {
  if (isNotInUse) return 'not-in-use'
  if (!runs.length) return 'never-run'
  const age = daysSince(runs[0].started_at, now)
  if (age !== null && age > STALE_AFTER_DAYS) return 'quiet'
  if (runs[0].status === 'failed' || runs[0].status === 'blocked') return 'attention'
  return 'working'
}

export function fillMarkers(source) {
  return [...String(source ?? '').matchAll(/<!--\s*fill:\s*([a-z0-9-]+)\s*-->/g)].map(
    (match) => match[1]
  )
}

export function sortRunsNewestFirst(runs) {
  return [...runs].sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))
}

// "What ran overnight" — everything inside the last day, so the morning glance always has
// yesterday evening and last night in it whatever timezone the reader woke up in.
export function runsSince(runs, hours = OVERNIGHT_HOURS, now = Date.now()) {
  return runs.filter((run) => {
    const started = new Date(run.started_at).getTime()
    return !Number.isNaN(started) && now - started <= hours * 3600000 && started <= now
  })
}

// --- agent identity colors ----------------------------------------------------------------
//
// KEEP IN SYNC: these two functions (AGENT_PALETTE, agentColorIndex) and scheduleWeekView
// below are mirrored verbatim inside public/index.html's inline script, because the page
// ships with no module loading. Change them here, change them there.
//
// Eight distinct dark-theme-friendly hues. Agent color is IDENTITY only — status colors
// (ok/warn/bad) stay separate and are never applied to the same element as an agent color.
export const AGENT_PALETTE = [
  { name: 'blue', hex: '#60a5fa' },
  { name: 'violet', hex: '#a78bfa' },
  { name: 'teal', hex: '#2dd4bf' },
  { name: 'amber', hex: '#facc15' },
  { name: 'rose', hex: '#fb7185' },
  { name: 'green', hex: '#34d399' },
  { name: 'cyan', hex: '#22d3ee' },
  { name: 'orange', hex: '#fb923c' }
]

// Deterministic slug → palette index. Hash: FNV-1a 32-bit over the slug's UTF-16 code
// units (offset basis 0x811c9dc5, prime 0x01000193, Math.imul for 32-bit wrap), then
// unsigned mod 8. Pure arithmetic on the string — the same slug maps to the same color
// forever, on every device, with no stored state.
export function agentColorIndex(slug) {
  const text = String(slug ?? '')
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % AGENT_PALETTE.length
}

// --- schedule → week-strip expansion ------------------------------------------------------
//
// Expands one parsed schedule string (the six forms from api/workflows.js) into what the
// Schedule strip draws. Days are Monday-first: 0 = Mon … 6 = Sun.
//   daily HH:MM     → { type: 'days', days: [0..6], time }
//   weekdays HH:MM  → { type: 'days', days: [0..4], time }
//   weekly ddd HH:MM→ { type: 'days', days: [thatDay], time }
//   monthly D HH:MM → { type: 'monthly', day: D, time }   (footnote row, not a column)
//   hourly          → { type: 'interval', label: 'hourly' }
//   every N minutes|hours → { type: 'interval', label: 'every Nm' | 'every Nh' }
// Anything unrecognised → null.
const WEEK_MON_FIRST = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

export function scheduleWeekView(schedule) {
  if (typeof schedule !== 'string') return null
  const trimmed = schedule.trim()
  let match
  if (trimmed === 'hourly') return { type: 'interval', label: 'hourly' }
  if ((match = /^every (\d+) (minutes|hours)$/.exec(trimmed))) {
    return { type: 'interval', label: `every ${match[1]}${match[2] === 'hours' ? 'h' : 'm'}` }
  }
  if ((match = /^daily (\d{2}:\d{2})$/.exec(trimmed))) {
    return { type: 'days', days: [0, 1, 2, 3, 4, 5, 6], time: match[1] }
  }
  if ((match = /^weekdays (\d{2}:\d{2})$/.exec(trimmed))) {
    return { type: 'days', days: [0, 1, 2, 3, 4], time: match[1] }
  }
  if ((match = /^weekly (sun|mon|tue|wed|thu|fri|sat) (\d{2}:\d{2})$/.exec(trimmed))) {
    return { type: 'days', days: [WEEK_MON_FIRST.indexOf(match[1])], time: match[2] }
  }
  if ((match = /^monthly (\d{1,2}) (\d{2}:\d{2})$/.exec(trimmed))) {
    return { type: 'monthly', day: Number(match[1]), time: match[2] }
  }
  return null
}

// --- task text → { title, details } -------------------------------------------------------
//
// KEEP IN SYNC: mirrored verbatim inside public/index.html's inline script (same rule as
// the palette helpers above). The Add-task form is one textarea: the first line becomes
// the card's title (clipped to the endpoint's 200-char cap), and when there is more than
// the title — extra lines, or a clipped first line — the full text rides as details.
// --- the week calendar -------------------------------------------------------------------
// Mirrored verbatim in public/index.html. Monday-first, local time: the calendar answers
// "did today's job run", and a UTC week would answer it for the wrong day either side of
// midnight.

export function weekDates(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
  return Array.from({ length: 7 }, (unused, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    return date
  })
}

export const dateKey = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

// Which local days a workflow actually ran on, from the run logs. Runs match a workflow by
// its slug - the same field the Workflows board matches on - so a run log missing
// `workflow` counts for nothing rather than for everything.
export function ranOnDays(runs, slug) {
  const days = new Set()
  if (!slug) return days
  for (const run of runs ?? []) {
    if (run.workflow !== slug) continue
    const at = Date.parse(run.started_at)
    if (!Number.isFinite(at)) continue
    days.add(dateKey(new Date(at)))
  }
  return days
}

export function splitTaskText(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return null
  const title = trimmed.split(/\r?\n/)[0].trim().slice(0, 200).trim()
  return trimmed === title ? { title } : { title, details: trimmed.slice(0, 2000) }
}

// A heartbeat file is `{ "runtime": "hermes", "at": "…" }`, written by the runtime's own
// cron. Fresh means the light is on. Stale or absent means it is not, and the rail says so
// rather than pretending everything is fine.
export function heartbeatStatus(beat, now = Date.now()) {
  if (!beat || typeof beat !== 'object' || !beat.at) {
    return { status: 'no-heartbeat', lastBeat: null }
  }
  const age = minutesSince(beat.at, now)
  if (age === null) return { status: 'no-heartbeat', lastBeat: null }
  return {
    status: age <= HEARTBEAT_STALE_AFTER_MINUTES ? 'live' : 'silent',
    lastBeat: beat.at
  }
}
