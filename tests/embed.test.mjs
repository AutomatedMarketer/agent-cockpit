// The one OpenAI call meaning search makes (api/_embed.js): texts in, vectors out, in batches OpenAI
// accepts. OpenAI is a fake fetch handed in; nothing here reaches the network. Held to: the exact
// request; batches of at most 2,048 texts and 300,000 tokens (counted at 3 characters a token, to stay
// under); every failure is one of the board's own sentences - never OpenAI's words, never a key.

import test from 'node:test'
import assert from 'node:assert/strict'
import { embedTexts, batchesOf, estimateTokens, EmbedError, EMBED, EMBED_SAY } from '../api/_embed.js'
import { MEANING } from '../api/_memory-index.js'

const KEY = 'sk-test-thisMustNeverLeaveTheServer'
const ENDPOINT = 'https://api.openai.com/v1/embeddings'

// A vector OpenAI could send for text number `at`: base64 of little-endian float32s.
const floats = (at) => Float32Array.from({ length: MEANING.dimensions }, (_, axis) => ((at + 1) * (axis + 1)) % 7 / 7 - 0.5)
const base64Of = (values) => Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString('base64')

function fakeOpenAI(answer = null) {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    const body = JSON.parse(options.body)
    calls.push({ url: String(url), options, body })
    if (answer) return answer(body, calls.length)
    return Response.json({
      object: 'list',
      data: body.input.map((_, at) => ({ object: 'embedding', index: at, embedding: base64Of(floats(at)) })),
      model: body.model,
      usage: { prompt_tokens: body.input.length * 5, total_tokens: body.input.length * 5 }
    })
  }
  return { calls, fetchImpl }
}

async function refusal(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  assert.fail('it did not refuse')
}

test('one text: one request, exactly as planned, and its vector back', async () => {
  const openai = fakeOpenAI()
  const result = await embedTexts(['hello there'], { apiKey: KEY, fetchImpl: openai.fetchImpl })
  assert.equal(openai.calls.length, 1)
  const [sent] = openai.calls
  assert.equal(sent.url, ENDPOINT)
  assert.equal(sent.options.method, 'POST')
  assert.equal(sent.options.headers.Authorization, `Bearer ${KEY}`)
  assert.equal(sent.options.headers['Content-Type'], 'application/json')
  assert.ok(sent.options.signal instanceof AbortSignal, 'a call to OpenAI must be able to time out')
  assert.deepEqual(sent.body, { model: 'text-embedding-3-small', input: ['hello there'], dimensions: 512, encoding_format: 'base64' })
  assert.equal(result.vectors.length, 1)
  assert.deepEqual([...result.vectors[0]], [...floats(0)])
  assert.equal(result.tokens, 5)
  assert.equal(EMBED.timeoutMs, 20_000)
})

test('2,049 texts are two requests, and the vectors come back in the order given', async () => {
  const openai = fakeOpenAI()
  const texts = Array.from({ length: 2049 }, (_, at) => `note ${at}`)
  const result = await embedTexts(texts, { apiKey: KEY, fetchImpl: openai.fetchImpl })
  assert.deepEqual(openai.calls.map((call) => call.body.input.length), [2048, 1])
  assert.equal(result.vectors.length, 2049)
  assert.deepEqual([...result.vectors[2048]], [...floats(0)], 'the second request\'s first vector is the 2,049th')
  assert.equal(result.tokens, 2049 * 5)
})

test('a batch holds at most 300,000 tokens, counted at 3 characters a token', () => {
  assert.equal(estimateTokens('x'.repeat(3)), 1)
  assert.equal(estimateTokens('x'.repeat(4)), 2)
  const tokensWorth = (tokens) => 'x'.repeat(tokens * 3)
  assert.deepEqual(batchesOf([tokensWorth(100_000), tokensWorth(100_000), tokensWorth(100_000)]).map((batch) => batch.length), [3])
  assert.deepEqual(batchesOf([tokensWorth(100_000), tokensWorth(100_000), `${tokensWorth(100_000)}x`]).map((batch) => batch.length), [2, 1])
  assert.deepEqual(batchesOf([]), [])
})

