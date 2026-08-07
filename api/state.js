// One request from the browser, one JSON payload back.
//
// The cockpit reads the team repo and nothing else. There is no database, no Anthropic
// API call, and no run-history endpoint to reverse-engineer — Routines does not publish
// one. Everything on the page comes from files the agents committed.
//
// The GitHub token, when there is one, stays on the server. A private team repo works;
// the token never reaches the browser.

import { parseFrontmatter, daysSince, stateFor, fillMarkers, sortRunsNewestFirst } from './lib.js'

const GITHUB = 'https://api.github.com'
const AGENT_DIR = '.claude/agents'
const BRAIN_FILES = ['shared/about-me.md', 'shared/business-brain.md', 'shared/writing-rules.md']
const MAX_RUNS_RETURNED = 50

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

export default async function handler(request, response) {
  try {
    const settings = config()
    const { owner, repo, branch } = settings

    // One tree call gives every path in the repo. Cheaper than walking directories.
    const tree = await gh(`/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`)
    const paths = (tree.tree ?? []).filter((node) => node.type === 'blob').map((node) => node.path)

    const agentPaths = paths.filter((path) => path.startsWith(`${AGENT_DIR}/`) && path.endsWith('.md'))
    const runPaths = paths.filter((path) => /^runs\/\d{4}-\d{2}\/.+\.json$/.test(path))

    const [agentFiles, runFiles, brainFiles] = await Promise.all([
      Promise.all(agentPaths.map(async (path) => [path, await rawFile(settings, path)])),
      Promise.all(runPaths.map(async (path) => [path, await rawFile(settings, path)])),
      Promise.all(BRAIN_FILES.map(async (path) => [path, await rawFile(settings, path)]))
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
        runsThisWeek: mine.filter((run) => (daysSince(run.started_at) ?? 99) <= 7).length,
        totalRuns: mine.length,
        state: stateFor(mine)
      }
    })

    const brain = brainFiles.map(([path, body]) => ({
      path,
      present: body !== null,
      missing: fillMarkers(body)
    }))

    response.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300')
    response.status(200).json({
      repo: { owner, repo, branch, url: `https://github.com/${owner}/${repo}` },
      agents: agents.sort((a, b) => a.slug.localeCompare(b.slug)),
      runs: runs.slice(0, MAX_RUNS_RETURNED),
      totalRuns: runs.length,
      unparseableRuns: unparseable,
      brain,
      generatedAt: new Date().toISOString()
    })
  } catch (error) {
    response.status(error.status === 404 ? 404 : 500).json({ error: error.message })
  }
}
