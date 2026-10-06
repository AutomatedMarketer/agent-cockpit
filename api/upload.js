// /api/upload?slot=<slot>: one picture into the board's own picture store (spec 5c).
//
// The browser has already cropped and shrunk the picture (canvas -> webp, JPEG where webp cannot
// be made) and sends the raw bytes as application/octet-stream. Nothing here trusts that: the
// order of checks below is the contract, and each one refuses before anything is written.
//
//   write gate -> a store is connected -> the slot -> real picture bytes, with a readable size
//   of at most 2048 pixels a side -> under the size budget -> count the change AND point settings.json at the new version, in one save ->
//   store the picture -> remove the picture it replaced (best effort)
//
// Counting comes first, in the same save as the pointer, because that save is the only place the
// count is safe from a second upload arriving at the same moment (it is written with ifMatch).
// Checked on a copy instead, two hundred uploads at once all passed the check and all stored a
// picture - an advanced operation each, 2,000 a month on Hobby. Now a picture is stored only for a
// change that was counted. If storing it fails, the pointer goes back to the old picture (best
// effort) and the change stays counted: giving it back would be one more write, and a store that
// keeps failing could then be tried for ever without the count moving.
//
// What the picture IS comes from its bytes. The path's extension, the stored content type and
// the pointer are all taken from sniffImage, never from a header or a query the sender typed.
// Each picture gets a new version made here, so it is written once, never overwritten, and a
// cached copy of it can never be the wrong picture.

import { randomBytes } from 'node:crypto'
import { writeGate, parseSlot, slotKind, PICTURE_BUDGET, sniffImage, imageSize } from './lib.js'
import {
  pictureStore,
  NOT_CONNECTED,
  failureAnswer,
  dailyCaps,
  usageDay,
  allowanceLeft,
  spendAllowance
} from './_picture-store.js'

// 16 lowercase hex characters: inside the store's ^[a-z0-9]{8,32}$, and 64 random bits, so two
// uploads never meet on one path.
export const newVersion = () => randomBytes(8).toString('hex')

const NOT_A_PICTURE = 'That is not a picture this board accepts: send a webp, JPEG or PNG.'

// The board's own pictures are at most 1600 pixels wide (a banner), so 2048 is room to spare. A
// picture can be a few KB as a file and gigabytes once decoded, and every viewer's browser
// decodes what is kept here.
export const MAX_PICTURE_SIDE = 2048

// The body as bytes, read no further than one byte past the limit - enough to know it is too
// big, without holding all of something that is. Vercel hands an octet-stream body over as a
// Buffer; a plain request stream is read here instead. Anything else (a string, nothing at all)
// is no bytes, which sniffImage then refuses.
async function readBytes(request, limit) {
  const body = request?.body
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  if (body === undefined && typeof request?.[Symbol.asyncIterator] === 'function') {
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      const part = Buffer.from(chunk)
      chunks.push(part)
      size += part.length
      if (size > limit) break // leaving the loop stops the stream
    }
    return Buffer.concat(chunks)
  }
  return Buffer.alloc(0)
}

// After the picture could not be stored: the slot back on the picture it showed before, which
// was never removed. Only if the slot still points at the version that failed - if another change
// has moved it on since, that one stands. Best effort: if this fails too, the slot points at a
// picture that is not there, /api/art answers 404 and the board shows its built-in picture.
async function pointBack(pictures, slot, failed, previous) {
  const unchanged = new Error('the slot has moved on')
  await pictures.saveSettings((draft) => {
    // Throwing stops the save, so a slot that has moved on costs no write at all.
    if (draft.pictures[slot]?.v !== failed) throw unchanged
    if (previous) draft.pictures[slot] = previous
    else delete draft.pictures[slot]
  }).catch(() => {})
}

// `store` is injected by the tests; left undefined, it is built from the environment on each
// request (null when no store is connected).
export function makeHandler({ store, env, now = () => new Date(), loadSdk, version = newVersion } = {}) {
  return async function handler(request, response) {
    const environment = env ?? process.env
    if (String(request?.method ?? 'GET').toUpperCase() !== 'POST') {
      response.setHeader('Allow', 'POST')
      response.status(405).json({ error: 'POST the picture\'s bytes to /api/upload?slot=<slot>.' })
      return
    }
    response.setHeader('Cache-Control', 'no-store')

    const denied = writeGate(request, environment, 'application/octet-stream')
    if (denied) {
      const { status, ...answer } = denied
      response.status(status).json(answer)
      return
    }

    const pictures = store !== undefined ? store : pictureStore(environment, loadSdk)
    if (!pictures) {
      response.status(503).json({ error: NOT_CONNECTED })
      return
    }

    const slot = parseSlot(request.query?.slot)
    if (!slot) {
      response.status(400).json({ error: 'slot must be "today", "team" or "agent-<slug>".' })
      return
    }

    const kind = slotKind(slot)
    const budget = PICTURE_BUDGET[kind]
    const bytes = await readBytes(request, budget)
    const type = sniffImage(bytes)
    const size = imageSize(bytes)
    if (!type || !size) {
      response.status(415).json({ error: NOT_A_PICTURE })
      return
    }
    if (size.width > MAX_PICTURE_SIDE || size.height > MAX_PICTURE_SIDE) {
      response.status(413).json({
        error: `That picture is ${size.width} by ${size.height} pixels, and the board keeps nothing over ${MAX_PICTURE_SIDE} on a side, so shrink it and try again.`
      })
      return
    }
    if (bytes.length > budget) {
      response.status(413).json({
        error: `That picture is over the ${budget / 1024} KB limit for ${kind === 'portrait' ? 'a portrait' : 'a banner'}, so shrink it and try again.`
      })
      return
    }

    const caps = dailyCaps(environment)
    const moment = now()
    const day = usageDay(moment)
    try {
      const v = version()
      let replaced = null
      const saved = await pictures.saveSettings((draft) => {
        spendAllowance(draft, 'writes', caps, day)
        replaced = draft.pictures[slot] ?? null
        draft.pictures[slot] = { v, type, bytes: bytes.length, at: moment.toISOString() }
      })

      try {
        await pictures.putPicture(slot, v, bytes, type)
      } catch (error) {
        await pointBack(pictures, slot, v, replaced)
        throw error
      }
      // Only now that nothing points at it. A failed delete leaves a file nobody points at.
      if (replaced) await pictures.dropPicture(slot, replaced.v, replaced.type).catch(() => {})

      response.status(200).json({ slot, picture: { v, type }, left: allowanceLeft(saved, caps, day) })
    } catch (error) {
      const { status, error: sentence } = failureAnswer(error)
      response.status(status).json({ error: sentence })
    }
  }
}

export default makeHandler()
