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

  /* Resolve what the code LOOKS UP, not how the constant was spelled. The first version of this
     matched /^const\s+\w*SLUG\w*\s*=\s*'...'/ and missed four undocumented slugs at once: a name
     without "SLUG" in it, a double-quoted value, an indented declaration, and a camelCase name.
     Every one of those would have shipped the same 404 this test exists to prevent. */
  const constants = new Map()
  for (const m of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"]([a-z0-9][a-z0-9-]*)['"]/g)) {
    constants.set(m[1], m[2])
  }
  // A slug is "fixed" when the code indexes the trigger map with something the user did not type.
  const fixed = new Set()
  for (const m of source.matchAll(/triggers\s*\[\s*([A-Za-z_$][\w$]*|['"][a-z0-9-]+['"])\s*\]/g)) {
    const key = m[1]
    if (/^['"]/.test(key)) fixed.add(key.slice(1, -1))
    else if (constants.has(key)) fixed.add(constants.get(key))
  }
  assert.ok(fixed.size > 0, 'no fixed dispatch slug found in api/fire.js - this test has gone hollow')

  for (const slug of fixed) {
    assert.ok(
      readme.includes(slug),
      `api/fire.js requires the "${slug}" routine, and README.md never names it. A reader wiring only their workflow slugs gets a 404 from every button that uses it.`
    )
  }
})
