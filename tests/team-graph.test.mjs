// The team repo's own memory graph, built by the board: every note a dot, and a line only for a reason
// the board can name. Nothing is invented to fill a thin graph out - a repo with no links is lonely dots,
// and the screen says so.
//
// The lines:
//   link     [[Note]], ![[Note]], [[folder/Note#heading|alias]], resolved the way Obsidian does
//   mention  [text](path.md) from the note's own folder, and a plain repo path (shared/about-me.md)
//            that is a note - the way this team's notes point at each other (they have no [[links]])
//   agent    a note under agents/<slug>/, or a task card `for: <slug>`, and that agent's own file
//   day      notes of the same day hang off one day dot, never joined to each other
//   tag      notes sharing a frontmatter tag, project or person hang off one tag dot
// tests/fixtures/vaults-parity.json's resolution table is the collector's; the board holds the team
// repo's links and markdown mentions to the same table.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildTeamGraph,
  isTeamNote,
  noteOrder,
  TEAM_EDGE_KINDS,
  TEAM_CAPS
} from '../api/_team-graph.js'
import { VAULTS_EDGE_KINDS } from '../api/_vaults.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/vaults-parity.json', import.meta.url), 'utf8'))
const KIND = Object.fromEntries(TEAM_EDGE_KINDS.map((kind, index) => [kind, index]))

// notes: { path: text } - a graph from them, as the endpoint hands them over.
const graphOf = (notes) => buildTeamGraph(Object.entries(notes).map(([path, text]) => ({ path, text })))
// Every line that touches `path`, as { to, kind } with `to` the other end's path or hub label.
function linesOf(graph, path) {
  const index = graph.notes.findIndex((note) => note.path === path)
  assert.ok(index >= 0, `${path} is not a dot`)
  const name = (dot) => (dot < graph.notes.length ? graph.notes[dot].path : `${graph.hubs[dot - graph.notes.length].kind}:${graph.hubs[dot - graph.notes.length].label}`)
  return graph.edges
    .filter(([from, to]) => from === index || to === index)
    .map(([from, to, kind]) => ({ to: name(from === index ? to : from), kind: TEAM_EDGE_KINDS[kind] }))
}

/* ---------- the line kinds ---------------------------------------------------------------------- */

test('the first four line kinds are the contract\'s, in its order; the team repo adds agent after them', () => {
  assert.deepEqual(TEAM_EDGE_KINDS.slice(0, VAULTS_EDGE_KINDS.length), VAULTS_EDGE_KINDS)
  assert.deepEqual(TEAM_EDGE_KINDS, ['link', 'mention', 'day', 'tag', 'agent'])
})

/* ---------- the resolution table, shared with the collector ----------------------------------- */

test('vaults parity: every case of the resolution table draws exactly the lines the contract says', () => {
  assert.ok(fixture.resolution.cases.length >= 30, 'the table was not read')
  for (const { why, notes, from, text, edges } of fixture.resolution.cases) {
    const graph = graphOf(Object.fromEntries(notes.map((path) => [path, path === from ? text : ''])))
    const order = noteOrder(notes)
    const expected = [...edges].sort((a, b) => KIND[a.kind] - KIND[b.kind] || order.indexOf(a.to) - order.indexOf(b.to))
    const drawn = linesOf(graph, from).sort((a, b) => KIND[a.kind] - KIND[b.kind] || order.indexOf(a.to) - order.indexOf(b.to))
    assert.deepEqual(drawn, expected, why)
  }
})

test('the dots are numbered in the contract\'s order: the path without regard to case, then the path', () => {
  assert.deepEqual(noteOrder(['b.md', 'A.md', 'a.md', 'Z/x.md', 'a/b.md']), ['A.md', 'a.md', 'a/b.md', 'b.md', 'Z/x.md'])
  const graph = graphOf({ 'b.md': '', 'A.md': '', 'a/b.md': '' })
  assert.deepEqual(graph.notes.map((note) => note.path), ['A.md', 'a/b.md', 'b.md'])
})

/* ---------- plain repo paths: how this team's notes point at each other ------------------------ */

