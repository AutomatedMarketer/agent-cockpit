import test from 'node:test'
import assert from 'node:assert/strict'
import { shapeSnapshot, armStateFor, routineFor, shapeWorkflows, shapeBoard } from '../api/state.js'

/* A workflow file saying `schedule: "daily 06:30"` makes nothing happen at 06:30. A routine is the
   alarm clock. This board reported nine jobs running, each with a next-run time, against one real
   routine — not because anyone lied, but because a file that says `schedule:` looks exactly like a
   job that runs, and `nextRun` was computed from the schedule alone.

   This dashboard cannot call the routines API — no browser can — so the truth arrives as a
   snapshot committed by /routines. Everything here treats it as one. */

const isoAgo = (ms) => new Date(Date.now() - ms).toISOString()

const workflowFile = (slug, { name, schedule = 'daily 06:30', armed, reason } = {}) => [
  `workflows/${slug}.yml`,
  [
    `name: ${name ?? slug}`,
    'owner: research',
    'steps: [scan-market]',
    'trigger:',
    `  schedule: "${schedule}"`,
    armed === undefined ? null : `  armed: ${armed}`,
    reason ? `  reason: "${reason}"` : null,
    `output: inbox/{date}/${slug}.md`
  ].filter(Boolean).join('\n') + '\n'
]

const known = { agents: ['research'], skills: ['scan-market'] }

/* ---------- the snapshot ---------------------------------------------------------------------- */

test('a fresh snapshot is usable and carries when it was taken', () => {
  const snap = shapeSnapshot(JSON.stringify({ takenAt: isoAgo(3600_000), routines: [{ id: 'a', name: 'A' }] }))
  assert.equal(snap.usable, true)
  assert.equal(snap.stale, false)
  assert.equal(snap.routines.length, 1)
  assert.ok(snap.takenAt)
})

test('an absent snapshot is unusable and says so - it never means nothing is scheduled', () => {
  const snap = shapeSnapshot(null)
  assert.equal(snap.usable, false)
  assert.deepEqual(snap.routines, [])
  assert.match(snap.why, /no snapshot/)
})

test('a corrupt snapshot is not the same as an absent one', () => {
  const snap = shapeSnapshot('{ not json')
  assert.equal(snap.usable, false)
  assert.match(snap.why, /could not be read/)
})

test('a snapshot with no takenAt is served but never as current', () => {
  const snap = shapeSnapshot(JSON.stringify({ routines: [{ id: 'a', name: 'A' }] }))
  assert.equal(snap.routines.length, 1, 'the data is still the best available')
  assert.equal(snap.usable, false)
  assert.match(snap.why, /when it was taken/)
})

test('an old snapshot is stale and says how old', () => {
  const snap = shapeSnapshot(JSON.stringify({ takenAt: isoAgo(72 * 3600_000), routines: [] }))
  assert.equal(snap.stale, true)
  assert.match(snap.why, /days ago|hours ago/, 'an age a person can read')
})

/* ---------- the four states -------------------------------------------------------------------- */

test('armed means the file approved it AND a routine exists', () => {
  assert.equal(armStateFor({ name: 'Morning Intel', armed: true }, [{ id: 'x', name: 'Morning Intel' }]), 'armed')
})

test('declared means the file approved it and NOTHING rings', () => {
  assert.equal(armStateFor({ name: 'Morning Intel', armed: true }, []), 'declared')
})

test('unapproved means something rings that the file never approved', () => {
  assert.equal(armStateFor({ name: 'Morning Intel', armed: false }, [{ id: 'x', name: 'Morning Intel' }]), 'unapproved')
})

test('off means not armed and nothing ringing', () => {
  assert.equal(armStateFor({ name: 'Morning Intel', armed: false }, []), 'off')
})

test('routine names match across the spacing and casing a person types on two different days', () => {
  assert.ok(routineFor({ name: 'Morning Intel' }, [{ id: 'x', name: 'morning   INTEL' }]))
  assert.equal(routineFor({ name: 'Morning Intel' }, [{ id: 'x', name: 'Morning Brief' }]), null)
})

/* ---------- the number this brick exists for --------------------------------------------------- */

/* Nine jobs declaring a schedule against one real routine. The board used to report all nine as
   running, each with a next-run time. */

test('nine declared and one armed reports one armed, eight declared, and no invented next runs', () => {
  const files = Array.from({ length: 9 }, (_, index) =>
    workflowFile(`job-${index}`, { name: `Job ${index}`, armed: true })
  )
  const workflows = shapeWorkflows(files, [], known, Date.now(), [{ id: 'trig_0', name: 'Job 0' }])

  assert.equal(workflows.filter((workflow) => workflow.arm === 'armed').length, 1)
  assert.equal(workflows.filter((workflow) => workflow.arm === 'declared').length, 8)

  for (const workflow of workflows.filter((entry) => entry.arm === 'declared')) {
    assert.equal(
      workflow.nextRun,
      null,
      `${workflow.name} declares a schedule with nothing behind it and must not claim a next run`
    )
  }
  assert.ok(workflows.find((workflow) => workflow.arm === 'armed').nextRun, 'the real one still gets its time')
})

