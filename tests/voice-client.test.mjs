// The voice helpers the PAGE runs, tested here through api/_voice.js, which holds the same code: the
// page has no module loading, so the block between `voice-page:start` and `voice-page:end` is
// mirrored verbatim into public/index.html, and the last tests in this file hold the two copies
// together byte for byte (the same arrangement as calendar.test.mjs and the week helpers).
//
// What these tests hold it to: how a reply is cut into pieces for Fish; that a piece from a turn the
// person talked over is dropped; that every count OpenAI documents is added up, cached apart; that
// the outbox clears only what the server counted; that the six tools answer from the board's own
// data, small and plain, whatever the data looks like; and that nothing but a real tap can ever
// stand in for the owner's yes.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  takeSpeakable,
  newTurn,
  isStale,
  emptyTally,
  addUsage,
  addFishBytes,
  readOutbox,
  outboxPut,
  outboxBatch,
  outboxSettle,
  outboxSummary,
  voiceToolAnswer,
  confirmsYes,
  VOICE_PAGE_SCREENS,
  VOICE_SCREENS,
  VOICE_TOOL_NAMES,
  MAX_OUTBOX_ITEMS,
  TRANSCRIBE_MODEL,
  costOf
} from '../api/_voice.js'
import { VOICE_PRICES } from '../api/_voice-prices.js'
import { REPLY_USAGE, TRANSCRIPTION_USAGE } from './helpers/voice-fixtures.mjs'

/* ---------- cutting a reply into pieces for Fish ---------- */

// Feeds a reply in as it streams, a few characters at a time, and collects every piece.
function cutWhileStreaming(reply, step = 3) {
  const pieces = []
  let buffer = ''
  let first = true
  for (let at = 0; at < reply.length; at += step) {
    buffer += reply.slice(at, at + step)
    for (;;) {
      const { piece, rest } = takeSpeakable(buffer, { first })
      if (!piece) break
      pieces.push(piece)
      buffer = rest
      first = false
    }
  }
  const { piece } = takeSpeakable(buffer, { first, done: true })
  if (piece) pieces.push(piece)
  return pieces
}

test('the first piece goes at the first pause once 12 characters are waiting, then a sentence at a time', () => {
  assert.deepEqual(cutWhileStreaming('Three jobs are due today, and one has gone quiet. The brief runs at six. Nothing failed.'), [
    'Three jobs are due today,', 'and one has gone quiet.', 'The brief runs at six.', 'Nothing failed.'
  ])
  // A pause before 12 characters is too short to be worth a request on its own.
  assert.deepEqual(cutWhileStreaming('Sure, the team is fine. All good.'), ['Sure, the team is fine.', 'All good.'])
})

test('numbers are never cut: 1,000 and 3.5 stay whole', () => {
  const pieces = cutWhileStreaming('You have spent 1,000 tokens and 3.5 dollars this month. That is fine.')
  assert.deepEqual(pieces, ['You have spent 1,000 tokens and 3.5 dollars this month.', 'That is fine.'])
  for (const piece of pieces) assert.doesNotMatch(piece, /^\d|[,.]$(?<=\d[,.])/)
})

test('a long run with no sentence end is cut under 220 characters, at a pause or a space', () => {
  const words = Array.from({ length: 80 }, (unused, n) => `word${n}`).join(' ')
  const pieces = cutWhileStreaming(`Here it is, ${words}, and then the end.`)
  for (const piece of pieces) assert.ok(piece.length <= 220, `a piece of ${piece.length} characters`)
  assert.equal(pieces.join(' '), `Here it is, ${words}, and then the end.`, 'something was lost or added between pieces')
  assert.ok(pieces.length >= 3)
})

test('whatever is left is spoken when the reply is done, and nothing empty is ever a piece', () => {
  assert.deepEqual(takeSpeakable('and that is all', { first: false, done: true }), { piece: 'and that is all', rest: '' })
  assert.deepEqual(takeSpeakable('   ', { first: false, done: true }), { piece: null, rest: '' })
  assert.deepEqual(takeSpeakable('Not yet a sentence', { first: false }), { piece: null, rest: 'Not yet a sentence' })
  assert.deepEqual(takeSpeakable('', { first: true }), { piece: null, rest: '' })
})

/* ---------- turns ---------- */

