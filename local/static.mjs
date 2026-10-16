import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
}

const PLAIN = { 'Content-Type': 'text/plain; charset=utf-8' }

// A request path to a path inside public/, or null if it could point anywhere else. Every
// refusal is on the decoded text, so %2e%2e%2f and friends are caught too.
export function safeRelativePath(pathname) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (/[\0\\:]/.test(decoded)) return null // NUL, backslash, drive letter / Windows stream marker
  const segments = decoded.split('/').filter((part) => part !== '')
  if (segments.some((part) => part.startsWith('.'))) return null // '.', '..' and hidden files
  return segments.join('/')
}

async function fileAt(publicRoot, relative) {
  try {
    const real = await realpath(join(publicRoot, relative))
    if (real !== publicRoot && !real.startsWith(publicRoot + sep)) return null // a link out of public/
    return (await stat(real)).isFile() ? real : null
  } catch {
    return null
  }
}

// Serves public/ the way vercel.json's cleanUrls does: "/" is index.html, "/x" finds x or x.html,
// and "/x.html" is sent on to "/x". Returns { status, headers, body } and never throws.
export async function serveStatic(publicRootInput, method, pathname) {
  if (method !== 'GET' && method !== 'HEAD') {
    return { status: 405, headers: { Allow: 'GET, HEAD', ...PLAIN }, body: 'Method Not Allowed' }
  }
  const publicRoot = await realpath(publicRootInput)
  const relative = safeRelativePath(pathname)
  if (relative === null) return { status: 400, headers: PLAIN, body: 'Bad request' }

  if (relative.endsWith('.html')) {
    const clean = relative === 'index.html' ? '/' : '/' + relative.slice(0, -'.html'.length)
    return { status: 308, headers: { Location: clean }, body: '' }
  }
  const file = (await fileAt(publicRoot, relative === '' ? 'index.html' : relative)) ?? (relative ? await fileAt(publicRoot, relative + '.html') : null)
  if (!file) return { status: 404, headers: PLAIN, body: 'Not found' }
  return {
    status: 200,
    headers: {
      'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=0, must-revalidate'
    },
    body: await readFile(file)
  }
}
