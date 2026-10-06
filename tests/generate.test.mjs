// /api/generate: "describe it" -> OpenAI's image model -> the picture's bytes back to the browser,
// which shrinks it and sends it to /api/upload like any other picture.
//
// OpenAI is stubbed through globalThis.fetch, as fire.test.mjs stubs its upstreams; nothing here
// reaches the network. What these tests hold it to: it spends the owner's money only when every
// check has passed and today's allowance is not used up; it asks for exactly the picture the plan
// describes, in the owner's art style; whatever OpenAI answers, the answer is a plain sentence or
// a real picture; and the OpenAI key never leaves the server - not in a body, a header or a log.

import test from 'node:test'
import assert from 'node:assert/strict'
import { makeHandler } from '../api/generate.js'
import { NOT_CONNECTED } from '../api/_picture-store.js'
import { DEFAULT_ART_STYLE } from '../api/lib.js'
import {
  STORE_ENV,
  NOON,
  webp,
  png,
  connectedStore,
  storeCalls,
  asTheBoard,
  call,
  everythingSent
} from './helpers/personalise-harness.mjs'

const OPENAI_KEY = 'sk-test-thisMustNeverLeaveTheServer'
const ENV = { ...STORE_ENV, OPENAI_API_KEY: OPENAI_KEY }
const JSON_TYPE = { 'content-type': 'application/json' }
const ENDPOINT = 'https://api.openai.com/v1/images/generations'
const PORTRAIT = { slot: 'agent-content', description: 'a cheerful robot writing in a notebook' }

function board({ env = ENV, now = NOON } = {}) {
  const connected = connectedStore(env)
  const handler = makeHandler({ store: connected.store, env, now })
  const generate = (body, headers = asTheBoard(JSON_TYPE)) => call(handler, { method: 'POST', headers, body })
  return { ...connected, handler, generate }
}

// Replaces fetch for one test. `answer` gets (url, options) and returns a Response or throws.
// Always restores the real fetch, so a test that stubs several times cannot leave one behind.
const realFetch = globalThis.fetch
function stubOpenAI(t, answer) {
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options, body: JSON.parse(options.body) })
    return answer(url, options)
  }
  t.after(() => {
    globalThis.fetch = realFetch
  })
  return calls
}

const imageAnswer = (bytes) => () =>
  new Response(JSON.stringify({ created: 1, data: [{ b64_json: Buffer.from(bytes).toString('base64') }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })

const errorAnswer = (status, error) => () =>
  new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } })

/* ---------- the request OpenAI gets ---------- */

test('a portrait is asked for exactly as planned, and its bytes come straight back', async (t) => {
  const bytes = webp(30000)
  const calls = stubOpenAI(t, imageAnswer(bytes))
  const response = await board().generate(PORTRAIT)

  assert.equal(response.statusCode, 200)
  assert.deepEqual(Buffer.from(response.sent), bytes)
  assert.equal(response.headers['Content-Type'], 'image/webp')
  assert.equal(response.headers['Cache-Control'], 'no-store')
  assert.equal(response.headers['X-Content-Type-Options'], 'nosniff')

  assert.equal(calls.length, 1)
  const [sent] = calls
  assert.equal(sent.url, ENDPOINT)
  assert.equal(sent.options.method, 'POST')
  assert.equal(sent.options.headers.Authorization, `Bearer ${OPENAI_KEY}`)
  assert.equal(sent.options.headers['Content-Type'], 'application/json')
  assert.ok(sent.options.signal instanceof AbortSignal, 'a call to OpenAI must be able to time out')
  const { prompt, ...rest } = sent.body
  assert.deepEqual(rest, {
    model: 'gpt-image-1-mini',
    size: '1024x1024',
    quality: 'medium',
    output_format: 'webp',
    output_compression: 80,
    n: 1
  })
  assert.ok(prompt.startsWith(DEFAULT_ART_STYLE), 'with no style of its own, the board paints in the built-in one')
  assert.ok(prompt.includes(PORTRAIT.description))
  assert.match(prompt, /square/i)
  assert.match(prompt, /one subject/i)
  assert.match(prompt, /centred/i)
})