test('a plain repo path that is a note is a mention, in prose, in backticks and in a code block', () => {
  const graph = graphOf({
    'CLAUDE.md': 'Read shared/business-brain.md first, then `shared/about-me.md`.\n```\ncat shared/writing-rules.md\n```',
    'shared/business-brain.md': '',
    'shared/about-me.md': '',
    'shared/writing-rules.md': ''
  })
  assert.deepEqual(linesOf(graph, 'CLAUDE.md'), [
    { to: 'shared/about-me.md', kind: 'mention' },
    { to: 'shared/business-brain.md', kind: 'mention' },
    { to: 'shared/writing-rules.md', kind: 'mention' }
  ])
})

test('a plain path is read from the repo root, whole: no guessing at a file name on its own', () => {
  const graph = graphOf({
    'agents/sales/README.md': 'See about-me.md, knowledge/offer-sheet.md, and CLAUDE.md. Also ./CLAUDE.md, x/shared/about-me.md and shared/about-me.mdx.',
    'shared/about-me.md': '',
    'agents/sales/knowledge/offer-sheet.md': '',
    'CLAUDE.md': ''
  })
  assert.deepEqual(linesOf(graph, 'agents/sales/README.md'), [{ to: 'CLAUDE.md', kind: 'mention' }])
})

test('a plain path to something that is not a note, or not there, or the note itself, is nothing', () => {
  const graph = graphOf({
    'README.md': 'Run workflows/morning-intel.yml, see docs/missing.md, and README.md itself. https://example.com/shared/a.md is an address, ' +
      'shared/a.md.bak is a copy and /shared/a.md is a path on somebody\'s computer.',
    'shared/a.md': ''
  })
  assert.deepEqual(linesOf(graph, 'README.md'), [])
})

test('an address is never a note, even one that would reach a note once its two slashes were dropped', () => {
  const graph = graphOf({ 'A.md': '[h](//B.md)', 'B.md': '' })
  assert.deepEqual(linesOf(graph, 'A.md'), [])
})

test('a plain path matches without regard to case, as a markdown path does', () => {
  const graph = graphOf({ 'README.md': 'See Shared/About-Me.md.', 'shared/about-me.md': '' })
  assert.deepEqual(linesOf(graph, 'README.md'), [{ to: 'shared/about-me.md', kind: 'mention' }])
})

test('a path written as a wikilink or a markdown link is that kind of line, not a second mention', () => {
  const graph = graphOf({ 'A.md': '[[B.md]] and [x](C.md)', 'B.md': '', 'C.md': '' })
  assert.deepEqual(linesOf(graph, 'A.md'), [{ to: 'B.md', kind: 'link' }, { to: 'C.md', kind: 'mention' }])
})

test('a note written many times over is one line, however it is written', () => {
  const graph = graphOf({ 'A.md': 'shared/b.md, `shared/b.md`, [b](shared/b.md) and shared/b.md again', 'shared/b.md': 'Back to A.md.' })
  assert.deepEqual(linesOf(graph, 'A.md'), [{ to: 'shared/b.md', kind: 'mention' }])
  assert.equal(graph.lines, 1)
})

/* ---------- agent lines ------------------------------------------------------------------------ */

