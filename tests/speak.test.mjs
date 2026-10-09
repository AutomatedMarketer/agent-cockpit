// /api/speak: one piece of a reply, spoken by Fish in the owner's chosen voice (the Fish mouth).
//
// Fish is stubbed through globalThis.fetch; nothing reaches the network. What these tests hold it
// to: the model header is ALWAYS sent and is the free model unless the owner chose the paid one
// exactly - a missing header is silently billed as the paid model; the voice comes from the owner's
// settings, never from the request; only a live Fish session's ticket is accepted; a warm-up never
// calls Fish; what comes back is an MP3 or our sentence; the Fish key goes to Fish in one header and
// nowhere else; and no answer is ever kept by a shared cache.

import test from 'node:test'
import assert from 'node:assert/strict'
import { makeHandler, FISH_URL } from '../api/speak.js'
import { voiceConfig, signTicket, newSessionId, SPEAK_TICKET_MS } from '../api/_voice.js'
import { VIEW_KEY, NOON, asTheBoard, call, everythingSent } from './helpers/personalise-harness.mjs'
import { OPENAI_KEY, FISH_KEY, FISH_VOICE, twoFrameMp3 } from './helpers/voice-fixtures.mjs'

const ENV = { VIEW_KEY, OPENAI_API_KEY: OPENAI_KEY, FISH_API_KEY: FISH_KEY, FISH_VOICE_ID: FISH_VOICE }
const JSON_TYPE = { 'content-type': 'application/json' }
const NOW = NOON().getTime()

// A ticket as /api/voice-session would have made it for this env, `ago` ms ago.
const ticketFor = (env = ENV, { ago = 0, mouth } = {}) => {
  const config = voiceConfig(env)
  const speaks = mouth ?? config.mouth
  return signTicket({
    sid: newSessionId(),
    iat: NOW - ago,
    mouth: speaks,
    model: config.model ?? 'gpt-realtime-2.1-mini',
    ...(speaks === 'fish' ? { fishModel: config.fishModel ?? 's2.1-pro-free' } : {})
  }, OPENAI_KEY)
}

function speaker({ env = ENV } = {}) {
  const handler = makeHandler({ env, now: NOON })
  const speak = (body, headers = asTheBoard(JSON_TYPE)) => call(handler, { method: 'POST', headers, body })
  return { handler, speak }
}

const realFetch = globalThis.fetch
function stubFish(t, answer = () => new Response(twoFrameMp3(), { status: 200, headers: { 'content-type': 'audio/mpeg' } })) {
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options, body: JSON.parse(options.body) })
    return answer(url, options)
  }
  t.after(() => { globalThis.fetch = realFetch })
  return calls
}

const noCache = (response, label) => {
  assert.equal(response.headers['Cache-Control'], 'private, no-store', `${label}: not private, no-store`)
  assert.doesNotMatch(JSON.stringify(response.headers), /s-maxage|public/i, `${label}: a shared cache may keep this`)
}

/* ---------- what Fish is asked ---------- */

test('a piece of a reply goes to Fish with the key, the free model, the owner\'s voice, and comes back as MP3', async (t) => {
  const calls = stubFish(t)
  const response = await speaker().speak({ ticket: ticketFor(), text: '  Three jobs are due today. ' })
  assert.equal(response.statusCode, 200)
  noCache(response, 'speech')
  assert.equal(response.headers['Content-Type'], 'audio/mpeg')
  assert.equal(response.headers['X-Content-Type-Options'], 'nosniff')
  assert.deepEqual(Buffer.from(response.sent), twoFrameMp3())

  assert.equal(calls.length, 1)
  const [sent] = calls
  assert.equal(sent.url, FISH_URL)
  assert.equal(FISH_URL, 'https://api.fish.audio/v1/tts')
  assert.equal(sent.options.method, 'POST')
  assert.deepEqual(sent.options.headers, {
    Authorization: `Bearer ${FISH_KEY}`,
    'Content-Type': 'application/json',
    model: 's2.1-pro-free'
  })
  assert.ok(sent.options.signal instanceof AbortSignal)
  assert.deepEqual(sent.body, { text: 'Three jobs are due today.', reference_id: FISH_VOICE, format: 'mp3', latency: 'low' })
  assert.ok(!sent.options.body.includes(OPENAI_KEY), 'the OpenAI key went to Fish')
})

