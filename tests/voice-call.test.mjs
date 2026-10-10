// A whole voice call, run against a fake browser: a microphone, a WebRTC connection with its events
// channel, an <audio> element and the clock are all handed in through openVoice's `deps`, the seam
// the page fills with voiceDeps(). Nothing here can prove a real call works - that is the live proof
// (T14) - but everything the page decides is decided here: what it asks for and in what order, what
// state it says it is in, how it answers a tool, what it counts, and that everything it opened is
// closed again.

import test from 'node:test'
import assert from 'node:assert/strict'
import { flush } from './helpers/page-harness.mjs'
import { SDP_OFFER, SDP_ANSWER, REPLY_USAGE, TRANSCRIPTION_USAGE } from './helpers/voice-fixtures.mjs'
import { ticketSays, voiceToolAnswer, costOf } from '../api/_voice.js'
import { VOICE_PRICES } from '../api/_voice-prices.js'
import { NOW, ticketFor, page, fakeBrowser, connected } from './helpers/voice-browser.mjs'

/* ---------- starting ---------- */

test('the tap asks for the microphone with echo-cancel and noise-suppress, and starts the sound, before anything waits', async () => {
  const loaded = await page()
  const browser = fakeBrowser()
  loaded.exposed.openVoice(browser.deps, browser.ui)
  // Synchronously, inside the tap: an iPhone allows neither from anything else.
  assert.deepEqual(browser.log.slice(0, 3), ['audio context', 'audio resumed', 'microphone asked'])
  assert.deepEqual(browser.state.constraints, { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
  assert.deepEqual(browser.ui.shown[0], { state: 'connecting', words: undefined, live: true })
})

test('the events channel is made before the offer, and the offer goes to the board - never to OpenAI', async () => {
  const browser = await connected()
  const order = browser.log.filter((step) => !['audio context', 'audio resumed', 'microphone asked'].includes(step))
  assert.deepEqual(order, ['connection', 'audio element', 'add track', 'channel oai-events', 'offer', 'local description', 'call offered to the board', 'remote description'])
  assert.deepEqual(browser.state.calls, [SDP_OFFER])
  assert.deepEqual(browser.state.pc.remote, { type: 'answer', sdp: SDP_ANSWER })
  assert.equal(browser.lastState(), 'listening', 'an open call does not say it is listening')
  assert.deepEqual(browser.ui.names, ['Penny'])
})

test('OpenAI\'s voice plays from the call\'s own sound track, in an <audio> element - no address, nothing for the CSP to allow', async () => {
  const browser = await connected()
  const remote = { id: 'remote stream' }
  browser.state.pc.ontrack({ streams: [remote] })
  assert.equal(browser.audio.srcObject, remote)
})

/* ---------- talking ---------- */

test('the states follow the conversation: listening, thinking, speaking, and listening again', async () => {
  const browser = await connected()
  browser.emit({ type: 'input_audio_buffer.speech_started' })
  assert.equal(browser.lastState(), 'listening')
  browser.emit({ type: 'input_audio_buffer.speech_stopped' })
  assert.equal(browser.lastState(), 'thinking')
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'response.output_audio_transcript.delta', delta: 'Three jobs ' })
  browser.emit({ type: 'response.output_audio_transcript.delta', delta: 'are due.' })
  assert.equal(browser.lastState(), 'speaking')
  assert.deepEqual(browser.ui.spoken, ['', 'Three jobs ', 'Three jobs are due.'], 'the words are not shown as they arrive, after an empty start')
  browser.emit({ type: 'response.done', response: { usage: REPLY_USAGE, output: [] } })
  assert.equal(browser.lastState(), 'speaking', 'it said Listening while its voice was still playing')
  browser.emit({ type: 'output_audio_buffer.stopped' })
  assert.equal(browser.lastState(), 'listening')
})

test('what the person said appears from the caption, and the caption\'s cost is counted', async () => {
  const browser = await connected()
  browser.emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'What is due today?', usage: TRANSCRIPTION_USAGE })
  assert.equal(browser.ui.heard.at(-1), 'What is due today?')
  assert.equal(browser.state.saved.at(-1).counts.transcribeAudioIn, 17)
})

test('a tool call is answered from the board: its output, then one request for the reply', async () => {
  const browser = await connected()
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'response.function_call_arguments.done', call_id: 'call_1', name: 'whats_due', arguments: '{"hours":24}' })
  browser.emit({ type: 'response.function_call_arguments.done', call_id: 'call_2', name: 'open_screen', arguments: '{"screen":"connections"}' })
  browser.emit({ type: 'response.done', response: { usage: REPLY_USAGE, output: [{ type: 'function_call', call_id: 'call_1', name: 'whats_due', arguments: '{"hours":24}' }] } })
  const sent = browser.state.channel.sent
  assert.deepEqual(sent.map((event) => event.type), ['conversation.item.create', 'conversation.item.create', 'response.create'])
  assert.deepEqual(sent[0].item, {
    type: 'function_call_output',
    call_id: 'call_1',
    output: JSON.stringify(voiceToolAnswer('whats_due', { hours: 24 }, browser.deps.view()))
  })
  assert.deepEqual(JSON.parse(sent[1].item.output), { opened: 'connections' })
  assert.deepEqual(browser.state.opened, ['connections'])
  assert.equal(browser.lastState(), 'thinking')
})

test('a tool call with broken arguments, or a tool nobody defined, is still answered - with an error, not a guess', async () => {
  const browser = await connected()
  browser.emit({ type: 'response.function_call_arguments.done', call_id: 'call_x', name: 'run_job', arguments: '{"slug":' })
  browser.emit({ type: 'response.done', response: { usage: REPLY_USAGE } })
  const [output, again] = browser.state.channel.sent
  assert.ok(JSON.parse(output.item.output).error)
  assert.equal(again.type, 'response.create')
  assert.deepEqual(browser.state.opened, [])
})

test('the outbox is written after every reply, with the counts so far, under the ticket\'s session', async () => {
  const browser = await connected()
  browser.emit({ type: 'response.done', response: { usage: REPLY_USAGE } })
  browser.emit({ type: 'response.done', response: { usage: REPLY_USAGE } })
  assert.equal(browser.state.saved.length, 2)
  const [first, second] = browser.state.saved
  const claims = ticketSays(browser.ticket)
  assert.equal(second.sid, claims.sid)
  assert.equal(second.ticket, browser.ticket)
  assert.equal(second.at, new Date(NOW).toISOString())
  assert.equal(first.counts.audioOut, 91)
  assert.equal(second.counts.audioOut, 182)
  assert.equal(second.counts.cachedTextIn, 128)
})

