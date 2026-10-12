// GET /api/mailbox: the one question the owner's computer asks the board - "any orders for me?"
// (plan 2026-10-12-mac-mailbox, 2.1). Mailbox mode only (FIRE_MODE=mailbox, api/_mailbox.js).
//
// Who may ask: only the computer, with its own key (MAILBOX_KEY) in Authorization: Bearer, compared in
// constant time. Never the view key, never a signed-in cookie, never a browser: the computer has no
// business with the board's other keys, and the board's other keys have no business here. Every
// request a browser makes carries Sec-Fetch-Site (and a cross-origin one Origin), so a request with
// either is refused before the key is looked at. Node's own fetch, which the computer uses, sends
// neither.
//
// What it answers: the queue's good, unexpired orders, oldest first, the envelopes exactly as the
// board stored them (signed, so the computer checks every one itself), and the pace the board asks
// for. One fresh read of one small file per poll - a simple operation - and no write: orders leave
// the queue only by expiring, and the computer remembers what it took in its own claim folders.
//
// What it never answers: the signing secret, the key, or which setting is wrong. A board not in
// mailbox mode, or not set up, is one sentence, the same for everyone who asks. The key is checked
// before the store is touched, so a stranger guessing keys costs no store operation.

import { keysMatch } from './_lib.js'
import { mailboxConfig, pendingOrders, MAILBOX_CONTRACT } from './_mailbox.js'
import { pictureStore, failureAnswer } from './_picture-store.js'

const OFF = 'The Mac mailbox is not switched on for this board.'
const WRONG_KEY = 'Missing or wrong mailbox key.'
const BROWSER = 'The mailbox answers only your computer, never a browser.'

export function makeHandler({ env, loadSdk, now = () => new Date() } = {}) {
  return async function handler(request, response) {
    // Kept by nobody, every answer: the orders are the owner's own words for up to an hour.
    response.setHeader('Cache-Control', 'private, no-store')
    if (String(request?.method ?? 'GET').toUpperCase() !== 'GET') {
      response.setHeader('Allow', 'GET')
      response.status(405).json({ error: 'GET only, with the computer\'s key in Authorization: Bearer.' })
      return
    }
    const headers = request?.headers ?? {}
    if (headers['sec-fetch-site'] !== undefined || headers.origin !== undefined) {
      response.status(403).json({ error: BROWSER })
      return
    }
    const environment = env ?? process.env
    const config = mailboxConfig(environment)
    if (!config.ready) {
      response.status(503).json({ error: OFF })
      return
    }
    const header = typeof headers.authorization === 'string' ? headers.authorization : ''
    const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
    if (!keysMatch(provided, config.key)) {
      response.status(401).json({ error: WRONG_KEY })
      return
    }
    try {
      const orders = await pendingOrders(pictureStore(environment, loadSdk), config, now())
      response.status(200).json({ v: MAILBOX_CONTRACT.version, pollSeconds: config.pollSeconds, orders })
    } catch (error) {
      const { status, error: sentence } = failureAnswer(error)
      response.status(status).json({ error: sentence })
    }
  }
}

export default makeHandler()
