import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/* This dashboard is the one asset in the Level 2 build that is extended and never rebuilt. Six
   screens shipped and were used; two day-one bugs were found against them by a live rehearsal that
   local tests had passed clean. Losing one to a refactor would be a real regression that nothing
   else here would catch, because every other test covers the API rather than the page.

   So this asserts the floor: the six that shipped still exist, and the page still knows how to
   show them. New screens are welcome. Missing ones are not. */

const page = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8')

const SHIPPED_SCREENS = ['today', 'team', 'workflows', 'skills', 'memory', 'connections']

test('every screen that shipped still has its nav entry', () => {
  for (const screen of SHIPPED_SCREENS) {
    assert.match(page, new RegExp(`data-screen="${screen}"`), `the ${screen} screen lost its nav entry`)
  }
})

test('every screen that shipped still has somewhere to render into', () => {
  for (const screen of SHIPPED_SCREENS) {
    assert.match(page, new RegExp(`id="${screen}"`), `the ${screen} screen lost its container`)
  }
})

test('every screen that shipped is still registered for routing', () => {
  const declared = /const SCREENS = \[([^\]]+)\]/.exec(page)
  assert.ok(declared, 'the SCREENS list should still exist')
  for (const screen of SHIPPED_SCREENS) {
    assert.match(declared[1], new RegExp(`'${screen}'`), `${screen} is not in the SCREENS list, so its hash will not route`)
  }
})

test('the ledger screen was added without displacing anything', () => {
  assert.match(page, /data-screen="ledger"/)
  assert.match(page, /id="ledger"/)
  const declared = /const SCREENS = \[([^\]]+)\]/.exec(page)
  assert.match(declared[1], /'ledger'/)
})

/* The hero number is the reason UI1 exists, and the reason it took this long: tiles.yml has named
   a metric nothing computes since the day it was written. The page must be able to say that. */

test('the page can render a hero that cannot be computed, rather than a zero', () => {
  assert.match(page, /No hero number yet/, 'an undefined hero needs its own empty state')
  assert.match(page, /would be a claim about your week/, 'and it should say why a zero is not shown instead')
})

test('proposals are rendered with all three citations, not just a name', () => {
  assert.match(page, /you said:/, 'their words')
  assert.match(page, /that is:/, 'their number')
  assert.match(page, /data-approve=/, 'and the item, with something to approve')
})

test('the gaps list is rendered, not tucked away', () => {
  assert.match(page, /Nothing on the team does these yet/)
})

/* --- UI2: which jobs actually ring ------------------------------------------------------------
   The board reported nine jobs running, each with a next-run time, against one real routine. The
   schedule chip said "daily 06:30" and looked exactly like a fact. */

test('the workflows screen shows an arm state, not just a schedule', () => {
  for (const state of ['ARMED', 'DECLARED', 'UNAPPROVED', 'OFF']) {
    assert.match(page, new RegExp(state), `the ${state} state has no label on screen`)
  }
})

test('a declared job is told it is a wish, not given a next-run time', () => {
  assert.match(page, /Nothing fires this/)
  assert.match(page, /is a wish until you arm it/)
})

test('unapproved spend is named as spend nobody approved', () => {
  assert.match(page, /spending runs nobody approved/)
})

test('the snapshot is always presented as a snapshot, with its age', () => {
  assert.match(page, /This is a snapshot, not a live reading/)
  assert.match(page, /Which of these actually ring is unknown/, 'and an absent one says so')
  assert.match(page, /run <code>\/routines<\/code> again before/, 'and a stale one says so')
})

test('orphan routines are reported and explicitly not adopted', () => {
  assert.match(page, /Reported, not adopted/)
})

test('the schedule chip is only lit when something actually rings', () => {
  assert.match(page, /const scheduleLive = workflow\.arm === 'armed' \|\| workflow\.arm === 'unapproved'/)
})