test('the sheet shows a live estimate from the server\'s price table, and says when there is none', async () => {
  const browser = await connected()
  browser.emit({ type: 'response.done', response: { usage: REPLY_USAGE } })
  const expected = costOf({ textIn: 55, cachedTextIn: 64, audioIn: 13, textOut: 30, audioOut: 91 }, { model: 'gpt-realtime-2.1-mini' }, VOICE_PRICES)
  assert.ok(expected.usd < 0.01)
  assert.equal(browser.ui.costs.at(-1), 'This conversation ≈ under $0.01 (estimate)')
  const none = await connected({ prices: null })
  none.emit({ type: 'response.done', response: { usage: REPLY_USAGE } })
  assert.match(none.ui.costs.at(-1), /no estimate yet/)
})

test('an error event is said in our words and the call carries on; OpenAI\'s words are never shown', async () => {
  const browser = await connected()
  browser.emit({ type: 'error', error: { code: 'server_error', message: 'Internal failure req_123' } })
  assert.equal(browser.ui.shown.at(-1).words, browser.exposed.VOICE_UNHEARD)
  assert.ok(!JSON.stringify(browser.ui).includes('req_123'))
  assert.equal(browser.state.ended.length, 0)
  const before = browser.ui.shown.length
  browser.emit({ type: 'error', error: { code: 'response_cancel_not_active' } })
  assert.equal(browser.ui.shown.length, before, 'cancelling a finished reply was reported as a problem')
})

/* ---------- talking over it ---------- */

test('talking over a reply goes straight back to listening; OpenAI cancels it, so nothing is sent', async () => {
  const browser = await connected()
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'response.output_audio_transcript.delta', delta: 'A long answer' })
  assert.equal(browser.lastState(), 'speaking')
  browser.emit({ type: 'input_audio_buffer.speech_started' })
  assert.equal(browser.lastState(), 'listening')
  assert.deepEqual(browser.state.channel.sent, [], 'something was sent that OpenAI does by itself')
  assert.equal(browser.call.session.turns.current, 1, 'talking over a reply did not start a new turn')
})

test('with the barge-in flag on, talking over a reply also sends response.cancel and output_audio_buffer.clear', async () => {
  const browser = await connected({ cancelOnBargeIn: true })
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'response.output_audio_transcript.delta', delta: 'A long answer' })
  browser.emit({ type: 'input_audio_buffer.speech_started' })
  assert.deepEqual(browser.state.channel.sent.map((event) => event.type), ['response.cancel', 'output_audio_buffer.clear'])
  // With nothing being said, there is nothing to cancel.
  const quiet = await connected({ cancelOnBargeIn: true })
  quiet.emit({ type: 'input_audio_buffer.speech_started' })
  assert.deepEqual(quiet.state.channel.sent, [])
})

/* ---------- ending ---------- */

const everythingClosed = (browser) => {
  assert.ok(browser.tracks.every((track) => track.stopped), 'the microphone was left on')
  assert.equal(browser.state.pc.closed, true, 'the connection was left open')
  assert.equal(browser.state.channel.closed, true, 'the events channel was left open')
  assert.equal(browser.audio.srcObject, null, 'the sound was left playing')
  assert.equal(browser.state.context.closed, true, 'the audio context was left running')
  assert.equal(browser.timers.size, 0, 'a timer was left behind')
}

test('Stop closes everything it opened, once, and says it ended', async () => {
  const browser = await connected()
  browser.call.stop('stopped')
  everythingClosed(browser)
  assert.deepEqual(browser.state.ended, ['stopped'])
  assert.deepEqual(browser.ui.shown.at(-1), { state: 'ended', words: 'Ended. Tap the orb to talk again.', live: false })
  browser.call.stop('stopped')
  assert.deepEqual(browser.state.ended, ['stopped'], 'a second Stop ended it twice')
})

test('no talking for the idle minutes hangs up - the person talking, or a reply finishing, starts the wait again', async () => {
  const browser = await connected({ answer: { idleMinutes: 3 } })
  const waits = () => [...browser.timers.values()].map((timer) => timer.ms)
  const waiting = () => [...browser.timers.keys()]
  assert.deepEqual(waits(), [3 * 60_000])
  for (const event of [
    { type: 'input_audio_buffer.speech_started' },
    { type: 'output_audio_buffer.stopped' }
  ]) {
    const before = waiting()
    browser.emit(event)
    assert.deepEqual(waits(), [3 * 60_000], `${event.type} left two hang-ups waiting`)
    assert.notDeepEqual(waiting(), before, `${event.type} did not start the wait again`)
  }
  browser.fireTimer()
  everythingClosed(browser)
  assert.deepEqual(browser.state.ended, ['idle'])
  assert.match(browser.ui.shown.at(-1).words, /Ended after 3 minutes with no talking/)
})

test('a microphone that is blocked gets one sentence saying where to allow it, and nothing else starts', async () => {
  const loaded = await page()
  for (const name of ['NotAllowedError', 'SecurityError']) {
    const browser = fakeBrowser({ micError: Object.assign(new Error('Permission denied by system'), { name }) })
    loaded.exposed.openVoice(browser.deps, browser.ui)
    await flush()
    const last = browser.ui.shown.at(-1)
    assert.equal(last.state, 'error')
    assert.equal(last.words, loaded.exposed.VOICE_MIC_BLOCKED)
    assert.match(last.words, /Settings > Safari > Microphone/)
    assert.match(last.words, /Chrome/)
    assert.equal(browser.state.pc, null, 'a call was started with no microphone')
    assert.equal(browser.state.context.closed, true)
    assert.deepEqual(browser.state.ended, ['error'])
  }
  const missing = fakeBrowser({ micError: Object.assign(new Error('x'), { name: 'NotFoundError' }) })
  loaded.exposed.openVoice(missing.deps, missing.ui)
  await flush()
  assert.match(missing.ui.shown.at(-1).words, /No microphone was found/)
})

test('the board refusing the call shows its sentence and turns the microphone off', async () => {
  const loaded = await page()
  const sentence = 'OpenAI\'s spending limit for this key is reached, so voice is off until next month or until you raise it.'
  const browser = fakeBrowser({ refusal: sentence })
  loaded.exposed.openVoice(browser.deps, browser.ui)
  await flush()
  assert.deepEqual(browser.ui.shown.at(-1), { state: 'error', words: sentence, live: false })
  assert.ok(browser.tracks.every((track) => track.stopped))
  assert.equal(browser.state.pc.closed, true)
})

test('an answer that is not a call is refused rather than half-started', async () => {
  const loaded = await page()
  for (const answer of [{ sdp: 'nonsense' }, { ticket: 'not.a-ticket' }, { sdp: undefined }]) {
    const browser = fakeBrowser({ answer })
    loaded.exposed.openVoice(browser.deps, browser.ui)
    await flush()
    assert.equal(browser.ui.shown.at(-1).state, 'error', JSON.stringify(answer))
    assert.equal(browser.state.pc.remote, undefined, 'an answer that is not one was applied')
  }
})

