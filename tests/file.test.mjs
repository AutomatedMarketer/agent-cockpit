// The Memory viewer's file endpoint. Mostly a security test: it must refuse anything that
// is not a plain, repo-relative text file, because it fetches with the server-side token.
import test from 'node:test'
import assert from 'node:assert/strict'
import handler, { safePath } from '../api/file.js'

// These suites cover the endpoint's data logic, not the view gate - that has its own
// suite in gate.test.mjs. Opting out here keeps every case from carrying a key header.
process.env.PUBLIC_DASHBOARD = 'true'

test('plain vault paths pass', () => {
  assert.equal(safePath('wiki/INDEX.md'), 'wiki/INDEX.md')
  assert.equal(safePath('inbox/2026-08-07/monday-brief.md'), 'inbox/2026-08-07/monday-brief.md')
  assert.equal(safePath('runtimes.yml'), 'runtimes.yml')
  assert.equal(safePath('runs/heartbeat/hermes.json'), 'runs/heartbeat/hermes.json')
})

test('traversal, absolute paths, and dotfiles are refused', () => {
  assert.equal(safePath('../secrets.md'), null)
  assert.equal(safePath('wiki/../../etc/passwd.md'), null)
  assert.equal(safePath('/etc/passwd.md'), null)
  assert.equal(safePath('.env'), null)
  assert.equal(safePath('.claude/agents/research.md'), null)
  assert.equal(safePath('wiki//double.md'), null)
})

test('only readable text extensions are served', () => {
  assert.equal(safePath('script.sh'), null)
  assert.equal(safePath('binary.png'), null)
  assert.equal(safePath('page.html'), null)
  assert.notEqual(safePath('notes.txt'), null)
  assert.notEqual(safePath('workflows/brief.yaml'), null)
})

test('nonsense input never becomes a request', () => {
  assert.equal(safePath(''), null)
  assert.equal(safePath(null), null)
  assert.equal(safePath('a'.repeat(600) + '.md'), null)
  assert.equal(safePath('wiki/<script>.md'), null)
})

function fakeResponse() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(key, value) {
      this.headers[key] = value
    },
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return this
    }
  }
}

async function call(query, files = {}) {
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const match = /\/contents\/(.+?)\?ref=/.exec(String(url))
    const body = match ? files[decodeURI(match[1])] : undefined
    if (body === undefined) return new Response('Not Found', { status: 404 })
    return new Response(body, { status: 200 })
  }
  const previous = { ...process.env }
  Object.assign(process.env, { GITHUB_OWNER: 'someone', GITHUB_REPO: 'my-agent-team' })
  const response = fakeResponse()
  try {
    await handler({ query }, response)
  } finally {
    globalThis.fetch = original
    process.env = previous
  }
  return response
}

test('a real file comes back as text', async () => {
  const response = await call({ path: 'wiki/INDEX.md' }, { 'wiki/INDEX.md': '# Index\n' })
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.content, '# Index\n')
})

test('a rejected path is a 400, and no fetch happens', async () => {
  let fetched = false
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    fetched = true
    return new Response('', { status: 200 })
  }
  const previous = { ...process.env }
  Object.assign(process.env, { GITHUB_OWNER: 'someone', GITHUB_REPO: 'my-agent-team' })
  const response = fakeResponse()
  try {
    await handler({ query: { path: '../.env' } }, response)
  } finally {
    globalThis.fetch = original
    process.env = previous
  }
  assert.equal(response.statusCode, 400)
  assert.equal(fetched, false)
})

test('a missing file is a 404 with a plain message', async () => {
  const response = await call({ path: 'wiki/missing.md' })
  assert.equal(response.statusCode, 404)
})
