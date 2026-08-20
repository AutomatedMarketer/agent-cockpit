// The fire endpoint, end to end over a stubbed fetch — same pattern as state.test.mjs.
// Every error path is also checked for secret leakage: FIRE_KEY, the trigger URLs inside
// FIRE_TRIGGERS, and GITHUB_TOKEN must never appear in any response.
import test from 'node:test'
import assert from 'node:assert/strict'
import handler, {
  isValidSlug,
  keysMatch,
  parseTriggers,
  dispatchPayload,
  sessionUrlFrom
} from '../api/fire.js'

const FIRE_KEY = 'fk_correctHorseBatteryStaple'
const GITHUB_TOKEN = 'ghp_thisMustNeverLeaveTheServer'
const TRIGGER_URL = 'https://triggers.example/hooks/abc123SuperSecretPath'
const TRIGGERS = JSON.stringify({
  'monday-brief': TRIGGER_URL,
  'ghost-flow': 'https://triggers.example/hooks/ghost',
  'no-fire': 'https://triggers.example/hooks/nofire'
})

// Workflow files the stubbed GitHub serves. ghost-flow is in the map but not the repo.
const FILES = {
  'workflows/monday-brief.yml':
    'name: Monday Brief\nowner: research\nsteps: [pull-calendar, write-brief]\ntrigger:\n  schedule: "weekly mon 06:00"\n  fire: true\noutput: inbox/{date}/monday-brief.md\n',
  'workflows/no-fire.yml':
    'name: No Fire\nowner: research\nsteps: [write-brief]\ntrigger:\n  schedule: "daily 06:00"\noutput: inbox/{date}/no-fire.md\n'
}

// Stub both upstreams: GitHub contents reads and the trigger POST. Records trigger calls
// so the happy paths can assert exactly what was dispatched.
function stubFetch({ trigger = { status: 200, body: '{}' } } = {}) {
  const original = globalThis.fetch
  const calls = { trigger: [] }
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url)
    if (target.startsWith('https://api.github.com')) {
      const match = /\/contents\/(.+?)\?ref=/.exec(target)
      const body = match ? FILES[decodeURI(match[1])] : undefined
      if (body === undefined) return new Response('Not Found', { status: 404 })
      return new Response(body, { status: 200 })
    }
    calls.trigger.push({ url: target, options })
    if (trigger.reject) throw new Error('boom')
    return new Response(trigger.body, { status: trigger.status })
  }
  return { calls, restore: () => (globalThis.fetch = original) }
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

const BASE_ENV = {
  GITHUB_OWNER: 'someone',
  GITHUB_REPO: 'my-agent-team',
  GITHUB_TOKEN,
  FIRE_KEY,
  FIRE_TRIGGERS: TRIGGERS
}

async function fire(request, { env = {}, unset = [], trigger } = {}) {
  const stub = stubFetch({ trigger })
  const previous = { ...process.env }
  Object.assign(process.env, BASE_ENV, env)
  for (const name of unset) delete process.env[name]
  const response = fakeResponse()
  try {
    await handler(
      { method: 'POST', headers: {}, body: {}, ...request },
      response
    )
  } finally {
    stub.restore()
    process.env = previous
  }
  return { response, calls: stub.calls }
}

const withKey = (body, key = FIRE_KEY) => ({ headers: { 'x-fire-key': key }, body })

// The one assertion that runs on everything: no secret ever leaves the server.
function assertNoSecrets(response) {
  const text = JSON.stringify(response.body) + JSON.stringify(response.headers)
  assert.doesNotMatch(text, /fk_/, 'FIRE_KEY leaked')
  assert.doesNotMatch(text, /ghp_/, 'GITHUB_TOKEN leaked')
  assert.ok(!text.includes('triggers.example'), 'a trigger URL leaked')
  assert.ok(!text.includes('SuperSecretPath'), 'a trigger URL path leaked')
}

// --- pure helpers -------------------------------------------------------------------------

test('slug shape: kebab-case only, before any lookup', () => {
  assert.ok(isValidSlug('monday-brief'))
  assert.ok(isValidSlug('a'))
  for (const bad of ['Monday-Brief', 'monday brief', '../etc', 'monday_brief', '-lead', 'lead-', '', 42, null, 'a'.repeat(101)]) {
    assert.equal(isValidSlug(bad), false, `"${bad}" should be rejected`)
  }
})

