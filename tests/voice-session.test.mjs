// /api/voice-session: the page's WebRTC offer in, OpenAI's answer out. The function adds the key and
// the whole session on the way through, so the page never holds a key of any kind.
//
// OpenAI is stubbed through globalThis.fetch, as generate.test.mjs does; nothing reaches the network.
// What these tests hold it to: every gate refuses before anything is spent or read; the key goes to
// exactly one address in exactly one header; the session sent is the one the server built, named
// from the store and never from the request; it never writes the store and works without one;
// whatever OpenAI answers, the page gets an answer SDP or one of our sentences; and no answer is
// ever kept by a shared cache.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { makeHandler, CALLS_URL, SPEND_LIMIT } from '../api/voice-session.js'
import { voiceConfig, sessionFor, readTicket, SPEAK_TICKET_MS, NO_VOICE_KEY } from '../api/_voice.js'
import { STORE_ENV, VIEW_KEY, NOON, connectedStore, storeCalls, asTheBoard, call, everythingSent } from './helpers/personalise-harness.mjs'
import { OPENAI_KEY, FISH_KEY, FISH_VOICE, SDP_OFFER, SDP_ANSWER } from './helpers/voice-fixtures.mjs'

const ENV = { ...STORE_ENV, OPENAI_API_KEY: OPENAI_KEY, GITHUB_OWNER: 'jordan', GITHUB_REPO: 'team' }
const SDP_TYPE = { 'content-type': 'application/sdp' }

function board({ env = ENV, now = NOON, store, ...rest } = {}) {
  const connected = store === undefined ? connectedStore(env) : { store, fake: null }
  const handler = makeHandler({ store: connected.store, env, now, ...rest })
  const offer = (body = SDP_OFFER, headers = asTheBoard(SDP_TYPE), extra = {}) =>
    call(handler, { method: 'POST', headers, body, ...extra })
  return { ...connected, handler, offer }
}

const realFetch = globalThis.fetch
function stubOpenAI(t, answer) {
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    return answer(url, options)
  }
  t.after(() => {
    globalThis.fetch = realFetch
  })
  return calls
}

const answered = (sdp = SDP_ANSWER) => () => new Response(sdp, { status: 201, headers: { 'content-type': 'application/sdp' } })
const refused = (status, error) => () =>
  new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } })

const noCache = (response, label) => {
  assert.equal(response.headers['Cache-Control'], 'private, no-store', `${label}: not private, no-store`)
  assert.doesNotMatch(JSON.stringify(response.headers), /s-maxage|public/i, `${label}: a shared cache may keep this`)
}

/* ---------- the call OpenAI gets ---------- */

test('an offer goes to OpenAI with the key in one header, the session the server built, and the answer comes back', async (t) => {
  const calls = stubOpenAI(t, answered())
  const { offer, store } = board()
  await store.saveSettings((draft) => { draft.assistantName = 'Penny' })
  const response = await offer()

  assert.equal(response.statusCode, 200)
  noCache(response, 'a call that started')
  assert.equal(response.body.sdp, SDP_ANSWER)
  assert.equal(response.body.mouth, 'openai')
  assert.equal(response.body.model, 'gpt-realtime-2.1-mini')
  assert.equal(response.body.name, 'Penny')
  assert.equal(response.body.idleMinutes, 2)
  assert.equal(response.body.captions, true)

  assert.equal(calls.length, 1)
  const [sent] = calls
  assert.equal(sent.url, CALLS_URL)
  assert.equal(CALLS_URL, 'https://api.openai.com/v1/realtime/calls')
  assert.equal(sent.options.method, 'POST')
  assert.equal(sent.options.headers.Authorization, `Bearer ${OPENAI_KEY}`)
  assert.ok(sent.options.signal instanceof AbortSignal, 'a call to OpenAI must be able to time out')
  // The safety identifier is a hash of the repo, never the key and never the repo's name in clear.
  const expected = createHash('sha256').update('jordan/team').digest('hex')
  assert.equal(sent.options.headers['OpenAI-Safety-Identifier'], expected)
  assert.deepEqual(Object.keys(sent.options.headers).sort(), ['Authorization', 'OpenAI-Safety-Identifier'])

  const form = sent.options.body
  assert.ok(form instanceof FormData, 'the call is not multipart')
  assert.deepEqual([...form.keys()].sort(), ['sdp', 'session'])
  assert.equal(form.get('sdp'), SDP_OFFER)
  assert.deepEqual(JSON.parse(form.get('session')), sessionFor(voiceConfig(ENV), 'Penny'))
  assert.ok(!form.get('session').includes(OPENAI_KEY))
})

