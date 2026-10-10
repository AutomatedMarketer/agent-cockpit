// Searching inside the team's pages, on Memory's List.
//
// The board's payload holds the names of the pages and never what they say, and a page is fetched only
// when it is opened, so the box used to search names alone, and said so. The graph (api/graph.js) reads
// every note once, when Memory opens, and sends for each the few things search may use: its headings,
// its description, its tags and its opening words - all of which /api/file would show anyway. Once that
// has arrived, the box ranks pages by those as well. Typing never fetches: the ranking is the page's own
// arithmetic over what is already there. Until it arrives, or if it never does, the box searches names
// and says exactly that, as before.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadPage, flush } from './helpers/page-harness.mjs'
import { basePayload } from './helpers/page-payload.mjs'
import { buildTeamGraph } from '../api/_team-graph.js'

const COMMIT = 'd'.repeat(40)
const HOSTILE = '<img src=x onerror=alert(1)>'
const NOTES = {
  'shared/business-brain.md': '---\ndescription: What we sell and to whom.\n---\n# Business brain\n\nWe sell roofing to homeowners in the valley.\n## Pricing\n',
  'shared/about-me.md': '# About me\n\nOwner of a small roofing firm.\n',
  'agents/sales/README.md': `# Sales\n\n## ${HOSTILE} pipeline\n`,
  'agents/sales/knowledge/offer-sheet.md': '---\ntags: [pricing]\n---\n# Offer sheet\n',
  'docs/roofing-guide.md': '# Guide\n\nNothing else here.\n',
  'inbox/2026-10-09/brief.md': '# Morning brief\n'
}
const team = { ...buildTeamGraph(Object.entries(NOTES).map(([path, text]) => ({ path, text }))), hidden: 0, more: 0, unread: 0 }
const graphPayload = { commit: COMMIT, team, vaults: { status: 'none', why: 'No vault has been read yet.', read: 0, skipped: 0, unreadable: 0, notShown: 0, computers: [] }, generatedAt: new Date().toISOString() }
const files = Object.keys(NOTES).map((path) => ({ path, size: 900 }))

async function boot({ graph = true } = {}) {
  const answer = async (url) => {
    if (url.startsWith('/api/graph')) {
      return graph
        ? { ok: true, status: 200, headers: { get: () => null }, json: async () => graphPayload }
        : { ok: false, status: 500, headers: { get: () => null }, json: async () => ({ error: 'Something went wrong reading your team repo, so try again in a minute.' }) }
    }
    if (url.startsWith('/api/state')) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ...basePayload(), commit: COMMIT, memory: { files, indexes: [], truncated: false } }) }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) }
  }
  const page = loadPage({ fetch: answer, hash: '#memory', expose: ['memoryRank', 'memorySearchIndex'] })
  await flush()
  return page
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
const hitsOf = (page) => withClass(page.node('memory-tree'), 'mem-hit')

/* ---------- the ranking -------------------------------------------------------------------------- */

const entry = (path, patch = {}) => ({ path, headings: [], description: '', tags: [], opening: '', ...patch })

test('every word typed must be somewhere in the page; a word only starts a word, it need not finish it', async () => {
  const page = await boot()
  const rank = page.exposed.memoryRank
  const pages = [entry('a.md', { opening: 'We sell roofing in the valley.' }), entry('b.md', { opening: 'Roofing only.' })]
  assert.deepEqual(rank(pages, 'roof').map((hit) => hit.path), ['a.md', 'b.md'].sort())
  assert.deepEqual(rank(pages, 'roofing valley').map((hit) => hit.path), ['a.md'])
  assert.deepEqual(rank(pages, 'oofing').map((hit) => hit.path), [], 'the middle of a word matched')
  assert.deepEqual(rank(pages, '   '), [])
})

test('a name beats a heading, a heading beats the description and tags, and they beat the opening words', async () => {
  const page = await boot()
  const pages = [
    entry('notes/opening.md', { opening: 'pricing' }),
    entry('notes/described.md', { description: 'pricing' }),
    entry('notes/headed.md', { headings: ['Pricing'] }),
    entry('notes/pricing.md')
  ]
  assert.deepEqual(page.exposed.memoryRank(pages, 'pricing').map((hit) => hit.path), ['notes/pricing.md', 'notes/headed.md', 'notes/described.md', 'notes/opening.md'])
})