test('a piece from a turn the person talked over is stale and is dropped', () => {
  const turns = { current: 0 }
  const first = newTurn(turns)
  assert.equal(isStale(turns, first), false)
  const second = newTurn(turns) // they talked over it
  assert.equal(isStale(turns, first), true)
  assert.equal(isStale(turns, second), false)
  assert.ok(second > first)
})

/* ---------- counting ---------- */

test('every count OpenAI documents for a reply is added, cached tokens apart from the rest', () => {
  const tally = addUsage(emptyTally(), REPLY_USAGE, 'reply')
  assert.deepEqual(tally, {
    textIn: 55, cachedTextIn: 64, audioIn: 13, cachedAudioIn: 0, textOut: 30, audioOut: 91,
    transcribeTextIn: 0, transcribeAudioIn: 0, transcribeOut: 0, fishBytes: 0
  })
  const twice = addUsage(tally, REPLY_USAGE, 'reply')
  assert.equal(twice.audioOut, 182)
  assert.equal(tally.audioOut, 91, 'adding changed the tally it was given')
})

test('every count OpenAI documents for a caption is added to the caption counts', () => {
  const tally = addUsage(emptyTally(), TRANSCRIPTION_USAGE, 'captions')
  assert.equal(tally.transcribeAudioIn, 17)
  assert.equal(tally.transcribeTextIn, 0)
  assert.equal(tally.transcribeOut, 9)
  assert.equal(tally.audioIn, 0)
})

test('usage that is missing, odd or hostile adds nothing rather than something', () => {
  for (const odd of [null, undefined, 'lots', [], { input_tokens: -5 }, { output_token_details: { audio_tokens: 1.5 } }, { input_token_details: { text_tokens: '9' } }]) {
    assert.deepEqual(addUsage(emptyTally(), odd, 'reply'), emptyTally(), JSON.stringify(odd))
  }
  assert.deepEqual(addUsage(emptyTally(), REPLY_USAGE, 'something else'), emptyTally())
})

test('Fish characters are counted as UTF-8 bytes, the way Fish bills them', () => {
  assert.equal(addFishBytes(emptyTally(), 'Hello.').fishBytes, 6)
  assert.equal(addFishBytes(emptyTally(), 'Olá — café.').fishBytes, 15)
})

/* ---------- the outbox ---------- */

const sid = (n) => n.toString(16).padStart(32, '0')
const entry = (n, over = {}) => ({
  ticket: `t${n}.sig`, sid: sid(n), at: '2026-10-09T12:00:00.000Z', model: 'gpt-realtime-2.1-mini', mouth: 'openai',
  counts: { ...emptyTally(), audioOut: 1200 }, ...over
})

test('a conversation is one outbox entry, updated after every reply', () => {
  let outbox = readOutbox(null)
  outbox = outboxPut(outbox, entry(1))
  outbox = outboxPut(outbox, entry(1, { counts: { ...emptyTally(), audioOut: 2400 } }))
  outbox = outboxPut(outbox, entry(2))
  assert.equal(outbox.items.length, 2)
  assert.equal(outbox.items[0].counts.audioOut, 2400)
})

test('the outbox is sent 20 at a time, oldest first, and survives a "kept" answer', () => {
  let outbox = readOutbox(null)
  for (let n = 1; n <= 25; n += 1) outbox = outboxPut(outbox, entry(n))
  const batch = outboxBatch(outbox)
  assert.equal(batch.reports.length, 20)
  assert.deepEqual(batch.sids, Array.from({ length: 20 }, (unused, n) => sid(n + 1)))
  assert.deepEqual(batch.reports[0], { ticket: 't1.sig', counts: entry(1).counts })

  const kept = outboxSettle(outbox, batch, { accepted: [], kept: batch.sids, refused: [] })
  assert.equal(kept.items.length, 25, 'a kept answer lost conversations')
  const some = outboxSettle(outbox, batch, { accepted: [sid(1), sid(2)], kept: [], refused: [{ at: 4, why: 'bad' }] })
  assert.deepEqual(some.items.map((item) => item.sid).slice(0, 3), [sid(3), sid(4), sid(6)], 'accepted and refused were not the ones cleared')
  assert.equal(some.items.length, 22)
  // An answer that is not an answer clears nothing.
  assert.equal(outboxSettle(outbox, batch, null).items.length, 25)
  assert.equal(outboxSettle(outbox, batch, { accepted: 'all' }).items.length, 25)
})

