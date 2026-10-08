// One request from the browser, one JSON payload back — enough to draw all seven screens:
// Today, Ledger, Team, Workflows, Skills, Memory, Connections.
//
// The cockpit reads the team repo and nothing else. There is no database, no Anthropic
// API call, and no run-history endpoint to reverse-engineer — Routines does not publish
// one. Everything on the page comes from files the agents committed.
//
// One GitHub tree call gives every path in the repo; raw fetches fill in the handful of
// files each screen needs. The GitHub token, when there is one, stays on the server. A
// private team repo works; the token never reaches the browser.
//
// The dashboard READS git. It never writes. Dispatching work is api/fire.js's job — even
// "pause" is a dispatch there, instructing the agent session to make the edit itself.

import {
  parseFrontmatter,
  daysSince,
  stateFor,
  notInUse,
  notInUseBecause,
  fillMarkers,
  sortRunsNewestFirst,
  runsSince,
  heartbeatStatus, HEARTBEAT_STALE_AFTER_MINUTES, HEARTBEAT_STALE_MIN_MINUTES,
  HEARTBEAT_STALE_MAX_MINUTES, viewGate, TASK_STATUSES } from './lib.js'
import {
  parseWorkflow,
  normaliseSteps,
  validateWorkflow,
  nextRunAt,
  isGoneQuiet
} from './workflows.js'
import { parseSimpleYaml } from './yaml-lite.js'

const GITHUB = 'https://api.github.com'
const AGENT_DIR = '.claude/agents'
const BRAIN_FILES = ['shared/about-me.md', 'shared/business-brain.md', 'shared/writing-rules.md']
// The two agents that usually never apply to someone with a job rather than a company. Their
// knowledge file is where that decision is written down, so it is the only place the board can
// learn it. Two extra fetches, in parallel with the ones already happening.
const KNOWLEDGE_FILES = {
  sales: 'agents/sales/knowledge/offer-sheet.md',
  'customer-service': 'agents/customer-service/knowledge/faq.md'
}
const MAX_RUNS_RETURNED = 50
// Each agent's own newest runs, sent with the agent. The Team card counted its runs from the whole
// list and drew them from the feed above, which is the newest fifty across EVERY agent - so an
// agent whose work was older than the busiest one's last fifty said "8 runs logged" and opened to
// "No runs logged yet". Five is what the card has room for.
const AGENT_RECENT_RUNS = 5
const MAX_MEMORY_FILES = 2000

function config() {
  const owner = process.env.GITHUB_OWNER
  const repo = process.env.GITHUB_REPO
  const branch = process.env.GITHUB_BRANCH || 'main'
  if (!owner || !repo) {
    throw new Error('Set GITHUB_OWNER and GITHUB_REPO in your hosting environment, then redeploy.')
  }
  return { owner, repo, branch }
}

function headers(accept = 'application/vnd.github+json') {
  const base = { Accept: accept, 'User-Agent': 'agent-cockpit' }
  if (process.env.GITHUB_TOKEN) base.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  return base
}

async function gh(path) {
  const response = await fetch(`${GITHUB}${path}`, { headers: headers() })
  if (!response.ok) {
    const detail = await response.text()
    const error = new Error(`GitHub returned ${response.status}. ${detail.slice(0, 200)}`)
    error.status = response.status
    throw error
  }
  return response.json()
}

async function rawFile({ owner, repo, branch }, filePath) {
  const response = await fetch(
    `${GITHUB}/repos/${owner}/${repo}/contents/${encodeURI(filePath)}?ref=${branch}`,
    { headers: headers('application/vnd.github.raw') }
  )
  if (!response.ok) return null
  return response.text()
}

// --- shaping, exported so the suite can hit them without a network -----------------------

// ---------------------------------------------------------------------------------------------
// Which jobs actually ring.
//
// A workflow file saying `schedule: "daily 06:30"` makes nothing happen at 06:30. A routine is the
// alarm clock. This board reported nine jobs running, each with a next-run time, against one real
// routine - not because anyone lied, but because a file that says `schedule:` looks exactly like a
// job that runs, and nothing here ever checked.
//
// This dashboard is a web app reading GitHub. It cannot call the routines API - no browser can. So
// the truth arrives as a snapshot committed by /routines, and everything below treats it as one:
// it carries the moment it was taken, and a stale or absent snapshot says so rather than passing
// for current. A snapshot presented as live is the same class of lie as the declared job it is
// here to catch.
//
// The reconcile logic mirrors scripts/lib/arm.mjs in the team repo. Deliberately mirrored, not
// imported: that repo is the student's, this one is a deployed app, and there is no import path
// between them. tests/routines.test.mjs pins the two to the same answers.

export const SNAPSHOT_STALE_AFTER_HOURS = 24

// "242426 hours old" is not a number anybody reads, and the point of the sentence is that somebody
// notices it.
export function describeAge(hours) {
  if (hours < 48) return `${Math.round(hours)} hours`
  const days = Math.round(hours / 24)
  if (days < 14) return `${days} days`
  const weeks = Math.round(days / 7)
  if (weeks < 9) return `${weeks} weeks`
  const months = Math.round(days / 30)
  return months < 24 ? `${months} months` : `${Math.round(days / 365)} years`
}
export const ARM_STATES = ['armed', 'declared', 'unapproved', 'off', 'unknown']

function routineNameKey(value) {
  // NFC, matching arm.mjs. Without it "Cafe\u0301" and "Caf\u00e9" are different strings that look
  // identical, and one correctly armed job reports DECLARED while its own routine is listed as an
  // orphan - two false statements about the same job, on the same screen.
  return typeof value === 'string' ? value.trim().normalize('NFC').toLowerCase().replace(/\s+/g, ' ') : ''
}

// Every `why` here is a FINISHED SENTENCE, capital letter and full stop, for the same reason the
// hero panel's are: they are printed straight after a bold sentence that ends in a full stop, so a
// fragment starting lowercase reads as a typo on the most prominent warning on the screen. That was
// fixed for the hero panel one screen earlier and missed here - the tool was fixed and the other
// end of it was not.
//
// Capitalising at the display layer is NOT the fix, and this is the third place that has been true:
// the display layer cannot tell a sentence from a filename, and doing it there once turned
// `tiles.yml` into `Tiles.yml` and sent students to a file that does not exist.
export function shapeSnapshot(source, now = Date.now()) {
  if (source === null || source === undefined) {
    return { takenAt: null, routines: [], usable: false, why: 'No snapshot has been taken yet.' }
  }
  let parsed
  try {
    parsed = JSON.parse(source)
  } catch {
    // Corrupt is not absent. An empty routine list for an unreadable file would assert "nothing is
    // scheduled", which is a claim about somebody's account a broken file cannot support.
    return { takenAt: null, routines: [], usable: false, why: 'The snapshot could not be read.' }
  }
  const routines = Array.isArray(parsed?.routines) ? parsed.routines : null
  if (!routines) {
    return { takenAt: null, routines: [], usable: false, why: 'The snapshot has no routines list.' }
  }
  const takenAt = typeof parsed?.takenAt === 'string' ? parsed.takenAt.trim() : ''
  const takenMs = takenAt ? Date.parse(takenAt) : NaN
  if (!takenAt || Number.isNaN(takenMs)) {
    return { takenAt: null, routines, usable: false, why: 'The snapshot does not say when it was taken.' }
  }
  const ageHours = (now - takenMs) / 3600_000

  // A stamp in the future is not fresh, it is wrong - clock skew, a hand edit, a bad timezone.
  // Left alone it gives the worst possible answer: ageHours goes negative, the staleness test
  // passes, and a file dated 2099 reads as the most current snapshot imaginable.
  if (ageHours < 0) {
    return {
      takenAt,
      routines,
      ageHours,
      usable: false,
      why: 'The snapshot is stamped in the future, so its age cannot be trusted.'
    }
  }

  const stale = ageHours > SNAPSHOT_STALE_AFTER_HOURS
  return {
    takenAt,
    routines,
    ageHours,
    stale,
    usable: true,
    why: stale ? `The snapshot was taken ${describeAge(ageHours)} ago.` : null
  }
}

// ---------------------------------------------------------------------------------------------
// Usage meters: how much of each plan is used, read from the files the collector commits.
//
// Like the routines snapshot, this is a reading with a moment attached, never a live number: the
// board cannot reach anybody's Claude or Codex account, and must not try. A collector on the
// owner's always-on computer writes .agent-team/status/usage/<computer>.json, and the rules below
// are shapeSnapshot's - missing, corrupt, undated, future and stale each say so - with eight hours
// for stale, because the collector runs every three and two missed runs is worth a sentence.
//
// The collector has its own fail-closed gate. This board does not lean on it. The file reaches here
// through a repo anybody with push access can edit, and this payload goes to a browser on a board
// that can be public, so every key, number and name is checked again here and the output is BUILT
// from the keys the board knows rather than copied and pruned. An unknown key cannot leak, because
// nothing ever reads it.
//
// KEEP IN SYNC with scripts/lib/status/schema.mjs in agent-team-template. Mirrored by hand, not
// imported, for the same reason as the arming rules: there is no import path between a student's
// repo and a deployed app. tests/fixtures/usage-parity.json is the shared contract, the same bytes
// in both repos, and tests/usage.test.mjs holds these constants to it.
export const USAGE_SCHEMA = 'agent-status/usage/v1'
export const USAGE_FOLDER = '.agent-team/status/usage'
export const USAGE_COMPUTER_SLUG = /^[a-z0-9-]{1,32}$/
export const USAGE_STALE_AFTER_HOURS = 8
export const USAGE_MAX_FILES = 5
export const USAGE_MAX_STRING = 60
export const USAGE_STATUSES = ['found', 'not found', 'unavailable']
export const USAGE_SOURCES = ['unofficial-live', 'claude-code-statusline', 'claude-code-saved', 'codex-session-log']
export const USAGE_WINDOWS = {
  five_hour: '5-hour',
  weekly_all: 'Weekly',
  weekly_model: 'Weekly, {model} only',
  weekly: 'Weekly'
}
const USAGE_SERVICES = ['claude', 'codex']
// More windows than the contract allows is a file that is not what it says it is. A window must say
// what it is and how much is used; the model and the reset time may be missing, because Claude's
// address answers `resets_at: null` for a window that has not started yet.
export const USAGE_MAX_WINDOWS = 8
export const USAGE_WINDOW_REQUIRED = ['kind', 'usedPercent']
export const USAGE_WINDOW_OPTIONAL = ['model', 'resetsAt']
export const USAGE_MAX_ACTIVITY_DAYS = 17
export const USAGE_MAX_PERCENT = 1000
const USAGE_ESTIMATE_DAYS = 7
const USAGE_MAX_COUNT = 1e7
// A reading is a few hundred bytes; the biggest the collector can write is a few kilobytes. Anything
// over this is not a reading, and is neither fetched nor parsed.
export const USAGE_MAX_BYTES = 64 * 1024
// The limits are read a moment before the file is stamped, so a reading time after the stamp is two
// clocks a little apart at most. Past this, it is not a time the board can date anything by.
const USAGE_READ_SLACK_MS = 5 * 60_000
const UNKNOWN_SHAPE = 'The reading is not in a shape this board knows.'

