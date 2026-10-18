// The Codex worker on the page (T14): a job the computer gives to Codex is run with Codex, and the page
// says so in a small plain label. There is no choice to make: the computer's allowlist decides, and the
// page only follows the status file (data.mailbox). Old data draws the very same page it always did.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadPage, flush } from './helpers/page-harness.mjs'
import { basePayload } from './helpers/page-payload.mjs'
import { orderFrom, codexOnBoard } from '../api/_voice.js'
import { codexStanding } from '../api/_mac-status.js'
import { connected } from './helpers/voice-browser.mjs'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/mailbox-parity.json', import.meta.url), 'utf8'))
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body })

const workflow = (slug, name, over = {}) => ({
  slug, path: `workflows/${slug}.yml`, name, owner: 'research', steps: ['scan'], runner: 'routine', schedule: 'daily 06:30',
  armed: false, arm: 'off', reason: null, routineId: null, fire: true, webhook: false, output: 'inbox/x.md', problems: [],
  lastRun: null, nextRun: null, state: 'never-run', ...over
})
const computer = (allows) => ({ computer: 'Mac Mini', runner: 'mac-mini', takenAt: '2026-10-18T12:00:00Z', allows: { actions: ['task', 'run'], jobs: ['morning-intel', 'task-sweep'], ...allows }, orders: [], hidden: 0 })
const mailbox = (allows) => ({ status: 'ok', why: null, read: 1, skipped: 0, unreadable: 0, notShown: 0, computers: [computer(allows)] })
const READY = { workers: ['claude', 'codex'], codexJobs: ['task-sweep'] }
const NOT_READY = { workers: ['claude'], codexJobs: ['task-sweep'] }
const jobs = (extra = {}) => [workflow('morning-intel', 'Morning intel'), workflow('task-sweep', 'Task sweep'), ...Object.values(extra)]

async function board(box, { workflows = jobs(), answers = [] } = {}) {
  const fires = []
  const payload = { ...basePayload(), workflows, ...(box === undefined ? {} : { mailbox: box }) }
  const page = loadPage({
    expose: ['fireWorkflow', 'orderFrom', 'codexOnBoard', 'postFire'],
    fetch: async (url, init = {}) => {
      if (url === '/api/fire') {
        fires.push(JSON.parse(init.body))
        return answers.shift() ?? json(200, { ok: true, accepted: true })
      }
      return json(200, String(url).startsWith('/api/state') ? payload : {})
    }
  })
  await flush()
  return { page, fires, today: page.node('today').innerHTML, workflows: page.node('workflows').innerHTML }
}
const buttonOf = (markup, slug) => new RegExp(`<button[^>]*data-fire="${slug}"[^>]*data-action="run"[^>]*>[\\s\\S]*?</button>`).exec(markup)?.[0] ?? null
const firesBlock = (markup) => /<div class="fires">[\s\S]*?<\/div>/.exec(markup)?.[0] ?? null

test('a job that is Codex\'s, with Codex ready, sends worker "codex" by itself and says so in a small label', async () => {
  const { today, workflows } = await board(mailbox(READY))
  for (const markup of [today, workflows]) {
    const codex = buttonOf(markup, 'task-sweep')
    assert.ok(codex, 'no run button for the Codex job')
    assert.match(codex, /data-worker="codex"/)
    assert.match(codex, /runs with Codex/)
    const claude = buttonOf(markup, 'morning-intel')
    assert.ok(claude)
    assert.doesNotMatch(claude, /data-worker|Codex/, 'a Claude job was marked')
  }
  // Said once under the buttons: Codex runs on the ChatGPT plan, not on Claude runs.
  assert.match(today, /ChatGPT/)
})

test('a Codex job whose Codex is not ready cannot be run, and says why in plain words', async () => {
  const { today, workflows } = await board(mailbox(NOT_READY))
  for (const markup of [today, workflows]) {
    assert.equal(buttonOf(markup, 'task-sweep'), null, 'a button that sends was drawn')
    const off = new RegExp('<button[^>]*disabled[^>]*>[\\s\\S]*?</button>').exec(firesBlock(markup) ?? markup)
    assert.ok(off, 'no disabled button')
    assert.match(markup, /Codex is not ready on your Mac/)
    assert.ok(buttonOf(markup, 'morning-intel'), 'the Claude job lost its button')
  }
})

test('clicking a Codex button sends worker "codex"; a Claude button sends no worker key at all', async () => {
  const { page, fires } = await board(mailbox(READY))
  await page.exposed.fireWorkflow({ dataset: { fire: 'task-sweep', action: 'run', worker: 'codex' }, parentElement: { querySelector: () => ({}) }, innerHTML: '' })
  await page.exposed.fireWorkflow({ dataset: { fire: 'morning-intel', action: 'run' }, parentElement: { querySelector: () => ({}) }, innerHTML: '' })
  assert.deepEqual(fires, [{ workflow: 'task-sweep', action: 'run', worker: 'codex' }, { workflow: 'morning-intel', action: 'run' }])
  // A pause never carries a worker, whatever the button says.
  await page.exposed.fireWorkflow({ dataset: { fire: 'task-sweep', action: 'pause', worker: 'codex' }, parentElement: { querySelector: () => ({}) }, innerHTML: '' })
  assert.deepEqual(fires.at(-1), { workflow: 'task-sweep', action: 'pause' })
})