test('the outbox read back from storage keeps only what the page itself writes', () => {
  assert.deepEqual(readOutbox('not json').items, [])
  assert.deepEqual(readOutbox('{"items":"x"}').items, [])
  const stored = JSON.stringify({
    version: 1,
    items: [entry(1), { ...entry(2), sid: 'nope' }, { ...entry(3), ticket: 'x'.repeat(5000) }, { ...entry(4), counts: { audioOut: -1 } }, 'junk', { ...entry(5), extra: '<b>' }]
  })
  const outbox = readOutbox(stored)
  assert.deepEqual(outbox.items.map((item) => item.sid), [sid(1), sid(5)])
  assert.equal(outbox.items[1].extra, undefined)
  let full = readOutbox(null)
  for (let n = 1; n <= MAX_OUTBOX_ITEMS + 5; n += 1) full = outboxPut(full, entry(n))
  assert.equal(full.items.length, MAX_OUTBOX_ITEMS)
  assert.equal(full.items[0].sid, sid(6), 'the oldest are not the ones let go')
})

test('the outbox adds up to a device-only total for a month, priced by the table the server sent', () => {
  const prices = { ...VOICE_PRICES, transcribeModel: TRANSCRIBE_MODEL }
  let outbox = readOutbox(null)
  outbox = outboxPut(outbox, entry(1))
  outbox = outboxPut(outbox, entry(2, { at: '2026-09-30T23:00:00.000Z' }))
  outbox = outboxPut(outbox, entry(3, { mouth: 'fish', fishModel: 's2.1-pro-free', counts: { ...emptyTally(), fishBytes: 500 } }))
  const october = outboxSummary(outbox, prices, '2026-10')
  assert.equal(october.conversations, 2)
  assert.equal(october.usd, costOf({ audioOut: 1200 }, { model: 'gpt-realtime-2.1-mini' }, VOICE_PRICES).usd)
  assert.deepEqual(october.fishBytes, { 's2.1-pro-free': 500 })
  assert.equal(october.waiting, 3, 'every conversation in the outbox is still waiting to be recorded')
  assert.deepEqual(outboxSummary(outbox, null, '2026-10').incomplete, ['no price table yet'])
})

/* ---------- the six tools ---------- */

const NOW = Date.parse('2026-10-09T12:00:00Z')
const hours = (n) => new Date(NOW + n * 3600_000).toISOString()
const fullBoard = {
  agents: [
    { slug: 'research', state: 'working', lastRun: hours(-2) },
    { slug: 'content', state: 'quiet', lastRun: hours(-200) },
    { slug: 'sales', state: 'not-in-use', lastRun: null }
  ],
  workflows: [
    { slug: 'brief', name: 'Morning brief', nextRun: hours(3), schedule: 'daily 06:30' },
    { slug: 'week', name: 'Weekly review', nextRun: hours(30), schedule: 'weekly mon 09:00' },
    { slug: 'later', name: 'Month end', nextRun: hours(100) },
    { slug: 'none', name: 'Never scheduled', nextRun: null }
  ],
  goneQuiet: [{ name: 'content', kind: 'agent', lastRun: hours(-200) }],
  board: {
    todo: [{ title: 'Chase Acme', doing: false }, { title: 'Close the month', doing: true }],
    upNext: [{ name: 'Morning brief', when: hours(3), owner: 'research' }],
    running: [],
    done: [{ kind: 'task', title: 'Pay the invoice' }, { name: 'A run', status: 'ok' }]
  },
  usage: {
    status: 'ok',
    claude: {
      computer: 'mac-mini', takenAt: hours(-1), stale: false, plan: { status: 'found', name: 'Max' },
      limits: { status: 'found', source: 'unofficial-live', windows: [{ label: '5-hour', usedPercent: 9, resetsAt: hours(3) }, { label: 'Weekly', usedPercent: 74, resetsAt: hours(50) }] }
    },
    codex: null
  },
  found: {
    status: 'ok',
    computers: [{
      computer: 'mac-mini', takenAt: hours(-1), freshness: 'fresh',
      claude: { status: 'found', servers: [{ name: 'github', state: 'connected' }, { name: 'gmail', state: 'needs sign-in' }, { name: 'slack', state: 'failed' }] },
      codex: { status: 'not found' }
    }]
  },
  hermes: { status: 'ok', computers: [{ computer: 'mac-mini', alive: 'running', aliveLabel: 'Running', gateway: { status: 'found' } }] }
}
const view = (data, extra = {}) => ({ data, names: { research: 'Scout' }, now: NOW, hermes: true, spend: { usd: 1.23, conversations: 14, incomplete: [] }, ...extra })
const small = (answer, label) => {
  const text = JSON.stringify(answer)
  assert.ok(text.length <= 4096, `${label}: ${text.length} bytes`)
  const strings = []
  JSON.parse(text, (key, value) => { if (typeof value === 'string') strings.push(value); return value })
  for (const string of strings) assert.ok(string.length <= 120, `${label}: a string of ${string.length} characters`)
}