export function isUsageFile(path) {
  const prefix = `${USAGE_FOLDER}/`
  if (typeof path !== 'string' || !path.startsWith(prefix) || !path.endsWith('.json')) return false
  return USAGE_COMPUTER_SLUG.test(path.slice(prefix.length, -'.json'.length))
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// A name the board will print: a computer, a plan, a model, or the collector's one-line reason.
// The same refusals as the collector's gate - an @, a slash either way, a JWT's opening, an API
// key's prefix, a Bearer header - and two it cannot make on the collector's behalf, because the
// board does not know the owner's username or hostname: a uuid, and any unbroken run long enough to
// be a token. Anything that fails is NOT a name, and comes back as no name.
const NAME_CHARACTERS = /^[\p{L}\p{N} .,'’()+&:_-]+$/u
const NOT_A_NAME = /@|\/|\\|eyJ|sk-|bearer|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|\S{24,}/i
export function cleanUsageName(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text || text.length > USAGE_MAX_STRING) return null
  if (!NAME_CHARACTERS.test(text) || NOT_A_NAME.test(text)) return null
  return text
}

// A moment written the way the collector writes them, and only that way. Date.parse alone accepts
// "7 Oct", which is not a time anybody can be held to.
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/
const isoMs = (value) => (typeof value === 'string' && ISO_TIME.test(value) ? Date.parse(value) : NaN)

// Over 100 is a real reading - an account can go past its limit - and is shown as read, never
// clipped. Past the contract's ceiling it is not a percentage of anything.
const isPercent = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= USAGE_MAX_PERCENT
const isCount = (value) => Number.isInteger(value) && value >= 0 && value <= USAGE_MAX_COUNT

function usagePlan(raw) {
  if (isPlainObject(raw) && raw.status === 'found') {
    const name = cleanUsageName(raw.name)
    return name ? { status: 'found', name } : { status: 'unavailable', name: null }
  }
  if (!isPlainObject(raw) || raw.status === 'not found' || raw.status === undefined) return { status: 'not found', name: null }
  return { status: 'unavailable', name: null }
}

// One shape for "no reading", so the page never has to guess whether windows exists.
const noLimits = (status, why = null) => ({ status, source: null, readAt: null, why, windows: [] })

// A reading is shown whole or not at all. One window the board cannot read means the file is not
// what the board thinks it is, and showing the other two would present a partial answer as the
// whole one - the collector refuses a partial reading for the same reason.
function usageLimits(raw, now, takenMs) {
  if (!isPlainObject(raw) || raw.status === 'not found' || raw.status === undefined) return noLimits('not found')
  if (raw.status === 'unavailable') return noLimits('unavailable', cleanUsageName(raw.why))
  if (raw.status !== 'found') return noLimits('unavailable', UNKNOWN_SHAPE)
  if (!USAGE_SOURCES.includes(raw.source)) return noLimits('unavailable', UNKNOWN_SHAPE)
  const given = raw.windows
  if (!Array.isArray(given) || !given.length || given.length > USAGE_MAX_WINDOWS) return noLimits('unavailable', UNKNOWN_SHAPE)

  const windows = []
  for (const window of given) {
    if (!isPlainObject(window) || USAGE_WINDOW_REQUIRED.some((key) => !Object.hasOwn(window, key))) return noLimits('unavailable', UNKNOWN_SHAPE)
    if (!Object.hasOwn(USAGE_WINDOWS, window.kind) || !isPercent(window.usedPercent)) return noLimits('unavailable', UNKNOWN_SHAPE)
    // No reset time is a reading that cannot say when it resets, and the page says exactly that. A
    // reset time that is there and unreadable is a different thing: a file not in the known shape.
    const noReset = window.resetsAt === undefined || window.resetsAt === null
    const resetMs = noReset ? null : isoMs(window.resetsAt)
    if (!noReset && !Number.isFinite(resetMs)) return noLimits('unavailable', UNKNOWN_SHAPE)
    // A model name that is not plainly a name costs the name, not the reading around it.
    const model = window.kind === 'weekly_model' ? cleanUsageName(window.model) : null
    const label = window.kind === 'weekly_model'
      ? USAGE_WINDOWS.weekly_model.replace('{model}', model ?? 'one model')
      : USAGE_WINDOWS[window.kind]
    // Past its reset, the percentage describes a window that has closed. Today's figure is unknown
    // until the next reading, and saying 49% of a week that already ended is the worse answer.
    const resetSinceReading = resetMs !== null && resetMs <= now
    windows.push({
      kind: window.kind,
      label,
      usedPercent: resetSinceReading ? null : window.usedPercent,
      resetsAt: resetMs === null ? null : new Date(resetMs).toISOString(),
      resetSinceReading
    })
  }
  // When the limits were read, which a saved copy or a Codex log can put hours before the file. A
  // time in the future, or after the file was written, cannot be the moment of reading, so it is
  // dropped and the file's own time stands in for it.
  const readMs = isoMs(raw.readAt)
  const readTrusted = Number.isFinite(readMs) && readMs <= now && readMs <= takenMs + USAGE_READ_SLACK_MS
  return {
    status: 'found',
    source: raw.source,
    readAt: readTrusted ? new Date(readMs).toISOString() : null,
    why: null,
    windows
  }
}

// Claude Code's own logs, counted on the owner's computer. Only ever an estimate, and only ever a
// count - never a percentage, because the logs say what was done, not what the plan allows. The
// week is the seven days up to the reading; the collector keeps a few more so a timezone cannot cut
// one short, and the older ones are not this week's. More days than the contract allows is refused.
//
// The collector writes each day as the owner's LOCAL date, so the week is counted in that calendar
// too. Counting it in UTC put a reading taken near midnight a day off: in Tokyo at 5 in the morning
// the UTC date is still yesterday, and the week reached back one day too far.
const DAY_STRING = /^\d{4}-\d{2}-\d{2}$/
const TIMEZONE_NAME = /^(?:UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2})$/
const shiftDay = (day, by) => new Date(Date.parse(`${day}T00:00:00Z`) + by * 86400_000).toISOString().slice(0, 10)

// The reading's own date where the owner is: from the timezone the collector wrote, when it is one
// this runtime knows. It is only used here, never passed on to the page.
function localDayAt(ms, timezone) {
  if (typeof timezone !== 'string' || timezone.length > USAGE_MAX_STRING || !TIMEZONE_NAME.test(timezone)) return null
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(ms)).map((part) => [part.type, part.value]))
    const day = `${parts.year}-${parts.month}-${parts.day}`
    return DAY_STRING.test(day) ? day : null
  } catch {
    return null
  }
}

function usageActivity(raw, takenMs) {
  if (!isPlainObject(raw) || raw.status === 'not found' || raw.status === undefined) return { status: 'not found' }
  if (raw.status !== 'found' || raw.estimate !== true || !Array.isArray(raw.days) || raw.days.length > USAGE_MAX_ACTIVITY_DAYS) {
    return { status: 'unavailable' }
  }
  for (const day of raw.days) {
    if (!isPlainObject(day) || typeof day.day !== 'string' || !DAY_STRING.test(day.day)) return { status: 'unavailable' }
    if (!isCount(day.replies) || !isCount(day.sessions)) return { status: 'unavailable' }
  }
  // Without a timezone it can use, the newest day in the file is the reading's today - but only a day
  // somewhere on Earth could have reached by then, which is within a day of the UTC date. Otherwise
  // the UTC date stands in.
  const utcDay = new Date(takenMs).toISOString().slice(0, 10)
  const newest = raw.days.map((day) => day.day).filter((day) => day >= shiftDay(utcDay, -1) && day <= shiftDay(utcDay, 1)).sort().at(-1)
  const today = localDayAt(takenMs, raw.timezone) ?? newest ?? utcDay
  const since = shiftDay(today, -USAGE_ESTIMATE_DAYS)
  let replies = 0
  let sessions = 0
  let days = 0
  for (const day of raw.days) {
    // Inside the week, and never a day after the reading's own today.
    if (day.day <= since || day.day > today) continue
    replies += day.replies
    sessions += day.sessions
    days += 1
  }
  return { status: 'found', estimate: true, days, replies, sessions }
}

// One file, judged on its own. Every `why` is a finished sentence, for the reason shapeSnapshot
// gives: it is printed straight after a bold sentence.
function readUsageFile(body, now) {
  // No body is a file the tree listed that the handler could not fetch, or would not, because the
  // tree said it was too big. Either way it is a file that could not be used.
  if (typeof body !== 'string') return { usable: false, why: 'A usage file could not be fetched, or was too big to read.' }
  if (Buffer.byteLength(body, 'utf8') > USAGE_MAX_BYTES) return { usable: false, why: 'A usage file was too big to read.' }
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    return { usable: false, why: 'A usage file could not be read.' }
  }
  if (!isPlainObject(parsed)) return { usable: false, why: 'A usage file could not be read.' }
  if (parsed.schema !== USAGE_SCHEMA) {
    return { usable: false, why: 'A usage file was written in a format this board does not know.' }
  }
  const takenMs = isoMs(parsed.takenAt)
  if (!Number.isFinite(takenMs)) return { usable: false, why: 'A usage file does not say when it was taken.' }
  // A stamp in the future is wrong, not fresh - see shapeSnapshot.
  if (takenMs > now) return { usable: false, why: 'A usage file is stamped in the future, so its age cannot be trusted.' }

  const reading = {
    usable: true,
    takenMs,
    takenAt: new Date(takenMs).toISOString(),
    computer: cleanUsageName(parsed.computer),
    // Per service, how old its figures are: from when the limits were read, or from the file when
    // there is no reading time. Kept apart from the payload; pickService copies what the page needs.
    age: {}
  }
  for (const service of USAGE_SERVICES) {
    const raw = isPlainObject(parsed[service]) ? parsed[service] : {}
    const limits = usageLimits(raw.limits, now, takenMs)
    const readMs = limits.readAt ? Date.parse(limits.readAt) : takenMs
    const ageHours = (now - readMs) / 3600_000
    reading.age[service] = { readMs, ageHours, stale: ageHours > USAGE_STALE_AFTER_HOURS }
    reading[service] = {
      plan: usagePlan(raw.plan),
      limits,
      ...(service === 'claude' ? { activity: usageActivity(raw.activity, takenMs) } : {})
    }
  }
  return reading
}

// The freshest FOUND reading wins, and names the computer it came from. Freshest is by when the
// limits were read, not when the file was written: a newer file holding a six-hour-old saved copy
// does not beat an older file with a newer reading. A newer file that could not read the meter does
// not hide an older one that could - the older one shows, with its age. With no reading anywhere,
// the freshest file says why.
function pickService(readings, service) {
  // Two files holding the same reading time - the same Codex log, collected twice - go to the newer file.
  const newestFirst = [...readings].sort((a, b) => (b.age[service].readMs - a.age[service].readMs) || (b.takenMs - a.takenMs))
  const chosen = newestFirst.find((reading) => reading[service].limits.status === 'found') ?? newestFirst[0]
  return {
    computer: chosen.computer,
    takenAt: chosen.takenAt,
    ageHours: chosen.age[service].ageHours,
    stale: chosen.age[service].stale,
    ...chosen[service]
  }
}

// `found` is how many usage files the tree holds. Only the first five, in name order, are read: a
// file per computer, and nobody has more than five always-on computers - the rest are counted so the
// page can say some were left out rather than dropping them without a word. `skipped` is only ever
// those: a file among the five that could not be fetched, or was too big, is `unreadable`.
export function shapeUsage(files, now = Date.now(), found = null) {
  const given = Array.isArray(files) ? files : []
  const total = Math.max(found ?? 0, given.length)
  const toRead = [...given].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).slice(0, USAGE_MAX_FILES)
  const shaped = toRead.map(([, body]) => readUsageFile(body, now))
  const readings = shaped.filter((reading) => reading.usable)
  const base = { read: toRead.length, skipped: total - toRead.length, unreadable: shaped.length - readings.length }

  if (!toRead.length) {
    return { status: 'none', why: 'No usage reading has been taken yet.', ...base, claude: null, codex: null }
  }
  if (!readings.length) {
    return { status: 'unusable', why: shaped[0].why, ...base, claude: null, codex: null }
  }
  return {
    status: 'ok',
    why: null,
    ...base,
    claude: pickService(readings, 'claude'),
    codex: pickService(readings, 'codex')
  }
}

// ---------------------------------------------------------------------------------------------
// The Connections wall: what each computer has set up - its tools, the servers Claude Code can
// reach, and Codex's servers and plugins - read from the files the collector commits.
//
// The same rules as the usage meters, and for the same reasons: a reading with a moment attached,
// one file per computer in .agent-team/status/connections/, only the first five fetched, nothing
// over 64 KB fetched at all, missing, corrupt, undated and future files said to be unusable, and a
// file older than eight hours shown with its age rather than as current. Every name is checked
// again here and the output is BUILT from the keys the board knows, so a server's address, command
// or settings - which the collector never writes - cannot come through even if somebody pushes them.
//
// Found is not proved. A server can be listed, even connected, and still never have read the
// owner's own data back. "Proved" on this wall comes from the connections register alone, matched
// by name (matchProved below); nothing in this file can set it.
//
// KEEP IN SYNC with scripts/lib/status/connections-schema.mjs in agent-team-template.
// tests/fixtures/connections-parity.json is the shared contract, the same bytes in both repos, and
// tests/found.test.mjs holds these constants to it - including `expectedShape`, the exact shape
// this code must make from the contract's sample.
export const FOUND_SCHEMA = 'agent-status/connections/v1'
export const FOUND_FOLDER = '.agent-team/status/connections'
export const FOUND_COMPUTER_SLUG = /^[a-z0-9-]{1,32}$/
export const FOUND_STALE_AFTER_HOURS = 8
export const FOUND_MAX_FILES = 5
export const FOUND_MAX_BYTES = 65536
export const FOUND_MAX_COMPUTERS = 3
export const FOUND_STATUSES = ['found', 'not found', 'unavailable']
export const FOUND_CAPS = { claudeServers: 100, codexServers: 50, codexPlugins: 60, tools: 12 }
export const FOUND_TOOLS = ['Claude Code', 'Codex', 'Hermes', 'Node.js', 'Git', 'GitHub CLI', 'Claude app', 'ChatGPT app', 'Tailscale']
// Every state comes with the words the wall shows for it: a state is said, never only coloured.
export const FOUND_TOOL_STATES = { found: 'Found', 'not found': 'Not found', 'could not check': 'Could not check' }
export const FOUND_VERSION = /^\d+(\.\d+){1,3}$/
export const FOUND_MAX_VERSION_LENGTH = 32
export const FOUND_SCOPES = { user: 'Your server', plugin: 'Plugin server', 'claude.ai': 'claude.ai connector', other: 'Other' }
export const FOUND_TRANSPORTS = { local: 'Local program', web: 'Web service', unknown: 'Not known' }
export const FOUND_SERVER_STATES = {
  connected: 'Connected',
  'needs sign-in': 'Needs sign-in',
  failed: 'Failed',
  'waiting for approval': 'Waiting for approval',
  'not checked': 'Not checked',
  'seen before': 'Seen before',
  unknown: 'Unknown'
}
export const FOUND_LIVE_STATES = {
  checked: 'Checked live',
  'timed out': 'Live check took too long',
  'could not run': 'Live check could not run',
  'could not read': 'Live check answer not understood',
  'program not found': 'Claude Code not found'
}
export const FOUND_CODEX_STATES = { found: 'Found', 'turned off': 'Turned off' }
// How many the file may say it left out or did not list. Far past any real computer; a count past
// it is not a count of anything.
const FOUND_MAX_COUNT = 1e6

