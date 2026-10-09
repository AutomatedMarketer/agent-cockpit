// /api/voice-meter: the voice spend meter (Phase 10). There is no cap on voice - the owner's choice -
// so this is how they see what it costs. It is a METER, not a guard, and an estimate: OpenAI's own
// token counts for each reply, times the rates in api/_voice-prices.js. The bill is at
// platform.openai.com, and the hard spend limit on the OpenAI project is what actually stops spending.
//
// GET (the view key): this month's total, the last conversation, anything the table could not price,
// how many meter writes are left today, and the price table itself - so the page can show a live
// estimate while you talk without keeping a second copy of any price.
//
// POST (the write gate): { reports: [{ ticket, counts }, ...] }, at most 20, sent by the page when a
// conversation ends, or when the board opens with conversations still in the device's outbox. For
// each: the ticket must be one this server signed for a voice session in the last 35 days; the
// counts must be whole numbers no bigger than one conversation could make; the session must not
// already be counted. The page sends counts, never money - any dollar figure in a report is ignored -
// and the server prices them. Then ONE save for the whole batch, and only if there is something new.
//
// The answer says which sessions were counted (accepted - the page clears them from its outbox),
// which must wait (kept - the day's meter writes are used up, there is no store, or it failed), and
// which can never count (refused, by position, with why - the page drops them). Anyone holding the
// keys could still send made-up counts; the checks keep the numbers plausible, not true.
//
// Every answer carries `private, no-store`.

import { viewGate, writeGate, readJsonBody } from './lib.js'
import {
  pictureStore,
  failureAnswer,
  usageDay,
  meterWritesLeft,
  spendMeterWrite
} from './_picture-store.js'
import { readTicket, costOf, METER_TICKET_MS, TRANSCRIBE_MODEL, MAX_REPLY_TOKENS } from './_voice.js'
import { VOICE_PRICES, PRICES_CHECKED } from './_voice-prices.js'

export const MAX_REPORTS = 20

// The most one conversation could plausibly use of each count. OpenAI ends a session at 60 minutes;
// user audio is about 10 tokens a second and the assistant's about 20 (realtime-costs). Every reply
// re-sends the whole conversation, so input grows with each one: the input ceilings allow a reply
// every two seconds for the hour, each carrying a long conversation. These stop nonsense - a number
// pasted in by hand, an overflow - not a key holder who wants to lie, which no check here can.
const HOUR_SECONDS = 60 * 60
const USER_AUDIO_PER_SECOND = 10
const ASSISTANT_AUDIO_PER_SECOND = 20
const HOUR_OF_REPLIES = HOUR_SECONDS / 2
const LONG_CONTEXT = 128_000
const INPUT_CEILING = HOUR_OF_REPLIES * LONG_CONTEXT
// Captions are short; the whole hour of them is far under this.
const CAPTION_CEILING = 100_000
// An hour of replies, each a few sentences, as UTF-8 bytes.
const FISH_BYTES_CEILING = 3_000_000
export const COUNT_CEILINGS = {
  textIn: INPUT_CEILING,
  cachedTextIn: INPUT_CEILING,
  audioIn: INPUT_CEILING,
  cachedAudioIn: INPUT_CEILING,
  textOut: HOUR_OF_REPLIES * MAX_REPLY_TOKENS,
  audioOut: HOUR_SECONDS * ASSISTANT_AUDIO_PER_SECOND,
  transcribeTextIn: CAPTION_CEILING,
  transcribeAudioIn: HOUR_SECONDS * USER_AUDIO_PER_SECOND,
  transcribeOut: CAPTION_CEILING,
  fishBytes: FISH_BYTES_CEILING
}

const WHY = {
  report: 'This is not a voice report the board can read.',
  ticket: 'This conversation\'s ticket is not one this board gave out in the last 35 days, so it cannot be counted.',
  counts: 'This conversation\'s counts are not numbers one conversation could make, so it was not counted.',
  noStore: 'No picture store is connected, so the meter is kept on this device only.',
  spent: 'The voice meter has used the store writes it may have today, so these conversations are kept on this device and recorded with the next one.'
}

