// The team repo's own memory graph: every note a dot, and a line only for a reason the board can name.
// Starts with "_" so Vercel does not turn it into an endpoint; api/graph.js serves it.
//
// A line is never invented to make a thin graph look full. A repo whose notes do not point at each other
// is a field of lonely dots, and the screen says so - a lonely dot is a missing link, which is worth
// seeing. The kinds, and what each one means:
//
//   link     a wikilink or an embed of a note: [[Note]], ![[Note]], [[folder/Note#heading|alias]]
//   mention  a markdown link to a note, [text](path.md), from the folder of the note it is written in;
//            and a plain repo path that is a note (shared/about-me.md), read from the repo root - the
//            way this team's notes point at each other, since they hold no [[links]]
//   day      notes of one day hang off one day dot, so thirty run logs are thirty lines, not 435
//   tag      notes sharing a frontmatter tag, project or person hang off one tag dot
//   agent    a note in agents/<slug>/, or a task card written `for: <slug>`, and that agent's own file
//
// Links and markdown mentions follow the collector's resolution table (tests/fixtures/vaults-parity.json,
// "resolution"), so a vault and the team repo draw the same lines from the same text. The first four
// kinds are the contract's, in its order; agent is the team repo's own and comes after them.
//
// The text of a note is read here to find its lines and the few things search may use - its headings,
// its description, its tags and its opening words, all of which the board can already show through
// /api/file. Nothing else a note says leaves this file.

import { isCalendarDay, isTaskCard } from './state.js'
import { safePath } from './file.js'
import { VAULTS_EDGE_KINDS, VAULTS_MIN_HUB_NOTES, isNoteTitle } from './_vaults.js'

export const TEAM_EDGE_KINDS = [...VAULTS_EDGE_KINDS, 'agent']
// notes: how many are read; bytes: a note bigger than this (by the tree's size) is not read at all.
export const TEAM_CAPS = { notes: 400, bytes: 64 * 1024, lines: 3200, hubs: 200 }
const MAX_TAGS_PER_NOTE = 8
const KIND = Object.fromEntries(TEAM_EDGE_KINDS.map((kind, index) => [kind, index]))
// Over the line cap the lines go from the end of this order: tags first, links last.
const KEEP_ORDER = ['link', 'mention', 'agent', 'day', 'tag'].map((kind) => KIND[kind])
const priority = (kind) => KEEP_ORDER.indexOf(kind)

// --- which files are notes ------------------------------------------------------------------------------

// Markdown outside node_modules and outside every dot folder but .claude, where the agents and their
// skills live. The rest of the dot folders hold the board's own status files and settings.
export function isTeamNote(path) {
  if (typeof path !== 'string' || !path.endsWith('.md')) return false
  const segments = path.split('/')
  if (segments.some((segment) => !segment || segment === 'node_modules')) return false
  return segments.slice(0, -1).every((segment, index) => !segment.startsWith('.') || (index === 0 && segment === '.claude')) &&
    !segments.at(-1).startsWith('.')
}

const keyOf = (path) => path.normalize('NFC').toLowerCase()
const withoutExtension = (value) => value.replace(/\.md$/i, '')

// The order of the dots, the collector's: the path without regard to case, then the path itself, by
// code unit so every computer gives the same order.
function byPath(first, second) {
  const a = keyOf(first)
  const b = keyOf(second)
  if (a !== b) return a < b ? -1 : 1
  return first < second ? -1 : first > second ? 1 : 0
}
export const noteOrder = (paths) => [...paths].sort(byPath)