test('Stop while it is still connecting leaves nothing running when the microphone arrives', async () => {
  const loaded = await page()
  let allow
  const browser = fakeBrowser()
  browser.deps.mediaDevices.getUserMedia = () => new Promise((resolve) => { allow = resolve })
  const call = loaded.exposed.openVoice(browser.deps, browser.ui)
  call.stop('stopped')
  allow({ getTracks: () => browser.tracks })
  await flush()
  assert.ok(browser.tracks.every((track) => track.stopped), 'the microphone came on after Stop')
  assert.equal(browser.state.pc, null)
})

test('a call that drops is said, and closed', async () => {
  const browser = await connected()
  browser.state.pc.connectionState = 'failed'
  browser.state.pc.onconnectionstatechange()
  everythingClosed(browser)
  assert.deepEqual(browser.state.ended, ['dropped'])
  assert.match(browser.ui.shown.at(-1).words, /dropped/)
})

/* ---------- the tap on the page ---------- */

test('a tap on the page starts one call, and a second tap or its end lets it go', async () => {
  const loaded = await page()
  const browser = fakeBrowser()
  // The tap is given the page's own dependencies, with the browser's parts swapped for fakes.
  const deps = { ...loaded.exposed.voiceDeps(), ...browser.deps, onEnd: loaded.exposed.voiceDeps().onEnd }
  loaded.exposed.voiceTap(deps)
  const live = loaded.current()
  assert.ok(live, 'the tap did not start a call')
  loaded.exposed.voiceTap(deps)
  assert.equal(loaded.current(), null, 'a second tap left the call running')
  await flush()
  assert.ok(browser.tracks.every((track) => track.stopped), 'the microphone came on after the second tap')
  // A tap after that is a new call.
  const next = fakeBrowser()
  loaded.exposed.voiceTap({ ...deps, ...next.deps, onEnd: deps.onEnd })
  assert.ok(loaded.current() && loaded.current() !== live)
})

/* ---------- reading a ticket ---------- */

test('the page reads a ticket\'s session, time, model and mouth, and nothing that is not a ticket', () => {
  const ticket = ticketFor('fish')
  const said = ticketSays(ticket)
  assert.match(said.sid, /^[0-9a-f]{32}$/)
  assert.equal(said.iat, NOW)
  assert.equal(said.mouth, 'fish')
  assert.equal(said.fishModel, 's2.1-pro-free')
  for (const wrong of ['', 'abc', 'a.b.c', null, 42, `${Buffer.from('{"sid":"x"}').toString('base64url')}.${'a'.repeat(43)}`]) {
    assert.equal(ticketSays(wrong), null, String(wrong))
  }
})

test('a browser error while starting is our sentence, never the browser\'s own words', async () => {
  const loaded = await page()
  const browser = fakeBrowser()
  const Real = browser.deps.RTCPeerConnection
  browser.deps.RTCPeerConnection = class extends Real {
    async createOffer() { throw new Error('InvalidStateError: m-line 3 has no ice-ufrag (internal detail)') }
  }
  loaded.exposed.openVoice(browser.deps, browser.ui)
  await flush()
  const last = browser.ui.shown.at(-1)
  assert.equal(last.state, 'error')
  assert.match(last.words, /could not start in this browser/)
  assert.ok(!last.words.includes('ice-ufrag'))
  assert.ok(browser.tracks.every((track) => track.stopped))
})

test('a new call starts with an empty sheet, never the last call\'s words or cost', async () => {
  const loaded = await page()
  const browser = fakeBrowser()
  loaded.exposed.openVoice(browser.deps, browser.ui)
  assert.deepEqual([browser.ui.heard[0], browser.ui.spoken[0], browser.ui.costs[0]], ['', '', ''])
})

test('the page sends the offer to the board as JSON - the one way Vercel hands a body over', async () => {
  const loaded = await page()
  await loaded.exposed.voiceDeps().startCall(SDP_OFFER)
  const sent = loaded.requests.find((request) => request.url === '/api/voice-session')
  assert.ok(sent, 'the offer never went to the board')
  assert.equal(sent.init.method, 'POST')
  assert.equal(sent.init.headers['Content-Type'], 'application/json')
  // And whether the echo guard will run here - a computer on headphones; the harness's window has no
  // fine pointer - which alone decides whether a transcript is asked for when captions are off.
  assert.deepEqual(JSON.parse(sent.init.body), { sdp: SDP_OFFER, echoGuardHere: false, names: [], micDistance: 'near', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
})

test('the outbox entry says the conversation is still going until the call ends', async () => {
  const browser = await connected()
  browser.emit({ type: 'response.done', response: { usage: REPLY_USAGE } })
  assert.equal(browser.state.saved.at(-1).open, true, 'a live conversation could be reported half-counted')
  browser.call.stop('stopped')
  assert.equal(browser.state.saved.at(-1).open, false, 'an ended conversation is still marked as going')
  assert.equal(browser.state.saved.at(-1).counts.audioOut, 91)
})

/* ---------- the reply to a tool round trip: never lost to a response OpenAI started itself ---------- */
// From the live test on a preview (2026-10-09, Chrome, real OpenAI): the model spoke a preamble,
// asked for two tools and finished at 1148 ms; at 1249 ms the server's VAD committed a turn (the
// assistant's own voice, heard back) and started a NEW response at 1254 ms; the page's response.create
// for the tool outputs was then refused - "Conversation already has an active response in progress" -
// and the outputs were never answered. OpenAI's own error event, word for word but the id:
const ACTIVE_RESPONSE = {
  type: 'error',
  error: {
    type: 'invalid_request_error',
    code: 'conversation_already_has_active_response',
    message: 'Conversation already has an active response in progress: resp_123. Wait until the response is finished before creating a new one.'
  }
}
const TOOL_CALLS = [
  { type: 'function_call', call_id: 'call_1', name: 'whats_due', arguments: '{"hours":24}' },
  { type: 'function_call', call_id: 'call_2', name: 'team_status', arguments: '{}' }
]
const toolReply = (browser, extra = {}) => {
  for (const call of TOOL_CALLS) browser.emit({ ...call, type: 'response.function_call_arguments.done' })
  browser.emit({ type: 'response.done', response: { status: 'completed', usage: REPLY_USAGE, output: TOOL_CALLS, ...extra } })
}
const sentTypes = (browser) => browser.state.channel.sent.map((event) => event.type)
const creates = (browser) => sentTypes(browser).filter((type) => type === 'response.create').length

test('the live race: a turn the server heard mid-reply holds the tool reply until its own response is done, then asks once', async () => {
  const browser = await connected()
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'response.output_audio_transcript.delta', delta: 'Let me check the board.' })
  browser.emit({ type: 'input_audio_buffer.speech_started' })
  toolReply(browser)
  assert.deepEqual(sentTypes(browser), ['conversation.item.create', 'conversation.item.create'], 'the outputs did not go at once, or a reply was asked for while a turn was being heard')
  browser.emit({ type: 'input_audio_buffer.speech_stopped' })
  browser.emit({ type: 'input_audio_buffer.committed' })
  browser.emit({ type: 'response.created' })
  assert.equal(creates(browser), 0, 'a reply was asked for while OpenAI\'s own response was running')
  browser.emit({ type: 'response.done', response: { status: 'completed', usage: REPLY_USAGE, output: [] } })
  assert.equal(creates(browser), 1, 'the tool outputs were never answered')
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'response.done', response: { status: 'completed', usage: REPLY_USAGE, output: [] } })
  assert.equal(creates(browser), 1, 'the reply was asked for twice')
})

