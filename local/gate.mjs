// The sign-in wall for the board on this computer (task T4).
//
// How a person gets in: the starter prints one link. Opening it swaps the link for a cookie and
// sends the browser on to the board, so the link is no longer in the address bar. The link works
// once and only for 2 minutes. The cookie is HttpOnly (a script on the page cannot read it),
// SameSite=Strict (another site's page cannot ride it), and is tied to THIS run of the server:
// stop and start the board and every old cookie and link is dead.
//
// What the board's own handlers see: the gate adds the per-run x-view-key they already understand
// (api/_gate.js viewGate), so api/*.js run unchanged. The website's sign-in (api/login.js) is not
// involved here and is not changed.
//
// Plugs into createBoardServer({ gate }) - which runs after the Host check, so a page on another
// name never gets this far.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const OPEN_PATH = '/open-board'
// The port is in the name: two boards on one computer keep their own cookies (a browser shares
// cookies between ports on 127.0.0.1, so one name would make each sign the other out).
export const cookieName = (port) => `board_local_${port}`
export const LINK_LIFETIME_MS = 2 * 60 * 1000

const digest = (value) => createHash('sha256').update(String(value)).digest()
// Both sides are hashed to the same length first, so the compare never throws and never leaks length.
const sameSecret = (given, wanted) => timingSafeEqual(digest(given), digest(wanted))

// Every value sent under this name. A page on another port of 127.0.0.1 can plant a cookie with the
// same name, so a junk one must not hide the real one: the request is good if ANY value is.
function readCookies(headers, name) {
  const values = []
  for (const part of String(headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at > 0 && part.slice(0, at).trim() === name) values.push(part.slice(at + 1).trim())
  }
  return values
}

function refuse(response, status, text, json) {
  response.statusCode = status
  response.setHeader('Cache-Control', 'no-store')
  if (json) {
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.end(JSON.stringify({ error: text }))
  } else {
    response.setHeader('Content-Type', 'text/plain; charset=utf-8')
    response.end(text)
  }
  return false
}

export function createLocalGate({ now = Date.now } = {}) {
  const runSecret = randomBytes(32) // cookies are only good for the run that made them
  const viewKey = randomBytes(24).toString('hex') // what the handlers' own view gate is given
  const links = [] // { hash, expires, used }

  const mac = (nonce) => createHmac('sha256', runSecret).update(nonce).digest('base64url')
  const valueIsGood = (value) => {
    const dot = value.indexOf('.')
    if (dot < 1) return false
    return sameSecret(value.slice(dot + 1), mac(value.slice(0, dot)))
  }
  // No early exit: every value is checked, so timing does not say which one was close.
  const cookieIsGood = (values) => values.map(valueIsGood).includes(true)

  // A fresh one-time link's secret part. The caller builds the address and prints it - once.
  function issueOpenToken() {
    const token = randomBytes(32).toString('base64url')
    links.push({ hash: digest(token), expires: now() + LINK_LIFETIME_MS, used: false })
    return token
  }

  // Looks at every outstanding link (no early exit) so timing does not say which one was close.
  function takeToken(given) {
    const hash = digest(given)
    let found = null
    for (const link of links) {
      if (timingSafeEqual(hash, link.hash) && !found) found = link
    }
    if (!found || found.used || now() > found.expires) return false
    found.used = true
    return true
  }

  function isSameOrigin(request) {
    const fetchSite = String(request.headers['sec-fetch-site'] ?? '').toLowerCase()
    if (fetchSite && fetchSite !== 'same-origin') return false
    const origin = String(request.headers.origin ?? '').toLowerCase()
    const port = request.socket.localPort
    return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`
  }

  async function gate(request, response) {
    const { pathname, search } = splitUrl(request.url)
    const isApi = pathname === '/api' || pathname.startsWith('/api/')
    const opensLink = pathname === OPEN_PATH && request.method === 'GET'

    // A page on another site - or on another port of this computer, which counts as "same-site" -
    // may not make the browser call the board at all, reads included (a read can cost money). A
    // typed address or a bookmark says "none", the board's own page says "same-origin". Only the
    // one-time link may come from elsewhere: the file the starter opens is "another site".
    if (!opensLink) {
      const fetchSite = String(request.headers['sec-fetch-site'] ?? '').toLowerCase()
      if (fetchSite === 'same-site' || fetchSite === 'cross-site') {
        return refuse(response, 403, 'That did not come from the own page.', isApi)
      }
    }

    if (opensLink) {
      const token = new URLSearchParams(search).get('t') ?? ''
      if (!token || !takeToken(token)) {
        return refuse(response, 403, 'This link was already used or has run out. Close this window and start the board again.')
      }
      const nonce = randomBytes(24).toString('base64url')
      response.setHeader('Set-Cookie', `${cookieName(request.socket.localPort)}=${nonce}.${mac(nonce)}; Path=/; HttpOnly; SameSite=Strict`)
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('Location', '/')
      response.statusCode = 303
      response.end()
      return false
    }

    if (!cookieIsGood(readCookies(request.headers, cookieName(request.socket.localPort)))) {
      return refuse(response, 401, 'Open the board with the link shown in the window that started it.', isApi)
    }
    // Every change must come from the board's own page: another site's page can make the browser
    // send the cookie only with a stamp that says so (and the cookie is SameSite=Strict as well).
    if (request.method !== 'GET' && request.method !== 'HEAD' && !isSameOrigin(request)) {
      return refuse(response, 403, 'That did not come from the board\'s own page.', isApi)
    }
    request.headers['x-view-key'] = viewKey
    return true
  }

  return { gate, issueOpenToken, viewKey }
}

function splitUrl(url) {
  const raw = String(url)
  const at = raw.indexOf('?')
  return at === -1 ? { pathname: raw.split('#')[0], search: '' } : { pathname: raw.slice(0, at), search: raw.slice(at + 1).split('#')[0] }
}

// The settings the board's handlers read from the environment, set for a run on this computer.
// Whatever the computer already had is replaced (a stray VIEW_KEY must not decide who gets in).
export function applyLocalEnv(viewKey, env = process.env) {
  env.VIEW_KEY = viewKey
  env.PUBLIC_FIRE = 'true' // the fire key is waived; the view gate and same-origin check still run
  delete env.PUBLIC_DASHBOARD
  delete env.EDIT_KEY
  delete env.BOARD_PASSWORD
  delete env.BOARD_USERNAME
}
