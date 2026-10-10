// The vaults snapshot: the memory graph of each Obsidian vault the owner named in vaults.yml, as dots
// and lines, read from the files the status collector commits to .agent-team/status/vaults/. Starts
// with "_" so Vercel does not turn it into an endpoint; api/graph.js serves it.
//
// tests/fixtures/vaults-parity.json is the shared contract, the same bytes in both repos, and
// tests/vaults.test.mjs holds this file to it. Mirrored, not imported: the collector lives in the
// student's repo and this is a deployed app, with no import path between them.
//
// A vault comes at one of two levels, chosen by the owner for each vault:
//   shape   (the default)  its name, its counts, and anonymous dots (numbers) joined by lines (number
//                          pairs). No title, folder, tag, date, content or path.
//   titles  (opt-in)       the same, plus each note's title, top folder and day, and a hub dot for a
//                          day or a tag two or more notes share - every one held to the title rule.
// The file comes through a repo anybody with push access can edit, and the board can be public, so
// every name and title is checked again here and the answer is built only from the keys the board
// knows. Whatever a `shape` vault's file says, no title, folder, day or tag of it is ever read.

import {
  isConnectionName, isCalendarDay, cleanUsageName, isPlainObject, keepEntries, readStatusEnvelope, isoSeconds, shapeStatusFiles
} from './state.js'

export const VAULTS_SCHEMA = 'agent-status/vaults/v1'
export const VAULTS_FOLDER = '.agent-team/status/vaults'
export const VAULTS_COMPUTER_SLUG = /^[a-z0-9-]{1,32}$/
// A vault changes slowly and the collector rewrites its file at most once a day, so it is stale after
// days, not hours.
export const VAULTS_STALE_AFTER_DAYS = 7
export const VAULTS_MAX_FILES = 5
export const VAULTS_MAX_BYTES = 256 * 1024
export const VAULTS_MAX_COMPUTERS = 3
export const VAULTS_STATUSES = ['found', 'not found', 'unavailable']
export const VAULTS_CAPS = { vaults: 3, notes: 600, lines: 2000, hubs: 200 }
export const VAULTS_LEVELS = ['shape', 'titles']
// The order is the contract: an edge's kind is its index here.
export const VAULTS_EDGE_KINDS = ['link', 'mention', 'day', 'tag']
export const VAULTS_HUB_KINDS = ['day', 'tag']
export const VAULTS_MIN_HUB_NOTES = 2
export const VAULTS_WHY_CODES = { unreadable: 'could not be read', refused: 'refused by the safety check' }
export const VAULTS_ALLOWED_KEYS = {
  file: ['schema', 'takenAt', 'computer', 'vaults'],
  blockFound: ['status', 'items', 'hidden', 'more'],
  blockNotFound: ['status', 'why'],
  vault: ['name', 'level', 'notes', 'lines', 'lonely', 'hidden', 'more', 'moreLines', 'untitled', 'edges', 'nodes', 'hubs'],
  node: ['title', 'folder', 'day'],
  hub: ['kind', 'label']
}
export const VAULTS_REQUIRED_KEYS = {
  file: ['schema', 'takenAt', 'computer', 'vaults'],
  vault: ['name', 'level', 'notes', 'lines', 'lonely', 'hidden', 'more', 'moreLines', 'edges'],
  vaultAtTitles: ['untitled', 'nodes'],
  hub: ['kind', 'label']
}