test('a banner is asked for wide, with room for text on the left', async (t) => {
  const calls = stubOpenAI(t, imageAnswer(webp(50000)))
  const response = await board().generate({ slot: 'today', description: 'a quiet harbour at first light' })
  assert.equal(response.statusCode, 200)
  assert.equal(calls[0].body.size, '1536x1024')
  assert.match(calls[0].body.prompt, /21:9/)
  assert.match(calls[0].body.prompt, /left/i)
  assert.doesNotMatch(calls[0].body.prompt, /one subject/i, 'a banner is a scene, not a portrait')
})

test('the prompt starts with the owner\'s own art style once they have set one', async (t) => {
  const calls = stubOpenAI(t, imageAnswer(webp()))
  const { generate, store } = board()
  await store.saveSettings((settings) => {
    settings.artStyle = 'Soft watercolour animals, morning light.'
  })
  await generate(PORTRAIT)
  assert.ok(calls[0].body.prompt.startsWith('Soft watercolour animals, morning light.'))
  assert.ok(!calls[0].body.prompt.includes(DEFAULT_ART_STYLE), 'the owner\'s style replaces the built-in one')
})

test('OPENAI_IMAGE_MODEL chooses the model', async (t) => {
  const calls = stubOpenAI(t, imageAnswer(webp()))
  await board({ env: { ...ENV, OPENAI_IMAGE_MODEL: 'gpt-image-1.5' } }).generate(PORTRAIT)
  assert.equal(calls[0].body.model, 'gpt-image-1.5')
})

test('the picture\'s type is taken from its bytes', async (t) => {
  stubOpenAI(t, imageAnswer(png(2000)))
  const response = await board().generate(PORTRAIT)
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['Content-Type'], 'image/png')
})

/* ---------- nothing is spent until everything has passed ---------- */

test('with no OPENAI_API_KEY it says which setting is missing, and OpenAI is never called', async (t) => {
  const calls = stubOpenAI(t, imageAnswer(webp()))
  const { generate, fake } = board({ env: STORE_ENV })
  const response = await generate(PORTRAIT)
  assert.equal(response.statusCode, 503)
  assert.match(response.body.error, /OPENAI_API_KEY/)
  assert.equal(calls.length, 0)
  assert.equal(storeCalls(fake), 0, 'nothing is counted for a picture that cannot be made')
})

test('with no store connected it is refused with the store sentence, and OpenAI is never called', async (t) => {
  const calls = stubOpenAI(t, imageAnswer(webp()))
  const handler = makeHandler({ store: null, env: { VIEW_KEY: STORE_ENV.VIEW_KEY, OPENAI_API_KEY: OPENAI_KEY }, now: NOON })
  const response = await call(handler, { method: 'POST', headers: asTheBoard(JSON_TYPE), body: PORTRAIT })
  assert.equal(response.statusCode, 503)
  assert.equal(response.body.error, NOT_CONNECTED)
  assert.equal(calls.length, 0)
})

test('a bad slot or description is refused before the store or OpenAI', async (t) => {
  const calls = stubOpenAI(t, imageAnswer(webp()))
  for (const body of [
    { slot: 'agent-../x', description: 'a robot' },
    { slot: 'team.webp', description: 'a robot' },
    { slot: 'team', description: 'ab' },
    { slot: 'team', description: 'x'.repeat(401) },
    { slot: 'team', description: 'a robot‮' },
    { slot: 'team' },
    null,
    ['team', 'a robot']
  ]) {
    const { generate, fake } = board()
    const response = await generate(body)
    assert.equal(response.statusCode, 400, `${JSON.stringify(body)} was not refused`)
    assert.equal(storeCalls(fake), 0, `${JSON.stringify(body)} reached the store`)
  }
  assert.equal(calls.length, 0)
})

