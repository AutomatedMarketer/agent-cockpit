// Signing out. POST {} as JSON from the board's own page takes the cookie away on this device;
// POST { "everywhere": true } signs every device out, this one included.
//
// This device: only from the board itself and only as JSON, like every change, so another site
// cannot sign the owner out behind their back. No key is needed to take your own cookie away.
//
// Everywhere: a change like any other - the view gate (a signed-in device or the view key), the edit
// key when one is set, the board itself, JSON - so a viewer of a shared board cannot sign the owner
// out. It is kept as a moment in the picture store's settings.json (sessionsValidFrom): every session
// signed in before it is refused by every server once it has read the file, which takes up to about
// a minute and a half (this server's copy is kept 30 seconds, the store's cache 60). It costs one
// store write, counted in the day's changes. With no store, changing VIEW_KEY or BOARD_PASSWORD
// does the same, at once, and the answer says so.

import { isSameOriginRequest, readJsonBody } from './_lib.js'
import { writeGate } from './_gate.js'
import { clearedSessionCookie } from './_session.js'
import { pictureStore, dailyCaps, usageDay, spendAllowance, refuseIfSpent, failureAnswer } from './_picture-store.js'

const NO_STORE =
  'Signing out everywhere is kept in the picture store, and this board has none connected. To sign ' +
  'every device out without one, change VIEW_KEY (or BOARD_PASSWORD) in Vercel and redeploy.'

// `store`, `env`, `now` and `loadSdk` are handed in by the tests; left out, they are the real ones.
export function makeHandler({ store, env, now = () => new Date(), loadSdk } = {}) {
  return async function handler(request, response) {
    const environment = env ?? process.env
    response.setHeader('Cache-Control', 'private, no-store')
    if (String(request?.method ?? 'GET').toUpperCase() !== 'POST') {
      response.setHeader('Allow', 'POST')
      response.status(405).json({ error: 'POST {} to sign out of this device, or { "everywhere": true } for every device.' })
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

    if (readJsonBody(request)?.everywhere === true) {
      const pictures = store !== undefined ? store : pictureStore(environment, loadSdk)
      const denied = await writeGate(request, environment, 'application/json', { store: pictures })
      if (denied) {
        const { status, ...answer } = denied
        response.status(status).json(answer)
        return
      }
      if (!pictures) {
        response.status(503).json({ error: NO_STORE })
        return
      }
      const moment = now()
      const caps = dailyCaps(environment)
      const day = usageDay(moment)
      try {
        const charge = (settings) => spendAllowance(settings, 'writes', caps, day, { now: moment })
        await refuseIfSpent(pictures, charge)
        await pictures.saveSettings((draft) => {
          charge(draft)
          // Never backwards: a press handled late by a server with a slow clock cannot let back in
          // the devices an earlier press signed out.
          draft.sessionsValidFrom = Math.max(draft.sessionsValidFrom, moment.getTime())
        })
      } catch (error) {
        const { status, error: sentence } = failureAnswer(error)
        response.status(status).json({ error: sentence })
        return
      }
    }

    response.setHeader('Set-Cookie', clearedSessionCookie())
    response.status(204).end()
  }
}

export default makeHandler()
