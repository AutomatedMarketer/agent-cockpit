// Voice that runs on this computer (task T16): the board's server side of a turn-based loop.
//
//   page records until silence -> POST audio to /api/local-voice/hear -> speech-to-text program
//   page asks /api/local-voice/think with the conversation -> a language model with the board's tools
//   page runs the tool calls itself, exactly as it does for the cloud voice (cards, yes rules, data-only results)
//   page sends each clause of the reply to /api/local-voice/speak -> a text-to-speech program -> audio
//
// The three programs are OpenAI-shaped web addresses on THIS computer (Voice Studio, Ollama...). They are
// called from here, never from the browser, and only at addresses local/loopback.mjs accepts; a redirect
// is an error. The tool definitions and the instructions are the cloud voice's own (api/_voice.js:
// toolsFor, instructionsFor), so the two engines can never drift apart.
//
// Everything here is behind the same gate as every /api call (cookie, the page's key, the board's own
// Origin) and answers a session ticket this run signed; nothing is kept past a restart.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { assistantLabel, cleanSpeakText, instructionsFor, isMp3, toolsFor, voiceZone, DEFAULT_IDLE_MINUTES, SPEAK_TICKET_MS } from '../api/_voice.js'
import { mailboxConfig } from '../api/_mailbox.js'
import { ordersConfig, ordersView, readMacStatus } from '../api/_orders.js'
import { callableAddress, parseLoopbackUrl, whereIs } from './loopback.mjs'

export const VOICE_PATHS = Object.freeze({
  start: '/api/local-voice/start',
  hear: '/api/local-voice/hear',
  think: '/api/local-voice/think',
  speak: '/api/local-voice/speak'
})

// What the spike found makes a small model usable for a voice: with thinking switched off it must be told,
// in so many words, to call the tool first - without this sentence it says "let me check" and then
// makes things up (docs/superpowers/specs/2026-10-16-local-brain-spike.md).
export const CALL_THE_TOOL_FIRST = 'When a tool can answer, call the matching tool immediately and say nothing before it. Never answer from memory what a tool could tell you.'

const HEAR_TIMEOUT_MS = 30_000
const THINK_TIMEOUT_MS = 60_000
const SPEAK_TIMEOUT_MS = 20_000
const MAX_AUDIO_IN = 4 * 1024 * 1024
const MAX_ANSWER_BYTES = 256 * 1024
const MAX_AUDIO_OUT = 5 * 1024 * 1024
const MAX_MESSAGES = 40
const MAX_CALLS = 4
const MAX_SESSIONS = 20

const PART_WORDS = {
  hear: 'The listening part (speech to text)',
  think: 'The thinking part (the language model)',
  speak: 'The speaking part (text to speech)'
}
export const SAY = Object.freeze({
  off: 'Local voice is switched off. Switch the Voice engine to Local in Settings first.',
  ended: 'This voice session has ended. Tap the orb to start a new one.',
  badRequest: 'The board could not read that request.',
  noAudio: 'There was no sound to listen to.',
  noText: 'Send up to 400 characters of plain text to speak.',
  notAudio: 'The speaking part sent back something that is not sound, so it was not played.',
  down: (part, where) => `${PART_WORDS[part]} is not answering${where ? ` at ${where}` : ''}. Start it, or switch the Voice engine back to Cloud in Settings.`,
  error: (part, where) => `${PART_WORDS[part]} answered with an error${where ? ` at ${where}` : ''}. Check it is running, or switch the Voice engine back to Cloud in Settings.`,
  badAddress: (part) => `${PART_WORDS[part]} has an address that is not allowed. Open Settings and put it back to the default.`,
  noAnswer: 'I did not get an answer to that. Please ask again.'
})

// ---- turning the model's words into something safe to speak -------------------------------------------