// --- finding the links in a note's text (the collector's rules) ----------------------------------------

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/
const INLINE_CODE = /(?<!`)(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g
const WIKILINK = /!?\[\[([^[\]\n]*)\]\]/g
const MARKDOWN_LINK = /\]\(\s*(?:<([^<>\n]*)>|([^\s()<>]*))(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g
// A repo path written out: segments of letters, digits, dot, dash and underscore, ending in .md, with
// nothing path-like either side of it - so the end of a longer path or address is never taken for one.
// A full stop after it ends the sentence, not the path.
const PLAIN_PATH = /(?<![\w./-])([\w.-]+(?:\/[\w.-]+)*\.md)(?![\w-]|\.[\w-])/g

// Each line of the text, with every fenced code block blanked out.
function linesOutsideFences(text) {
  const kept = []
  let fence = null
  for (const line of text.split('\n')) {
    if (fence) {
      const close = FENCE_CLOSE.exec(line)
      if (close && close[1][0] === fence.character && close[1].length >= fence.length) fence = null
      kept.push('')
      continue
    }
    const open = FENCE_OPEN.exec(line)
    // A backtick fence's description cannot hold a backtick; if it does, this is inline code, not a fence.
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { character: open[1][0], length: open[1].length }
      kept.push('')
      continue
    }
    kept.push(line)
  }
  return kept
}

const withoutCode = (text) => linesOutsideFences(text).join('\n').replace(INLINE_CODE, ' ')

// The note a wikilink names: before the alias (also when a table escapes the bar), the heading, the block.
const wikiTarget = (inside) => inside.split(/\\?\|/, 1)[0].split('#', 1)[0].split('^', 1)[0].trim()

// The path a markdown link goes to, or null if it is an address, not a note, or not written as a path.
function markdownTarget(destination) {
  let target = destination.trim().split('#', 1)[0].split('?', 1)[0]
  try {
    target = decodeURIComponent(target)
  } catch {
    // Not valid percent-encoding: it is the path as written.
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return null
  return /\.md$/i.test(target) ? target : null
}

function extractLinks(text) {
  const clean = withoutCode(text)
  const found = []
  for (const match of clean.matchAll(WIKILINK)) {
    const target = wikiTarget(match[1])
    if (target) found.push({ kind: 'link', target })
  }
  for (const match of clean.matchAll(MARKDOWN_LINK)) {
    const target = markdownTarget(match[1] ?? match[2] ?? '')
    if (target) found.push({ kind: 'mention', target })
  }
  return found
}

// Plain paths, in prose or in code alike: a path in backticks is how a path is usually written. The
// wikilinks and markdown link targets are taken out first, so a path written as one of those is that
// kind of line and not a second one.
function plainPaths(text) {
  const prose = text.replace(WIKILINK, ' ').replace(MARKDOWN_LINK, ' ')
  return [...prose.matchAll(PLAIN_PATH)].map((match) => match[1])
}

// Two notes with one name: the one with the fewest folders, then the shortest path, then the first.
function closest(first, second) {
  return first.depth - second.depth || first.path.length - second.path.length || byPath(first.path, second.path)
}
const closestOf = (entries) => entries.reduce((best, entry) => (closest(entry, best) < 0 ? entry : best))

function makeResolver(paths) {
  const byFull = new Map()
  const byName = new Map()
  const add = (map, key, entry) => {
    const list = map.get(key)
    if (list) list.push(entry)
    else map.set(key, [entry])
  }
  for (const path of paths) {
    const full = withoutExtension(keyOf(path))
    const entry = { path, full, depth: path.split('/').length }
    add(byFull, full, entry)
    add(byName, full.slice(full.lastIndexOf('/') + 1), entry)
  }
  return {
    // [[Name]] is any note of that name; [[Folder/Name]] must be the whole path or the end of a longer one.
    byName(target) {
      const name = withoutExtension(keyOf(target)).trim()
      const sameName = byName.get(name.slice(name.lastIndexOf('/') + 1)) ?? []
      const reached = name.includes('/') ? sameName.filter((entry) => entry.full === name || entry.full.endsWith(`/${name}`)) : sameName
      return reached.length ? closestOf(reached).path : null
    },
    // [x](path/Note.md) from the folder of the note it is written in, or from the root after a slash.
    byPath(from, target) {
      const segments = []
      const start = target.startsWith('/') ? [] : from.split('/').slice(0, -1)
      for (const part of [...start, ...target.split('/')]) {
        if (part === '' || part === '.') continue
        if (part === '..') {
          if (!segments.length) return null
          segments.pop()
          continue
        }
        segments.push(part)
      }
      const exact = byFull.get(withoutExtension(keyOf(segments.join('/'))))
      return exact ? closestOf(exact).path : null
    },
    // A plain repo path: the whole path from the root, nothing else.
    fromRoot(target) {
      const exact = byFull.get(withoutExtension(keyOf(target)))
      return exact ? closestOf(exact).path : null
    }
  }
}

// --- what a note says about itself: its frontmatter -----------------------------------------------------

const FRONTMATTER_MAX = 32 * 1024
const FRONTMATTER = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/
const TAG_KEYS = new Set(['tags', 'tag', 'project', 'people'])
const DAY_KEYS = ['date', 'created']

const unixText = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, '\n')

function splitFrontmatter(text) {
  const whole = unixText(text)
  const match = FRONTMATTER.exec(whole.slice(0, FRONTMATTER_MAX))
  return match ? { lines: match[1].split('\n'), body: whole.slice(match[0].length) } : { lines: [], body: whole }
}

// One value as Obsidian writes it: quotes, a leading hash, or a link, taken off.
function cleanValue(raw) {
  let value = raw.trim().replace(/^(["'])(.*)\1$/, '$2').trim()
  const link = /^\[\[([^\]|]*)(?:\|[^\]]*)?\]\]$/.exec(value)
  if (link) value = link[1].trim()
  return value.replace(/^#/, '').trim()
}

// What follows `key:` on the same line: a [list, of, values], one link, or values separated by commas.
function inlineValues(raw) {
  let inner = raw.trim()
  if (/^\[\[[^\]]*\]\]$/.test(inner)) return [cleanValue(inner)]
  if (inner.startsWith('[') && inner.endsWith(']')) inner = inner.slice(1, -1)
  return inner.split(',').map(cleanValue).filter(Boolean)
}

// { key (lower case): [values] }, and the raw text after each key on its own line (for a description,
// whose commas are words, not separators), with an indented block after `>` or `|` joined to it.
function readProperties(lines) {
  const properties = new Map()
  const raw = new Map()
  let current = null
  let block = null
  for (const line of lines) {
    if (block && /^[ \t]+\S/.test(line)) {
      raw.set(block, `${raw.get(block)} ${line.trim()}`.trim())
      continue
    }
    block = null
    const pair = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/.exec(line)
    if (pair) {
      current = pair[1].toLowerCase()
      if (!properties.has(current)) properties.set(current, [])
      const value = pair[2].trim()
      if (!raw.has(current)) {
        if (/^[>|][+-]?$/.test(value)) {
          raw.set(current, '')
          block = current
        } else raw.set(current, value)
      }
      if (value && !/^[>|][+-]?$/.test(value)) properties.get(current).push(...inlineValues(value))
      continue
    }
    const item = /^[ \t]*-[ \t]+(.*)$/.exec(line)
    if (item && current) {
      const value = cleanValue(item[1])
      if (value) properties.get(current).push(value)
    }
  }
  return { properties, raw }
}

const DAY_PREFIX = /^(\d{4}-\d{2}-\d{2})(?!\d)/
const DAY_FOLDER = /^\d{4}-\d{2}-\d{2}$/

// A date at the start of the file name, else a folder named by a date (the nearest), else the
// frontmatter's date or created.
function dayOf(path, properties) {
  const segments = path.split('/')
  const name = withoutExtension(segments.at(-1))
  const named = DAY_PREFIX.exec(name)
  if (named && isCalendarDay(named[1])) return named[1]
  for (const folder of segments.slice(0, -1).reverse()) {
    if (DAY_FOLDER.test(folder) && isCalendarDay(folder)) return folder
  }
  for (const key of DAY_KEYS) {
    const value = properties.get(key)?.[0]
    const match = typeof value === 'string' ? DAY_PREFIX.exec(value) : null
    if (match && isCalendarDay(match[1])) return match[1]
  }
  return undefined
}

// The tags a note shares: its tags, tag, project and people, each held to the title rule because a tag
// dot's label is shown on a board that can be public.
function tagsOf(properties) {
  const found = []
  const seen = new Set()
  for (const [key, values] of properties) {
    if (!TAG_KEYS.has(key)) continue
    for (const value of values) {
      const lower = value.toLowerCase()
      if (seen.has(lower) || !isNoteTitle(value)) continue
      seen.add(lower)
      found.push(value)
    }
  }
  return found.slice(0, MAX_TAGS_PER_NOTE)
}

// --- what search may use ---------------------------------------------------------------------------------

const SEARCH = { headings: 12, heading: 80, description: 160, opening: 160 }
// White space becomes one space; any other control character is taken out.
const plainText = (text) => text.replace(/\s+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').replace(/ {2,}/g, ' ').trim()
const HEADING = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/

function searchEntry(body, raw, tags) {
  const headings = []
  const words = []
  for (const line of linesOutsideFences(body)) {
    const heading = HEADING.exec(line)
    if (heading) {
      const text = plainText(heading[1]).slice(0, SEARCH.heading)
      if (text && headings.length < SEARCH.headings) headings.push(text)
      continue
    }
    words.push(line)
  }
  const opening = plainText(words.join(' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/!?\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_, target, alias) => alias ?? target)
    .replace(/[*_`>~]+/g, ' ')).slice(0, SEARCH.opening)
  const description = plainText(cleanValue(raw.get('description') ?? '')).slice(0, SEARCH.description)
  return { headings, description, tags, opening }
}

