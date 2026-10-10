// A fake browser for a voice call, and the page booted with voice on: what tests/voice-call.test.mjs
// and tests/voice-fish.test.mjs share. Every part of the browser openVoice reaches for is here, and
// every step it takes is written down in `log`.

import { loadPage, flush } from './page-harness.mjs'
import { basePayload, brandAnswer, VOICE_ON } from './page-payload.mjs'
import { SDP_OFFER, SDP_ANSWER, OPENAI_KEY } from './voice-fixtures.mjs'
import { signTicket, newSessionId } from '../../api/_voice.js'
import { VOICE_PRICES } from '../../api/_voice-prices.js'

export const NOW = Date.parse('2026-10-09T12:00:00Z')
export const ticketFor = (mouth = 'openai') =>
  signTicket({ sid: newSessionId(), iat: NOW, mouth, model: 'gpt-realtime-2.1-mini', ...(mouth === 'fish' ? { fishModel: 's2.1-pro-free' } : {}) }, OPENAI_KEY)
export const PRICES = { ...structuredClone(VOICE_PRICES), transcribeModel: 'gpt-4o-mini-transcribe' }

export async function page(brand = brandAnswer({ voice: VOICE_ON })) {
  const given = {}
  const loaded = loadPage({
    fetch: async (url) => ({ ok: true, status: 200, json: async () => (url.startsWith('/api/brand') ? brand : url.startsWith('/api/state') ? basePayload() : {}) }),
    expose: ['openVoice', 'voiceTap', 'voiceDeps', 'fishMouth', 'VOICE_MIC_BLOCKED', 'VOICE_UNHEARD'],
    after: 'given.current = () => voiceSession',
    given
  })
  await flush()
  return { ...loaded, current: () => given.current() }
}

