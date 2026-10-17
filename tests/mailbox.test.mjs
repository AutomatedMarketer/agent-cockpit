// The Mac mailbox's shared contract (plan 2026-10-12-mac-mailbox, task C1): the order envelope, the
// signature, the checks in their order, the payload rules, and the status file the Mac pushes back.
// tests/fixtures/mailbox-parity.json is the contract: the same bytes live in agent-team-template,
// whose runner checks orders by it, and a test in each repo holds its side to it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  MAILBOX_CONTRACT,
  signBody,
  verifyOrder,
  orderLifeSeconds
} from '../api/_mailbox.js'
import { validateTask, validateMove, parseApprove, validateCreation } from '../api/fire.js'
import { isValidSlug, TASK_STATUSES } from '../api/_lib.js'
import { hiddenText, VOICE_MODEL_TIERS } from '../api/_voice.js'

const fixtureUrl = new URL('./fixtures/mailbox-parity.json', import.meta.url)
const raw = readFileSync(fixtureUrl)
const fixture = JSON.parse(raw.toString('utf8'))
const NOW = Date.parse(fixture.test.now)
// As the runner checks: with the moment its claim store was made (the board keeps no claims).
const expect = { keys: fixture.test.keys, repo: fixture.test.repo, runner: fixture.test.runner, now: NOW, claimsSince: Date.parse(fixture.test.claimsSince) }

test('mailbox parity: the contract file is ASCII with LF line ends, so its bytes survive any editor or checkout', () => {
  assert.ok([...raw].every((byte) => byte === 0x0a || (byte >= 0x20 && byte <= 0x7e)), 'a byte outside printable ASCII')
  assert.ok(!raw.includes(0x0d), 'a carriage return')
})

test('mailbox parity: the shared contract file is the same bytes the Mac runner holds', (t) => {
  const sibling = fileURLToPath(new URL('../../agent-team-template/tests/fixtures/mailbox-parity.json', import.meta.url))
  if (!existsSync(sibling)) {
    // Skipped, not passed: the reason is in the output so a quiet skip never reads as agreement.
    t.skip(`NOT CHECKED - the mailbox contract was not compared with the runner's copy, because ${sibling} does not exist (agent-team-template has not copied it yet, or is not checked out beside agent-cockpit)`)
    return
  }
  assert.equal(readFileSync(sibling, 'utf8'), raw.toString('utf8'), 'the shared mailbox contract has been edited on one side only')
})

// A shape as the fixture writes it, compiled, so a "/" written plainly and an escaped one compare equal.
const shape = (source) => new RegExp(source).source

