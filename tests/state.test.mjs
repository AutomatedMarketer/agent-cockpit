// End-to-end over a stubbed GitHub. Proves the page can render a team repo without a
// network, a token, or a live account.
import test from 'node:test'
import assert from 'node:assert/strict'
import handler from '../api/state.js'

const TREE = {
  tree: [
    { type: 'blob', path: '.claude/agents/research.md' },
    { type: 'blob', path: '.claude/agents/email.md' },
    { type: 'blob', path: 'runs/2026-08/2026-08-07T0600Z-research.json' },
    { type: 'blob', path: 'runs/2026-08/2026-08-07T0700Z-research.json' },
    { type: 'blob', path: 'runs/2026-08/broken.json' },
    { type: 'blob', path: 'shared/about-me.md' },
    { type: 'blob', path: 'shared/business-brain.md' },
    { type: 'blob', path: 'shared/writing-rules.md' },
    { type: 'tree', path: 'agents' },
    { type: 'blob', path: 'README.md' }
  ]
}

// Relative, so the fixture stays correct whatever day the suite runs on.
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString().replace(/\.\d+Z$/, 'Z')
const recent = isoAgo(3600_000)
const older = isoAgo(20 * 86400_000)

const FILES = {
  '.claude/agents/research.md':
    '---\nname: research\ndescription: Looks something up and comes back with links.\nmodel: sonnet\n---\n\n# Research\n',
  '.claude/agents/email.md':
    '---\nname: email\ndescription: Sweeps your inbox and drafts replies.\nmodel: sonnet\n---\n\n# Email\n',
  'runs/2026-08/2026-08-07T0600Z-research.json': JSON.stringify({
    schema: 'run-log/v1',
    run_id: '2026-08-07T0600Z-research',
    agent: 'research',
    model: 'sonnet',
    trigger: 'schedule',
    started_at: older,
    status: 'ok',
    summary: 'An older run that should sort second.',
    artifacts: ['agents/research/output/old.md'],
    session_url: 'https://claude.ai/code/session_old'
  }),
  'runs/2026-08/2026-08-07T0700Z-research.json': JSON.stringify({
    schema: 'run-log/v1',
    run_id: '2026-08-07T0700Z-research',
    agent: 'research',
    model: 'sonnet',
    trigger: 'schedule',
    started_at: recent,
    status: 'ok',
    summary: 'The newest run, which should sort first and mark the agent as working.',
    artifacts: ['agents/research/output/new.md'],
    session_url: 'https://claude.ai/code/session_new'
  }),
  'runs/2026-08/broken.json': '{ not json',
  'shared/about-me.md': '# About me\n<!-- fill: full-name -->\n',
  'shared/business-brain.md': '# Business brain\n\nAll filled in.\n',
  'shared/writing-rules.md': '# Writing rules\n<!-- fill: voice-samples -->\n<!-- fill: default-cta -->\n'
}

function stubGitHub() {
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('/git/trees/')) {
      return new Response(JSON.stringify(TREE), { status: 200 })
    }
    const match = /\/contents\/(.+?)\?ref=/.exec(target)
    const body = match ? FILES[decodeURI(match[1])] : undefined
    if (body === undefined) return new Response('Not Found', { status: 404 })
    return new Response(body, { status: 200 })
  }
  return () => {
    globalThis.fetch = original
  }
}

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

async function run(env = {}) {
  const restore = stubGitHub()
  const previous = { ...process.env }
  Object.assign(process.env, { GITHUB_OWNER: 'someone', GITHUB_REPO: 'my-agent-team', ...env })
  const response = fakeResponse()
  try {
    await handler({}, response)
  } finally {
    restore()
    process.env = previous
  }
  return response
}

test('missing configuration explains itself instead of failing silently', async () => {
  const restore = stubGitHub()
  const previous = { ...process.env }
  delete process.env.GITHUB_OWNER
  delete process.env.GITHUB_REPO
  const response = fakeResponse()
  try {
    await handler({}, response)
  } finally {
    restore()
    process.env = previous
  }
  assert.equal(response.statusCode, 500)
  assert.match(response.body.error, /GITHUB_OWNER and GITHUB_REPO/)
})

test('agents come back with their model and a state', async () => {
  const { body } = await run()
  assert.deepEqual(
    body.agents.map((agent) => agent.slug),
    ['email', 'research']
  )
  const research = body.agents.find((agent) => agent.slug === 'research')
  assert.equal(research.model, 'sonnet')
  assert.equal(research.state, 'working')
  assert.equal(research.totalRuns, 2)
  const email = body.agents.find((agent) => agent.slug === 'email')
  assert.equal(email.state, 'never-run', 'an agent with no run logs has never run')
})

test('runs are newest first and keep their session link', async () => {
  const { body } = await run()
  assert.equal(body.runs[0].run_id, '2026-08-07T0700Z-research')
  assert.equal(body.runs[0].session_url, 'https://claude.ai/code/session_new')
  assert.equal(body.totalRuns, 2)
})

test('an unparseable run log is reported, not swallowed', async () => {
  const { body } = await run()
  assert.deepEqual(body.unparseableRuns, ['runs/2026-08/broken.json'])
})

test('empty business-brain fields come back by name', async () => {
  const { body } = await run()
  const byPath = Object.fromEntries(body.brain.map((file) => [file.path, file]))
  assert.deepEqual(byPath['shared/about-me.md'].missing, ['full-name'])
  assert.deepEqual(byPath['shared/business-brain.md'].missing, [])
  assert.deepEqual(byPath['shared/writing-rules.md'].missing, ['voice-samples', 'default-cta'])
})

test('the payload never contains the token', async () => {
  const { body } = await run({ GITHUB_TOKEN: 'ghp_thisMustNeverLeaveTheServer' })
  assert.doesNotMatch(JSON.stringify(body), /ghp_/)
})