test('the ticket in the answer names this session, its mouth and its model, and is new every time', async (t) => {
  stubOpenAI(t, answered())
  const { offer } = board()
  const first = await offer()
  const second = await offer()
  const read = (answer) => readTicket(answer.body.ticket, OPENAI_KEY, { now: NOON().getTime(), maxAgeMs: SPEAK_TICKET_MS })
  const one = read(first)
  assert.ok(one, 'the ticket does not read back')
  assert.equal(one.mouth, 'openai')
  assert.equal(one.model, 'gpt-realtime-2.1-mini')
  assert.equal(one.iat, NOON().getTime())
  assert.notEqual(one.sid, read(second).sid, 'two sessions share one id')
})

test('with Fish set up the session is text only and the ticket says Fish, with the Fish model', async (t) => {
  const calls = stubOpenAI(t, answered())
  const env = { ...ENV, FISH_API_KEY: FISH_KEY, FISH_VOICE_ID: FISH_VOICE }
  const response = await board({ env }).offer()
  assert.equal(response.body.mouth, 'fish')
  assert.deepEqual(JSON.parse(calls[0].options.body.get('session')).output_modalities, ['text'])
  const ticket = readTicket(response.body.ticket, OPENAI_KEY, { now: NOON().getTime(), maxAgeMs: SPEAK_TICKET_MS })
  assert.equal(ticket.mouth, 'fish')
  assert.equal(ticket.fishModel, 's2.1-pro-free')
  assert.ok(!everythingSent(response).includes(FISH_KEY), 'the Fish key reached the page')
})

test('the assistant\'s name comes from the store, never from anything in the request', async (t) => {
  const calls = stubOpenAI(t, answered())
  const { offer, store } = board()
  await store.saveSettings((draft) => { draft.assistantName = 'Penny' })
  await offer(SDP_OFFER, asTheBoard({ ...SDP_TYPE, 'x-assistant-name': 'Mallory' }), { query: { name: 'Mallory' } })
  const { instructions } = JSON.parse(calls[0].options.body.get('session'))
  assert.match(instructions, /You are Penny\b/)
  assert.ok(!instructions.includes('Mallory'))
})

test('with no store connected voice still works, and the assistant is "your assistant"', async (t) => {
  const calls = stubOpenAI(t, answered())
  const response = await board({ store: null, env: { VIEW_KEY, OPENAI_API_KEY: OPENAI_KEY } }).offer()
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.name, 'your assistant')
  assert.match(JSON.parse(calls[0].options.body.get('session')).instructions, /You are your assistant\b/)
})

test('starting a call never writes the store - not the settings, not a count, nothing', async (t) => {
  stubOpenAI(t, answered())
  const { offer, store, fake } = board()
  await store.saveSettings((draft) => { draft.assistantName = 'Penny' })
  const puts = fake.calls.put.length
  const reads = fake.calls.get.length
  for (let i = 0; i < 5; i += 1) assert.equal((await offer()).statusCode, 200)
  assert.equal(fake.calls.put.length, puts, 'a voice call wrote to the picture store')
  assert.ok(fake.calls.get.slice(reads).every((read) => read.options.useCache !== false), 'a voice call read past the cache')
})

test('a store that fails or never answers costs the name, never the call', async (t) => {
  stubOpenAI(t, answered())
  const failing = { readSettings: async () => { throw new Error('store down') } }
  const failed = await board({ store: failing }).offer()
  assert.equal(failed.statusCode, 200)
  assert.equal(failed.body.name, 'your assistant')
  const silent = { readSettings: () => new Promise(() => {}) }
  const waited = await board({ store: silent, nameWaitMs: 20 }).offer()
  assert.equal(waited.statusCode, 200)
  assert.equal(waited.body.name, 'your assistant')
})

/* ---------- the offer ---------- */