test('mailbox parity: the board\'s numbers, shapes and lists are the contract\'s', () => {
  const contract = MAILBOX_CONTRACT
  assert.equal(contract.version, fixture.version)
  assert.equal(contract.sigShape.source, shape(fixture.signing.sigShape))
  assert.equal(contract.kidShape.source, shape(fixture.signing.kidShape))
  assert.equal(contract.secretShape.source, shape(fixture.signing.secretShape))
  assert.deepEqual(contract.envelopeKeys, fixture.envelope.keys)
  assert.equal(contract.maxBodyBytes, fixture.envelope.maxBodyBytes)
  assert.deepEqual(contract.bodyKeys, fixture.body.keys)
  assert.equal(contract.idShape.source, shape(fixture.body.idShape))
  assert.equal(contract.repoShape.source, shape(fixture.body.repoShape))
  assert.equal(contract.runnerShape.source, shape(fixture.body.runnerShape))
  assert.equal(contract.timeShape.source, shape(fixture.body.timeShape))
  for (const key of ['minSeconds', 'pollsCovered', 'plusSeconds', 'maxSeconds', 'futureSkewSeconds']) {
    assert.equal(contract.life[key], fixture.life[key], `life.${key}`)
  }
  assert.equal(contract.keyShape.source, shape(fixture.api.keyShape))
  assert.deepEqual(contract.pollSeconds, fixture.api.pollSeconds)
  assert.equal(contract.maxOrders, fixture.api.maxOrders)
  assert.deepEqual(contract.actions, fixture.actions)
  assert.equal(contract.source, fixture.payload.source)
  // The board's own lists are the contract's, so a change on the board fails here first.
  assert.deepEqual(fixture.payload.modelTiers, VOICE_MODEL_TIERS)
  assert.deepEqual(fixture.payload.taskStatuses, TASK_STATUSES)
  const status = contract.status
  assert.equal(status.schema, fixture.status.schema)
  assert.equal(status.folder, fixture.status.folder)
  for (const key of ['maxFileBytes', 'maxFilesRead', 'maxComputersShown', 'maxOrders', 'maxJobs']) {
    assert.equal(status[key], fixture.status[key], `status.${key}`)
  }
  assert.equal(status.commitShape.source, shape(fixture.status.commitShape))
  assert.deepEqual(status.states, fixture.status.states)
  assert.deepEqual(status.reasons, fixture.status.reasons)
  assert.deepEqual(status.allowedKeys, fixture.status.allowedKeys)
  assert.deepEqual(status.requiredKeys, fixture.status.requiredKeys)
  assert.equal(status.maxSteps, fixture.status.maxSteps, 'status.maxSteps')
  assert.deepEqual(status.optionalKeys, fixture.status.optionalKeys)
  // A claim outlives every way its order could still pass the other checks.
  assert.equal(fixture.claims.keepSeconds, fixture.life.maxSeconds + fixture.life.futureSkewSeconds)
  assert.equal(contract.claims.keepSeconds, fixture.claims.keepSeconds)
  for (const rule of ['since', 'keep', 'seen', 'durable']) assert.equal(typeof fixture.claims[rule], 'string', `claims.${rule}`)
  assert.match(fixture.claims.durable, /BEFORE any effect/)
  assert.match(fixture.claims.durable, /fsync/)
})

test('mailbox parity: an order issued before the claim store was made is refused - and only a side that keeps claims checks it', () => {
  const before = fixture.orders.find((order) => order.verdict === 'before-claims')
  assert.ok(before, 'the contract has no before-claims case')
  assert.equal(verifyOrder(before.envelope, expect).verdict, 'before-claims')
  const { claimsSince, ...board } = expect
  assert.equal(verifyOrder(before.envelope, board).verdict, 'ok', 'the board, which keeps no claims, refused it')
  // Issued exactly at claimsSince is not before it.
  const exactly = fixture.orders.find((order) => JSON.parse(order.envelope.body).issuedAt === fixture.test.claimsSince)
  assert.equal(verifyOrder(exactly.envelope, expect).verdict, 'ok')
  // A claim store whose made-at moment cannot be read is not one to run anything from.
  assert.equal(verifyOrder(exactly.envelope, { ...expect, claimsSince: Number.NaN }).verdict, 'before-claims')
})

test('mailbox parity: an order lives max(15 minutes, 3 polls and 2 minutes), never more than an hour', () => {
  for (const { pollSeconds, lifeSeconds } of fixture.life.examples) {
    assert.equal(orderLifeSeconds(pollSeconds), lifeSeconds, `at a ${pollSeconds} s pace`)
  }
})

test('mailbox parity: the board signs each good order\'s body to the exact signature in the contract', () => {
  const good = fixture.orders.filter((order) => order.verdict === 'ok')
  assert.ok(good.length >= 3)
  for (const { name, envelope } of good) {
    assert.equal(signBody(fixture.test.keys[envelope.kid], envelope.body), envelope.sig, name)
  }
  // The key is the secret's own bytes: a base64 secret is not decoded first.
  assert.notEqual(signBody(Buffer.from(fixture.test.keys.k1, 'utf8').toString('base64'), fixture.orders[0].envelope.body), fixture.orders[0].envelope.sig)
})

test('mailbox parity: every order in the contract gets the contract\'s verdict, checked in the contract\'s order', () => {
  const verdicts = new Set(fixture.checks.map((check) => check.verdict))
  for (const { name, envelope, verdict } of fixture.orders) {
    assert.ok(verdicts.has(verdict), `${name}: ${verdict} is not a verdict the contract lists`)
    const result = verifyOrder(envelope, expect)
    assert.equal(result.verdict, verdict, name)
    if (verdict === 'ok') {
      const parsed = JSON.parse(envelope.body)
      assert.deepEqual(result.order, parsed, `${name}: the order given back is not the body that was signed`)
    } else {
      assert.equal(result.order, undefined, `${name}: a refused order was given back`)
    }
  }
  // Each verdict the contract names is reached by at least one case.
  for (const verdict of verdicts) assert.ok(fixture.orders.some((order) => order.verdict === verdict), `no case reaches ${verdict}`)
})

