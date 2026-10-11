// The meaning index, pure: which notes are learned, the text each is learned from, the one-byte packing,
// what changed since the last build, how a search is scored, and how the stored file is read back.
// Starts with "_" so Vercel does not turn it into an endpoint. No network and no store here: the two
// endpoints (api/memory-index.js, api/memory-search.js) do the calling, through api/_memory-meaning.js.
//
// What is learned: a team note the board can already open (api/file.js's safePath), 64 KB or less, at
// most 2,000 of them in the graph's order. The same rule as word search - search only what the board
// could show - so a note found is a note that opens. Nothing in .claude/ (the board refuses to open it),
// and nothing from a computer's vaults: their contents never leave the computer (plan D2).
//
// A note's vector is a blurred copy of the note, never a safe summary: published attacks rebuild text
// from vectors (plan, finding 14). So the index lives only in the private picture store, is never sent
// to the browser, and no answer carries a vector.

import { safePath } from './file.js'
import { isTeamNote, noteOrder, noteFacts, TEAM_CAPS } from './_team-graph.js'

// OpenAI's text-embedding-3-small, shortened to 512 numbers (plan D4): 0.7 points under full size on
// OpenAI's benchmark, a third of the size. `builder` is the version of noteText below: a change to the
// model, the size or the text makes every stored vector useless, so the file is then read as empty and
// the whole index is built again.
export const MEANING = { model: 'text-embedding-3-small', dimensions: 512, builder: 1 }
export const INDEX_KIND = 'agent-cockpit/memory-index/v1'

export const INDEX_CAPS = {
  notes: 2000,
  noteBytes: TEAM_CAPS.bytes,
  noteChars: 8000,
  fileBytes: 8 * 1024 * 1024
}

// How close in meaning a note must be to be shown, and how many are. Tuned 2026-10-11 on Nuno's live
// board (101 notes, -small at 512 numbers, plan T9): unrelated questions scored at most 0.252, the
// weakest right first answer 0.337 ("orkestrator" -> the orchestrator), so 0.30 sits between them.
export const MEANING_FLOOR = 0.3
export const MEANING_HITS_MAX = 50

const SHA = /^[0-9a-f]{40}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/* ---------- which notes ---------- */

// From the repo tree (one GitHub call, which carries every file's fingerprint). Returns the notes to
// learn, and how many were left out for being too big or past the cap.
export function eligibleNotes(tree) {
  const nodes = (Array.isArray(tree) ? tree : []).filter((node) =>
    plainObject(node) && node.type === 'blob' && typeof node.path === 'string' && SHA.test(String(node.sha)) &&
    isTeamNote(node.path) && safePath(node.path) === node.path)
  const byPath = new Map(nodes.map((node) => [node.path, node]))
  const ordered = noteOrder([...byPath.keys()]).map((path) => byPath.get(path))
  const small = ordered.filter((node) => (Number.isFinite(node.size) ? node.size : 0) <= INDEX_CAPS.noteBytes)
  return {
    notes: small.slice(0, INDEX_CAPS.notes).map((node) => ({ path: node.path, sha: node.sha, size: Number.isFinite(node.size) ? node.size : 0 })),
    tooBig: ordered.length - small.length,
    past: Math.max(0, small.length - INDEX_CAPS.notes)
  }
}

/* ---------- the text a note is learned from ---------- */

// Its title, top folder and day - so "the inbox note from Tuesday" is close to it - then the note itself,
// frontmatter included, cut at 8,000 characters. One vector a note.
export function noteText(path, text) {
  const body = typeof text === 'string' ? text : ''
  const { title, folder, day } = noteFacts(path, body)
  const cut = body.length > INDEX_CAPS.noteChars
  let kept = body.slice(0, INDEX_CAPS.noteChars)
  // Never half of a character made of two code units.
  if (cut && /[\uD800-\uDBFF]$/.test(kept)) kept = kept.slice(0, -1)
  const head = [title, folder ? `Folder: ${folder}` : null, day ? `Day: ${day}` : null].filter(Boolean).join('\n')
  return { text: `${head}\n\n${kept}`, cut }
}

/* ---------- one byte a number ---------- */

// Each number as a whole step of the note's own scale, -127 to 127. Within half a step of the original.
export function packVector(vector) {
  let most = 0
  for (const value of vector) most = Math.max(most, Math.abs(value))
  const scale = most > 0 ? most / 127 : 0
  const bytes = new Int8Array(vector.length)
  if (scale > 0) for (let at = 0; at < vector.length; at += 1) bytes[at] = Math.round(vector[at] / scale)
  return { scale, bytes }
}

export const unpackVector = ({ scale, bytes }) => Float32Array.from(bytes, (value) => value * scale)

// The length of the packed numbers. A note's scale multiplies every number alike, so it cancels out of
// a similarity and is not needed to score.
function bytesLength(bytes) {
  let sum = 0
  for (const value of bytes) sum += value * value
  return Math.sqrt(sum)
}

/* ---------- the index ---------- */

// { commit, savedAt, saves: { day, count }, entries: [{ path, sha, cut, scale, bytes, length }] }, the
// entries in the graph's order. `commit` is the repo commit the index matches in full; `saves` counts
// today's saves inside the file itself, so counting costs nothing (api/_memory-meaning.js).
export function emptyIndex() {
  return { commit: null, savedAt: null, saves: { day: '', count: 0 }, entries: [] }
}

const entryOf = (path, sha, cut, scale, bytes) => ({ path, sha, cut: Boolean(cut), scale, bytes, length: bytesLength(bytes) })

