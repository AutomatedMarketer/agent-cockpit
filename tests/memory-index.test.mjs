// The meaning index, pure (api/_memory-index.js): which notes are learned, the text each is learned
// from, the one-byte packing, what changed since the last build, how a search scores, and how a stored
// file is read back - where anything the board did not write is an empty index (a rebuild), never a
// crash and never a half-trusted file. No network, no store.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MEANING,
  INDEX_CAPS,
  eligibleNotes,
  noteText,
  packVector,
  unpackVector,
  emptyIndex,
  diffIndex,
  withEmbedded,
  scoreIndex,
  serialiseIndex,
  readIndexFile
} from '../api/_memory-index.js'

const sha = (seed) => seed.toString(16).padStart(40, '0')
const blob = (path, size = 1000, seed = path.length) => ({ path, type: 'blob', sha: sha(seed), size })

// A unit vector with its weight on a few axes, so similarities are easy to reason about.
function vector(weights) {
  const values = new Float32Array(MEANING.dimensions)
  for (const [axis, weight] of Object.entries(weights)) values[Number(axis)] = weight
  const length = Math.hypot(...values)
  return values.map((value) => value / length)
}

function randomUnit(seed) {
  let state = seed
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648 - 0.5
  }
  const values = Float32Array.from({ length: MEANING.dimensions }, next)
  const length = Math.hypot(...values)
  return values.map((value) => value / length)
}

const cosine = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0) / (Math.hypot(...a) * Math.hypot(...b))

function indexOf(notes) {
  return withEmbedded(emptyIndex(), [], notes.map(({ path, seed = 1, weights, cut = false }) => ({
    path, sha: sha(seed), cut, vector: weights ? vector(weights) : randomUnit(seed)
  })))
}

/* ---------- which notes ---------- */

test('only notes the board can open are learned: .claude/, other dot folders, non-notes and refused names stay out', () => {
  const { notes } = eligibleNotes([
    blob('shared/writing-rules.md'),
    blob('.claude/agents/sales.md'),
    blob('.github/notes.md'),
    blob('agents/sales/knowledge/offer-sheet.md'),
    blob('inbox/2026-10-11/morning-intel.md'),
    blob('README.md'),
    blob('shared/data.json'),
    blob('shared/odd name!.md'),
    blob('node_modules/x/readme.md'),
    { path: 'shared/a-folder.md', type: 'tree', sha: sha(9) },
    { path: 'shared/no-sha.md', type: 'blob', sha: 'not-a-sha', size: 10 }
  ])
  assert.deepEqual(notes.map((note) => note.path), [
    'agents/sales/knowledge/offer-sheet.md', 'inbox/2026-10-11/morning-intel.md', 'README.md', 'shared/writing-rules.md'
  ])
  assert.deepEqual(Object.keys(notes[0]).sort(), ['path', 'sha', 'size'])
})

test('a note over 64 KB stays out and is counted; past 2,000 notes the rest are counted, never learned', () => {
  const limit = INDEX_CAPS.noteBytes
  assert.equal(limit, 64 * 1024)
  const sized = eligibleNotes([blob('a.md', limit), blob('b.md', limit + 1)])
  assert.deepEqual(sized.notes.map((note) => note.path), ['a.md'])
  assert.equal(sized.tooBig, 1)
  assert.equal(INDEX_CAPS.notes, 2000)
  const many = Array.from({ length: 2001 }, (_, index) => blob(`n/${String(index).padStart(4, '0')}.md`))
  const capped = eligibleNotes(many)
  assert.equal(capped.notes.length, 2000)
  assert.equal(capped.past, 1)
  assert.equal(capped.notes.at(-1).path, 'n/1999.md', 'the cap keeps the notes in the graph\'s order')
  assert.equal(eligibleNotes(many.slice(0, 2000)).past, 0)
})

/* ---------- the text each note is learned from ---------- */

test('a note is learned from its title, top folder and day, then its own text, frontmatter included', () => {
  const said = noteText('inbox/2026-10-11/morning-intel.md', '---\ntags: [intel]\n---\n# Morning intel\nThree things.')
  assert.equal(said.text, 'morning-intel\nFolder: inbox\nDay: 2026-10-11\n\n---\ntags: [intel]\n---\n# Morning intel\nThree things.')
  assert.equal(said.cut, false)
  assert.equal(noteText('README.md', 'Hello').text, 'README\n\nHello', 'a root note has no folder line')
  assert.equal(noteText('agents/sales/README.md', 'x').text, 'sales/README\nFolder: agents\n\nx', 'the graph\'s own title for a README')
  assert.equal(noteText('shared/plan.md', '---\ndate: 2026-10-03\n---\nx').text.split('\n')[2], 'Day: 2026-10-03', 'a day from the frontmatter')
})