test('a word few pages have counts for more than one most pages have, and equal pages keep path order', async () => {
  const page = await boot()
  const pages = [
    entry('a.md', { opening: 'team roofing' }),
    entry('b.md', { opening: 'team' }),
    entry('c.md', { opening: 'team' }),
    entry('d.md', { opening: 'team' }),
    entry('e.md', { headings: ['team'], opening: 'cladding' })
  ]
  // "roofing" is in one page of five and "team" in all; a.md has both and wins.
  assert.equal(page.exposed.memoryRank(pages, 'team roofing')[0].path, 'a.md')
  assert.deepEqual(page.exposed.memoryRank(pages, 'team').slice(1).map((hit) => hit.path), ['a.md', 'b.md', 'c.md', 'd.md'])
  // Two pages each hold both words, one in its name and one in its opening words, the other way round:
  // the one named by the rarer word comes first, though path order would put the other first.
  const crossed = [
    entry('a/common.md', { opening: 'rare' }),
    entry('z/rare.md', { opening: 'common' }),
    ...['p', 'q', 'r'].map((name) => entry(`${name}.md`, { opening: 'common' }))
  ]
  assert.deepEqual(page.exposed.memoryRank(crossed, 'common rare').map((hit) => hit.path), ['z/rare.md', 'a/common.md'])
})

test('the .md every page name ends in is not a word to search for', async () => {
  const page = await boot()
  assert.deepEqual(page.exposed.memoryRank([entry('a.md'), entry('notes/b.md')], 'md'), [])
})

test('each hit says where the words were found', async () => {
  const page = await boot()
  const rank = page.exposed.memoryRank
  assert.equal(rank([entry('x/pricing.md')], 'pricing')[0].where, 'in its name')
  assert.equal(rank([entry('a.md', { headings: ['Intro', 'Pricing for 2027'] })], 'pricing')[0].where, 'in a heading: Pricing for 2027')
  assert.equal(rank([entry('a.md', { description: 'All about pricing' })], 'pricing')[0].where, 'in its description')
  assert.equal(rank([entry('a.md', { tags: ['pricing'] })], 'pricing')[0].where, 'in its tags')
  assert.equal(rank([entry('a.md', { opening: 'Our pricing.' })], 'pricing')[0].where, 'in its opening words')
})

/* ---------- on the screen ------------------------------------------------------------------------- */

test('with the graph read, a word written inside a page finds it, and the box says what it searches', async () => {
  const page = await boot()
  assert.match(page.node('memory-search').placeholder, /Search 6 pages: names, headings, descriptions and opening words/)
  const before = page.requests.length
  type(page, 'valley')
  const hits = hitsOf(page)
  assert.deepEqual(hits.map((hit) => hit.dataset.path), ['shared/business-brain.md'])
  assert.equal(hits[0].tagName, 'BUTTON', 'a hit is not a button a keyboard can reach')
  assert.match(textOf(hits[0]), /in its opening words/)
  assert.equal(page.requests.length, before, 'typing asked the board for something')
})

test('a heading read from a page is shown as text, never as markup', async () => {
  const page = await boot()
  type(page, 'pipeline')
  const [hit] = hitsOf(page)
  assert.ok(textOf(hit).includes(HOSTILE))
  assert.ok(walk(page.node('memory-tree')).every((node) => node.tagName !== 'IMG'))
})

test('the folder buttons narrow the hits too, and a word found only elsewhere says where', async () => {
  const page = await boot()
  page.node('memory-filters').listeners.click.at(-1)({ target: { closest: () => ({ dataset: { source: 'agents' } }) } })
  type(page, 'roofing')
  assert.deepEqual(hitsOf(page), [])
  const said = textOf(page.node('memory-tree'))
  assert.match(said, /No page in agents\/ has "roofing"/)
  assert.match(said, /3 elsewhere in your vault do/)
})

test('a word in no page says exactly what was searched, and that a page holds more than that', async () => {
  const page = await boot()
  type(page, 'zebra')
  const said = textOf(page.node('memory-tree'))
  assert.match(said, /No page has "zebra" in its name, headings, description, tags or opening words/)
  assert.match(said, /not every word/)
})

test('without the graph, the box searches names and says so, as it always has', async () => {
  const page = await boot({ graph: false })
  assert.equal(page.exposed.memorySearchIndex(), null)
  assert.match(page.node('memory').innerHTML, /Search 6 page names/)
  type(page, 'valley')
  assert.deepEqual(hitsOf(page), [])
  assert.match(page.node('memory-tree').innerHTML, /searches page names, not the words written inside/)
})