test('a note in an agent\'s folder joins that agent\'s own file, and a task card joins the agent it is for', () => {
  const graph = graphOf({
    '.claude/agents/sales.md': '---\nname: sales\n---\nThe sales agent.',
    '.claude/agents/research.md': '',
    'agents/sales/README.md': '',
    'agents/sales/knowledge/offer-sheet.md': '',
    'agents/editor/README.md': '',
    'tasks/2026-10-09-check-pricing.md': '---\nstatus: todo\nfor: research\n---\n# Check pricing',
    'tasks/2026-10-09-nobody.md': '---\nfor: nobody-here\n---\n',
    // An agent's slug is lower case, as the fire endpoint holds it; this card would never be routed.
    '.claude/agents/Editor.md': '',
    'tasks/2026-10-09-shouting.md': '---\nfor: Editor\n---\n',
    'tasks/README.md': '---\nfor: sales\n---\nHow tasks work.'
  })
  assert.deepEqual(linesOf(graph, '.claude/agents/sales.md'), [
    { to: 'agents/sales/knowledge/offer-sheet.md', kind: 'agent' },
    { to: 'agents/sales/README.md', kind: 'agent' }
  ])
  assert.deepEqual(linesOf(graph, '.claude/agents/research.md'), [{ to: 'tasks/2026-10-09-check-pricing.md', kind: 'agent' }])
  // No .claude/agents/editor.md, so the editor's folder has no agent to join.
  assert.deepEqual(linesOf(graph, 'agents/editor/README.md'), [])
  assert.deepEqual(linesOf(graph, 'tasks/2026-10-09-nobody.md').filter((line) => line.kind === 'agent'), [])
  assert.deepEqual(linesOf(graph, 'tasks/2026-10-09-shouting.md').filter((line) => line.kind === 'agent'), [])
  // The folder's README explains the folder; it is not a task for anybody.
  assert.deepEqual(linesOf(graph, 'tasks/README.md').filter((line) => line.kind === 'agent'), [])
})

test('an agent line is not a link: a note with only agent lines is still a lonely dot', () => {
  const graph = graphOf({ '.claude/agents/sales.md': '', 'agents/sales/README.md': '' })
  assert.equal(graph.lines, 1)
  assert.equal(graph.lonely, 2)
})

/* ---------- day and tag hubs -------------------------------------------------------------------- */

test('notes of one day hang off one day dot: thirty notes are thirty lines, never four hundred and thirty-five', () => {
  const notes = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`inbox/2026-09-01/run-${String(index).padStart(2, '0')}.md`, '']))
  const graph = graphOf(notes)
  assert.deepEqual(graph.hubs, [{ kind: 'day', label: '2026-09-01' }])
  assert.equal(graph.lines, 30)
  assert.ok(graph.edges.every(([from, to, kind]) => kind === KIND.day && to === 30 && from < 30))
})

test('a note\'s day is a date at the start of its name, a folder named by a date, or its frontmatter date or created', () => {
  const graph = graphOf({
    'inbox/2026-08-20/morning-intel.md': '',
    'inbox/2026-08-20/inbox-triage.md': '',
    'docs/2026-08-20-sweep.md': '',
    'notes/plan.md': '---\ncreated: 2026-08-20T08:00:00Z\n---\n',
    'notes/later.md': '---\ndate: "2026-08-21"\n---\n',
    'notes/never.md': '---\ndate: 2026-02-31\n---\n',
    'runs/2026-08/summary.md': ''
  })
  assert.deepEqual(graph.hubs, [{ kind: 'day', label: '2026-08-20' }])
  assert.deepEqual(graph.notes.map((note) => [note.path, note.day ?? null]), [
    ['docs/2026-08-20-sweep.md', '2026-08-20'],
    ['inbox/2026-08-20/inbox-triage.md', '2026-08-20'],
    ['inbox/2026-08-20/morning-intel.md', '2026-08-20'],
    ['notes/later.md', '2026-08-21'],
    ['notes/never.md', null],
    ['notes/plan.md', '2026-08-20'],
    ['runs/2026-08/summary.md', null]
  ])
  assert.equal(graph.lines, 4)
})

test('notes sharing a tag, a project or a person hang off one tag dot; one note alone makes no dot', () => {
  const graph = graphOf({
    'a.md': '---\ntags: [Launch, ideas]\n---\n',
    'b.md': '---\ntags:\n  - launch\nproject: "[[Newsletter]]"\n---\n',
    'c.md': '---\npeople: Ann, Ben\nproject: Newsletter\n---\n',
    'd.md': '---\ntags: [solo]\n---\n'
  })
  assert.deepEqual(graph.hubs, [{ kind: 'tag', label: 'Launch' }, { kind: 'tag', label: 'Newsletter' }])
  assert.deepEqual(linesOf(graph, 'b.md'), [{ to: 'tag:Launch', kind: 'tag' }, { to: 'tag:Newsletter', kind: 'tag' }])
  assert.deepEqual(linesOf(graph, 'd.md'), [])
})