test('key comparison rejects wrong, empty, and missing keys', () => {
  assert.ok(keysMatch(FIRE_KEY, FIRE_KEY))
  assert.equal(keysMatch('wrong', FIRE_KEY), false)
  assert.equal(keysMatch('', FIRE_KEY), false)
  assert.equal(keysMatch(undefined, FIRE_KEY), false)
  assert.equal(keysMatch('', ''), false, 'an empty configured key never matches')
})

test('FIRE_TRIGGERS must be a JSON object — anything else means unconfigured', () => {
  assert.deepEqual(parseTriggers('{"a-b": "https://x"}'), { 'a-b': 'https://x' })
  for (const bad of [undefined, '', 'not json', '[]', '"str"', '42']) {
    assert.equal(parseTriggers(bad), null)
  }
})

test('the pause payload tells the agent to make the edit, not the dashboard', () => {
  const payload = dispatchPayload('monday-brief', 'pause')
  assert.equal(payload.action, 'pause')
  assert.match(payload.instruction, /workflows\/monday-brief\.yml/)
  assert.match(payload.instruction, /you, the agent session, make the edit/i)
  assert.deepEqual(dispatchPayload('monday-brief', 'run'), {
    source: 'agent-cockpit',
    action: 'run',
    workflow: 'monday-brief'
  })
})

test('session URLs are accepted under their real names, https only', () => {
  assert.equal(sessionUrlFrom({ session_url: 'https://claude.ai/code/s1' }), 'https://claude.ai/code/s1')
  assert.equal(sessionUrlFrom({ sessionUrl: 'https://claude.ai/code/s2' }), 'https://claude.ai/code/s2')
  assert.equal(sessionUrlFrom({ url: 'http://insecure.example' }), null)
  assert.equal(sessionUrlFrom({}), null)
  assert.equal(sessionUrlFrom(null), null)
})

test('session URL host allowlist survives suffix and userinfo confusion', () => {
  assert.equal(sessionUrlFrom({ url: 'https://a.claude.ai/code/s3' }), 'https://a.claude.ai/code/s3')
  assert.equal(sessionUrlFrom({ url: 'https://claude.ai.evil.com/phish' }), null)
  assert.equal(sessionUrlFrom({ url: 'https://notclaude.ai/phish' }), null)
  assert.equal(sessionUrlFrom({ url: 'https://claude.ai@evil.com/phish' }), null)
})

// --- method and auth ----------------------------------------------------------------------

test('anything but POST is refused', async () => {
  const { response } = await fire({ method: 'GET', ...withKey({ workflow: 'monday-brief' }) })
  assert.equal(response.statusCode, 405)
  assert.equal(response.headers.Allow, 'POST')
  assertNoSecrets(response)
})

test('no FIRE_KEY set means 503 closed, never open', async () => {
  const { response, calls } = await fire(withKey({ workflow: 'monday-brief' }), { unset: ['FIRE_KEY'] })
  assert.equal(response.statusCode, 503)
  assert.match(response.body.error, /not configured/i)
  assert.equal(calls.trigger.length, 0, 'nothing was dispatched')
  assertNoSecrets(response)
})

test('no FIRE_TRIGGERS set means 503, even with a valid key', async () => {
  const { response } = await fire(withKey({ workflow: 'monday-brief' }), { unset: ['FIRE_TRIGGERS'] })
  assert.equal(response.statusCode, 503)
  assertNoSecrets(response)
})

test('malformed FIRE_TRIGGERS reads as unconfigured, not as open', async () => {
  const { response } = await fire(withKey({ workflow: 'monday-brief' }), { env: { FIRE_TRIGGERS: 'not json' } })
  assert.equal(response.statusCode, 503)
  assertNoSecrets(response)
})

test('a request without the key is 401', async () => {
  const { response, calls } = await fire({ body: { workflow: 'monday-brief' } })
  assert.equal(response.statusCode, 401)
  assert.equal(calls.trigger.length, 0)
  assertNoSecrets(response)
})

