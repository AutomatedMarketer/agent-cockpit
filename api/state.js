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
  fillMarkers,
  sortRunsNewestFirst,
  runsSince,
  heartbeatStatus, viewGate } from './lib.js'
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

export function shapeSnapshot(source, now = Date.now()) {
  if (source === null || source === undefined) {
    return { takenAt: null, routines: [], usable: false, why: 'no snapshot has been taken yet' }
  }
  let parsed
  try {
    parsed = JSON.parse(source)
  } catch {
    // Corrupt is not absent. An empty routine list for an unreadable file would assert "nothing is
    // scheduled", which is a claim about somebody's account a broken file cannot support.
    return { takenAt: null, routines: [], usable: false, why: 'the snapshot could not be read' }
  }
  const routines = Array.isArray(parsed?.routines) ? parsed.routines : null
  if (!routines) {
    return { takenAt: null, routines: [], usable: false, why: 'the snapshot has no routines list' }
  }
  const takenAt = typeof parsed?.takenAt === 'string' ? parsed.takenAt.trim() : ''
  const takenMs = takenAt ? Date.parse(takenAt) : NaN
  if (!takenAt || Number.isNaN(takenMs)) {
    return { takenAt: null, routines, usable: false, why: 'the snapshot does not say when it was taken' }
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
      why: 'the snapshot is stamped in the future, so its age cannot be trusted'
    }
  }

  const stale = ageHours > SNAPSHOT_STALE_AFTER_HOURS
  return {
    takenAt,
    routines,
    ageHours,
    stale,
    usable: true,
    why: stale ? `the snapshot was taken ${describeAge(ageHours)} ago` : null
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

export function shapeRuntimes(registry, heartbeats, now = Date.now()) {
  const entries = Array.isArray(registry?.runtimes) ? registry.runtimes : []
  return entries
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => {
      const beat = entry.heartbeat ? heartbeats[entry.heartbeat] ?? null : null
      const { status, lastBeat } = entry.heartbeat
        ? heartbeatStatus(beat, now)
        : { status: 'no-heartbeat', lastBeat: null }
      return {
        name: String(entry.name ?? 'unnamed'),
        kind: String(entry.kind ?? 'runtime'),
        url: typeof entry.url === 'string' ? entry.url : null,
        heartbeat: entry.heartbeat ?? null,
        status,
        lastBeat
      }
    })
}

// Every skill in the repo, with its one-line description and which workflows call it.
// A skill no workflow uses is not wrong — it is there for sessions — but the owner should
// be able to see that at a glance.
export function shapeSkills(skillFiles, workflows = []) {
  return skillFiles
    .map(([path, source]) => {
      const slug = path.split('/').at(-2)
      const data = parseFrontmatter(source ?? '')
      const usedBy = workflows
        .filter((workflow) => (workflow.steps ?? []).includes(slug))
        .map((workflow) => workflow.slug)
      return { slug, path, description: data.description ?? '', usedBy }
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

export function shapeLedger(source) {
  if (!source) return null
  const parsed = parseSimpleYaml(source)
  const hourlyValue = positiveNumber(parsed?.hourly_value)
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
      ? { value: ledger.costPerWeek, unit: 'a week', money: true, caption: 'at the rate you set' }
      : null
}

export function shapeHero(tiles, ledger) {
  const metric = typeof tiles?.hero === 'string' ? tiles.hero.trim() : ''
  if (!metric) return null

  // `HERO_METRICS[metric]` with an unvalidated key reaches the prototype chain. From a tiles.yml:
  // `hero: constructor` resolved to Object, spread a truthy result and rendered NaN; `hero:
  // __proto__` threw inside this function and 500'd the whole dashboard. The key comes out of a
  // file in the student's repo, so it is exactly as trusted as they are careless.
  const resolve = Object.hasOwn(HERO_METRICS, metric) ? HERO_METRICS[metric] : null
  if (typeof resolve !== 'function') {
    return {
      metric,
      defined: false,
      why: `tiles.yml asks for "${metric}" and nothing computes it yet`
    }
  }

  const resolved = resolve(ledger)
  if (!resolved) {
    const why = !ledger
      ? 'there is no ledger.yml yet'
      : ledger.unreadable > 0
        ? `${ledger.unreadable} row${ledger.unreadable === 1 ? '' : 's'} in your ledger could not be read as hours`
        : !usableHours(ledger)
          ? 'your ledger has no hours in it yet'
          : `"${metric}" needs a number your ledger does not carry`
    return { metric, defined: false, why }
  }

  // Last gate, on the number itself. `minutes_each: 1e308` survives every earlier check - the
  // hours are finite and positive - and only the product overflows, so the hero rendered "$Infinity".
  if (!Number.isFinite(resolved.value)) {
    return { metric, defined: false, why: `"${metric}" came out as a number nobody can read` }
  }

  return { metric, defined: true, ...resolved }
}

const TASK_STATUSES = ['todo', 'doing', 'done']

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
      for: typeof data.for === 'string' && data.for ? data.for : null
    }
  })
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

function isRunningLog(run, now) {
  if (run.finished_at) return false
  if (run.status == null || run.status === 'running') return true
  const started = Date.parse(run.started_at)
  return Number.isFinite(started) && now - started <= RUNNING_GRACE_MINUTES * 60_000
}

export function shapeBoard(workflows, runs, tasks = [], now = Date.now()) {
  // To do: open tasks (todo and doing), oldest first — task filenames are date-prefixed
  // by convention, so path order is age order. `doing` rides along as a flag rather than
  // its own column: on a phone four columns already stack tall enough.
  //
  // Done tasks add no card of their own. A finished task only earns its place in Done
  // through the run log the agent wrote — the run card IS the record, and carding the
  // task file next to it would show the same work twice.
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
      name,
      agent: run.agent ?? null,
      status: run.status ?? 'ok',
      summary: run.summary ?? '',
      started_at: run.started_at ?? null,
      session_url: run.session_url ?? null,
      _at: at
    })
  }
  done.sort((a, b) => b._at - a._at)
  for (const card of done) delete card._at

  return { todo, upNext, running, done }
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

    const [agentFiles, runFiles, brainFiles, knowledgeFiles, workflowFiles, taskFiles, skillFiles, runtimesSource, connectionsSource, tilesSource, onboardingSource, stackSource, ledgerSource, proposalsSource, routineSnapshotSource] =
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
        hasRoutineSnapshot ? rawFile(settings, ROUTINE_SNAPSHOT) : null
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
        state: stateFor(mine, now, notInUse(Object.fromEntries(knowledgeFiles)[slug]))
      }
    })

    const brain = brainFiles.map(([path, body]) => ({
      path,
      present: body !== null,
      missing: fillMarkers(body)
    }))

    const known = {}
    if (agents.length) known.agents = agents.map((agent) => agent.slug)
    if (skillSlugs.length) known.skills = skillSlugs
    const snapshot = shapeSnapshot(routineSnapshotSource, now)
    const workflows = shapeWorkflows(workflowFiles, runs, known, now, snapshot.routines, snapshot.usable && !snapshot.stale)
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
    const stack = shapeStack(stackSource ? parseSimpleYaml(stackSource) : null, paths)
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
      runs: runs.slice(0, MAX_RUNS_RETURNED),
      totalRuns: runs.length,
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