// --- each dot --------------------------------------------------------------------------------------------

const GENERIC_NAMES = new Set(['readme', 'index', 'skill'])

// A short name: the file name, or folder/name for the names every folder has.
function titleOf(path) {
  const segments = path.split('/')
  const name = withoutExtension(segments.at(-1))
  return GENERIC_NAMES.has(name.toLowerCase()) && segments.length > 1 ? `${segments.at(-2)}/${name}` : name
}

const AGENT_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/

// --- from notes to dots and lines ------------------------------------------------------------------------

// Days first, in order; then tags by name without regard to case, labelled as first written. A hub only
// when two or more notes share it.
function makeHubs(info) {
  const days = new Map()
  const tags = new Map()
  info.forEach(({ day, tags: noteTags }, note) => {
    if (day !== undefined) {
      if (!days.has(day)) days.set(day, [])
      days.get(day).push(note)
    }
    for (const tag of noteTags) {
      const key = tag.toLowerCase()
      if (!tags.has(key)) tags.set(key, { label: tag, members: [] })
      tags.get(key).members.push(note)
    }
  })
  const hubs = []
  for (const day of [...days.keys()].sort()) {
    if (days.get(day).length >= VAULTS_MIN_HUB_NOTES) hubs.push({ kind: 'day', label: day, members: days.get(day) })
  }
  for (const key of [...tags.keys()].sort()) {
    const { label, members } = tags.get(key)
    if (members.length >= VAULTS_MIN_HUB_NOTES) hubs.push({ kind: 'tag', label, members })
  }
  return hubs
}

