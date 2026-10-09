// vercel.json: the security headers every response carries, and the one function that needs
// more time than the default.
//
// The Content-Security-Policy is pinned whole, directive by directive, so it can only change
// on purpose. Personalising added exactly one thing: `blob:` in img-src, because a picture from
// the private store is fetched with the view key and shown from memory as a blob: URL - an
// <img> cannot send the key itself. Nothing from outside the site was added: connect-src is
// still 'self', so the page cannot talk to the store, OpenAI or anything else directly.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = new URL('../', import.meta.url)
const config = JSON.parse(readFileSync(new URL('vercel.json', ROOT), 'utf8'))

function headersFor(source) {
  const block = (config.headers ?? []).find((entry) => entry.source === source)
  assert.ok(block, `vercel.json has no headers for ${source}`)
  return Object.fromEntries(block.headers.map(({ key, value }) => [key, value]))
}

function policy() {
  const value = headersFor('/(.*)')['Content-Security-Policy']
  assert.ok(value, 'there is no Content-Security-Policy')
  const directives = {}
  for (const part of value.split(';').map((piece) => piece.trim()).filter(Boolean)) {
    const [name, ...sources] = part.split(/\s+/)
    assert.equal(directives[name], undefined, `${name} is given twice; browsers use only the first`)
    directives[name] = sources
  }
  return directives
}

test('the policy is exactly this one: every directive, every source', () => {
  assert.deepEqual(policy(), {
    'default-src': ["'self'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'script-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'connect-src': ["'self'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-ancestors': ["'none'"]
  })
})

test('pictures may come from memory, and still from nowhere outside the site', () => {
  const images = policy()['img-src']
  assert.ok(images.includes('blob:'), 'without blob: a picture from the private store cannot be shown')
  for (const source of images) {
    assert.doesNotMatch(source, /^(?:\*|https?:|https?:\/\/|\*\.)/, `${source} lets pictures load from other sites`)
  }
})

test('the page can still only talk to its own site', () => {
  // The store and OpenAI are reached by the board's own functions, never by a request from the
  // page. (The voice call's sound is WebRTC, which connect-src does not govern - see below.)
  assert.deepEqual(policy()['connect-src'], ["'self'"])
})

test('talking to the board needed no change to the policy, and the page still requests nothing from another site', () => {
  // The call is started by /api/voice-session, on this site, which adds the key; after that the
  // sound and the events go between the browser and OpenAI over WebRTC, which connect-src does not
  // govern (proved in a real browser on a preview, not here). OpenAI's voice plays from the call's
  // own track (srcObject) and Fish's from decoded bytes: neither loads an address, so neither needs
  // media-src, and nothing needs an ephemeral key on the page.
  const directives = policy()
  assert.deepEqual(directives['connect-src'], ["'self'"])
  assert.equal(directives['media-src'], undefined, 'a media source was added for voice')
  for (const sources of Object.values(directives)) {
    for (const source of sources) assert.doesNotMatch(source, /openai|fish\.audio|wss:/i, `${source} was let into the policy`)
  }
  const page = readFileSync(new URL('public/index.html', ROOT), 'utf8')
  assert.doesNotMatch(page, /api\.openai\.com|api\.fish\.audio|wss:\/\//, 'the page addresses OpenAI or Fish itself')
  assert.doesNotMatch(page, /\bek_|client_secrets/, 'the page asks for an ephemeral key')
  for (const path of ['/api/voice-session', '/api/speak', '/api/voice-meter']) {
    assert.ok(page.includes(`'${path}'`), `the page does not reach ${path} on its own site`)
  }
  // Nothing new needs longer than the default to run, so vercel.json is untouched by voice.
  assert.deepEqual(Object.keys(config.functions ?? {}), ['api/generate.js'])
})

test('the other security headers are unchanged', () => {
  const headers = headersFor('/(.*)')
  assert.equal(headers['X-Content-Type-Options'], 'nosniff')
  assert.equal(headers['X-Frame-Options'], 'DENY')
  assert.equal(headers['Referrer-Policy'], 'strict-origin-when-cross-origin')
})

test('making a picture gets 60 seconds, and gives up on OpenAI before the platform gives up on it', () => {
  // gpt-image models can take tens of seconds. The function stops waiting at its own timeout so
  // the person sees our sentence, not the platform's timeout page - which only works if that
  // timeout is shorter than maxDuration.
  assert.deepEqual(Object.keys(config.functions ?? {}), ['api/generate.js'],
    'only the picture-making function needs longer than the default')
  const { maxDuration } = config.functions['api/generate.js']
  assert.equal(maxDuration, 60)
  assert.ok(existsSync(fileURLToPath(new URL('api/generate.js', ROOT))), 'vercel.json configures a function that does not exist')

  const source = readFileSync(new URL('api/generate.js', ROOT), 'utf8')
  // The budget is for the whole request; OpenAI gets what is left of it (tests/generate.test.mjs
  // proves that by effect), so the budget is what must sit inside maxDuration.
  const found = /const HANDLER_BUDGET_MS = ([\d_]+)/.exec(source)
  assert.ok(found, 'api/generate.js no longer states its time budget as HANDLER_BUDGET_MS')
  const timeout = Number(found[1].replaceAll('_', ''))
  assert.ok(timeout < maxDuration * 1000, `a ${timeout} ms timeout never fires inside a ${maxDuration} s function`)
  assert.ok(timeout >= (maxDuration - 10) * 1000, 'the timeout gives OpenAI much less time than the function has')
})
