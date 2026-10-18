// The Mac's own status file, read for the board (the Mac mailbox, plan 2026-10-12-mac-mailbox): which jobs the
// computer will run, and - for the Codex worker (T14) - which of them are Codex's and whether Codex is ready.
// Starts with "_" so Vercel does not turn it into an endpoint.
//
// Read as a stranger's file: shaped by state.js (the contract's keys only), three seconds at most, and
// anything wrong - no file, not the contract's, too big, GitHub slow or down - reads as no status, never a guess.

import { MAILBOX_CONTRACT } from './_mailbox.js'
import { shapeMailbox, MAILBOX_FOLDER } from './state.js'
import { repoFolder, repoReader } from './_repo.js'

// One read of the order's own runner: the team folder, or GitHub with the board's read-only token.
const MAC_STATUS_WAIT_MS = 3000
export async function readMacStatus(env, runner, now = Date.now()) {
  if (typeof runner !== 'string' || !MAILBOX_CONTRACT.runnerShape.test(runner)) return null
  const folder = repoFolder(env)
  if (folder) {
    // The same status file, from the team folder instead of GitHub; the same three-second wait.
    const branch = (typeof env.GITHUB_BRANCH === 'string' && env.GITHUB_BRANCH.trim()) || 'main'
    const path = `${MAILBOX_FOLDER}/${runner}.json`
    try {
      const body = await Promise.race([
        repoReader(folder).file(branch, path),
        new Promise((resolve) => setTimeout(() => resolve(null), MAC_STATUS_WAIT_MS).unref?.())
      ])
      if (body === null) return null
      const shaped = shapeMailbox([[path, body]], now, 1)
      return shaped.status === 'ok' ? shaped.computers[0] : null
    } catch {
      return null
    }
  }
  const owner = typeof env.GITHUB_OWNER === 'string' ? env.GITHUB_OWNER.trim() : ''
  const repo = typeof env.GITHUB_REPO === 'string' ? env.GITHUB_REPO.trim() : ''
  if (!MAILBOX_CONTRACT.repoShape.test(`${owner}/${repo}`)) return null
  const branch = (typeof env.GITHUB_BRANCH === 'string' && env.GITHUB_BRANCH.trim()) || 'main'
  const path = `${MAILBOX_FOLDER}/${runner}.json`
  const headers = { Accept: 'application/vnd.github.raw', 'User-Agent': 'agent-cockpit' }
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`
  try {
    const answer = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`, {
      headers,
      signal: AbortSignal.timeout(MAC_STATUS_WAIT_MS)
    })
    if (!answer.ok) return null
    const body = await answer.text()
    const shaped = shapeMailbox([[path, body]], now, 1)
    return shaped.status === 'ok' ? shaped.computers[0] : null
  } catch {
    return null
  }
}

// Where the Codex worker stands for one job, from a computer's shaped status (readMacStatus):
//   'ready'      the job is Codex's on that computer, and Codex is ready now
//   'not-ready'  the job is Codex's, and Codex is not ready (the computer's own check found a problem)
//   'not-codex'  the computer does not give this job to Codex, or says nothing about workers
//   'no-status'  the computer has not said anything the board can use
// The page and the voice hold the same rule over data.mailbox (codexOnBoard in public/app.js and api/_voice.js);
// tests/worker-page.test.mjs holds the three together.
export function codexStanding(computer, slug) {
  if (!computer || typeof computer !== 'object') return 'no-status'
  const allows = computer.allows
  if (!allows || !Array.isArray(allows.codexJobs) || !Array.isArray(allows.workers) || !allows.codexJobs.includes(slug)) return 'not-codex'
  return allows.workers.includes('codex') ? 'ready' : 'not-ready'
}
