// GET /api/graph: the Memory screen's graph - the team repo's own dots and lines, and the vaults each
// computer's collector published - over a stubbed GitHub.
//
// It is asked for only when the Memory screen opens, never with the board, so the 60-second Readiness
// check stays one call. It reads every note (up to a cap), which costs a call per note, so a second open
// with nothing new answers from one call, as /api/state does. Behind the same gate, kept by nobody.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import handler from '../api/graph.js'
import { TEAM_CAPS } from '../api/_team-graph.js'
import { VAULTS_FOLDER, VAULTS_MAX_BYTES } from '../api/_vaults.js'

const SHA = 'a'.repeat(40)
const NEWER = 'b'.repeat(40)
const vaultsFixture = JSON.parse(readFileSync(new URL('./fixtures/vaults-parity.json', import.meta.url), 'utf8'))
const VAULT_SAMPLE = JSON.stringify({ ...vaultsFixture.sample, takenAt: new Date(Date.now() - 3600_000).toISOString().replace(/\.\d+Z$/, 'Z') })

const FILES = {
  'CLAUDE.md': '# Team\n\nRead shared/business-brain.md before anything else.\n',
  'shared/business-brain.md': '---\ndescription: What we sell.\n---\n# Business brain\n\nRoofing, in the valley.\n',
  'shared/about-me.md': '# About me\n',
  '.claude/agents/sales.md': '---\nname: sales\n---\n',
  'agents/sales/README.md': '# Sales\n',
  'workflows/brief.yml': 'name: Brief\n',
  '.agent-team/onboarding-state.md': '# not a note of the team\n',
  [`${VAULTS_FOLDER}/mac-mini.json`]: VAULT_SAMPLE
}

const treeOf = (files, sizes = {}) => ({
  tree: [
    ...Object.keys(files).map((path) => ({ type: 'blob', path, size: sizes[path] ?? files[path].length })),
    { type: 'tree', path: 'shared' }
  ]
})

// `head` answers the commit question (null: Not Found). `calls` records every request; `delay`
// holds each file read open so the test can count how many run at once.
function stubGitHub({ files = FILES, sizes = {}, head = SHA, calls = [], treeFails, delay = 0, missing = [] } = {}) {
  const original = globalThis.fetch
  const inFlight = { now: 0, most: 0 }
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url)
    calls.push({ url: target, accept: init.headers?.Accept ?? null })
    if (target.includes('/commits/')) {
      if (head === null) return new Response('Not Found', { status: 404 })
      return new Response(head, { status: 200 })
    }
    if (target.includes('/git/trees/')) {
      if (treeFails) return new Response(treeFails.body ?? 'refused', { status: treeFails.status, headers: treeFails.headers ?? {} })
      return new Response(JSON.stringify(treeOf(files, sizes)), { status: 200 })
    }
    const match = /\/contents\/(.+?)\?ref=/.exec(target)
    const path = match ? decodeURI(match[1]) : null
    inFlight.now += 1
    inFlight.most = Math.max(inFlight.most, inFlight.now)
    try {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
      const body = path && !missing.includes(path) ? files[path] : undefined
      return body === undefined ? new Response('Not Found', { status: 404 }) : new Response(body, { status: 200 })
    } finally {
      inFlight.now -= 1
    }
  }
  return { inFlight, restore: () => { globalThis.fetch = original } }
}

function fakeResponse() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(key, value) { this.headers[key] = value },
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this }
  }
}

async function run({ env = {}, request = { headers: {} }, ...options } = {}) {
  const stub = stubGitHub(options)
  const previous = { ...process.env }
  delete process.env.VIEW_KEY
  Object.assign(process.env, { GITHUB_OWNER: 'someone', GITHUB_REPO: 'my-agent-team', PUBLIC_DASHBOARD: 'true', ...env })
  const response = fakeResponse()
  try {
    await handler({ method: 'GET', ...request }, response)
  } finally {
    stub.restore()
    process.env = previous
  }
  return { response, inFlight: stub.inFlight }
}

/* ---------- the gate and the headers ------------------------------------------------------------ */

test('a stranger is refused before GitHub is asked anything, and the refusal is kept by nobody', async () => {
  for (const headers of [{}, { 'x-view-key': 'wrong' }]) {
    const calls = []
    const { response } = await run({ env: { PUBLIC_DASHBOARD: '', VIEW_KEY: 'the-right-key' }, request: { headers }, calls })
    assert.equal(response.statusCode, 401)
    assert.equal(response.headers['Cache-Control'], 'private, no-store')
    assert.deepEqual(calls, [], 'GitHub was asked before the gate')
  }
})

