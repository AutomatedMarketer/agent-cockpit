// The Readiness wall on the "On my computer" board: the server's own lines ("Your Mac last reported on its orders...",
// "Mac mailbox", "(Mac time)") say "this computer" there. The local server turns them on their way out
// (local/localize.mjs localizeReadiness); the website's lines are not touched. Only the board's OWN words are
// rewritten, never a job's name or a path that happens to hold the word.

import test from 'node:test'
import assert from 'node:assert/strict'
import { loadPage, flush } from './helpers/page-harness.mjs'
import { basePayload } from './helpers/page-payload.mjs'
import { shapeReadiness, READINESS_WORDS, SWITCHED_OFF } from '../api/_readiness.js'
import { shapeJobs, JOBS_FOLDER } from '../api/state.js'
import { localizeResponse, localizeSentence } from '../local/localize.mjs'

const MAC = /\bMac\b/
const NOW = Date.parse('2026-10-09T15:05:00Z')
const TAKEN = '2026-10-09T15:00:00Z'
const reply = (body) => ({ ok: true, status: 200, type: 'basic', headers: { get: () => null }, json: async () => body })
const daily = (hour, minute) => ({ kind: 'slots', slots: [{ minute, hour }] })
const launchdJob = (patch = {}) => ({ label: 'local.donna.story-belt-daily', cadence: daily(6, 15), state: 'loaded', lastExit: 0, lastReportAt: '2026-10-09T10:15:22Z', dueAt: '2026-10-09T10:15:00Z', dueBeforeAt: '2026-10-08T10:15:00Z', ...patch })
const hermesJob = (patch = {}) => ({ profile: 'default', id: 'a1b2c3d4e5f6', name: 'Hermes job a1b2c3d4e5f6', enabled: true, cadence: daily(6, 30), lastRunAt: '2026-10-09T10:30:04Z', lastResult: 'ok', dueAt: '2026-10-09T10:30:00Z', dueBeforeAt: '2026-10-08T10:30:00Z', ...patch })
const reading = (over = {}, name = 'Mac Mini') => ({
  schema: 'agent-status/jobs/v1', takenAt: TAKEN, computer: name, timezone: 'America/New_York', bootedAt: '2026-10-09T14:00:00Z',
  launchd: {
    status: 'found',
    items: [launchdJob(), launchdJob({ label: 'local.donna.off', state: 'not loaded', lastExit: undefined }), launchdJob({ label: 'local.donna.broke', lastExit: 2, lastReportAt: '2026-10-09T14:01:00Z' }),
      { label: 'local.donna.always', cadence: { kind: 'always' }, state: 'running', lastReportAt: '2026-10-09T14:50:02Z' }, launchdJob({ label: 'local.donna.disabled', disabled: true })],
    hidden: 0, more: 0
  },
  hermes: { status: 'found', items: [hermesJob(), hermesJob({ id: 'b1b2c3d4e5f6', lastResult: 'failed' })], hidden: 0, more: 0 },
  ...over
})
const wallOf = (docs, now, extra = {}) => shapeReadiness({
  jobs: shapeJobs(docs.map((doc, index) => [`${JOBS_FOLDER}/m${index}.json`, JSON.stringify(doc)]), now), now, ...extra
})
const mailbox = (orders, takenAt = TAKEN, name = 'Mac Mini') => ({ status: 'ok', computers: [{ computer: name, runner: 'mac-mini', takenAt, allows: { actions: ['task'], jobs: [] }, orders, hidden: 0 }] })
const order = (state, at, over = {}) => ({ id: state.padEnd(32, 'a').replace(/[^0-9a-f]/g, 'a').slice(0, 32), action: 'task', state, at, startedAt: null, finishedAt: null, commit: null, why: null, landed: null, ...over })

// The local board's own computer is called "This computer"; the website's is whatever its owner named it.
const SAMPLES = (name = 'Mac Mini') => [
  wallOf([reading({}, name)], NOW),
  wallOf([reading({ launchd: { status: 'unavailable', why: 'permission denied' }, hermes: { status: 'unavailable' } }, name)], NOW),
  wallOf([reading({}, name)], NOW + 12 * 3600_000),
  wallOf([reading({ computer: undefined })], NOW),
  shapeReadiness({ mailbox: mailbox([order('ok', '2026-10-09T14:00:00Z')], TAKEN, name), now: NOW }),
  shapeReadiness({ mailbox: mailbox([order('failed', '2026-10-09T14:00:00Z', { why: 'push-failed' })], TAKEN, name), now: NOW }),
  shapeReadiness({ mailbox: mailbox([order('unknown', '2026-10-09T14:00:00Z')], TAKEN, name), now: NOW }),
  shapeReadiness({ mailbox: mailbox([order('ok', '2026-10-07T14:00:00Z')], '2026-10-07T14:30:00Z', name), now: NOW }),
  shapeReadiness({ jobs: shapeJobs([], NOW), now: NOW }),
  shapeReadiness({ jobs: shapeJobs([[`${JOBS_FOLDER}/bad.json`, '{ broken']], NOW), now: NOW })
]
const everyString = (value, found = []) => {
  if (typeof value === 'string') found.push(value)
  // an id is a key the page matches on, never a word anyone reads
  else if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) if (key !== 'id') everyString(inner, found)
  return found
}

