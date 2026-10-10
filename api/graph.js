// The Memory screen's graph: the team repo's own notes as dots and lines (api/_team-graph.js), and the
// Obsidian vaults each computer's collector published (api/_vaults.js).
//
// Asked for only when the Memory screen opens - never with the board - because it reads every note,
// one GitHub call each. So it is not part of /api/state, and the Readiness wall's 60-second check stays
// one call. A second open with nothing new is one call too: the page sends ?since=<the commit it holds>.
//
// The same discipline as api/state.js: read only, the token stays on the server, the whole graph is
// read from one commit, every answer sits behind the view gate and is kept by nobody.

import { viewGate } from './_gate.js'
import { config, gh, headCommit, rawFile, sinceOf, READ_FAILED } from './state.js'
import { buildTeamGraph, isTeamNote, noteOrder, TEAM_CAPS } from './_team-graph.js'
import { shapeVaults, isVaultsFile, VAULTS_MAX_FILES, VAULTS_MAX_BYTES } from './_vaults.js'

// How many notes are read at once. GitHub counts each read against the hourly allowance either way;
// this only keeps a large repo from opening hundreds of connections at the same moment.
export const READS_AT_ONCE = 8

async function eachLimited(items, limit, work) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await work(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

export default async function handler(request, response) {
  // Every answer sits behind the view key, and a shared cache keys on the address, not the key: so
  // none is kept. Set before anything else, so a refusal carries it too.
  response.setHeader('Cache-Control', 'private, no-store')
  if (String(request?.method ?? 'GET').toUpperCase() !== 'GET') {
    response.setHeader('Allow', 'GET')
    response.status(405).json({ error: 'GET only: this endpoint reads your team repo and never changes it.' })
    return
  }
  // As /api/state: a "has it changed?" check is let through without asking the picture store about
  // "sign out everywhere" (that read is billed), and checked in full only if it has changed.
  const polling = sinceOf(request) !== null
  const full = { response }
  const denied = await viewGate(request, process.env, polling ? { checkSignOut: false } : full)
  if (denied) {
    response.status(denied.status).json({ error: denied.error })
    return
  }
  try {
    const base = config()
    const { owner, repo } = base
    const head = await headCommit(base)
    if (head !== null && head === sinceOf(request)) {
      response.status(200).json({ unchanged: true, commit: head })
      return
    }
    if (polling) {
      const late = await viewGate(request, process.env, full)
      if (late) {
        response.status(late.status).json({ error: late.error })
        return
      }
    }
    const settings = head === null ? base : { ...base, branch: head }
    const tree = await gh(`/repos/${owner}/${repo}/git/trees/${settings.branch}?recursive=1`)
    const blobs = (tree.tree ?? []).filter((node) => node.type === 'blob')
    const sizes = Object.fromEntries(blobs.map((node) => [node.path, node.size ?? null]))
    const paths = blobs.map((node) => node.path)

    // A note the tree says is too big is not read and not a dot; it is counted. Past the cap, the rest
    // are counted too, in the order the dots are numbered.
    const notes = noteOrder(paths.filter(isTeamNote))
    const small = notes.filter((path) => (sizes[path] ?? 0) <= TEAM_CAPS.bytes)
    const toRead = small.slice(0, TEAM_CAPS.notes)
    // The vaults files on the same terms as every status file: five read, none the tree calls too big.
    const vaultPaths = paths.filter(isVaultsFile).sort()
    const vaultsToRead = vaultPaths.slice(0, VAULTS_MAX_FILES)
    const vaultBody = (path) => ((sizes[path] ?? 0) > VAULTS_MAX_BYTES ? null : rawFile(settings, path))

    // Notes and vaults files share the one limit on reads at a time.
    const bodies = await eachLimited([...toRead, ...vaultsToRead], READS_AT_ONCE,
      (path, index) => (index < toRead.length ? rawFile(settings, path) : vaultBody(path)))
    const texts = bodies.slice(0, toRead.length)
    const vaultFiles = vaultsToRead.map((path, index) => [path, bodies[toRead.length + index]])
    const team = buildTeamGraph(toRead.map((path, index) => ({ path, text: texts[index] })))
    const now = Date.now()
    response.status(200).json({
      commit: head,
      team: {
        ...team,
        // Too big to read; past the cap; listed but not returned by GitHub (still a dot, with no lines).
        hidden: notes.length - small.length,
        more: small.length - toRead.length,
        unread: texts.filter((text) => typeof text !== 'string').length
      },
      vaults: shapeVaults(vaultFiles, now, vaultPaths.length),
      generatedAt: new Date(now).toISOString()
    })
  } catch (error) {
    if (error.retryAfter !== undefined) {
      response.setHeader('Retry-After', String(error.retryAfter))
      response.status(429).json({ error: `GitHub's rate limit was reached. Try again in ${error.retryAfter} seconds.` })
      return
    }
    response.status(error.status === 404 ? 404 : 500).json({ error: error.ours ? error.message : READ_FAILED })
  }
}
