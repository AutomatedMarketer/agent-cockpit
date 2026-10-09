// The Voice spend card in Today's Usage section, the live estimate's partner: what it says in every
// state the meter can be in, that "estimate" is always in plain view, where it sits, and when the
// page reports the device's conversations to the board - once when a call ends, once when the board
// opens with any waiting, never by asking for a key.

import test from 'node:test'
import assert from 'node:assert/strict'
import { cssRules } from './helpers/css-rules.mjs'
import { loadPage, flush, classesIn } from './helpers/page-harness.mjs'
import { basePayload, brandAnswer, VOICE_ON } from './helpers/page-payload.mjs'
import { VOICE_PRICES, PRICES_CHECKED } from '../api/_voice-prices.js'
import { TRANSCRIBE_MODEL } from '../api/_voice.js'

const OUTBOX = 'agent-cockpit-voice-outbox'
const PRICES = { checked: PRICES_CHECKED, transcribeModel: TRANSCRIBE_MODEL, ...structuredClone(VOICE_PRICES) }
const thisMonth = new Date().toISOString().slice(0, 7)
const sid = (n) => n.toString(16).padStart(32, '0')
const entry = (n, over = {}) => ({
  ticket: `body${n}.sig`, sid: sid(n), at: new Date().toISOString(), model: 'gpt-realtime-2.1-mini', mouth: 'openai',
  counts: { textIn: 0, cachedTextIn: 0, audioIn: 0, cachedAudioIn: 0, textOut: 0, audioOut: 1200, transcribeTextIn: 0, transcribeAudioIn: 0, transcribeOut: 0, fishBytes: 0 },
  ...over
})
const outboxOf = (...entries) => JSON.stringify({ version: 1, items: entries })
const meterOn = (over = {}) => ({
  store: true,
  thisMonth: { month: thisMonth, conversations: 14, usd: 1.23, incomplete: [], fishBytes: {}, ...over.thisMonth },
  last: { at: new Date().toISOString(), usd: 0.08, incomplete: [], model: 'gpt-realtime-2.1-mini', mouth: 'openai', fishBytes: 0, ...over.last },
  writesLeftToday: 5,
  prices: PRICES,
  ...over.top
})

// A browser that answers the board, /api/brand with voice on (unless told otherwise), and the meter.
function board({ voice = VOICE_ON, meter = meterOn(), report = () => ({ ok: true, status: 200, answer: { store: true, accepted: [], kept: [], refused: [] } }), storage = {}, prompt } = {}) {
  const posts = []
  const fetch = async (url, init = {}) => {
    if (url.startsWith('/api/brand')) return { ok: true, status: 200, json: async () => brandAnswer({ voice }) }
    if (url.startsWith('/api/voice-meter') && init.method === 'POST') {
      posts.push(JSON.parse(init.body))
      const { ok, status, answer } = report(JSON.parse(init.body))
      return { ok, status, json: async () => answer }
    }
    if (url.startsWith('/api/voice-meter')) return { ok: true, status: 200, json: async () => meter }
    return { ok: true, status: 200, json: async () => basePayload() }
  }
  const page = loadPage({ fetch, storage, prompt, expose: ['voiceSpendInnerHtml', 'voiceSpendNow', 'voiceDeps', 'sendVoiceReports'], after: 'given.set = (value) => { voiceMeter = value }', given: {} })
  return { page, posts }
}

async function cardWith(meter, storage = {}) {
  const { page } = board({ meter, storage })
  await flush()
  return page.exposed.voiceSpendInnerHtml()
}
const text = (markup) => markup.replace(/<[^>]+>/g, '').replace(/&middot;/g, '·').replace(/&mdash;/g, '—').replace(/&rsquo;/g, '\'').replace(/&times;/g, '×').replace(/&hellip;/g, '…').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

/* ---------- what the card says ---------- */

test('the card says this month\'s total, how many conversations and the last one, as an estimate', async () => {
  const card = text(await cardWith(meterOn()))
  assert.match(card, /^Voice spend/)
  assert.match(card, /This month ≈ \$1\.23 · 14 conversations · last one ≈ \$0\.08/)
  assert.match(card, new RegExp(`estimate From OpenAI's own token counts × prices checked ${PRICES_CHECKED}\\. Your bill is at platform\\.openai\\.com\\.`))
})

