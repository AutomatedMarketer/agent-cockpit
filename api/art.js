// /api/art?slot=<slot>&v=<version>&t=<webp|jpeg|png>: one picture from the board's PRIVATE
// picture store, to someone holding the view key (spec 5c).
//
// An <img> cannot send the view key, so the page fetches each picture with the key and shows it
// from memory as a blob: URL. This endpoint is a read: the view gate only, never the edit key.
//
// - slot, v and t are checked before the store is touched, so no other path can be asked for.
//   They are exactly what /api/brand hands the page; t names the extension the picture was
//   stored under, which saves reading settings.json on every picture.
// - The bytes are checked again on the way out, and the Content-Type comes from them - not from
//   the path, the store's record or the URL. A file planted in the store that is not a picture
//   is refused, never served from the board's own origin.
// - A version is never overwritten, so its answer can be cached forever - privately, because it
//   sits behind the view key and must not be kept by a shared cache.

import { viewGate, parseSlot, sniffImage } from './lib.js'
import { pictureStore, isPictureVersion, NOT_CONNECTED, failureAnswer } from './_picture-store.js'

const TYPES = { webp: 'image/webp', jpeg: 'image/jpeg', png: 'image/png' }
const FOREVER = 'private, max-age=31536000, immutable'

// Each value must be a single string of exactly our own shape; a repeated query parameter
// arrives as an array and is refused with the rest.
function parseRequest(query = {}) {
  const slot = parseSlot(query.slot)
  const version = isPictureVersion(query.v) ? query.v : null
  const type = typeof query.t === 'string' && Object.hasOwn(TYPES, query.t) ? TYPES[query.t] : null
  return slot && version && type ? { slot, version, type } : null
}

// `store` is injected by the tests; left undefined, it is built from the environment on each
// request (null when no store is connected).
export function makeHandler({ store, env, loadSdk } = {}) {
  return async function handler(request, response) {
    const environment = env ?? process.env
    if (String(request?.method ?? 'GET').toUpperCase() !== 'GET') {
      response.setHeader('Allow', 'GET')
      response.status(405).json({ error: 'GET /api/art?slot=<slot>&v=<version>&t=<webp|jpeg|png>.' })
      return
    }
    // Every answer but the picture itself is not to be kept: a refusal cached "forever" would
    // outlive the fix for it.
    response.setHeader('Cache-Control', 'no-store')

    const denied = viewGate(request, environment)
    if (denied) {
      response.status(denied.status).json({ error: denied.error })
      return
    }

    const wanted = parseRequest(request.query)
    if (!wanted) {
      response.status(400).json({ error: 'Ask for a picture as slot, v and t, exactly as /api/brand gives them.' })
      return
    }

    const pictures = store !== undefined ? store : pictureStore(environment, loadSdk)
    if (!pictures) {
      response.status(503).json({ error: NOT_CONNECTED })
      return
    }

    try {
      const bytes = await pictures.getPicture(wanted.slot, wanted.version, wanted.type)
      if (!bytes) {
        response.status(404).json({ error: 'That picture is not in the store any more, so reload the board.' })
        return
      }
      const type = sniffImage(bytes)
      if (!type) {
        response.status(502).json({ error: 'That stored file is not a picture, so the board will not show it.' })
        return
      }
      response.setHeader('Content-Type', type)
      response.setHeader('Cache-Control', FOREVER)
      response.setHeader('X-Content-Type-Options', 'nosniff')
      response.status(200).end(bytes)
    } catch (error) {
      const { status, error: sentence } = failureAnswer(error)
      response.status(status).json({ error: sentence })
    }
  }
}

export default makeHandler()
