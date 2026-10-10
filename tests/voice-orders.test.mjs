// Orders by voice (Phase 11): what the board lets the assistant propose, and what it never does.
//
// The assistant can only PROPOSE: a task card for the team, or one run of a job that has its own
// trigger link. A card appears; nothing is sent until the owner says yes - a tap on the card, or
// their own spoken "yes" heard from their own microphone, under the rules in api/_voice.js. Orders go
// through the same fire endpoint the board's buttons use, so with fire not set up they are off, and
// the assistant says so plainly.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ordersConfig, ordersView, MAX_ORDER_JOBS } from '../api/_orders.js'
import { ORDERS_OFF } from '../api/_voice.js'

// Trigger links shaped like the real ones, made up. Nothing here is a working address.
const LINK = (n) => `https://claude.ai/code/triggers/trig_${n}/fire`
const triggers = (map) => JSON.stringify(map)
const KEYED = (map) => ({ FIRE_KEY: 'a-long-fire-passphrase', FIRE_TRIGGERS: triggers(map) })

/* ---------- on, off, and why ---------- */

test('orders are off until fire is set up, and the one sentence says how to switch them on - never "use the Run button"', () => {
  for (const [what, env] of [
    ['nothing set', {}],
    ['FIRE_TRIGGERS that is not JSON', { FIRE_KEY: 'k', FIRE_TRIGGERS: 'task-intake=https://x' }],
    ['FIRE_TRIGGERS that is a list', { FIRE_KEY: 'k', FIRE_TRIGGERS: '["https://x"]' }],
    ['links but no fire key, and not PUBLIC_FIRE', { FIRE_TRIGGERS: triggers({ 'task-intake': LINK(1) }) }],
    ['a key but no links at all', KEYED({})],
    ['a key, but every link is not https', KEYED({ 'task-intake': 'http://claude.ai/x', 'morning-intel': 'ftp://x' })],
    ['PUBLIC_FIRE on a board open to everyone, with no fire key', { PUBLIC_DASHBOARD: 'true', PUBLIC_FIRE: 'true', FIRE_TRIGGERS: triggers({ 'task-intake': LINK(1) }) }]
  ]) {
    const config = ordersConfig(env)
    assert.equal(config.on, false, `${what}: orders are on`)
    assert.equal(config.why, ORDERS_OFF, `${what}: the reason is not the sentence`)
    assert.equal(config.tasks, false, what)
    assert.deepEqual(config.jobs, [], what)
    assert.deepEqual(ordersView(config), { on: false }, what)
  }
  assert.match(ORDERS_OFF, /Run buttons are not set up/)
  assert.match(ORDERS_OFF, /task-intake/)
  assert.match(ORDERS_OFF, /FIRE_KEY/)
  assert.match(ORDERS_OFF, /FIRE_TRIGGERS/)
  assert.match(ORDERS_OFF, /README/)
  assert.doesNotMatch(ORDERS_OFF, /use the Run button/i)
})

test('with the fire key and a task-intake link, tasks are on; every job with a link of its own can be run', () => {
  const config = ordersConfig(KEYED({
    'task-intake': LINK(1),
    'morning-intel': LINK(2),
    'gone-cold': LINK(3),
    'Bad Slug': LINK(4),
    '../escape': LINK(5),
    'weekly-review': 'http://claude.ai/not-https',
    'daily-brief': 42
  }))
  assert.deepEqual(config, { on: true, tasks: true, jobs: ['gone-cold', 'morning-intel'], key: 'fire-key', spokenYes: true, jev: false })
  // No task-intake: no task cards, but a job with its own link still runs.
  const jobsOnly = ordersConfig(KEYED({ 'morning-intel': LINK(2) }))
  assert.equal(jobsOnly.on, true)
  assert.equal(jobsOnly.tasks, false)
  assert.deepEqual(jobsOnly.jobs, ['morning-intel'])
  // Only task-intake: task cards, and no job to run.
  assert.deepEqual(ordersConfig(KEYED({ 'task-intake': LINK(1) })).jobs, [])
})