test('a note is cut at 8,000 characters of its own text, and says it was cut', () => {
  assert.equal(INDEX_CAPS.noteChars, 8000)
  const exact = noteText('shared/a.md', 'x'.repeat(8000))
  assert.equal(exact.cut, false)
  assert.ok(exact.text.endsWith('x'.repeat(8000)))
  const over = noteText('shared/a.md', 'x'.repeat(8001))
  assert.equal(over.cut, true)
  assert.equal(over.text.length, exact.text.length)
  // Never half a character: a cut that lands inside an emoji drops the whole of it.
  const emoji = noteText('shared/a.md', `${'x'.repeat(7999)}\u{1F600}y`)
  assert.equal(emoji.cut, true)
  assert.ok(!/[\uD800-\uDBFF]$/.test(emoji.text), 'a lone half of a character was kept')
})

/* ---------- one byte a number ---------- */

test('packing keeps every number within half a step, and a search finds the same order', () => {
  for (const seed of [1, 7, 42]) {
    const original = randomUnit(seed)
    const packed = packVector(original)
    assert.ok(packed.bytes instanceof Int8Array && packed.bytes.length === MEANING.dimensions)
    const back = unpackVector(packed)
    const worst = Math.max(...original.map((value, index) => Math.abs(value - back[index])))
    assert.ok(worst <= packed.scale / 2 + 1e-9, `error ${worst} over half a step ${packed.scale / 2}`)
    assert.ok(cosine(original, back) > 0.999)
    assert.ok(Math.max(...packed.bytes.map(Math.abs)) === 127, 'the biggest number did not use the whole byte')
  }
  const zero = packVector(new Float32Array(MEANING.dimensions))
  assert.equal(zero.scale, 0)
  assert.ok(unpackVector(zero).every((value) => value === 0))
})

/* ---------- what changed since the last build ---------- */

test('only new and changed notes are learned again; a renamed note is new; a gone note is dropped', () => {
  const index = indexOf([
    { path: 'shared/kept.md', seed: 1 },
    { path: 'shared/changed.md', seed: 2 },
    { path: 'shared/old-name.md', seed: 3 },
    { path: 'shared/gone.md', seed: 4 }
  ])
  const now = [
    { path: 'shared/kept.md', sha: sha(1), size: 10 },
    { path: 'shared/changed.md', sha: sha(22), size: 10 },
    { path: 'shared/new-name.md', sha: sha(3), size: 10 },
    { path: 'shared/brand-new.md', sha: sha(5), size: 10 }
  ]
  const diff = diffIndex(index, now)
  assert.deepEqual(diff.keep.map((entry) => entry.path), ['shared/kept.md'])
  assert.deepEqual(diff.embed.map((note) => note.path), ['shared/changed.md', 'shared/new-name.md', 'shared/brand-new.md'])
  assert.equal(diff.removed, 3, 'changed, renamed and gone notes leave the old index')
  const after = withEmbedded(index, diff.keep, diff.embed.map((note) => ({ ...note, cut: false, vector: randomUnit(9) })))
  assert.deepEqual(after.entries.map((entry) => entry.path), ['shared/brand-new.md', 'shared/changed.md', 'shared/kept.md', 'shared/new-name.md'])
  assert.equal(diffIndex(after, now).embed.length, 0)
})

/* ---------- scoring ---------- */

test('a search returns paths best first, above the floor, at most 50, never a vector', () => {
  const index = indexOf([
    { path: 'shared/far.md', weights: { 0: 0.05, 9: 1 } },
    { path: 'shared/near.md', weights: { 0: 1, 1: 0.2 } },
    { path: 'shared/nearest.md', weights: { 0: 1 } },
    { path: 'shared/middle.md', weights: { 0: 1, 1: 1 } }
  ])
  const hits = scoreIndex(index, vector({ 0: 1 }), { floor: 0.5 })
  assert.deepEqual(hits.map(([path]) => path), ['shared/nearest.md', 'shared/near.md', 'shared/middle.md'])
  assert.ok(hits.every(([path, similarity]) => typeof path === 'string' && typeof similarity === 'number' && similarity >= 0.5 && similarity <= 1))
  assert.ok(Math.abs(hits[0][1] - 1) < 0.01)
  assert.ok(hits.every((hit) => hit.length === 2))
  const many = indexOf(Array.from({ length: 60 }, (_, index) => ({ path: `n/${String(index).padStart(2, '0')}.md`, weights: { 0: 1 } })))
  const capped = scoreIndex(many, vector({ 0: 1 }), { floor: 0 })
  assert.equal(capped.length, 50)
  assert.equal(capped[0][0], 'n/00.md', 'equal scores keep the graph\'s order')
  assert.deepEqual(scoreIndex(emptyIndex(), vector({ 0: 1 })), [])
})

/* ---------- the stored file ---------- */

