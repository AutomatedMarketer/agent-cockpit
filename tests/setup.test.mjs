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
    onboarding: { brief: true, access: false, training: false, workflows: false, oversight: false }
  })
  const byRung = Object.fromEntries(setup.map((rung) => [rung.rung, rung.pass]))
  assert.equal(byRung.brief, true)
  assert.equal(byRung.training, false, 'shipped skills do not fake a finished Training stage')
  assert.equal(byRung.oversight, false, 'shipped fire buttons do not fake a finished Oversight stage')
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