const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7)

// The counts as the meter keeps them: every known field a whole number, zero or more, under its
// ceiling, and no Fish characters on a session that spoke with OpenAI's voice. Unknown fields - a
// dollar figure, anything else - are not read at all. Null when anything is wrong.
function cleanCounts(raw, mouth) {
  if (!plainObject(raw)) return null
  const counts = {}
  for (const [field, ceiling] of Object.entries(COUNT_CEILINGS)) {
    const value = raw[field] ?? 0
    if (!Number.isInteger(value) || value < 0 || value > ceiling) return null
    counts[field] = value
  }
  if (mouth !== 'fish' && counts.fishBytes > 0) return null
  return counts
}

// The price table as the page needs it: every rate, its source and date, and which model captions use.
const pricesView = () => ({ checked: PRICES_CHECKED, transcribeModel: TRANSCRIBE_MODEL, ...structuredClone(VOICE_PRICES) })

// What the page is shown: this month and the last conversation, in dollars. Never the session ids.
function meterView(meter, { env, now }) {
  const month = monthOf(now.getTime())
  const kept = meter.months[month]
  const last = meter.last
  return {
    store: true,
    thisMonth: {
      month,
      conversations: kept?.conversations ?? 0,
      usd: (kept?.micros ?? 0) / 1e6,
      incomplete: kept?.incomplete ?? [],
      fishBytes: { ...(kept?.fishBytes ?? {}) }
    },
    last: last
      ? { at: last.at, usd: last.micros / 1e6, incomplete: last.incomplete, model: last.model, mouth: last.mouth, fishBytes: last.fishBytes }
      : null,
    writesLeftToday: meterWritesLeft(meter, env, usageDay(now)),
    prices: pricesView()
  }
}

// A meter that cannot be read, said - never shown as zero.
const faultView = (error) => ({ store: true, damaged: true, why: failureAnswer(error).error, prices: pricesView() })

// Adds one checked report to the meter: its month, its money, what could not be priced, its Fish
// characters, its session id, and the last conversation if it is the newest.
function record(meter, report) {
  const { ticket, counts, cost } = report
  const month = (meter.months[monthOf(ticket.iat)] ??= { conversations: 0, micros: 0, incomplete: [], fishBytes: {}, sids: [] })
  month.conversations += 1
  month.micros += cost.micros
  month.incomplete = [...new Set([...month.incomplete, ...cost.incomplete])]
  if (counts.fishBytes > 0) month.fishBytes[ticket.fishModel] = (month.fishBytes[ticket.fishModel] ?? 0) + counts.fishBytes
  month.sids.push(ticket.sid)
  if (!meter.last || Date.parse(meter.last.at) <= ticket.iat) {
    meter.last = {
      sid: ticket.sid,
      at: new Date(ticket.iat).toISOString(),
      micros: cost.micros,
      incomplete: cost.incomplete,
      model: ticket.model,
      mouth: ticket.mouth,
      fishBytes: counts.fishBytes
    }
  }
}

const counted = (meter, report) => Boolean(meter.months[monthOf(report.ticket.iat)]?.sids.includes(report.ticket.sid))