test('a request with the wrong key is 401', async () => {
  const { response } = await fire(withKey({ workflow: 'monday-brief' }, 'fk_wrong'))
  assert.equal(response.statusCode, 401)
  assertNoSecrets(response)
})

test('PUBLIC_FIRE=true allows same-origin dispatch without a key — even with no key set', async () => {
  // The genuinely-open configuration: no FIRE_KEY anywhere, browser same-origin headers.
  const { response } = await fire(
    { headers: { 'sec-fetch-site': 'same-origin' }, body: { workflow: 'monday-brief' } },
    { env: { PUBLIC_FIRE: 'true' }, unset: ['FIRE_KEY'], trigger: { status: 200, body: '{}' } }
  )
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.ok, true)
})

test('PUBLIC_FIRE=true refuses cross-site browser calls', async () => {
  for (const headers of [
    { 'sec-fetch-site': 'cross-site' },
    { origin: 'https://evil.example', host: 'cockpit.example.vercel.app' }
  ]) {
    const { response, calls } = await fire(
      { headers, body: { workflow: 'monday-brief' } },
      { env: { PUBLIC_FIRE: 'true' } }
    )
    assert.equal(response.statusCode, 403)
    assert.equal(calls.trigger.length, 0)
    assertNoSecrets(response)
  }
})

test('a CORS-simple text/plain body is refused even with a valid key', async () => {
  const { response, calls } = await fire({
    headers: { 'x-fire-key': FIRE_KEY, 'content-type': 'text/plain' },
    body: '{"workflow":"monday-brief","action":"pause"}'
  })
  assert.equal(response.statusCode, 400)
  assert.equal(calls.trigger.length, 0)
  assertNoSecrets(response)
})

test('a form-encoded body parsed into an object is refused too', async () => {
  // Vercel parses urlencoded bodies into objects; the content-type check must still apply.
  const { response, calls } = await fire({
    headers: { 'x-fire-key': FIRE_KEY, 'content-type': 'application/x-www-form-urlencoded' },
    body: { workflow: 'monday-brief', action: 'pause' }
  })
  assert.equal(response.statusCode, 400)
  assert.equal(calls.trigger.length, 0)
  assertNoSecrets(response)
})

test('a content-type smuggling JSON in a parameter is refused (essence check)', async () => {
  const { response, calls } = await fire({
    headers: { 'x-fire-key': FIRE_KEY, 'content-type': 'text/plain; charset=application/json' },
    body: '{"workflow":"monday-brief"}'
  })
  assert.equal(response.statusCode, 400)
  assert.equal(calls.trigger.length, 0)
  assertNoSecrets(response)
})

test('PUBLIC_FIRE fails closed when Origin arrives with no host to compare', async () => {
  const { response, calls } = await fire(
    { headers: { origin: 'https://cockpit.example.vercel.app' }, body: { workflow: 'monday-brief' } },
    { env: { PUBLIC_FIRE: 'true' } }
  )
  assert.equal(response.statusCode, 403)
  assert.equal(calls.trigger.length, 0)
  assertNoSecrets(response)
})

test('PUBLIC_FIRE set to anything but "true" still requires the key', async () => {
  const { response } = await fire({ body: { workflow: 'monday-brief' } }, { env: { PUBLIC_FIRE: '1' } })
  assert.equal(response.statusCode, 401)
  assertNoSecrets(response)
})

// --- input validation ---------------------------------------------------------------------

test('a bad slug shape is 400 before any lookup happens', async () => {
  for (const bad of ['Monday Brief', '../../etc/passwd', 'UPPER', 'a_b']) {
    const { response, calls } = await fire(withKey({ workflow: bad }))
    assert.equal(response.statusCode, 400, `"${bad}" should be 400`)
    assert.equal(calls.trigger.length, 0)
    assertNoSecrets(response)
  }
})

test('a bad action is 400', async () => {
  const { response } = await fire(withKey({ workflow: 'monday-brief', action: 'delete' }))
  assert.equal(response.statusCode, 400)
  assert.match(response.body.error, /"run" or "pause"/)
  assertNoSecrets(response)
})

test('a slug not in the trigger map is 404 with a helpful message', async () => {
  const { response } = await fire(withKey({ workflow: 'unknown-flow' }))
  assert.equal(response.statusCode, 404)
  assert.match(response.body.error, /FIRE_TRIGGERS/)
  assertNoSecrets(response)
})