test('a declared job never reaches the Up Next column', () => {
  const files = [workflowFile('sweep', { name: 'Sweep', schedule: 'hourly', armed: true })]
  const declared = shapeWorkflows(files, [], known, Date.now(), [])
  assert.equal(shapeBoard(declared, [], []).upNext.length, 0, 'Up Next advertised jobs nothing fires')

  const armed = shapeWorkflows(files, [], known, Date.now(), [{ id: 'trig_sweep', name: 'Sweep' }])
  assert.equal(shapeBoard(armed, [], []).upNext.length, 1)
})

test('with no snapshot at all, nothing claims a next run', () => {
  const files = [workflowFile('sweep', { name: 'Sweep', armed: true })]
  const workflows = shapeWorkflows(files, [], known, Date.now(), [])
  assert.equal(workflows[0].nextRun, null, 'an unknown snapshot is not evidence that a routine exists')
})

/* ---------- what the screen needs --------------------------------------------------------------- */

test('a job left off carries its reason to the screen', () => {
  const files = [workflowFile('cold', { name: 'Cold', armed: false, reason: 'Off until the pipeline has people in it' })]
  const workflows = shapeWorkflows(files, [], known, Date.now(), [])
  assert.equal(workflows[0].arm, 'off')
  assert.equal(workflows[0].reason, 'Off until the pipeline has people in it')
})

test('an armed job names the routine behind it; a declared job cannot', () => {
  const files = [workflowFile('brief', { name: 'Brief', armed: true })]
  assert.equal(shapeWorkflows(files, [], known, Date.now(), [{ id: 'trig_b', name: 'Brief' }])[0].routineId, 'trig_b')
  assert.equal(shapeWorkflows(files, [], known, Date.now(), [])[0].routineId, null)
})

test('unapproved spend names the routine doing it - that is the whole point of the state', () => {
  const files = [workflowFile('brief', { name: 'Brief', armed: false, reason: 'not yet' })]
  const workflows = shapeWorkflows(files, [], known, Date.now(), [{ id: 'trig_live', name: 'Brief' }])
  assert.equal(workflows[0].arm, 'unapproved')
  assert.equal(workflows[0].routineId, 'trig_live')
})

test('a workflow with no armed field at all is off, never armed by default', () => {
  const files = [workflowFile('legacy', { name: 'Legacy' })]
  assert.equal(shapeWorkflows(files, [], known, Date.now(), [])[0].arm, 'off')
  assert.equal(shapeWorkflows(files, [], known, Date.now(), [{ id: 'x', name: 'Legacy' }])[0].arm, 'unapproved')
})

/* ---------- the mirror must not drift from arm.mjs ---------------------------------------------
   This reconcile logic is mirrored from scripts/lib/arm.mjs in the team repo, not imported — there
   is no import path between a student's repo and a deployed app. That makes drift the standing
   risk, and it happened once already: arm.mjs learned to refuse future timestamps and to say
   `unknown`, and this file kept accepting a 2099 stamp as the freshest snapshot possible. */

test('a snapshot stamped in the future is refused, not treated as the freshest possible', () => {
  const now = Date.parse('2026-08-27T12:00:00Z')
  const snap = shapeSnapshot(JSON.stringify({ takenAt: '2099-01-01T00:00:00Z', routines: [] }), now)
  assert.equal(snap.usable, false)
  assert.notEqual(snap.stale, false, 'it must never read as fresh')
  assert.match(snap.why, /future/)
})

test('an age is rendered in something a person reads', () => {
  const now = Date.parse('2026-08-27T12:00:00Z')
  const snap = shapeSnapshot(JSON.stringify({ takenAt: '1999-01-01T00:00:00Z', routines: [] }), now)
  assert.doesNotMatch(snap.why, /\d{5,} hours/, '242426 hours is noise, not a number')
})

/* "Nothing rings" and "I cannot tell what rings" are different claims, and only one of them
   survives a snapshot the board cannot trust. */

test('with the routines unknown, no job is called declared', () => {
  const files = [workflowFile('brief', { name: 'Brief', armed: true })]
  const unknown = shapeWorkflows(files, [], known, Date.now(), [], false)
  assert.equal(unknown[0].arm, 'unknown')
  assert.equal(unknown[0].nextRun, null)

  const declared = shapeWorkflows(files, [], known, Date.now(), [], true)
  assert.equal(declared[0].arm, 'declared', 'with a trustworthy snapshot, an empty list DOES mean nothing rings')
})

test('an unarmed job is still off when the routines are unknown - the file decides that one', () => {
  const files = [workflowFile('cold', { name: 'Cold', armed: false, reason: 'not yet' })]
  assert.equal(shapeWorkflows(files, [], known, Date.now(), [], false)[0].arm, 'off')
})