test('at the daily cap it is refused before OpenAI is called', async (t) => {
  const calls = stubOpenAI(t, imageAnswer(webp()))
  const { generate } = board({ env: { ...ENV, GENERATE_DAILY_CAP: '1' } })
  assert.equal((await generate(PORTRAIT)).statusCode, 200)
  const refused = await generate(PORTRAIT)
  assert.equal(refused.statusCode, 429)
  assert.match(refused.body.error, /tomorrow/)
  assert.doesNotMatch(refused.body.error, /raise|GENERATE_DAILY_CAP/i, 'the owner is told to raise the cap')
  assert.equal(calls.length, 1, 'the cap must stop the spend, not count it afterwards')
})

test('an attempt OpenAI fails still counts, so a failing upstream cannot be hammered past the cap', async (t) => {
  const calls = stubOpenAI(t, errorAnswer(500, { message: 'server error' }))
  const { generate } = board({ env: { ...ENV, GENERATE_DAILY_CAP: '2' } })
  await generate(PORTRAIT)
  await generate(PORTRAIT)
  assert.equal((await generate(PORTRAIT)).statusCode, 429)
  assert.equal(calls.length, 2)
})

test('making a picture does not spend the day\'s changes - only storing it does', async (t) => {
  stubOpenAI(t, imageAnswer(webp()))
  const { generate, store } = board()
  await generate(PORTRAIT)
  const { settings } = await store.readSettings()
  assert.deepEqual(settings.usage, { day: '2026-10-06', writes: 0, generated: 1 })
})

test('with no change left today to store it with, no picture is made and OpenAI is never paid', async (t) => {
  // From the security review (waste.mjs): a made picture is stored by an upload, which is a
  // change. With the day's changes used up - or switched off with WRITE_DAILY_CAP=0 - Make it
  // still charged OpenAI for a picture the upload then refused to keep.
  const calls = stubOpenAI(t, imageAnswer(webp()))
  for (const writes of ['0', '2']) {
    const env = { ...ENV, WRITE_DAILY_CAP: writes }
    const { generate, store } = board({ env })
    await store.saveSettings((draft) => { draft.usage = { day: '2026-10-06', writes: Number(writes), generated: 0 } })
    const refused = await generate(PORTRAIT)
    assert.equal(refused.statusCode, 429, `WRITE_DAILY_CAP=${writes}`)
    assert.match(refused.body.error, /No changes are left today/)
    assert.match(refused.body.error, /nothing was made/)
    assert.equal((await store.readSettings()).settings.usage.generated, 0, 'a picture nobody made was counted')
  }
  assert.equal(calls.length, 0, 'OpenAI was paid for a picture that could not be kept')
})

/* ---------- whatever OpenAI answers ---------- */

test('a refusal on safety grounds is a plain sentence, not OpenAI\'s message', async (t) => {
  stubOpenAI(t, errorAnswer(400, {
    code: 'moderation_blocked',
    type: 'image_generation_user_error',
    message: 'Your request was rejected as a result of our safety system. Request id req_123.'
  }))
  const response = await board().generate(PORTRAIT)
  assert.equal(response.statusCode, 400)
  assert.match(response.body.error, /safety/i)
  assert.match(response.body.error, /describe it differently/i)
  assert.ok(!response.body.error.includes('req_123'), 'OpenAI\'s own message is not passed on')
})

test('any other refusal of the description is a sentence too', async (t) => {
  stubOpenAI(t, errorAnswer(400, { code: 'invalid_value', message: 'Invalid prompt.' }))
  const response = await board().generate(PORTRAIT)
  assert.equal(response.statusCode, 400)
  assert.doesNotMatch(response.body.error, /Invalid prompt/)
})

test('a key OpenAI does not accept is named by its setting, never by its value', async (t) => {
  stubOpenAI(t, errorAnswer(401, { message: `Incorrect API key provided: ${OPENAI_KEY}.` }))
  const response = await board().generate(PORTRAIT)
  assert.equal(response.statusCode, 502)
  assert.match(response.body.error, /OPENAI_API_KEY/)
  assert.ok(!everythingSent(response).includes(OPENAI_KEY))
})