test('a slug in the map but missing from the repo is 404', async () => {
  const { response, calls } = await fire(withKey({ workflow: 'ghost-flow' }))
  assert.equal(response.statusCode, 404)
  assert.match(response.body.error, /workflows\/ghost-flow\.yml/)
  assert.equal(calls.trigger.length, 0, 'the trigger was never called')
  assertNoSecrets(response)
})

test('a workflow without trigger.fire: true is refused', async () => {
  const { response, calls } = await fire(withKey({ workflow: 'no-fire' }))
  assert.equal(response.statusCode, 403)
  assert.match(response.body.error, /fire: true/)
  assert.equal(calls.trigger.length, 0)
  assertNoSecrets(response)
})

// --- dispatch -----------------------------------------------------------------------------

test('happy path run: dispatches server-side and returns the session URL', async () => {
  const { response, calls } = await fire(withKey({ workflow: 'monday-brief' }), {
    trigger: { status: 200, body: JSON.stringify({ session_url: 'https://claude.ai/code/session_live' }) }
  })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.body, {
    ok: true,
    workflow: 'monday-brief',
    action: 'run',
    sessionUrl: 'https://claude.ai/code/session_live'
  })
  assert.equal(calls.trigger.length, 1)
  assert.equal(calls.trigger[0].url, TRIGGER_URL, 'dispatched to the mapped trigger')
  assert.equal(calls.trigger[0].options.method, 'POST')
  assert.equal(calls.trigger[0].options.headers.Authorization, undefined,
    'the GitHub token must never ride along to the trigger')
  assert.ok(calls.trigger[0].options.signal instanceof AbortSignal, 'dispatch carries a timeout signal')
  const sent = JSON.parse(calls.trigger[0].options.body)
  assert.equal(sent.workflow, 'monday-brief')
  assert.equal(sent.action, 'run')
})

test('a session URL on a host other than claude.ai is dropped, not relayed', async () => {
  const { response } = await fire(withKey({ workflow: 'monday-brief' }), {
    trigger: { status: 200, body: JSON.stringify({ session_url: 'https://evil.example/phish' }) }
  })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.body, { ok: true, workflow: 'monday-brief', action: 'run', accepted: true })
})

test('happy path pause: dispatches the pause instruction, agent makes the edit', async () => {
  const { response, calls } = await fire(withKey({ workflow: 'monday-brief', action: 'pause' }), {
    trigger: { status: 202, body: 'accepted' }
  })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.body, { ok: true, workflow: 'monday-brief', action: 'pause', accepted: true })
  const sent = JSON.parse(calls.trigger[0].options.body)
  assert.equal(sent.action, 'pause')
  assert.match(sent.instruction, /workflows\/monday-brief\.yml/)
})

test('a trigger that answers 500 comes back as 502 in plain words', async () => {
  const { response } = await fire(withKey({ workflow: 'monday-brief' }), {
    trigger: { status: 500, body: `internal: token ${GITHUB_TOKEN} url ${TRIGGER_URL}` }
  })
  assert.equal(response.statusCode, 502)
  assert.match(response.body.error, /rejected the dispatch \(status 500\)/)
  assertNoSecrets(response)
})

test('a trigger that times out or refuses the connection is 502', async () => {
  const { response } = await fire(withKey({ workflow: 'monday-brief' }), {
    trigger: { reject: true }
  })
  assert.equal(response.statusCode, 502)
  assert.match(response.body.error, /did not respond/)
  assertNoSecrets(response)
})

test('a 2xx trigger response with a non-JSON body still counts as accepted', async () => {
  const { response } = await fire(withKey({ workflow: 'monday-brief' }), {
    trigger: { status: 200, body: 'ok' }
  })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.body, { ok: true, workflow: 'monday-brief', action: 'run', accepted: true })
})

test('the happy path never leaks a secret either', async () => {
  const { response } = await fire(withKey({ workflow: 'monday-brief' }), {
    trigger: { status: 200, body: JSON.stringify({ session_url: 'https://claude.ai/code/s' }) }
  })
  assertNoSecrets(response)
})