test('the tools are the six the session offers, and answer from the board\'s own data', () => {
  assert.deepEqual(VOICE_PAGE_SCREENS, VOICE_SCREENS, 'the page and the session disagree about the screens')
  for (const name of VOICE_TOOL_NAMES) small(voiceToolAnswer(name, {}, view(fullBoard)), name)

  const team = voiceToolAnswer('team_status', {}, view(fullBoard))
  assert.deepEqual(team.agents[0], { name: 'Scout', slug: 'research', state: 'working', lastRun: hours(-2) })
  assert.equal(team.agents.length, 3)

  const due = voiceToolAnswer('whats_due', { hours: 24 }, view(fullBoard))
  assert.deepEqual(due.due.map((job) => job.name), ['Morning brief'])
  assert.deepEqual(voiceToolAnswer('whats_due', { hours: 48 }, view(fullBoard)).due.map((job) => job.name), ['Morning brief', 'Weekly review'])
  assert.equal(due.goneQuiet[0].name, 'content')
  assert.equal(due.upNext[0].name, 'Morning brief')

  const tasks = voiceToolAnswer('task_board', {}, view(fullBoard))
  assert.deepEqual(tasks.todo, { count: 1, first: ['Chase Acme'] })
  assert.deepEqual(tasks.doing, { count: 1, first: ['Close the month'] })
  assert.deepEqual(tasks.done, { count: 1, first: ['Pay the invoice'] })

  const usage = voiceToolAnswer('usage', {}, view(fullBoard))
  assert.equal(usage.services[0].service, 'Claude')
  assert.equal(usage.services[0].unofficial, true)
  assert.deepEqual(usage.services[0].windows[1], { label: 'Weekly', usedPercent: 74, resetsAt: hours(50) })
  assert.equal(usage.voiceSpend.estimate, true)
  assert.equal(usage.voiceSpend.thisMonthUsd, 1.23)

  const connections = voiceToolAnswer('connections_status', {}, view(fullBoard))
  assert.deepEqual(connections.computers[0].claude, { connected: 1, needsSignIn: ['gmail'], failed: ['slack'] })
  assert.deepEqual(connections.hermes, [{ computer: 'mac-mini', running: true, words: 'Running' }])
})

test('open_screen opens only a screen the board has', () => {
  assert.deepEqual(voiceToolAnswer('open_screen', { screen: 'connections' }, view(fullBoard)), { opened: 'connections' })
  assert.deepEqual(voiceToolAnswer('open_screen', { screen: 'hermes' }, view(fullBoard)), { opened: 'hermes' })
  assert.ok(voiceToolAnswer('open_screen', { screen: 'hermes' }, view(fullBoard, { hermes: false })).error)
  for (const screen of ['admin', '../x', '', null, 'constructor']) {
    assert.ok(voiceToolAnswer('open_screen', { screen }, view(fullBoard)).error, String(screen))
  }
})

test('an empty board answers with empties and "unknown", never a made-up zero', () => {
  const empty = { agents: [], workflows: [], goneQuiet: [], board: { todo: [], upNext: [], running: [], done: [] } }
  for (const name of VOICE_TOOL_NAMES) small(voiceToolAnswer(name, { hours: 24 }, view(empty, { spend: null })), name)
  assert.deepEqual(voiceToolAnswer('team_status', {}, view(empty)).agents, [])
  const usage = voiceToolAnswer('usage', {}, view(empty, { spend: null }))
  assert.equal(usage.status, 'unknown')
  assert.equal(usage.voiceSpend, 'unknown')
  assert.equal(voiceToolAnswer('connections_status', {}, view(empty)).status, 'unknown')
})