test('a tag that fails the title rule is never a dot on the board', () => {
  const email = 'someone' + '@' + 'example.com'
  const graph = graphOf({ 'a.md': `---\ntags: [${email}, ok]\n---\n`, 'b.md': `---\ntags: [${email}, ok]\n---\n` })
  assert.deepEqual(graph.hubs, [{ kind: 'tag', label: 'ok' }])
})

test('days come first among the hubs, then tags, each in order', () => {
  const graph = graphOf({
    '2026-10-02 b.md': '---\ntags: [zeta]\n---\n',
    '2026-10-02 a.md': '---\ntags: [alpha, zeta]\n---\n',
    '2026-10-01 c.md': '---\ntags: [alpha]\n---\n',
    '2026-10-01 d.md': ''
  })
  assert.deepEqual(graph.hubs.map((hub) => `${hub.kind}:${hub.label}`), ['day:2026-10-01', 'day:2026-10-02', 'tag:alpha', 'tag:zeta'])
})

/* ---------- each dot ---------------------------------------------------------------------------- */

test('each dot says its path, a short name, its top folder, and whether the board can open it', () => {
  const graph = graphOf({
    'shared/business-brain.md': '',
    'agents/sales/README.md': '',
    '.claude/skills/run-log/SKILL.md': '',
    'CLAUDE.md': '',
    'docs/index.md': ''
  })
  const byPath = Object.fromEntries(graph.notes.map((note) => [note.path, note]))
  assert.deepEqual(byPath['shared/business-brain.md'], { path: 'shared/business-brain.md', title: 'business-brain', folder: 'shared', opens: true })
  // A README, an index or a SKILL is named by its folder, or every agent would be called README.
  assert.equal(byPath['agents/sales/README.md'].title, 'sales/README')
  assert.equal(byPath['.claude/skills/run-log/SKILL.md'].title, 'run-log/SKILL')
  assert.equal(byPath['docs/index.md'].title, 'docs/index')
  assert.equal(byPath['CLAUDE.md'].folder, null)
  // /api/file opens nothing in a dot folder, so the page offers no Open for it.
  assert.equal(byPath['.claude/skills/run-log/SKILL.md'].opens, false)
  assert.equal(byPath['CLAUDE.md'].opens, true)
})

test('which notes are the team repo\'s: markdown, outside node_modules and every dot folder but .claude', () => {
  for (const path of ['README.md', 'shared/about-me.md', '.claude/agents/sales.md', '.claude/skills/run-log/SKILL.md', 'inbox/2026-08-20/morning-intel.md']) {
    assert.equal(isTeamNote(path), true, path)
  }
  for (const path of ['.agent-team/onboarding-state.md', '.github/pull_request_template.md', 'node_modules/x/README.md', 'a/node_modules/b.md',
    '.claude/.hidden/x.md', 'docs/.claude/x.md', 'workflows/brief.yml', 'shared/about-me.md.bak', 'README.MD.txt', '', null, 7]) {
    assert.equal(isTeamNote(path), false, String(path))
  }
})

/* ---------- counts and caps --------------------------------------------------------------------- */

test('lonely is every note with no link or mention line, as the collector counts it', () => {
  const graph = graphOf({ 'A.md': '[[B]]', 'B.md': '', 'C.md': '', '2026-01-01 D.md': '', '2026-01-01 E.md': '' })
  // C.md, and the two notes joined only by their day.
  assert.equal(graph.lonely, 3)
})

