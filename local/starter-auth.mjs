// How a second "Start Board" proves itself to the running board, and the board to it, WITHOUT the
// per-run secret ever being sent. The starter sends a fresh nonce and a time with a code made from
// the secret; the board checks the code, and answers with the link plus a second code over the
// nonce and the link. A program that merely listens on the same port (the board has stopped and
// something else took its place) cannot make that second code, so the starter never opens a page
// it did not get from the real board.

import { createHmac, timingSafeEqual } from 'node:crypto'

export const ASK_WINDOW_MS = 60_000

const code = (secret, text) => createHmac('sha256', secret).update(text).digest('base64url')

export const askCode = (secret, time, nonce) => code(secret, `ask:${time}:${nonce}`)
export const answerCode = (secret, nonce, link) => code(secret, `answer:${nonce}:${link}`)

// Both sides are fixed-length codes (base64url of 32 bytes), compared in constant time.
export function codesMatch(given, wanted) {
  if (typeof given !== 'string' || typeof wanted !== 'string' || given.length !== wanted.length) return false
  return timingSafeEqual(Buffer.from(given), Buffer.from(wanted))
}
