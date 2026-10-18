// GET /api/progress?order=<id>: how far a run on this computer has got (task T12). Only the local board has it: it lives
// here and not in api/, which is what Vercel serves, so the website answers 404 for it as for any address it does not know.
//
// The runner (agent-team-template, scripts/lib/mailbox/progress.mjs) keeps one small file per order, progress/<order id>.json
// in its state folder, while Claude works. This reads that file and hands back only the fields the card shows. The file is
// the runner's, written by a process that runs Claude, so it is read as untrusted: an id that is 32 lowercase hex before any
// path is built, no links in the way (lstat on the folder and the file), a plain file of at most 4 KB, and every field
// checked again for its type and shape. Anything else in the file is dropped, never passed on.

import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'

export const PROGRESS_PATH = '/api/progress'
const ID_SHAPE = /^[0-9a-f]{32}$/
const SCHEMA = 'agent-mailbox-progress/v1'
const MAX_BYTES = 4096
const MAX_STEPS = 100000
const TOOL_NAME = /^[A-Za-z0-9_*-]{1,64}$/
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const PHASES = new Set(['started', 'working', 'finishing'])
const OUTCOMES = new Set(['ok', 'failed', 'unknown', 'stale'])

export const SAY = Object.freeze({
  badId: 'That is not an order number the board knows.',
  none: 'No progress is kept for that order.',
  getOnly: 'GET only.'
})

// The orders this board has queued (and so knows), newest 200. The page asks about an order from the moment it is sent, a little
// before the runner writes a file for it: a known order with no file yet is "waiting", not an error. An id the board never queued
// stays "no progress is kept" (404). Only the ids of orders the board itself accepted get in, and only in the 32-hex shape.
const QUEUED_KEPT = 200
export function queuedOrders() {
  const ids = new Set()
  return {
    note(id) {
      if (typeof id !== 'string' || !ID_SHAPE.test(id)) return
      ids.delete(id)
      ids.add(id)
      while (ids.size > QUEUED_KEPT) ids.delete(ids.values().next().value)
    },
    has: (id) => ids.has(id),
    size: () => ids.size
  }
}

// /api/fire, with one thing added: an order it answers as queued is noted. Nothing about the answer changes.
export function rememberQueuedOrders(handler, queued) {
  return async function fireThenNote(request, response) {
    const send = response.json
    response.json = function json(value) {
      if (response.statusCode === 200 && value?.ok === true && value?.via === 'mac') queued.note(value.orderId)
      return send.call(response, value)
    }
    return handler(request, response)
  }
}

const isTime = (value) => typeof value === 'string' && TIME.test(value) && Number.isFinite(Date.parse(value))

// The file's text, or null: a plain file (not a link, not a folder) of at most 4 KB, in a folder that is itself a plain folder.
function readSmallFile(stateDir, id) {
  const folder = join(stateDir, 'progress')
  const path = join(folder, `${id}.json`)
  try {
    if (!lstatSync(folder).isDirectory()) return null
    const info = lstatSync(path)
    if (!info.isFile() || info.size > MAX_BYTES) return null
  } catch {
    return null
  }
  let handle = null
  try {
    handle = openSync(path, 'r')
    // Checked again on the open file, and read one byte past the cap: a file that grew since the check is still refused.
    if (!fstatSync(handle).isFile()) return null
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    const length = readSync(handle, buffer, 0, MAX_BYTES + 1, 0)
    return length > MAX_BYTES ? null : buffer.toString('utf8', 0, length)
  } catch {
    return null
  } finally {
    if (handle !== null) {
      try { closeSync(handle) } catch { /* nothing to close */ }
    }
  }
}

// The allow-listed fields, each checked, or null when the file is not the runner's progress file for this order.
export function cleanProgress(id, value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value.schema !== SCHEMA || value.id !== id) return null
  if (!PHASES.has(value.phase) || !isTime(value.startedAt) || !isTime(value.lastEventAt) || typeof value.final !== 'boolean') return null
  if (!Number.isSafeInteger(value.steps) || value.steps < 0 || value.steps > MAX_STEPS) return null
  if (value.lastTool !== null && !(typeof value.lastTool === 'string' && TOOL_NAME.test(value.lastTool))) return null
  if (Object.hasOwn(value, 'outcome') && !(typeof value.outcome === 'string' && OUTCOMES.has(value.outcome))) return null
  return {
    phase: value.phase,
    steps: value.steps,
    lastTool: value.lastTool,
    startedAt: value.startedAt,
    lastEventAt: value.lastEventAt,
    final: value.final,
    ...(Object.hasOwn(value, 'outcome') ? { outcome: value.outcome } : {})
  }
}

// `stateDir` is a function: the runner's state folder (null when jobs are off), read at each request.
export function progressHandler({ stateDir, queued = queuedOrders() }) {
  return async function progress(request, response) {
    response.setHeader('Cache-Control', 'private, no-store')
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET')
      return response.status(405).json({ error: SAY.getOnly })
    }
    const order = request.query?.order
    if (typeof order !== 'string' || !ID_SHAPE.test(order)) return response.status(400).json({ error: SAY.badId })
    const folder = stateDir()
    if (typeof folder !== 'string' || folder === '') return response.status(404).json({ error: SAY.none })
    const text = readSmallFile(folder, order)
    let parsed = null
    try { parsed = text === null ? null : JSON.parse(text) } catch { parsed = null }
    const answer = parsed === null ? null : cleanProgress(order, parsed)
    if (answer === null) {
      if (parsed === null && queued.has(order)) return response.status(200).json({ state: 'waiting' })
      return response.status(404).json({ error: SAY.none })
    }
    return response.status(200).json(answer)
  }
}