// What a title must be to be shown: the contract's rule. The same rule holds a top folder, a tag and a
// hub label. The collector also refuses the owner's username, computer name and home folder; the board
// cannot, because it does not know whose computer a file came from.
export const NOTE_TITLE_RULE = {
  maxLength: 80,
  never: ['@', '/', '\\', 'eyj', 'sk-', 'bearer'],
  uuid: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/,
  maxSegmentLength: 23,
  separatorCharacters: ':._-,;()[]{}\'’"!?#+&*=%|~',
  controlCharacters: /[\u0000-\u001f\u007f-\u009f]/,
  invisibleCharacters: /[\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/
}

// A separator or any whitespace ends a run; each character is compared on its own, so nothing in the
// list is read as a range.
const isSegmentBreak = (character) => NOTE_TITLE_RULE.separatorCharacters.includes(character) || /\s/u.test(character)

export function isNoteTitle(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()) return false
  if (value.length > NOTE_TITLE_RULE.maxLength) return false
  const lower = value.toLowerCase()
  if (NOTE_TITLE_RULE.never.some((fragment) => lower.includes(fragment))) return false
  if (NOTE_TITLE_RULE.controlCharacters.test(value) || NOTE_TITLE_RULE.invisibleCharacters.test(value)) return false
  if (NOTE_TITLE_RULE.uuid.test(lower)) return false
  let run = 0
  for (const character of value) {
    run = isSegmentBreak(character) ? 0 : run + 1
    if (run > NOTE_TITLE_RULE.maxSegmentLength) return false
  }
  return true
}

// A vault is called by its folder name, held to the connection-name rule (connections-parity.json).
export const isVaultName = (value) => isConnectionName(value)

export function isVaultsFile(path) {
  const prefix = `${VAULTS_FOLDER}/`
  if (typeof path !== 'string' || !path.startsWith(prefix) || !path.endsWith('.json')) return false
  return VAULTS_COMPUTER_SLUG.test(path.slice(prefix.length, -'.json'.length))
}

// --- reading the files ------------------------------------------------------------------------------

const VAULTS_MAX_COUNT = 1e7
const isCount = (value) => Number.isInteger(value) && value >= 0 && value <= VAULTS_MAX_COUNT
const upTo = (value, max) => Number.isInteger(value) && value >= 0 && value <= max
// A day exactly as the collector writes it: a real calendar day, with nothing round it.
const isVaultDay = (value) => typeof value === 'string' && value === value.trim() && isCalendarDay(value)
// One of the two fixed reasons, or none: never the file's own words.
const knownWhy = (why) => (typeof why === 'string' && Object.values(VAULTS_WHY_CODES).includes(why) ? why : null)
// The kinds below this join two notes (link, mention); the others join a note to a hub (day, tag).
const NOTE_KINDS = VAULTS_EDGE_KINDS.indexOf('day')

// One entry per dot, in order. A title, folder or day that fails the rule is left off and the dot stays,
// anonymous: the board shows less, never something the collector should have refused.
function vaultNodes(raw, notes) {
  if (!Array.isArray(raw) || raw.length !== notes) return null
  const nodes = []
  for (const entry of raw) {
    if (!isPlainObject(entry)) return null
    const node = {}
    if (isNoteTitle(entry.title)) node.title = entry.title
    if (isNoteTitle(entry.folder)) node.folder = entry.folder
    if (isVaultDay(entry.day)) node.day = entry.day
    nodes.push(node)
  }
  return nodes
}

// A hub keeps its place - the lines are numbered by it - but a label that fails the rule is not shown.
function vaultHubs(raw) {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > VAULTS_CAPS.hubs) return null
  const hubs = []
  for (const entry of raw) {
    if (!isPlainObject(entry) || !VAULTS_HUB_KINDS.includes(entry.kind)) return null
    const shown = entry.kind === 'day' ? isVaultDay(entry.label) : isNoteTitle(entry.label)
    hubs.push({ kind: entry.kind, label: shown ? entry.label : null })
  }
  return hubs
}

// Every line as the contract draws it, or null for a list the board cannot vouch for: a link or a
// mention joins two notes, a day or tag line goes from a note to a hub of its own kind, from is below
// to, one line per pair and kind, and every hub has at least two lines.
function vaultEdges(raw, notes, hubs) {
  if (!Array.isArray(raw) || raw.length > VAULTS_CAPS.lines) return null
  const dots = notes + hubs.length
  const seen = new Set()
  const spokes = hubs.map(() => 0)
  const edges = []
  for (const edge of raw) {
    if (!Array.isArray(edge) || edge.length !== 3 || !edge.every(Number.isSafeInteger)) return null
    const [from, to, kind] = edge
    if (from < 0 || from >= to || to >= dots || kind < 0 || kind >= VAULTS_EDGE_KINDS.length) return null
    if (kind < NOTE_KINDS) {
      if (to >= notes) return null
    } else {
      if (from >= notes || to < notes || hubs[to - notes].kind !== VAULTS_EDGE_KINDS[kind]) return null
      spokes[to - notes] += 1
    }
    const key = `${from},${to},${kind}`
    if (seen.has(key)) return null
    seen.add(key)
    edges.push([from, to, kind])
  }
  if (spokes.some((count) => count < VAULTS_MIN_HUB_NOTES)) return null
  return edges
}