const byKeep = (first, second) => priority(first[2]) - priority(second[2]) || first[0] - second[0] || first[1] - second[1]

// The lines, cut to the cap from the end of the keep order; a hub left with fewer than two lines goes
// with them, and the hubs after it are renumbered.
function compose({ lines, hubs: allHubs, count, hubCap, lineCap }) {
  let hubs = allHubs.slice(0, hubCap)
  let edges = [...lines]
  hubs.forEach((hub, index) => {
    for (const member of hub.members) edges.push([member, count + index, KIND[hub.kind]])
  })
  edges.sort(byKeep)
  edges = edges.slice(0, lineCap)
  const spokes = hubs.map(() => 0)
  for (const [, to] of edges) if (to >= count) spokes[to - count] += 1
  if (spokes.some((spoke) => spoke < VAULTS_MIN_HUB_NOTES)) {
    const renumbered = []
    let next = 0
    spokes.forEach((spoke, index) => {
      renumbered[index] = spoke >= VAULTS_MIN_HUB_NOTES ? next++ : -1
    })
    edges = edges.filter(([, to]) => to < count || renumbered[to - count] >= 0)
      .map(([from, to, kind]) => (to < count ? [from, to, kind] : [from, count + renumbered[to - count], kind]))
    hubs = hubs.filter((hub, index) => renumbered[index] >= 0)
  }
  return { hubs, edges }
}

