// The voice spend meter's money: one price table (api/_voice-prices.js), and costOf, which turns a
// conversation's token counts into dollars. The page sends counts, never dollars; the server - and,
// for the live estimate in the sheet, the page with the table the server hands it - multiplies.
//
// What these tests hold it to: worked examples from usage shaped exactly like OpenAI's documented
// response.done; cached tokens priced as cached and never twice; a rate nobody has sourced makes the
// total INCOMPLETE, never $0; Fish's free model is $0 with its bytes still counted; every price has
// a source and a date beside it; and no price lives anywhere else.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { VOICE_PRICES, PRICES_CHECKED } from '../api/_voice-prices.js'
import { costOf, VOICE_MODELS, TRANSCRIBE_MODEL, FISH_MODELS } from '../api/_voice.js'

const MINI = { model: 'gpt-realtime-2.1-mini', transcribeModel: TRANSCRIBE_MODEL }
const FULL = { model: 'gpt-realtime-2.1', transcribeModel: TRANSCRIBE_MODEL }

// OpenAI's documented response.done usage (realtime-costs): 119 text tokens in, 64 of them cached;
// 13 audio in; 30 text and 91 audio out. As counts: 55 uncached text, 64 cached text.
const DOC_REPLY = { textIn: 55, cachedTextIn: 64, audioIn: 13, cachedAudioIn: 0, textOut: 30, audioOut: 91 }

test('the documented reply costs what the price page says, on both models', () => {
  // mini: 55 x 0.60 + 64 x 0.06 + 13 x 10 + 30 x 2.40 + 91 x 20 = 2,058.84 millionths of a dollar.
  const mini = costOf(DOC_REPLY, MINI, VOICE_PRICES)
  assert.equal(mini.micros, 2059)
  assert.equal(mini.usd, 0.002059)
  assert.deepEqual(mini.incomplete, [])
  // full: 55 x 4 + 64 x 0.40 + 13 x 32 + 30 x 24 + 91 x 64 = 7,205.6.
  assert.equal(costOf(DOC_REPLY, FULL, VOICE_PRICES).micros, 7206)
})

test('a minute of OpenAI\'s voice answering costs about what the rates say it should', () => {
  // 60 s of assistant audio is 1,200 tokens (1 per 50 ms): $0.024 on mini at $20 per million.
  assert.equal(costOf({ audioOut: 1200 }, MINI, VOICE_PRICES).usd, 0.024)
})

test('cached tokens are priced as cached, and never counted twice', () => {
  const uncached = costOf({ textIn: 1_000_000 }, MINI, VOICE_PRICES).usd
  const cached = costOf({ cachedTextIn: 1_000_000 }, MINI, VOICE_PRICES).usd
  assert.equal(uncached, 0.6)
  assert.equal(cached, 0.06)
  assert.equal(costOf({ textIn: 1_000_000, cachedTextIn: 1_000_000 }, MINI, VOICE_PRICES).usd, 0.66)
  assert.equal(costOf({ cachedAudioIn: 1_000_000 }, MINI, VOICE_PRICES).usd, 0.3)
})

test('captions are priced from the transcription model\'s own rates', () => {
  const captions = costOf({ transcribeAudioIn: 1_000_000, transcribeOut: 1_000_000 }, MINI, VOICE_PRICES)
  assert.equal(captions.usd, 6.25)
  assert.deepEqual(captions.incomplete, [])
})

test('a rate nobody has sourced makes the total incomplete - never $0 - and only when there is something to price', () => {
  const prices = structuredClone(VOICE_PRICES)
  prices.realtime['gpt-realtime-2.1-mini'].audioOut = null
  const cost = costOf(DOC_REPLY, MINI, prices)
  assert.deepEqual(cost.incomplete, ['gpt-realtime-2.1-mini audio out'])
  assert.equal(cost.micros, 239, 'the rest is still counted (2,058.84 less 91 x 20)')
  assert.deepEqual(costOf({ ...DOC_REPLY, audioOut: 0 }, MINI, prices).incomplete, [], 'nothing to price was called incomplete')
  // The transcription text-in rate is not on OpenAI's page: unpriced, and harmless while it is 0.
  assert.equal(VOICE_PRICES.transcription[TRANSCRIBE_MODEL].textIn, null)
  assert.deepEqual(costOf({ transcribeTextIn: 5 }, MINI, VOICE_PRICES).incomplete, [`captions (${TRANSCRIBE_MODEL}) text in`])
})

