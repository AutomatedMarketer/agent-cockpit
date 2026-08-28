// The view gate. Vercel's "Standard Protection" exempts production domains, and closing
// that gap on their side costs $150/month — so the two read endpoints close it themselves.
// These tests are the contract: a private repo is never served to an unauthenticated
// caller, and a missing key fails silent rather than open.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { viewGate, keysMatch } from '../api/lib.js'

const req = (headers = {}) => ({ headers })
const KEY = 'a-long-enough-view-key'

/* ---------- closed by default ---------- */

test('no VIEW_KEY and no opt-out refuses to serve at all', () => {
  const denied = viewGate(req(), {})
  assert.equal(denied.status, 503)
  assert.match(denied.error, /VIEW_KEY/)
})

test('an unconfigured deployment never serves the repo instead', () => {
  // The failure mode has to be silence. A dashboard that answers "I am not configured"
  // by handing over a private business repo is the bug this whole file exists to prevent.
  const denied = viewGate(req({ 'x-view-key': 'anything' }), {})
  assert.ok(denied, 'an unconfigured deployment must not fall through to serving')
})

/* ---------- the key ---------- */

test('the right key in the right header passes', () => {
  assert.equal(viewGate(req({ 'x-view-key': KEY }), { VIEW_KEY: KEY }), null)
})

test('no key is a 401 that names the header to use', () => {
  const denied = viewGate(req(), { VIEW_KEY: KEY })
  assert.equal(denied.status, 401)
  assert.match(denied.error, /x-view-key/)
})

test('a wrong key is a 401, and the real key is never echoed back', () => {
  const denied = viewGate(req({ 'x-view-key': 'wrong' }), { VIEW_KEY: KEY })
  assert.equal(denied.status, 401)
  assert.ok(!denied.error.includes(KEY), 'an error message must never contain the key')
})

test('a near-miss is still a miss - no prefix, case or whitespace tolerance', () => {
  for (const attempt of [KEY.slice(0, -1), KEY + 'x', KEY.toUpperCase(), ` ${KEY} `, '']) {
    assert.equal(
      viewGate(req({ 'x-view-key': attempt }), { VIEW_KEY: KEY })?.status,
      401,
      `"${attempt}" must not pass`
    )
  }
})

test('a non-string header value cannot slip through', () => {
  for (const value of [undefined, null, 123, ['x'], {}]) {
    assert.equal(viewGate(req({ 'x-view-key': value }), { VIEW_KEY: KEY })?.status, 401)
  }
})

/* ---------- the deliberate way out ---------- */

test('PUBLIC_DASHBOARD=true opens it, and only that exact string does', () => {
  assert.equal(viewGate(req(), { PUBLIC_DASHBOARD: 'true' }), null)
  for (const value of ['TRUE', 'yes', '1', 'true ', '']) {
    assert.ok(
      viewGate(req(), { PUBLIC_DASHBOARD: value }),
      `PUBLIC_DASHBOARD="${value}" must not open the dashboard`
    )
  }
})

/* ---------- the compare ---------- */

test('keysMatch is used by both keys, so there is one implementation to get right', async () => {
  const fire = await import('../api/fire.js')
  assert.equal(fire.keysMatch, keysMatch, 'fire and view must share the same compare')
})

test('keysMatch refuses an empty expected key rather than matching everything', () => {
  assert.equal(keysMatch('', ''), false)
  assert.equal(keysMatch('anything', ''), false)
  assert.equal(keysMatch('anything', undefined), false)
})

test('keysMatch handles different lengths without throwing', () => {
  // timingSafeEqual throws on a length mismatch, which is why both sides are hashed
  // first — and a plain length check would leak the key's length through timing.
  assert.doesNotThrow(() => keysMatch('short', 'a-much-longer-expected-key'))
  assert.equal(keysMatch('short', 'a-much-longer-expected-key'), false)
})

/* ---------- both read endpoints, not just one ---------- */

test('state and file both refuse an unauthenticated caller', async () => {
  const previous = process.env.PUBLIC_DASHBOARD
  delete process.env.PUBLIC_DASHBOARD
  process.env.VIEW_KEY = KEY
  try {
    for (const module of ['../api/state.js', '../api/file.js']) {
      const handler = (await import(module)).default
      let status = 0
      let body = null
      const response = {
        status(code) { status = code; return this },
        json(payload) { body = payload; return this },
        setHeader() { return this }
      }
      await handler({ headers: {}, query: { path: 'README.md' } }, response)
      assert.equal(status, 401, `${module} served an unauthenticated caller`)
      assert.match(body.error, /view key/i)
    }
  } finally {
    delete process.env.VIEW_KEY
    if (previous !== undefined) process.env.PUBLIC_DASHBOARD = previous
  }
})

/* `api/fire.js` says, in a comment: "which is why the README still says to keep PUBLIC_FIRE
   deployments behind Vercel's own access control." The README said no such thing. PUBLIC_FIRE
   appeared once, in a table, marked Required: No, with no risk note at all — while the code
   beside that comment calls its own same-origin check "best-effort by nature (non-browser
   clients forge headers freely)".

   Setting one environment variable to `true` lets anybody who knows the URL fire a job on the
   owner's Claude account. That is the most expensive thing a reader can do to themselves with
   this dashboard, and it was the one row of the table with nothing to say about it. */

test('the README carries the PUBLIC_FIRE warning that the code says it carries', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  const fire = await readFile(new URL('../api/fire.js', import.meta.url), 'utf8')

  if (/README/.test(fire) && /PUBLIC_FIRE/.test(fire)) {
    assert.match(readme, /PUBLIC_FIRE/, 'fire.js cites the README about PUBLIC_FIRE and the README never mentions it')
  }
  const row = readme.split('\n').find((line) => line.includes('PUBLIC_FIRE'))
  assert.ok(row, 'PUBLIC_FIRE is not documented at all')
  // Both halves, not either. An alternation here let the substantive warning be deleted while
  // one stray phrase kept the test green - which is the same failure this test exists to catch.
  assert.match(readme, /not a security boundary/i,
    'nothing says PUBLIC_FIRE is not a security boundary, which is the whole point of the row')
  assert.match(readme, /forge/i,
    'nothing says the headers it trusts can be forged by anything that is not a browser')
  assert.match(readme, /anyone who knows your dashboard's URL|anyone who knows the URL/i,
    'nothing says who can fire your jobs once this is on')
})

test('the README quotes the number of tests the suite actually reports', () => {
  if (process.env.COCKPIT_README_SELF_CHECK === '1') return
  const env = { ...process.env, COCKPIT_README_SELF_CHECK: '1' }
  delete env.NODE_TEST_CONTEXT
  const run = spawnSync(process.execPath, ['--test'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    encoding: 'utf8',
    env
  })
  const reported = /^\s*(?:ℹ|#)\s*pass\s+(\d+)\s*$/m.exec(run.stdout ?? '')
  assert.ok(reported, "could not read a pass count out of the suite's own output")

  const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8')
  const claims = [...readme.matchAll(/(\d+) tests/g)].map((found) => found[1])
  assert.ok(claims.length, 'the README no longer says how many tests there are')
  for (const claimed of claims) {
    assert.equal(claimed, reported[1],
      `the README says ${claimed} tests and the suite reports ${reported[1]}`)
  }
})