test('over the line cap, tag lines go first, then day, agent and mention lines; links stay longest', () => {
  assert.equal(TEAM_CAPS.lines, 3200)
  const notes = {}
  // Four notes, each with one line of every kind but day, so each kind has a known count; then the cap
  // is lowered for the test.
  notes['.claude/agents/sales.md'] = ''
  for (let index = 0; index < 4; index += 1) {
    notes[`agents/sales/2026-05-0${index + 1} n${index}.md`] = `---\ntags: [x]\n---\n[[hub]] shared/m.md`
  }
  notes['hub.md'] = ''
  notes['shared/m.md'] = ''
  const whole = graphOf(notes)
  const count = (graph, kind) => graph.edges.filter((edge) => edge[2] === KIND[kind]).length
  assert.deepEqual(['link', 'mention', 'agent', 'day', 'tag'].map((kind) => count(whole, kind)), [4, 4, 4, 0, 4])
  for (const [cap, kept] of [[12, [4, 4, 4, 0, 0]], [8, [4, 4, 0, 0, 0]], [6, [4, 2, 0, 0, 0]], [3, [3, 0, 0, 0, 0]]]) {
    const capped = buildTeamGraph(Object.entries(notes).map(([path, text]) => ({ path, text })), { lines: cap })
    assert.deepEqual(['link', 'mention', 'agent', 'day', 'tag'].map((kind) => count(capped, kind)), kept, `cap ${cap}`)
    assert.equal(capped.moreLines, 16 - capped.lines, `cap ${cap}`)
    // A hub left with fewer than two lines is not drawn.
    assert.equal(capped.hubs.length, kept[4] >= 2 ? 1 : 0, `cap ${cap}`)
  }
})

test('the hubs are capped too, and their lines go with them', () => {
  assert.equal(TEAM_CAPS.hubs, 200)
  const notes = { 'a.md': '---\ntags: [t1, t2, t3]\n---\n', 'b.md': '---\ntags: [t1, t2, t3]\n---\n' }
  const graph = buildTeamGraph(Object.entries(notes).map(([path, text]) => ({ path, text })), { hubs: 2 })
  assert.deepEqual(graph.hubs.map((hub) => hub.label), ['t1', 't2'])
  assert.equal(graph.lines, 4)
  assert.equal(graph.moreLines, 2)
})

test('a note that could not be read is still a dot, with no lines of its own', () => {
  const graph = buildTeamGraph([{ path: 'A.md', text: null }, { path: 'B.md', text: '[[A]]' }])
  assert.equal(graph.notes.length, 2)
  assert.deepEqual(linesOf(graph, 'A.md'), [{ to: 'B.md', kind: 'link' }])
})

/* ---------- what search may use: never more than the board could already show ------------------ */

test('each note gives search its headings, description, tags and opening words, and nothing else', () => {
  const graph = graphOf({
    'shared/business-brain.md': '---\nname: brain\ndescription: What the business sells, and to whom.\ntags: [core]\napi_key: abc\n---\n# The business brain\n\nWe sell roofing to homeowners in the valley. ' + 'More words. '.repeat(40) + '\n## Pricing\n```\n# not a heading\n```\n### Who buys',
    'b.md': '---\ntags: [core]\n---\n'
  })
  const index = graph.notes.findIndex((note) => note.path === 'shared/business-brain.md')
  const entry = graph.search[index]
  assert.deepEqual(Object.keys(entry).sort(), ['description', 'headings', 'opening', 'tags'])
  assert.deepEqual(entry.headings, ['The business brain', 'Pricing', 'Who buys'])
  assert.equal(entry.description, 'What the business sells, and to whom.')
  assert.deepEqual(entry.tags, ['core'])
  assert.ok(entry.opening.startsWith('We sell roofing to homeowners in the valley.'), entry.opening)
  assert.ok(entry.opening.length <= 160)
  assert.ok(!JSON.stringify(graph.search).includes('abc'), 'a frontmatter value search does not use reached the payload')
  assert.equal(graph.search.length, graph.notes.length)
})

test('search text is cut to size and cleaned of control characters', () => {
  const long = 'x'.repeat(500)
  const graph = graphOf({ 'a.md': `---\ndescription: ${long}\n---\n# ${long}\n` + Array.from({ length: 20 }, (_, index) => `## H${index}`).join('\n') + '\nText\twith a tab\u0007.' })
  const [entry] = graph.search
  assert.ok(entry.description.length <= 160)
  assert.ok(entry.headings.every((heading) => heading.length <= 80))
  assert.ok(entry.headings.length <= 12)
  const texts = [entry.description, entry.opening, ...entry.headings, ...entry.tags]
  assert.ok(texts.every((text) => !/[\x00-\x1f\x7f]/.test(text)), 'a control character reached the search text')
  assert.match(entry.opening, /Text with a tab\./)
})