test('the model header is ALWAYS sent, and is the free model unless FISH_MODEL says s2.1-pro exactly', async (t) => {
  // A request with no model header is billed as s2.1-pro. So every call carries one, and anything
  // that is not exactly the paid model's name - nothing, empty, a typo, another case - is free.
  for (const value of [undefined, '', ' ', 's2.1-pro ', 'S2.1-PRO', 's2-pro', 's2.1-pr0', 'free', 's2.1-pro-free']) {
    const calls = stubFish(t)
    const env = value === undefined ? ENV : { ...ENV, FISH_MODEL: value }
    const response = await speaker({ env }).speak({ ticket: ticketFor(env), text: 'Hello.' })
    assert.equal(response.statusCode, 200, JSON.stringify(value))
    assert.equal(calls[0].options.headers.model, 's2.1-pro-free', `FISH_MODEL=${JSON.stringify(value)} did not send the free model`)
  }
  const paid = { ...ENV, FISH_MODEL: 's2.1-pro' }
  const calls = stubFish(t)
  await speaker({ env: paid }).speak({ ticket: ticketFor(paid), text: 'Hello.' })
  assert.equal(calls[0].options.headers.model, 's2.1-pro')
})

test('a session started on the free model stays free even if FISH_MODEL changes to paid mid-call', async (t) => {
  const calls = stubFish(t)
  await speaker({ env: { ...ENV, FISH_MODEL: 's2.1-pro' } }).speak({ ticket: ticketFor(ENV), text: 'Hello.' })
  assert.equal(calls[0].options.headers.model, 's2.1-pro-free')
})

test('the voice is the owner\'s FISH_VOICE_ID, never one the request names', async (t) => {
  const calls = stubFish(t)
  await speaker().speak({ ticket: ticketFor(), text: 'Hello.', reference_id: 'b'.repeat(32), voice: 'c'.repeat(32) })
  assert.equal(calls[0].body.reference_id, FISH_VOICE)
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['format', 'latency', 'reference_id', 'text'])
})

test('a warm-up answers 204 at once and never calls Fish', async (t) => {
  const calls = stubFish(t)
  const response = await speaker().speak({ ticket: ticketFor(), warm: true })
  assert.equal(response.statusCode, 204)
  noCache(response, 'a warm-up')
  assert.equal(calls.length, 0)
})

/* ---------- who may ask ---------- */

test('only a live Fish session\'s ticket is accepted, and every refusal comes before Fish', async (t) => {
  const calls = stubFish(t)
  const { speak } = speaker()
  const openaiTicket = ticketFor(ENV, { mouth: 'openai' })
  for (const [what, ticket, status] of [
    ['no ticket', undefined, 401],
    ['a made-up ticket', 'abc.def', 401],
    ['an expired ticket (66 minutes)', ticketFor(ENV, { ago: 66 * 60_000 }), 401],
    ['an OpenAI-voice session\'s ticket', openaiTicket, 403]
  ]) {
    const response = await speak({ ticket, text: 'Hello.' })
    assert.equal(response.statusCode, status, what)
    assert.equal(response.body.needs, undefined, `${what}: the page would ask for the edit key`)
    noCache(response, what)
  }
  assert.ok((await speak({ ticket: ticketFor(ENV, { ago: SPEAK_TICKET_MS - 1000 }), text: 'Hello.' })).statusCode === 200)
  assert.equal(calls.length, 1)
})

