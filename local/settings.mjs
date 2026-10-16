// The keys a student pastes into the board's Settings box (task T10): OpenAI (voice), and optionally
// Fish and OpenRouter. Kept in one file in the board's locked state folder, read back into the
// handlers' environment at each start, and NEVER sent back to the page, written to a log, or put in an
// error message: the page learns only "saved" and the last four characters.
//
// Only the local server has this (startLocalBoard); the website keeps using environment variables and
// never shows a box.

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'

export const SETTINGS_PATH = '/api/local-settings'
const MAX_BODY_CHARS = 2000

// What each key may look like. A pasted value that does not fit is refused, whatever else it is.
export const SLOTS = Object.freeze({
  OPENAI_API_KEY: { label: 'OpenAI key (for voice)', shape: /^sk-[A-Za-z0-9_-]{20,200}$/, hint: 'It starts with sk- and has no spaces.' },
  FISH_API_KEY: { label: 'Fish Audio key (optional, for a different voice)', shape: /^[A-Za-z0-9_-]{16,200}$/, hint: 'Letters, numbers, - and _ only.' },
  OPENROUTER_API_KEY: { label: 'OpenRouter key (optional)', shape: /^sk-or-[A-Za-z0-9_-]{16,200}$/, hint: 'It starts with sk-or- and has no spaces.' }
})
const SLOT_NAMES = Object.keys(SLOTS)
const isSlot = (name) => typeof name === 'string' && Object.hasOwn(SLOTS, name)

export const SAY = Object.freeze({
  notAKey: (slot) => `That does not look like ${SLOTS[slot].label.replace(/ \(.*\)$/, '')}. ${SLOTS[slot].hint}`,
  anthropicKey: 'That looks like an Anthropic (Claude) key. The OpenAI box takes only an OpenAI key, which starts with sk- and is made at platform.openai.com.',
  openrouterKey: 'That looks like an OpenRouter key. Paste it in the OpenRouter box, not here.',
  whitespace: 'That has a space or a new line in it. Paste only the key.',
  unknownSlot: 'The board does not keep that setting.',
  badRequest: 'The board could not read that request.',
  tooBig: 'That is too long to be a key.',
  cannotSave: 'The board could not save the key on this computer. Check the Start Board window.',
  nothingSaved: 'No key is saved yet.',
  works: 'This key works.',
  refused: 'OpenAI refused this key. Check that you pasted the whole key and that it is still active.',
  refusedOther: 'This service refused this key. Check that you pasted the whole key and that it is still active.',
  noCredit: 'This key is valid, but the account has no credit left. Add credit on the OpenAI website.',
  unreachable: 'The board could not reach the service to check. Check your internet connection and try again.',
  cannotTest: 'The board cannot check this kind of key. It is saved and will be used.',
  busy: 'A check is already running. Wait a moment.'
})

const last4 = (value) => value.slice(-4)

// A space, a new line, a tab, a control character, an odd Unicode space or line separator: anything a
// key never holds and a careless paste often does.
function hasSpaceOrControl(value) {
  for (const character of value) {
    const code = character.codePointAt(0)
    if (code <= 32 || (code >= 127 && code <= 160) || code === 0x2028 || code === 0x2029 || /\s/.test(character)) return true
  }
  return false
}

function readFileKeys(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const keys = {}
    for (const name of SLOT_NAMES) {
      const value = parsed?.keys?.[name]
      if (typeof value === 'string' && SLOTS[name].shape.test(value)) keys[name] = value
    }
    return keys
  } catch {
    return {}
  }
}

// Written to a temp name and renamed; private to the user (0600; on Windows the folder is already
// locked to the user by icacls).
function writeKeys(file, keys) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(temp, JSON.stringify({ version: 1, keys }), { mode: 0o600 })
    try { chmodSync(temp, 0o600) } catch { /* Windows */ }
    renameSync(temp, file)
  } catch (failure) {
    rmSync(temp, { force: true })
    throw failure
  }
}