test('the owner\'s key opens it, and the answer is kept by nobody', async () => {
  const { response } = await run({ env: { PUBLIC_DASHBOARD: '', VIEW_KEY: 'the-right-key' }, request: { headers: { 'x-view-key': 'the-right-key' } } })
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['Cache-Control'], 'private, no-store')
})

test('GET only: anything else is answered before the key is looked at', async () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const calls = []
    const { response } = await run({ request: { method, headers: {} }, calls })
    assert.equal(response.statusCode, 405)
    assert.equal(response.headers.Allow, 'GET')
    assert.equal(response.headers['Cache-Control'], 'private, no-store')
    assert.deepEqual(calls, [])
  }
})

/* ---------- one commit, and one call when nothing changed --------------------------------------- */

test('the graph is built from one commit: the tree and every file are read at the head', async () => {
  const calls = []
  const { response } = await run({ calls })
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.commit, SHA)
  const tree = calls.find((call) => call.url.includes('/git/trees/'))
  assert.match(tree.url, new RegExp(`/git/trees/${SHA}\\?recursive=1$`))
  const reads = calls.filter((call) => call.url.includes('/contents/'))
  assert.ok(reads.length > 0)
  for (const read of reads) assert.ok(read.url.endsWith(`?ref=${SHA}`), read.url)
})

test('since = the head: exactly one call to GitHub and a small answer', async () => {
  const calls = []
  const { response } = await run({ calls, request: { headers: {}, query: { since: SHA } } })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.body, { unchanged: true, commit: SHA })
  assert.equal(calls.length, 1)
  assert.equal(response.headers['Cache-Control'], 'private, no-store')
})

test('since read from the address too; an old one, or one that is not a commit id, gets the whole graph', async () => {
  const fromUrl = await run({ request: { headers: {}, url: `/api/graph?since=${SHA}` } })
  assert.equal(fromUrl.response.body.unchanged, true)
  const old = await run({ head: NEWER, request: { headers: {}, query: { since: SHA } } })
  assert.equal(old.response.body.commit, NEWER)
  assert.ok(Array.isArray(old.response.body.team.notes))
  for (const since of ['', 'main', SHA.slice(0, 7), SHA.toUpperCase(), [SHA], 7, null]) {
    const { response } = await run({ request: { headers: {}, query: { since } } })
    assert.equal(response.body.unchanged, undefined, JSON.stringify(since))
  }
})

test('with no commit from GitHub, the graph is read from the branch and never answered "unchanged"', async () => {
  const calls = []
  const { response } = await run({ head: null, calls, request: { headers: {}, query: { since: SHA } } })
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.commit, null)
  assert.equal(response.body.unchanged, undefined)
  assert.match(calls.find((call) => call.url.includes('/git/trees/')).url, /\/git\/trees\/main\?recursive=1$/)
})

/* ---------- what is read ---------------------------------------------------------------------- */

test('the team repo\'s notes become dots and lines; files that are not notes are never read', async () => {
  const calls = []
  const { response } = await run({ calls })
  const { team } = response.body
  assert.deepEqual(team.notes.map((note) => note.path), ['.claude/agents/sales.md', 'agents/sales/README.md', 'CLAUDE.md', 'shared/about-me.md', 'shared/business-brain.md'])
  const index = (path) => team.notes.findIndex((note) => note.path === path)
  assert.deepEqual(team.edges, [[index('CLAUDE.md'), index('shared/business-brain.md'), 1], [index('.claude/agents/sales.md'), index('agents/sales/README.md'), 4]])
  assert.equal(team.lonely, 3)
  const read = calls.filter((call) => call.url.includes('/contents/')).map((call) => decodeURI(/\/contents\/(.+?)\?ref=/.exec(call.url)[1]))
  assert.ok(!read.includes('workflows/brief.yml'))
  assert.ok(!read.includes('.agent-team/onboarding-state.md'))
})