test('mailbox parity: a body is never parsed before its signature matches', () => {
  const original = JSON.parse
  let parsed = 0
  JSON.parse = (...args) => {
    parsed += 1
    return original(...args)
  }
  try {
    for (const { envelope, verdict } of fixture.orders) {
      parsed = 0
      verifyOrder(envelope, expect)
      if (['bad-signature', 'unknown-key'].includes(verdict)) assert.equal(parsed, 0, `${verdict}: the body was parsed`)
    }
  } finally {
    JSON.parse = original
  }
})

// The typed fields, held to the board's own rules - the rules the Mac checks them by again. A
// field is good only in the exact form the board writes it: what the board's own validator gives
// back from it is the field itself.
function boardVerdict(payload) {
  const { action, ...fields } = payload
  const same = (built) => JSON.stringify(built) === JSON.stringify(fields)
  if (action === 'task') {
    const checked = validateTask(fields)
    return !checked.error && same(checked.task)
  }
  if (action === 'skill' || action === 'agent') {
    const checked = validateCreation(fields)
    return !checked.error && same(checked.item)
  }
  if (action === 'move') {
    const checked = validateMove(fields)
    return !checked.error && same(checked.move)
  }
  if (action === 'approve') {
    const checked = parseApprove(fields)
    return !checked.error && same({ task: checked.task })
  }
  if (['run', 'pause', 'arm'].includes(action)) return isValidSlug(fields.workflow) && same({ workflow: fields.workflow })
  return false
}

test('mailbox parity: every payload case gets the contract\'s verdict from the board\'s own rules', () => {
  for (const { name, payload, verdict } of fixture.payload.cases) {
    assert.equal(boardVerdict(payload) ? 'ok' : 'refused', verdict, name)
  }
  for (const action of fixture.actions) {
    assert.ok(fixture.payload.cases.some((item) => item.payload.action === action && item.verdict === 'ok'), `no good case for ${action}`)
  }
  // The hidden-text cases are hidden by the board's one rule.
  assert.ok(fixture.payload.cases.filter((item) => /nobody can see|zero-width|override|byte order|TAG/.test(item.name)).every((item) => Object.values(item.payload).some(hiddenText)))
})

test('mailbox parity: the sample status file uses only the contract\'s keys, states, reasons and shapes', () => {
  const { sample, allowedKeys, states, reasons, stateRules } = fixture.status
  assert.deepEqual(Object.keys(sample), allowedKeys.file)
  assert.deepEqual(Object.keys(sample.allows), allowedKeys.allows)
  assert.deepEqual(Object.keys(stateRules), states)
  for (const entry of sample.orders) {
    assert.deepEqual(Object.keys(entry), allowedKeys.order)
    assert.ok(states.includes(entry.state))
    if (entry.why !== null) assert.ok(Object.hasOwn(reasons[entry.state], entry.why), `${entry.why} is not a ${entry.state} reason`)
  }
  for (const state of states) assert.ok(sample.orders.some((entry) => entry.state === state), `the sample has no ${state} order`)
})

test('mailbox: a key id outside kidShape is unknown even when a key is held under it, and an odd signature never throws', () => {
  const secret = fixture.test.keys.k1
  const { body } = fixture.orders[0].envelope
  const oddKid = { kid: 'K 1', body, sig: signBody(secret, body) }
  assert.equal(verifyOrder(oddKid, { ...expect, keys: { ...expect.keys, 'K 1': secret } }).verdict, 'unknown-key')
  // 43 characters, but not 43 bytes: refused by its shape, never handed to the byte compare.
  assert.equal(verifyOrder({ kid: 'k1', body, sig: '\u00e9'.repeat(43) }, expect).verdict, 'bad-signature')
  assert.equal(verifyOrder({ kid: 'k1', body, sig: '+'.repeat(43) }, expect).verdict, 'bad-signature')
})