test('if OpenAI refuses the request because a response is running, it is asked again once - after that response - and never loops', async () => {
  const browser = await connected()
  browser.emit({ type: 'response.created' })
  toolReply(browser)
  assert.deepEqual(sentTypes(browser), ['conversation.item.create', 'conversation.item.create', 'response.create'])
  // The server's VAD started its own response first, so ours was refused.
  browser.emit({ type: 'response.created' })
  browser.emit(ACTIVE_RESPONSE)
  assert.notEqual(browser.ui.shown.at(-1).words, browser.exposed.VOICE_UNHEARD, 'a refusal the page handles was shown as a failure')
  assert.equal(creates(browser), 1)
  browser.emit({ type: 'response.done', response: { status: 'completed', usage: REPLY_USAGE, output: [] } })
  assert.equal(creates(browser), 2, 'the refused request was not asked again after the running response')
  // Refused again: no third try for this batch.
  browser.emit({ type: 'response.created' })
  browser.emit(ACTIVE_RESPONSE)
  browser.emit({ type: 'response.done', response: { status: 'completed', usage: REPLY_USAGE, output: [] } })
  assert.equal(creates(browser), 2, 'one tool batch asked for a reply more than twice')
})

test('talking over a tool round trip keeps the outputs, and the reply comes once after the person\'s turn', async () => {
  const browser = await connected()
  browser.emit({ type: 'response.created' })
  browser.emit({ ...TOOL_CALLS[0], type: 'response.function_call_arguments.done' })
  browser.emit({ type: 'input_audio_buffer.speech_started' })
  browser.emit({ type: 'response.done', response: { status: 'cancelled', usage: REPLY_USAGE, output: [TOOL_CALLS[0]] } })
  const [output] = browser.state.channel.sent
  assert.equal(output?.item?.call_id, 'call_1', 'a tool output was dropped when the person talked over it')
  assert.equal(creates(browser), 0, 'a reply was asked for while the person was talking')
  browser.emit({ type: 'input_audio_buffer.speech_stopped' })
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'response.done', response: { status: 'completed', usage: REPLY_USAGE, output: [] } })
  assert.equal(creates(browser), 1)
})

test('a reply held for a turn that never gets a response of its own is asked for 1.5 seconds after the turn ends', async () => {
  const browser = await connected()
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'input_audio_buffer.speech_started' })
  toolReply(browser)
  browser.emit({ type: 'input_audio_buffer.speech_stopped' })
  const held = [...browser.timers.entries()].find(([, timer]) => timer.ms === 1500)
  assert.ok(held, 'nothing waits to ask for the held reply')
  assert.equal(creates(browser), 0)
  held[1].fn()
  assert.equal(creates(browser), 1)
  // And when a response does start in that time, the wait is dropped and the reply waits for it.
  const other = await connected()
  other.emit({ type: 'response.created' })
  other.emit({ type: 'input_audio_buffer.speech_started' })
  toolReply(other)
  other.emit({ type: 'input_audio_buffer.speech_stopped' })
  other.emit({ type: 'response.created' })
  assert.ok(![...other.timers.values()].some((timer) => timer.ms === 1500), 'the wait was left running after a response started')
})

test('the reply plays the way OpenAI\'s WebRTC guide does it: an <audio> element, autoplay, srcObject from ontrack, kept for the whole call', async () => {
  // Chrome's echo canceller needs the call's sound to play from the call's own track; this is that.
  const loaded = await page()
  const audio = loaded.exposed.voiceDeps().createAudio()
  assert.equal(audio.tagName, 'AUDIO')
  assert.equal(audio.autoplay, true)
  assert.equal(audio.attributes.playsinline, '')
  assert.ok(loaded.node('voice-dock').children.includes(audio), 'the element is not in the page')
  const browser = await connected()
  const remote = { id: 'the call' }
  browser.state.pc.ontrack({ track: { kind: 'audio' }, streams: [remote] })
  browser.emit({ type: 'response.done', response: { usage: REPLY_USAGE } })
  assert.equal(browser.audio.srcObject, remote)
  assert.equal(browser.audio.removed, false, 'the element went before the call ended')
  browser.call.stop('stopped')
  assert.equal(browser.audio.removed, true)
})

/* ---------- the echo guard: a computer on speakers hearing itself ---------- */
// The live test (desktop, speakers, quiet room): 1.3 to 1.5 s into each reply the server heard the
// assistant's own voice as a turn - "It happened.", "Still fight.", "Adiós." - cut the reply off and
// answered it. On a computer (a mouse, not a finger), a turn that starts in the first 1.5 s of the
// assistant's sound and turns out to be under 3 words is taken for its own voice: the response the
// server started for it is cancelled, the turn is deleted so the model never sees it, and the reply
// is asked for again once. Barge-in itself is untouched - it is still instant, on every device.

const guarded = (options = {}) => connected({ answer: { echoGuard: true }, finePointer: true, headphones: true, ...options })
async function heardItself(browser, transcript, { after = 1200, responseFirst = true } = {}) {
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'output_audio_buffer.started' })
  browser.clock.now += after
  browser.emit({ type: 'input_audio_buffer.speech_started' })
  browser.emit({ type: 'response.done', response: { status: 'cancelled', usage: REPLY_USAGE, output: [] } })
  browser.emit({ type: 'input_audio_buffer.speech_stopped' })
  browser.emit({ type: 'input_audio_buffer.committed' })
  if (responseFirst) browser.emit({ type: 'response.created' })
  browser.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_echo', transcript, usage: TRANSCRIPTION_USAGE })
}