// The connection-name rule, the contract's own. It replaces cleanUsageName's for connection names
// only: `\S{24,}` refused `plugin:marketing:supermetrics` - 29 characters with no space - as if it
// were a token. Here a long stretch is measured between separators, so a plugin's full name is a
// name and a 40-character token is still not. Everything else is the same: the board's characters,
// no @ or slash either way, no JWT opening, no key prefix, no Bearer, no uuid. The collector also
// refuses the owner's username, computer name and home folder; the board cannot, because it does
// not know whose computer it was.
export const CONNECTION_NAME = {
  characters: /^[\p{L}\p{N} .,'’()+&:_-]+$/u,
  maxLength: 60,
  never: ['@', '/', '\\', 'eyJ', 'sk-', 'bearer'],
  neverIgnoresCase: true,
  uuid: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/,
  segmentSeparators: ':._- ',
  maxSegmentLength: 23
}

// Each character is compared one at a time, so nothing in the separator list is read as a range.
function longestSegment(value) {
  let longest = 0
  let current = 0
  for (const character of value) {
    current = CONNECTION_NAME.segmentSeparators.includes(character) ? 0 : current + 1
    longest = Math.max(longest, current)
  }
  return longest
}

export function isConnectionName(value) {
  if (typeof value !== 'string' || !value || value.length > CONNECTION_NAME.maxLength) return false
  if (value !== value.trim() || !CONNECTION_NAME.characters.test(value)) return false
  const lower = value.toLowerCase()
  if (CONNECTION_NAME.never.some((fragment) => lower.includes(fragment.toLowerCase()))) return false
  if (CONNECTION_NAME.uuid.test(lower)) return false
  return longestSegment(value) <= CONNECTION_NAME.maxSegmentLength
}

export function isFoundFile(path) {
  const prefix = `${FOUND_FOLDER}/`
  if (typeof path !== 'string' || !path.startsWith(prefix) || !path.endsWith('.json')) return false
  return FOUND_COMPUTER_SLUG.test(path.slice(prefix.length, -'.json'.length))
}

const isFoundCount = (value) => Number.isInteger(value) && value >= 0 && value <= FOUND_MAX_COUNT
// Own keys only: `toString` is not a state, however an object lookup would answer it.
const wordFor = (words, value) => (typeof value === 'string' && Object.hasOwn(words, value) ? words[value] : null)

// A block that found nothing carries its status and, when it is plainly a sentence, why.
const noBlock = (status, why = null) => ({ status, why: why === null ? null : cleanUsageName(why) })

// Shown whole or not at all, like a usage reading: a block whose own shape is wrong is not a list
// the board can vouch for, so none of it is shown. One bad ENTRY is different - it is dropped and
// counted in hidden, and the rest of the list stands, as the contract's rules say.
function blockStatus(raw) {
  if (!isPlainObject(raw) || raw.status === undefined || raw.status === 'not found') return noBlock('not found')
  if (raw.status === 'unavailable') return noBlock('unavailable', raw.why ?? null)
  if (raw.status !== 'found') return noBlock('unavailable')
  return null
}

// Keeps the entries that pass, in the file's order and only up to the cap. A dropped entry is
// counted in hidden; one past the cap is counted in more, so neither disappears without a word.
function keepEntries(given, cap, shape, keyOf) {
  const kept = []
  const seen = new Set()
  let hidden = 0
  let more = 0
  for (const raw of given) {
    const entry = isPlainObject(raw) ? shape(raw) : null
    if (!entry || seen.has(keyOf(entry))) {
      hidden += 1
      continue
    }
    seen.add(keyOf(entry))
    if (kept.length < cap) kept.push(entry)
    else more += 1
  }
  return { kept, hidden, more }
}

function claudeServer(raw) {
  if (!isConnectionName(raw.name)) return null
  const scopeLabel = wordFor(FOUND_SCOPES, raw.scope)
  const transportLabel = wordFor(FOUND_TRANSPORTS, raw.transport)
  const stateLabel = wordFor(FOUND_SERVER_STATES, raw.state)
  if (!scopeLabel || !transportLabel || !stateLabel) return null
  return { name: raw.name, scope: raw.scope, scopeLabel, transport: raw.transport, transportLabel, state: raw.state, stateLabel }
}

// Missing `enabled` is Found, as the contract says; anything but true, false or missing is not a
// switch the board can read.
function codexState(raw) {
  if (raw.enabled === undefined || raw.enabled === true) return 'found'
  return raw.enabled === false ? 'turned off' : null
}

function codexServer(raw) {
  const state = codexState(raw)
  if (!isConnectionName(raw.name) || !state) return null
  return { name: raw.name, state, label: FOUND_CODEX_STATES[state] }
}

function codexPlugin(raw) {
  const state = codexState(raw)
  if (!isConnectionName(raw.name) || !isConnectionName(raw.from) || !state) return null
  return { name: raw.name, from: raw.from, state, label: FOUND_CODEX_STATES[state] }
}

function foundClaude(raw) {
  const missing = blockStatus(raw)
  if (missing) return missing
  if (!Object.hasOwn(FOUND_LIVE_STATES, raw.live) || !Array.isArray(raw.servers)) return noBlock('unavailable')
  if (![raw.projectServers, raw.hidden, raw.more].every(isFoundCount)) return noBlock('unavailable')
  const servers = keepEntries(raw.servers, FOUND_CAPS.claudeServers, claudeServer, (server) => server.name)
  return {
    status: 'found',
    live: raw.live,
    liveLabel: FOUND_LIVE_STATES[raw.live],
    servers: servers.kept,
    projectServers: raw.projectServers,
    hidden: raw.hidden + servers.hidden,
    more: raw.more + servers.more
  }
}

function foundCodex(raw) {
  const missing = blockStatus(raw)
  if (missing) return missing
  if (!Array.isArray(raw.servers) || !Array.isArray(raw.plugins)) return noBlock('unavailable')
  if (![raw.hidden, raw.more].every(isFoundCount)) return noBlock('unavailable')
  const servers = keepEntries(raw.servers, FOUND_CAPS.codexServers, codexServer, (server) => server.name)
  // One plugin per name and source: `github` from two marketplaces is two plugins.
  const plugins = keepEntries(raw.plugins, FOUND_CAPS.codexPlugins, codexPlugin, (plugin) => JSON.stringify([plugin.name, plugin.from]))
  return {
    status: 'found',
    servers: servers.kept,
    plugins: plugins.kept,
    hidden: raw.hidden + servers.hidden + plugins.hidden,
    more: raw.more + servers.more + plugins.more
  }
}

// The tools are a fixed list of names, so one the board does not know is not shown and not
// counted: there is no "hidden tools" sentence a person could act on. A version is only ever a
// reading of a tool that was found, and only when it is plainly a version number.
function foundTool(raw) {
  const label = wordFor(FOUND_TOOL_STATES, raw.state)
  if (!FOUND_TOOLS.includes(raw.name) || !label) return null
  const version = raw.state === 'found' && typeof raw.version === 'string' &&
    raw.version.length <= FOUND_MAX_VERSION_LENGTH && FOUND_VERSION.test(raw.version) ? raw.version : null
  return { name: raw.name, state: raw.state, label, version }
}

// One status file's envelope, judged the same way for every part the collector writes: no body
// (not fetched, or the tree said it was too big), too big, not JSON, another schema, no time, or a
// time in the future. Every `why` is a finished sentence naming which kind of file it was.
function readStatusEnvelope(body, now, { schema, maxBytes, noun }) {
  if (typeof body !== 'string') return { usable: false, why: `A ${noun} file could not be fetched, or was too big to read.` }
  if (Buffer.byteLength(body, 'utf8') > maxBytes) return { usable: false, why: `A ${noun} file was too big to read.` }
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    return { usable: false, why: `A ${noun} file could not be read.` }
  }
  if (!isPlainObject(parsed)) return { usable: false, why: `A ${noun} file could not be read.` }
  if (parsed.schema !== schema) return { usable: false, why: `A ${noun} file was written in a format this board does not know.` }
  const takenMs = isoMs(parsed.takenAt)
  if (!Number.isFinite(takenMs)) return { usable: false, why: `A ${noun} file does not say when it was taken.` }
  if (takenMs > now) return { usable: false, why: `A ${noun} file is stamped in the future, so its age cannot be trusted.` }
  return { usable: true, parsed, takenMs }
}

// A time as the collector writes it: whole seconds, Z, no milliseconds.
const isoSeconds = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z')

// `found` is how many files of this kind the tree holds. Only the first five, in name order, are
// read, and the rest are counted in `skipped`. Of the files that could be used, the newest three
// are shown and the others counted in `notShown`: a card per computer is already a long screen on
// a phone, and nobody has more than three computers they set things up on.
function shapeStatusFiles(files, now, found, { maxFiles, maxComputers, noneWhy, read }) {
  const given = Array.isArray(files) ? files : []
  const total = Math.max(found ?? 0, given.length)
  const toRead = [...given].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).slice(0, maxFiles)
  const shaped = toRead.map(([, body]) => read(body, now))
  const readings = shaped.filter((reading) => reading.usable).sort((a, b) => b.takenMs - a.takenMs)
  const base = {
    read: toRead.length,
    skipped: total - toRead.length,
    unreadable: shaped.length - readings.length,
    notShown: Math.max(0, readings.length - maxComputers)
  }
  if (!toRead.length) return { status: 'none', why: noneWhy, ...base, computers: [] }
  if (!readings.length) return { status: 'unusable', why: shaped[0].why, ...base, computers: [] }
  return { status: 'ok', why: null, ...base, computers: readings.slice(0, maxComputers).map((reading) => reading.computer) }
}

function readFoundFile(body, now) {
  const envelope = readStatusEnvelope(body, now, { schema: FOUND_SCHEMA, maxBytes: FOUND_MAX_BYTES, noun: 'connections' })
  if (!envelope.usable) return envelope
  const { parsed, takenMs } = envelope
  const tools = Array.isArray(parsed.tools)
    ? keepEntries(parsed.tools, FOUND_CAPS.tools, foundTool, (tool) => tool.name).kept
    : []
  return {
    usable: true,
    takenMs,
    computer: {
      computer: cleanUsageName(parsed.computer),
      takenAt: isoSeconds(takenMs),
      freshness: now - takenMs > FOUND_STALE_AFTER_HOURS * 3600_000 ? 'stale' : 'fresh',
      tools,
      claude: foundClaude(parsed.claude),
      codex: foundCodex(parsed.codex)
    }
  }
}

export function shapeFound(files, now = Date.now(), found = null) {
  return shapeStatusFiles(files, now, found, {
    maxFiles: FOUND_MAX_FILES, maxComputers: FOUND_MAX_COMPUTERS, noneWhy: 'Nothing has been found yet.', read: readFoundFile
  })
}

// A name as matching compares it: trimmed and in lower case, and nothing else. Punctuation is kept,
// so `sl-ack` is not `slack`.
const provedKey = (name) => (typeof name === 'string' ? name.trim().toLowerCase() : '')

// The names one found entry can be proved by. Its whole name always. A claude.ai connector also by
// its name without the `claude.ai ` prefix its scope gives it - "Gmail" in the register badges
// "claude.ai Gmail". A plugin server only by its whole `plugin:<plugin>:<server>` name: cutting it
// down to its last part made "Slack" prove `plugin:slack:slack`, a different server from the
// connector somebody tested. Nothing is matched across scopes, and no part of a name is guessed at.
function provedNamesOf(entry, scope) {
  const whole = provedKey(entry.name)
  const names = [whole]
  if (scope === 'claude.ai' && whole.startsWith('claude.ai ')) names.push(whole.slice('claude.ai '.length))
  return names
}

// Adds `proved` to every found server and plugin: true only when the register has a PROVED entry
// - a verified date and a proof - whose name or slug is one of that entry's names above. Nothing
// the connections file says can make it true. A new object; the shape shapeFound made, which the
// contract fixes, is left alone.
export function matchProved(found, connections = []) {
  if (!found || !Array.isArray(found.computers)) return found
  const proved = new Set()
  for (const entry of Array.isArray(connections) ? connections : []) {
    if (entry?.proved !== true) continue
    for (const key of [provedKey(entry.name), provedKey(entry.slug)]) if (key) proved.add(key)
  }
  // Codex's servers and plugins carry no scope, so only their whole name counts.
  const mark = (entry) => ({ ...entry, proved: provedNamesOf(entry, entry.scope).some((name) => proved.has(name)) })
  return {
    ...found,
    computers: found.computers.map((computer) => ({
      ...computer,
      claude: computer.claude?.status === 'found'
        ? { ...computer.claude, servers: computer.claude.servers.map(mark) }
        : computer.claude,
      codex: computer.codex?.status === 'found'
        ? { ...computer.codex, servers: computer.codex.servers.map(mark), plugins: computer.codex.plugins.map(mark) }
        : computer.codex
    }))
  }
}

// ---------------------------------------------------------------------------------------------
// The Hermes card: Hermes's version, whether it is running, and each profile's model, skills and
// last week - read from .agent-team/status/hermes/<computer>.json on the Connections wall's terms
// (five files, 64 KB, unusable said in a sentence, stale after eight hours, newest three computers).
//
// Running is worked out HERE, from the times in the file, by the contract's alive rule: the gateway
// says running and stamped its own file within five minutes of the check, or any profile's
// scheduler did. A file never says whether Hermes is alive, and a yes/no flag somebody adds is never
// read - the output is built from known keys only, so it cannot be. The collector never runs
// `hermes`, and nothing Hermes keeps beside the fields read (argv, pid, base_url, chats, titles,
// memory) has a key here to arrive through.
//
// KEEP IN SYNC with scripts/lib/status/hermes-schema.mjs in agent-team-template.
// tests/fixtures/hermes-parity.json is the shared contract, the same bytes in both repos, and
// tests/hermes.test.mjs holds the board to it, `expectedShape` and every alive example included.
export const HERMES_SCHEMA = 'agent-status/hermes/v1'
export const HERMES_FOLDER = '.agent-team/status/hermes'
export const HERMES_COMPUTER_SLUG = /^[a-z0-9-]{1,32}$/
export const HERMES_STALE_AFTER_HOURS = 8
export const HERMES_MAX_FILES = 5
export const HERMES_MAX_BYTES = 65536
export const HERMES_MAX_COMPUTERS = 3
export const HERMES_STATUSES = ['found', 'not found', 'unavailable']
export const HERMES_CAPS = { profiles: 12 }
export const HERMES_DEFAULT_PROFILE = 'default'
export const HERMES_SESSION_DAYS = 7
export const HERMES_GATEWAY_STATES = {
  starting: 'Starting',
  running: 'Running',
  degraded: 'Running with problems',
  stopped: 'Stopped',
  startup_failed: 'Failed to start',
  unknown: 'Unknown'
}
export const HERMES_ALIVE = {
  withinSeconds: 300,
  gatewayStates: ['running'],
  words: { running: 'Running', down: 'Down at last check', stale: 'Not checked for {hours} h' }
}
export const HERMES_WORDS = {
  install: {
    version: 'Hermes {version}',
    noVersion: 'Hermes, version not known',
    updateAvailable: '{label} - update available',
    upToDate: '{label} - up to date',
    'not found': 'Hermes not found',
    unavailable: 'Hermes could not be read'
  },
  model: { both: '{model} via {provider}', modelOnly: '{model}', none: 'Model not known' },
  sessions: { 'not found': 'No sessions recorded', unavailable: 'Not available ({why})' }
}
// Hermes's own profile id rule, with the connection-name rule on top.
export const HERMES_PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
const HERMES_MAX_COUNT = 1e7

