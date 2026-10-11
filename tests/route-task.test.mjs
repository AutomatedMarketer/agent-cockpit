// /api/route-task: Jev, on OpenRouter, picks who should do a task the owner asked for by voice, and
// on which model tier, each with its odds (Nuno, 2026-10-10 and 2026-10-11). Off unless JEV_ROUTING
// is on AND an OpenRouter key is set; with it off, the orchestrator routes the card on its sweep, as
// the Add task button does, on the agent's own model. With it on, the order's words go to OpenRouter,
// which the README says where the switch is.
//
// OpenRouter is stubbed through globalThis.fetch; nothing reaches the network. What these hold it
// to: the write gate before anything is read or sent; the key in one header to one address; only an
// agent or a model it was sent, at 60% or surer, ever comes back, with odds a whole number 0 to 100;
// anything else - off, slower than 1.5 s, an error, a vendor's words - is no pick, with our own
// one-word reason; and no answer is kept by a shared cache.

import test from 'node:test'
import assert from 'node:assert/strict'
import { makeHandler, JEV_URL, JEV_MODEL, JEV_TIMEOUT_MS } from '../api/route-task.js'
import { STORE_ENV, asTheBoard, call } from './helpers/personalise-harness.mjs'

const KEY = ['or', 'test', 'routingKeyThatStaysOnTheServer'].join('-')
const ON = { ...STORE_ENV, JEV_ROUTING: 'on', OPENROUTER_API_KEY: KEY }
const JSON_TYPE = { 'content-type': 'application/json' }
const AGENTS = [{ slug: 'research', description: 'Finds things out and writes it up.' }, { slug: 'content', description: 'Writes the newsletter and posts.' }]
const ASK = { title: 'Draft this week\'s newsletter', details: 'Use the Monday notes.', agents: AGENTS, models: ['opus', 'sonnet'] }
const NOBODY = (why) => ({ agent: { pick: null, why }, model: { pick: null, why } })

const realFetch = globalThis.fetch
function stubJev(t, answer) {
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    return answer(url, options)
  }
  t.after(() => { globalThis.fetch = realFetch })
  return calls
}
const answered = (answers, status = 200) => () => new Response(JSON.stringify({ answers }), { status, headers: { 'content-type': 'application/json' } })
const picked = (owner, ownerSure, model = 'sonnet', modelSure = 0.74) =>
  answered({ owner: { type: 'choice', choice: owner, confidence: ownerSure }, model: { type: 'choice', choice: model, confidence: modelSure } })
const ask = (env, body = ASK, headers = asTheBoard(JSON_TYPE), method = 'POST') =>
  call(makeHandler({ env, timeoutMs: 50 }), { method, headers, body })
const noCache = (response, label) => assert.equal(response.headers['Cache-Control'], 'private, no-store', `${label}: not private, no-store`)

test('with the switch off, or no OpenRouter key, nothing is sent anywhere: the orchestrator routes, on the agent\'s own model', async (t) => {
  const calls = stubJev(t, picked('content', 0.9))
  for (const env of [STORE_ENV, { ...STORE_ENV, JEV_ROUTING: 'on' }, { ...STORE_ENV, OPENROUTER_API_KEY: KEY }, { ...ON, JEV_ROUTING: 'off' }]) {
    const response = await ask(env)
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.body, NOBODY('off'))
    noCache(response, 'off')
  }
  assert.equal(calls.length, 0, 'the order went to OpenRouter with the switch off')
})

test('the write gate comes first: a stranger, another site, or the wrong body type is refused before anything is sent', async (t) => {
  const calls = stubJev(t, picked('content', 0.9))
  const stranger = await ask(ON, ASK, JSON_TYPE)
  assert.equal(stranger.statusCode, 401)
  noCache(stranger, 'a stranger')
  const crossSite = await ask(ON, ASK, asTheBoard({ ...JSON_TYPE, 'sec-fetch-site': 'cross-site' }))
  assert.equal(crossSite.statusCode, 403)
  const form = await ask(ON, ASK, asTheBoard({ 'content-type': 'text/plain' }))
  assert.equal(form.statusCode, 415)
  const editKeyed = await ask({ ...ON, EDIT_KEY: 'an-edit-key' })
  assert.equal(editKeyed.statusCode, 401, 'a board with an edit key let a change through without it')
  const get = await ask(ON, undefined, asTheBoard(), 'GET')
  assert.equal(get.statusCode, 405)
  noCache(get, 'a GET')
  assert.equal(calls.length, 0)
})