// The notes kept as they are, and the notes to learn: new, changed (a new fingerprint) or renamed (a new
// path; the title is part of the text). Everything else in the old index is dropped.
export function diffIndex(index, notes) {
  const old = new Map(index.entries.map((entry) => [entry.path, entry]))
  const keep = []
  const embed = []
  for (const note of notes) {
    const before = old.get(note.path)
    if (before && before.sha === note.sha) keep.push(before)
    else embed.push(note)
  }
  return { keep, embed, removed: index.entries.length - keep.length }
}

// A new index from the entries kept and the notes just learned ({ path, sha, cut, vector }).
export function withEmbedded(index, keep, learned) {
  const entries = new Map(keep.map((entry) => [entry.path, entry]))
  for (const note of learned) {
    const { scale, bytes } = packVector(note.vector)
    entries.set(note.path, entryOf(note.path, note.sha, note.cut, scale, bytes))
  }
  return { ...index, entries: noteOrder([...entries.keys()]).map((path) => entries.get(path)) }
}

/* ---------- a search ---------- */

// The notes closest in meaning to the question's vector: [[path, similarity]], best first, at or above
// the floor, at most MEANING_HITS_MAX. Equal scores keep the graph's order. Never a vector.
export function scoreIndex(index, query, { floor = MEANING_FLOOR, max = MEANING_HITS_MAX } = {}) {
  let queryLength = 0
  for (const value of query) queryLength += value * value
  queryLength = Math.sqrt(queryLength)
  if (!queryLength) return []
  const hits = []
  for (const entry of index.entries) {
    if (!entry.length) continue
    let dot = 0
    for (let at = 0; at < entry.bytes.length; at += 1) dot += query[at] * entry.bytes[at]
    const similarity = Math.round((dot / (queryLength * entry.length)) * 10_000) / 10_000
    if (similarity >= floor) hits.push([entry.path, similarity])
  }
  return hits.sort((a, b) => b[1] - a[1]).slice(0, max)
}

/* ---------- the stored file ---------- */

const FILE_KEYS = ['builder', 'commit', 'dimensions', 'kind', 'model', 'notes', 'savedAt', 'saves', 'vectors']

// The file in the private picture store: the notes as [path, fingerprint, cut, scale], and every vector
// in one base64 string, one byte a number. No note text.
export function serialiseIndex(index) {
  return JSON.stringify({
    kind: INDEX_KIND,
    model: MEANING.model,
    dimensions: MEANING.dimensions,
    builder: MEANING.builder,
    commit: index.commit,
    savedAt: index.savedAt,
    saves: index.saves,
    notes: index.entries.map((entry) => [entry.path, entry.sha, entry.cut ? 1 : 0, entry.scale]),
    vectors: Buffer.concat(index.entries.map((entry) => Buffer.from(entry.bytes.buffer, entry.bytes.byteOffset, entry.bytes.length))).toString('base64')
  })
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

// Only the server writes the file, but it is read as if anyone could have: too big, not JSON, a key the
// board never writes, another model, size or text builder, a number that is not a number, a path the
// board would not open, a note twice, or vectors that do not match the notes - all an empty index (a
// rebuild), never a crash.
export function readIndexFile(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > INDEX_CAPS.fileBytes) return emptyIndex()
  let file
  try {
    file = JSON.parse(text)
  } catch {
    return emptyIndex()
  }
  if (!plainObject(file)) return emptyIndex()
  const keys = Object.keys(file).sort()
  if (keys.length !== FILE_KEYS.length || keys.some((key, at) => key !== FILE_KEYS[at])) return emptyIndex()
  if (file.kind !== INDEX_KIND || file.model !== MEANING.model || file.dimensions !== MEANING.dimensions || file.builder !== MEANING.builder) return emptyIndex()
  if (file.commit !== null && !(typeof file.commit === 'string' && SHA.test(file.commit))) return emptyIndex()
  if (file.savedAt !== null && !(typeof file.savedAt === 'string' && Number.isFinite(Date.parse(file.savedAt)))) return emptyIndex()
  const saves = file.saves
  if (!plainObject(saves) || Object.keys(saves).sort().join() !== 'count,day') return emptyIndex()
  if (!(saves.day === '' || (typeof saves.day === 'string' && DAY.test(saves.day))) || !Number.isSafeInteger(saves.count) || saves.count < 0) return emptyIndex()
  if (!Array.isArray(file.notes) || file.notes.length > INDEX_CAPS.notes) return emptyIndex()
  if (typeof file.vectors !== 'string' || !BASE64.test(file.vectors)) return emptyIndex()
  const vectors = Buffer.from(file.vectors, 'base64')
  if (vectors.length !== file.notes.length * MEANING.dimensions) return emptyIndex()
  const seen = new Set()
  const entries = []
  for (const [at, note] of file.notes.entries()) {
    if (!Array.isArray(note) || note.length !== 4) return emptyIndex()
    const [path, sha, cut, scale] = note
    if (typeof path !== 'string' || safePath(path) !== path || !isTeamNote(path) || seen.has(path)) return emptyIndex()
    if (typeof sha !== 'string' || !SHA.test(sha) || (cut !== 0 && cut !== 1)) return emptyIndex()
    if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0) return emptyIndex()
    seen.add(path)
    const start = at * MEANING.dimensions
    const bytes = new Int8Array(vectors.buffer.slice(vectors.byteOffset + start, vectors.byteOffset + start + MEANING.dimensions))
    entries.push(entryOf(path, sha, cut, scale, bytes))
  }
  const byPath = new Map(entries.map((entry) => [entry.path, entry]))
  return {
    commit: file.commit,
    savedAt: file.savedAt,
    saves: { day: saves.day, count: saves.count },
    entries: noteOrder([...byPath.keys()]).map((path) => byPath.get(path))
  }
}