// Sentences that are the model talking to itself. Narrow on purpose: a real answer such as "I need the
// name of the job" must survive, so only the shapes the spike saw leak out are matched.
const REASONING_START = /^(?:(?:okay|ok|alright|all right|hmm+|so|well)[,.!:\s]+)?(?:we (?:need|have|should|must) to (?:call|check|use|figure|find|look|answer|respond|make sure|see|think|recall)|we(?:'ll| will| should) (?:call|use|check|look up)|the user(?:'s| is| wants| asked| said| has| might| may)|(?:let me|let's) (?:think|see|check|figure|call|use|look|try|recall)|i (?:need|have|should|will|must) to (?:call|check|use|figure|find|look|answer|respond|make sure|see|think|recall)|i(?:'ll| should| will| must| need) (?:call|use|check|look up)|first,? (?:i|let)|now,? (?:i|let)|thinking[:.]|reasoning:|the (?:tool|function) (?:call|result|returned))/i

// A paragraph that opens with one of these is the model's working, list and all.
const THINKING_BLOCK = /^\s*(?:thinking process|thought process|thinking|reasoning|analysis|plan|chain of thought)\s*:/i

// <think> blocks (closed, or cut off), and tool-call markup the model printed instead of calling.
export function stripMarkup(raw) {
  let text = typeof raw === 'string' ? raw : ''
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, ' ').replace(/<think>[\s\S]*$/i, ' ').replace(/<\/?think>/gi, ' ')
  text = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, ' ').replace(/<tool_call>[\s\S]*$/i, ' ').replace(/<\/?tool_call>/gi, ' ')
  text = text.replace(/```[\s\S]*?```/g, ' ')
  // Chat-template markers a model prints when its template did not take them: a message ends at its end marker,
  // and a turn it invents for someone else (user, system, tool) is not an answer at all.
  text = text.replace(/<\|im_start\|>\s*(?:user|system|tool)[\s\S]*$/i, ' ')
  text = text.replace(/<\|(?:im_end|endoftext|eot_id|end_of_turn|end)\|>[\s\S]*$/i, ' ')
  text = text.replace(/<\|im_start\|>\s*(?:assistant)?/gi, ' ').replace(/<\|[a-z_]{1,24}\|>/gi, ' ')
  text = text.replace(/\[\/?(?:INST|SYS|\/INST)\]/gi, ' ')
  // Mistral-style call markers: everything after one is a call that was never made, not words.
  text = text.replace(/\[TOOL_CALLS\][\s\S]*$/i, ' ').replace(/\[\/?TOOL_(?:CALLS|RESULTS)\]/gi, ' ')
  return stripPrintedCalls(text)
}

// A tool call printed as plain JSON - {"name": "run_job", "arguments": {...}} - instead of made. Found by its
// opening and followed to its matching brace (strings and escapes respected), so a sentence around it survives.
function stripPrintedCalls(text) {
  const opener = /\{\s*"(?:name|tool|tool_name|function|tool_calls|arguments)"\s*:/g
  let out = ''
  let from = 0
  for (let found = opener.exec(text); found; found = opener.exec(text)) {
    if (found.index < from) continue
    let depth = 0
    let inString = false
    let end = -1
    for (let at = found.index; at < text.length; at += 1) {
      const character = text[at]
      if (inString) {
        if (character === '\\') at += 1
        else if (character === '"') inString = false
      } else if (character === '"') inString = true
      else if (character === '{') depth += 1
      else if (character === '}') {
        depth -= 1
        if (depth === 0) { end = at + 1; break }
      }
    }
    out += text.slice(from, found.index) + ' '
    from = end === -1 ? text.length : end // a call cut off in the middle ends the text
    opener.lastIndex = from
  }
  return out + text.slice(from)
}

// Words that are not the answer: the markup above, and the "Okay, the user is asking..." the model
// sometimes writes out before answering. What is left is what may be spoken.
export function cleanReply(raw) {
  const kept = []
  for (const block of stripMarkup(raw).split(/\n\s*\n/)) {
    let paragraph = block
    if (THINKING_BLOCK.test(paragraph)) {
      // "Thinking Process: 1. ... 2. ... Final answer: Two jobs ran." keeps only what follows the marker.
      const after = /\n\s*(?:final answer|final response|response|answer)\s*:\s*([\s\S]*)$/i.exec(paragraph)
      if (!after) continue
      paragraph = after[1]
    }
    const sentences = paragraph.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).filter(Boolean)
    let at = 0
    while (at < sentences.length && REASONING_START.test(sentences[at])) at += 1
    const rest = sentences.slice(at).join(' ').trim()
    if (rest) kept.push(rest)
  }
  return kept.join(' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200)
}

// ---- the session ticket ---------------------------------------------------------------------------------

const TICKET_SHAPE = /^([A-Za-z0-9_-]{1,400})\.([A-Za-z0-9_-]{43})$/

function ticketTools(runSecret) {
  const key = createHash('sha256').update(`agent-cockpit local voice ticket\n${runSecret}`).digest()
  const sign = (body) => createHmac('sha256', key).update(body).digest()
  return {
    make(claims) {
      const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
      return `${body}.${sign(body).toString('base64url')}`
    },
    read(ticket, now) {
      if (typeof ticket !== 'string') return null
      const parts = TICKET_SHAPE.exec(ticket)
      if (!parts) return null
      const given = Buffer.from(parts[2], 'base64url')
      const expected = sign(parts[1])
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
      let claims
      try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) } catch { return null }
      if (!claims || typeof claims.sid !== 'string' || !Number.isInteger(claims.iat) || claims.model !== 'local') return null
      const age = now - claims.iat
      return age < -60_000 || age > SPEAK_TICKET_MS ? null : claims
    }
  }
}