// One vault, built from the keys the board knows, or null when it is not a vault the board can vouch
// for: it is then left out whole and counted in hidden, and the others stand. The board counts the
// lines and the lonely dots itself rather than repeating the file's numbers.
function shapeVault(raw) {
  if (!isVaultName(raw.name) || !VAULTS_LEVELS.includes(raw.level)) return null
  if (!upTo(raw.notes, VAULTS_CAPS.notes) || !upTo(raw.lines, VAULTS_CAPS.lines)) return null
  if (![raw.lonely, raw.hidden, raw.more, raw.moreLines].every(isCount)) return null
  const titles = raw.level === 'titles'
  // At the shape level nothing but numbers is read, whatever else the file holds.
  const nodes = titles ? vaultNodes(raw.nodes, raw.notes) : []
  const hubs = titles ? vaultHubs(raw.hubs) : []
  if (!nodes || !hubs) return null
  const edges = vaultEdges(raw.edges, raw.notes, hubs)
  if (!edges) return null
  const linked = new Set()
  for (const [from, to, kind] of edges) {
    if (kind < NOTE_KINDS) {
      linked.add(from)
      linked.add(to)
    }
  }
  const vault = {
    name: raw.name,
    level: raw.level,
    notes: raw.notes,
    lines: edges.length,
    lonely: raw.notes - linked.size,
    hidden: raw.hidden,
    more: raw.more,
    moreLines: raw.moreLines,
    edges
  }
  if (!titles) return vault
  return { ...vault, untitled: nodes.filter((node) => node.title === undefined).length, nodes, hubs }
}

function vaultsBlock(raw) {
  const empty = (status, why = null) => ({ status, why, items: [], hidden: 0, more: 0 })
  // Absent is "not found"; present but not a block is a file the board cannot vouch for.
  if (raw === undefined) return empty('not found')
  if (!isPlainObject(raw)) return empty('unavailable')
  if (raw.status === undefined || raw.status === 'not found') return empty('not found', knownWhy(raw.why))
  if (raw.status !== 'found') return empty('unavailable', raw.status === 'unavailable' ? knownWhy(raw.why) : null)
  if (!Array.isArray(raw.items) || !isCount(raw.hidden) || !isCount(raw.more)) return empty('unavailable')
  const kept = keepEntries(raw.items, VAULTS_CAPS.vaults, shapeVault, (vault) => vault.name)
  return { status: 'found', why: null, items: kept.kept, hidden: raw.hidden + kept.hidden, more: raw.more + kept.more }
}

function readVaultsFile(body, now) {
  const envelope = readStatusEnvelope(body, now, { schema: VAULTS_SCHEMA, maxBytes: VAULTS_MAX_BYTES, noun: 'vaults' })
  if (!envelope.usable) return envelope
  const { parsed, takenMs } = envelope
  return {
    usable: true,
    takenMs,
    computer: {
      computer: cleanUsageName(parsed.computer),
      takenAt: isoSeconds(takenMs),
      freshness: now - takenMs > VAULTS_STALE_AFTER_DAYS * 86400_000 ? 'stale' : 'fresh',
      vaults: vaultsBlock(parsed.vaults)
    }
  }
}

// The first five files in name order are read, and the newest three computers shown, as for every
// other status file. `found` is how many the tree holds.
export function shapeVaults(files, now = Date.now(), found = null) {
  return shapeStatusFiles(files, now, found, {
    maxFiles: VAULTS_MAX_FILES, maxComputers: VAULTS_MAX_COMPUTERS, noneWhy: 'No vault has been read yet.', read: readVaultsFile
  })
}
