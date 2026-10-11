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
    'script-src': ["'self'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'connect-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-ancestors': ["'none'"]
  })
})

test('no script runs unless it is a file on this site: no inline script at all (audit finding #4)', () => {
  // With 'unsafe-inline', any slip that let markup into the page could run script there - and read
  // whatever the page can. The board's script is its own file, /app.js, so nothing inline is needed.
  assert.deepEqual(policy()['script-src'], ["'self'"])
  const page = readFileSync(new URL('public/index.html', ROOT), 'utf8')
  const tags = [...page.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
  assert.equal(tags.length, 1, 'the page has more than one script tag')
  assert.match(tags[0][0], /^<script src="\/app\.js"><\/script>$/, 'the one script tag is not /app.js')
  assert.equal(tags[0][1], '', 'the script tag has inline code in it')
  assert.ok(existsSync(fileURLToPath(new URL('public/app.js', ROOT))), 'public/app.js is missing')
})

test('no inline event handler anywhere: not in the page, not in markup the script writes', () => {
  // An on...= attribute is inline script; the policy blocks it, so a button wired that way would
  // silently do nothing. The script attaches every listener with addEventListener instead.
  const page = readFileSync(new URL('public/index.html', ROOT), 'utf8')
  const script = readFileSync(new URL('public/app.js', ROOT), 'utf8')
  // Memory's graph view, the second file the page loads (only when Graph opens), is held to the same.
  const graphView = readFileSync(new URL('public/memory-graph.js', ROOT), 'utf8')
  for (const [name, text] of [['index.html', page], ['app.js', script], ['memory-graph.js', graphView]]) {
    const found = text.match(/<[a-z][^>]*\son[a-z]+\s*=/i)
    assert.equal(found, null, `${name} has an inline handler: ${found?.[0]}`)
    assert.doesNotMatch(text, /javascript:/i, `${name} has a javascript: address`)
  }
})

test('plugins and embedded objects are refused outright', () => {
  // default-src 'self' already covers <object> and <embed>, but only while it stays 'self': this
  // says it on its own line, so a later widening of default-src does not let them in.
  assert.deepEqual(policy()['object-src'], ["'none'"])
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
  const page = readFileSync(new URL('public/index.html', ROOT), 'utf8') + readFileSync(new URL('public/app.js', ROOT), 'utf8') +
    readFileSync(new URL('public/memory-graph.js', ROOT), 'utf8')
  assert.doesNotMatch(page, /api\.openai\.com|api\.fish\.audio|wss:\/\//, 'the page addresses OpenAI or Fish itself')
  assert.doesNotMatch(page, /\bek_|client_secrets/, 'the page asks for an ephemeral key')
  for (const path of ['/api/voice-session', '/api/speak', '/api/voice-meter']) {
    assert.ok(page.includes(`'${path}'`), `the page does not reach ${path} on its own site`)
  }
  // Nothing voice needs runs longer than the default, so vercel.json is untouched by voice.
  assert.deepEqual(Object.keys(config.functions ?? {}), ['api/generate.js', 'api/memory-index.js'])
})

test('the other security headers are unchanged', () => {
  const headers = headersFor('/(.*)')
  assert.equal(headers['X-Content-Type-Options'], 'nosniff')
  assert.equal(headers['X-Frame-Options'], 'DENY')
  assert.equal(headers['Referrer-Policy'], 'strict-origin-when-cross-origin')
})

// Audit finding #8 (2026-10-10): defence in depth the board was missing.
function permissions() {
  const value = headersFor('/(.*)')['Permissions-Policy']
  assert.ok(value, 'there is no Permissions-Policy')
  const features = {}
  for (const part of value.split(',').map((piece) => piece.trim()).filter(Boolean)) {
    const found = /^([a-z-]+)=\(([^)]*)\)$/.exec(part)
    assert.ok(found, `"${part}" is not a feature=(allowlist) pair`)
    assert.equal(features[found[1]], undefined, `${found[1]} is given twice`)
    features[found[1]] = found[2].trim()
  }
  return features
}

test('the microphone is for this site only, and the camera and location are off for everyone', () => {
  const features = permissions()
  // Talking to the board needs the microphone on its own page, and nowhere else: not in a frame,
  // not from another site.
  assert.equal(features.microphone, 'self')
  assert.equal(features.camera, '')
  assert.equal(features.geolocation, '')
})

test('another site opened from the board cannot reach back into it', () => {
  // same-origin: a page this board opens (a GitHub link, a Claude session) gets no handle on the
  // board's window, and a page that opens the board gets none either.
  assert.equal(headersFor('/(.*)')['Cross-Origin-Opener-Policy'], 'same-origin')
})

test('making a picture gets 60 seconds, and gives up on OpenAI before the platform gives up on it', () => {
  // gpt-image models can take tens of seconds. The function stops waiting at its own timeout so
  // the person sees our sentence, not the platform's timeout page - which only works if that
  // timeout is shorter than maxDuration.
  assert.deepEqual(Object.keys(config.functions ?? {}), ['api/generate.js', 'api/memory-index.js'],
    'only picture-making and learning notes by meaning need longer than the default')
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