test('on a computer, a two-word turn 1.2 s into the reply is its own voice: cancelled, deleted, and the reply asked for again', async () => {
  const browser = await guarded()
  await heardItself(browser, 'It happened.')
  assert.deepEqual(browser.state.channel.sent, [
    { type: 'response.cancel' },
    { type: 'output_audio_buffer.clear' },
    { type: 'conversation.item.delete', item_id: 'item_echo' }
  ])
  assert.ok(!browser.ui.heard.includes('It happened.'), 'its own voice was shown as what the person said')
  browser.emit({ type: 'response.done', response: { status: 'cancelled', usage: REPLY_USAGE, output: [] } })
  assert.equal(browser.state.channel.sent.filter((event) => event.type === 'response.create').length, 1, 'the cut-off reply was not asked for again')
  assert.equal(browser.state.saved.at(-1).counts.transcribeAudioIn, 17, 'the caption it paid for was not counted')
})

test('a turn the server has not answered yet is only deleted - nothing to cancel, nothing more to ask', async () => {
  const browser = await guarded()
  await heardItself(browser, 'Adiós.', { responseFirst: false })
  assert.deepEqual(browser.state.channel.sent, [{ type: 'conversation.item.delete', item_id: 'item_echo' }])
})

test('the guard leaves real talking alone: three words or more, a turn after 1.5 s, a phone, or VOICE_ECHO_GUARD off', async () => {
  const cases = [
    ['three words', guarded(), 'Wait, what about', {}],
    ['after 1.5 seconds', guarded(), 'Stop.', { after: 1600 }],
    ['on a phone', connected({ answer: { echoGuard: true }, finePointer: false }), 'Stop.', {}],
    ['switched off', connected({ answer: { echoGuard: false }, finePointer: true, headphones: true }), 'Stop.', {}],
    ['in speakers mode, where the microphone rests while it talks', connected({ answer: { echoGuard: true }, finePointer: true }), 'Stop.', {}]
  ]
  for (const [what, made, transcript, options] of cases) {
    const browser = await made
    await heardItself(browser, transcript, options)
    assert.deepEqual(browser.state.channel.sent, [], `${what}: the person was taken for the assistant`)
    assert.ok(browser.ui.heard.includes(transcript), `${what}: what the person said was hidden`)
  }
})

test('five echoes in a row: the cut-off reply is asked for again once, every echo is deleted, and none restarts the idle wait', async () => {
  const browser = await guarded()
  const idleWait = () => [...browser.timers.entries()].filter(([, timer]) => timer.ms === 2 * 60_000).map(([id]) => id)
  // A real question first: nothing is playing, so it is the person.
  browser.emit({ type: 'input_audio_buffer.speech_started' })
  browser.emit({ type: 'input_audio_buffer.speech_stopped' })
  browser.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_q', transcript: 'What is due today?', usage: TRANSCRIPTION_USAGE })
  const waiting = idleWait()
  for (let echo = 1; echo <= 5; echo += 1) {
    browser.emit({ type: 'response.created' })
    browser.emit({ type: 'output_audio_buffer.started' })
    browser.clock.now += 1200
    browser.emit({ type: 'input_audio_buffer.speech_started' })
    browser.emit({ type: 'response.done', response: { status: 'cancelled', usage: REPLY_USAGE, output: [] } })
    browser.emit({ type: 'output_audio_buffer.cleared' })
    browser.emit({ type: 'input_audio_buffer.speech_stopped' })
    browser.emit({ type: 'response.created' })
    browser.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: `item_echo_${echo}`, transcript: 'It happened.', usage: TRANSCRIPTION_USAGE })
    browser.emit({ type: 'response.done', response: { status: 'cancelled', usage: REPLY_USAGE, output: [] } })
    browser.clock.now += 5000
  }
  const sent = browser.state.channel.sent
  assert.equal(sent.filter((event) => event.type === 'response.create').length, 1, 'an echo was answered by asking for the reply again more than once')
  assert.deepEqual(sent.filter((event) => event.type === 'conversation.item.delete').map((event) => event.item_id),
    ['item_echo_1', 'item_echo_2', 'item_echo_3', 'item_echo_4', 'item_echo_5'])
  assert.deepEqual(idleWait(), waiting, 'an echo restarted the idle hang-up')
  // A real question again allows one more.
  browser.emit({ type: 'input_audio_buffer.speech_started' })
  browser.emit({ type: 'input_audio_buffer.speech_stopped' })
  browser.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_q2', transcript: 'And tomorrow?', usage: TRANSCRIPTION_USAGE })
  assert.notDeepEqual(idleWait(), waiting, 'a real question did not restart the idle wait')
  await heardItself(browser, 'It happened.')
  browser.emit({ type: 'response.done', response: { status: 'cancelled', usage: REPLY_USAGE, output: [] } })
  assert.equal(browser.state.channel.sent.filter((event) => event.type === 'response.create').length, 2)
})

test('the echo clock starts again with each new reply', async () => {
  const browser = await guarded()
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'output_audio_buffer.started' })
  browser.clock.now += 10_000
  // A second reply, ten seconds later: an echo 1.2 s into IT is still an echo.
  await heardItself(browser, 'It happened.')
  assert.ok(browser.state.channel.sent.some((event) => event.type === 'conversation.item.delete'), 'the clock still counted from the first reply')
})

test('a word right after a short reply has finished is the person, not an echo', async () => {
  const browser = await guarded()
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'output_audio_buffer.started' })
  browser.clock.now += 800
  browser.emit({ type: 'output_audio_buffer.stopped' })
  browser.clock.now += 300
  browser.emit({ type: 'input_audio_buffer.speech_started' })
  browser.emit({ type: 'input_audio_buffer.speech_stopped' })
  browser.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_thanks', transcript: 'Thanks', usage: TRANSCRIPTION_USAGE })
  assert.deepEqual(browser.state.channel.sent, [], '"Thanks" after the reply ended was taken for an echo')
  assert.ok(browser.ui.heard.includes('Thanks'))
})

test('a turn early in a reply that turns out to be the person does restart the idle wait, once its words show it', async () => {
  const browser = await guarded()
  const idleWait = () => [...browser.timers.entries()].filter(([, timer]) => timer.ms === 2 * 60_000).map(([id]) => id)
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'output_audio_buffer.started' })
  browser.clock.now += 1000
  const before = idleWait()
  browser.emit({ type: 'input_audio_buffer.speech_started' })
  browser.emit({ type: 'input_audio_buffer.speech_stopped' })
  assert.deepEqual(idleWait(), before, 'a turn not yet known to be the person restarted the idle wait')
  browser.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_real', transcript: 'Wait, which job?', usage: TRANSCRIPTION_USAGE })
  assert.notDeepEqual(idleWait(), before, 'the person talking did not restart the idle wait')
})

/* ---------- the double reply ---------- */
// The person's own turn, ending after the tool outputs went, gets a response of its own from OpenAI
// that already has them. That response is the reply; asking for another would answer twice.

