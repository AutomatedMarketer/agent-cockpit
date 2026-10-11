// POST /api/memory-index: one step of learning the team notes by meaning. It spends the owner's money
// (OpenAI) and the picture store's writes, so it sits behind the write gate, and refuses before any
// GitHub, OpenAI or store call. Each step reads only notes that changed (by GitHub's fingerprint), at
// most 200 and 300,000 tokens' worth, and saves at most twice a UTC day. GitHub, OpenAI and the store
// are fakes (tests/helpers/meaning-fakes.mjs).

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { makeHandler } from '../api/memory-index.js'
import { MEANING_SAY, MEANING_LIMITS, forgetMeaning, meaningConfig } from '../api/_memory-meaning.js'
import { MEMORY_INDEX_PATH } from '../api/_picture-store.js'
import { estimateTokens, EMBED_SAY } from '../api/_embed.js'
import { noteText, readIndexFile } from '../api/_memory-index.js'
import { asTheBoard, call, everythingSent } from './helpers/personalise-harness.mjs'
import { ENV, HEAD, NEWER, OPENAI_KEY, stubFetch, meaningWorld, blobCalls, manyNotes, shaOf } from './helpers/meaning-fakes.mjs'

const JSON_TYPE = { 'content-type': 'application/json' }
const NOTES = {
  'shared/writing-rules.md': '# Writing rules\nShort sentences. No jargon.\n',
  'shared/standards/definition-of-done.md': '---\ndescription: When a task is finished\n---\n# Definition of done\nTested, reviewed, shipped.\n',
  'inbox/2026-10-11/morning-intel.md': '# Morning intel\nThree things happened overnight.\n',
  '.claude/agents/sales.md': '---\nname: sales\n---\nNever learned: the board does not open it.\n',
  'workflows/brief.yml': 'name: Brief\n'
}
const LEARNED = ['inbox/2026-10-11/morning-intel.md', 'shared/standards/definition-of-done.md', 'shared/writing-rules.md']

function board(t, { env = ENV, files = NOTES, head = HEAD, openai, store, clock } = {}) {
  const world = meaningWorld(t, { env })
  const stub = stubFetch({ files, head, openai })
  t.after(stub.restore)
  let time = clock ?? Date.parse('2026-10-11T09:00:00Z')
  const handler = makeHandler({ store: store === undefined ? world.store : store, env, now: () => time })
  return {
    ...world,
    calls: stub.calls,
    step: (headers = asTheBoard(JSON_TYPE)) => call(handler, { method: 'POST', headers, body: {} }),
    later: (ms) => { time += ms },
    swap: (next) => {
      stub.restore()
      const again = stubFetch(next)
      t.after(again.restore)
      return again.calls
    }
  }
}

const outside = (calls) => calls.head.length + calls.tree.length + calls.blob.length + calls.openai.length

/* ---------- the gate ---------- */

test('refused before any GitHub, OpenAI or store call: no key, a wrong type, another site, a GET', async (t) => {
  const world = board(t)
  const cases = [
    [{ method: 'POST', headers: JSON_TYPE }, 401],
    [{ method: 'POST', headers: asTheBoard({ 'content-type': 'text/plain' }) }, 415],
    [{ method: 'POST', headers: asTheBoard({ ...JSON_TYPE, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }) }, 403],
    [{ method: 'GET', headers: asTheBoard() }, 405]
  ]
  const handler = makeHandler({ store: world.store, env: ENV })
  for (const [request, status] of cases) {
    const response = await call(handler, { body: {}, ...request })
    assert.equal(response.statusCode, status, JSON.stringify(request))
    assert.equal(response.headers['Cache-Control'], 'private, no-store')
  }
  assert.equal(outside(world.calls), 0, 'GitHub or OpenAI was asked before the gate')
  assert.equal(blobCalls(world.fake), 0, 'the store was read before the gate')
})

test('a board with the edit key set asks for it; a public board with none has meaning search off', async (t) => {
  const keyed = board(t, { env: { ...ENV, EDIT_KEY: 'an-edit-key-long-enough' } })
  const refused = await keyed.step()
  assert.equal(refused.statusCode, 401)
  assert.equal(refused.body.needs, 'edit-key')
  assert.equal(outside(keyed.calls), 0)
  const open = await call(makeHandler({ store: keyed.store, env: { ...ENV, VIEW_KEY: '', PUBLIC_DASHBOARD: 'true' } }), { method: 'POST', headers: JSON_TYPE, body: {} })
  assert.equal(open.statusCode, 403)
  assert.equal(outside(keyed.calls), 0)
})

