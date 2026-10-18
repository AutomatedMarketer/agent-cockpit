// The Codex worker, board side (T14). The shared contract is tests/fixtures/mailbox-parity.json, the
// same bytes the runner holds: the order's optional `worker`, the status file's optional
// allows.workers / allows.codexJobs, and the two new reason words. Every case below is read from the
// fixture, so a case added there is tried here without a line changing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MAILBOX_CONTRACT } from '../api/_mailbox.js'
import { shapeMailbox, MAILBOX_FOLDER } from '../api/state.js'
import { MAC_REASON_WORDS } from '../api/_voice.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/mailbox-parity.json', import.meta.url), 'utf8'))
const SAMPLE = fixture.status.sample
const WORKERS = fixture.status.workers
const NOW = Date.parse(SAMPLE.takenAt) + 60_000
const clone = (value) => structuredClone(value)
const computerOf = (doc) => shapeMailbox([[`${MAILBOX_FOLDER}/mac-mini.json`, JSON.stringify(doc)]], NOW, 1).computers[0]
const withAllows = (allows) => ({ ...clone(SAMPLE), allows })

test('the board holds the contract\'s worker words, keys and reasons', () => {
  const contract = MAILBOX_CONTRACT
  assert.deepEqual(contract.workers.values, fixture.payload.worker.values)
  assert.equal(contract.workers.default, fixture.payload.worker.default)
  assert.deepEqual(contract.workers.actions, fixture.payload.worker.actions)
  assert.deepEqual(contract.status.workers.values, WORKERS.values)
  assert.deepEqual(contract.status.workers.allowsOptional, WORKERS.allowsOptional)
  assert.deepEqual(contract.status.workers.reasons, WORKERS.reasons)
  // The older lists stay the contract's own words, untouched.
  assert.deepEqual(contract.status.reasons, fixture.status.reasons)
  assert.deepEqual(contract.status.allowedKeys, fixture.status.allowedKeys)
})

test('the sample status file, which has no worker keys, reads exactly as it did before them', () => {
  const computer = computerOf(SAMPLE)
  assert.deepEqual(Object.keys(computer.allows), ['actions', 'jobs'])
  assert.equal(JSON.stringify(computer.allows), JSON.stringify({ actions: fixture.actions.filter((a) => SAMPLE.allows.actions.includes(a)), jobs: [...SAMPLE.allows.jobs].sort() }))
})

test('the contract\'s sample with workers is read whole: both keys, in the contract\'s order', () => {
  const { actions, jobs, workers, codexJobs } = computerOf(withAllows(WORKERS.sampleAllows)).allows
  assert.deepEqual(workers, WORKERS.sampleAllows.workers)
  assert.deepEqual(codexJobs, WORKERS.sampleAllows.codexJobs)
  assert.deepEqual(jobs, WORKERS.sampleAllows.jobs)
  assert.ok(actions.includes('run'))
})

test('every allows the contract accepts keeps its worker keys (no worker ready, or only Claude, is as valid as both)', () => {
  for (const { why, allows } of WORKERS.allowsAccept) {
    const shown = computerOf(withAllows(allows)).allows
    if (Object.hasOwn(allows, 'workers')) {
      assert.deepEqual(shown.workers, allows.workers, why)
      assert.deepEqual(shown.codexJobs, [...allows.codexJobs].sort(), why)
    } else {
      assert.deepEqual(Object.keys(shown), ['actions', 'jobs'], why)
    }
  }
})

test('every allows the contract refuses loses both worker keys, and the rest of the file still reads', () => {
  for (const { why, allows } of WORKERS.allowsRefuse) {
    const computer = computerOf(withAllows(allows))
    assert.ok(computer, why)
    assert.deepEqual(Object.keys(computer.allows), ['actions', 'jobs'], `${why}: a worker key survived`)
    assert.deepEqual(computer.allows.jobs, [...allows.jobs].sort(), why)
    assert.equal(computer.orders.length, SAMPLE.orders.length, why)
  }
})

test('workers and codexJobs are size-capped and read as a stranger\'s: a long or odd list is dropped, not trimmed', () => {
  const many = Array.from({ length: 41 }, (_, n) => `job-${n}`)
  const base = { actions: ['run'], jobs: many.slice(0, 40) }
  for (const [why, extra] of [
    ['41 Codex jobs', { workers: ['codex'], codexJobs: many }],
    ['3 workers', { workers: ['claude', 'codex', 'claude'], codexJobs: [] }],
    ['an object for workers', { workers: { codex: true }, codexJobs: [] }],
    ['a number in codexJobs', { workers: ['codex'], codexJobs: [7] }],
    ['null codexJobs', { workers: ['codex'], codexJobs: null }],
    ['a prototype name', { workers: ['constructor'], codexJobs: [] }],
    ['an angle-bracket worker', { workers: ['<img src=x>'], codexJobs: [] }]
  ]) {
    const allows = computerOf(withAllows({ ...base, ...extra })).allows
    assert.deepEqual(Object.keys(allows), ['actions', 'jobs'], why)
  }
})

test('the two new reason words are read in an order of the right kind, and only there', () => {
  const entry = (state, why) => ({ ...clone(SAMPLE.orders.find((one) => one.state === state)), id: 'ab'.repeat(16), why })
  const refused = clone(SAMPLE)
  refused.orders = [entry('refused', 'worker-not-allowed')]
  assert.equal(computerOf(refused).orders[0].why, 'worker-not-allowed')
  const failed = clone(SAMPLE)
  failed.orders = [entry('failed', 'codex-failed')]
  assert.equal(computerOf(failed).orders[0].why, 'codex-failed')
  for (const [state, why] of [['refused', 'codex-failed'], ['failed', 'worker-not-allowed']]) {
    const wrong = clone(SAMPLE)
    wrong.orders = [entry(state, why)]
    assert.equal(computerOf(wrong).orders.length, 0, `${why} as ${state} was kept`)
    assert.equal(computerOf(wrong).hidden, 1)
  }
})

test('the sentences said for a reason: the contract\'s words, plus the two new ones, and none of them names a worker it should not', () => {
  for (const state of ['refused', 'failed']) {
    for (const [word, text] of Object.entries(fixture.status.reasons[state])) {
      if (word === 'tool-refused') continue
      assert.equal(MAC_REASON_WORDS[state][word], text, word)
    }
  }
  assert.equal(MAC_REASON_WORDS.refused['worker-not-allowed'], WORKERS.reasons.refused['worker-not-allowed'])
  assert.equal(MAC_REASON_WORDS.failed['codex-failed'], WORKERS.reasons.failed['codex-failed'])
  // A tool refused may be Claude's or Codex's: the sentence names neither.
  assert.doesNotMatch(MAC_REASON_WORDS.failed['tool-refused'], /claude|codex/i)
  assert.match(MAC_REASON_WORDS.failed['tool-refused'], /tool/)
})