// Two things worth knowing, both accepted: Remove clears the computer's own variable of the same name
// (OPENAI_API_KEY...) for as long as the board runs - a restart brings back whatever the computer had; and
// two boards run by one student share settings.json (the second to start reads the same file). Both are rare.
export function createSettings({ file, env = process.env, fetchImpl = fetch, openaiBase = 'https://api.openai.com', openrouterBase = 'https://openrouter.ai', testTimeoutMs = 10_000 } = {}) {
  if (typeof file !== 'string' || !file) throw new Error('createSettings needs the settings file path.')
  let keys = readFileKeys(file)
  let testing = false

  // Puts every saved key where the board's handlers read it. A saved key wins over one the computer
  // already had; a slot with nothing saved is left as it is.
  function inject() {
    for (const name of SLOT_NAMES) if (keys[name]) env[name] = keys[name]
  }
  inject()

  const status = () => Object.fromEntries(SLOT_NAMES.map((name) => [name, keys[name]
    ? { label: SLOTS[name].label, saved: true, last4: last4(keys[name]) }
    : { label: SLOTS[name].label, saved: false }]))

  function check(slot, value) {
    if (!isSlot(slot)) return SAY.unknownSlot
    if (typeof value !== 'string') return SAY.notAKey(slot)
    if (value.length > 400) return SAY.tooBig
    if (hasSpaceOrControl(value)) return SAY.whitespace
    // Other services' keys have the same sk- start, so the shape alone would let them in.
    if (slot === 'OPENAI_API_KEY' && value.startsWith('sk-ant-')) return SAY.anthropicKey
    if (slot === 'OPENAI_API_KEY' && value.startsWith('sk-or-')) return SAY.openrouterKey
    if (!SLOTS[slot].shape.test(value)) return SAY.notAKey(slot)
    return null
  }

  function save(slot, value) {
    const refusal = check(slot, value)
    if (refusal) return { status: 400, body: { error: refusal } }
    const next = { ...keys, [slot]: value }
    try {
      writeKeys(file, next)
    } catch {
      return { status: 500, body: { error: SAY.cannotSave } }
    }
    keys = next
    env[slot] = value
    return { status: 200, body: { ok: true, keys: status() } }
  }

  function remove(slot) {
    if (!isSlot(slot)) return { status: 400, body: { error: SAY.unknownSlot } }
    const next = { ...keys }
    delete next[slot]
    try {
      writeKeys(file, next)
    } catch {
      return { status: 500, body: { error: SAY.cannotSave } }
    }
    keys = next
    delete env[slot]
    return { status: 200, body: { ok: true, keys: status() } }
  }

  // One call to the service's own "list models" address, with the saved key. Says only whether it
  // worked - never the key, never the service's own words.
  async function test(slot) {
    if (!isSlot(slot)) return { status: 400, body: { error: SAY.unknownSlot } }
    const key = keys[slot]
    if (!key) return { status: 400, body: { error: SAY.nothingSaved } }
    const target = slot === 'OPENAI_API_KEY' ? `${openaiBase}/v1/models` : slot === 'OPENROUTER_API_KEY' ? `${openrouterBase}/api/v1/auth/key` : null
    if (!target) return { status: 200, body: { result: 'untestable', say: SAY.cannotTest } }
    if (testing) return { status: 429, body: { error: SAY.busy } }
    testing = true
    try {
      const answer = await fetchImpl(target, { method: 'GET', headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(testTimeoutMs) })
      if (answer.ok) return { status: 200, body: { result: 'works', say: SAY.works } }
      let quota = false
      if (answer.status === 429 || answer.status === 402) {
        try { quota = /insufficient_quota|billing|credit/i.test(JSON.stringify(await answer.json())) } catch { /* no body */ }
        quota = quota || answer.status === 402
      }
      if (quota) return { status: 200, body: { result: 'no credit', say: SAY.noCredit } }
      if (answer.status === 401 || answer.status === 403) return { status: 200, body: { result: 'refused', say: slot === 'OPENAI_API_KEY' ? SAY.refused : SAY.refusedOther } }
      return { status: 200, body: { result: 'unreachable', say: SAY.unreachable } }
    } catch {
      return { status: 200, body: { result: 'unreachable', say: SAY.unreachable } }
    } finally {
      testing = false
    }
  }

  // POST only. { action: 'status' } | { action: 'save', slot, value } | { action: 'remove', slot } | { action: 'test', slot }
  async function handler(request, response) {
    response.setHeader('Cache-Control', 'no-store')
    const send = ({ status, body }) => response.status(status).json(body)
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST')
      return send({ status: 405, body: { error: 'POST only.' } })
    }
    const body = request.body
    if (!body || typeof body !== 'object' || Array.isArray(body) || JSON.stringify(body).length > MAX_BODY_CHARS) return send({ status: 400, body: { error: SAY.badRequest } })
    try {
      switch (body.action) {
        case 'status': return send({ status: 200, body: { ok: true, keys: status() } })
        case 'save': return send(save(body.slot, body.value))
        case 'remove': return send(remove(body.slot))
        case 'test': return send(await test(body.slot))
        default: return send({ status: 400, body: { error: SAY.badRequest } })
      }
    } catch {
      // Whatever went wrong, the answer is one fixed sentence: nothing from the error, which could hold the key.
      return send({ status: 500, body: { error: SAY.cannotSave } })
    }
  }

  return { handler, status, save, remove, test, inject, file }
}

export const settingsFileIn = (stateDir) => join(stateDir, 'settings.json')