const saidAndDone = (browser, words) => {
  browser.emit({ type: 'response.output_audio_transcript.delta', delta: words })
  browser.emit({ type: 'response.done', response: { status: 'completed', usage: REPLY_USAGE, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_audio' }] }] } })
}

test('the person\'s new turn gets the tool reply in its own response - nothing more is asked for, so it never answers twice', async () => {
  const browser = await connected()
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'input_audio_buffer.speech_started' })
  toolReply(browser)
  browser.emit({ type: 'input_audio_buffer.speech_stopped' })
  browser.emit({ type: 'input_audio_buffer.committed' })
  browser.emit({ type: 'response.created' })
  saidAndDone(browser, 'The morning brief runs at three.')
  assert.equal(creates(browser), 0, 'the reply was asked for again after the person\'s own turn had it')
  assert.ok(![...browser.timers.values()].some((timer) => timer.ms === 1500), 'a wait to ask for it again was left running')
  // And a refusal arriving late cannot bring it back.
  browser.emit(ACTIVE_RESPONSE)
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'response.done', response: { status: 'completed', usage: REPLY_USAGE, output: [] } })
  assert.equal(creates(browser), 0)
})

test('an echo is not the person: its response never stands in for the tool reply, which is still asked for once', async () => {
  const echoAfterTools = async (transcript, { wordsFirst = true } = {}) => {
    const browser = await guarded()
    browser.emit({ type: 'response.created' })
    browser.emit({ type: 'output_audio_buffer.started' })
    browser.clock.now += 1200
    browser.emit({ type: 'input_audio_buffer.speech_started' })
    toolReply(browser)
    browser.emit({ type: 'input_audio_buffer.speech_stopped' })
    browser.emit({ type: 'response.created' })
    if (wordsFirst) browser.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_turn', transcript, usage: TRANSCRIPTION_USAGE })
    saidAndDone(browser, 'Sure.')
    return creates(browser)
  }
  assert.equal(await echoAfterTools('It happened.'), 1, 'an echo\'s response was taken for the tool reply')
  // Its words not in yet when its response ends: it might be the echo, so the reply is still asked for.
  assert.equal(await echoAfterTools('Wait, which job is due?', { wordsFirst: false }), 1)
  // Words that show it is the person: their turn's response was the reply.
  assert.equal(await echoAfterTools('Wait, which job is due?'), 0)
})

test('only the turn that just ended can stand in for the reply - never one from an earlier round', async () => {
  const browser = await connected()
  // A turn ends with a reply owed, but gets no response of its own: the reply is asked for after 1.5 s.
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'input_audio_buffer.speech_started' })
  toolReply(browser)
  browser.emit({ type: 'input_audio_buffer.speech_stopped' })
  const [, held] = [...browser.timers.entries()].find(([, timer]) => timer.ms === 1500)
  held.fn()
  browser.emit({ type: 'response.created' })
  saidAndDone(browser, 'The morning brief runs at three.')
  assert.equal(creates(browser), 1)
  // Next round: the request is refused because OpenAI started a response of its own. That response is
  // no turn of the person's, so the reply is asked for once more after it, as always.
  browser.emit({ type: 'response.created' })
  toolReply(browser)
  browser.emit({ type: 'response.created' })
  browser.emit(ACTIVE_RESPONSE)
  saidAndDone(browser, 'Hm.')
  assert.equal(creates(browser), 3, 'a turn from the round before stood in for this round\'s reply')
})

/* ---------- speakers mode: on a computer, the microphone rests while the reply plays ---------- */
// Live test #2 (2026-10-09): on Nuno's PC the sound runs through Elgato Wave Link - a virtual
// output to his speakers, and its own microphone input - and the browser's echo canceller cannot
// reach through that. The assistant kept hearing itself ("There.", "Let's get going.", "That's
// it.") and answering. So on a computer, unless the person says they are on headphones, the
// microphone track is switched off from a reply's first sound until 300 ms after its last - nothing
// is sent to OpenAI meanwhile - and a tap on the orb, Esc or Space interrupts instead of talking.

const speakers = (options = {}) => connected({ finePointer: true, ...options })
const mic = (browser) => browser.tracks.map((track) => track.enabled)
const tailWait = (browser) => [...browser.timers.entries()].find(([, timer]) => timer.ms === 300)
const endTail = (browser) => {
  const [id, timer] = tailWait(browser) ?? assert.fail('nothing waits out the tail')
  browser.timers.delete(id)
  timer.fn()
}
const idleWaits = (browser) => [...browser.timers.values()].filter((timer) => timer.ms === 2 * 60_000).length

test('on a computer the microphone rests from a reply\'s first sound until 300 ms after it stops', async () => {
  const browser = await speakers()
  browser.emit({ type: 'response.created' })
  assert.notDeepEqual(mic(browser), [false], 'the microphone rested before anything was said')
  browser.emit({ type: 'output_audio_buffer.started' })
  assert.deepEqual(mic(browser), [false], 'the microphone heard the reply')
  browser.emit({ type: 'output_audio_buffer.stopped' })
  assert.deepEqual(mic(browser), [false], 'the last of the reply could still echo')
  assert.ok(tailWait(browser), 'nothing waits 300 ms before listening again')
  endTail(browser)
  assert.deepEqual(mic(browser), [true])
})

test('a reply cut short rests the same 300 ms, and one that starts inside the tail keeps it resting', async () => {
  const browser = await speakers()
  browser.emit({ type: 'output_audio_buffer.started' })
  browser.emit({ type: 'output_audio_buffer.cleared' })
  assert.deepEqual(mic(browser), [false])
  browser.emit({ type: 'output_audio_buffer.started' })
  assert.equal(tailWait(browser), undefined, 'the first reply\'s tail would switch the microphone on during the second')
  assert.deepEqual(mic(browser), [false])
  browser.emit({ type: 'output_audio_buffer.stopped' })
  endTail(browser)
  assert.deepEqual(mic(browser), [true])
})

test('the interrupt - the orb, Esc or Space - stops the reply and switches the microphone on at once', async () => {
  const browser = await speakers()
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'output_audio_buffer.started' })
  browser.emit({ type: 'response.output_audio_transcript.delta', delta: 'A long answer' })
  assert.equal(browser.call.interrupt(), true)
  assert.deepEqual(browser.state.channel.sent, [{ type: 'response.cancel' }, { type: 'output_audio_buffer.clear' }])
  assert.deepEqual(mic(browser), [true], 'the microphone stayed off after the interrupt')
  assert.equal(tailWait(browser), undefined)
  assert.equal(browser.lastState(), 'listening')
  // The cut-off sound ending does not switch it off again.
  browser.emit({ type: 'output_audio_buffer.cleared' })
  assert.deepEqual(mic(browser), [true])
  // With nothing being said there is nothing to interrupt: the orb and Esc go back to ending the call.
  const quiet = await speakers()
  assert.equal(quiet.call.interrupt(), false)
  assert.deepEqual(quiet.state.channel.sent, [])
})

