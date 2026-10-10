// The words the board shows on the chip beside the Claude status line reading. The template's guides
// quote them, so a student can match what they read to what they see on the board.
//
// tests/fixtures/board-chip-parity.json is the shared contract: the same bytes in agent-team-template
// and here. The template holds its guides to it without reading this repo; these tests hold the page.
// If the chip ever changes, the fixture changes in both repos, and the guides with it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadPage, script, flush } from './helpers/page-harness.mjs'
import { basePayload } from './helpers/page-payload.mjs'

const fixtureUrl = new URL('./fixtures/board-chip-parity.json', import.meta.url)
const contract = JSON.parse(readFileSync(fixtureUrl, 'utf8'))

// What a person reads: the page's markup with its entities turned back into the characters they show.
const shown = (markup) => String(markup)
  .replace(/<[^>]*>/g, '')
  .replace(/&rsquo;/g, '’').replace(/&lsquo;/g, '‘').replace(/&amp;/g, '&').replace(/&#39;/g, "'")

test('the chip contract is the one the template holds: one phrase per source, and the old words', () => {
  assert.deepEqual(Object.keys(contract).sort(), ['about', 'chips', 'oldWording'])
  assert.deepEqual(Object.keys(contract.chips), ['claude-code-statusline'])
  assert.ok(contract.oldWording.length > 0)
})

test('the status line reading wears exactly the chip the shared contract names', async () => {
  const page = loadPage({ payload: basePayload(), expose: ['sourceChipHtml'] })
  await flush()
  for (const [source, words] of Object.entries(contract.chips)) {
    assert.equal(shown(page.exposed.sourceChipHtml(source)), words, `the ${source} chip does not say "${words}"`)
  }
})

test('the old chip wording appears nowhere the page can show it', () => {
  for (const old of contract.oldWording) {
    assert.ok(!script.includes(old), `app.js still says "${old}"`)
    assert.ok(!shown(script).includes(old), `app.js still says "${old}", written with an entity`)
  }
})

test('the two repos hold the same chip contract, byte for byte', (t) => {
  const sibling = fileURLToPath(new URL('../../agent-team-template/tests/fixtures/board-chip-parity.json', import.meta.url))
  if (!existsSync(sibling)) {
    // Skipped, not passed: the reason is in the output so a quiet skip never reads as agreement.
    t.skip(`NOT CHECKED - the chip contract was not compared with the template's copy, because ${sibling} does not exist (agent-team-template is not checked out beside agent-cockpit)`)
    return
  }
  assert.equal(readFileSync(sibling, 'utf8'), readFileSync(fixtureUrl, 'utf8'), 'the shared chip contract has been edited on one side only')
})