test('every state of the meter has its own words, and none of them is a zero it did not read', async () => {
  assert.match(text(await cardWith(meterOn({ thisMonth: { conversations: 0, usd: 0 }, last: null, top: {} }))), /No conversations yet this month\./)
  assert.match(text(await cardWith(meterOn({ thisMonth: { incomplete: ['gpt-realtime-2.1-mini audio out'] } }))),
    /Incomplete: no price yet for gpt-realtime-2.1-mini audio out, so the real cost is higher\./)
  assert.match(text(await cardWith(meterOn({ thisMonth: { fishBytes: { 's2.1-pro-free': 8200 } } }))), /Fish: about 8,200 characters \(free model, \$0\)/)
  assert.match(text(await cardWith({ store: true, damaged: true, why: 'The voice meter\'s file is damaged: delete it.', prices: PRICES })), /The voice meter's file is damaged: delete it\./)
  const waiting = text(await cardWith(meterOn(), { [OUTBOX]: outboxOf(entry(1), entry(2), entry(3)) }))
  assert.match(waiting, /3 conversations on this device not recorded yet\./)
  const device = text(await cardWith({ store: false, why: 'No store.', prices: PRICES }, { [OUTBOX]: outboxOf(entry(1), entry(2)) }))
  assert.match(device, /This month ≈ \$0\.05 · 2 conversations/)
  assert.match(device, /This device only — connect a picture store to keep one total across your devices\./)
  assert.match(text(await cardWith({ store: false, prices: PRICES })), /No conversations yet this month\./)
})

test('before the meter answers, the card says it is reading it, never a total', () => {
  // Read straight after the page loads, before the board or the meter has answered.
  const { page } = board()
  const card = text(page.exposed.voiceSpendInnerHtml())
  assert.match(card, /Reading the voice meter…/)
  assert.doesNotMatch(card, /\$/, 'a total was shown before the meter said one')
})

test('"estimate" is always in plain view, never only inside a Why?', async () => {
  for (const meter of [meterOn(), meterOn({ thisMonth: { conversations: 0, usd: 0 } }), { store: false, prices: PRICES }, { store: true, damaged: true, why: 'x', prices: PRICES }, null]) {
    const markup = await cardWith(meter)
    const outsideWhy = markup.replace(/<details class="why">[\s\S]*?<\/details>/g, '')
    assert.match(outsideWhy, /<span class="chip">estimate<\/span>/, `${JSON.stringify(meter)?.slice(0, 40)}: no estimate label in view`)
  }
})

test('money is never more exact than the estimate: under a cent says so, the rest to the cent', async () => {
  assert.match(text(await cardWith(meterOn({ thisMonth: { usd: 0.004 }, last: { usd: 0.004 } }))), /This month under \$0\.01 · 14 conversations · last one under \$0\.01/)
  assert.match(text(await cardWith(meterOn({ thisMonth: { usd: 12.345 } }))), /This month ≈ \$12\.35|This month ≈ \$12\.34/)
  assert.match(text(await cardWith(meterOn({ thisMonth: { usd: 0, conversations: 2 } }))), /This month ≈ \$0\.00 · 2 conversations/)
})

test('everything the server or the store said is escaped', async () => {
  const hostile = '<img src=x onerror=alert(1)>'
  const markups = [
    await cardWith({ store: true, damaged: true, why: hostile, prices: PRICES }),
    await cardWith(meterOn({ thisMonth: { incomplete: [hostile] } })),
    await cardWith({ ...meterOn(), prices: { ...PRICES, checked: hostile } }),
    await cardWith(meterOn({ thisMonth: { fishBytes: { [hostile]: 10 } } }))
  ]
  for (const markup of markups) assert.ok(!markup.includes('<img'), `markup went in: ${markup.slice(0, 80)}`)
})

/* ---------- where it sits ---------- */

test('the card sits in Today\'s Usage section, after Plan limits and Subscriptions - and only while voice is on', async () => {
  const { page } = board()
  await flush()
  const today = page.node('today').innerHTML
  const at = (pattern) => today.search(pattern)
  assert.ok(at(/<section class="plan-limits">/) >= 0)
  assert.ok(at(/<h2>Usage<\/h2>/) > at(/<section class="plan-limits">/))
  assert.ok(at(/<section class="panel card subs">/) > at(/<h2>Usage<\/h2>/))
  assert.ok(at(/<section class="panel card voice-spend" id="voice-spend">/) > at(/<section class="panel card subs">/), 'the card is not after Subscriptions')
  const { page: off } = board({ voice: { on: false, why: 'No key.' } })
  await flush()
  assert.ok(!off.node('today').innerHTML.includes('voice-spend'), 'the card is drawn with voice off')
})

test('every class the card puts in the markup is one the stylesheet styles', async () => {
  const rules = cssRules()
  const used = new Set()
  for (const meter of [meterOn({ thisMonth: { incomplete: ['x'], fishBytes: { 's2.1-pro-free': 5 } } }), { store: false, prices: PRICES }])
    for (const name of classesIn(await cardWith(meter, { [OUTBOX]: outboxOf(entry(1)) }))) used.add(name)
  for (const name of ['voice-spend-total', 'voice-spend-line', 'voice-spend-warn', 'voice-spend-note']) assert.ok(used.has(name), `${name} was never drawn`)
  for (const name of used) assert.ok(rules.some((rule) => new RegExp(`\\.${name}(?![\\w-])`).test(rule.selector)), `class "${name}" has no rule`)
  assert.ok(rules.some((rule) => /\.voice-spend(?![\w-])/.test(rule.selector)))
})

/* ---------- reporting ---------- */

test('when the board opens with conversations waiting, it reports them once, and clears only what was counted', async () => {
  const waiting = { [OUTBOX]: outboxOf(entry(1), entry(2), entry(3)) }
  const { page, posts } = board({
    storage: waiting,
    report: (body) => ({ ok: true, status: 200, answer: { store: true, accepted: [sid(1)], kept: [sid(2)], refused: [{ at: 2, why: 'bad' }], meter: meterOn({ thisMonth: { conversations: 15 } }) } })
  })
  await flush(10)
  assert.equal(posts.length, 1, `${posts.length} reports at boot`)
  assert.deepEqual(posts[0].reports.map((report) => report.ticket), ['body1.sig', 'body2.sig', 'body3.sig'])
  assert.deepEqual(Object.keys(posts[0].reports[0]).sort(), ['counts', 'ticket'], 'a report carries more than its ticket and counts')
  const left = JSON.parse(page.storage.getItem(OUTBOX)).items.map((item) => item.sid)
  assert.deepEqual(left, [sid(2)], 'the outbox kept something counted, or lost something kept')
  assert.equal(page.exposed.voiceSpendNow().conversations, 15, 'the card did not take the meter the report came back with')
})

test('with nothing waiting, opening the board sends no report at all', async () => {
  const { posts } = board()
  await flush(10)
  assert.equal(posts.length, 0)
})

test('when a call ends, the conversation is reported once', async () => {
  const { page, posts } = board({ report: () => ({ ok: true, status: 200, answer: { store: true, accepted: [sid(9)], kept: [], refused: [] } }) })
  await flush(10)
  page.storage.setItem(OUTBOX, outboxOf(entry(9)))
  page.exposed.voiceDeps().onEnd('stopped')
  await flush(10)
  assert.equal(posts.length, 1)
  assert.deepEqual(JSON.parse(page.storage.getItem(OUTBOX)).items, [])
})

test('a report the board refuses keeps everything, and never asks for the edit key', async () => {
  let asked = 0
  const { page, posts } = board({
    storage: { [OUTBOX]: outboxOf(entry(1)) },
    prompt: () => { asked += 1; return 'key' },
    report: () => ({ ok: false, status: 401, answer: { needs: 'edit-key', error: 'Missing or wrong edit key.' } })
  })
  await flush(10)
  assert.equal(posts.length, 1)
  assert.equal(asked, 0, 'a report nobody pressed anything for asked for the edit key')
  assert.equal(JSON.parse(page.storage.getItem(OUTBOX)).items.length, 1)
})

test('with voice off, the meter is never asked and nothing is reported', async () => {
  const { page, posts } = board({ voice: { on: false, why: 'No key.' }, storage: { [OUTBOX]: outboxOf(entry(1)) } })
  await flush(10)
  assert.equal(posts.length, 0)
  assert.ok(!page.requests.some((request) => request.url.startsWith('/api/voice-meter')))
})

test('the usage tool hears this month\'s spend: the board\'s total, or this device\'s with no store', async () => {
  const { page } = board()
  await flush(10)
  assert.deepEqual(page.exposed.voiceSpendNow(), { usd: 1.23, conversations: 14, incomplete: [] })
  const { page: device } = board({ meter: { store: false, prices: PRICES }, storage: { [OUTBOX]: outboxOf(entry(1)) } })
  await flush(10)
  assert.equal(device.exposed.voiceSpendNow().conversations, 1)
  assert.equal(device.exposed.voiceDeps().view().spend.conversations, 1)
})
