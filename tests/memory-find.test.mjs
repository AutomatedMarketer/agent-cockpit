// Memory's one search on the screen (public/memory-find.js): the words ranked on this device, the board
// asked by meaning only on Enter or a pause, the two lists made one, a day and a folder read from the
// question, a name heard wrong heard right, and the board learning the notes while Memory is open. Every
// state that is not "found by meaning" says why in one sentence. Nothing a note says is ever markup.

import test from 'node:test'
import assert from 'node:assert/strict'
import { loadPage, flush } from './helpers/page-harness.mjs'
import { basePayload } from './helpers/page-payload.mjs'
import { buildTeamGraph } from '../api/_team-graph.js'

const COMMIT = 'd'.repeat(40)
const HOSTILE = '<img src=x onerror=alert(1)>'
const NOTES = {
  'shared/writing-rules.md': '# Writing rules\n\nShort sentences.\n',
  'shared/standards/definition-of-done.md': '# Definition of done\n\nTested and shipped.\n',
  'agents/orchestrator/README.md': '# Orchestrator\n\nRoutes the work.\n',
  'agents/sales/knowledge/offer-sheet.md': `# Offer sheet\n\n## ${HOSTILE} prices\n`,
  'inbox/2026-10-11/morning-intel.md': '# Morning intel\n\nToday.\n',
  'inbox/2026-10-11/evening-notes.md': '# Evening\n\nLater today.\n',
  'inbox/2026-10-09/brief.md': '# Brief\n\nFriday.\n'
}
const team = { ...buildTeamGraph(Object.entries(NOTES).map(([path, text]) => ({ path, text }))), hidden: 0, more: 0, unread: 0 }
const graphPayload = { commit: COMMIT, team, vaults: { status: 'none', why: 'none', read: 0, skipped: 0, unreadable: 0, notShown: 0, computers: [] }, generatedAt: new Date().toISOString() }
const files = Object.keys(NOTES).map((path) => ({ path, size: 900 }))
// Sunday 11 October 2026, midday in London.
const NOON = Date.parse('2026-10-11T11:00:00Z')

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body })

async function boot({ search = () => reply(200, { on: true, ready: true, commit: COMMIT, indexed: 7, hits: [] }), index = () => reply(200, { on: true, commit: COMMIT, indexed: 7, left: 0, embeddedNow: 0, cut: 0, tooBig: 0, past: 0, savedAt: null }), editKey = '', holder = null, prompt = () => null, brand = null } = {}) {
  const asked = { search: [], index: [] }
  const answer = async (url, init = {}) => {
    if (url.startsWith('/api/graph')) return reply(200, graphPayload)
    if (url.startsWith('/api/state')) return reply(200, { ...basePayload(), commit: COMMIT, memory: { files, indexes: [], truncated: false } })
    if (url.startsWith('/api/brand') && brand) return reply(200, brand)
    if (url === '/api/memory-search') {
      asked.search.push({ body: JSON.parse(init.body), headers: init.headers })
      return search(JSON.parse(init.body), asked.search.length)
    }
    if (url === '/api/memory-index') {
      asked.index.push({ body: JSON.parse(init.body), headers: init.headers })
      return index(asked.index.length)
    }
    return reply(200, {})
  }
  const timers = []
  const page = loadPage({
    fetch: answer,
    hash: '#memory',
    prompt,
    storage: editKey ? { 'agent-cockpit-edit-key': editKey } : {},
    expose: ['memoryFind', 'memoryMeaning', 'memoryFindDeps', 'memoryFindLearn', 'memoryShowFound'],
    after: `Object.assign(memoryFindDeps, { now: () => ${NOON}, zone: () => 'Europe/London', wait: (fn) => { given.timers.push(fn); return given.timers.length }, stop: (id) => { if (id) given.timers[id - 1] = null } })`,
    given: { timers }
  })
  if (holder) holder.page = page
  await flush()
  return { page, asked, timers }
}

const walk = (node, found = []) => {
  if (!node) return found
  found.push(node)
  for (const child of node.children ?? []) walk(child, found)
  return found
}
const textOf = (node) => `${node?.textContent ?? ''}${(node?.children ?? []).map(textOf).join('')}`
const withClass = (root, name) => walk(root).filter((node) => (node.className ?? '').split(/\s+/).includes(name))
const type = (page, text) => page.node('memory-search').listeners.input.at(-1)({ target: { value: text } })
const enter = (page) => page.node('memory-search').listeners.keydown.at(-1)({ key: 'Enter', preventDefault() {} })
const hitsOf = (page) => withClass(page.node('memory-tree'), 'mem-hit')
const pathsOf = (page) => hitsOf(page).map((hit) => hit.dataset.path)
const runTimers = async (timers) => {
  for (const [at, fn] of timers.entries()) {
    if (fn) {
      timers[at] = null
      await fn()
    }
  }
  await flush()
}