test('the offer is read however the platform hands it over: a string, bytes, or the request stream', async (t) => {
  const calls = stubOpenAI(t, answered())
  const { handler } = board()
  const streamed = {
    method: 'POST',
    headers: asTheBoard(SDP_TYPE),
    query: {},
    body: undefined,
    async * [Symbol.asyncIterator]() {
      yield Buffer.from(SDP_OFFER.slice(0, 40))
      yield Buffer.from(SDP_OFFER.slice(40))
    }
  }
  for (const [what, request] of [
    ['a string', { method: 'POST', headers: asTheBoard(SDP_TYPE), body: SDP_OFFER }],
    ['a Buffer', { method: 'POST', headers: asTheBoard(SDP_TYPE), body: Buffer.from(SDP_OFFER) }],
    ['the stream', streamed]
  ]) {
    const response = await call(handler, request)
    assert.equal(response.statusCode, 200, `an offer sent as ${what} was refused`)
  }
  assert.ok(calls.every((sent) => sent.options.body.get('sdp') === SDP_OFFER))
})

test('something that is not an offer, or one over 16 KB, is refused before OpenAI', async (t) => {
  const calls = stubOpenAI(t, answered())
  const { offer } = board()
  for (const body of ['', 'hello', '{"sdp":"v=0"}', null, 42, `x${SDP_OFFER}`]) {
    const response = await offer(body)
    assert.equal(response.statusCode, 400, `${JSON.stringify(body)?.slice(0, 20)} was accepted`)
    noCache(response, 'a refused offer')
  }
  const huge = await offer(SDP_OFFER + 'a=x'.repeat(6000))
  assert.equal(huge.statusCode, 413)
  noCache(huge, 'a huge offer')
  assert.equal(calls.length, 0)
})

/* ---------- nothing is spent until everything has passed ---------- */

test('every gate refuses before OpenAI is called or the store is read', async (t) => {
  const calls = stubOpenAI(t, answered())
  const cases = [
    ['no view key', { 'content-type': 'application/sdp' }, ENV, 401],
    ['the wrong view key', { 'x-view-key': 'nope', 'content-type': 'application/sdp' }, ENV, 401],
    ['no edit key when one is set', asTheBoard(SDP_TYPE), { ...ENV, EDIT_KEY: 'edit' }, 401],
    ['another site', asTheBoard({ ...SDP_TYPE, 'sec-fetch-site': 'cross-site' }), ENV, 403],
    ['a form-shaped body', asTheBoard({ 'content-type': 'text/plain' }), ENV, 415],
    ['JSON', asTheBoard({ 'content-type': 'application/json' }), ENV, 415],
    ['an open board with no edit key', { 'content-type': 'application/sdp' }, { ...ENV, VIEW_KEY: undefined, PUBLIC_DASHBOARD: 'true' }, 403]
  ]
  for (const [what, headers, env, status] of cases) {
    const { offer, fake } = board({ env })
    const response = await offer(SDP_OFFER, headers)
    assert.equal(response.statusCode, status, `${what}: ${response.statusCode}`)
    noCache(response, what)
    assert.equal(storeCalls(fake), 0, `${what} reached the store`)
  }
  const withKey = await board({ env: { ...ENV, EDIT_KEY: 'edit' } }).offer(SDP_OFFER, asTheBoard({ ...SDP_TYPE, 'x-edit-key': 'edit' }))
  assert.equal(withKey.statusCode, 200)
  assert.equal(calls.length, 1, 'OpenAI was called for a refused request')
})

test('with no OPENAI_API_KEY, or a model the board does not know, it says which setting and OpenAI is never called', async (t) => {
  const calls = stubOpenAI(t, answered())
  const { OPENAI_API_KEY, ...noKey } = ENV
  const missing = await board({ env: noKey }).offer()
  assert.equal(missing.statusCode, 503)
  assert.equal(missing.body.error, NO_VOICE_KEY)
  noCache(missing, 'no key')
  const wrong = await board({ env: { ...ENV, OPENAI_REALTIME_MODEL: 'gpt-4o-realtime-preview' } }).offer()
  assert.equal(wrong.statusCode, 503)
  assert.match(wrong.body.error, /OPENAI_REALTIME_MODEL/)
  assert.equal(calls.length, 0)
})

