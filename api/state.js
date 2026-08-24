// One request from the browser, one JSON payload back — enough to draw all five screens:
// Today, Team, Workflows, Memory, Connections.
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

export function shapeWorkflows(workflowFiles, runs, known, now = Date.now()) {
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
      // Never-run is its own state, not "quiet": a fresh clone ships five scheduled
      // workflows, and greeting a new owner with five alarms would teach them to ignore
      // the one alarm that matters later.
      const quiet = last !== null && schedule !== null && isGoneQuiet(schedule, last.started_at, now)

      let state = 'never-run'
      if (problems.length) state = 'attention'
      else if (last && (last.status === 'failed' || last.status === 'blocked')) state = 'attention'
      else if (quiet) state = 'quiet'
      else if (last) state = 'working'

      return {
        slug,
        path,
        name: typeof workflow.name === 'string' ? workflow.name : slug,
        owner: typeof workflow.owner === 'string' ? workflow.owner : null,
        steps: Array.isArray(workflow.steps) ? workflow.steps : [],
        runner: workflow.runner ?? 'routine',
        schedule,
        fire: workflow.trigger?.fire === true,
        webhook: workflow.trigger?.webhook === true,
        output: typeof workflow.output === 'string' ? workflow.output : null,
        problems,
        lastRun: last
          ? { started_at: last.started_at, status: last.status, summary: last.summary ?? '', session_url: last.session_url ?? null }
          : null,
        nextRun: schedule ? nextRunAt(schedule, { now, lastRun: last?.started_at ?? null }) : null,
        state
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

// The five rungs of the Hiring Ladder, each judged from what the repo actually contains.
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

export function shapeSetup({ brain, skills, workflows, runtimes, tiles, runs, onboarding = null, now = Date.now() }) {
  // The Shift rung is behavioral either way: it asks whether anything actually ran on a
  // schedule this week, which no install record can answer.
  const shiftOk = workflows.some(
    (workflow) =>
      workflow.schedule !== null &&
      workflow.lastRun &&
      (daysSince(workflow.lastRun.started_at, now) ?? 99) <= 7
  ) || runs.some((run) => run.trigger === 'schedule' && (daysSince(run.started_at, now) ?? 99) <= 7)

  if (onboarding) {
    const pass = (stage) => onboarding[stage] === true
    const detail = (stage, doneText) => pass(stage) ? doneText : 'Not finished in /onboard yet'
    // Rung 4 is the course's Workflows stage. The install record decides pass/fail; the
    // behavioral signal (did anything actually run this week) rides along in the detail.
    const workflowsDetail = pass('workflows')
      ? shiftOk ? 'Workflows built — something ran on a schedule this week' : 'Workflows built — nothing has run on a schedule in the last 7 days'
      : 'Not finished in /onboard yet'
    return [
      { rung: 'brief', label: 'Brief', pass: pass('brief'), detail: detail('brief', 'Business brain filled in') },
      { rung: 'access', label: 'Access', pass: pass('access'), detail: detail('access', 'Tools connected') },
      { rung: 'training', label: 'Training', pass: pass('training'), detail: detail('training', 'Skills built and verified') },
      { rung: 'workflows', label: 'Workflows', pass: pass('workflows'), detail: workflowsDetail },
      { rung: 'oversight', label: 'Oversight', pass: pass('oversight'), detail: detail('oversight', 'Dashboard deployed, dispatched from the phone') }
    ]
  }

  // Heuristic fallback — but the template now ships staffed, so "skills exist" and
  // "a fire workflow exists" are true in a fresh clone and prove nothing. Gate the
  // achievement-shaped rungs on evidence somebody actually used the repo.
  const used = runs.length > 0
  const briefOk =
    brain.length > 0 && brain.every((file) => file.present && file.missing.length === 0)

  const chosenTiles = Array.isArray(tiles?.chosen) ? tiles.chosen : []
  const accessOk = runtimes.length > 0 || chosenTiles.length > 0

  const trainingOk = used && skills.length > 0

  const oversightOk = used && workflows.some((workflow) => workflow.fire)

  return [
    { rung: 'brief', label: 'Brief', pass: briefOk, detail: briefOk ? 'Business brain filled in' : 'Business brain files missing or still have empty fields' },
    { rung: 'access', label: 'Access', pass: accessOk, detail: accessOk ? 'Tools connected' : 'No connections or runtimes registered yet' },
    { rung: 'training', label: 'Training', pass: trainingOk, detail: trainingOk ? `${skills.length} skill${skills.length === 1 ? '' : 's'} defined` : used ? 'No skills in the repo yet' : 'No runs yet — the repo has not been used' },
    { rung: 'workflows', label: 'Workflows', pass: shiftOk, detail: shiftOk ? 'Something ran on a schedule this week' : 'Nothing has run on a schedule in the last 7 days' },
    { rung: 'oversight', label: 'Oversight', pass: oversightOk, detail: oversightOk ? 'Fire buttons registered' : used ? 'No workflow has fire: true yet' : 'No runs yet — the repo has not been used' }
  ]
}

// Tasks: tasks/*.md is the human to-do list living next to the agents' run logs.
// Frontmatter carries `status: todo|doing|done` and an optional `for: <agent-slug>`;
// the first heading in the body (or, failing that, the filename) is the title. A file
// with no frontmatter at all still parses — its status defaults to todo, because a task
// someone bothered to write down is work until something says otherwise.
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
    const taskPaths = paths.filter((path) => /^tasks\/[^/]+\.md$/.test(path))
    const skillPaths = paths.filter((path) => /^(?:\.claude\/)?skills\/[^/]+\/(?:SKILL|skill)\.md$/.test(path))
    const skillSlugs = [...new Set(skillPaths.map((path) => path.split('/').at(-2)))]
    const hasRuntimes = paths.includes('runtimes.yml')
    const hasTiles = paths.includes('tiles.yml')
    const hasStack = paths.includes('stack.yml')
    const ONBOARDING_STATE = '.agent-team/onboarding-state.md'
    const hasOnboarding = paths.includes(ONBOARDING_STATE)

    const [agentFiles, runFiles, brainFiles, workflowFiles, taskFiles, skillFiles, runtimesSource, tilesSource, onboardingSource, stackSource] =
      await Promise.all([
        Promise.all(agentPaths.map(async (path) => [path, await rawFile(settings, path)])),
        Promise.all(runPaths.map(async (path) => [path, await rawFile(settings, path)])),
        Promise.all(BRAIN_FILES.map(async (path) => [path, await rawFile(settings, path)])),
        Promise.all(workflowPaths.map(async (path) => [path, await rawFile(settings, path)])),
        Promise.all(taskPaths.map(async (path) => [path, await rawFile(settings, path)])),
        Promise.all(skillPaths.map(async (path) => [path, await rawFile(settings, path)])),
        hasRuntimes ? rawFile(settings, 'runtimes.yml') : null,
        hasTiles ? rawFile(settings, 'tiles.yml') : null,
        hasOnboarding ? rawFile(settings, ONBOARDING_STATE) : null,
        hasStack ? rawFile(settings, 'stack.yml') : null
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
        state: stateFor(mine, now)
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
    const workflows = shapeWorkflows(workflowFiles, runs, known, now)
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

    const tiles = tilesSource ? parseSimpleYaml(tilesSource) : null
    const skills = shapeSkills(skillFiles, workflows)
    const stack = shapeStack(stackSource ? parseSimpleYaml(stackSource) : null, paths)
    const memory = shapeMemory(paths, sizes)
    const onboarding = parseOnboardingState(onboardingSource)
    const setup = shapeSetup({ brain, skills: skillSlugs, workflows, runtimes, tiles, runs, onboarding, now })

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
      skills,
      stack,
      memory,
      setup,
      generatedAt: new Date(now).toISOString()
    })
  } catch (error) {
    response.status(error.status === 404 ? 404 : 500).json({ error: error.message })
  }
}