const fillWords = (template, values) => template.replace(/\{(\w+)\}/g, (_, key) => String(values[key]))

export const isProfileName = (value) => typeof value === 'string' && HERMES_PROFILE_NAME.test(value) && isConnectionName(value)

// The collector writes only the last segment after a slash, so a model with a slash in it is not
// one the collector wrote. What arrives is held to the connection-name rule as it is.
export const hermesModelName = (value) => (isConnectionName(value) ? value : null)

export function isHermesFile(path) {
  const prefix = `${HERMES_FOLDER}/`
  if (typeof path !== 'string' || !path.startsWith(prefix) || !path.endsWith('.json')) return false
  return HERMES_COMPUTER_SLUG.test(path.slice(prefix.length, -'.json'.length))
}

const isHermesCount = (value) => Number.isInteger(value) && value >= 0 && value <= HERMES_MAX_COUNT
// A time the board can date anything by, as the collector writes it; anything else is no time.
const hermesTime = (value) => {
  const ms = isoMs(value)
  return Number.isFinite(ms) ? isoSeconds(ms) : null
}
// found, not found, or - for anything else, including a status the board does not know - unavailable.
const hermesStatus = (raw) => {
  if (!isPlainObject(raw) || raw.status === undefined || raw.status === 'not found') return 'not found'
  return raw.status === 'found' ? 'found' : 'unavailable'
}

function hermesInstall(raw) {
  const status = hermesStatus(raw)
  if (status !== 'found') return { status, version: null, updateAvailable: null, label: HERMES_WORDS.install[status] }
  const version = typeof raw.version === 'string' && raw.version.length <= FOUND_MAX_VERSION_LENGTH && FOUND_VERSION.test(raw.version)
    ? raw.version : null
  const updateAvailable = typeof raw.updateAvailable === 'boolean' ? raw.updateAvailable : null
  const base = version ? fillWords(HERMES_WORDS.install.version, { version }) : HERMES_WORDS.install.noVersion
  const label = updateAvailable === true ? fillWords(HERMES_WORDS.install.updateAvailable, { label: base })
    : updateAvailable === false ? fillWords(HERMES_WORDS.install.upToDate, { label: base }) : base
  return { status, version, updateAvailable, label }
}

function hermesGateway(raw) {
  const status = hermesStatus(raw)
  const none = (which) => ({ status: which, state: null, stateLabel: null, beatAt: null })
  if (status !== 'found') return none(status)
  // A state the contract does not name is not a gateway the board can describe.
  if (typeof raw.state !== 'string' || !Object.hasOwn(HERMES_GATEWAY_STATES, raw.state)) return none('unavailable')
  return { status, state: raw.state, stateLabel: HERMES_GATEWAY_STATES[raw.state], beatAt: hermesTime(raw.beatAt) }
}

function hermesSessions(raw) {
  const status = hermesStatus(raw)
  const unavailable = (why) => ({
    status: 'unavailable',
    label: why ? fillWords(HERMES_WORDS.sessions.unavailable, { why }) : HERMES_WORDS.sessions.unavailable.replace(/\s*\(\{why\}\)/, '')
  })
  if (status === 'not found') return { status, label: HERMES_WORDS.sessions['not found'] }
  if (status === 'unavailable') return unavailable(raw.why === undefined ? null : cleanUsageName(raw.why))
  if (raw.days !== HERMES_SESSION_DAYS || !isHermesCount(raw.conversations) || !isHermesCount(raw.scheduled)) return unavailable(null)
  return { status, days: raw.days, conversations: raw.conversations, scheduled: raw.scheduled, lastActiveAt: hermesTime(raw.lastActiveAt) }
}

function hermesProfile(raw) {
  if (!isProfileName(raw.name)) return null
  const model = hermesModelName(raw.model)
  // "x via provider" needs an x, and a provider that is plainly a name.
  const provider = model && isConnectionName(raw.provider) ? raw.provider : null
  const modelLabel = model && provider ? fillWords(HERMES_WORDS.model.both, { model, provider })
    : model ? fillWords(HERMES_WORDS.model.modelOnly, { model }) : HERMES_WORDS.model.none
  const skills = hermesStatus(raw.skills) === 'found' && isHermesCount(raw.skills.count) ? raw.skills.count : null
  return {
    name: raw.name,
    model,
    provider,
    modelLabel,
    skills,
    sessions: hermesSessions(raw.sessions),
    schedulerBeatAt: hermesStatus(raw.scheduler) === 'found' ? hermesTime(raw.scheduler.beatAt) : null
  }
}

function hermesProfiles(raw) {
  const status = hermesStatus(raw)
  const none = (which) => ({ status: which, items: [], hidden: 0, more: 0 })
  if (status !== 'found') return none(status)
  if (!Array.isArray(raw.items) || !isHermesCount(raw.hidden) || !isHermesCount(raw.more)) return none('unavailable')
  // The file's order stands - default first, as the collector writes it. A name the board refuses,
  // or one listed twice, is counted in hidden; past twelve, in more.
  const kept = keepEntries(raw.items, HERMES_CAPS.profiles, hermesProfile, (item) => item.name)
  return { status, items: kept.kept, hidden: raw.hidden + kept.hidden, more: raw.more + kept.more }
}

// The contract's alive rule, from the times the board itself accepted: the gateway in a running
// state with a stamp within five minutes of the check, either way, or any profile's scheduler beat
// within the same window.
function hermesAlive(takenMs, gateway, profiles) {
  const near = (iso) => iso !== null && Math.abs(Date.parse(iso) - takenMs) <= HERMES_ALIVE.withinSeconds * 1000
  if (gateway.status === 'found' && HERMES_ALIVE.gatewayStates.includes(gateway.state) && near(gateway.beatAt)) return true
  return profiles.items.some((item) => near(item.schedulerBeatAt))
}

function readHermesFile(body, now) {
  const envelope = readStatusEnvelope(body, now, { schema: HERMES_SCHEMA, maxBytes: HERMES_MAX_BYTES, noun: 'Hermes' })
  if (!envelope.usable) return envelope
  const { parsed, takenMs } = envelope
  const ageMs = now - takenMs
  const stale = ageMs > HERMES_STALE_AFTER_HOURS * 3600_000
  const install = hermesInstall(parsed.install)
  const gateway = hermesGateway(parsed.gateway)
  const profiles = hermesProfiles(parsed.profiles)
  // An old reading is neither Running nor Down: it is how long since anybody looked.
  const alive = stale ? 'stale' : hermesAlive(takenMs, gateway, profiles) ? 'running' : 'down'
  return {
    usable: true,
    takenMs,
    computer: {
      computer: cleanUsageName(parsed.computer),
      takenAt: isoSeconds(takenMs),
      freshness: stale ? 'stale' : 'fresh',
      alive,
      aliveLabel: fillWords(HERMES_ALIVE.words[alive], { hours: Math.floor(ageMs / 3600_000) }),
      install,
      gateway,
      profiles
    }
  }
}

export function shapeHermes(files, now = Date.now(), found = null) {
  return shapeStatusFiles(files, now, found, {
    maxFiles: HERMES_MAX_FILES, maxComputers: HERMES_MAX_COMPUTERS, noneWhy: 'No Hermes reading has been taken yet.', read: readHermesFile
  })
}

// ---------------------------------------------------------------------------------------------
// What the owner pays: `subscriptions:` in stack.yml, written by /onboard or by hand, as
// `{ name, service, price, currency, per }`.
//
// One total per currency, never converted - there is no exchange rate the board could honestly
// use, and a wrong one would be printed as fact. A yearly price counts as a twelfth a month, and the
// page says so. A line with no usable price is listed and LEFT OUT of the total: counting it as
// nothing would make the total a claim that it is free. Money is added in cents, so 8.25 and 10.10
// make 18.35 and not 18.349999999999998.
//
// The names are printed on a board that can be public, so they pass the same test as the usage
// names. A line whose name fails is dropped whole, price and all, and counted - a total made of
// lines nobody can see is not a total anybody can check.
const PRICE = /^\d+(?:\.\d{1,2})?$/
const CURRENCY_CODE = /^[A-Z]{3}$/
const SERVICE = /^[a-z0-9-]{1,32}$/
const MAX_PRICE_CENTS = 1e9
// Which usage meter reads the plan behind a subscription. Codex runs on a ChatGPT plan, so any of
// the three words names the same account.
const METER_FOR_SERVICE = { claude: 'claude', anthropic: 'claude', codex: 'codex', chatgpt: 'codex', openai: 'codex' }

function priceCents(value) {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value.trim() : ''
  if (!PRICE.test(text)) return null
  const cents = Math.round(Number(text) * 100)
  return cents <= MAX_PRICE_CENTS ? cents : null
}

// The family word is the first word of the plan the collector read - "Max" of "Max 20x", "Pro" of
// "Pro". A subscription called "Claude Max" is the same family as "Max 5x" or "Max 20x", and the
// board cannot tell those apart from a name, so it does not try. "Claude Pro" against "Max 20x" is a
// real disagreement between what the owner wrote and what the account says, and that is flagged.
const wordsOf = (text) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)

function planReadFor(service, usage) {
  const meter = METER_FOR_SERVICE[service]
  const plan = meter ? usage?.[meter]?.plan : null
  if (plan?.status !== 'found' || typeof plan.name !== 'string') return null
  // The collector's word for a tier it could not name. That is not a plan, so nothing to compare.
  return /^not recognised$/i.test(plan.name) ? null : plan.name
}

export function shapeSubscriptions(doc, usage = null) {
  const rows = Array.isArray(doc?.subscriptions) ? doc.subscriptions : []
  const items = []
  const totals = new Map()
  let unreadable = 0
  for (const row of rows) {
    const name = isPlainObject(row) ? cleanUsageName(row.name) : null
    if (!name) {
      unreadable += 1
      continue
    }
    const serviceText = typeof row.service === 'string' ? row.service.trim().toLowerCase() : ''
    const service = SERVICE.test(serviceText) ? serviceText : null
    const cents = priceCents(row.price)
    const currency = typeof row.currency === 'string' && CURRENCY_CODE.test(row.currency.trim()) ? row.currency.trim() : null
    const per = row.per === 'month' || row.per === 'year' ? row.per : null
    const monthlyCents = cents !== null && currency && per ? (per === 'year' ? Math.round(cents / 12) : cents) : null
    if (monthlyCents !== null) totals.set(currency, (totals.get(currency) ?? 0) + monthlyCents)
    const planRead = service ? planReadFor(service, usage) : null
    items.push({
      name,
      service,
      price: cents === null ? null : cents / 100,
      currency,
      per,
      monthly: monthlyCents === null ? null : monthlyCents / 100,
      planRead,
      mismatch: planRead !== null && !wordsOf(name).includes(wordsOf(planRead)[0])
    })
  }
  return {
    items,
    totals: [...totals.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, cents]) => ({ currency, monthly: cents / 100 })),
    unpriced: items.filter((item) => item.monthly === null).length,
    unreadable
  }
}

export function routineFor(workflow, routines) {
  const wanted = routineNameKey(workflow?.name) || routineNameKey(workflow?.slug)
  if (!wanted) return null
  return (routines ?? []).find((routine) => routineNameKey(routine?.name) === wanted) ?? null
}

// `routinesKnown` is the difference between "nothing rings" and "I have no idea what rings".
//
// Without it an unusable snapshot gives an empty routine list, every armed job comes back
// `declared`, and the board asserts a pile of wishes it has no evidence for - while the banner
// above it says the routines are unknown. Two answers on one screen, and the confident one wrong.
export function armStateFor(workflow, routines, routinesKnown = true) {
  if (!routinesKnown) return workflow?.armed === true ? 'unknown' : 'off'
  const ringing = Boolean(routineFor(workflow, routines))
  if (workflow?.armed !== true) return ringing ? 'unapproved' : 'off'
  return ringing ? 'armed' : 'declared'
}