test('off unless switched on, with a key and a store - and says which, with nothing called', async (t) => {
  const cases = [
    [{ ...ENV, MEMORY_MEANING: '' }, MEANING_SAY.off],
    [{ ...ENV, MEMORY_MEANING: 'yes' }, MEANING_SAY.off],
    [{ ...ENV, OPENAI_API_KEY: '' }, MEANING_SAY.noKey]
  ]
  for (const [env, why] of cases) {
    const world = board(t, { env })
    const response = await world.step()
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.body, { on: false, why })
    assert.equal(outside(world.calls), 0)
    assert.equal(blobCalls(world.fake), 0)
  }
  const { BLOB_STORE_ID, ...noStore } = ENV
  const world = board(t, { env: noStore, store: null })
  const response = await world.step()
  assert.deepEqual(response.body, { on: false, why: MEANING_SAY.noStore })
  assert.equal(outside(world.calls), 0)
  assert.ok(MEANING_SAY.noStore.includes('Private Blob store'))
})

test('the on/off rule on its own: switched on, a key, a store, and not an open board without an edit key', () => {
  const { BLOB_STORE_ID, ...noStore } = ENV
  assert.deepEqual(meaningConfig(ENV), { on: true })
  assert.deepEqual(meaningConfig({ ...ENV, MEMORY_MEANING: ' ON ' }), { on: true })
  assert.deepEqual(meaningConfig(noStore), { on: false, why: MEANING_SAY.noStore })
  assert.deepEqual(meaningConfig({ ...ENV, PUBLIC_DASHBOARD: 'true' }), { on: false, why: MEANING_SAY.openBoard })
  assert.deepEqual(meaningConfig({ ...ENV, PUBLIC_DASHBOARD: 'true', EDIT_KEY: 'an-edit-key-long-enough' }), { on: true })
  assert.deepEqual(meaningConfig({}), { on: false, why: MEANING_SAY.off })
})

/* ---------- learning ---------- */

test('the first step learns every note the board can open, once, and saves the index privately', async (t) => {
  const world = board(t)
  const response = await world.step()
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['Cache-Control'], 'private, no-store')
  const { savedAt, ...rest } = response.body
  assert.deepEqual(rest, { on: true, commit: HEAD, indexed: 3, left: 0, embeddedNow: 3, cut: 0, tooBig: 0, past: 0 })
  assert.equal(savedAt, '2026-10-11T09:00:00.000Z')
  assert.equal(world.calls.head.length, 1)
  assert.equal(world.calls.tree.length, 1)
  assert.equal(world.calls.blob.length, 3, 'each note is read once, by its fingerprint')
  assert.ok(world.calls.blob.every((read) => read.accept === 'application/vnd.github.raw' && read.auth === 'Bearer ghp_fakeTokenForTests'))
  assert.equal(world.calls.openai.length, 1)
  const sent = world.calls.openai[0]
  assert.equal(sent.init.headers.Authorization, `Bearer ${OPENAI_KEY}`)
  assert.deepEqual(sent.body.input, LEARNED.map((path) => noteText(path, NOTES[path]).text))
  const put = world.fake.calls.put.find((one) => one.pathname === MEMORY_INDEX_PATH)
  assert.equal(put.options.access, 'private')
  const stored = world.fake.files.get(MEMORY_INDEX_PATH).bytes.toString('utf8')
  assert.deepEqual(readIndexFile(stored).entries.map((entry) => entry.path), LEARNED)
  for (const text of Object.values(NOTES)) assert.ok(!stored.includes(text.trim().split('\n').at(-1)), 'note text was stored')
})

test('nothing new: one GitHub call, no OpenAI, no store read', async (t) => {
  const world = board(t)
  await world.step()
  const reads = world.fake.calls.get.length
  const before = { head: world.calls.head.length, tree: world.calls.tree.length, openai: world.calls.openai.length }
  const again = await world.step()
  assert.equal(again.statusCode, 200)
  assert.equal(again.body.embeddedNow, 0)
  assert.equal(again.body.indexed, 3)
  assert.equal(world.calls.head.length - before.head, 1)
  assert.equal(world.calls.tree.length - before.tree, 0)
  assert.equal(world.calls.openai.length - before.openai, 0)
  assert.equal(world.fake.calls.get.length, reads, 'the index was read from the store again')
})