test('OpenAI\'s answer the board did not expect is our sentence: too few vectors, the wrong size, not numbers', async () => {
  const shapes = {
    'one vector short': (body) => Response.json({ data: body.input.slice(1).map((_, at) => ({ index: at, embedding: base64Of(floats(at)) })) }),
    'the wrong size': (body) => Response.json({ data: body.input.map((_, at) => ({ index: at, embedding: base64Of(new Float32Array(10)) })) }),
    'an index twice': (body) => Response.json({ data: body.input.map(() => ({ index: 0, embedding: base64Of(floats(0)) })) }),
    'not a number': (body) => Response.json({ data: body.input.map((_, at) => ({ index: at, embedding: base64Of(Float32Array.from({ length: MEANING.dimensions }, () => Number.NaN)) })) }),
    'not JSON': () => new Response('<html>oops</html>', { status: 200 })
  }
  for (const [name, answer] of Object.entries(shapes)) {
    const error = await refusal(embedTexts(['a', 'b'], { apiKey: KEY, fetchImpl: fakeOpenAI(answer).fetchImpl }))
    assert.ok(error instanceof EmbedError, name)
    assert.equal(error.message, EMBED_SAY.odd, name)
  }
})

test('every refusal is one of the board\'s sentences; OpenAI\'s own words and anything key-shaped never come out', async () => {
  const leak = 'Incorrect API key provided: sk-proj-ABCDEF1234567890abcdef. You can find your key at https://platform.openai.com'
  const refused = (status, error, headers = {}) => () => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json', ...headers } })
  const cases = [
    ['a wrong key', refused(401, { message: leak, code: 'invalid_api_key' }), 502, EMBED_SAY.key, undefined],
    ['no access', refused(403, { message: leak }), 502, EMBED_SAY.key, undefined],
    ['the spend limit', refused(429, { message: leak, code: 'insufficient_quota', type: 'insufficient_quota' }), 429, EMBED_SAY.spent, undefined],
    ['the rate limit', refused(429, { message: leak, code: 'rate_limit_exceeded' }, { 'retry-after': '17' }), 429, EMBED_SAY.busy(17), 17],
    ['the rate limit with no wait given', refused(429, { message: leak }), 429, EMBED_SAY.busy(20), 20],
    ['a wait that is too long', refused(429, { message: leak }, { 'retry-after': '99999' }), 429, EMBED_SAY.busy(3600), 3600],
    ['a server error', refused(500, { message: leak }), 502, EMBED_SAY.failed, undefined],
    ['a bad request', refused(400, { message: leak }), 502, EMBED_SAY.failed, undefined]
  ]
  for (const [name, answer, status, sentence, retryAfter] of cases) {
    const error = await refusal(embedTexts(['a'], { apiKey: KEY, fetchImpl: fakeOpenAI(answer).fetchImpl }))
    assert.ok(error instanceof EmbedError, name)
    assert.equal(error.status, status, name)
    assert.equal(error.message, sentence, name)
    assert.equal(error.retryAfter, retryAfter, name)
    const everything = `${error.message} ${JSON.stringify(error)} ${error.stack}`
    assert.ok(!everything.includes('sk-proj') && !everything.includes(KEY) && !everything.includes('Incorrect'), `${name}: leaked`)
  }
})

test('a call that takes too long, or never connects, is our sentence', async () => {
  const slow = await refusal(embedTexts(['a'], {
    apiKey: KEY,
    fetchImpl: async () => { throw Object.assign(new Error(`timed out ${KEY}`), { name: 'TimeoutError' }) }
  }))
  assert.equal(slow.message, EMBED_SAY.slow)
  assert.equal(slow.status, 504)
  const dropped = await refusal(embedTexts(['a'], {
    apiKey: KEY,
    fetchImpl: async () => { throw new TypeError(`fetch failed ${KEY}`) }
  }))
  assert.equal(dropped.message, EMBED_SAY.failed)
  assert.ok(!JSON.stringify(dropped).includes(KEY) && !dropped.message.includes(KEY))
  // The time limit is real: a call that never answers is cut off by its signal.
  const hanging = await refusal(embedTexts(['a'], {
    apiKey: KEY,
    timeoutMs: 30,
    fetchImpl: (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason))
    })
  }))
  assert.equal(hanging.message, EMBED_SAY.slow)
})

test('a later batch that fails keeps nothing from the earlier ones, and says how many tokens were spent', async () => {
  const error = await refusal(embedTexts(Array.from({ length: 2049 }, () => 'x'), {
    apiKey: KEY,
    fetchImpl: fakeOpenAI((body, call) => (call === 1
      ? Response.json({ data: body.input.map((_, at) => ({ index: at, embedding: base64Of(floats(at)) })), usage: { total_tokens: 99 } })
      : new Response('{}', { status: 500 }))).fetchImpl
  }))
  assert.equal(error.message, EMBED_SAY.failed)
  assert.equal(error.tokens, 99, 'what was paid for is still counted')
})
