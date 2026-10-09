// /api/speak: { ticket, text } -> one piece of a reply, spoken by Fish in the owner's chosen voice,
// as MP3 bytes (Phase 10, the Fish mouth). { ticket, warm: true } -> 204 and nothing else.
//
// Only used when the owner has set up Fish (FISH_API_KEY and FISH_VOICE_ID). Then OpenAI answers in
// text, the page cuts each reply into pieces as it arrives - the first clause, then each sentence -
// and each piece comes here. The warm-up is the page saying "a reply is coming": it costs a request
// to this function and nothing else, and keeps the function ready so the first piece is fast.
//
// The order is the contract: the write gate, voice on and Fish set up, a ticket from a live Fish
// session, then the text, then Fish. The ticket is what stops this being a free speech machine for
// anyone with the board's keys: it was signed by /api/voice-session for one session and lasts 65
// minutes (OpenAI's 60, plus grace).
//
// MONEY. Fish chooses the model from a request HEADER, and a request without it - or with a name it
// does not know - is billed as the paid model (docs.fish.audio, text-to-speech). So every call sends
// the header, and it is the free model unless FISH_MODEL said the paid one exactly when the session
// started AND still says so now: a change in either direction mid-call never makes a free session
// paid. The voice is the owner's FISH_VOICE_ID, never anything the request names.
//
// The Fish key goes to Fish in one header and nowhere else. Fish's own words are never passed on, and
// every answer carries `private, no-store`.

import { writeGate, readJsonBody, readCapped } from './lib.js'
import {
  voiceConfig,
  readTicket,
  cleanSpeakText,
  isMp3,
  SPEAK_TICKET_MS,
  FISH_FREE_MODEL,
  FISH_PAID_MODEL
} from './_voice.js'

export const FISH_URL = 'https://api.fish.audio/v1/tts'
// One piece is a sentence or two; a second of MP3 at 128 kbps is 16 KB. A megabyte is a minute.
const MAX_AUDIO_BYTES = 1024 * 1024
// A piece that takes longer than this is no use to a conversation: the page skips it and moves on.
const FISH_TIMEOUT_MS = 10_000

const SAY = {
  noFish: 'Fish is not set up on this board, so its replies are spoken with OpenAI\'s voice: set FISH_API_KEY and FISH_VOICE_ID in Vercel to use your own.',
  ended: 'This voice session has ended, so tap the orb to start a new one.',
  notFish: 'This voice session speaks with OpenAI\'s voice, not Fish.',
  noText: 'Send up to 400 characters of plain text to speak.',
  key: 'Fish did not accept FISH_API_KEY, so check the key in Vercel and redeploy.',
  credit: 'Fish says this account needs credit for that voice model, so check your Fish account, or remove FISH_MODEL to use the free model.',
  busy: 'Fish is busy right now, so that part of the reply was not spoken.',
  slow: 'Fish took too long, so that part of the reply was not spoken.',
  failed: 'Fish did not speak that part of the reply.',
  notAudio: 'Fish sent back something that is not speech, so it was not played.'
}

const timedOut = (error) => error?.name === 'TimeoutError' || error?.name === 'AbortError'

function refusalFor(status) {
  if (status === 401 || status === 403) return { status: 502, error: SAY.key }
  if (status === 402) return { status: 402, error: SAY.credit }
  if (status === 429) return { status: 429, error: SAY.busy }
  return { status: 502, error: SAY.failed }
}

export function makeHandler({ env, now = () => new Date() } = {}) {
  return async function handler(request, response) {
    const environment = env ?? process.env
    // First, before any answer can be sent: nothing this endpoint says may be kept by a shared cache.
    response.setHeader('Cache-Control', 'private, no-store')
    if (String(request?.method ?? 'GET').toUpperCase() !== 'POST') {
      response.setHeader('Allow', 'POST')
      response.status(405).json({ error: 'POST { "ticket": "...", "text": "..." }.' })
      return
    }
    const denied = writeGate(request, environment)
    if (denied) {
      const { status, ...answer } = denied
      response.status(status).json(answer)
      return
    }
    const config = voiceConfig(environment)
    if (!config.on) {
      response.status(503).json({ error: config.why })
      return
    }
    if (config.mouth !== 'fish') {
      response.status(503).json({ error: SAY.noFish })
      return
    }

    const body = readJsonBody(request)
    // 401 with no `needs`: the page asks for the edit key only when a refusal names it.
    const ticket = readTicket(body?.ticket, environment.OPENAI_API_KEY, { now: now().getTime(), maxAgeMs: SPEAK_TICKET_MS })
    if (!ticket) {
      response.status(401).json({ error: SAY.ended })
      return
    }
    if (ticket.mouth !== 'fish') {
      response.status(403).json({ error: SAY.notFish })
      return
    }
    if (body.warm === true) {
      response.status(204).end()
      return
    }
    const text = cleanSpeakText(body.text)
    if (!text) {
      response.status(400).json({ error: SAY.noText })
      return
    }

    const model = config.fishModel === FISH_PAID_MODEL && ticket.fishModel === FISH_PAID_MODEL ? FISH_PAID_MODEL : FISH_FREE_MODEL
    let upstream
    try {
      upstream = await fetch(FISH_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${environment.FISH_API_KEY.trim()}`, 'Content-Type': 'application/json', model },
        body: JSON.stringify({ text, reference_id: config.fishVoiceId, format: 'mp3', latency: 'low' }),
        signal: AbortSignal.timeout(FISH_TIMEOUT_MS)
      })
    } catch (error) {
      // The error's own message is not looked at: it can carry whatever the request carried.
      const slow = timedOut(error)
      response.status(slow ? 504 : 502).json({ error: slow ? SAY.slow : SAY.failed })
      return
    }
    if (!upstream.ok) {
      // Fish's answer is not read at all: its status is enough to choose a sentence.
      await upstream.body?.cancel().catch(() => {})
      const { status, error } = refusalFor(upstream.status)
      response.status(status).json({ error })
      return
    }

    let audio
    try {
      audio = upstream.body ? await readCapped(upstream.body, MAX_AUDIO_BYTES) : null
    } catch (error) {
      const slow = timedOut(error)
      response.status(slow ? 504 : 502).json({ error: slow ? SAY.slow : SAY.failed })
      return
    }
    if (!audio || !isMp3(audio)) {
      response.status(502).json({ error: SAY.notAudio })
      return
    }
    response.setHeader('Content-Type', 'audio/mpeg')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.status(200).end(audio)
  }
}

export default makeHandler()