// ---- audio sniffing: what came back from the speaking part must be sound ------------------------------

export function audioKind(bytes) {
  if (!bytes || bytes.length < 12) return null
  const head = bytes.subarray(0, 12)
  if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WAVE') return 'audio/wav'
  if (head.toString('latin1', 0, 4) === 'OggS') return 'audio/ogg'
  if (head.toString('latin1', 0, 4) === 'fLaC') return 'audio/flac'
  if (head.toString('latin1', 4, 8) === 'ftyp') return 'audio/mp4'
  if (isMp3(bytes)) return 'audio/mpeg'
  return null
}

async function readLimited(answer, limit) {
  const declared = Number(answer.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > limit) return null
  const chunks = []
  let size = 0
  const reader = answer.body?.getReader?.()
  if (!reader) {
    const whole = Buffer.from(await answer.arrayBuffer())
    return whole.length > limit ? null : whole
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > limit) { try { await reader.cancel() } catch { /* gone */ } return null }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

// ---- the four handlers ----------------------------------------------------------------------------------

export function createLocalVoice({ settings, env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  const runSecret = randomBytes(32).toString('hex')
  const tickets = ticketTools(runSecret)
  const sessions = new Map() // sid -> { name, zone, orders }

  const send = (response, status, body) => response.status(status).json(body)
  const guard = (request, response, needsBody = true) => {
    response.setHeader('Cache-Control', 'private, no-store')
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST')
      send(response, 405, { error: 'POST only.' })
      return false
    }
    if (needsBody && (request.body === undefined || request.body === null)) {
      send(response, 400, { error: SAY.badRequest })
      return false
    }
    return true
  }
  const ticketOf = (value, response) => {
    const claims = tickets.read(value, now())
    const session = claims ? sessions.get(claims.sid) : null
    if (!session) { send(response, 409, { error: SAY.ended }); return null }
    return session
  }

  // The address of a part, checked again now (it was checked when saved; the file could have been edited).
  function partAddress(part, field, request, response) {
    const url = parseLoopbackUrl(settings.voice()[field], { exceptPort: request.socket?.localPort ?? null })
    if (!url) { send(response, 502, { error: SAY.badAddress(part), part }); return null }
    return url
  }

  async function call(part, url, init, timeoutMs, response, limit) {
    let answer
    try {
      answer = await fetchImpl(callableAddress(url), { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
    } catch {
      send(response, 502, { error: SAY.down(part, whereIs(url)), part })
      return null
    }
    if (!answer.ok) {
      send(response, 502, { error: SAY.error(part, whereIs(url)), part })
      return null
    }
    let bytes
    try { bytes = await readLimited(answer, limit) } catch { bytes = null }
    if (!bytes) {
      send(response, 502, { error: SAY.error(part, whereIs(url)), part })
      return null
    }
    return { bytes, type: answer.headers?.get?.('content-type') ?? '' }
  }

  async function start(request, response) {
    if (!guard(request, response)) return
    if (settings.voice().engine !== 'local') return send(response, 409, { error: SAY.off })
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body : {}
    const name = assistantLabel(typeof body.name === 'string' ? body.name : '')
    const zone = voiceZone(body.timeZone)
    // Orders by voice: offered only as far as the board's fire is set up, as for the cloud voice.
    const fireSettings = mailboxConfig(env)
    const mac = fireSettings.ready ? await readMacStatus(env, fireSettings.runner) : null
    const orders = ordersConfig(env, mac)
    const sid = randomBytes(16).toString('hex')
    if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value)
    sessions.set(sid, { name, zone, orders })
    const voice = settings.voice()
    const where = (field) => { const url = parseLoopbackUrl(voice[field]); return url ? whereIs(url) : null }
    return send(response, 200, {
      ticket: tickets.make({ sid, iat: now(), mouth: 'fish', model: 'local' }),
      mouth: 'fish',
      model: 'local',
      name,
      idleMinutes: DEFAULT_IDLE_MINUTES,
      captions: true,
      echoGuard: false,
      orders: ordersView(orders),
      parts: { hear: where('hearUrl'), think: where('thinkUrl'), speak: where('speakUrl') }
    })
  }

  async function hear(request, response) {
    if (!guard(request, response)) return
    const session = ticketOf(request.headers['x-voice-ticket'], response)
    if (!session) return
    const audio = request.body
    if (!Buffer.isBuffer(audio) || audio.length < 1000 || audio.length > MAX_AUDIO_IN || audio.toString('latin1', 0, 4) !== 'RIFF' || audio.toString('latin1', 8, 12) !== 'WAVE') {
      return send(response, 400, { error: SAY.noAudio })
    }
    const url = partAddress('hear', 'hearUrl', request, response)
    if (!url) return
    const form = new FormData()
    form.set('file', new Blob([audio], { type: 'audio/wav' }), 'speech.wav')
    form.set('model', settings.voice().hearModel)
    form.set('response_format', 'json')
    const got = await call('hear', url, { method: 'POST', body: form }, HEAR_TIMEOUT_MS, response, MAX_ANSWER_BYTES)
    if (!got) return
    let text = null
    try { text = JSON.parse(got.bytes.toString('utf8'))?.text } catch { text = null }
    if (typeof text !== 'string') return send(response, 502, { error: SAY.error('hear', whereIs(url)), part: 'hear' })
    return send(response, 200, { text: text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000) })
  }

  // The conversation so far, from the page, held to a small shape: the page may say what the person said,
  // what was answered, what the tools returned and what the board noted; never which model, which tools or
  // what the instructions are.
  function cleanMessages(list) {
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_MESSAGES) return null
    const messages = []
    for (const item of list) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null
      const content = item.content === null || item.content === undefined ? '' : item.content
      if (typeof content !== 'string' || content.length > 6000) return null
      if (item.role === 'user' || item.role === 'system') {
        if (!content.trim()) return null
        messages.push({ role: item.role, content })
      } else if (item.role === 'tool') {
        if (typeof item.tool_call_id !== 'string' || !/^[\w-]{1,64}$/.test(item.tool_call_id)) return null
        messages.push({ role: 'tool', tool_call_id: item.tool_call_id, content })
      } else if (item.role === 'assistant') {
        const message = { role: 'assistant', content }
        if (item.tool_calls !== undefined) {
          if (!Array.isArray(item.tool_calls) || item.tool_calls.length > MAX_CALLS) return null
          message.tool_calls = []
          for (const one of item.tool_calls) {
            if (!one || typeof one.id !== 'string' || !/^[\w-]{1,64}$/.test(one.id) || typeof one.name !== 'string' || typeof one.arguments !== 'string' || one.arguments.length > 2000) return null
            message.tool_calls.push({ id: one.id, type: 'function', function: { name: one.name, arguments: one.arguments } })
          }
        }
        if (!content.trim() && !message.tool_calls) return null
        messages.push(message)
      } else {
        return null
      }
    }
    return messages
  }

  async function think(request, response) {
    if (!guard(request, response)) return
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body : {}
    const session = ticketOf(body.ticket, response)
    if (!session) return
    const messages = cleanMessages(body.messages)
    if (!messages) return send(response, 400, { error: SAY.badRequest })
    const url = partAddress('think', 'thinkUrl', request, response)
    if (!url) return
    const tools = toolsFor(session.orders)
    const toolNames = new Set(tools.map((tool) => tool.name))
    const payload = {
      model: settings.voice().brainModel,
      messages: [{ role: 'system', content: `${instructionsFor(session.name, session.zone, session.orders)} ${CALL_THE_TOOL_FIRST}` }, ...messages],
      tools: tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
      tool_choice: 'auto',
      stream: false,
      temperature: 0.3,
      max_tokens: 400,
      // Thinking off: a voice cannot wait 6 to 37 seconds. The sentence above is what makes that safe.
      reasoning_effort: 'none'
    }
    const got = await call('think', url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, THINK_TIMEOUT_MS, response, MAX_ANSWER_BYTES)
    if (!got) return
    let message
    try { message = JSON.parse(got.bytes.toString('utf8'))?.choices?.[0]?.message } catch { message = null }
    if (!message || typeof message !== 'object') return send(response, 502, { error: SAY.error('think', whereIs(url)), part: 'think' })
    const calls = []
    for (const one of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      const name = one?.function?.name
      if (typeof name !== 'string' || !toolNames.has(name) || calls.length >= MAX_CALLS) continue // an invented tool is dropped
      let args = one.function.arguments
      if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = {} } }
      if (!args || typeof args !== 'object' || Array.isArray(args)) args = {}
      const text = JSON.stringify(args)
      const callId = typeof one.id === 'string' && /^[\w-]{1,64}$/.test(one.id) ? one.id : `call_${randomBytes(6).toString('hex')}`
      calls.push({ call_id: callId, name, arguments: text.length > 2000 ? '{}' : text })
    }
    // With a tool call, nothing is said before the result: the answer comes after it.
    const text = calls.length ? '' : cleanReply(typeof message.content === 'string' ? message.content : '')
    return send(response, 200, { text, calls, empty: !text && calls.length === 0 })
  }

  async function speak(request, response) {
    if (!guard(request, response)) return
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body : {}
    const session = ticketOf(body.ticket, response)
    if (!session) return
    if (body.warm === true) { response.statusCode = 204; response.end(); return }
    const text = cleanSpeakText(stripMarkup(typeof body.text === 'string' ? body.text : ''))
    if (!text) return send(response, 400, { error: SAY.noText })
    const url = partAddress('speak', 'speakUrl', request, response)
    if (!url) return
    const voice = settings.voice()
    const got = await call('speak', url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: voice.speakModel, input: text, voice: voice.speakVoice }) }, SPEAK_TIMEOUT_MS, response, MAX_AUDIO_OUT)
    if (!got) return
    const kind = audioKind(got.bytes)
    if (!kind) return send(response, 502, { error: SAY.notAudio, part: 'speak' })
    response.setHeader('Content-Type', kind)
    response.status(200).end(got.bytes)
  }

  return {
    routes: { [VOICE_PATHS.start]: start, [VOICE_PATHS.hear]: hear, [VOICE_PATHS.think]: think, [VOICE_PATHS.speak]: speak },
    // Read by the page before it runs: which engine this board is set to.
    configScript: () => `window.__BOARD_LOCAL_VOICE__ = { engine: ${JSON.stringify(settings.voice().engine === 'local' ? 'local' : 'cloud')} }\n`
  }
}
