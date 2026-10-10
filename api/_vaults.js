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

import { isConnectionName } from './state.js'

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