test('a model the table does not know prices nothing and says so for everything it used', () => {
  const cost = costOf(DOC_REPLY, { model: 'gpt-realtime-9', transcribeModel: 'nope' }, VOICE_PRICES)
  assert.equal(cost.micros, 0)
  assert.equal(cost.incomplete.length, 5, 'every non-zero count of an unknown model is unpriced')
})

test('Fish\'s free model is $0 with its bytes still counted; the paid model is $15 a million bytes', () => {
  const free = costOf({ fishBytes: 8200 }, { ...MINI, fishModel: 's2.1-pro-free' }, VOICE_PRICES)
  assert.equal(free.micros, 0)
  assert.deepEqual(free.incomplete, [])
  assert.equal(free.fishBytes, 8200)
  const paid = costOf({ fishBytes: 1_000_000 }, { ...MINI, fishModel: 's2.1-pro' }, VOICE_PRICES)
  assert.equal(paid.usd, 15)
})

test('counts that are not whole, positive numbers count for nothing rather than for something', () => {
  for (const wrong of [-5, 1.5, '100', null, NaN, Infinity]) {
    assert.equal(costOf({ audioOut: wrong }, MINI, VOICE_PRICES).micros, 0, String(wrong))
  }
})

test('every price has a source address and the date it was checked; the table covers every model the board uses', () => {
  const rows = [
    ...Object.entries(VOICE_PRICES.realtime),
    ...Object.entries(VOICE_PRICES.transcription),
    ...Object.entries(VOICE_PRICES.fish)
  ]
  assert.ok(rows.length >= 5)
  for (const [name, row] of rows) {
    assert.match(row.source, /^https:\/\/[a-z0-9.-]+\//, `${name} has no source address`)
    assert.match(row.checked, /^\d{4}-\d{2}-\d{2}$/, `${name} has no date checked`)
    for (const [field, value] of Object.entries(row)) {
      if (['source', 'checked', 'note'].includes(field)) continue
      assert.ok(value === null || (typeof value === 'number' && value >= 0), `${name}.${field} is not a price or null`)
    }
  }
  assert.match(PRICES_CHECKED, /^\d{4}-\d{2}-\d{2}$/)
  for (const model of VOICE_MODELS) assert.ok(VOICE_PRICES.realtime[model], `no row for ${model}`)
  assert.ok(VOICE_PRICES.transcription[TRANSCRIBE_MODEL], `no row for ${TRANSCRIBE_MODEL}`)
  for (const model of FISH_MODELS) assert.ok(VOICE_PRICES.fish[model], `no row for ${model}`)
  assert.equal(VOICE_PRICES.fish['s2.1-pro-free'].perMillionBytes, 0)
})

test('no price lives anywhere but api/_voice-prices.js - not in another function, not in the page', () => {
  const RATE = /\b(?:textIn|cachedTextIn|audioIn|cachedAudioIn|textOut|audioOut|perMillionBytes)\s*:\s*\d/
  const PER_MILLION = /\$\s?\d+(?:\.\d+)?\s*(?:\/|per|a)\s*(?:1M|million)/i
  const files = readdirSync(new URL('../api/', import.meta.url))
    .filter((name) => name.endsWith('.js') && name !== '_voice-prices.js')
    .map((name) => [`api/${name}`, readFileSync(new URL(`../api/${name}`, import.meta.url), 'utf8')])
  files.push(['public/index.html', readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')])
  for (const [name, source] of files) {
    assert.doesNotMatch(source, RATE, `${name} writes a price of its own`)
    assert.doesNotMatch(source, PER_MILLION, `${name} writes a price of its own`)
  }
  // The control: the table itself is caught by the same patterns, so they are not matching nothing.
  assert.match(readFileSync(new URL('../api/_voice-prices.js', import.meta.url), 'utf8'), RATE)
})