// Mirrors validateArming in the team repo. Without it the board silently read `armed: "yes"` as
// OFF and explained nothing - a student who typed the wrong kind of true saw a job quietly not
// running and no reason anywhere. The template refuses all three of these; the board should at
// least be able to say so.
//
// KEEP IN SYNC with scripts/lib/arm.mjs `validateArming` in the team repo. Mirrored by hand, not
// imported - there is no import path between a student's repo and a deployed app. The shared
// contract is tests/fixtures/arming-parity.json, the same bytes in both repos, and both sides run
// it. Until that fixture existed this function had drifted twice with nothing to catch it.
function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function armingProblems(workflow) {
  const problems = []
  const name = workflow?.name || workflow?.slug || 'a workflow'
  const armed = workflow?.armedRaw
  const schedule = textOf(workflow?.schedule)

  if (armed !== undefined && typeof armed !== 'boolean') {
    problems.push(`${name}: trigger.armed must be true or false`)
  }

  // Some jobs have no clock. A webhook is fired by an inbound request; a `fire: true` job is fired
  // by a button on this board, which is the same registered trigger URL a webhook posts to -
  // api/fire.js posts to exactly that. Neither is ever "off" in the sense these rules mean, and
  // neither has a schedule to declare.
  //
  // The board had NO exemption at all, not even the webhook one the template shipped first, and
  // line ~258 was not even passing it the fields it would need to have one. So a student who
  // wired Lesson 10's webhook - or Lesson 12's button - read PASS from check:arming and a red
  // problem on this board about the same job. Two answers on one screen, which is the exact
  // failure this file's own comments say it exists to catch.
  const clockless = schedule === '' && (workflow?.webhook === true || workflow?.fire === true)

  if (armed !== true && !clockless && !textOf(workflow?.reason)) {
    problems.push(`${name}: is not armed and carries no reason - say what would have to change for it to be worth a run`)
  }
  if (armed === true && !clockless && schedule === '') {
    problems.push(`${name}: is armed but declares no schedule - there is nothing for a routine to fire on`)
  }
  return problems
}

