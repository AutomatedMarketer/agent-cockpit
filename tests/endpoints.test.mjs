// Which files in api/ are endpoints. Vercel turns every api/ file whose name does not start with "_"
// into a public URL. A helper module there has no handler, so GET /api/lib and the others answered
// 500 FUNCTION_INVOCATION_FAILED to anybody who asked (audit finding #5, 2026-10-10): no data, but a
// stranger could make the server load modules and fail, which is billed and fills the logs.
//
// The rule, both ways round: a file Vercel will serve has a handler, and a file with no handler
// starts with "_" so Vercel leaves it alone.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join } from 'node:path'

const API = fileURLToPath(new URL('../api/', import.meta.url))
const files = readdirSync(API).filter((name) => name.endsWith('.js'))

test('every api/ file Vercel would serve has a handler, and every helper starts with "_"', async () => {
  assert.ok(files.length > 5, 'api/ was not read')
  for (const name of files) {
    if (name.startsWith('_')) continue
    const module = await import(pathToFileURL(join(API, name)).href)
    assert.equal(typeof module.default, 'function', `api/${name} is served by Vercel and has no handler: start its name with "_"`)
  }
})

test('the four helpers that used to answer 500 are not endpoints any more', () => {
  for (const name of ['lib.js', 'readiness.js', 'workflows.js', 'yaml-lite.js']) {
    assert.ok(!files.includes(name), `api/${name} is still served by Vercel`)
    assert.ok(files.includes(`_${name}`), `api/_${name} is missing`)
  }
})
