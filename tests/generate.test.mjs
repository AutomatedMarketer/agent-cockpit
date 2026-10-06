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
import { makeHandler as makeUpload } from '../api/upload.js'
import { makeHandler as makeBrand } from '../api/brand.js'
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

test('pictures refused at either cap cost no read that skips the cache, and no OpenAI call', async (t) => {
  const calls = stubOpenAI(t, imageAnswer(webp()))
  const uncached = ((fake) => fake.calls.get.filter((read) => read.options.useCache === false).length)
  // Out of pictures from words.
  const pictures = board({ env: { ...ENV, GENERATE_DAILY_CAP: '1' } })
  assert.equal((await pictures.generate(PORTRAIT)).statusCode, 200)
  let before = uncached(pictures.fake)
  for (let i = 0; i < 100; i += 1) assert.equal((await pictures.generate(PORTRAIT)).statusCode, 429)
  assert.equal(uncached(pictures.fake) - before, 0, 'refused pictures skipped the cache')
  // Out of changes to keep one with.
  const changes = board({ env: { ...ENV, WRITE_DAILY_CAP: '0' } })
  before = uncached(changes.fake)
  for (let i = 0; i < 100; i += 1) assert.equal((await changes.generate(PORTRAIT)).statusCode, 429)
  assert.equal(uncached(changes.fake) - before, 0, 'pictures refused for want of a change skipped the cache')
  assert.equal(calls.length, 1)
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
  // The picture is counted, and the change that will keep it is held - not yet spent.
  assert.deepEqual(settings.usage, { day: '2026-10-06', writes: 0, generated: 1, pending: [{ slot: 'agent-content', at: '2026-10-06T12:00:00.000Z' }] })
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

// A board with the day's changes used up to `used`, and the three endpoints a made picture goes
// through, all on one store and one clock.
async function dayWith(used, { clock = NOON } = {}) {
  const { store, fake } = connectedStore(ENV)
  await store.saveSettings((draft) => { draft.usage = { day: '2026-10-06', writes: used, generated: 0, pending: [] } })
  const generate = makeHandler({ store, env: ENV, now: clock })
  const upload = makeUpload({ store, env: ENV, now: clock })
  const brand = makeBrand({ store, env: ENV, now: clock })
  return {
    store,
    fake,
    make: () => call(generate, { method: 'POST', headers: asTheBoard(JSON_TYPE), body: { slot: 'today', description: 'a harbour' } }),
    keep: (bytes, slot = 'today') => call(upload, { method: 'POST', headers: asTheBoard({ 'content-type': 'application/octet-stream' }), query: { slot }, body: bytes }),
    rename: (value) => call(brand, { method: 'POST', headers: asTheBoard(JSON_TYPE), body: { change: 'name', slug: 'content', value } }),
    left: async () => (await call(brand, { method: 'GET', headers: asTheBoard() })).body.left
  }
}

test('with one change left, two Make it at once pay OpenAI once, and the picture made is kept', async (t) => {
  // From the second review (attack3, part D): both requests saw one change left and both paid
  // OpenAI; only one picture could then be kept. A picture from words now holds the change that
  // will keep it, in the same save that counts the picture, so the second finds none free.
  const calls = stubOpenAI(t, async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
    return imageAnswer(webp(500))()
  })
  const day = await dayWith(19)
  const made = await Promise.all([day.make(), day.make()])
  assert.deepEqual(made.map((answer) => answer.statusCode).sort(), [200, 429])
  assert.match(made.find((answer) => answer.statusCode === 429).body.error, /No changes are left today/)
  assert.equal(calls.length, 1, 'OpenAI was paid for a picture there was no change left to keep')
  const kept = await day.keep(made.find((answer) => answer.statusCode === 200).sent)
  assert.equal(kept.statusCode, 200, 'the picture made could not be kept')
})

test('the change a made picture holds cannot be spent by anything else, and is shown as used', async (t) => {
  stubOpenAI(t, imageAnswer(webp(500)))
  const day = await dayWith(19)
  const made = await day.make()
  assert.equal(made.statusCode, 200)
  assert.equal((await day.left()).writes, 0, 'the held change is offered on the page')
  assert.equal((await day.rename('Penny')).statusCode, 429, 'a rename took the change the picture was holding')
  assert.equal((await day.keep(webp(500), 'team')).statusCode, 429, 'an upload to another slot took it')
  assert.equal((await day.keep(made.sent)).statusCode, 200, 'the picture itself could not use it')
  assert.deepEqual((await day.store.readSettings({ fresh: true })).settings.usage.pending, [], 'the change stayed held after it was used')
})

test('a made picture that is never kept lets its change go after ten minutes', async (t) => {
  // A picture can be made and then never stored: the tab closed, OpenAI's answer refused, the
  // shrink failed. Its change is held for ten minutes - far longer than making and storing one
  // takes - and then free again, with no extra write needed to let it go.
  stubOpenAI(t, imageAnswer(webp(500)))
  let clock = Date.parse('2026-10-06T12:00:00Z')
  const day = await dayWith(19, { clock: () => new Date(clock) })
  assert.equal((await day.make()).statusCode, 200)
  clock += 9 * 60_000
  assert.equal((await day.rename('Penny')).statusCode, 429)
  clock += 2 * 60_000
  assert.equal((await day.rename('Penny')).statusCode, 200, 'a change was held for good by a picture nobody kept')
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

test('OpenAI gets only the time the request has left, so the whole request ends inside 60 seconds', { timeout: 5_000 }, async (t) => {
  // vercel.json gives this function 60 s. A fixed 55 s for OpenAI, started after a slow store
  // save, would run past that and end on the platform's timeout page instead of our sentence.
  // Here the store "took" 54.95 s, so OpenAI gets the 50 ms that are left.
  const start = Date.parse('2026-10-06T12:00:00Z')
  let first = true
  const now = () => {
    const at = first ? start : start + 54_950
    first = false
    return new Date(at)
  }
  stubOpenAI(t, (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason))
  }))
  const response = await board({ now }).generate(PORTRAIT)
  assert.equal(response.statusCode, 504)
  assert.match(response.body.error, /too long/)
})

test('an answer from OpenAI is read only as far as the largest picture it may carry', async (t) => {
  // An upstream answer read with .json() is buffered whole first. One that never ends, or ends
  // at 50 MB, would hold the function's memory for nothing: reading stops just past the limit.
  let pulled = 0
  stubOpenAI(t, () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"data":[{"b64_json":"')) },
    pull(controller) {
      if (pulled >= 50 * 1024 * 1024) return controller.close()
      pulled += 64 * 1024
      controller.enqueue(new Uint8Array(64 * 1024).fill(0x41))
    }
  }), { status: 200 }))
  const response = await board().generate(PORTRAIT)
  assert.equal(response.statusCode, 502)
  assert.match(response.body.error, /too big/)
  assert.ok(pulled < 8 * 1024 * 1024, `${Math.round(pulled / 1024 / 1024)} MB of the answer was read`)
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