/* ---------- when the board is asked ---------- */

test('ten letters typed ask nothing by meaning; the pause asks once, with the question\'s words; Enter asks at once', async () => {
  const { page, asked, timers } = await boot()
  const word = 'definition'
  for (let at = 1; at <= word.length; at += 1) type(page, word.slice(0, at))
  assert.equal(asked.search.length, 0, 'a key asked the board')
  assert.equal(timers.filter(Boolean).length, 1, 'more than one pause is waiting')
  await runTimers(timers)
  assert.deepEqual(asked.search.map((one) => one.body), [{ q: 'definition' }])
  assert.equal(asked.search[0].headers['Content-Type'], 'application/json')
  type(page, 'how should the agents write')
  enter(page)
  await flush()
  assert.deepEqual(asked.search.at(-1).body, { q: 'how should the agents write' })
  assert.equal(asked.search.length, 2)
  // The same words again: answered from what the board said, not asked twice.
  type(page, 'definition')
  enter(page)
  await flush()
  assert.equal(asked.search.length, 2)
})

test('a question that is only a day or a folder, or names a folder that is not there, is never asked by meaning', async () => {
  const { page, asked, timers } = await boot()
  for (const question of ['what did i save today', 'in the inbox folder', 'something in my finance folder', 'hi']) {
    type(page, question)
    enter(page)
  }
  await runTimers(timers)
  assert.equal(asked.search.length, 0)
})

/* ---------- one list ---------- */

test('the word list and the meaning list become one: a note in both first, each saying why', async () => {
  const { page, timers } = await boot({
    search: () => reply(200, { on: true, ready: true, commit: COMMIT, indexed: 7, hits: [['shared/standards/definition-of-done.md', 0.61], ['shared/writing-rules.md', 0.44]] })
  })
  type(page, 'writing')
  assert.deepEqual(pathsOf(page), ['shared/writing-rules.md'], 'words are shown at once, before the board answers')
  await runTimers(timers)
  assert.deepEqual(pathsOf(page), ['shared/writing-rules.md', 'shared/standards/definition-of-done.md'])
  const [both, meaningOnly] = hitsOf(page)
  assert.match(textOf(both), /in its name; close in meaning to what you asked/)
  assert.match(textOf(meaningOnly), /close in meaning to what you asked/)
  assert.doesNotMatch(textOf(meaningOnly), /in its name/)
})

test('rank fusion: each list gives a rank, a note scores 1/(60 + rank) from each list it is in', async () => {
  const { page } = await boot()
  const find = page.exposed.memoryFind
  page.exposed.memoryMeaning.answers.set('writing rules', { pending: false, hits: ['shared/standards/definition-of-done.md', 'agents/orchestrator/README.md', 'shared/writing-rules.md'] })
  const found = find('writing rules')
  assert.deepEqual(found.hits.map((hit) => hit.path), ['shared/writing-rules.md', 'shared/standards/definition-of-done.md', 'agents/orchestrator/README.md'])
  const [first] = found.hits
  assert.ok(Math.abs(first.score - (1 / 61 + 1 / 63)) < 1e-12)
})

test('a meaning call that fails keeps the word results, and says so in one sentence', async () => {
  const { page, timers } = await boot({ search: () => reply(429, { on: true, error: 'That is more than 30 searches by meaning in a minute, so this one waits: try again in a moment. Word search still works.' }) })
  type(page, 'writing')
  await runTimers(timers)
  assert.deepEqual(pathsOf(page), ['shared/writing-rules.md'])
  assert.match(textOf(page.node('memory-tree')), /more than 30 searches by meaning in a minute/)
  const dropped = await boot({ search: () => { throw new Error('offline') } })
  type(dropped.page, 'writing')
  await runTimers(dropped.timers)
  assert.deepEqual(pathsOf(dropped.page), ['shared/writing-rules.md'])
  assert.match(textOf(dropped.page.node('memory-tree')), /could not be reached/)
})

/* ---------- days and folders ---------- */

