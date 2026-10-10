// Signing out of this device: the cookie is taken away. POST {} as JSON from the board's own page.
//
// Only from the board itself and only as JSON, like every change, so another site cannot sign the
// owner out behind their back. No key is needed to take your own cookie away.

import { isSameOriginRequest } from './_lib.js'
import { clearedSessionCookie } from './_session.js'

export function makeHandler() {
  return async function handler(request, response) {
    response.setHeader('Cache-Control', 'private, no-store')
    if (String(request?.method ?? 'GET').toUpperCase() !== 'POST') {
      response.setHeader('Allow', 'POST')
      response.status(405).json({ error: 'POST {} from the board to sign out of this device.' })
      return
    }
    const headers = request?.headers ?? {}
    if (!isSameOriginRequest(headers)) {
      response.status(403).json({ error: 'Signing out is only accepted from the board itself.' })
      return
    }
    const essence = String(headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (essence !== 'application/json') {
      response.status(415).json({ error: 'Send this as Content-Type: application/json.' })
      return
    }
    response.setHeader('Set-Cookie', clearedSessionCookie())
    response.status(204).end()
  }
}

export default makeHandler()
