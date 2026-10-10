// Every answer from every endpoint is kept by nobody but the browser that asked, and not even there.
// A shared cache (Vercel's CDN) keys what it keeps on the address, not on who asked, so a copy made
// for the owner would be handed to anyone: that is the leak ce0101e closed for /api/state on
// 2026-10-09. Some endpoints said only 'no-store', and some said nothing at all on a 405 or a
// refusal. Now each says 'private, no-store' on every answer, refusals and wrong methods included.
//
// The endpoints are found by listing api/, so one added later is held to this without anybody
// remembering to add it here. The one deliberate exception is a stored picture from /api/art, which
// never changes under its address and is kept by the browser only ('private'); it needs the key, so
// it is never reached below.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join } from 'node:path'

const API = fileURLToPath(new URL('../api/', import.meta.url))
const endpoints = readdirSync(API).filter((name) => name.endsWith('.js') && !name.startsWith('_'))

function fakeResponse() {
  return {
    statusCode: null,
    headers: {},
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; return this },
    getHeader(key) { return this.headers[key.toLowerCase()] },
    status(code) { this.statusCode = code; return this },
    json() { return this },
    send() { return this },
    end() { return this }
  }
}

const CASES = [
  ['GET', {}],
  ['POST', { 'content-type': 'application/json' }],
  ['POST', { 'content-type': 'text/plain' }],
  ['PUT', {}],
  ['DELETE', {}]
]

test('every endpoint answers private, no-store - to a stranger, to a wrong method, to anything', async () => {
  assert.ok(endpoints.includes('state.js') && endpoints.includes('fire.js'), 'api/ was not read')
  const previous = { ...process.env }
  for (const name of ['PUBLIC_DASHBOARD', 'EDIT_KEY', 'BLOB_STORE_ID', 'BLOB_READ_WRITE_TOKEN', 'OPENAI_API_KEY', 'FISH_API_KEY', 'PUBLIC_FIRE']) {
    delete process.env[name]
  }
  Object.assign(process.env, {
    VIEW_KEY: 'a-long-enough-view-key',
    GITHUB_OWNER: 'someone',
    GITHUB_REPO: 'my-agent-team',
    FIRE_KEY: 'fk_fake',
    FIRE_TRIGGERS: '{"monday-brief":"https://triggers.example/x"}'
  })
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('a stranger made the board call out') }
  const wrong = []
  try {
    for (const name of endpoints) {
      const handler = (await import(pathToFileURL(join(API, name)).href)).default
      for (const [method, headers] of CASES) {
        const response = fakeResponse()
        await handler({ method, headers, query: { path: 'README.md', slot: 'team', v: 'abcdefgh1234', t: 'webp' }, body: {} }, response)
        if (response.headers['cache-control'] !== 'private, no-store') {
          wrong.push(`api/${name} ${method} (${headers['content-type'] ?? 'no type'}) answered ${response.statusCode} with Cache-Control ${response.headers['cache-control']}`)
        }
      }
    }
  } finally {
    globalThis.fetch = realFetch
    process.env = previous
  }
  assert.deepEqual(wrong, [])
})