test('a saved index reads back exactly, and its file carries no note text', () => {
  const index = indexOf([{ path: 'shared/a.md', seed: 3, cut: true }, { path: 'inbox/2026-10-11/b.md', seed: 4 }])
  index.commit = 'a'.repeat(40)
  index.savedAt = '2026-10-11T10:00:00.000Z'
  index.saves = { day: '2026-10-11', count: 1 }
  const text = serialiseIndex(index)
  const back = readIndexFile(text)
  assert.equal(back.commit, index.commit)
  assert.equal(back.savedAt, index.savedAt)
  assert.deepEqual(back.saves, index.saves)
  assert.deepEqual(back.entries.map((entry) => [entry.path, entry.sha, entry.cut]), index.entries.map((entry) => [entry.path, entry.sha, entry.cut]))
  back.entries.forEach((entry, at) => assert.deepEqual([...entry.bytes], [...index.entries[at].bytes]))
  const query = randomUnit(3)
  assert.deepEqual(scoreIndex(back, query, { floor: -1 }), scoreIndex(index, query, { floor: -1 }))
  const parsed = JSON.parse(text)
  assert.deepEqual(Object.keys(parsed).sort(), ['builder', 'commit', 'dimensions', 'kind', 'model', 'notes', 'savedAt', 'saves', 'vectors'])
  assert.equal(parsed.model, 'text-embedding-3-small')
  assert.equal(parsed.dimensions, 512)
})

test('a hostile or broken index file is an empty index, never a crash', () => {
  const good = (() => {
    const index = indexOf([{ path: 'shared/a.md', seed: 3 }, { path: 'shared/b.md', seed: 4 }])
    index.commit = 'b'.repeat(40)
    return JSON.parse(serialiseIndex(index))
  })()
  assert.equal(readIndexFile(JSON.stringify(good)).entries.length, 2, 'the good file was refused')
  const vectors = Buffer.from(good.vectors, 'base64')
  const broken = {
    'not JSON': '{"kind":',
    'an array': '[]',
    'another model': { ...good, model: 'text-embedding-3-large' },
    'another size': { ...good, dimensions: 1536 },
    'another text builder': { ...good, builder: 99 },
    'another kind': { ...good, kind: 'something-else' },
    'an extra key': { ...good, note: 'hello' },
    'a missing key': (({ saves, ...rest }) => rest)(good),
    'a scale that is not a number': { ...good, notes: [[...good.notes[0].slice(0, 3), 'NaN'], good.notes[1]] },
    'an endless scale': JSON.stringify(good).replace(`,${good.notes[0][3]}]`, ',1e400]'),
    'a negative scale': { ...good, notes: [[...good.notes[0].slice(0, 3), -1], good.notes[1]] },
    'fewer vectors than notes': { ...good, vectors: vectors.subarray(0, MEANING.dimensions).toString('base64') },
    'more vectors than notes': { ...good, vectors: Buffer.concat([vectors, vectors.subarray(0, MEANING.dimensions)]).toString('base64') },
    'vectors that are not base64': { ...good, vectors: '!!!!' },
    'vectors with a character base64 does not have': { ...good, vectors: `${good.vectors.slice(0, 8)}!${good.vectors.slice(8)}` },
    'the same note twice': { ...good, notes: [good.notes[0], good.notes[0]] },
    'a path the board would not open': { ...good, notes: [['.claude/agents/x.md', ...good.notes[0].slice(1)], good.notes[1]] },
    'a path that climbs out': { ...good, notes: [['shared/../../etc.md', ...good.notes[0].slice(1)], good.notes[1]] },
    'a bad fingerprint': { ...good, notes: [[good.notes[0][0], 'xyz', ...good.notes[0].slice(2)], good.notes[1]] },
    'a bad commit': { ...good, commit: 'main' },
    'a bad save count': { ...good, saves: { day: '2026-10-11', count: -1 } },
    'a bad save day': { ...good, saves: { day: 'today', count: 1 } },
    'too many notes': {
      ...good,
      notes: Array.from({ length: 2001 }, (_, index) => [`n/${index}.md`, sha(index + 1), 0, 0.01]),
      vectors: Buffer.alloc(2001 * MEANING.dimensions, 1).toString('base64')
    }
  }
  for (const [name, file] of Object.entries(broken)) {
    const read = readIndexFile(typeof file === 'string' ? file : JSON.stringify(file))
    assert.deepEqual(read.entries, [], `${name}: was read as an index`)
    assert.equal(read.commit, null, `${name}: kept a commit`)
  }
  // Over 8 MB: refused before it is parsed.
  assert.equal(INDEX_CAPS.fileBytes, 8 * 1024 * 1024)
  const huge = JSON.stringify(good) + ' '.repeat(INDEX_CAPS.fileBytes)
  assert.deepEqual(readIndexFile(huge).entries, [])
  assert.deepEqual(readIndexFile(null).entries, [])
  assert.deepEqual(readIndexFile(undefined).entries, [])
})
