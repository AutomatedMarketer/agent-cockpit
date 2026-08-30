import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { armingProblems } from '../api/state.js'

/* ---------- the arming mirror must not drift from arm.mjs --------------------------------------

   `armingProblems` here and `validateArming` in agent-team-template's scripts/lib/arm.mjs are the
   same three rules written twice. They are mirrored by hand because there is no import path
   between a student's repo and a deployed web app.

   Nothing checked that they agreed, and they did not. The template grew a clockless exemption -
   a webhook job, and later a dashboard button, has no schedule and is never "off", so demanding
   a schedule or a reason from it is asking somebody to justify a state the job was never in.
   This side grew NO exemption at all, and its caller was not even passing it `fire` or `webhook`.
   A student following Lesson 10 or Lesson 12 read PASS from check:arming and a red problem on
   this board, about the same job, on the same afternoon.

   tests/fixtures/arming-parity.json is the shared contract: the same bytes in both repos, run by
   both sides. Change one implementation only and that side fails here. */

const fixtureUrl = new URL('./fixtures/arming-parity.json', import.meta.url)
const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8'))

// The board's own shaping, from shapeWorkflows: a flat row, not the template's nested workflow.
// Adapting here rather than in the fixture is what keeps the fixture identical in both repos.
const rowFor = (trigger) => ({
  name: fixture.name,
  slug: 'monday-brief',
  schedule: trigger.schedule ?? null,
  reason: trigger.reason ?? null,
  armedRaw: trigger.armed,
  fire: trigger.fire === true,
  webhook: trigger.webhook === true
})

for (const testCase of fixture.cases) {
  test(`arming parity: ${testCase.label}`, () => {
    assert.deepEqual(
      armingProblems(rowFor(testCase.trigger)),
      testCase.expected,
      'this board and the team repo must say the same thing about the same job'
    )
  })
}

/* A contract nobody can quietly empty. Deleting the awkward cases would make this file pass and
   mean nothing, which is the failure mode of every golden-file test ever written. */

test('the shared contract still covers the cases the drift was actually about', () => {
  assert.ok(fixture.cases.length >= 15, `the contract has shrunk to ${fixture.cases.length} cases`)

  const labels = fixture.cases.map((c) => c.label).join(' | ')
  assert.match(labels, /CLOCKLESS/, 'the clockless cases are the whole reason this file exists')
  assert.equal(
    fixture.cases.filter((c) => /CLOCKLESS/.test(c.label)).length,
    4,
    'armed and unarmed, webhook and button - all four, or the exemption is only half tested'
  )
  assert.match(labels, /must NOT leak/, 'the exemption must be shown to stop at scheduled jobs too')
})

/* The one cross-repo check that is possible on a machine holding both. It cannot run in CI, where
   only one repo is checked out - so it skips rather than fails there, and the per-case assertions
   above are what carries the contract when it does. */

test('when both repos are on this machine, the two fixtures are byte-identical', (t) => {
  const sibling = fileURLToPath(new URL('../../agent-team-template/tests/fixtures/arming-parity.json', import.meta.url))
  if (!existsSync(sibling)) {
    t.skip('agent-team-template is not checked out beside this repo')
    return
  }
  assert.equal(
    readFileSync(sibling, 'utf8'),
    readFileSync(fixtureUrl, 'utf8'),
    'the shared contract has been edited on one side only - that is the drift, one level up'
  )
})
