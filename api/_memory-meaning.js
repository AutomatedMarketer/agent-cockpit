// Memory search by meaning, the server's side: whether it is on, the one copy of the index this server
// instance holds, one learning step (api/memory-index.js) and one search (api/memory-search.js). Starts
// with "_" so Vercel does not turn it into an endpoint.
//
// What leaves the board, and only when the owner switched it on (MEMORY_MEANING=on; plan D1): the text
// of each team note the board can open, its first 8,000 characters, to OpenAI - once, and again only
// when the note changes - and the words of each search. Not trained on; kept up to 30 days in OpenAI's
// abuse logs. The vectors stay in the private picture store and in this instance's memory: never the
// repo (the board's GitHub token is read-only), never the browser, never an answer.
//
// The limits are there to stop a stuck loop, not to ration the owner (they asked for no monthly cap): a
// step reads at most 200 notes and sends at most 300,000 tokens; a search is 1-300 characters; each
// instance makes at most 30 searches a minute and 1,000 a day. The OpenAI project's own spend limit
// (README, "Set a hard spend limit") is the real ceiling.

import { config, gh, headCommit } from './state.js'
import { spendIndexSave, usageDay, failureAnswer, PictureStoreError } from './_picture-store.js'
import { meaningConfig, MEANING_SAY } from './_meaning-switch.js'
import {
  emptyIndex,
  readIndexFile,
  serialiseIndex,
  eligibleNotes,
  diffIndex,
  withEmbedded,
  noteText,
  scoreIndex,
  INDEX_CAPS
} from './_memory-index.js'
import { embedTexts, estimateTokens, EmbedError } from './_embed.js'
import { hiddenText } from './_voice.js'

export { meaningConfig, MEANING_SAY }

export const MEANING_LIMITS = {
  notesPerStep: 200,
  tokensPerStep: 300_000,
  readsAtOnce: 8,
  queryChars: 300,
  searchesPerMinute: 30,
  searchesPerDay: 1000,
  cachedQueries: 200,
  // The store is read at most once every 10 minutes per instance, as "sign out everywhere" is
  // (api/_gate.js): every read that misses the cache is billed. A failed read is tried after a minute.
  readEveryMs: 10 * 60_000,
  readAgainAfterFailureMs: 60_000,
  // Saved when 6 hours have passed since the last save, or 50 or more notes changed - and never more
  // than twice a UTC day (api/_picture-store.js, INDEX_SAVES_PER_DAY).
  saveEveryMs: 6 * 3600_000,
  saveAfterChanged: 50
}

/* ---------- this instance's copy ---------- */

// The index as this instance last knew it, when it last read the store, and how many notes changed since
// the last save. A warm instance answers from here; a cold one reads the last saved copy.
let held = null
let readAt = -Infinity
let readFailedAt = -Infinity
let changedSinceSave = 0
let stepping = null
// This instance's OpenAI calls for searches: their times in the last minute, and today's count.
const searches = { minute: [], day: '', today: 0 }
// The last MEANING_LIMITS.cachedQueries searches' vectors, by their words, oldest first.
const queryCache = new Map()

// A new instance, as far as this module knows. For the tests.
export function forgetMeaning() {
  held = null
  readAt = -Infinity
  readFailedAt = -Infinity
  changedSinceSave = 0
  stepping = null
  searches.minute = []
  searches.day = ''
  searches.today = 0
  queryCache.clear()
}

async function currentIndex(store, now) {
  if (held && (changedSinceSave > 0 || now - readAt < MEANING_LIMITS.readEveryMs)) return held
  if (!held && now - readFailedAt < MEANING_LIMITS.readAgainAfterFailureMs) throw new PictureStoreError(503, MEANING_SAY.storeDown)
  try {
    const { text } = await store.readIndex()
    held = readIndexFile(text)
    readAt = now
    return held
  } catch (error) {
    if (held) return held
    readFailedAt = now
    throw new PictureStoreError(503, MEANING_SAY.storeDown)
  }
}

const cutCount = (index) => index.entries.filter((entry) => entry.cut).length

/* ---------- reading notes by fingerprint ---------- */

