// Three things found in review of the local wording:
//  1. Jarvis, on the local board, when orders by voice are OFF: plain student words, not "your Mac" / "FIRE_KEY ... in Vercel, then redeploy".
//  2. Only a string a rule actually changed is tidied: a student's own text that says "Mac" passes through byte for byte.
//  (3, the Readiness allow-list, is in local-readiness-words.test.mjs.)

import test from 'node:test'
import assert from 'node:assert/strict'
import { ordersConfig, LOCAL_ORDERS_OFF } from '../api/_orders.js'
import { instructionsFor, ORDERS_OFF, MAILBOX_ORDERS_OFF } from '../api/_voice.js'
import { applyLocalEnv } from '../local/gate.mjs'
import { localizeSentence, localizeResponse } from '../local/localize.mjs'

// Made-up values, put together at runtime so nothing here looks like a real secret to a scanner.
const MAILBOX_ENV = (runner = 'this-computer') => ({
  FIRE_MODE: 'mailbox',
  FIRE_KEY: ['fk', 'mailbox', 'long', 'enough', 'passphrase'].join('-'),
  MAILBOX_SECRET: ['test', 'only', 'mailbox', 'signing', 'value', '0123456789'].join('-'),
  MAILBOX_KEY: ['test', 'only', 'mailbox', 'poll', 'value', 'abcdefghij'].join('-'),
  MAILBOX_RUNNER: runner,
  GITHUB_OWNER: 'ExampleOwner',
  GITHUB_REPO: 'example-team',
  GITHUB_TOKEN: 'ghp_fakeTokenForTheReviewFixesSuite',
  BLOB_STORE_ID: 'store_fake'
})
const FORBIDDEN = /Vercel|redeploy|FIRE_KEY|FIRE_TRIGGERS|README|\bMac\b|mailbox|env var|hosting/i

test('applyLocalEnv marks the run as the one on a student\'s computer', () => {
  const env = {}
  applyLocalEnv('k', env)
  assert.equal(env.BOARD_LOCAL, 'true')
})

test('local: orders by voice off because jobs are not set up at all - plain words, nothing about Vercel', () => {
  const orders = ordersConfig({ BOARD_LOCAL: 'true' }, null)
  assert.equal(orders.on, false)
  assert.match(orders.why, /^Orders by voice are off, because jobs are not switched on for this board yet\. /)
  assert.match(orders.why, /Start Board window/)
  assert.doesNotMatch(orders.why, FORBIDDEN)
  const told = instructionsFor('Jarvis', null, orders)
  assert.doesNotMatch(told, FORBIDDEN)
  assert.match(told, /jobs are not switched on for this board yet/)
})

test('local: orders by voice off because the computer lets nothing through - the same plain words', () => {
  for (const mac of [{ allows: { actions: [], jobs: [] } }, { allows: { actions: ['run'], jobs: [] } }]) {
    const orders = ordersConfig({ ...MAILBOX_ENV(), BOARD_LOCAL: 'true', PUBLIC_FIRE: 'true' }, mac)
    assert.equal(orders.on, false, JSON.stringify(mac))
    assert.match(orders.why, /^Orders by voice are off, because jobs are not switched on for this board yet\./)
    assert.doesNotMatch(orders.why, FORBIDDEN)
  }
  // The mailbox not set up at all (a missing secret) is the same state to a student.
  const notReady = ordersConfig({ BOARD_LOCAL: 'true', FIRE_MODE: 'mailbox' }, null)
  assert.equal(notReady.on, false)
  assert.doesNotMatch(notReady.why, FORBIDDEN)
})

test('website: both off-states say what they always said', () => {
  assert.equal(ordersConfig({}, null).why, ORDERS_OFF)
  const nothing = ordersConfig({ ...MAILBOX_ENV('mac-mini'), PUBLIC_FIRE: 'true' }, { allows: { actions: [], jobs: [] } })
  assert.equal(nothing.on, false)
  assert.equal(nothing.why, MAILBOX_ORDERS_OFF)
  assert.equal(ordersConfig({ FIRE_MODE: 'mailbox' }, null).why, MAILBOX_ORDERS_OFF)
  assert.match(instructionsFor('Jarvis', null, ordersConfig({}, null)), /FIRE_KEY and FIRE_TRIGGERS in Vercel, then redeploy/)
})

test('local: the same plain sentence reaches the page through the sentence rewriter', () => {
  const local = ordersConfig({ BOARD_LOCAL: 'true' }, null).why
  assert.equal(localizeSentence(ORDERS_OFF), local)
  assert.equal(local, LOCAL_ORDERS_OFF)
  assert.equal(localizeSentence(MAILBOX_ORDERS_OFF), local)
})

/* ---------- a student's own text is never tidied ---------- */

test('text that mentions Mac passes through byte for byte, odd spacing and all', () => {
  const own = [
    'Move  the   Mac  mini , please .',
    '  Mac   mini needs a charger ; check it  ',
    'Buy a Mac\tStudio .\n\nThen  call  Sam',
    'Set up Vercel  and   redeploy ,  the Mac  site',
    '   '
  ]
  for (const text of own) {
    assert.equal(localizeSentence(text), text, JSON.stringify(text))
    for (const key of ['why', 'note', 'say', 'error']) assert.equal(localizeResponse({ [key]: text })[key], text, `${key}: ${JSON.stringify(text)}`)
  }
  // Only the board's own sentence is changed - and then it is tidied as before.
  assert.equal(localizeSentence('Codex is not ready on your Mac , so that job cannot be started from here.'), 'Codex is not ready on this computer, so that job cannot be started from here.')
})
