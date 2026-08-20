// Serves one file's text so the Memory screen can open a page in place, phone-first,
// without bouncing the reader out to GitHub. Read-only, same token discipline as
// api/state.js: the token stays on the server and never reaches the browser.

import { viewGate } from './lib.js'

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
  const denied = viewGate(request)
  if (denied) {
    response.status(denied.status).json({ error: denied.error })
    return
  }
  const owner = process.env.GITHUB_OWNER
  const repo = process.env.GITHUB_REPO
  const branch = process.env.GITHUB_BRANCH || 'main'
  if (!owner || !repo) {
    response.status(500).json({ error: 'Set GITHUB_OWNER and GITHUB_REPO in your hosting environment.' })
    return
  }

  const path = safePath(request.query?.path)
  if (!path) {
    response.status(400).json({ error: 'path must be a plain repo-relative file ending in .md, .txt, .json or .yml' })
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
  response.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300')
  response.status(200).json({ path, content })
}