// notes: [{ path, text }] - text null for a note that could not be read: still a dot, with no lines of
// its own. `caps` lowers the line and hub caps (for tests).
export function buildTeamGraph(notes, caps = {}) {
  const limits = { ...TEAM_CAPS, ...caps }
  const textOf = new Map(notes.map((note) => [note.path, typeof note.text === 'string' ? note.text : null]))
  const paths = noteOrder([...textOf.keys()])
  const indexOf = new Map(paths.map((path, index) => [path, index]))
  const resolver = makeResolver(paths)
  const agentFile = (slug) => (AGENT_SLUG.test(slug) ? indexOf.get(`.claude/agents/${slug}.md`) : undefined)

  const seen = new Set()
  const lines = []
  const join = (from, to, kind) => {
    if (to === undefined || to === null || to === from) return
    const line = [Math.min(from, to), Math.max(from, to), KIND[kind]]
    const key = line.join(',')
    if (seen.has(key)) return
    seen.add(key)
    lines.push(line)
  }

  const info = paths.map((path, from) => {
    const text = textOf.get(path)
    const { lines: head, body } = splitFrontmatter(text ?? '')
    const { properties, raw } = readProperties(head)
    if (text !== null) {
      for (const link of extractLinks(unixText(text))) {
        const reached = link.kind === 'link' ? resolver.byName(link.target) : resolver.byPath(path, link.target)
        join(from, reached === null ? undefined : indexOf.get(reached), link.kind)
      }
      for (const target of plainPaths(unixText(text))) {
        const reached = resolver.fromRoot(target)
        join(from, reached === null ? undefined : indexOf.get(reached), 'mention')
      }
    }
    const folder = /^agents\/([^/]+)\//.exec(path)
    if (folder) join(from, agentFile(folder[1]), 'agent')
    if (isTaskCard(path)) {
      const owner = properties.get('for')?.[0]
      if (typeof owner === 'string') join(from, agentFile(owner), 'agent')
    }
    const tags = tagsOf(properties)
    // Search may use only what the board could show anyway: the words of a note /api/file would open.
    // Any other note (an agent's or a command's file in .claude/, a name /api/file refuses) is a dot
    // with lines and nothing to search.
    const search = safePath(path) !== null ? searchEntry(body, raw, tags) : { headings: [], description: '', tags: [], opening: '' }
    return { day: dayOf(path, properties), tags, search }
  })

  const count = paths.length
  const hubs = makeHubs(info)
  const whole = compose({ lines, hubs, count, hubCap: Infinity, lineCap: Infinity }).edges.length
  const drawn = compose({ lines, hubs, count, hubCap: limits.hubs, lineCap: limits.lines })
  const linked = new Set()
  for (const [from, to, kind] of drawn.edges) {
    if (kind === KIND.link || kind === KIND.mention) {
      linked.add(from)
      linked.add(to)
    }
  }
  return {
    notes: paths.map((path, index) => {
      const top = path.includes('/') ? path.slice(0, path.indexOf('/')) : null
      const note = { path, title: titleOf(path), folder: top, opens: safePath(path) !== null }
      if (info[index].day !== undefined) note.day = info[index].day
      return note
    }),
    hubs: drawn.hubs.map(({ kind, label }) => ({ kind, label })),
    edges: drawn.edges,
    lines: drawn.edges.length,
    lonely: count - linked.size,
    moreLines: whole - drawn.edges.length,
    search: info.map((entry) => entry.search)
  }
}
