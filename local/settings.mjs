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
import { callableAddress, parseLoopbackUrl, whereIs } from './loopback.mjs'

export const SETTINGS_PATH = '/api/local-settings'
const MAX_BODY_CHARS = 2000

// What each key may look like. A pasted value that does not fit is refused, whatever else it is.
export const SLOTS = Object.freeze({
  OPENAI_API_KEY: { label: 'OpenAI key (for voice)', shape: /^sk-[A-Za-z0-9_-]{20,200}$/, hint: 'It starts with sk- and has no spaces.' },
  FISH_API_KEY: { label: 'Fish Audio key (optional, for a different voice)', shape: /^[A-Za-z0-9_-]{16,200}$/, hint: 'Letters, numbers, - and _ only.' },
  OPENROUTER_API_KEY: { label: 'OpenRouter key (optional)', shape: /^sk-or-[A-Za-z0-9_-]{16,200}$/, hint: 'It starts with sk-or- and has no spaces.' }
})
const SLOT_NAMES = Object.keys(SLOTS)

// Local voice (task T16): where the three parts are, and which models they are asked for. None of this is
// secret; every address must be on this computer (local/loopback.mjs).
export const VOICE_DEFAULTS = Object.freeze({
  engine: 'cloud',
  hearUrl: 'http://127.0.0.1:3900/v1/audio/transcriptions',
  thinkUrl: 'http://127.0.0.1:11434/v1/chat/completions',
  speakUrl: 'http://127.0.0.1:3900/v1/audio/speech',
  hearModel: 'whisper-1',
  brainModel: 'qwen3:8b',
  speakModel: 'kittentts',
  speakVoice: 'alloy'
})
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/
const VOICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/
const VOICE_FIELD_CHECKS = {
  engine: (value, { boardPort }) => (value === 'cloud' || value === 'local' ? value : null),
  hearUrl: (value, { boardPort }) => (parseLoopbackUrl(value, { exceptPort: boardPort }) ? value : null),
  thinkUrl: (value, { boardPort }) => (parseLoopbackUrl(value, { exceptPort: boardPort }) ? value : null),
  speakUrl: (value, { boardPort }) => (parseLoopbackUrl(value, { exceptPort: boardPort }) ? value : null),
  hearModel: (value) => (typeof value === 'string' && MODEL_NAME.test(value) ? value : null),
  brainModel: (value) => (typeof value === 'string' && MODEL_NAME.test(value) ? value : null),
  speakModel: (value) => (typeof value === 'string' && MODEL_NAME.test(value) ? value : null),
  speakVoice: (value) => (typeof value === 'string' && VOICE_NAME.test(value) ? value : null)
}
const VOICE_FIELD_NAMES = Object.keys(VOICE_FIELD_CHECKS)
const URL_FIELDS = ['hearUrl', 'thinkUrl', 'speakUrl']
const isSlot = (name) => typeof name === 'string' && Object.hasOwn(SLOTS, name)

export const SAY = Object.freeze({
  voiceBad: (field) => (URL_FIELDS.includes(field)
    ? 'That address is not allowed. It must start with http://127.0.0.1 (or http://localhost), because the voice parts run on this computer.'
    : field === 'engine' ? 'The voice engine is Cloud or Local.' : 'That name does not look right. Use letters, numbers and - _ . : only.'),
  voiceUnknown: 'The board does not keep that voice setting.',
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

function readFileVoice(file, boardPort = null) {
  const voice = { ...VOICE_DEFAULTS }
  try {
    const stored = JSON.parse(readFileSync(file, 'utf8'))?.voice
    for (const name of VOICE_FIELD_NAMES) {
      if (typeof stored?.[name] === 'string' && VOICE_FIELD_CHECKS[name](stored[name], { boardPort }) !== null) voice[name] = stored[name]
    }
  } catch { /* defaults */ }
  return voice
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
function writeKeys(file, keys, voice = VOICE_DEFAULTS) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(temp, JSON.stringify({ version: 1, keys, voice }), { mode: 0o600 })
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
  let voice = readFileVoice(file)
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
      writeKeys(file, next, voice)
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
      writeKeys(file, next, voice)
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

  // ---- local voice settings ----
  function voiceSave(values, boardPort) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) return { status: 400, body: { error: SAY.badRequest } }
    const next = { ...voice }
    for (const [field, value] of Object.entries(values)) {
      if (!Object.hasOwn(VOICE_FIELD_CHECKS, field)) return { status: 400, body: { error: SAY.voiceUnknown } }
      const ok = VOICE_FIELD_CHECKS[field](value, { boardPort })
      if (ok === null) return { status: 400, body: { error: SAY.voiceBad(field) } }
      next[field] = ok
    }
    try {
      writeKeys(file, keys, next)
    } catch {
      return { status: 500, body: { error: SAY.cannotSave } }
    }
    voice = next
    return { status: 200, body: { ok: true, voice: { ...voice } } }
  }

  // Is anything listening where each part is said to be? Any answer at all counts - the root of
  // Ollama says so, Voice Studio may say "not found": both mean it is up.
  async function voiceCheck() {
    const result = {}
    for (const [part, field] of [['hear', 'hearUrl'], ['think', 'thinkUrl'], ['speak', 'speakUrl']]) {
      const url = parseLoopbackUrl(voice[field])
      if (!url) { result[part] = { up: false, where: null }; continue }
      const root = new URL('/', callableAddress(url)).href
      try {
        await fetchImpl(root, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(3000) })
        result[part] = { up: true, where: whereIs(url) }
      } catch {
        result[part] = { up: false, where: whereIs(url) }
      }
    }
    return { status: 200, body: { ok: true, check: result } }
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
        case 'status': return send({ status: 200, body: { ok: true, keys: status(), voice: { ...voice }, voiceDefaults: { ...VOICE_DEFAULTS } } })
        case 'voice-save': return send(voiceSave(body.values, request.socket?.localPort ?? null))
        case 'voice-check': return send(await voiceCheck())
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

  return { handler, status, save, remove, test, inject, file, voice: () => ({ ...voice }) }
}

export const settingsFileIn = (stateDir) => join(stateDir, 'settings.json')