test('every kind of old data draws the same run buttons as a board that has never heard of Codex', async () => {
  const plain = await board(undefined)
  const sample = fixture.status.sample
  const olds = [
    mailbox({}),
    { status: 'none', why: 'Your Mac has not reported on an order yet.', read: 0, skipped: 0, unreadable: 0, notShown: 0, computers: [] },
    { status: 'ok', computers: [{ ...computer({}), allows: sample.allows }] },
    // Worker keys that are not the shaped ones (a hand-made payload): nothing is offered.
    mailbox({ workers: 'codex', codexJobs: 'task-sweep' }),
    { status: 'ok', computers: [{ ...computer({}), allows: { actions: ['run'], jobs: ['task-sweep'], codexJobs: ['task-sweep'] } }] }
  ]
  for (const box of olds) {
    const drawn = await board(box)
    assert.equal(firesBlock(drawn.today), firesBlock(plain.today))
    assert.equal(buttonOf(drawn.workflows, 'task-sweep'), buttonOf(plain.workflows, 'task-sweep'))
    assert.doesNotMatch(drawn.today, /Codex|ChatGPT/)
  }
})

test('everything printed is escaped: a job name with markup in it stays text, and no worker word comes from the file', async () => {
  const hostile = [workflow('task-sweep', '<img src=x onerror=alert(1)>Sweep')]
  const { today, workflows } = await board(mailbox(READY), { workflows: hostile })
  for (const markup of [today, workflows]) {
    assert.doesNotMatch(markup, /<img src=x/)
    assert.match(markup, /&lt;img src=x/)
  }
})

test('the page, the voice and the fire endpoint stand in the same place for any job: one rule, three copies', async () => {
  const { page } = await board(undefined)
  const cases = [
    ['ready', READY, 'task-sweep'],
    ['not ready', NOT_READY, 'task-sweep'],
    ['a Claude job', READY, 'morning-intel'],
    ['no worker keys', {}, 'task-sweep'],
    ['no job named', READY, 'ghost']
  ]
  for (const [why, allows, slug] of cases) {
    const box = mailbox(allows)
    assert.equal(page.exposed.codexOnBoard(box, slug), codexStanding(box.computers[0], slug), why)
    assert.equal(codexOnBoard(box, slug), codexStanding(box.computers[0], slug), why)
  }
  assert.equal(page.exposed.codexOnBoard(undefined, 'task-sweep'), 'not-codex')
  assert.equal(page.exposed.codexOnBoard({ status: 'none', computers: [] }, 'task-sweep'), 'not-codex')
})

test('a voice run order for a Codex job carries worker "codex"; for a job not ready it is refused before a card; others are as before', async () => {
  const orders = { on: true, tasks: true, jobs: ['morning-intel', 'task-sweep'], key: 'fire-key', spokenYes: true, jev: false }
  const data = (box) => ({ ...basePayload(), workflows: jobs(), ...(box === undefined ? {} : { mailbox: box }) })
  const { page } = await board(undefined)
  for (const fn of [orderFrom, page.exposed.orderFrom]) {
    assert.deepEqual(fn('run_job', { workflow: 'task-sweep' }, { orders, data: data(mailbox(READY)) }).order, { kind: 'run', slug: 'task-sweep', name: 'Task sweep', worker: 'codex' })
    assert.deepEqual(fn('run_job', { workflow: 'morning-intel' }, { orders, data: data(mailbox(READY)) }).order, { kind: 'run', slug: 'morning-intel', name: 'Morning intel' })
    assert.deepEqual(fn('run_job', { workflow: 'task-sweep' }, { orders, data: data(mailbox({})) }).order, { kind: 'run', slug: 'task-sweep', name: 'Task sweep' })
    assert.deepEqual(fn('run_job', { workflow: 'task-sweep' }, { orders, data: data(undefined) }).order, { kind: 'run', slug: 'task-sweep', name: 'Task sweep' })
    const refused = fn('run_job', { workflow: 'task-sweep' }, { orders, data: data(mailbox(NOT_READY)) })
    assert.equal(refused.order, undefined)
    assert.match(refused.error, /Codex is not ready/)
  }
})

test('the voice card is sent through fire with the worker, and a Claude job is sent exactly as before', async () => {
  const board = {
    ...basePayload(),
    agents: [{ slug: 'research', state: 'working', description: 'Finds things out.' }],
    workflows: jobs(),
    mailbox: mailbox(READY)
  }
  const orders = { on: true, tasks: true, jobs: ['morning-intel', 'task-sweep'], key: 'fire-key', spokenYes: true, jev: false }
  const call = async (name) => {
    const browser = await connected({ answer: { orders }, data: board })
    browser.emit({ type: 'response.created' })
    browser.emit({ type: 'response.done', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 }, output: [{ type: 'function_call', call_id: 'call_w', name: 'run_job', arguments: JSON.stringify({ workflow: name }) }] } })
    const event = new Event('click')
    Object.defineProperty(event, 'isTrusted', { value: true })
    browser.clock.now += 800
    browser.call.confirm(event, '', browser.ui.cards.at(-1)?.id, '')
    await flush()
    return browser.state.dispatched[0].body
  }
  assert.deepEqual(await call('task-sweep'), { workflow: 'task-sweep', action: 'run', worker: 'codex' })
  assert.deepEqual(await call('morning-intel'), { workflow: 'morning-intel', action: 'run' })
})