test('OpenAI\'s own limit is a sentence about the owner\'s OpenAI account', async (t) => {
  stubOpenAI(t, errorAnswer(429, { message: 'You exceeded your current quota.' }))
  const response = await board().generate(PORTRAIT)
  assert.equal(response.statusCode, 429)
  assert.match(response.body.error, /OpenAI/)
})

test('something that is not a picture, sent back as one, is refused', async (t) => {
  stubOpenAI(t, imageAnswer(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')))
  const response = await board().generate(PORTRAIT)
  assert.equal(response.statusCode, 502)
  assert.equal(response.sent, null)
})

test('an answer with no picture in it is refused', async (t) => {
  for (const body of ['{"data":[]}', '{"data":[{"url":"https://example.com/x.png"}]}', 'not json', '{}']) {
    stubOpenAI(t, () => new Response(body, { status: 200 }))
    const response = await board().generate(PORTRAIT)
    assert.equal(response.statusCode, 502, `${body} was not refused`)
    assert.equal(response.sent, null)
  }
})

test('a picture over 4 MB is refused, because the platform could not send it back', async (t) => {
  stubOpenAI(t, imageAnswer(webp(4 * 1024 * 1024 + 1)))
  const response = await board().generate(PORTRAIT)
  assert.equal(response.statusCode, 502)
  assert.equal(response.sent, null)
})

test('OpenAI taking too long is a sentence, not a hung request', async (t) => {
  stubOpenAI(t, () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  })
  const response = await board().generate(PORTRAIT)
  assert.equal(response.statusCode, 504)
  assert.match(response.body.error, /too long/)
})

/* ---------- the key never leaves the server ---------- */

test('the OpenAI key is never in any answer or any log, whatever OpenAI sends back', async (t) => {
  // Every upstream below echoes the key back, the way a careless proxy or an error page might.
  // None of it may reach the browser, and nothing may write it to the function's logs.
  const echo = (status) => (url, options) =>
    new Response(JSON.stringify({ error: { message: `bad key ${options.headers.Authorization}`, code: OPENAI_KEY } }), { status })
  const answers = [
    echo(400),
    echo(401),
    echo(403),
    echo(429),
    echo(500),
    (url, options) => new Response(`${options.headers.Authorization} is not valid`, { status: 502 }),
    (url, options) => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(options.headers.Authorization).toString('base64') }] }), { status: 200 }),
    (url, options) => new Response(JSON.stringify({ echo: options.headers.Authorization }), { status: 200 }),
    () => {
      throw new Error(`connect failed while sending ${OPENAI_KEY}`)
    }
  ]

  const logged = []
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level]
    console[level] = (...parts) => logged.push(parts.map(String).join(' '))
    t.after(() => {
      console[level] = original
    })
  }

  for (const [index, answer] of answers.entries()) {
    stubOpenAI(t, answer)
    const response = await board().generate(PORTRAIT)
    assert.ok(response.statusCode >= 400, `answer ${index} was treated as a picture`)
    const sent = everythingSent(response)
    assert.ok(!sent.includes(OPENAI_KEY), `answer ${index} sent the key back to the browser`)
    assert.ok(!sent.includes('Bearer'), `answer ${index} sent the Authorization header back`)
  }
  assert.ok(!logged.some((line) => line.includes(OPENAI_KEY)), 'the key was written to a log')
})

/* ---------- the rest of the contract ---------- */

test('only POST is answered', async () => {
  const response = await call(board().handler, { method: 'GET', headers: asTheBoard() })
  assert.equal(response.statusCode, 405)
  assert.equal(response.headers.Allow, 'POST')
})

test('a request goes through the write gate: a form-shaped body is refused before anything else', async (t) => {
  const calls = stubOpenAI(t, imageAnswer(webp()))
  const { generate, fake } = board()
  const response = await generate('slot=team&description=a+robot', asTheBoard({ 'content-type': 'application/x-www-form-urlencoded' }))
  assert.equal(response.statusCode, 415)
  assert.equal(calls.length, 0)
  assert.equal(storeCalls(fake), 0)
})