test('the website\'s Readiness lines are untouched, and the sample reaches the lines that matter', () => {
  const strings = SAMPLES().flatMap((wall) => everyString(wall))
  for (const [pattern, why] of [[/Mac mailbox/, 'a mailbox card'], [/Mac LaunchAgents/, 'a list that could not be read'], [/\(Mac time\)/, 'a schedule on the computer\'s clock'],
    [/the Mac checked at/, 'a running job'], [/^Mac restarted at/, 'a restart line'], [/Your Mac last reported/, 'a quiet mailbox']]) {
    assert.ok(strings.some((text) => pattern.test(text)), why)
  }
  assert.ok(strings.length > 150, `only ${strings.length} strings were looked at`)
})

test('local: every Readiness line comes out without "Mac"', () => {
  for (const [index, wall] of SAMPLES('This computer').entries()) {
    const left = everyString(localizeResponse({ readiness: wall }).readiness).filter((text) => MAC.test(text))
    assert.deepEqual(left, [], `sample ${index}`)
  }
  // Every sentence the wall can say, including the ones the samples do not reach.
  for (const text of [...Object.values(READINESS_WORDS), ...Object.values(SWITCHED_OFF)]) {
    assert.doesNotMatch(localizeResponse({ readiness: { text } }).readiness.text, MAC, text)
  }
})

test('local: the Readiness lines, before and after, in plain words', () => {
  const say = (text) => localizeResponse({ readiness: { text } }).readiness.text
  const rows = [
    ['Your Mac last reported on its orders at {time}, and none failed in the last day.', 'This computer last reported on its orders at {time}, and none failed in the last day.'],
    ['An order failed on your Mac at {time}. Nothing it changed left the Mac; send it again from the board.', 'An order failed on this computer at {time}. Nothing it changed left this computer; send it again from the board.'],
    ['Your Mac lost track of an order at {time} and will not run it again by itself. Check the board, then send it again if it is not there.', 'This computer lost track of an order at {time} and will not run it again by itself. Check the board, then send it again if it is not there.'],
    ['Your Mac has not reported on an order since {date}, so the board cannot vouch for its mailbox.', 'This computer has not reported on an order since {date}, so the board cannot vouch for its orders.'],
    ['Mac mailbox', 'Orders from the board'],
    ['Mac LaunchAgents', 'Scheduled jobs'],
    ['Mac restarted at {stamp}', 'This computer restarted at {stamp}'],
    ['Every day at 6:15am (Mac time)', 'Every day at 6:15am (this computer\'s time)'],
    ['Hermes was running when the Mac checked at {time}.', 'Hermes was running when this computer checked at {time}.'],
    ['Not checked since {date}. The Mac\'s last reading is {hours} h old.', 'Not checked since {date}. This computer\'s last reading is {hours} h old.'],
    ['{name} is installed but not switched on in the Mac\'s scheduler, so it will not run.', '{name} is installed but not switched on in this computer\'s scheduler, so it will not run.'],
    ['{name} stopped with error code {code}. The Mac does not say why; its log on the Mac has the reason.', '{name} stopped with error code {code}. This computer does not say why; its log has the reason.'],
    ['Its scheduler is running. Whether its last report was written is checked on the Mac control center, not here.', 'Its scheduler is running. Whether its last report was written is not checked here.'],
    ['Switched off: turned off on the Mac (its plist says Disabled), so the Mac\'s scheduler is told not to run it.', 'Switched off: turned off on this computer, so its scheduler is told not to run it.']
  ]
  for (const [before, after] of rows) assert.equal(say(before), after, before)
})

test('local: only the board\'s own words change - a job called "Back up the Mac" keeps its name', () => {
  const out = localizeResponse({ readiness: { cards: [{ name: 'Back up the Mac', ref: 'This computer · local.Mac-backup', sentence: { text: 'Back up the Mac ran clean at {time}.' } }] } })
  assert.equal(out.readiness.cards[0].name, 'Back up the Mac')
  assert.equal(out.readiness.cards[0].ref, 'This computer · local.Mac-backup')
  assert.equal(out.readiness.cards[0].sentence.text, 'Back up the Mac ran clean at {time}.')
})

test('local: the mailbox status line and file messages say "this computer"', () => {
  assert.equal(localizeSentence('Your Mac has not reported on an order yet.'), 'This computer has not reported on an order yet.')
  assert.equal(localizeSentence('A Mac mailbox file could not be read.'), 'The orders status file could not be read.')
  assert.equal(localizeSentence('A Mac mailbox file does not say when it was taken.'), 'The orders status file does not say when it was taken.')
})

test('local: the Readiness screen, drawn from the local board\'s answer, shows no "Mac"; the website\'s still does', async () => {
  class Pinned extends Date {
    constructor(...args) { if (args.length) super(...args); else super(NOW) }
    static now() { return NOW }
  }
  const textOf = (node) => `${node.textContent ?? ''} ${(node.children ?? []).map(textOf).join(' ')}`
  const draw = async (wall, local) => {
    const payload = { ...basePayload(), generatedAt: new Date(NOW).toISOString(), readiness: wall }
    const page = loadPage({
      date: Pinned, hash: '#readiness', windowExtras: local ? { __BOARD_LOCAL__: true } : {},
      fetch: async (url) => reply(url.startsWith('/api/state') ? (local ? localizeResponse(payload) : payload) : {})
    })
    await flush()
    return textOf(page.node('readiness'))
  }
  let websiteSaysMac = 0
  for (const [index, wall] of SAMPLES().slice(0, 8).entries()) {
    assert.doesNotMatch(await draw(SAMPLES('This computer')[index], true), MAC)
    if (MAC.test(await draw(wall, false))) websiteSaysMac += 1
  }
  assert.ok(websiteSaysMac >= 4, `the website's screen said Mac in only ${websiteSaysMac} samples: the check looks at too little`)
})
