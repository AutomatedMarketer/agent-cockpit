import test from 'node:test'
import assert from 'node:assert/strict'
import { parseOnboardingState, shapeSetup, shapeWorkflows, shapeGoneQuiet } from '../api/state.js'

const STATE_FILE = `# Onboarding state

\`\`\`yaml
install_complete: false
\`\`\`

| # | Phase | Stage | Status | Finished |
|---|---|---|---|---|
| 1 | Pre-flight | 1 · Brief | done | 2026-08-19 |
| 2 | The repo | 1 · Brief | done | 2026-08-19 |
| 3 | About me | 1 · Brief | skipped | |
| 6 | Connectors | 2 · Access | in-progress | |
| 7 | Meet the team | 3 · Training | pending | |
| 10 | Workflows | 4 · Workflows | pending | |
| 11 | Oversight | 5 · Oversight | pending | |
`

test('the onboarding state table parses into per-stage pass flags', () => {
  const stages = parseOnboardingState(STATE_FILE)
  assert.equal(stages.brief, true, 'done + skipped both count')
  assert.equal(stages.access, false, 'in-progress is not done')
  assert.equal(stages.training, false)
  assert.equal(stages.oversight, false)
})

test('no table, empty, or non-string input reads as no onboarding record', () => {
  assert.equal(parseOnboardingState('just prose, no table'), null)
  assert.equal(parseOnboardingState(''), null)
  assert.equal(parseOnboardingState(null), null)
})

test('with an onboarding record, the ladder believes it over repo shape', () => {
  const setup = shapeSetup({
    brain: [],
    skills: ['scan-market'],
    workflows: [{ schedule: 'daily 06:30', fire: true, lastRun: null }],
    runtimes: [],
    tiles: null,
    runs: [],
    onboarding: { brief: true, access: false, training: false, workflows: false, oversight: false, improvement: false }
  })
  const byRung = Object.fromEntries(setup.map((rung) => [rung.rung, rung.pass]))
  assert.equal(byRung.brief, true)
  assert.equal(byRung.training, false, 'shipped skills do not fake a finished Training stage')
  assert.equal(byRung.workflows, false, 'a pending Workflows stage shows as pending, whatever ran')
  assert.equal(byRung.oversight, false, 'shipped fire buttons do not fake a finished Oversight stage')
  assert.equal(byRung.improvement, false, 'a pending Improvement stage shows as pending')
  assert.deepEqual(setup.map((rung) => rung.label),
    ['Brief', 'Access', 'Training', 'Workflows', 'Oversight', 'Improvement'],
    'ladder labels match the six course stage names, in order')
})

test('a fresh staffed clone with no runs passes zero achievement rungs', () => {
  // The template ships with skills and fire: true workflows out of the box; only evidence
  // of use may light those rungs up when no onboarding record exists.
  const setup = shapeSetup({
    brain: [{ path: 'shared/business-brain.md', present: true, missing: ['owner-name'] }],
    skills: ['scan-market', 'triage-inbox'],
    workflows: [{ schedule: 'daily 06:30', fire: true, lastRun: null }],
    runtimes: [],
    tiles: { chosen: [] },
    runs: [],
    onboarding: null
  })
  for (const rung of setup) {
    assert.equal(rung.pass, false, `${rung.rung} must not pass on an untouched clone`)
  }
})

const FRESH_WORKFLOW = [
  ['workflows/morning-intel.yml', [
    'name: Morning Intel',
    'owner: research',
    'steps: [scan-market]',
    'trigger:',
    '  schedule: "daily 06:30"',
    '  fire: true',
    'output: inbox/{date}/morning-intel.md'
  ].join('\n')]
]

test('a scheduled workflow that never ran is never-run, not quiet', () => {
  const workflows = shapeWorkflows(FRESH_WORKFLOW, [], {}, Date.now())
  assert.equal(workflows[0].state, 'never-run')
  assert.deepEqual(shapeGoneQuiet([], workflows), [], 'never-run does not raise a gone-quiet alarm')
})

test('a scheduled workflow whose runs stopped is still quiet', () => {
  const twoWeeksAgo = new Date(Date.now() - 14 * 86400000).toISOString()
  const runs = [{ workflow: 'morning-intel', agent: 'research', started_at: twoWeeksAgo, status: 'ok' }]
  const workflows = shapeWorkflows(FRESH_WORKFLOW, runs, {}, Date.now())
  assert.equal(workflows[0].state, 'quiet')
  assert.equal(shapeGoneQuiet([], workflows).length, 1)
})

/* The board showed five rungs while the course named six stages everywhere — in the pre-work
   drill, in the shift talk, in the installer's twelve phases, and now in Lesson 18. Improvement
   was taught and then invisible on the one screen students look at daily. The CSS was the same
   bug in another place: `.ladder` was `repeat(5, 1fr)`, so a sixth rung had nowhere to render. */

test('the ladder has one rung per stage the course teaches, Improvement last', () => {
  const setup = shapeSetup({
    brain: [], skills: [], workflows: [], runtimes: [], tiles: null, runs: []
  })
  assert.deepEqual(
    setup.map((rung) => rung.rung),
    ['brief', 'access', 'training', 'workflows', 'oversight', 'improvement'],
    'the six stages, in the order the course climbs them'
  )
})

test('Improvement is the one rung no repo shape can fake', () => {
  // Everything else can be inferred from files the template already ships. A verdict exists
  // only because the owner said what they did with a piece of work.
  const base = {
    brain: [], skills: ['scan-market'], runtimes: [], tiles: null,
    workflows: [{ schedule: 'daily 06:30', fire: true, lastRun: null }],
    runs: [{ trigger: 'schedule', started_at: new Date().toISOString() }]
  }
  const without = shapeSetup(base).find((rung) => rung.rung === 'improvement')
  assert.equal(without.pass, false, 'a busy repo with no verdicts has not started Improvement')
  assert.match(without.detail, /quality\//, 'the detail should say where the verdicts go')

  const with_one = shapeSetup({ ...base, verdicts: 1 }).find((rung) => rung.rung === 'improvement')
  assert.equal(with_one.pass, true, 'one filed verdict starts the stage')
  assert.equal(with_one.detail, '1 verdict filed', 'singular at one — this line is read on quiet weeks')

  const with_many = shapeSetup({ ...base, verdicts: 4 }).find((rung) => rung.rung === 'improvement')
  assert.equal(with_many.detail, '4 verdicts filed')
})

test('an onboarding record decides Improvement too, not just the first five stages', () => {
  const setup = shapeSetup({
    brain: [], skills: [], workflows: [], runtimes: [], tiles: null, runs: [],
    onboarding: { brief: true, access: true, training: true, workflows: true, oversight: true, improvement: true }
  })
  const improvement = setup.find((rung) => rung.rung === 'improvement')
  assert.equal(improvement.pass, true, 'the install record is believed for Improvement as well')
})

test('the ladder grid is not pinned to a fixed number of columns', async () => {
  // `repeat(5, 1fr)` is why a sixth rung had nowhere to go, and `repeat(6, ...)` would just
  // move the same bug one place along. Same lesson as seven nav tabs in a six-column grid.
  const { readFile } = await import('node:fs/promises')
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8')
  const ladder = html.match(/\.ladder \{[^}]*\}/)
  assert.ok(ladder, 'no .ladder rule found')
  assert.ok(
    !/repeat\(\s*\d+\s*,/.test(ladder[0]),
    `.ladder pins a fixed column count: ${ladder[0]}`
  )
})