test('while it talks, the sheet says to tap the orb or press Space - not to talk over it', async () => {
  const browser = await speakers()
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'output_audio_buffer.started' })
  assert.equal(browser.lastState(), 'speaking')
  assert.match(browser.ui.shown.at(-1).words, /tap the orb or press Space to interrupt/)
})

test('the idle hang-up never counts the time the microphone rests', async () => {
  const browser = await speakers()
  assert.equal(idleWaits(browser), 1)
  browser.emit({ type: 'output_audio_buffer.started' })
  assert.equal(idleWaits(browser), 0, 'a long reply could hang up the call while the person cannot talk')
  browser.emit({ type: 'output_audio_buffer.stopped' })
  assert.equal(idleWaits(browser), 0)
  endTail(browser)
  assert.equal(idleWaits(browser), 1, 'the wait did not start again when the microphone came back')
})

test('a tool round trip across the rest loses nothing: the outputs go, and the reply is asked for once', async () => {
  const browser = await speakers()
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'output_audio_buffer.started' })
  for (const call of TOOL_CALLS) browser.emit({ ...call, type: 'response.function_call_arguments.done' })
  browser.emit({ type: 'response.done', response: { status: 'completed', usage: REPLY_USAGE, output: TOOL_CALLS } })
  browser.emit({ type: 'output_audio_buffer.stopped' })
  endTail(browser)
  assert.deepEqual(browser.state.channel.sent.map((event) => event.type), ['conversation.item.create', 'conversation.item.create', 'response.create'])
})

test('phones, and computers on headphones, keep talk-over: the microphone never rests, and nothing is an interrupt', async () => {
  for (const options of [{}, { finePointer: true, headphones: true }]) {
    const browser = await connected(options)
    browser.emit({ type: 'response.created' })
    browser.emit({ type: 'output_audio_buffer.started' })
    assert.ok(!mic(browser).includes(false), `${JSON.stringify(options)}: the microphone rested`)
    assert.equal(browser.call.interrupt(), false)
    assert.match(browser.ui.shown.at(-1).words ?? 'Speaking - talk to interrupt', /talk to interrupt/)
  }
})

test('switching to headphones mid-reply lets the microphone listen at once', async () => {
  const browser = await speakers()
  browser.emit({ type: 'output_audio_buffer.started' })
  browser.call.setSpeakersMode(false)
  assert.deepEqual(mic(browser), [true])
  browser.emit({ type: 'output_audio_buffer.stopped' })
  browser.emit({ type: 'output_audio_buffer.started' })
  assert.deepEqual(mic(browser), [true], 'headphones mode still rested the microphone')
})

test('for 1.5 s after a reply ends, a tap is taken as a late interrupt - never a hang-up', async () => {
  const browser = await speakers()
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'output_audio_buffer.started' })
  browser.emit({ type: 'response.done', response: { status: 'completed', usage: REPLY_USAGE, output: [] } })
  browser.emit({ type: 'output_audio_buffer.stopped' })
  endTail(browser)
  browser.clock.now += 400 // a person reacting
  assert.equal(browser.call.handlesTap(), true, 'a tap 400 ms after the reply ended would hang up')
  assert.deepEqual(browser.state.channel.sent, [], 'a late tap sent something')
  assert.deepEqual(browser.state.ended, [])
  browser.clock.now += 1200
  assert.equal(browser.call.handlesTap(), false, 'long after the reply, the orb no longer ends the call')
  // An interrupt starts the same window, so a double tap does not hang up either.
  const twice = await speakers()
  twice.emit({ type: 'response.created' })
  twice.emit({ type: 'output_audio_buffer.started' })
  assert.equal(twice.call.handlesTap(), true)
  twice.clock.now += 300
  assert.equal(twice.call.handlesTap(), true, 'the second tap of a double tap hung up')
})

test('"Listening" shows only when the microphone is on: not during the tail, and as soon as it comes back', async () => {
  const browser = await speakers()
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'output_audio_buffer.started' })
  browser.emit({ type: 'response.done', response: { status: 'completed', usage: REPLY_USAGE, output: [] } })
  browser.emit({ type: 'output_audio_buffer.stopped' })
  assert.notEqual(browser.lastState(), 'listening', 'it said Listening with the microphone off')
  endTail(browser)
  assert.equal(browser.lastState(), 'listening')
})

test('a microphone rested 30 s with no new sound comes back on by itself, and the idle wait with it', async () => {
  // A reply is at most 300 output tokens - about 15 s of OpenAI's voice - and a Fish piece is a
  // sentence; 30 s with no new sound means the end of the sound was lost, not that it is still talking.
  const browser = await speakers()
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'output_audio_buffer.started' })
  const safety = () => [...browser.timers.entries()].find(([, timer]) => timer.ms === 30_000)
  assert.ok(safety(), 'nothing brings a stuck microphone back')
  const [id, timer] = safety()
  browser.timers.delete(id)
  timer.fn()
  assert.deepEqual(mic(browser), [true])
  assert.equal(idleWaits(browser), 1)
  assert.equal(browser.lastState(), 'listening')
  // More sound while rested starts the 30 s again.
  const longer = await speakers()
  longer.emit({ type: 'output_audio_buffer.started' })
  const first = [...longer.timers.entries()].find(([, entry]) => entry.ms === 30_000)[0]
  longer.emit({ type: 'output_audio_buffer.started' })
  assert.ok(!longer.timers.has(first), 'the first safety wait was left running')
})

test('hanging up during the tail leaves no timer behind and the microphone off', async () => {
  const browser = await speakers()
  browser.emit({ type: 'output_audio_buffer.started' })
  browser.emit({ type: 'output_audio_buffer.stopped' })
  assert.ok(tailWait(browser))
  browser.call.stop('stopped')
  assert.equal(browser.timers.size, 0, 'a timer outlived the call')
  assert.ok(browser.tracks.every((track) => track.stopped))
})

test('a double tap - an interrupt, then a second tap as the cancelled reply finishes - does not hang up', async () => {
  const browser = await speakers()
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'output_audio_buffer.started' })
  assert.equal(browser.call.handlesTap(), true)
  browser.emit({ type: 'response.done', response: { status: 'cancelled', usage: REPLY_USAGE, output: [] } })
  browser.clock.now += 300
  assert.equal(browser.call.handlesTap(), true, 'the second tap of a double tap hung up')
  assert.deepEqual(browser.state.ended, [])
})

/* ---------- a reply that came back empty ---------- */
// Live test #3: the first spoken turn got response.created, then response.done 367 ms later with no
// output at all - no sound, no words - and the person heard silence with nothing to say why.

const NO_REPLY = 'No reply came back. Say it again.'
const watchInfo = (t) => {
  const said = []
  t.mock.method(console, 'info', (...parts) => { said.push(parts) })
  return said
}

