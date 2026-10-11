// POST /api/memory-search { q }: the words of a search, turned into a vector (one OpenAI call, kept for
// repeats), scored against the index on the server, and answered as [[path, similarity]] - never a
// vector. Behind the write gate (it spends, a little), off unless switched on, 1-300 characters with no
// hidden ones, and at most 30 OpenAI calls a minute and 1,000 a day per server instance, to stop a stuck
// loop. GitHub, OpenAI and the store are fakes.

import test from 'node:test'
import assert from 'node:assert/strict'
import { makeHandler } from '../api/memory-search.js'
import { makeHandler as makeIndex } from '../api/memory-index.js'
import { MEANING_SAY, MEANING_LIMITS, SEARCH_SAY } from '../api/_memory-meaning.js'
import { EMBED_SAY } from '../api/_embed.js'
import { asTheBoard, call, everythingSent } from './helpers/personalise-harness.mjs'
import { ENV, HEAD, NEWER, OPENAI_KEY, stubFetch, meaningWorld, blobCalls } from './helpers/meaning-fakes.mjs'

const JSON_TYPE = { 'content-type': 'application/json' }
const NOTES = {
  'shared/writing-rules.md': '# Writing rules\nHow the agents write: short sentences, plain words.\n',
  'shared/standards/definition-of-done.md': '# Definition of done\nA task is finished when it is tested, reviewed and shipped.\n',
  'agents/sales/knowledge/offer-sheet.md': '# Offer sheet\nWhat we sell and the price of each package.\n',
  'inbox/2026-10-11/morning-intel.md': '# Morning intel\nThree things happened overnight.\n'
}

function board(t, { env = ENV, files = NOTES, openai, clock } = {}) {
  const world = meaningWorld(t, { env })
  let stub = stubFetch({ files, openai })
  t.after(() => stub.restore())
  let time = clock ?? Date.parse('2026-10-11T09:00:00Z')
  const search = makeHandler({ store: world.store, env, now: () => time })
  const learn = makeIndex({ store: world.store, env, now: () => time })
  return {
    ...world,
    calls: () => stub.calls,
    learn: () => call(learn, { method: 'POST', headers: asTheBoard(JSON_TYPE), body: {} }),
    ask: (q, headers = asTheBoard(JSON_TYPE)) => call(search, { method: 'POST', headers, body: { q } }),
    later: (ms) => { time += ms },
    swap: (next) => {
      stub.restore()
      stub = stubFetch(next)
    }
  }
}

const outside = (calls) => calls.head.length + calls.tree.length + calls.blob.length + calls.openai.length

test('refused before any GitHub, OpenAI or store call: no key, a wrong type, another site, a GET', async (t) => {
  const world = board(t)
  const handler = makeHandler({ store: world.store, env: ENV })
  const cases = [
    [{ method: 'POST', headers: JSON_TYPE }, 401],
    [{ method: 'POST', headers: asTheBoard({ 'content-type': 'text/plain' }) }, 415],
    [{ method: 'POST', headers: asTheBoard({ ...JSON_TYPE, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }) }, 403],
    [{ method: 'GET', headers: asTheBoard() }, 405]
  ]
  for (const [request, status] of cases) {
    const response = await call(handler, { body: { q: 'writing' }, ...request })
    assert.equal(response.statusCode, status)
    assert.equal(response.headers['Cache-Control'], 'private, no-store')
  }
  assert.equal(outside(world.calls()), 0)
  assert.equal(blobCalls(world.fake), 0)
})

test('off unless switched on: says why, and calls nothing', async (t) => {
  const world = board(t, { env: { ...ENV, MEMORY_MEANING: 'off' } })
  const response = await world.ask('writing')
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.body, { on: false, why: MEANING_SAY.off })
  assert.equal(outside(world.calls()), 0)
})

test('1 to 300 characters of plain text, no hidden characters: anything else is refused before OpenAI', async (t) => {
  const world = board(t)
  await world.learn()
  const before = world.calls().openai.length
  for (const q of ['', '   ', 'x'.repeat(301), `writing${String.fromCodePoint(0xe0041)}`, `a${String.fromCharCode(0x200b)}b`, `ring${String.fromCharCode(7)}bell`, 42, null, ['writing']]) {
    const response = await world.ask(q)
    assert.equal(response.statusCode, 400, JSON.stringify(q))
    assert.equal(response.body.error, SEARCH_SAY.badQuery)
  }
  assert.equal(world.calls().openai.length, before, 'a refused search reached OpenAI')
  assert.equal((await world.ask('x'.repeat(300))).statusCode, 200)
  assert.equal(MEANING_LIMITS.queryChars, 300)
})

test('before anything is learned: not ready, and OpenAI is not asked', async (t) => {
  const world = board(t)
  const response = await world.ask('how should the agents write')
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.body, { on: true, ready: false, indexed: 0 })
  assert.equal(world.calls().openai.length, 0)
})