test('Jev is asked two choices - who, over exactly the agents sent, and which tier, over exactly the tiers sent - in one call, with the key in one header', async (t) => {
  const calls = stubJev(t, picked('content', 0.84, 'sonnet', 0.74))
  const response = await ask(ON)
  assert.equal(response.statusCode, 200)
  noCache(response, 'a pick')
  assert.deepEqual(response.body, { agent: { pick: 'content', odds: 84 }, model: { pick: 'sonnet', odds: 74 } })
  assert.equal(calls.length, 1, 'more than one call for one card')
  const [sent] = calls
  assert.equal(sent.url, JEV_URL)
  assert.equal(JEV_URL, 'https://openrouter.ai/api/alpha/decisions')
  assert.equal(sent.options.method, 'POST')
  assert.deepEqual(Object.keys(sent.options.headers).sort(), ['Authorization', 'Content-Type'])
  assert.equal(sent.options.headers.Authorization, `Bearer ${KEY}`)
  assert.ok(sent.options.signal instanceof AbortSignal, 'a call to OpenRouter must be able to time out')
  const body = JSON.parse(sent.options.body)
  assert.equal(body.model, JEV_MODEL)
  assert.deepEqual(Object.keys(body.questions).sort(), ['model', 'owner'])
  assert.equal(body.questions.owner.type, 'choice')
  assert.deepEqual(Object.keys(body.questions.owner.criteria), ['research', 'content'])
  assert.equal(body.questions.model.type, 'choice')
  assert.deepEqual(Object.keys(body.questions.model.criteria), ['opus', 'sonnet'])
  // What goes to OpenRouter: the task's words, the agents' slugs and descriptions, our tier notes.
  assert.deepEqual(body.state, { task: 'Draft this week\'s newsletter', details: 'Use the Monday notes.' })
  assert.ok(!JSON.stringify(response.body).includes(KEY))
})

test('Jev must answer within 1.5 s, or the card goes as if it were off', async (t) => {
  assert.equal(JEV_TIMEOUT_MS, 1500)
  stubJev(t, (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })))))
  assert.deepEqual((await ask(ON)).body, NOBODY('no answer'))
})

test('each choice stands alone: only an option it was sent, at 60% or surer, as a whole 0-100', async (t) => {
  const cases = [
    [picked('content', 0.84, 'sonnet', 0.59), { agent: { pick: 'content', odds: 84 }, model: { pick: null, why: 'unsure' } }],
    [picked('sales', 0.99, 'opus', 0.9), { agent: { pick: null, why: 'unsure' }, model: { pick: 'opus', odds: 90 } }],
    [picked('content', 0.6, 'gpt-5', 0.99), { agent: { pick: 'content', odds: 60 }, model: { pick: null, why: 'unsure' } }],
    [picked('content', 1, 'sonnet', 0), { agent: { pick: 'content', odds: 100 }, model: { pick: null, why: 'unsure' } }],
    // A confidence no honest answer gives is refused, not shown as 100%: a compromised reply must not
    // earn the card's strongest endorsement (review 2026-10-11: 7 and 1e9 came back as 100%).
    [picked('content', 1.7, 'sonnet', -3), NOBODY('unsure')],
    [picked('content', 7, 'haiku', 1e9), NOBODY('unsure')],
    [() => new Response('{"answers":{"owner":{"type":"choice","choice":"content","confidence":1e999}}}', { status: 200, headers: { 'content-type': 'application/json' } }), NOBODY('unsure')],
    [picked('content', '0.9', 'sonnet', Number.NaN), { agent: { pick: null, why: 'unsure' }, model: { pick: null, why: 'unsure' } }],
    [answered({ owner: { choice: 'content', confidence: 0.9 } }), { agent: { pick: 'content', odds: 90 }, model: { pick: null, why: 'unsure' } }],
    [picked('constructor', 0.99, 'toString', 0.99), NOBODY('unsure')]
  ]
  for (const [answer, expected] of cases) {
    stubJev(t, answer)
    assert.deepEqual((await ask(ON)).body, expected)
  }
})

