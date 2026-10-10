// The vaults snapshot: the memory graph of each Obsidian vault the owner named, read from the files
// the status collector commits to .agent-team/status/vaults/. The Memory screen draws it beside the
// team repo's own graph.
//
// The same terms as every other status file: it comes through a repo anybody with push access can
// edit, and the payload goes to a browser on a board that can be public. So every name and title is
// checked again here, the answer is BUILT from the keys the board knows, and a vault published at the
// `shape` level never carries a title, a folder, a day or a tag, whatever the file says.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  VAULTS_SCHEMA,
  VAULTS_FOLDER,
  VAULTS_COMPUTER_SLUG,
  VAULTS_STALE_AFTER_DAYS,
  VAULTS_MAX_FILES,
  VAULTS_MAX_BYTES,
  VAULTS_MAX_COMPUTERS,
  VAULTS_STATUSES,
  VAULTS_CAPS,
  VAULTS_LEVELS,
  VAULTS_EDGE_KINDS,
  VAULTS_HUB_KINDS,
  VAULTS_MIN_HUB_NOTES,
  VAULTS_WHY_CODES,
  VAULTS_ALLOWED_KEYS,
  VAULTS_REQUIRED_KEYS,
  NOTE_TITLE_RULE,
  isNoteTitle,
  isVaultName,
  isVaultsFile
} from '../api/_vaults.js'

const fixtureUrl = new URL('./fixtures/vaults-parity.json', import.meta.url)
const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8'))

/* ---------- the shared contract ---------------------------------------------------------------- */

test('vaults parity: the board reads the folder, schema and limits the collector writes to', () => {
  assert.equal(VAULTS_SCHEMA, fixture.schema)
  assert.equal(VAULTS_FOLDER, fixture.folder)
  assert.equal(VAULTS_COMPUTER_SLUG.source, fixture.computerSlug)
  assert.equal(VAULTS_STALE_AFTER_DAYS, fixture.staleAfterDays)
  assert.equal(VAULTS_MAX_FILES, fixture.maxFilesRead)
  assert.equal(VAULTS_MAX_BYTES, fixture.maxFileBytes)
  assert.equal(VAULTS_MAX_COMPUTERS, fixture.maxComputersShown)
  assert.deepEqual(VAULTS_STATUSES, fixture.statuses)
  assert.deepEqual(VAULTS_CAPS, fixture.caps)
  assert.deepEqual(VAULTS_LEVELS, fixture.levels)
  assert.deepEqual(VAULTS_EDGE_KINDS, fixture.edgeKinds)
  assert.deepEqual(VAULTS_HUB_KINDS, fixture.hubKinds)
  assert.equal(VAULTS_MIN_HUB_NOTES, fixture.minHubNotes)
  assert.deepEqual(VAULTS_WHY_CODES, fixture.whyCodes)
  assert.deepEqual(VAULTS_ALLOWED_KEYS, fixture.allowedKeys)
  assert.deepEqual(VAULTS_REQUIRED_KEYS, fixture.requiredKeys)
})

test('vaults parity: the title rule is the contract\'s, value for value', () => {
  const rule = fixture.titleRule
  assert.equal(NOTE_TITLE_RULE.maxLength, rule.maxLength)
  assert.deepEqual(NOTE_TITLE_RULE.never, rule.never)
  assert.equal(NOTE_TITLE_RULE.uuid.source, rule.uuid)
  assert.equal(NOTE_TITLE_RULE.maxSegmentLength, rule.maxSegmentLength)
  assert.equal(NOTE_TITLE_RULE.separatorCharacters, rule.separatorCharacters)
  assert.equal(NOTE_TITLE_RULE.controlCharacters.source, rule.controlCharacters)
  assert.equal(NOTE_TITLE_RULE.invisibleCharacters.source, rule.invisibleCharacters)
  assert.equal(rule.neverIgnoresCase, true)
  assert.equal(rule.separatorsAlsoWhitespace, true)
})

test('vaults parity: the shared contract file is the same bytes the collector holds', (t) => {
  const sibling = fileURLToPath(new URL('../../agent-team-template/tests/fixtures/vaults-parity.json', import.meta.url))
  if (!existsSync(sibling)) {
    // Skipped, not passed: the reason is in the output so a quiet skip never reads as agreement.
    t.skip(`NOT CHECKED - the vaults contract was not compared with the collector's copy, because ${sibling} does not exist (agent-team-template is not checked out beside agent-cockpit)`)
    return
  }
  assert.equal(readFileSync(sibling, 'utf8'), readFileSync(fixtureUrl, 'utf8'), 'the shared vaults contract has been edited on one side only')
})

test('vaults parity: every title the collector publishes, the board shows; every one it refuses, the board refuses', () => {
  for (const title of fixture.titleRule.accept) assert.equal(isNoteTitle(title), true, `${title} should be a title`)
  for (const { title, why } of fixture.titleRule.acceptEdge) assert.equal(isNoteTitle(title), true, `${JSON.stringify(title)} (${why}) should be a title`)
  for (const { title, why } of fixture.titleRule.refuse) assert.equal(isNoteTitle(title), false, `${JSON.stringify(title)} (${why}) should not be`)
})

test('vaults parity: a vault is called by a name the board would print, and by nothing else', () => {
  for (const name of fixture.names.vaultAccept) assert.equal(isVaultName(name), true, `${name} should be a vault name`)
  for (const { name, why } of fixture.names.vaultRefuse) assert.equal(isVaultName(name), false, `${JSON.stringify(name)} (${why}) should not be`)
})

test('vaults parity: only strings are ever a title or a vault name', () => {
  for (const value of [undefined, null, 7, {}, [], ['Weekly plan'], true]) {
    assert.equal(isNoteTitle(value), false)
    assert.equal(isVaultName(value), false)
  }
})

test('a vaults file is one per computer, in the contract\'s folder, named by its slug', () => {
  assert.equal(isVaultsFile(`${VAULTS_FOLDER}/mac-mini.json`), true)
  assert.equal(isVaultsFile(`${VAULTS_FOLDER}/Mac Mini.json`), false)
  assert.equal(isVaultsFile(`${VAULTS_FOLDER}/sub/mac-mini.json`), false)
  assert.equal(isVaultsFile(`${VAULTS_FOLDER}/mac-mini.yml`), false)
  assert.equal(isVaultsFile('.agent-team/status/jobs/mac-mini.json'), false)
  assert.equal(isVaultsFile(`${VAULTS_FOLDER}/${'a'.repeat(33)}.json`), false)
  assert.equal(isVaultsFile(null), false)
})