export function shapeWorkflows(workflowFiles, runs, known, now = Date.now(), routines = [], routinesKnown = true) {
  return workflowFiles
    .map(([path, body]) => {
      const slug = path.split('/').pop().replace(/\.ya?ml$/, '')
      const data = parseWorkflow(body ?? '')
      const workflow = { ...data, steps: normaliseSteps(data.steps) }
      const problems = validateWorkflow(workflow, known)
      const mine = runs.filter((run) => run.workflow === slug || run.workflow === workflow.name)
      const last = mine[0] ?? null
      const schedule =
        workflow.trigger && typeof workflow.trigger === 'object' && !Array.isArray(workflow.trigger)
          ? workflow.trigger.schedule ?? null
          : null
      // Never-run is its own state, not "quiet": a fresh clone ships nine scheduled
      // workflows, and greeting a new owner with five alarms would teach them to ignore
      // the one alarm that matters later.
      const quiet = last !== null && schedule !== null && isGoneQuiet(schedule, last.started_at, now)

      let state = 'never-run'
      if (problems.length) state = 'attention'
      else if (last && (last.status === 'failed' || last.status === 'blocked')) state = 'attention'
      else if (quiet) state = 'quiet'
      else if (last) state = 'working'

      const name = typeof workflow.name === 'string' ? workflow.name : slug
      const armed = workflow.trigger?.armed === true
      const reason = typeof workflow.trigger?.reason === 'string' ? workflow.trigger.reason.trim() : null
      const routine = routineFor({ name, slug }, routines)
      const arm = armStateFor({ name, slug, armed }, routines, routinesKnown)

      return {
        slug,
        path,
        name,
        owner: typeof workflow.owner === 'string' ? workflow.owner : null,
        steps: Array.isArray(workflow.steps) ? workflow.steps : [],
        runner: workflow.runner ?? 'routine',
        schedule,
        armed,
        // The raw value, so the board can tell `armed: "yes"` from an absent field the way the
        // template does. `armed` above is the coerced boolean the rest of the page uses.
        armedRaw: workflow.trigger?.armed,
        arm,
        reason: reason || null,
        routineId: arm === 'armed' || arm === 'unapproved' ? (routine?.id ?? null) : null,
        fire: workflow.trigger?.fire === true,
        webhook: workflow.trigger?.webhook === true,
        output: typeof workflow.output === 'string' ? workflow.output : null,
        problems: [...problems, ...armingProblems({ name, slug, schedule, reason, armedRaw: workflow.trigger?.armed, fire: workflow.trigger?.fire === true, webhook: workflow.trigger?.webhook === true })],
        lastRun: last
          ? { started_at: last.started_at, status: last.status, summary: last.summary ?? '', session_url: last.session_url ?? null }
          : null,
        // ONLY when something actually rings. This one expression is the bug the whole brick is
        // about: it used to read `schedule ? nextRunAt(...) : null`, so every file with a
        // `schedule:` got a confident next-run time whether or not any alarm clock existed. Nine
        // jobs said "next in 14h" while one routine existed.
        nextRun: arm === 'armed' && schedule ? nextRunAt(schedule, { now, lastRun: last?.started_at ?? null }) : null,
        state
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

// Everything the team can reach, from connections/register.yml. The register's own rule is
// that a line without a `verified` date and a `proof` is a claim, not a connection — so that
// distinction is carried here rather than flattened, and the rail shows it.
//
// This function exists because the Access rung used to read `runtimes.length > 0 ||
// chosenTiles.length > 0` while its own failure line said "No connections or runtimes
// registered yet". It named a file nobody read. A student could connect Gmail, run /connect,
// get a proved entry written into the register, and still be told Access had not happened.
export function shapeConnections(register) {
  const entries = Array.isArray(register?.connections) ? register.connections : []
  return entries
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => {
      const verified = typeof entry.verified === 'string' ? entry.verified : null
      const proof = typeof entry.proof === 'string' && entry.proof.trim() ? entry.proof : null
      return {
        name: String(entry.name ?? entry.slug ?? 'unnamed'),
        slug: typeof entry.slug === 'string' ? entry.slug : null,
        kind: String(entry.kind ?? 'connector'),
        account: typeof entry.account === 'string' ? entry.account : null,
        scopes: Array.isArray(entry.scopes) ? entry.scopes.map(String) : [],
        usedBy: Array.isArray(entry.used_by) ? entry.used_by.map(String) : [],
        verified,
        proof,
        // Proved means it answered with the owner's own data and someone wrote down what it
        // returned. Both halves, or it is a claim.
        proved: Boolean(verified && proof)
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

// A runtime's url is typed into runtimes.yml in the team repo and ends up in an href. Escaping the
// text stops a quote breaking out of the attribute; it does nothing about the scheme, and the page
// allows inline scripts, so `javascript:` ran on click. new URL() strips the leading whitespace and
// control characters a browser would also ignore, so a disguised scheme is judged as the browser
// will read it. Credentials are refused because a link on the board should not carry a password
// into history and the Referer header.
function safeRuntimeUrl(value) {
  if (typeof value !== 'string') return null
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username || parsed.password) return null
  return parsed.href
}

// A runtime's own heartbeat window, as people actually write it. yaml-lite hands back a bare 200 as
// a number, but it does not know inline comments or quotes round a number: `200 # every 3 hours`
// and `"200"` both arrive as strings. Those used to fall back to 30 without a word, so a Hermes
// entry written with a helpful comment read Silent between every run. yaml-lite is kept in lockstep
// with the template's own parser, so the fix is here, for this one field: a comment (a # after a
// space) is dropped, then one pair of matching quotes, and what is left must be digits only. Any
// other value - words, a decimal, a number outside 5-1440 - is not understood: 30 is used, and the
// runtime row says so rather than leaving the owner to wonder why their setting did nothing.
function staleAfterFrom(value) {
  const fallback = { minutes: HEARTBEAT_STALE_AFTER_MINUTES, understood: false }
  if (value === undefined) return { minutes: HEARTBEAT_STALE_AFTER_MINUTES, understood: true }
  let minutes = null
  if (typeof value === 'number') minutes = value
  else if (typeof value === 'string') {
    const text = value.replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2').trim()
    if (/^\d{1,5}$/.test(text)) minutes = Number(text)
  }
  return Number.isInteger(minutes) && minutes >= HEARTBEAT_STALE_MIN_MINUTES && minutes <= HEARTBEAT_STALE_MAX_MINUTES
    ? { minutes, understood: true }
    : fallback
}

export function shapeRuntimes(registry, heartbeats, now = Date.now()) {
  const entries = Array.isArray(registry?.runtimes) ? registry.runtimes : []
  return entries
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => {
      const beat = entry.heartbeat ? heartbeats[entry.heartbeat] ?? null : null
      const { minutes: staleAfterMinutes, understood: staleAfterUnderstood } = staleAfterFrom(entry.stale_after_minutes)
      const { status, lastBeat } = entry.heartbeat
        ? heartbeatStatus(beat, now, staleAfterMinutes)
        : { status: 'no-heartbeat', lastBeat: null }
      return {
        name: String(entry.name ?? 'unnamed'),
        kind: String(entry.kind ?? 'runtime'),
        url: safeRuntimeUrl(entry.url),
        heartbeat: entry.heartbeat ?? null,
        status,
        lastBeat,
        staleAfterMinutes,
        staleAfterUnderstood
      }
    })
}

// Every skill in the repo, with its one-line description and which workflows call it.
// A skill no workflow uses is not wrong — it is there for sessions — but the owner should
// be able to see that at a glance.
//
// `stalled` is the subset of those jobs that cannot run as written, because the agent that owns
// them is switched off. For somebody with a job rather than a business that is not a corner case:
// four of this repo's skills are listed as a step in exactly one job, and that job is one of the
// two owned by sales and customer-service. The screen said "used by weekly-review" and left him to
// cross-reference another screen to learn that weekly-review never fires.
//
// What it does NOT mean is that the skill is dead. Anything here can still be asked for by name -
// which is what the other group on this screen says about itself - so the claim has to stay narrow:
// the JOB cannot run, not the skill cannot be used.
export function shapeSkills(skillFiles, workflows = []) {
  return skillFiles
    .map(([path, source]) => {
      const slug = path.split('/').at(-2)
      const data = parseFrontmatter(source ?? '')
      const users = workflows.filter((workflow) => (workflow.steps ?? []).includes(slug))
      return {
        slug,
        path,
        description: data.description ?? '',
        usedBy: users.map((workflow) => workflow.slug),
        stalled: users.filter((workflow) => workflow.ownerSwitchedOff).map((workflow) => workflow.slug),
        // The AGENTS behind those jobs, deduplicated, so the line can name what he has to look at
        // rather than counting. Review caught the version that could not: it said "the owner is
        // switched off" for any number of jobs, which invents a single shared owner when two dead
        // jobs can have two different ones - and this repo's two switchable agents are exactly that
        // case. Naming them removes the count from the sentence entirely, and two jobs owned by the
        // same agent correctly say that agent once.
        stalledOwners: [
          ...new Set(
            users
              .filter((workflow) => workflow.ownerSwitchedOff && typeof workflow.owner === 'string' && workflow.owner)
              .map((workflow) => workflow.owner)
          )
        ]
      }
    })
    .sort((a, b) => a.slug.localeCompare(b.slug))
}

// The starter stack from stack.yml. A plugin entry can only be verified on the owner's
// machine, so the dashboard shows how to check rather than pretending to know. A skill
// entry ships in the repo, so "present" is a real fact the tree can answer.
export function shapeStack(doc, paths = []) {
  const entries = Array.isArray(doc?.stack) ? doc.stack : []
  return entries
    .filter((entry) => entry && typeof entry.name === 'string')
    .map((entry) => {
      const source = entry.skill ? 'repo' : 'plugin'
      const present = source === 'repo' ? paths.includes(entry.skill) : null
      return {
        name: entry.name,
        source,
        plugin: entry.plugin ?? null,
        skill: entry.skill ?? null,
        present,
        gives: entry.gives ?? '',
        why: entry.why ?? '',
        verify: entry.verify ?? ''
      }
    })
}

export function shapeMemory(paths, treeSizes = {}) {
  const files = paths
    .filter((path) => path.endsWith('.md'))
    .filter((path) => !path.startsWith('.') && !path.includes('node_modules/'))
    .slice(0, MAX_MEMORY_FILES)
    .map((path) => ({ path, size: treeSizes[path] ?? null }))
  const indexes = files
    .map((file) => file.path)
    .filter((path) => /(^|\/)(INDEX|index|README|readme)\.md$/.test(path))
  return { files, indexes, truncated: files.length === MAX_MEMORY_FILES }
}

// The six rungs of the Hiring Ladder - one per stage the course teaches - each judged from
// what the repo actually contains. This said "five" and returned five while the course named
// six everywhere, so Improvement was taught, drilled in pre-work, and invisible on the board.
// These are approximations of the executable rung tests that live in the template — the
// dashboard can only see git, so anything needing a live probe is judged by its footprint.
// The onboarding installer commits its state file into the student's repo. When it is
// there, it is the truth about how far setup actually got — the repo-shape heuristics
// below exist only for repos that never ran /onboard.
export function parseOnboardingState(source) {
  if (typeof source !== 'string' || !source.trim()) return null
  const stages = {}
  const rows = source.matchAll(/^\|\s*\d+\s*\|[^|]+\|\s*\d\s*·\s*([A-Za-z]+)\s*\|\s*([a-z-]+)\s*\|/gm)
  let sawRow = false
  for (const row of rows) {
    sawRow = true
    const stage = row[1].toLowerCase()
    const done = row[2] === 'done' || row[2] === 'skipped'
    stages[stage] = (stages[stage] ?? true) && done
  }
  return sawRow ? stages : null
}

// Name what is actually reachable rather than saying "Tools connected", so a passing rung
// still tells the owner which tools it is passing on.
function accessDetail(provedConnections, runtimes) {
  const parts = []
  if (provedConnections.length) {
    parts.push(provedConnections.length === 1
      ? `${provedConnections[0].name} connected and proved`
      : `${provedConnections.length} connections proved`)
  }
  if (runtimes.length) parts.push(`${runtimes.length} runtime${runtimes.length === 1 ? '' : 's'}`)
  return parts.length ? parts.join(' · ') : 'Tools connected'
}

export function shapeSetup({ brain, skills, workflows, runtimes, tiles, runs, connections = [], verdicts = 0, onboarding = null, now = Date.now() }) {
  // The Shift rung is behavioral either way: it asks whether anything actually ran on a
  // schedule this week, which no install record can answer.
  const shiftOk = workflows.some(
    (workflow) =>
      workflow.schedule !== null &&
      workflow.lastRun &&
      (daysSince(workflow.lastRun.started_at, now) ?? 99) <= 7
  ) || runs.some((run) => run.trigger === 'schedule' && (daysSince(run.started_at, now) ?? 99) <= 7)

  // A connection only counts once it has answered with the owner's own data. An unproved
  // line in the register is a claim, and claims must not light a rung. Computed before the
  // onboarding branch because BOTH rung paths need it -- the first version of this fix only
  // reached the heuristic fallback, which is the path a student never takes.
  const provedConnections = connections.filter((connection) => connection.proved)

  if (onboarding) {
    const pass = (stage) => onboarding[stage] === true
    const detail = (stage, doneText) => pass(stage) ? doneText : 'Not finished in /onboard yet'
    // Rung 4 is the course's Workflows stage. The install record decides pass/fail; the
    // behavioral signal (did anything actually run this week) rides along in the detail.
    const workflowsDetail = pass('workflows')
      ? shiftOk ? 'Workflows built — something ran on a schedule this week' : 'Workflows built — nothing has run on a schedule in the last 7 days'
      : 'Not finished in /onboard yet'
    // Rung 2 is Access, and it takes the same shape. A record saying Access is done while
    // connections/register.yml is empty is the difference between a tool that was connected
    // and one that was ticked off, so it says which.
    const accessOnboardDetail = pass('access')
      ? (provedConnections.length || runtimes.length)
        ? accessDetail(provedConnections, runtimes)
        : 'Marked done in /onboard, but nothing is registered in connections/register.yml'
      : 'Not finished in /onboard yet'
    return [
      { rung: 'brief', label: 'Brief', pass: pass('brief'), detail: detail('brief', 'Business brain filled in') },
      { rung: 'access', label: 'Access', pass: pass('access'), detail: accessOnboardDetail },
      { rung: 'training', label: 'Training', pass: pass('training'), detail: detail('training', 'Skills built and verified') },
      { rung: 'workflows', label: 'Workflows', pass: pass('workflows'), detail: workflowsDetail },
      { rung: 'oversight', label: 'Oversight', pass: pass('oversight'), detail: detail('oversight', 'Dashboard deployed, dispatched from the phone') },
      { rung: 'improvement', label: 'Improvement', pass: pass('improvement'), detail: detail('improvement', 'Verdicts filed, and the rules they became') }
    ]
  }

  // Heuristic fallback — but the template now ships staffed, so "skills exist" and
  // "a fire workflow exists" are true in a fresh clone and prove nothing. Gate the
  // achievement-shaped rungs on evidence somebody actually used the repo.
  const used = runs.length > 0
  const briefOk =
    brain.length > 0 && brain.every((file) => file.present && file.missing.length === 0)

  const chosenTiles = Array.isArray(tiles?.chosen) ? tiles.chosen : []
  const accessOk = provedConnections.length > 0 || runtimes.length > 0 || chosenTiles.length > 0

  const trainingOk = used && skills.length > 0

  const oversightOk = used && workflows.some((workflow) => workflow.fire)

  // Improvement is the one stage no repo shape can fake: a verdict only exists because the
  // owner said what they did with a piece. Lesson 18.
  const improvementOk = verdicts > 0

  return [
    { rung: 'brief', label: 'Brief', pass: briefOk, detail: briefOk ? 'Business brain filled in' : 'Business brain files missing or still have empty fields' },
    { rung: 'access', label: 'Access', pass: accessOk, detail: accessOk ? accessDetail(provedConnections, runtimes) : 'No connections or runtimes registered yet' },
    { rung: 'training', label: 'Training', pass: trainingOk, detail: trainingOk ? `${skills.length} skill${skills.length === 1 ? '' : 's'} defined` : used ? 'No skills in the repo yet' : 'No runs yet — the repo has not been used' },
    { rung: 'workflows', label: 'Workflows', pass: shiftOk, detail: shiftOk ? 'Something ran on a schedule this week' : 'Nothing has run on a schedule in the last 7 days' },
    { rung: 'oversight', label: 'Oversight', pass: oversightOk, detail: oversightOk ? 'Fire buttons registered' : used ? 'No workflow has fire: true yet' : 'No runs yet — the repo has not been used' },
    { rung: 'improvement', label: 'Improvement', pass: improvementOk, detail: improvementOk ? `${verdicts} verdict${verdicts === 1 ? '' : 's'} filed` : 'No verdicts in quality/ yet — nothing has told the team what you did with its work' }
  ]
}

// Tasks: tasks/*.md is the human to-do list living next to the agents' run logs.
// Frontmatter carries `status: todo|doing|done` and an optional `for: <agent-slug>`;
// the first heading in the body (or, failing that, the filename) is the title. A file
// with no frontmatter at all still parses — its status defaults to todo, because a task
// someone bothered to write down is work until something says otherwise.
// ---------------------------------------------------------------------------------------------
// The ledger and what was derived from it.
//
// These three are the first numbers on this board that come from the owner rather than from the
// team's own activity. Everything else here counts what the agents did; this counts what the week
// costs, in their words, from a file they corrected themselves.
//
// The board only ever DISPLAYS these. ledger.yml and proposals.yml are validated in the team repo
// by `npm run check:ledger` and `npm run check:proposals`, which re-derive everything and refuse
// what does not hold up. Re-implementing that here would be a second opinion nobody asked for and
// a second thing to drift.

const MINUTES_IN_AN_HOUR = 60

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

// Rule 5, decision-readiness: a row confirmed twice with nobody named to act on its output is
// PARKED, not buildable. A fill marker left in the answer counts as no answer.
//
// KEEP IN SYNC with classify() in agent-team-template's scripts/lib/ledger.mjs. That one returns
// note | parked | candidate; this only needs to know which rows are parked, so it is the same two
// conditions and nothing else. tests/fixtures/parked-parity.json holds the shared cases.
export function isParked(row) {
  if (row?.confirmed !== 'twice') return false
  const handsOff = typeof row?.hands_off === 'string' ? row.hands_off.trim() : ''
  return handsOff === '' || /<!--\s*fill:/.test(handsOff)
}

// A short code such as USD, GBP or EUR, or null when the ledger did not say. KEEP IN SYNC with
// agent-team-template's currencyOf() in scripts/lib/ledger.mjs - mirrored by hand like the other
// ledger rules, and pinned by tests/fixtures/currency-parity.json, the same bytes in both repos.
// Never guess: this board printed "$" for every student in every country until the field existed.
const CURRENCY_SHAPE = /^\S{1,8}$/
export function currencyOf(parsed) {
  const value = parsed?.currency
  return typeof value === 'string' && CURRENCY_SHAPE.test(value.trim()) ? value.trim() : null
}

// The one way money becomes words on this board, the same shape as the template's formatMoney():
// the code after the number, and bare - never a symbol - when there is no code. The caller adds
// "a week" so the hero can split value from unit.
export function formatMoney(value, currency) {
  const number = Math.round(value).toLocaleString('en-US')
  return currency ? `${number} ${currency}` : number
}

export function shapeLedger(source) {
  if (!source) return null
  const parsed = parseSimpleYaml(source)
  const hourlyValue = positiveNumber(parsed?.hourly_value)
  const currency = currencyOf(parsed)
  const rows = Array.isArray(parsed?.tasks) ? parsed.tasks : []

  let hoursPerWeek = 0
  let unreadable = 0
  const tasks = rows.map((row) => {
    const hours = (Number(row?.times_per_week) * Number(row?.minutes_each)) / MINUTES_IN_AN_HOUR
    // Finite AND positive. A row whose numbers will not parse contributes nothing, and silently
    // contributing nothing is how a half-broken ledger under-reports somebody's week with no sign
    // that anything was wrong.
    const usable = Number.isFinite(hours) && hours > 0 ? hours : null
    if (usable === null) unreadable += 1
    if (usable !== null) hoursPerWeek += usable
    return {
      task: typeof row?.task === 'string' ? row.task : '',
      words: typeof row?.words === 'string' ? row.words : '',
      confirmed: row?.confirmed ?? null,
      // A parked row is one the owner deliberately did not hand over, because nobody was named to
      // act on the result. `check:ledger` prints those under their own "Parked" heading; this
      // screen showed them in What eats it looking exactly like every other row, so the one
      // question the screen invites - why did four of these get a proposal and two not? - had no
      // answer anywhere on it.
      //
      // KEEP IN SYNC with agent-team-template's classify() in scripts/lib/ledger.mjs, mirrored by
      // hand for the same reason as the arming and switched-off rules: no import path between a
      // student's repo and a deployed web app. tests/fixtures/parked-parity.json is the shared
      // contract, the same bytes in both repos.
      //
      // The reason is NOT the signal. A first attempt keyed on `parked_because` having text, which
      // invented a second, narrower definition: the ledger format lets an owner park a row without
      // typing a reason, and check:ledger still calls that parked, so those rows kept rendering as
      // live. What decides it is rule 5 - confirmed twice, and nobody named to act on the output.
      parked: isParked(row),
      parkedBecause:
        typeof row?.parked_because === 'string' && row.parked_because.trim()
          ? row.parked_because.trim()
          : null,
      hoursPerWeek: usable
    }
  })

  const complete = Number.isFinite(hoursPerWeek) && hoursPerWeek > 0 && unreadable === 0

  return {
    ownerType: parsed?.owner_type ?? null,
    // How many rows the board could not turn into hours, and whether the total can be trusted as
    // a statement about their week.
    unreadable,
    complete,
    // Null, never zero, when they gave no rate. Zero would read as "this time is free", which is a
    // different claim and a false one - and it is the claim a dashboard makes loudest.
    hourlyValue,
    // Null when the ledger names no currency. The page then prints the number bare and says so,
    // rather than the dollar sign it used to assume for everyone.
    currency,
    hoursPerWeek,
    costPerWeek: hourlyValue === null ? null : hoursPerWeek * hourlyValue,
    unpriced: hourlyValue === null,
    tasks
  }
}

export function shapeProposals(source) {
  if (!source) return null
  const parsed = parseSimpleYaml(source)
  const rows = Array.isArray(parsed?.proposals) ? parsed.proposals : []
  const gapRows = Array.isArray(parsed?.gaps) ? parsed.gaps : []

  return {
    proposals: rows.map((row) => ({
      task: typeof row?.task === 'string' ? row.task : '',
      item: typeof row?.item === 'string' ? row.item : '',
      why: typeof row?.why === 'string' ? row.why : '',
      words: typeof row?.words === 'string' ? row.words : '',
      number: typeof row?.number === 'string' ? row.number : ''
    })),
    gaps: gapRows.map((row) => ({
      task: typeof row?.task === 'string' ? row.task : '',
      question: typeof row?.question === 'string' ? row.question : ''
    }))
  }
}

// The hero number is the one figure on the front of the board, and it has never been rendered.
// `tiles.yml` has named `hero: hours-saved` since the day it was written, while `hours-saved` does
// not exist in the tiles catalogue or anywhere else - the exact declaration-nothing-backs bug this
// whole build was written to kill, sitting in the one place everybody looks first.
//
// So this resolves the hero honestly or not at all. A metric the board cannot compute comes back
// as `{ defined: false }` and the screen says so. It never renders a zero, because a zero here is
// a claim about somebody's week.
// A zero is not a small number here, it is a claim: "your repeating work costs you nothing".
// Rendered in the largest type on the screen, off a ledger with no readable rows in it.
//
// It happened: an empty `tasks:` list, or one row whose `times_per_week` would not parse, produced
// `0 hours a week` and - worse - `$0 a week at the rate you set`, which is the exact
// this-time-is-free claim the cost field refuses to make and got in through the back door.
function usableHours(ledger) {
  return ledger && Number.isFinite(ledger.hoursPerWeek) && ledger.hoursPerWeek > 0
}

export const HERO_METRICS = {
  'hours-a-week': (ledger) =>
    usableHours(ledger)
      ? { value: ledger.hoursPerWeek, unit: 'hours a week', caption: 'what your repeating work costs you' }
      : null,
  'cost-a-week': (ledger) =>
    usableHours(ledger) && !ledger.unpriced
      ? { value: ledger.costPerWeek, unit: 'a week', money: true, currency: ledger.currency ?? null, caption: 'at the rate you set' }
      : null
}

// Every `why` below is a FINISHED SENTENCE, capital letter and full stop, and that is deliberate.
// The panel prints it straight after "No hero number yet.", so a lowercase fragment started that
// sentence with a lowercase letter in every state. The first fix capitalised it in the renderer,
// which was worse: one of these reasons legitimately begins with the filename `tiles.yml`, and the
// panel started printing `Tiles.yml` - a file that does not exist - on the screen the course tells
// students to bookmark on day one. A view layer cannot tell an English word from a filename, so
// the sentences are written correctly here instead.
export function shapeHero(tiles, ledger) {
  const metric = typeof tiles?.hero === 'string' ? tiles.hero.trim() : ''
  if (!metric) return null

  // The shipped tiles.yml carries `hero: <!-- fill: hero-metric -->`, and the owner chooses their
  // number in onboarding phase 10 - near the end. So for most of a student's first week the hero
  // IS that marker, and it fell through to the "nothing computes it yet" branch below, which
  // quotes the metric back at them: `tiles.yml asks for "<!-- fill: hero-metric -->"`. Raw internal
  // markup, printed at the top of the screen they were told to bookmark on day one, describing a
  // step they have not reached yet as though something were broken.
  if (fillMarkers(metric).length) {
    return {
      metric,
      defined: false,
      why: 'This board can carry one number at the top and nobody has chosen yours. /onboard asks which, or just say what it should be.'
    }
  }

  // `HERO_METRICS[metric]` with an unvalidated key reaches the prototype chain. From a tiles.yml:
  // `hero: constructor` resolved to Object, spread a truthy result and rendered NaN; `hero:
  // __proto__` threw inside this function and 500'd the whole dashboard. The key comes out of a
  // file in the student's repo, so it is exactly as trusted as they are careless.
  const resolve = Object.hasOwn(HERO_METRICS, metric) ? HERO_METRICS[metric] : null
  if (typeof resolve !== 'function') {
    return {
      metric,
      defined: false,
      why: `Nothing computes "${metric}", which is what tiles.yml asks for.`
    }
  }

  const resolved = resolve(ledger)
  if (!resolved) {
    const why = !ledger
      ? 'There is no ledger.yml yet.'
      : ledger.unreadable > 0
        ? `${ledger.unreadable} row${ledger.unreadable === 1 ? '' : 's'} in your ledger could not be read as hours.`
        : !usableHours(ledger)
          ? 'Your ledger has no hours in it yet.'
          : `Your ledger does not carry the number "${metric}" needs.`
    return { metric, defined: false, why }
  }

  // Last gate, on the number itself. `minutes_each: 1e308` survives every earlier check - the
  // hours are finite and positive - and only the product overflows, so the hero rendered "$Infinity".
  if (!Number.isFinite(resolved.value)) {
    return { metric, defined: false, why: `"${metric}" produced a number nobody can read.` }
  }

  return { metric, defined: true, ...resolved }
}

export function parseTasks(taskFiles) {
  return taskFiles.map(([path, body]) => {
    const source = body ?? ''
    const data = parseFrontmatter(source)
    const status = TASK_STATUSES.includes(data.status) ? data.status : 'todo'
    const withoutFrontmatter = source.replace(/^---\r?\n[\s\S]*?\r?\n---/, '')
    const heading = /^#{1,6}\s+(.+?)\s*$/m.exec(withoutFrontmatter)
    const slug = path.split('/').pop().replace(/\.md$/, '')
    return {
      slug,
      path,
      title: heading ? heading[1] : slug,
      status,
      for: typeof data.for === 'string' && data.for ? data.for : null,
      // The day the card was CLOSED, which is not the date in its filename - that is the day it
      // was written, and a card raised in March and finished in June would read as three months
      // stale the moment it was done. Only a real YYYY-MM-DD counts: "last Tuesday" is somebody
      // typing a note into a date field, and a board that accepted it would sort by nonsense.
      doneAt: isCalendarDay(data.done_at) ? data.done_at.trim() : null
    }
  })
}

// A date this board can count from, or nothing. Deliberately narrow: it checks the shape AND
// that the shape names a real day, so 2026-02-31 is refused rather than rolled into March.
export function isCalendarDay(value) {
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
  const at = new Date(`${text}T00:00:00Z`)
  return Number.isFinite(at.getTime()) && at.toISOString().slice(0, 10) === text
}

// The Board: four columns for the Today screen — To do, Up Next, Running, Done.
//
// Running-detection rule, decided from the run-log shape (logs carry started_at, status,
// summary, session_url; finished_at only when the agent came back to stamp the result):
//   1. A run with a finished_at is never running — a stamped finish is final.
//   2. Otherwise, a missing status or status "running" means in flight: agents write the
//      final status when they finish, so a log without one was committed at kickoff.
//   3. Otherwise (a status is present but no finished_at), the run still counts as running
//      for 30 minutes after started_at — that covers logs written up front with a
//      provisional status. Past 30 minutes the status is trusted as the result.
const RUNNING_GRACE_MINUTES = 30
const TERMINAL_STATUSES = ['ok', 'partial', 'blocked', 'failed']
const UP_NEXT_WINDOW_MS = 48 * 3600_000
const DONE_WINDOW_MS = 14 * 86400_000
// Nuno's call, 2026-09-02: a finished TASK shows for seven days, then lives behind the link
// under the column rather than on the board. Runs keep their fourteen.
const TASK_DONE_WINDOW_MS = 7 * 86400_000

function isRunningLog(run, now) {
  if (run.finished_at) return false
  if (run.status == null || run.status === 'running') return true
  const started = Date.parse(run.started_at)
  return Number.isFinite(started) && now - started <= RUNNING_GRACE_MINUTES * 60_000
}

// A job owned by an agent somebody switched off validates clean and then never runs. That is not a
// guess: agent-team-template's own validator asks whether the owner EXISTS, not whether it is in
// use, and its scripts/check-arming.mjs already prints "Owned by an agent you are not using - these
// cannot run as written" in the terminal for exactly this.
//
// The board had both halves and said neither. It reads the knowledge files to decide an agent is
// switched off, and it reads every job's owner - and then showed nine cards that differed only in
// their reason for being off. Two of the nine jobs the template ships are owned by sales and
// customer-service, which are the two an employee switches off, so this is not a hypothetical about
// hand-written files: it is the state a fresh clone is in the moment somebody with a job answers
// those two knowledge files honestly. Both cards invited him to arm them once the data arrived.
//
// Returns the same rows with the flag added, rather than a filtered list, because the answer this
// screen needs is which card to mark - not which cards to hide.
export function markOwnerSwitchedOff(workflows = [], agents = []) {
  const off = new Set(
    agents.filter((agent) => agent?.state === 'not-in-use').map((agent) => agent.slug)
  )
  return workflows.map((workflow) => ({
    ...workflow,
    ownerSwitchedOff: typeof workflow?.owner === 'string' && workflow.owner !== '' && off.has(workflow.owner)
  }))
}

export function shapeBoard(workflows, runs, tasks = [], now = Date.now()) {
  // To do: open tasks (todo and doing), oldest first — task filenames are date-prefixed
  // by convention, so path order is age order. `doing` rides along as a flag rather than
  // its own column: on a phone four columns already stack tall enough.
  //
  // Done tasks USED TO add no card of their own: a finished task earned its place in Done only
  // through the run log the agent wrote, on the reasoning that the run card IS the record and
  // carding the task beside it would show one piece of work twice.
  //
  // That held while the only way a card got finished was an agent finishing it. The board now
  // has a Done button, so a card can be closed by the owner with no run behind it at all — and
  // under the old rule that work vanished from the board the moment it was done. Finished tasks
  // are carded below, for seven days against the runs' fourteen, and marked `kind: 'task'` so
  // the two are never dressed as each other.
  const todo = tasks
    .filter((task) => task.status === 'todo' || task.status === 'doing')
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((task) => ({
      slug: task.slug,
      title: task.title,
      for: task.for,
      doing: task.status === 'doing'
    }))

  const upNext = workflows
    .filter((workflow) => {
      if (!workflow.nextRun) return false
      const at = Date.parse(workflow.nextRun)
      return Number.isFinite(at) && at - now <= UP_NEXT_WINDOW_MS
    })
    .sort((a, b) => String(a.nextRun).localeCompare(String(b.nextRun)))
    .map((workflow) => ({
      slug: workflow.slug,
      name: workflow.name,
      owner: workflow.owner,
      when: workflow.nextRun
    }))

  const running = []
  const done = []
  for (const run of runs) {
    const name = run.workflow ?? run.agent ?? 'unknown'
    if (isRunningLog(run, now)) {
      running.push({
        name,
        agent: run.agent ?? null,
        started_at: run.started_at ?? null,
        session_url: run.session_url ?? null
      })
      continue
    }
    // Done means a real result: a stamped finish or a terminal status, inside 14 days.
    if (!run.finished_at && !TERMINAL_STATUSES.includes(run.status)) continue
    const at = Date.parse(run.finished_at ?? run.started_at)
    if (!Number.isFinite(at) || now - at > DONE_WINDOW_MS) continue
    done.push({
      kind: 'run',
      name,
      agent: run.agent ?? null,
      status: run.status ?? 'ok',
      summary: run.summary ?? '',
      started_at: run.started_at ?? null,
      session_url: run.session_url ?? null,
      _at: at
    })
  }

  // Finished TASKS join the finished runs, for seven days rather than the runs' fourteen. Two
  // windows in one column because they are two different things: a run is the team's record of
  // work it did, and stays long enough to review a fortnight; a task is the owner's own card,
  // and a column of last month's ticks is not a board, it is a filing cabinet.
  //
  // Undated done cards - every one written before done_at existed - are NOT placed here. The
  // board would have to invent a date to sort them by, and inventing one is how a card finished
  // in June reads as March. They are reachable in full through finishedTasks below.
  const finishedTasks = tasks
    .filter((task) => task.status === 'done')
    .map((task) => ({ kind: 'task', slug: task.slug, title: task.title, for: task.for ?? null, doneAt: task.doneAt ?? null }))
    .sort((a, b) => String(b.doneAt ?? '').localeCompare(String(a.doneAt ?? '')))

  for (const task of finishedTasks) {
    if (!task.doneAt) continue
    // Midday UTC, not midnight: a card dated today must read as today for a reader west of
    // Greenwich too, and a date with no time in it is a day, not an instant.
    const at = Date.parse(`${task.doneAt}T12:00:00Z`)
    if (!Number.isFinite(at) || now - at > TASK_DONE_WINDOW_MS) continue
    done.push({ ...task, _at: at })
  }

  done.sort((a, b) => b._at - a._at)
  for (const card of done) delete card._at

  return { todo, upNext, running, done, finishedTasks }
}

// Which files in tasks/ are somebody's cards. Exported so the suite can hit it directly rather
// than reasoning about a regex inside the handler. Kept deliberately narrow: only the folder's own
// README is excluded, because a card a student names oddly is still their card and dropping it
// silently would be worse than showing it.
export function isTaskCard(path) {
  const match = /^tasks\/([^/]+)\.md$/.exec(String(path ?? ''))
  return match !== null && match[1].toLowerCase() !== 'readme'
}

export function shapeGoneQuiet(agents, workflows) {
  const quiet = []
  for (const agent of agents) {
    if (agent.state === 'quiet') {
      quiet.push({ kind: 'agent', slug: agent.slug, name: agent.slug, lastRun: agent.lastRun })
    }
  }
  for (const workflow of workflows) {
    if (workflow.state === 'quiet') {
      quiet.push({
        kind: 'workflow',
        slug: workflow.slug,
        name: workflow.name,
        lastRun: workflow.lastRun?.started_at ?? null
      })
    }
  }
  return quiet
}

// ---------------------------------------------------------------------------------------------
// Whose board this is.
//
// The header greets the owner by first name and draws their initials, and the only place the repo
// holds a name is the first line under "## Name and role" in shared/about-me.md. That section is
// also where people write everything else about themselves - Nuno's own has his email address two
// lines below his name - and this payload goes to a browser, on a board that can be public.
//
// So the server takes ONE short name out of that section and nothing else, and anything that does
// not plainly look like a name comes back as no name. A missing greeting costs nothing; an email
// address printed in a header, or a stranger greeted as "Coach", is the kind of thing that gets a
// dashboard closed and not reopened.
const NAME_SECTION = /^##\s+name and role\s*$/i
// Where a name ends and the rest of the sentence begins: "Nuno Tavares. Coach...", "Jordan Avery
// (she/her)", "Priya Nair — design". A bare hyphen is NOT here - Jean-Luc is one name - only " - ".
const NAME_ENDS = /[.,;(|—]| - /
const MAX_NAME_WORDS = 4
const MAX_NAME_LENGTH = 40

export function ownerNameFrom(source) {
  if (typeof source !== 'string') return null
  const lines = source.split(/\r?\n/)
  const start = lines.findIndex((line) => NAME_SECTION.test(line.trim()))
  if (start === -1) return null

  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim()
    // The next heading is the end of the section. An empty Name and role does not borrow the
    // first line of whatever comes after it.
    if (/^#{1,6}\s/.test(line)) return null
    if (!line) continue
    // A fill marker where the name goes means the name has not been written. Skipping it like any
    // other comment would walk on to the role line and greet them as "Coach".
    if (/<!--\s*fill:/.test(line)) return null
    // A note to self, which is not the name and not a reason to give up on the line after it.
    if (/^<!--.*-->$/.test(line)) continue

    const name = line.split(NAME_ENDS)[0].trim()
    // Judged AFTER the cut, so an email later in the same sentence is cut away rather than
    // costing the name - and an email that IS the first thing on the line still has its `@`.
    if (!name || /[@<\d]/.test(name)) return null
    if (name.split(/\s+/).length > MAX_NAME_WORDS || name.length > MAX_NAME_LENGTH) return null
    return name
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// How much the team has done, far enough back to draw.
//
// `runs` in the payload stops at MAX_RUNS_RETURNED, which suits a feed and undercounts a chart: a
// team that runs hourly fills fifty in two days, and a fourteen-day line drawn from them shows the
// other twelve as nothing happening. So the Today sparkline gets its own list - only the two fields
// a day-count needs - over FIFTEEN days, because fourteen local days end up to fourteen hours
// either side of UTC and the board does not know where its reader is.
//
// It is capped too, much higher, because one payload cannot grow without limit. When the cap is
// hit `complete` says so, and the page draws nothing rather than a line that quietly runs out.
const ACTIVITY_DAYS = 15
const MAX_ACTIVITY_RUNS = 1000

export function shapeActivity(runs, now = Date.now(), cap = MAX_ACTIVITY_RUNS) {
  const sinceMs = now - ACTIVITY_DAYS * 86400_000
  const inWindow = (Array.isArray(runs) ? runs : [])
    .map((run) => ({ run, ms: Date.parse(run?.started_at) }))
    .filter(({ ms }) => Number.isFinite(ms) && ms >= sinceMs)
    .sort((a, b) => b.ms - a.ms)
  return {
    since: new Date(sinceMs).toISOString(),
    runs: inWindow.slice(0, cap).map(({ run }) => ({
      started_at: run.started_at,
      agent: typeof run.agent === 'string' ? run.agent : null
    })),
    complete: inWindow.length <= cap
  }
}

// --- the handler --------------------------------------------------------------------------

export default async function handler(request, response) {
  const denied = viewGate(request)
  if (denied) {
    response.status(denied.status).json({ error: denied.error })
    return
  }
  try {
    const settings = config()
    const { owner, repo, branch } = settings
    const now = Date.now()

    // One tree call gives every path in the repo. Cheaper than walking directories.
    const tree = await gh(`/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`)
    const blobs = (tree.tree ?? []).filter((node) => node.type === 'blob')
    const paths = blobs.map((node) => node.path)
    const sizes = Object.fromEntries(blobs.map((node) => [node.path, node.size ?? null]))

    const agentPaths = paths.filter((path) => path.startsWith(`${AGENT_DIR}/`) && path.endsWith('.md'))
    const runPaths = paths.filter((path) => /^runs\/\d{4}-\d{2}\/.+\.json$/.test(path))
    const workflowPaths = paths.filter((path) => /^workflows\/[^/]+\.ya?ml$/.test(path))
    // `tasks/README.md` explains the folder; it is not somebody's to-do. It matched this filter,
    // so it arrived on the board as a card titled "tasks/ — your to-do column", counted in the
    // To-do badge, and it ships in the template - meaning every repo had one phantom task from the
    // moment it was created, and the count was wrong by one forever.
    //
    // The team's own side already gets this right: work-the-tasks/SKILL.md says "Read every .md
    // file in tasks/ (skip README.md)". So the sweep ignored it and the board did not, and they
    // disagreed about the same folder.
    const taskPaths = paths.filter((path) => isTaskCard(path))
    // One file per verdict the owner gave. Counted, never read: the Improvement rung only
    // needs to know somebody closed the loop, and the contents are the owner's own words.
    const verdictPaths = paths.filter((path) => /^quality\/verdicts\/.+\.md$/.test(path))
    const skillPaths = paths.filter((path) => /^(?:\.claude\/)?skills\/[^/]+\/(?:SKILL|skill)\.md$/.test(path))
    const skillSlugs = [...new Set(skillPaths.map((path) => path.split('/').at(-2)))]
    const hasRuntimes = paths.includes('runtimes.yml')
    const CONNECTION_REGISTER = 'connections/register.yml'
    const hasConnections = paths.includes(CONNECTION_REGISTER)
    const hasTiles = paths.includes('tiles.yml')
    const hasStack = paths.includes('stack.yml')
    const hasLedger = paths.includes('ledger.yml')
    const hasProposals = paths.includes('proposals.yml')
    const ROUTINE_SNAPSHOT = '.agent-team/routines.json'
    const hasRoutineSnapshot = paths.includes(ROUTINE_SNAPSHOT)
    const ONBOARDING_STATE = '.agent-team/onboarding-state.md'
    const hasOnboarding = paths.includes(ONBOARDING_STATE)
    // One file per computer. Only the first five are fetched - shapeUsage counts the rest, so the
    // page can say some were left out. One the tree says is over the size limit is not fetched at
    // all, and goes to shapeUsage with no body, to be counted as a file that could not be used.
    const usagePaths = paths.filter((path) => isUsageFile(path)).sort()
    const usageBody = async (path) => ((sizes[path] ?? 0) > USAGE_MAX_BYTES ? null : rawFile(settings, path))
    // The Connections wall's files, on the same terms: five fetched, none the tree calls too big.
    const foundPaths = paths.filter((path) => isFoundFile(path)).sort()
    const foundBody = async (path) => ((sizes[path] ?? 0) > FOUND_MAX_BYTES ? null : rawFile(settings, path))
    const hermesPaths = paths.filter((path) => isHermesFile(path)).sort()
    const hermesBody = async (path) => ((sizes[path] ?? 0) > HERMES_MAX_BYTES ? null : rawFile(settings, path))

    const [agentFiles, runFiles, brainFiles, knowledgeFiles, workflowFiles, taskFiles, skillFiles, runtimesSource, connectionsSource, tilesSource, onboardingSource, stackSource, ledgerSource, proposalsSource, routineSnapshotSource, usageFiles, foundFiles, hermesFiles] =
      await Promise.all([
        Promise.all(agentPaths.map(async (path) => [path, await rawFile(settings, path)])),
        Promise.all(runPaths.map(async (path) => [path, await rawFile(settings, path)])),
        Promise.all(BRAIN_FILES.map(async (path) => [path, await rawFile(settings, path)])),
        Promise.all(Object.entries(KNOWLEDGE_FILES).map(async ([slug, path]) => [slug, await rawFile(settings, path)])),
        Promise.all(workflowPaths.map(async (path) => [path, await rawFile(settings, path)])),
        Promise.all(taskPaths.map(async (path) => [path, await rawFile(settings, path)])),
        Promise.all(skillPaths.map(async (path) => [path, await rawFile(settings, path)])),
        hasRuntimes ? rawFile(settings, 'runtimes.yml') : null,
        hasConnections ? rawFile(settings, CONNECTION_REGISTER) : null,
        hasTiles ? rawFile(settings, 'tiles.yml') : null,
        hasOnboarding ? rawFile(settings, ONBOARDING_STATE) : null,
        hasStack ? rawFile(settings, 'stack.yml') : null,
        hasLedger ? rawFile(settings, 'ledger.yml') : null,
        hasProposals ? rawFile(settings, 'proposals.yml') : null,
        hasRoutineSnapshot ? rawFile(settings, ROUTINE_SNAPSHOT) : null,
        Promise.all(usagePaths.slice(0, USAGE_MAX_FILES).map(async (path) => [path, await usageBody(path)])),
        Promise.all(foundPaths.slice(0, FOUND_MAX_FILES).map(async (path) => [path, await foundBody(path)])),
        Promise.all(hermesPaths.slice(0, HERMES_MAX_FILES).map(async (path) => [path, await hermesBody(path)]))
      ])

    const unparseable = []
    const parsedRuns = []
    for (const [path, body] of runFiles) {
      try {
        parsedRuns.push({ ...JSON.parse(body), _path: path })
      } catch {
        unparseable.push(path)
      }
    }
    const runs = sortRunsNewestFirst(parsedRuns)

    // Built once. It was `Object.fromEntries(knowledgeFiles)` inside the loop, rebuilt per agent.
    const knowledgeFor = Object.fromEntries(knowledgeFiles)
    const agents = agentPaths.map((path, index) => {
      const slug = path.slice(AGENT_DIR.length + 1, -3)
      const data = parseFrontmatter(agentFiles[index][1])
      const mine = runs.filter((run) => run.agent === slug)
      return {
        slug,
        description: data.description ?? '',
        model: data.model ?? 'unknown',
        lastRun: mine[0]?.started_at ?? null,
        lastStatus: mine[0]?.status ?? null,
        runsThisWeek: mine.filter((run) => (daysSince(run.started_at, now) ?? 99) <= 7).length,
        totalRuns: mine.length,
        recentRuns: mine.slice(0, AGENT_RECENT_RUNS),
        state: stateFor(mine, now, notInUse(knowledgeFor[slug])),
        // The owner's own sentence for why this one is switched off, so the card can say it. Null
        // for every agent that is not switched off - which is six of the eight, and both of the
        // two that can be.
        notInUseBecause: notInUseBecause(knowledgeFor[slug])
      }
    })

    const brain = brainFiles.map(([path, body]) => ({
      path,
      present: body !== null,
      missing: fillMarkers(body)
    }))
    // Only the name leaves this file. The body itself is never put in the payload - see
    // ownerNameFrom for why that matters more here than anywhere else on the board.
    const ownerName = ownerNameFrom(Object.fromEntries(brainFiles)['shared/about-me.md'])

    const known = {}
    if (agents.length) known.agents = agents.map((agent) => agent.slug)
    if (skillSlugs.length) known.skills = skillSlugs
    const snapshot = shapeSnapshot(routineSnapshotSource, now)
    const workflows = markOwnerSwitchedOff(
      shapeWorkflows(workflowFiles, runs, known, now, snapshot.routines, snapshot.usable && !snapshot.stale),
      agents
    )
    const tasks = parseTasks(taskFiles)

    // Heartbeat files named by the registry, fetched only if the tree actually has them.
    const registry = runtimesSource ? parseSimpleYaml(runtimesSource) : { runtimes: [] }
    const beatPaths = (Array.isArray(registry.runtimes) ? registry.runtimes : [])
      .map((entry) => entry?.heartbeat)
      .filter((path) => typeof path === 'string' && paths.includes(path))
    const heartbeats = {}
    await Promise.all(
      beatPaths.map(async (path) => {
        try {
          heartbeats[path] = JSON.parse(await rawFile(settings, path))
        } catch {
          heartbeats[path] = null
        }
      })
    )
    const runtimes = shapeRuntimes(registry, heartbeats, now)
    const connections = shapeConnections(connectionsSource ? parseSimpleYaml(connectionsSource) : { connections: [] })

    const tiles = tilesSource ? parseSimpleYaml(tilesSource) : null
    const skills = shapeSkills(skillFiles, workflows)
    // Parsed once: the starter stack and what the owner pays live in the same file.
    const stackDoc = stackSource ? parseSimpleYaml(stackSource) : null
    const stack = shapeStack(stackDoc, paths)
    const memory = shapeMemory(paths, sizes)
    const onboarding = parseOnboardingState(onboardingSource)
    const routinesKnown = snapshot.usable && !snapshot.stale
    // Claimed when a routine MATCHED, not when it happened to carry an id. Built from routineId,
    // a routine with no id matched its workflow, reported ARMED on its card, and appeared under
    // "Routines with no workflow file" at the same time - two contradictory statements about one
    // job on one screen. arm.mjs claims on the match; so does this now.
    const claimedRoutines = new Set(
      workflows
        .filter((workflow) => workflow.arm === 'armed' || workflow.arm === 'unapproved')
        .map((workflow) => routineNameKey(workflow.name))
    )
    // Only from a snapshot the board has agreed to trust. A stale one turned every correctly armed
    // routine into a reported orphan, underneath a banner saying the data was not to be trusted.
    const orphanRoutines = routinesKnown
      ? (snapshot.routines ?? [])
          .filter((routine) => !claimedRoutines.has(routineNameKey(routine?.name)))
          .map((routine) => ({
            id: routine?.id ?? null,
            // Matching arm.mjs: a blank, whitespace or non-string name is "(unnamed)", not an
            // empty bold tag or a stray number rendered as if it were a name.
            name: (typeof routine?.name === 'string' && routine.name.trim()) || '(unnamed)'
          }))
      : []

    // Two alarm clocks for one job both fire and both are billed, and the second was invisible.
    // Two files with one name both reported ARMED on the same routine id - twice as much running
    // as there is, and a second route by which a job nothing fires gets a next-run time.
    const routineProblems = []
    const countBy = (values) => {
      const seen = new Map()
      for (const value of values) if (value) seen.set(value, (seen.get(value) ?? 0) + 1)
      return seen
    }
    if (routinesKnown) {
      for (const [name, count] of countBy((snapshot.routines ?? []).map((r) => routineNameKey(r?.name)))) {
        if (count > 1) routineProblems.push(`${count} routines share the name "${name}" - they will all fire, and the spend is multiplied`)
      }
    }
    for (const [name, count] of countBy(workflows.map((workflow) => routineNameKey(workflow.name)))) {
      if (count > 1) routineProblems.push(`${count} workflow files share the name "${name}", so a routine cannot be matched to one of them`)
    }

    const ledger = shapeLedger(ledgerSource)
    const proposals = shapeProposals(proposalsSource)
    // A file the tree listed and the fetch could not return keeps its place with no body: it is a
    // file that could not be used, not one of those past the first five.
    const usage = shapeUsage(usageFiles, now, usagePaths.length)
    const subscriptions = shapeSubscriptions(stackDoc, usage)
    // Proved is matched in from the register here, after both are read, and from nowhere else.
    const found = matchProved(shapeFound(foundFiles, now, foundPaths.length), connections)
    const hermes = shapeHermes(hermesFiles, now, hermesPaths.length)
    const hero = shapeHero(tiles, ledger)
    const setup = shapeSetup({ brain, skills: skillSlugs, workflows, runtimes, tiles, runs, connections, verdicts: verdictPaths.length, onboarding, now })

    // A CDN cache in front of a board that reads GitHub. `generatedAt` below is stamped from the
    // `now` captured at the top of this handler, so it is baked into the body BEFORE the cache
    // sees it: somebody served a stale copy reads a truthful "N min ago" rather than a fresh-
    // looking timestamp on old data. The staleness is disclosed, which is what makes it fine.
    response.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300')
    response.status(200).json({
      repo: { owner, repo, branch, url: `https://github.com/${owner}/${repo}` },
      agents: agents.sort((a, b) => a.slug.localeCompare(b.slug)),
      owner: ownerName ? { name: ownerName } : null,
      runs: runs.slice(0, MAX_RUNS_RETURNED),
      totalRuns: runs.length,
      activity: shapeActivity(runs, now),
      unparseableRuns: unparseable,
      overnight: runsSince(runs, undefined, now).slice(0, MAX_RUNS_RETURNED),
      goneQuiet: shapeGoneQuiet(agents, workflows),
      board: shapeBoard(workflows, runs, tasks, now),
      brain,
      workflows,
      runtimes,
      connections,
      skills,
      stack,
      memory,
      ledger,
      proposals,
      hero,
      usage,
      subscriptions,
      found,
      hermes,
      routines: {
        takenAt: snapshot.takenAt,
        usable: snapshot.usable,
        stale: snapshot.stale ?? false,
        why: snapshot.why,
        count: snapshot.routines.length,
        known: routinesKnown,
        orphans: orphanRoutines,
        problems: routineProblems
      },
      setup,
      generatedAt: new Date(now).toISOString()
    })
  } catch (error) {
    response.status(error.status === 404 ? 404 : 500).json({ error: error.message })
  }
}
