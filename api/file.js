// Serves one file's text so the Memory screen can open a page in place, phone-first,
// without bouncing the reader out to GitHub. Read-only, same token discipline as
// api/state.js: the token stays on the server and never reaches the browser.

import { viewGate } from './_gate.js'
import { repoFolder, repoReader } from './_repo.js'

const GITHUB = 'https://api.github.com'
const ALLOWED_EXTENSIONS = /\.(md|txt|json|ya?ml)$/i
const MAX_BYTES = 200_000

export function safePath(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const path = raw.trim()
  if (path.length > 500) return null
  if (path.startsWith('/') || path.startsWith('.')) return null
  if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return null
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/.test(path)) return null
  if (!ALLOWED_EXTENSIONS.test(path)) return null
  return path
}

function headers() {
  const base = { Accept: 'application/vnd.github.raw', 'User-Agent': 'agent-cockpit' }
  if (process.env.GITHUB_TOKEN) base.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  return base
}

export default async function handler(request, response) {
  // Never a shared cache, for every answer - the refusals included: a CDN keys on the URL, not the
  // view key, so a copy made for the owner would be served to anyone without one.
  response.setHeader('Cache-Control', 'private, no-store')
  if (String(request?.method ?? 'GET').toUpperCase() !== 'GET') {
    response.setHeader('Allow', 'GET')
    response.status(405).json({ error: 'GET only: this endpoint reads one file and never changes it.' })
    return
  }
  const denied = await viewGate(request)
  if (denied) {
    response.status(denied.status).json({ error: denied.error })
    return
  }
  const owner = process.env.GITHUB_OWNER
  const repo = process.env.GITHUB_REPO
  const branch = process.env.GITHUB_BRANCH || 'main'
  const folder = repoFolder()
  if (!folder && (!owner || !repo)) {
    response.status(500).json({ error: 'Set GITHUB_OWNER and GITHUB_REPO in your hosting environment.' })
    return
  }

  const path = safePath(request.query?.path)
  if (!path) {
    response.status(400).json({ error: 'path must be a plain repo-relative file ending in .md, .txt, .json or .yml' })
    return
  }

  if (folder) {
    // The same answer from the team folder: what is committed on the pushed branch, never a file
    // you have changed and not committed.
    let text
    try {
      text = await repoReader(folder).file(branch, path)
    } catch {
      response.status(502).json({ error: 'The board could not read that file from the team folder.' })
      return
    }
    if (text === null) {
      response.status(404).json({ error: 'That file is not in the team repo.' })
      return
    }
    response.status(200).json({ path, content: text.slice(0, MAX_BYTES) })
    return
  }

  const upstream = await fetch(
    `${GITHUB}/repos/${owner}/${repo}/contents/${encodeURI(path)}?ref=${branch}`,
    { headers: headers() }
  )
  if (!upstream.ok) {
    response.status(upstream.status === 404 ? 404 : 502).json({ error: `GitHub returned ${upstream.status} for that file.` })
    return
  }

  const content = (await upstream.text()).slice(0, MAX_BYTES)
  response.status(200).json({ path, content })
}