test('a search finds notes by meaning, best first, as paths and similarities only', async (t) => {
  const world = board(t)
  await world.learn()
  const response = await world.ask('when is a task finished')
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['Cache-Control'], 'private, no-store')
  assert.equal(response.body.on, true)
  assert.equal(response.body.ready, true)
  assert.equal(response.body.commit, HEAD)
  assert.equal(response.body.indexed, 4)
  assert.equal(response.body.hits[0][0], 'shared/standards/definition-of-done.md')
  for (const hit of response.body.hits) {
    assert.equal(hit.length, 2)
    assert.ok(Object.hasOwn(NOTES, hit[0]))
    assert.equal(typeof hit[1], 'number')
  }
  const sims = response.body.hits.map((hit) => hit[1])
  assert.deepEqual(sims, [...sims].sort((a, b) => b - a))
  assert.deepEqual(Object.keys(response.body).sort(), ['commit', 'hits', 'indexed', 'on', 'ready'])
  const sent = everythingSent(response)
  assert.ok(!/[A-Za-z0-9+/]{80,}/.test(sent), 'a vector or base64 run was sent')
  assert.ok(!sent.includes(OPENAI_KEY) && !sent.includes('tested, reviewed'))
  const query = world.calls().openai.at(-1)
  assert.deepEqual(query.body.input, ['when is a task finished'])
})

test('the same words again cost no OpenAI call, whatever their case or spacing', async (t) => {
  const world = board(t)
  await world.learn()
  await world.ask('what we sell')
  const after = world.calls().openai.length
  const again = await world.ask('  What   WE sell ')
  assert.equal(again.statusCode, 200)
  assert.equal(world.calls().openai.length, after)
  assert.equal(again.body.hits[0][0], 'agents/sales/knowledge/offer-sheet.md')
})

test('at most 30 OpenAI calls a minute per server; the 31st is a sentence with the wait, and a minute later it carries on', async (t) => {
  const world = board(t)
  await world.learn()
  for (let at = 0; at < 30; at += 1) assert.equal((await world.ask(`question ${at}`)).statusCode, 200, `search ${at}`)
  const refused = await world.ask('question 31')
  assert.equal(refused.statusCode, 429)
  assert.equal(refused.body.error, SEARCH_SAY.tooManyMinute)
  assert.ok(Number(refused.headers['Retry-After']) >= 1 && Number(refused.headers['Retry-After']) <= 60)
  assert.equal((await world.ask('question 0')).statusCode, 200, 'a repeat is free, so it is never refused')
  world.later(61_000)
  assert.equal((await world.ask('question 31')).statusCode, 200)
  assert.equal(MEANING_LIMITS.searchesPerMinute, 30)
})

test('at most 1,000 OpenAI calls a UTC day per server; then a sentence until midnight UTC', async (t) => {
  const world = board(t, { clock: Date.parse('2026-10-11T00:00:00Z') })
  await world.learn()
  for (let at = 0; at < 1000; at += 1) {
    world.later(3_000)
    assert.equal((await world.ask(`day question ${at}`)).statusCode, 200, `search ${at}`)
  }
  world.later(3_000)
  const refused = await world.ask('one more')
  assert.equal(refused.statusCode, 429)
  assert.equal(refused.body.error, SEARCH_SAY.tooManyDay)
  world.later(24 * 3600_000)
  assert.equal((await world.ask('one more')).statusCode, 200, 'a new UTC day did not start again')
  assert.equal(MEANING_LIMITS.searchesPerDay, 1000)
})

test('the last 200 searches are kept; an older one is asked of OpenAI again', async (t) => {
  const world = board(t)
  await world.learn()
  for (let at = 0; at < 201; at += 1) {
    world.later(2_100)
    await world.ask(`kept question ${at}`)
  }
  const before = world.calls().openai.length
  await world.ask('kept question 200')
  assert.equal(world.calls().openai.length, before, 'the newest was not kept')
  world.later(2_100)
  await world.ask('kept question 0')
  assert.equal(world.calls().openai.length, before + 1, 'more than 200 were kept')
  // Asked again, a search is the newest kept: 2 is the oldest now (0 pushed 1 out), and asking 2 keeps it.
  await world.ask('kept question 2')
  world.later(2_100)
  await world.ask('a new one')
  const now = world.calls().openai.length
  await world.ask('kept question 2')
  assert.equal(world.calls().openai.length, now, 'a search asked again was not kept as the newest')
  world.later(2_100)
  await world.ask('kept question 3')
  assert.equal(world.calls().openai.length, now + 1)
  assert.equal(MEANING_LIMITS.cachedQueries, 200)
})

test('a note gone from the index is never found', async (t) => {
  const world = board(t)
  await world.learn()
  const { 'agents/sales/knowledge/offer-sheet.md': gone, ...rest } = NOTES
  world.swap({ files: rest, head: NEWER })
  world.later(1000)
  await world.learn()
  const response = await world.ask('what we sell and the price')
  assert.ok(!response.body.hits.some(([path]) => path === 'agents/sales/knowledge/offer-sheet.md'))
  assert.equal(response.body.indexed, 3)
})

test('OpenAI refusing the search is our sentence, never its words or the key', async (t) => {
  const world = board(t, {
    openai: (body) => (body.input.length === 1 && body.input[0] === 'refused words'
      ? new Response(JSON.stringify({ error: { message: `bad key ${OPENAI_KEY}`, code: 'invalid_api_key' } }), { status: 401 })
      : null)
  })
  await world.learn()
  const response = await world.ask('refused words')
  assert.equal(response.statusCode, 502)
  assert.equal(response.body.error, EMBED_SAY.key)
  assert.ok(!everythingSent(response).includes(OPENAI_KEY))
})