test('what did I save today: that day\'s notes, newest first; a day with none names the newest instead', async () => {
  const { page } = await boot()
  type(page, 'what did I save today')
  assert.deepEqual(pathsOf(page), ['inbox/2026-10-11/evening-notes.md', 'inbox/2026-10-11/morning-intel.md'])
  assert.match(textOf(hitsOf(page)[0]), /dated today/)
  type(page, 'what did I save yesterday')
  assert.deepEqual(pathsOf(page), [])
  assert.match(textOf(page.node('memory-tree')), /No note is dated yesterday\. The newest is evening-notes, from today\./)
  type(page, 'brief from friday')
  assert.deepEqual(pathsOf(page), ['inbox/2026-10-09/brief.md'])
})

test('a folder narrows the list; a folder that is not there is said, with the folders there are', async () => {
  const { page } = await boot()
  type(page, 'in my inbox')
  assert.deepEqual(pathsOf(page), ['inbox/2026-10-11/evening-notes.md', 'inbox/2026-10-11/morning-intel.md', 'inbox/2026-10-09/brief.md'])
  type(page, 'rules in shared')
  assert.deepEqual(pathsOf(page), ['shared/writing-rules.md'])
  type(page, 'something in my finance folder')
  assert.deepEqual(pathsOf(page), [])
  assert.match(textOf(page.node('memory-tree')), /There is no folder called finance\. Your folders are agents, inbox and shared\./)
})

test('a name heard wrong is heard as a known one, and the hit says so', async () => {
  const { page } = await boot()
  type(page, 'orkestrator')
  assert.deepEqual(pathsOf(page), ['agents/orchestrator/README.md'])
  assert.match(textOf(hitsOf(page)[0]), /heard as orchestrator/)
  const [heard] = page.exposed.memoryFind('orkestrator').hits
  assert.ok(Math.abs(heard.score - 0.8 / 61) < 1e-12, 'a name heard wrong counts 0.8 of a real match')
})

/* ---------- off, and why ---------- */

test('switched off: said once under the results, and never asked again on this visit', async () => {
  const why = 'Search by meaning is off on this board. To switch it on, set MEMORY_MEANING to on in Vercel and redeploy.'
  const { page, asked, timers } = await boot({ search: () => reply(200, { on: false, why }) })
  type(page, 'writing')
  await runTimers(timers)
  assert.match(textOf(page.node('memory-tree')), /Search by meaning is off on this board/)
  type(page, 'definition')
  enter(page)
  await runTimers(timers)
  assert.equal(asked.search.length, 1)
  assert.deepEqual(pathsOf(page), ['shared/standards/definition-of-done.md'])
})

