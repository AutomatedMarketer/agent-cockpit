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
  heartbeatStatus
} from './lib.js'
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
    const skillSlugs = [
      ...new Set(
        paths
          .map((path) => /^(?:\.claude\/)?skills\/([^/]+)\/(?:SKILL|skill)\.md$/.exec(path)?.[1])
          .filter(Boolean)
      )
    ]
    const hasRuntimes = paths.includes('runtimes.yml')
    const hasTiles = paths.includes('tiles.yml')
    const ONBOARDING_STATE = '.agent-team/onboarding-state.md'
    const hasOnboarding = paths.includes(ONBOARDING_STATE)

    const [agentFiles, runFiles, brainFiles, workflowFiles, runtimesSource, tilesSource, onboardingSource] =
      await Promise.all([
        Promise.all(agentPaths.map(async (path) => [path, await rawFile(settings, path)])),
        Promise.all(runPaths.map(async (path) => [path, await rawFile(settings, path)])),
        Promise.all(BRAIN_FILES.map(async (path) => [path, await rawFile(settings, path)])),
        Promise.all(workflowPaths.map(async (path) => [path, await rawFile(settings, path)])),
        hasRuntimes ? rawFile(settings, 'runtimes.yml') : null,
        hasTiles ? rawFile(settings, 'tiles.yml') : null,
        hasOnboarding ? rawFile(settings, ONBOARDING_STATE) : null
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
      brain,
      workflows,
      runtimes,
      memory,
      setup,
      generatedAt: new Date(now).toISOString()
    })
  } catch (error) {
    response.status(error.status === 404 ? 404 : 500).json({ error: error.message })
  }
}