test('three changed notes: three reads and one OpenAI call; a gone note is dropped; a renamed note is learned again', async (t) => {
  const world = board(t)
  await world.step()
  const files = {
    'shared/writing-rules.md': '# Writing rules\nShort sentences. Plain words.\n',
    'shared/standards/finished.md': NOTES['shared/standards/definition-of-done.md'],
    'inbox/2026-10-12/morning-intel.md': '# Morning intel\nA new day.\n'
  }
  const calls = world.swap({ files, head: NEWER })
  const response = await world.step()
  assert.equal(response.body.embeddedNow, 3)
  assert.equal(response.body.indexed, 3)
  assert.equal(response.body.commit, NEWER)
  assert.equal(calls.blob.length, 3)
  assert.equal(calls.openai.length, 1)
  assert.equal(calls.openai[0].body.input.length, 3)
})

test('450 new notes: 200 a step, the rest left for the next; the commit is set only when all are learned', async (t) => {
  const world = board(t, { files: manyNotes(450) })
  const first = await world.step()
  assert.deepEqual([first.body.embeddedNow, first.body.indexed, first.body.left], [200, 200, 250])
  assert.equal(first.body.commit, null, 'a half-learned index claimed the commit')
  assert.equal(world.calls.blob.length, 200)
  assert.equal(MEANING_LIMITS.notesPerStep, 200)
  const second = await world.step()
  assert.deepEqual([second.body.embeddedNow, second.body.indexed, second.body.left], [200, 400, 50])
  const third = await world.step()
  assert.deepEqual([third.body.embeddedNow, third.body.indexed, third.body.left], [50, 450, 0])
  assert.equal(third.body.commit, HEAD)
  assert.equal(world.calls.blob.length, 450, 'a note was read twice')
})

test('a step sends at most 300,000 tokens\' worth, by the sizes GitHub gives, before reading anything', async (t) => {
  const long = Object.fromEntries(Array.from({ length: 150 }, (_, at) => [`n/${String(at).padStart(3, '0')}.md`, `${'word '.repeat(1600)}${at}`]))
  const world = board(t, { files: long })
  const response = await world.step()
  const sent = world.calls.openai.flatMap((one) => one.body.input)
  const tokens = sent.reduce((sum, text) => sum + estimateTokens(text), 0)
  assert.ok(tokens <= MEANING_LIMITS.tokensPerStep, `${tokens} tokens in one step`)
  assert.ok(response.body.embeddedNow < 150 && response.body.embeddedNow > 100)
  assert.equal(world.calls.blob.length, response.body.embeddedNow, 'notes were read that were not learned')
  assert.equal(response.body.left, 150 - response.body.embeddedNow)
})

test('a note too big to read is counted, and one cut at 8,000 characters is counted as cut', async (t) => {
  const files = { 'shared/long.md': `${'x'.repeat(8001)}`, 'shared/huge.md': 'small text, big in the tree', 'shared/ok.md': 'fine' }
  const world = meaningWorld(t)
  const stub = stubFetch({ files, sizes: { 'shared/huge.md': 64 * 1024 + 1 } })
  t.after(stub.restore)
  const response = await call(makeHandler({ store: world.store, env: ENV }), { method: 'POST', headers: asTheBoard(JSON_TYPE), body: {} })
  assert.equal(response.body.indexed, 2)
  assert.equal(response.body.cut, 1)
  assert.equal(response.body.tooBig, 1)
})

/* ---------- when OpenAI refuses ---------- */

test('OpenAI\'s rate limit keeps what was learned, says the wait, and never repeats OpenAI\'s words or the key', async (t) => {
  const world = board(t, {
    openai: () => new Response(JSON.stringify({ error: { message: `Rate limit reached for ${OPENAI_KEY}`, code: 'rate_limit_exceeded' } }), { status: 429, headers: { 'retry-after': '30' } })
  })
  const response = await world.step()
  assert.equal(response.statusCode, 429)
  assert.equal(response.headers['Retry-After'], '30')
  assert.equal(response.body.error, EMBED_SAY.busy(30))
  assert.equal(response.body.indexed, 0)
  assert.equal(response.headers['Cache-Control'], 'private, no-store')
  assert.ok(!everythingSent(response).includes(OPENAI_KEY) && !everythingSent(response).includes('Rate limit reached'))
  assert.equal(world.fake.calls.put.length, 0, 'a failed step saved')
})

