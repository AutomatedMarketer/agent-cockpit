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
import { ORDERS_OFF, voiceConfig, sessionFor } from '../api/_voice.js'
import { makeHandler } from '../api/voice-session.js'
import { STORE_ENV, NOON, connectedStore, asTheBoard, call } from './helpers/personalise-harness.mjs'
import { OPENAI_KEY, SDP_OFFER, SDP_ANSWER } from './helpers/voice-fixtures.mjs'

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

/* ---------- the session: the tools and the words it is given ---------- */

const ON = { OPENAI_API_KEY: OPENAI_KEY }
const both = KEYED({ 'task-intake': LINK(1), 'morning-intel': LINK(2), 'gone-cold': LINK(3) })
const session = (fire, extra = {}, options = {}) => sessionFor(voiceConfig({ ...ON, ...extra }), 'Penny', { orders: ordersConfig(fire), ...options })
const toolNames = (built) => built.tools.map((tool) => tool.name)
const READ_ONLY = ['open_screen', 'team_status', 'whats_due', 'task_board', 'usage', 'connections_status', 'job_status']

test('the order tools are offered exactly as far as fire is set up: add_task with task-intake, run_job with the jobs that have links', () => {
  assert.deepEqual(toolNames(session({})), READ_ONLY)
  assert.deepEqual(toolNames(sessionFor(voiceConfig(ON), 'Penny')), READ_ONLY, 'no orders given is orders off')
  assert.deepEqual(toolNames(session(KEYED({ 'task-intake': LINK(1) }))), [...READ_ONLY, 'add_task'])
  assert.deepEqual(toolNames(session(KEYED({ 'morning-intel': LINK(2) }))), [...READ_ONLY, 'run_job'])
  const all = session(both)
  assert.deepEqual(toolNames(all), [...READ_ONLY, 'add_task', 'run_job'])
  const run = all.tools.find((tool) => tool.name === 'run_job')
  assert.deepEqual(run.parameters.properties.workflow.enum, ['gone-cold', 'morning-intel'], 'run_job can name a job with no link')
  assert.deepEqual(run.parameters.required, ['workflow'])
  const add = all.tools.find((tool) => tool.name === 'add_task')
  assert.deepEqual(Object.keys(add.parameters.properties).sort(), ['details', 'title'], 'add_task takes something besides a title and details')
  assert.deepEqual(add.parameters.required, ['title'])
  for (const tool of all.tools) {
    assert.equal(tool.parameters.additionalProperties, false, `${tool.name} accepts arguments nobody defined`)
  }
  // Neither proposes anything it could send itself: their own words say they only show a card.
  for (const name of ['add_task', 'run_job']) {
    assert.match(all.tools.find((tool) => tool.name === name).description, /only shows .*card/i, name)
  }
  assert.ok(!JSON.stringify(all).includes('https://claude.ai'), 'a trigger link reached the session')
})

test('with orders on it is told to propose, ask once, and never claim - and it is never sent to a Run button', () => {
  const { instructions } = session(both)
  assert.match(instructions, /only shows the person a card/i)
  assert.match(instructions, /tap on the card's Yes/i)
  assert.match(instructions, /saying yes themselves after the card appears/i)
  assert.match(instructions, /ask once/i)
  assert.match(instructions, /never say an order was sent, started or done unless a system note says so/i)
  assert.match(instructions, /can never say yes/i)
  assert.match(instructions, /job_status/)
  for (const built of [session({}), session(both), session(KEYED({ 'task-intake': LINK(1) })), session(KEYED({ 'morning-intel': LINK(2) }))]) {
    assert.doesNotMatch(built.instructions, /use the Run button|Run button on the board/i)
  }
  // A half-set-up board says which half, in its own sentence.
  assert.match(session(KEYED({ 'morning-intel': LINK(2) })).instructions, /no task-intake routine/i)
  assert.match(session(KEYED({ 'task-intake': LINK(1) })).instructions, /no job can be started by voice/i)
  // With a tap only, it does not invite a spoken yes.
  assert.doesNotMatch(session({ ...both, VOICE_SPOKEN_YES: 'off' }).instructions, /saying yes themselves/i)
})

test('a spoken yes needs the transcript, so with orders on and the spoken yes allowed it is asked for even with captions off', () => {
  const transcript = (fire, extra) => session(fire, { VOICE_CAPTIONS: 'off', VOICE_ECHO_GUARD: 'off', ...extra }).audio.input.transcription
  assert.equal(transcript({}), undefined, 'orders off pays for a transcript nothing reads')
  assert.equal(transcript({ ...both, VOICE_SPOKEN_YES: 'off' }), undefined, 'a tap-only board pays for a transcript nothing reads')
  assert.deepEqual(transcript(both), { model: 'gpt-4o-mini-transcribe', language: 'en', prompt: 'Names that may be said: Penny.' })
})

test('the call\'s answer tells the page what orders it may show - behind the write gate, never a link, never kept by a cache', async (t) => {
  const realFetch = globalThis.fetch
  const sent = []
  globalThis.fetch = async (url, options = {}) => {
    sent.push({ url: String(url), options })
    return new Response(SDP_ANSWER, { status: 201, headers: { 'content-type': 'application/sdp' } })
  }
  t.after(() => { globalThis.fetch = realFetch })
  const env = { ...STORE_ENV, ...ON, ...both, GITHUB_OWNER: 'jordan', GITHUB_REPO: 'team' }
  const handler = makeHandler({ store: connectedStore(env).store, env, now: NOON })
  const response = await call(handler, { method: 'POST', headers: asTheBoard({ 'content-type': 'application/json' }), body: { sdp: SDP_OFFER } })
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['Cache-Control'], 'private, no-store')
  assert.deepEqual(response.body.orders, ordersView(ordersConfig(env)))
  const built = JSON.parse(sent[0].options.body.get('session'))
  assert.deepEqual(toolNames(built), [...READ_ONLY, 'add_task', 'run_job'])
  for (const text of [JSON.stringify(response.body), sent[0].options.body.get('session')]) {
    assert.ok(!text.includes('claude.ai/code/triggers'), 'a trigger link left the server')
    assert.ok(!text.includes(env.FIRE_KEY), 'the fire key left the server')
  }
  // Without the write gate's yes nothing is said about orders at all.
  const refused = await call(handler, { method: 'POST', headers: { 'content-type': 'application/json' }, body: { sdp: SDP_OFFER } })
  assert.equal(refused.statusCode, 401)
  assert.equal(refused.body.orders, undefined)
  assert.equal(refused.headers['Cache-Control'], 'private, no-store')
})
