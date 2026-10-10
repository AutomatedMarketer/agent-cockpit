// /api/route-task: Jev, on OpenRouter, suggests which agent should do a task the owner asked for by
// voice (Nuno's D2, 2026-10-10). Off unless JEV_ROUTING is on AND an OpenRouter key is set; with it
// off, the orchestrator routes the card on its sweep, as the Add task button does. With it on, the
// order's words go to OpenRouter, which the README says where the switch is.
//
// OpenRouter is stubbed through globalThis.fetch; nothing reaches the network. What these hold it
// to: the write gate before anything is read or sent; the key in one header to one address; only a
// slug it was sent, at 0.6 sure or more, ever comes back; anything else - off, a timeout, an error,
// a vendor's words - is { for: null }; and no answer is kept by a shared cache.

import test from 'node:test'
import assert from 'node:assert/strict'
import { makeHandler, JEV_URL, JEV_MODEL } from '../api/route-task.js'
import { STORE_ENV, asTheBoard, call } from './helpers/personalise-harness.mjs'

const KEY = ['or', 'test', 'routingKeyThatStaysOnTheServer'].join('-')
const ON = { ...STORE_ENV, JEV_ROUTING: 'on', OPENROUTER_API_KEY: KEY }
const JSON_TYPE = { 'content-type': 'application/json' }
const AGENTS = [{ slug: 'research', description: 'Finds things out and writes it up.' }, { slug: 'content', description: 'Writes the newsletter and posts.' }]
const ASK = { title: 'Draft this week\'s newsletter', details: 'Use the Monday notes.', agents: AGENTS }

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
const picked = (choice, confidence) => () => new Response(JSON.stringify({ answers: { owner: { choice, confidence } } }), { status: 200, headers: { 'content-type': 'application/json' } })
const ask = (env, body = ASK, headers = asTheBoard(JSON_TYPE), method = 'POST') =>
  call(makeHandler({ env, timeoutMs: 50 }), { method, headers, body })
const noCache = (response, label) => assert.equal(response.headers['Cache-Control'], 'private, no-store', `${label}: not private, no-store`)

test('with the switch off, or no OpenRouter key, nothing is sent anywhere and the orchestrator routes', async (t) => {
  const calls = stubJev(t, picked('content', 0.9))
  for (const env of [STORE_ENV, { ...STORE_ENV, JEV_ROUTING: 'on' }, { ...STORE_ENV, OPENROUTER_API_KEY: KEY }, { ...ON, JEV_ROUTING: 'off' }]) {
    const response = await ask(env)
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.body, { for: null })
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

test('Jev is asked one choice over exactly the agents sent, with the key in one header to one address', async (t) => {
  const calls = stubJev(t, picked('content', 0.84))
  const response = await ask(ON)
  assert.equal(response.statusCode, 200)
  noCache(response, 'a pick')
  assert.deepEqual(response.body, { for: 'content', confidence: 0.84 })
  assert.equal(calls.length, 1)
  const [sent] = calls
  assert.equal(sent.url, JEV_URL)
  assert.equal(JEV_URL, 'https://openrouter.ai/api/alpha/decisions')
  assert.equal(sent.options.method, 'POST')
  assert.deepEqual(Object.keys(sent.options.headers).sort(), ['Authorization', 'Content-Type'])
  assert.equal(sent.options.headers.Authorization, `Bearer ${KEY}`)
  assert.ok(sent.options.signal instanceof AbortSignal, 'a call to OpenRouter must be able to time out')
  const body = JSON.parse(sent.options.body)
  assert.equal(body.model, JEV_MODEL)
  assert.equal(body.questions.owner.type, 'choice')
  assert.deepEqual(Object.keys(body.questions.owner.criteria), ['research', 'content'])
  assert.equal(body.state.task, 'Draft this week\'s newsletter')
  assert.equal(body.state.details, 'Use the Monday notes.')
  assert.ok(!JSON.stringify(response.body).includes(KEY))
})

test('only a slug it was sent, at 0.6 sure or more, comes back - a timeout, an error or the vendor\'s words never do', async (t) => {
  const cases = [
    ['a slug it was not sent', picked('sales', 0.99)],
    ['59% sure', picked('content', 0.59)],
    ['no confidence', picked('content', undefined)],
    ['a server error', () => new Response('internal: Jev saw <your task>', { status: 500 })],
    ['an error status, whatever its body says', () => new Response(JSON.stringify({ answers: { owner: { choice: 'content', confidence: 0.9 } } }), { status: 502 })],
    ['words, not JSON', () => new Response('I think content should do it', { status: 200 })],
    ['a refusal with words', () => new Response(JSON.stringify({ error: { message: 'Leaked vendor words' } }), { status: 400 })],
    ['no answer in time', (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))))],
    ['the network failing', () => { throw new Error('ECONNRESET Leaked vendor words') }]
  ]
  for (const [what, answer] of cases) {
    stubJev(t, answer)
    const response = await ask(ON)
    assert.equal(response.statusCode, 200, what)
    assert.deepEqual(response.body, { for: null }, what)
    assert.ok(!JSON.stringify(response.body).includes('Leaked'), `${what}: the vendor's words were relayed`)
    noCache(response, what)
  }
  stubJev(t, picked('research', 0.6))
  assert.deepEqual((await ask(ON)).body, { for: 'research', confidence: 0.6 })
})

test('what is sent is checked and capped first: a plain title, short details, at most 16 agents with real slugs', async (t) => {
  const calls = stubJev(t, picked('agent-1', 0.9))
  for (const title of ['', 'ab', 'x'.repeat(201), 'two\nlines', 42]) {
    const response = await ask(ON, { ...ASK, title })
    assert.equal(response.statusCode, 400, JSON.stringify(title))
    noCache(response, 'a bad title')
  }
  assert.equal(calls.length, 0, 'a bad request reached OpenRouter')
  const many = Array.from({ length: 30 }, (unused, n) => ({ slug: `agent-${n}`, description: 'd'.repeat(500) }))
  await ask(ON, { title: 'Draft it', agents: [{ slug: '../escape', description: 'x' }, { slug: 'Bad Slug', description: 'x' }, ...many] })
  const criteria = JSON.parse(calls.at(-1).options.body).questions.owner.criteria
  assert.equal(Object.keys(criteria).length, 16)
  assert.ok(!Object.keys(criteria).some((slug) => slug.includes('/') || slug.includes(' ')))
  assert.ok(Object.values(criteria).every((words) => words.length <= 200))
  // No agents to choose from: nothing to ask.
  const before = calls.length
  assert.deepEqual((await ask(ON, { title: 'Draft it', agents: [] })).body, { for: null })
  assert.equal(calls.length, before)
})

test('the order\'s words are never written to the logs', async (t) => {
  stubJev(t, () => { throw new Error('down') })
  const written = []
  for (const method of ['log', 'info', 'warn', 'error']) t.mock.method(console, method, (...parts) => written.push(parts.join(' ')))
  await ask(ON)
  assert.ok(!written.some((line) => line.includes('newsletter')), 'the title reached the logs')
})