// The exact text that matches a fingerprint, so what is learned is what the tree said. null when GitHub
// does not return it; that note is left for the next step.
async function noteByFingerprint({ owner, repo }, sha) {
  const headers = { Accept: 'application/vnd.github.raw', 'User-Agent': 'agent-cockpit' }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/blobs/${sha}`, { headers })
    return response.ok ? await response.text() : null
  } catch {
    return null
  }
}

async function eachLimited(items, limit, work) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const at = next
      next += 1
      results[at] = await work(items[at])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

// The notes this step may learn, in order: at most 200, and at most 300,000 tokens by the sizes the tree
// gave - decided before anything is read, so nothing is read that is not learned.
function stepNotes(waiting) {
  const chosen = []
  let tokens = 0
  for (const note of waiting) {
    if (chosen.length >= MEANING_LIMITS.notesPerStep) break
    const cost = estimateTokens('x'.repeat(Math.min(note.size, INDEX_CAPS.noteChars) + 200))
    if (chosen.length && tokens + cost > MEANING_LIMITS.tokensPerStep) break
    chosen.push(note)
    tokens += cost
  }
  return chosen
}

/* ---------- saving ---------- */

async function saveIfDue(store, now) {
  if (!held || changedSinceSave === 0) return
  const lastSave = held.savedAt ? Date.parse(held.savedAt) : -Infinity
  if (now - lastSave < MEANING_LIMITS.saveEveryMs && changedSinceSave < MEANING_LIMITS.saveAfterChanged) return
  const moment = new Date(now)
  const mine = held
  let saves = null
  try {
    const saved = await store.saveIndex((storedText) => {
      saves = spendIndexSave(readIndexFile(storedText).saves, usageDay(moment))
      return saves ? serialiseIndex({ ...mine, saves, savedAt: moment.toISOString() }) : null
    })
    if (saved && held === mine) {
      held = { ...mine, saves, savedAt: moment.toISOString() }
      changedSinceSave = 0
    }
  } catch {
    // Kept in this instance's memory; the next step that may save tries again.
  }
}

/* ---------- one learning step ---------- */

function stepAnswer(index, { left, embeddedNow, eligible }) {
  return {
    on: true,
    commit: index.commit,
    indexed: index.entries.length,
    left,
    embeddedNow,
    cut: cutCount(index),
    tooBig: eligible?.tooBig ?? 0,
    past: eligible?.past ?? 0,
    savedAt: index.savedAt
  }
}

async function stepNow({ store, env, now }) {
  const index = await currentIndex(store, now)
  const base = config()
  const head = await headCommit(base)
  if (head !== null && index.commit === head) {
    await saveIfDue(store, now)
    return stepAnswer(held, { left: 0, embeddedNow: 0 })
  }
  const tree = await gh(`/repos/${base.owner}/${base.repo}/git/trees/${head ?? base.branch}?recursive=1`)
  const eligible = eligibleNotes(tree.tree)
  const { keep, embed } = diffIndex(index, eligible.notes)
  const chosen = stepNotes(embed)
  const texts = await eachLimited(chosen, MEANING_LIMITS.readsAtOnce, (note) => noteByFingerprint(base, note.sha))
  const read = chosen.map((note, at) => ({ ...note, text: texts[at] })).filter((note) => typeof note.text === 'string')
  const made = read.map((note) => noteText(note.path, note.text))
  const { vectors } = made.length
    ? await embedTexts(made.map((one) => one.text), { apiKey: env.OPENAI_API_KEY })
    : { vectors: [] }
  // A changed note not learned this step keeps its old vector until it is: found by what it said.
  const learnedPaths = new Set(read.map((note) => note.path))
  const stillWaiting = embed.filter((note) => !learnedPaths.has(note.path))
  const old = new Map(index.entries.map((entry) => [entry.path, entry]))
  const stale = stillWaiting.map((note) => old.get(note.path)).filter(Boolean)
  const next = withEmbedded(index, [...keep, ...stale], read.map((note, at) => ({ path: note.path, sha: note.sha, cut: made[at].cut, vector: vectors[at] })))
  const left = stillWaiting.length
  next.commit = left === 0 ? head : null
  const removed = index.entries.length - keep.length - stale.length - read.filter((note) => old.has(note.path)).length
  held = next
  changedSinceSave += read.length + Math.max(0, removed)
  await saveIfDue(store, now)
  return stepAnswer(held, { left, embeddedNow: read.length, eligible })
}

// One step at a time per instance: a second ask while one runs gets the same answer, never a second
// round of reads and OpenAI calls for the same notes.
export function learnStep({ store, env = process.env, now = Date.now() }) {
  stepping ??= stepNow({ store, env, now }).finally(() => { stepping = null })
  return stepping
}

// How many notes this instance has learned, for an answer that failed part way.
export const meaningIndexed = () => held?.entries.length ?? 0

/* ---------- one search ---------- */

export const SEARCH_SAY = {
  badQuery: 'Search by meaning takes 1 to 300 characters of plain text.',
  tooManyMinute: 'That is more than 30 searches by meaning in a minute, so this one waits: try again in a moment. Word search still works.',
  tooManyDay: 'This board has made 1,000 searches by meaning today, so they wait until midnight UTC. Word search still works.'
}

// The words of a search as the board takes them: 1-300 characters once trimmed, nothing hidden
// (api/_voice.js's one rule for text a person cannot see). null for anything else.
export function cleanQuery(value) {
  if (typeof value !== 'string') return null
  const words = value.replace(/\s+/g, ' ').trim()
  if (!words || words.length > MEANING_LIMITS.queryChars || hiddenText(value) || /[\x00-\x1f\x7f]/.test(words)) return null
  return words
}

const cacheKey = (words) => words.toLowerCase()

// Counted only when OpenAI is asked - a repeat answered from memory costs nothing, so it is never refused.
function spendSearch(now) {
  const day = usageDay(new Date(now))
  if (searches.day !== day) {
    searches.day = day
    searches.today = 0
  }
  searches.minute = searches.minute.filter((at) => now - at < 60_000)
  if (searches.today >= MEANING_LIMITS.searchesPerDay) {
    const midnight = Date.parse(`${day}T00:00:00Z`) + 24 * 3600_000
    throw new EmbedError(429, SEARCH_SAY.tooManyDay, { retryAfter: Math.max(1, Math.ceil((midnight - now) / 1000)) })
  }
  if (searches.minute.length >= MEANING_LIMITS.searchesPerMinute) {
    throw new EmbedError(429, SEARCH_SAY.tooManyMinute, { retryAfter: Math.max(1, Math.ceil((searches.minute[0] + 60_000 - now) / 1000)) })
  }
  searches.minute.push(now)
  searches.today += 1
}

// { on, ready, commit, indexed, hits: [[path, similarity]] }, or { on, ready: false, indexed: 0 } before
// anything is learned - when OpenAI is not asked at all. Never a vector.
export async function searchByMeaning({ store, env = process.env, words, now = Date.now() }) {
  const index = await currentIndex(store, now)
  if (!index.entries.length) return { on: true, ready: false, indexed: 0 }
  const key = cacheKey(words)
  let vector = queryCache.get(key)
  if (vector) {
    queryCache.delete(key)
  } else {
    spendSearch(now)
    vector = (await embedTexts([words], { apiKey: env.OPENAI_API_KEY })).vectors[0]
  }
  queryCache.set(key, vector)
  while (queryCache.size > MEANING_LIMITS.cachedQueries) queryCache.delete(queryCache.keys().next().value)
  return { on: true, ready: true, commit: index.commit, indexed: index.entries.length, hits: scoreIndex(index, vector) }
}

// Any failure of a step or a search as the board says it: { status, retryAfter?, body }. OpenAI's and the
// store's are already our sentences; GitHub's rate limit gives its wait; anything else is one sentence.
export function meaningFailure(error) {
  if (error instanceof EmbedError) {
    return { status: error.status, retryAfter: error.retryAfter, body: { on: true, error: error.message, ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) } }
  }
  if (error instanceof PictureStoreError) {
    const { status, error: sentence } = failureAnswer(error)
    return { status, body: { on: true, error: sentence } }
  }
  if (error?.retryAfter !== undefined) {
    return { status: 429, retryAfter: error.retryAfter, body: { on: true, error: `GitHub's rate limit was reached. Try again in ${error.retryAfter} seconds.`, retryAfter: error.retryAfter } }
  }
  return { status: error?.ours && error.status !== 404 ? 500 : 502, body: { on: true, error: error?.ours ? error.message : MEANING_SAY.github } }
}