test('only POST is answered', async () => {
  const response = await call(board().handler, { method: 'GET', headers: asTheBoard() })
  assert.equal(response.statusCode, 405)
  assert.equal(response.headers.Allow, 'POST')
  noCache(response, 'a GET')
})

/* ---------- whatever OpenAI answers ---------- */

test('OpenAI\'s spending limit is its own sentence, and other refusals are ours, never OpenAI\'s words', async (t) => {
  const cases = [
    [refused(429, { code: 'project_spend_limit_exceeded', message: 'You have reached your project spend limit. req_123' }), 429, SPEND_LIMIT],
    [refused(429, { type: 'project_spend_limit_exceeded', message: 'req_123' }), 429, SPEND_LIMIT],
    [refused(429, { code: 'rate_limit_exceeded', message: 'Rate limit reached req_123' }), 429, /OpenAI/],
    [refused(401, { message: `Incorrect API key provided: ${OPENAI_KEY}. req_123` }), 502, /OPENAI_API_KEY/],
    [refused(403, { message: 'Project does not have access to model. req_123' }), 502, /OPENAI_API_KEY/],
    [refused(400, { message: 'Invalid SDP req_123' }), 502, /OpenAI/],
    [refused(500, { message: 'server exploded req_123' }), 502, /OpenAI/],
    [() => new Response('<html>Bad gateway req_123</html>', { status: 502 }), 502, /OpenAI/]
  ]
  for (const [answer, status, says] of cases) {
    stubOpenAI(t, answer)
    const response = await board().offer()
    assert.equal(response.statusCode, status)
    if (typeof says === 'string') assert.equal(response.body.error, says)
    else assert.match(response.body.error, says)
    assert.ok(!everythingSent(response).includes('req_123'), 'OpenAI\'s own words reached the page')
    noCache(response, `OpenAI ${status}`)
  }
  assert.match(SPEND_LIMIT, /spending limit/)
  assert.match(SPEND_LIMIT, /until next month or until you raise it/)
})

test('OpenAI taking too long, or not being reachable, is a sentence', async (t) => {
  stubOpenAI(t, () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError') })
  const slow = await board().offer()
  assert.equal(slow.statusCode, 504)
  assert.match(slow.body.error, /too long/)
  stubOpenAI(t, () => { throw new TypeError(`fetch failed for ${OPENAI_KEY}`) })
  const down = await board().offer()
  assert.equal(down.statusCode, 502)
  assert.ok(!everythingSent(down).includes(OPENAI_KEY))
})

test('an answer that is not an SDP, or is huge, is refused rather than handed to the browser', async (t) => {
  for (const body of ['{"ok":true}', '<html></html>', '', 'v=0' + 'x'.repeat(70 * 1024)]) {
    stubOpenAI(t, () => new Response(body, { status: 201 }))
    const response = await board().offer()
    assert.equal(response.statusCode, 502, `${body.slice(0, 20)} was passed on`)
    assert.equal(response.body.sdp, undefined)
  }
})

test('the OpenAI key is never in any answer or any log, whatever OpenAI sends back', async (t) => {
  const echo = (status) => (url, options) =>
    new Response(JSON.stringify({ error: { message: `bad key ${options.headers.Authorization}`, code: OPENAI_KEY } }), { status })
  const answers = [
    echo(400), echo(401), echo(403), echo(429), echo(500),
    (url, options) => new Response(`v=0\r\na=key:${options.headers.Authorization}`, { status: 201 }),
    () => { throw new Error(`connect failed while sending ${OPENAI_KEY}`) }
  ]
  const logged = []
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level]
    console[level] = (...parts) => logged.push(parts.map(String).join(' '))
    t.after(() => { console[level] = original })
  }
  for (const [index, answer] of answers.entries()) {
    stubOpenAI(t, answer)
    const response = await board().offer()
    const sent = everythingSent(response)
    assert.ok(!sent.includes(OPENAI_KEY), `answer ${index} sent the key back to the browser`)
    noCache(response, `answer ${index}`)
  }
  assert.ok(!logged.some((line) => line.includes(OPENAI_KEY)), 'the key was written to a log')
})