test('no answer carries a vector, a base64 run, the key or a note\'s text', async (t) => {
  const world = board(t)
  const response = await world.step()
  const sent = everythingSent(response)
  assert.ok(!/[A-Za-z0-9+/]{80,}/.test(sent), 'a long base64 run was sent')
  assert.ok(!sent.includes(OPENAI_KEY) && !sent.includes('ghp_'))
  assert.ok(!sent.includes('Short sentences'))
})

/* ---------- saving: at most twice a UTC day ---------- */

test('saved when 6 hours have passed or 50 notes changed, at most twice a UTC day; past that it still answers', async (t) => {
  const world = board(t, { files: manyNotes(10) })
  await world.step()
  const indexPuts = () => world.fake.calls.put.filter((one) => one.pathname === MEMORY_INDEX_PATH).length
  assert.equal(indexPuts(), 1, 'the first build was not saved')
  // One note changed an hour later: kept in memory, not saved.
  world.swap({ files: { ...manyNotes(10), 'n/000.md': 'changed' }, head: NEWER })
  world.later(3600_000)
  assert.equal((await world.step()).body.embeddedNow, 1)
  assert.equal(indexPuts(), 1)
  // 60 new notes: saved (the second today).
  const sixty = { ...manyNotes(70), 'n/000.md': 'changed' }
  world.swap({ files: sixty, head: 'e'.repeat(40) })
  world.later(60_000)
  const big = await world.step()
  assert.equal(big.body.embeddedNow, 60)
  assert.equal(indexPuts(), 2)
  // Six hours later, a change, but both of today's saves are used: still an answer, nothing written.
  world.swap({ files: { ...sixty, 'n/001.md': 'changed too' }, head: 'f'.repeat(40) })
  world.later(6 * 3600_000)
  const third = await world.step()
  assert.equal(third.statusCode, 200)
  assert.equal(third.body.embeddedNow, 1)
  assert.equal(indexPuts(), 2, 'a third save in one UTC day')
  assert.equal(third.body.savedAt, big.body.savedAt)
  // The next UTC day: saved again.
  world.later(24 * 3600_000)
  await world.step()
  assert.equal(indexPuts(), 3)
})

test('a new server reads the saved index once, learns only what changed, and reads it again only after 10 minutes', async (t) => {
  const world = board(t, { files: manyNotes(20) })
  await world.step()
  forgetMeaning()
  const calls = world.swap({ files: { ...manyNotes(20), 'n/005.md': 'changed' }, head: NEWER })
  const reads = () => world.fake.calls.get.filter((one) => one.pathname === MEMORY_INDEX_PATH).length
  const before = reads()
  const response = await world.step()
  assert.equal(response.body.embeddedNow, 1, 'a new server learned everything again')
  assert.equal(reads() - before, 1)
  await world.step()
  assert.equal(reads() - before, 1, 'read again within 10 minutes')
  assert.equal(calls.openai.length, 1)
  assert.equal(MEANING_LIMITS.readEveryMs, 10 * 60_000)
})

test('a damaged index file is read as empty, and everything is learned again', async (t) => {
  const world = board(t)
  await world.fake.sdk.put(MEMORY_INDEX_PATH, '{"kind":"agent-cockpit/memory-index/v1","model":"something-else"}', { access: 'private' })
  const response = await world.step()
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.embeddedNow, 3)
})

test('two steps at once on one server learn each note once', async (t) => {
  const world = board(t)
  const [first, second] = await Promise.all([world.step(), world.step()])
  assert.equal(first.statusCode, 200)
  assert.equal(second.statusCode, 200)
  assert.equal(world.calls.openai.length, 1)
  assert.equal(world.calls.blob.length, 3)
})

test('vercel.json gives the step a minute', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
  assert.equal(config.functions['api/memory-index.js'].maxDuration, 60)
  assert.ok(shaOf('x'))
})