test('at most four hundred notes are read, eight at a time; a note too big to read is counted, never fetched', async () => {
  const files = { ...FILES }
  for (let index = 0; index < TEAM_CAPS.notes + 5; index += 1) files[`inbox/n${String(index).padStart(3, '0')}.md`] = `# Note ${index}\n`
  files['big/one.md'] = '# big\n'
  files['big/two.md'] = '# big\n'
  const calls = []
  const { response, inFlight } = await run({ files, calls, delay: 2, sizes: { 'big/one.md': TEAM_CAPS.bytes + 1, 'big/two.md': 10 * TEAM_CAPS.bytes } })
  const { team } = response.body
  assert.equal(team.notes.length, TEAM_CAPS.notes)
  assert.equal(team.hidden, 2, 'the notes too big to read were not counted')
  // 410 notes small enough to read - the five above and 405 in inbox/ - so ten are past the cap.
  assert.equal(team.more, 10, 'the notes past the cap were not counted')
  const read = calls.filter((call) => call.url.includes('/contents/')).map((call) => decodeURI(/\/contents\/(.+?)\?ref=/.exec(call.url)[1]))
  assert.ok(!read.includes('big/one.md') && !read.includes('big/two.md'), 'a note over the size limit was fetched')
  assert.equal(read.filter((path) => path.endsWith('.md')).length, TEAM_CAPS.notes)
  assert.ok(inFlight.most <= 8, `${inFlight.most} reads ran at once`)
  assert.ok(inFlight.most >= 2, 'the reads ran one at a time')
})

test('a note GitHub would not return is still a dot, with no lines, and it is counted', async () => {
  const { response } = await run({ missing: ['shared/business-brain.md'] })
  const { team } = response.body
  assert.ok(team.notes.some((note) => note.path === 'shared/business-brain.md'))
  assert.equal(team.unread, 1)
})

test('each computer\'s vaults file is read and shaped; one the tree calls too big is never fetched', async () => {
  const { response } = await run()
  assert.equal(response.body.vaults.status, 'ok')
  assert.deepEqual(response.body.vaults.computers[0].vaults.items.map((vault) => vault.name), ['Field Notes', 'Ideas'])
  const calls = []
  const big = await run({ calls, sizes: { [`${VAULTS_FOLDER}/mac-mini.json`]: VAULTS_MAX_BYTES + 1 } })
  assert.ok(!calls.some((call) => call.url.includes(VAULTS_FOLDER)), 'a vaults file over the limit was fetched')
  assert.equal(big.response.body.vaults.status, 'unusable')
  const none = await run({ files: Object.fromEntries(Object.entries(FILES).filter(([path]) => !path.startsWith(VAULTS_FOLDER))) })
  assert.equal(none.response.body.vaults.status, 'none')
})

test('no word of a note reaches the page beyond the few search may use', async () => {
  const secret = 'the alarm code is 4821'
  const files = { ...FILES, 'shared/about-me.md': `# About me\n\n${'Plain words. '.repeat(20)}\n\n${secret}\n` }
  const { response } = await run({ files })
  assert.ok(!JSON.stringify(response.body).includes(secret))
})

/* ---------- when GitHub says no ----------------------------------------------------------------- */

test('GitHub\'s rate limit is passed on as a 429 with a Retry-After, kept by nobody', async () => {
  for (const headers of [{ 'retry-after': '120' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 120) }]) {
    const { response } = await run({ treeFails: { status: 403, headers } })
    assert.equal(response.statusCode, 429)
    assert.ok(Number(response.headers['Retry-After']) >= 119, response.headers['Retry-After'])
    assert.match(response.body.error, /rate limit/i)
    assert.equal(response.headers['Cache-Control'], 'private, no-store')
  }
})

test('GitHub\'s own words never reach the page: the board says what went wrong in its own', async () => {
  const { response } = await run({ treeFails: { status: 500, body: 'token ghp_x lacks scope repo:private' } })
  assert.equal(response.statusCode, 500)
  assert.ok(!JSON.stringify(response.body).includes('ghp_x'))
  assert.match(response.body.error, /GitHub returned 500/)
})

test('a failure that is not GitHub saying no is still told in the board\'s own words', async () => {
  // A tree that is not JSON: the parser's own message never reaches the page.
  const { response } = await run({ treeFails: { status: 200, body: '<html>Unexpected maintenance page</html>' } })
  assert.equal(response.statusCode, 500)
  assert.equal(response.body.error, 'Something went wrong reading your team repo, so try again in a minute.')
})

test('a board with no repo named says how to fix it', async () => {
  const stub = stubGitHub()
  const previous = { ...process.env }
  delete process.env.GITHUB_OWNER
  delete process.env.GITHUB_REPO
  process.env.PUBLIC_DASHBOARD = 'true'
  const response = fakeResponse()
  try {
    await handler({ method: 'GET', headers: {} }, response)
  } finally {
    stub.restore()
    process.env = previous
  }
  assert.equal(response.statusCode, 500)
  assert.match(response.body.error, /GITHUB_OWNER and GITHUB_REPO/)
})