test('the write gate, the voice settings and the text are all checked before Fish', async (t) => {
  const calls = stubFish(t)
  const { OPENAI_API_KEY, ...noOpenAI } = ENV
  const { FISH_API_KEY, ...noFish } = ENV
  const cases = [
    ['no view key', ENV, { ticket: ticketFor(), text: 'Hi.' }, JSON_TYPE, 401],
    ['another site', ENV, { ticket: ticketFor(), text: 'Hi.' }, asTheBoard({ ...JSON_TYPE, 'sec-fetch-site': 'cross-site' }), 403],
    ['a form-shaped body', ENV, 'text=hi', asTheBoard({ 'content-type': 'application/x-www-form-urlencoded' }), 415],
    ['voice off', noOpenAI, { ticket: ticketFor(), text: 'Hi.' }, asTheBoard(JSON_TYPE), 503],
    ['Fish not set up', noFish, { ticket: ticketFor(), text: 'Hi.' }, asTheBoard(JSON_TYPE), 503],
    ['a voice id that is not one', { ...ENV, FISH_VOICE_ID: 'not-an-id' }, { ticket: ticketFor(), text: 'Hi.' }, asTheBoard(JSON_TYPE), 503],
    ['no text', ENV, { ticket: ticketFor() }, asTheBoard(JSON_TYPE), 400],
    ['too much text', ENV, { ticket: ticketFor(), text: 'x'.repeat(401) }, asTheBoard(JSON_TYPE), 400],
    ['unprintable text', ENV, { ticket: ticketFor(), text: 'hi‮there' }, asTheBoard(JSON_TYPE), 400],
    ['text that is not text', ENV, { ticket: ticketFor(), text: ['hi'] }, asTheBoard(JSON_TYPE), 400],
    ['not a JSON object', ENV, '[1,2]', asTheBoard(JSON_TYPE), 401]
  ]
  for (const [what, env, body, headers, status] of cases) {
    const response = await speaker({ env }).speak(body, headers)
    assert.equal(response.statusCode, status, `${what}: ${response.statusCode} ${JSON.stringify(response.body)}`)
    noCache(response, what)
  }
  assert.equal(calls.length, 0, 'Fish was called for a refused request')
})

test('only POST is answered', async () => {
  const response = await call(speaker().handler, { method: 'GET', headers: asTheBoard() })
  assert.equal(response.statusCode, 405)
  assert.equal(response.headers.Allow, 'POST')
  noCache(response, 'a GET')
})

/* ---------- whatever Fish answers ---------- */

test('an answer that is not an MP3, or is over 1 MB, is refused with our sentence', async (t) => {
  for (const [what, answer] of [
    ['JSON', () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'audio/mpeg' } })],
    ['HTML', () => new Response('<script>alert(1)</script>', { status: 200 })],
    ['nothing', () => new Response(null, { status: 200 })],
    ['a huge MP3', () => new Response(Buffer.concat([twoFrameMp3(), Buffer.alloc(1024 * 1024)]), { status: 200 })]
  ]) {
    stubFish(t, answer)
    const response = await speaker().speak({ ticket: ticketFor(), text: 'Hello.' })
    assert.equal(response.statusCode, 502, `${what} was passed on`)
    assert.equal(response.sent, null)
    noCache(response, what)
  }
})

test('Fish\'s refusals are our sentences, naming the setting to check, never Fish\'s words', async (t) => {
  const refusal = (status) => () => new Response(JSON.stringify({ status, message: `nope req_fish_1 ${FISH_KEY}` }), { status })
  for (const [status, expected, says] of [
    [401, 502, /FISH_API_KEY/],
    [403, 502, /FISH_API_KEY/],
    [402, 402, /Fish/],
    [429, 429, /Fish/],
    [500, 502, /Fish/],
    [503, 502, /Fish/]
  ]) {
    stubFish(t, refusal(status))
    const response = await speaker().speak({ ticket: ticketFor(), text: 'Hello.' })
    assert.equal(response.statusCode, expected, `Fish ${status}`)
    assert.match(response.body.error, says)
    assert.ok(!everythingSent(response).includes('req_fish_1'), 'Fish\'s own words reached the page')
    noCache(response, `Fish ${status}`)
  }
  stubFish(t, () => { throw new DOMException('timed out', 'TimeoutError') })
  const slow = await speaker().speak({ ticket: ticketFor(), text: 'Hello.' })
  assert.equal(slow.statusCode, 504)
})

test('the Fish key is never in any answer or any log, whatever Fish sends back', async (t) => {
  const logged = []
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level]
    console[level] = (...parts) => logged.push(parts.map(String).join(' '))
    t.after(() => { console[level] = original })
  }
  const answers = [
    (url, options) => new Response(JSON.stringify({ echo: options.headers.Authorization }), { status: 401 }),
    (url, options) => new Response(`${options.headers.Authorization}`, { status: 200 }),
    () => { throw new Error(`connect failed while sending ${FISH_KEY}`) }
  ]
  for (const [index, answer] of answers.entries()) {
    stubFish(t, answer)
    const response = await speaker().speak({ ticket: ticketFor(), text: 'Hello.' })
    assert.ok(!everythingSent(response).includes(FISH_KEY), `answer ${index} sent the Fish key to the browser`)
  }
  assert.ok(!logged.some((line) => line.includes(FISH_KEY)), 'the Fish key was written to a log')
})