// A browser that does what the page asks and writes down every step.
// `motion` is a device that has not asked for less motion: the orb's glow then follows the reply's
// loudness, which `state.loudness` sets (0 to 127 either side of silence) and `frame()` moves on.
export function fakeBrowser({ micError = null, answer = {}, refusal = null, cancelOnBargeIn = false, prices = PRICES, holdDecode = false, finePointer = false, headphones = false, motion = false, debug = false } = {}) {
  const log = []
  const timers = new Map()
  let nextTimer = 1
  const tracks = [{ kind: 'audio', stopped: false, stop() { this.stopped = true; log.push('track stopped') } }]
  const stream = { getTracks: () => tracks, getAudioTracks: () => tracks }
  const audio = { srcObject: undefined, removed: false, remove() { this.removed = true } }
  // `decodes` holds a decode the test finishes itself, when holdDecode is on.
  const state = { pc: null, channel: null, context: null, constraints: null, saved: [], ended: [], opened: [], calls: [], decodes: [], loudness: 0 }
  const frames = new Map()
  let nextFrame = 1
  const ticket = answer.ticket ?? ticketFor(answer.mouth ?? 'openai')
  class FakeConnection {
    constructor() { state.pc = this; this.closed = false; this.tracks = []; log.push('connection') }
    addTrack(track) { this.tracks.push(track); log.push('add track') }
    createDataChannel(name) {
      log.push(`channel ${name}`)
      state.channel = {
        name, readyState: 'connecting', sent: [], closed: false,
        send(text) { this.sent.push(JSON.parse(text)) },
        close() { this.closed = true; this.readyState = 'closed'; this.onclose?.() }
      }
      return state.channel
    }
    async createOffer() { log.push('offer'); return { type: 'offer', sdp: SDP_OFFER } }
    async setLocalDescription() { log.push('local description') }
    async setRemoteDescription(description) { this.remote = description; log.push('remote description') }
    close() { this.closed = true; log.push('connection closed') }
  }
  // Fish's sound is decoded and scheduled here; each scheduled piece is written down in `started`.
  class FakeAudioContext {
    constructor() {
      state.context = this
      this.closed = false
      this.currentTime = 0
      this.destination = { name: 'speakers' }
      this.started = []
      this.analysers = []
      this.sources = []
      log.push('audio context')
    }
    resume() { log.push('audio resumed') }
    close() { this.closed = true }
    async decodeAudioData(bytes) {
      if (bytes?.broken) throw new Error('not audio')
      if (holdDecode) await new Promise((resolve) => state.decodes.push(resolve))
      return { duration: 1.5, text: bytes?.text }
    }
    createAnalyser() {
      const analyser = {
        fftSize: 2048, to: null, disconnected: false,
        connect(to) { this.to = to },
        disconnect() { this.to = null; this.disconnected = true },
        getByteTimeDomainData(samples) {
          for (let at = 0; at < samples.length; at += 1) samples[at] = 128 + (at % 2 ? state.loudness : -state.loudness)
        }
      }
      this.analysers.push(analyser)
      return analyser
    }
    createMediaStreamSource(stream) {
      const source = { stream, to: null, disconnected: false, connect(to) { this.to = to }, disconnect() { this.to = null; this.disconnected = true } }
      this.sources.push(source)
      return source
    }
    createBufferSource() {
      const context = this
      const node = {
        buffer: null, at: null, stopped: false, to: null,
        connect(to) { this.to = to },
        start(at) { this.at = at; context.started.push(this) },
        stop() { this.stopped = true }
      }
      return node
    }
  }
  // /api/speak, answered when the test says: each call waits until answered, failed, or aborted.
  const speeches = []
  const speak = (body, signal) => new Promise((resolve, reject) => {
    const speech = {
      body, signal,
      answer: (ok = true) => resolve({ ok, status: ok ? 200 : 502, arrayBuffer: async () => ({ text: body.text }) }),
      broken: () => resolve({ ok: true, status: 200, arrayBuffer: async () => ({ broken: true }) })
    }
    signal?.addEventListener?.('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    speeches.push(speech)
  })
  const clock = { now: NOW }
  const deps = {
    mediaDevices: {
      getUserMedia(constraints) {
        state.constraints = constraints
        log.push('microphone asked')
        return micError ? Promise.reject(micError) : Promise.resolve(stream)
      }
    },
    RTCPeerConnection: FakeConnection,
    AudioContext: FakeAudioContext,
    createAudio: () => { log.push('audio element'); return audio },
    async startCall(sdp) {
      state.calls.push(sdp)
      log.push('call offered to the board')
      if (refusal) throw new Error(refusal)
      return { json: async () => ({ sdp: SDP_ANSWER, ticket, mouth: 'openai', model: 'gpt-realtime-2.1-mini', name: 'Penny', idleMinutes: 2, captions: true, ...answer }) }
    },
    view: () => ({ data: basePayload(), names: {}, now: NOW, hermes: false, spend: null }),
    openScreen: (screen) => state.opened.push(screen),
    prices: () => prices,
    saveOutbox: (entry) => state.saved.push(structuredClone(entry)),
    onEnd: (reason) => state.ended.push(reason),
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id },
    clearTimeout: (id) => { timers.delete(id) },
    cancelOnBargeIn,
    // A mouse (a computer) or a finger (a phone), and the clock the echo guard reads.
    finePointer,
    // "I'm on headphones", as this device remembers it.
    headphones: () => headphones,
    now: () => clock.now,
    reducedMotion: () => !motion,
    // A developer's machine, where the page may log timings.
    debug: () => debug,
    requestAnimationFrame: (fn) => { const id = nextFrame++; frames.set(id, fn); return id },
    cancelAnimationFrame: (id) => { frames.delete(id) }
  }
  const ui = {
    shown: [], heard: [], spoken: [], costs: [], names: [], levels: [],
    show(stateName, { words, live } = {}) { this.shown.push({ state: stateName, words, live }) },
    you(text) { this.heard.push(text) },
    said(text) { this.spoken.push(text) },
    cost(text) { this.costs.push(text) },
    who(name) { this.names.push(name) },
    level(value) { this.levels.push(value) }
  }
  return {
    deps, ui, log, tracks, audio, state, ticket, timers, speeches, speak, clock, frames,
    emit: (event) => state.channel.onmessage({ data: JSON.stringify(event) }),
    open: () => { state.channel.readyState = 'open'; state.channel.onopen() },
    lastState: () => ui.shown.at(-1)?.state,
    fireTimer: () => { const [id, timer] = [...timers.entries()].at(-1); timers.delete(id); timer.fn() },
    // The next animation frame, as the browser would run it.
    frame: () => { const [id, fn] = [...frames.entries()][0]; frames.delete(id); fn() }
  }
}

export async function connected(options) {
  const loaded = await page()
  const browser = fakeBrowser(options)
  browser.deps.fish = loaded.exposed.fishMouth({ speak: browser.speak, now: () => browser.clock.now })
  const call = loaded.exposed.openVoice(browser.deps, browser.ui)
  await flush()
  browser.open()
  return { ...browser, call, exposed: loaded.exposed }
}