test('a reply that comes back with nothing in it says so, and logs only its status for debugging', async (t) => {
  const said = watchInfo(t)
  const browser = await connected()
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'response.done', response: { status: 'completed', status_details: null, usage: REPLY_USAGE, output: [] } })
  assert.deepEqual(browser.ui.shown.at(-1), { state: 'listening', words: NO_REPLY, live: true })
  assert.equal(said.length, 1)
  assert.deepEqual(said[0].slice(1), ['completed', null])
})

test('a failed reply is said the same way, and its status details are logged - never what was said', async (t) => {
  const said = watchInfo(t)
  const browser = await connected()
  browser.emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Checking in.', usage: TRANSCRIPTION_USAGE })
  browser.emit({ type: 'response.created' })
  const details = { type: 'failed', error: { type: 'server_error', code: 'internal_error' } }
  browser.emit({ type: 'response.done', response: { status: 'failed', status_details: details, usage: REPLY_USAGE, output: [] } })
  assert.equal(browser.ui.shown.at(-1).words, NO_REPLY)
  assert.deepEqual(said[0].slice(1), ['failed', details])
  assert.ok(!JSON.stringify(said).includes('Checking in'), 'what the person said was logged')
})

test('nothing is said for a reply the page itself cancelled, one the person talked over, or one that only asked for tools', async (t) => {
  const said = watchInfo(t)
  // Cancelled by the page: the interrupt in speakers mode, before any sound came.
  const interrupted = await connected({ finePointer: true })
  interrupted.emit({ type: 'response.created' })
  assert.equal(interrupted.call.interrupt(), true)
  interrupted.emit({ type: 'response.done', response: { status: 'cancelled', usage: REPLY_USAGE, output: [] } })
  // Cancelled by the page: the echo guard.
  const echoed = await guarded()
  await heardItself(echoed, 'It happened.')
  echoed.emit({ type: 'response.done', response: { status: 'cancelled', usage: REPLY_USAGE, output: [] } })
  // Talked over by the person.
  const talkedOver = await connected()
  talkedOver.emit({ type: 'response.created' })
  talkedOver.emit({ type: 'input_audio_buffer.speech_started' })
  talkedOver.emit({ type: 'response.done', response: { status: 'cancelled', status_details: { type: 'cancelled', reason: 'turn_detected' }, usage: REPLY_USAGE, output: [] } })
  // Only tool calls, and the response OpenAI started itself while a tool reply was owed.
  const tools = await connected()
  tools.emit({ type: 'response.created' })
  tools.emit({ type: 'input_audio_buffer.speech_started' })
  toolReply(tools)
  tools.emit({ type: 'input_audio_buffer.speech_stopped' })
  tools.emit({ type: 'response.created' })
  tools.emit({ type: 'response.done', response: { status: 'completed', usage: REPLY_USAGE, output: [] } })
  // A tool call heard in its events, though the response's own list came back empty.
  const toolEvents = await connected()
  toolEvents.emit({ type: 'response.created' })
  toolEvents.emit({ ...TOOL_CALLS[0], type: 'response.function_call_arguments.done' })
  toolEvents.emit({ type: 'response.done', response: { status: 'completed', usage: REPLY_USAGE, output: [] } })
  // A message in the response's own list, though none of its words were seen arriving.
  const message = await connected()
  message.emit({ type: 'response.created' })
  message.emit({ type: 'response.done', response: { status: 'completed', usage: REPLY_USAGE, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_audio' }] }] } })
  for (const [what, browser] of [['interrupted', interrupted], ['echo', echoed], ['talked over', talkedOver], ['tools', tools], ['tool events', toolEvents], ['message', message]]) {
    assert.ok(!browser.ui.shown.some((shown) => shown.words === NO_REPLY), `${what}: "no reply" was said`)
  }
  assert.deepEqual(said, [])
})

test('tool calls that arrive only in response.done\'s own list are still run, with one deferred request for the reply', async () => {
  // No response.function_call_arguments.done events at all: the list is the only place they are.
  const browser = await connected()
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'input_audio_buffer.speech_started' })
  browser.emit({ type: 'response.done', response: { status: 'completed', usage: REPLY_USAGE, output: TOOL_CALLS } })
  const sent = () => browser.state.channel.sent
  assert.deepEqual(sent().map((event) => event.item?.call_id ?? event.type), ['call_1', 'call_2'], 'the tool calls in the list were not run')
  assert.deepEqual(JSON.parse(sent()[0].item.output), voiceToolAnswer('whats_due', { hours: 24 }, browser.deps.view()))
  browser.emit({ type: 'input_audio_buffer.speech_stopped' })
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'response.done', response: { status: 'completed', usage: REPLY_USAGE, output: [] } })
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'response.done', response: { status: 'completed', usage: REPLY_USAGE, output: [] } })
  assert.equal(sent().filter((event) => event.type === 'response.create').length, 1)
})

test('the page hands the session the names on its board, and its microphone\'s distance', async () => {
  const { loadPage, flush: settle } = await import('./helpers/page-harness.mjs')
  const { basePayload: payloadOf, brandAnswer: brandOf } = await import('./helpers/page-payload.mjs')
  const payload = { ...payloadOf(), owner: { name: 'Jordan Avery' }, agents: [{ slug: 'customer-service', state: 'working' }, { slug: 'research', state: 'working' }] }
  const brand = { ...brandOf({ enabled: true, assistantName: 'Penny', voice: { on: true, mouth: 'openai' } }), names: { research: 'Scout' } }
  const sent = async (options) => {
    const loaded = loadPage({
      fetch: async (url) => ({ ok: true, status: 200, json: async () => (url.startsWith('/api/brand') ? brand : url.startsWith('/api/state') ? payload : {}) }),
      expose: ['voiceDeps'],
      ...options
    })
    await settle()
    await loaded.exposed.voiceDeps().startCall('v=0\r\n')
    return JSON.parse(loaded.requests.find((request) => request.url === '/api/voice-session').init.body)
  }
  const phone = await sent({})
  assert.deepEqual(phone.names, ['Penny', 'Jordan Avery', 'customer service', 'Scout', 'research'])
  assert.equal(phone.micDistance, 'near')
  assert.equal((await sent({ media: { '(pointer: fine)': true } })).micDistance, 'far', 'a computer on its speakers asked for a close microphone')
  assert.equal((await sent({ media: { '(pointer: fine)': true }, storage: { 'agent-cockpit-voice-headphones': 'on' } })).micDistance, 'near')
})

test('the page sends this device\'s own time zone, and its tools answer in it', async () => {
  const loaded = await page()
  await loaded.exposed.voiceDeps().startCall(SDP_OFFER)
  const sent = JSON.parse(loaded.requests.find((request) => request.url === '/api/voice-session').init.body)
  assert.equal(sent.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone)
  assert.equal(loaded.exposed.voiceDeps().view().timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone)
})