test('a board whose edit key this device does not hold: word search, one sentence, and nobody is asked for a key', async () => {
  let prompted = 0
  const { page, asked, timers } = await boot({ search: () => reply(401, { needs: 'edit-key', error: 'Missing or wrong edit key.' }), prompt: () => { prompted += 1; return 'typed' } })
  type(page, 'writing')
  await runTimers(timers)
  assert.match(textOf(page.node('memory-tree')), /needs this board's edit key/)
  assert.equal(prompted, 0)
  type(page, 'definition')
  enter(page)
  await flush()
  assert.equal(asked.search.length, 1)
})

test('the edit key this device holds goes with every meaning call', async () => {
  const { page, asked } = await boot({ editKey: 'the-edit-key-held-here' })
  type(page, 'writing')
  enter(page)
  await flush()
  assert.equal(asked.search[0].headers['x-edit-key'], 'the-edit-key-held-here')
})

/* ---------- learning while Memory is open ---------- */

test('learning runs while Memory is open and the board has a newer commit, and says how far; the same commit asks nothing', async () => {
  const steps = [
    reply(200, { on: true, commit: null, indexed: 200, left: 250, embeddedNow: 200, cut: 0, tooBig: 0, past: 0, savedAt: null }),
    reply(200, { on: true, commit: null, indexed: 400, left: 50, embeddedNow: 200, cut: 0, tooBig: 0, past: 0, savedAt: null }),
    reply(200, { on: true, commit: COMMIT, indexed: 450, left: 0, embeddedNow: 50, cut: 0, tooBig: 0, past: 0, savedAt: null })
  ]
  const seen = []
  const holder = {}
  // Memory is open from the start, so the steps begin by themselves.
  const { page, asked } = await boot({
    holder,
    index: (n) => {
      seen.push(holder.page?.node('memory-meaning')?.textContent ?? '')
      return steps[n - 1]
    }
  })
  await flush()
  assert.equal(asked.index.length, 3)
  assert.deepEqual(asked.index[0].body, {})
  assert.match(page.node('memory').innerHTML, /<p id="memory-meaning" class="small muted mem-meaning" aria-live="polite" hidden><\/p>/, 'the status line is not on the Memory screen')
  assert.ok(seen.includes('Learning your notes by meaning: 200 of 450…'), JSON.stringify(seen))
  assert.equal(page.node('memory-meaning').hidden, true, 'the status stayed up once everything was learned')
  await page.exposed.memoryFindLearn()
  assert.equal(asked.index.length, 3, 'a board already learned at this commit was asked again')
})

test('learning that is refused stops and says why; off means it is never asked again', async () => {
  const { page, asked } = await boot({ index: () => reply(429, { on: true, error: 'OpenAI asked the board to slow down, so meaning search carries on in 30 seconds.', retryAfter: 30 }) })
  await page.exposed.memoryFindLearn()
  await flush()
  assert.equal(asked.index.length, 1)
  assert.match(page.node('memory-meaning').textContent, /carries on in 30 seconds/)
  await page.exposed.memoryFindLearn()
  assert.equal(asked.index.length, 1, 'asked again before the wait was over')
  const off = await boot({ index: () => reply(200, { on: false, why: 'Search by meaning is off on this board.' }) })
  await off.page.exposed.memoryFindLearn()
  await off.page.exposed.memoryFindLearn()
  assert.equal(off.asked.index.length, 1)
})

/* ---------- what the board says is data ---------- */

test('a meaning hit the page does not list is ignored, and a heading full of markup is shown as text', async () => {
  const { page, timers } = await boot({
    search: () => reply(200, { on: true, ready: true, commit: COMMIT, indexed: 7, hits: [['../../etc/passwd', 0.9], ['.claude/agents/x.md', 0.8], ['agents/sales/knowledge/offer-sheet.md', 0.5], ['shared/writing-rules.md', 'not a number'], ['bad', 'x']] })
  })
  type(page, 'what we sell')
  await runTimers(timers)
  assert.deepEqual(pathsOf(page), ['agents/sales/knowledge/offer-sheet.md'])
  type(page, 'prices')
  assert.ok(textOf(page.node('memory-tree')).includes(HOSTILE))
  assert.ok(walk(page.node('memory-tree')).every((node) => node.tagName !== 'IMG'))
})

test('found by voice: the same list, numbered, under the question that found it; typing ends it', async () => {
  const { page } = await boot()
  page.exposed.memoryShowFound('in my inbox')
  assert.equal(page.node('memory-search').value, 'in my inbox')
  const rows = hitsOf(page)
  assert.deepEqual(rows.map((row) => row.dataset.path), ['inbox/2026-10-11/evening-notes.md', 'inbox/2026-10-11/morning-intel.md', 'inbox/2026-10-09/brief.md'])
  assert.deepEqual(rows.map((row) => withClass(row, 'mem-hit-n')[0]?.textContent), ['1.', '2.', '3.'])
  assert.match(textOf(page.node('memory-tree')), /Found by voice: "in my inbox"/)
  type(page, 'in my inbox')
  assert.equal(page.exposed.memoryMeaning.voice, null)
  assert.equal(withClass(page.node('memory-tree'), 'mem-hit-n').length, 0, 'typing kept the numbers')
})

test('the search file is the page\'s own plain script, asked for when Memory opens: no markup written, no storage touched', async () => {
  const { readFileSync } = await import('node:fs')
  const findView = readFileSync(new URL('../public/memory-find.js', import.meta.url), 'utf8')
  assert.doesNotMatch(findView, /innerHTML|insertAdjacentHTML|outerHTML/)
  assert.doesNotMatch(findView, /\blocalStorage\b|\bsessionStorage\b/)
  assert.doesNotMatch(findView, /api\.openai\.com/, 'the page addresses OpenAI itself')
  assert.ok(findView.startsWith("'use strict'"))
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  assert.ok(!app.includes('function memoryRank'), 'the ranking is still in /app.js, paid for by every visit')
})

test('when the board says search by meaning is off, the box never asks, and says why under the words', async () => {
  const why = 'Search by meaning is off on this board. To switch it on, set MEMORY_MEANING to on in Vercel and redeploy.'
  const { page, asked, timers } = await boot({ brand: { meaning: { on: false, why } } })
  type(page, 'writing')
  enter(page)
  await runTimers(timers)
  assert.equal(asked.search.length, 0)
  assert.equal(asked.index.length, 0, 'learning was asked of a board that said it is off')
  assert.match(textOf(page.node('memory-tree')), /Search by meaning is off on this board/)
  assert.deepEqual(pathsOf(page), ['shared/writing-rules.md'])
})