test('a timeout, an error, words, or a refusal is no pick at all, and the vendor\'s words never come back', async (t) => {
  const cases = [
    ['a server error', () => new Response('internal: Jev saw <your task>', { status: 500 })],
    ['an error status, whatever its body says', answered({ owner: { choice: 'content', confidence: 0.9 }, model: { choice: 'opus', confidence: 0.9 } }, 502)],
    ['words, not JSON', () => new Response('I think content should do it', { status: 200 })],
    ['a refusal with words', () => new Response(JSON.stringify({ error: { message: 'Leaked vendor words' } }), { status: 400 })],
    ['the network failing', () => { throw new Error('ECONNRESET Leaked vendor words') }]
  ]
  for (const [what, answer] of cases) {
    stubJev(t, answer)
    const response = await ask(ON)
    assert.equal(response.statusCode, 200, what)
    assert.deepEqual(response.body, NOBODY('no answer'), what)
    assert.ok(!JSON.stringify(response.body).includes('Leaked'), `${what}: the vendor's words were relayed`)
    noCache(response, what)
  }
})

test('what is sent is checked and capped first: a plain title, short details, real slugs, only known tiers', async (t) => {
  const calls = stubJev(t, picked('agent-1', 0.9))
  for (const title of ['', 'ab', 'x'.repeat(201), 'two\nlines', 42, 'Draft​it']) {
    const response = await ask(ON, { ...ASK, title })
    assert.equal(response.statusCode, 400, JSON.stringify(title))
    noCache(response, 'a bad title')
  }
  assert.equal(calls.length, 0, 'a bad request reached OpenRouter')
  const many = Array.from({ length: 30 }, (unused, n) => ({ slug: `agent-${n}`, description: 'd'.repeat(500) }))
  await ask(ON, { title: 'Draft it', agents: [{ slug: '../escape', description: 'x' }, { slug: 'Bad Slug', description: 'x' }, ...many], models: ['gpt-5', 'opus', 'opus', 'Sonnet', 'haiku', 42] })
  const questions = JSON.parse(calls.at(-1).options.body).questions
  assert.equal(Object.keys(questions.owner.criteria).length, 16)
  assert.ok(!Object.keys(questions.owner.criteria).some((slug) => slug.includes('/') || slug.includes(' ')))
  assert.ok(Object.values(questions.owner.criteria).every((words) => words.length <= 200))
  assert.deepEqual(Object.keys(questions.model.criteria), ['opus', 'haiku'], 'a tier the board does not know was offered')
  // Nothing to choose from on one side: that side is not asked, and says so.
  await ask(ON, { title: 'Draft it', agents: AGENTS, models: [] })
  assert.deepEqual(Object.keys(JSON.parse(calls.at(-1).options.body).questions), ['owner'])
  // A tier the board does not know is never a pick, even when Jev is sure of it.
  stubJev(t, picked('content', 0.9, 'gpt-5', 0.99))
  assert.deepEqual((await ask(ON, { title: 'Draft it', agents: AGENTS, models: ['gpt-5', 'sonnet'] })).body.model, { pick: null, why: 'unsure' })
  // No agents to choose from: that side says so, and only the tier is asked.
  const tierOnly = stubJev(t, picked('content', 0.9, 'sonnet', 0.8))
  assert.deepEqual((await ask(ON, { title: 'Draft it', agents: [], models: ['sonnet'] })).body, { agent: { pick: null, why: 'none to choose' }, model: { pick: 'sonnet', odds: 80 } })
  assert.deepEqual(Object.keys(JSON.parse(tierOnly.at(-1).options.body).questions), ['model'])
  const before = tierOnly.length
  assert.deepEqual((await ask(ON, { title: 'Draft it', agents: [], models: [] })).body, NOBODY('none to choose'))
  assert.equal(tierOnly.length, before, 'Jev was asked with nothing to choose from')
})

test('the order\'s words are never written to the logs', async (t) => {
  stubJev(t, () => { throw new Error('down') })
  const written = []
  for (const method of ['log', 'info', 'warn', 'error']) t.mock.method(console, method, (...parts) => written.push(parts.join(' ')))
  await ask(ON)
  assert.ok(!written.some((line) => line.includes('newsletter')), 'the title reached the logs')
})