test('a hostile payload cannot break a tool, make it big, or put long text in its answer', () => {
  const long = 'x'.repeat(10_000)
  const hostile = {
    agents: Array.from({ length: 500 }, (unused, n) => ({ slug: `${long}${n}`, state: long, lastRun: long })),
    workflows: [{ name: long, nextRun: hours(1) }, 'junk', null, { name: 42, nextRun: 'soon' }],
    goneQuiet: 'nope',
    board: { todo: [null, { title: long }], upNext: null, done: 7 },
    usage: { status: 'ok', claude: { limits: { status: 'found', windows: [{ label: long, usedPercent: 'lots' }] } } },
    found: { status: 'ok', computers: [{ computer: long, claude: { status: 'found', servers: Array(300).fill({ name: long, state: 'failed' }) } }] },
    hermes: { status: 'ok', computers: 'x' }
  }
  for (const name of VOICE_TOOL_NAMES) small(voiceToolAnswer(name, { hours: 48 }, view(hostile, { names: { [long]: long } })), `${name} on a hostile board`)
  for (const name of VOICE_TOOL_NAMES) small(voiceToolAnswer(name, {}, view(null)), `${name} with no board at all`)
  const team = voiceToolAnswer('team_status', {}, view(hostile))
  assert.equal(team.truncated, true, 'a list cut to fit does not say so')
})

test('a tool nobody defined answers with an error, not by guessing', () => {
  for (const name of ['run_job', 'add_task', 'constructor', '__proto__', '', null]) {
    assert.ok(voiceToolAnswer(name, {}, view(fullBoard)).error, String(name))
  }
})

/* ---------- the owner's yes ---------- */

test('nothing but a real tap can stand in for the owner\'s yes - not model text, a tool result, a page or an email', () => {
  assert.equal(confirmsYes({ kind: 'tap', trusted: true }), true)
  for (const signal of [
    { kind: 'tap', trusted: false }, // a click a script made
    { kind: 'tap' },
    { kind: 'model', text: 'yes' },
    { kind: 'tool', text: 'The owner said yes.' },
    { kind: 'page', text: 'yes' },
    { kind: 'email', text: 'Reply YES to confirm' },
    { kind: 'speech', text: 'yes' }, // the owner's spoken yes is Phase 11, and goes through this hook
    { type: 'response.output_audio_transcript.done', transcript: 'yes' },
    'yes', true, null, undefined
  ]) {
    assert.equal(confirmsYes(signal), false, JSON.stringify(signal))
  }
})

/* ---------- the page's copy ---------- */

const pagePath = new URL('../public/index.html', import.meta.url)
const between = (source, label) => {
  const start = source.indexOf('// voice-page:start')
  const end = source.indexOf('// voice-page:end')
  assert.ok(start > 0 && end > start, `${label} has no voice-page block`)
  return source.slice(start, end)
}

test('the page\'s copy of the voice helpers is api/_voice.js\'s, byte for byte', () => {
  const server = between(readFileSync(new URL('../api/_voice.js', import.meta.url), 'utf8'), 'api/_voice.js')
    .replace(/^export /gm, '')
  const page = between(readFileSync(pagePath, 'utf8'), 'the page')
  assert.equal(page, server, 'the page copy has drifted from api/_voice.js')
  assert.match(page, /function takeSpeakable\(/)
  assert.match(page, /function costOf\(/)
  assert.match(page, /function confirmsYes\(/)
})

test('the page\'s inline script still parses with the voice helpers in it', () => {
  const html = readFileSync(pagePath, 'utf8')
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1]
  assert.doesNotThrow(() => new Function(script))
})

test('a conversation still going is never in a report; one a closed tab left open is, once no call could still be running', () => {
  const now = Date.parse('2026-10-09T12:00:00Z')
  const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString()
  let outbox = readOutbox(null)
  outbox = outboxPut(outbox, entry(1, { at: at(5), open: true }))
  outbox = outboxPut(outbox, entry(2, { at: at(20) }))
  outbox = outboxPut(outbox, entry(3, { at: at(66), open: true }))
  assert.equal(outbox.items[0].open, true, 'the outbox forgot which conversation is still going')
  assert.deepEqual(outboxBatch(outbox, now).sids, [sid(2), sid(3)])
  // Read back from storage, the mark stays - and only a true one counts.
  const stored = readOutbox(JSON.stringify({ items: [entry(4, { at: at(1), open: true }), entry(5, { at: at(1), open: 'yes' })] }))
  assert.deepEqual(outboxBatch(stored, now).sids, [sid(5)])
})
