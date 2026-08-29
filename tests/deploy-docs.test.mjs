import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/* Four buttons on the board - Add task, New workflow, Arm, Approve - do not dispatch to the job
   they sit next to. They all dispatch to one dedicated routine, whose slug is fixed in fire.js and
   is NOT a workflow slug. Wiring "each workflow's slug" into FIRE_TRIGGERS, which is what the
   deploy instructions used to say, leaves all four returning 404 with nothing pointing at the
   cause. The endpoint's own error is clear; the reader only meets it after tapping a dead button.

   So: any slug fire.js requires but cannot derive from the user's workflows has to be named in the
   instructions somebody follows. Add a second one and this fails until the README says so. */
test('every fixed dispatch slug is named in the deploy instructions', async () => {
  const source = await readFile(join(root, 'api/fire.js'), 'utf8')
  const readme = await readFile(join(root, 'README.md'), 'utf8')

  const fixed = [...source.matchAll(/^const\s+\w*SLUG\w*\s*=\s*'([a-z0-9-]+)'/gm)].map((m) => m[1])
  assert.ok(fixed.length > 0, 'no fixed dispatch slug found in api/fire.js - this test has gone hollow')

  for (const slug of fixed) {
    assert.ok(
      readme.includes(slug),
      `api/fire.js requires the "${slug}" routine, and README.md never names it. A reader wiring only their workflow slugs gets a 404 from every button that uses it.`
    )
  }
})