// `store` is injected by the tests; left undefined, it is built from the environment on each request
// (null when no store is connected).
export function makeHandler({ store, env, now = () => new Date(), loadSdk } = {}) {
  return async function handler(request, response) {
    const environment = env ?? process.env
    // First, before any answer can be sent: nothing this endpoint says may be kept by a shared cache.
    response.setHeader('Cache-Control', 'private, no-store')
    const method = String(request?.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'POST') {
      response.setHeader('Allow', 'GET, POST')
      response.status(405).json({ error: 'GET to read the voice meter, POST { "reports": [...] } to add to it.' })
      return
    }
    const denied = method === 'GET' ? viewGate(request, environment) : writeGate(request, environment)
    if (denied) {
      const { status, ...answer } = denied
      response.status(status).json(answer)
      return
    }
    const moment = now()
    const context = { env: environment, now: moment }
    const pictures = store !== undefined ? store : pictureStore(environment, loadSdk)

    if (method === 'GET') {
      if (!pictures) {
        response.status(200).json({ store: false, why: WHY.noStore, prices: pricesView() })
        return
      }
      try {
        const { meter } = await pictures.readMeter()
        response.status(200).json(meterView(meter, context))
      } catch (error) {
        response.status(200).json(faultView(error))
      }
      return
    }

    // A ticket is checked against the key it was signed with; without the key nothing can be.
    const apiKey = environment.OPENAI_API_KEY
    if (!apiKey) {
      response.status(503).json({ error: 'Voice reports need OPENAI_API_KEY, the key their tickets were signed with.' })
      return
    }
    const body = readJsonBody(request)
    if (!Array.isArray(body?.reports) || body.reports.length > MAX_REPORTS) {
      response.status(400).json({ error: `Send { "reports": [...] } with at most ${MAX_REPORTS} reports.` })
      return
    }

    const checked = []
    const refused = []
    const seen = new Set()
    body.reports.forEach((raw, at) => {
      if (!plainObject(raw)) return refused.push({ at, why: WHY.report })
      const ticket = readTicket(raw.ticket, apiKey, { now: moment.getTime(), maxAgeMs: METER_TICKET_MS })
      if (!ticket) return refused.push({ at, why: WHY.ticket })
      const counts = cleanCounts(raw.counts, ticket.mouth)
      if (!counts) return refused.push({ at, why: WHY.counts })
      // The same conversation twice in one batch is one conversation.
      if (seen.has(ticket.sid)) return undefined
      seen.add(ticket.sid)
      const models = { model: ticket.model, transcribeModel: TRANSCRIBE_MODEL, fishModel: ticket.fishModel }
      checked.push({ ticket, counts, cost: costOf(counts, models, VOICE_PRICES) })
      return undefined
    })
    const sids = (reports) => reports.map((report) => report.ticket.sid)

    if (!pictures) {
      response.status(200).json({ store: false, accepted: [], kept: sids(checked), refused, why: WHY.noStore })
      return
    }
    const keepAll = (why, meter = null) =>
      response.status(200).json({ store: true, accepted: [], kept: sids(checked), refused, why, ...(meter ? { meter } : {}) })

    try {
      // First against the cached copy, so a batch already counted, or a day already spent, costs a
      // cache hit rather than a read that skips it. The cached copy can only be behind the real one.
      const { meter: shown } = await pictures.readMeter()
      if (checked.every((report) => counted(shown, report))) {
        response.status(200).json({ store: true, accepted: sids(checked), kept: [], refused, meter: meterView(shown, context) })
        return
      }
      if (meterWritesLeft(shown, environment, usageDay(moment)) === 0) {
        keepAll(WHY.spent, meterView(shown, context))
        return
      }
      let saved = null
      try {
        saved = await pictures.saveMeter((draft) => {
          const adding = checked.filter((report) => !counted(draft, report))
          // Everything was counted by another device meanwhile: stop the save, write nothing.
          if (!adding.length) throw NOTHING_NEW
          spendMeterWrite(draft, environment, usageDay(moment))
          for (const report of adding) record(draft, report)
        })
      } catch (error) {
        if (error !== NOTHING_NEW) throw error
      }
      const meter = saved ?? (await pictures.readMeter()).meter
      response.status(200).json({ store: true, accepted: sids(checked), kept: [], refused, meter: meterView(meter, context) })
    } catch (error) {
      // The day's writes spent at the last moment, a store that fails, a damaged meter: all wait.
      keepAll(failureAnswer(error).error)
    }
  }
}

// Thrown inside a save to stop it when there is nothing new to count.
const NOTHING_NEW = new Error('nothing new to count')

export default makeHandler()