test('PUBLIC_FIRE means no key is asked for - except on a board open to everyone, where the fire key is still required', () => {
  const links = triggers({ 'task-intake': LINK(1) })
  assert.equal(ordersConfig({ PUBLIC_FIRE: 'true', FIRE_TRIGGERS: links }).key, 'public')
  assert.equal(ordersConfig({ PUBLIC_FIRE: 'true', FIRE_KEY: 'k', FIRE_TRIGGERS: links }).key, 'public')
  assert.equal(ordersConfig({ PUBLIC_DASHBOARD: 'true', PUBLIC_FIRE: 'true', FIRE_KEY: 'k', FIRE_TRIGGERS: links }).key, 'fire-key')
  assert.equal(ordersConfig({ PUBLIC_FIRE: 'yes', FIRE_KEY: 'k', FIRE_TRIGGERS: links }).key, 'fire-key', 'only "true" is PUBLIC_FIRE')
})

test('a spoken yes is allowed unless VOICE_SPOKEN_YES says off', () => {
  const links = { 'task-intake': LINK(1) }
  assert.equal(ordersConfig(KEYED(links)).spokenYes, true)
  for (const off of ['off', 'OFF', 'false', '0', ' off ']) {
    assert.equal(ordersConfig({ ...KEYED(links), VOICE_SPOKEN_YES: off }).spokenYes, false, off)
  }
  assert.equal(ordersConfig({ ...KEYED(links), VOICE_SPOKEN_YES: 'on' }).spokenYes, true)
})

test('Jev picks the agent only when JEV_ROUTING is on AND an OpenRouter key is set - off by default', () => {
  const links = { 'task-intake': LINK(1) }
  const key = ['or', 'test', 'routing'].join('-')
  assert.equal(ordersConfig(KEYED(links)).jev, false)
  assert.equal(ordersConfig({ ...KEYED(links), JEV_ROUTING: 'on' }).jev, false, 'no OpenRouter key')
  assert.equal(ordersConfig({ ...KEYED(links), OPENROUTER_API_KEY: key }).jev, false, 'the switch is off')
  assert.equal(ordersConfig({ ...KEYED(links), JEV_ROUTING: 'on', OPENROUTER_API_KEY: key }).jev, true)
  assert.equal(ordersConfig({ ...KEYED(links), JEV_ROUTING: 'off', OPENROUTER_API_KEY: key }).jev, false)
  // Jev picks who does a TASK: with no task-intake there is nothing for it to pick.
  assert.equal(ordersConfig({ ...KEYED({ 'morning-intel': LINK(2) }), JEV_ROUTING: 'on', OPENROUTER_API_KEY: key }).jev, false)
})

test('no trigger link, part of one, or the fire key ever leaves the server in what orders say', () => {
  const key = 'fire-passphrase-that-stays-put'
  for (let round = 0; round < 50; round += 1) {
    const map = { 'task-intake': `https://claude.ai/code/triggers/trig_intake${round}/fire?k=q${round}` }
    for (let n = 0; n < 1 + (round % 7); n += 1) {
      map[`job-${round}-${n}`] = `https://claude.ai/code/triggers/trig_${round}x${n}/fire#frag${n}`
      map[`https://claude.ai/${n}`] = LINK(n)
      map[`odd${n}/path`] = LINK(n)
    }
    const env = { FIRE_KEY: key, FIRE_TRIGGERS: triggers(map), PUBLIC_FIRE: round % 2 ? 'true' : '' }
    for (const said of [JSON.stringify(ordersConfig(env)), JSON.stringify(ordersView(ordersConfig(env)))]) {
      for (const leak of ['https', '://', 'claude.ai', 'trig_', 'frag', key]) {
        assert.ok(!said.includes(leak), `round ${round}: "${leak}" left the server in ${said}`)
      }
    }
  }
  assert.deepEqual(Object.keys(ordersView(ordersConfig(KEYED({ 'task-intake': LINK(1) })))).sort(), ['jev', 'jobs', 'key', 'on', 'spokenYes', 'tasks'])
})

test('the job list is kept to a list the assistant can be offered', () => {
  const map = { 'task-intake': LINK(0) }
  for (let n = 0; n < MAX_ORDER_JOBS + 25; n += 1) map[`job-${String(n).padStart(3, '0')}`] = LINK(n)
  const { jobs } = ordersConfig(KEYED(map))
  assert.equal(jobs.length, MAX_ORDER_JOBS)
  assert.deepEqual(jobs, [...jobs].sort(), 'not in a stable order')
})

test('the orders helper never reads process.env: it decides from the env it is handed', () => {
  const source = readFileSync(new URL('../api/_orders.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /process\.env/)
})
