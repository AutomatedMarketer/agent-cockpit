import test from 'node:test'
import assert from 'node:assert/strict'
import { shapeLedger, shapeProposals, shapeHero } from '../api/state.js'

/* The first numbers on this board that come from the owner rather than from the team's own
   activity. Everything else here counts what the agents did; these count what the week costs, in
   their words, from a file they corrected themselves.

   The board only DISPLAYS them. ledger.yml and proposals.yml are validated in the team repo, by a
   checker that re-derives everything and refuses what does not hold up. */

const LEDGER = `owner_type: business
hourly_value: 150

tasks:
  - task: Sorting the inbox
    words: "The inbox eats my morning before I get to anything real"
    who: me
    times_per_week: 5
    minutes_each: 40
    confirmed: twice
    hands_off: "I send them"

  - task: Writing the newsletter
    words: "I write the newsletter myself and it eats most of an afternoon"
    who: me
    times_per_week: 1
    minutes_each: 180
    confirmed: twice
    hands_off: "I read it first"
`

const PROPOSALS = `proposals:
  - task: Sorting the inbox
    item: skill:triage-inbox
    why: "Beat workflow:inbox-triage, which also drafts replies."
    words: "The inbox eats my morning before I get to anything real"
    number: "3.3 hours a week, 500 a week"

gaps:
  - task: Chasing invoices
    question: "Nothing here chases money you are owed - should it?"
`

/* ---------- the ledger --------------------------------------------------------------------- */

test('hours are derived from frequency and duration, never read from the file', () => {
  const ledger = shapeLedger(LEDGER)
  assert.equal(ledger.tasks[0].hoursPerWeek, 10 / 3, '5 x 40 minutes')
  assert.equal(ledger.tasks[1].hoursPerWeek, 3, '1 x 180 minutes')
  assert.equal(Math.round(ledger.hoursPerWeek * 100) / 100, 6.33)
})

test('cost is hours times the rate they gave', () => {
  const ledger = shapeLedger(LEDGER)
  assert.equal(Math.round(ledger.costPerWeek), 950)
  assert.equal(ledger.unpriced, false)
})

/* Zero would read as "this time is free", which is a different claim and a false one - and on a
   dashboard it is the claim made loudest, in the largest type on the screen. */

test('with no rate the cost is null, never zero', () => {
  const ledger = shapeLedger(LEDGER.replace('hourly_value: 150\n', ''))
  assert.equal(ledger.costPerWeek, null)
  assert.equal(ledger.unpriced, true)
  assert.ok(ledger.hoursPerWeek > 0, 'the hours still count - only the money is unknown')
})

test('a nonsense rate is treated as no rate, not as a number', () => {
  for (const bad of ['hourly_value: 0', 'hourly_value: -50']) {
    const ledger = shapeLedger(LEDGER.replace('hourly_value: 150', bad))
    assert.equal(ledger.costPerWeek, null)
  }
})

test('the owner words survive to the screen verbatim', () => {
  const ledger = shapeLedger(LEDGER)
  assert.equal(ledger.tasks[0].words, 'The inbox eats my morning before I get to anything real')
})

test('no ledger.yml is null, which is different from a ledger of zero hours', () => {
  assert.equal(shapeLedger(null), null)
})

/* ---------- proposals ----------------------------------------------------------------------- */

test('proposals carry the three citations to the screen', () => {
  const shaped = shapeProposals(PROPOSALS)
  assert.equal(shaped.proposals.length, 1)
  assert.equal(shaped.proposals[0].item, 'skill:triage-inbox')
  assert.equal(shaped.proposals[0].words, 'The inbox eats my morning before I get to anything real')
  assert.equal(shaped.proposals[0].number, '3.3 hours a week, 500 a week')
  assert.ok(shaped.proposals[0].why)
})

test('gaps come through with their reason - they are half the answer', () => {
  const shaped = shapeProposals(PROPOSALS)
  assert.equal(shaped.gaps.length, 1)
  assert.equal(shaped.gaps[0].task, 'Chasing invoices')
  assert.match(shaped.gaps[0].question, /should it\?/)
})

test('a proposals file with neither list does not throw', () => {
  const shaped = shapeProposals('nothing: here\n')
  assert.deepEqual(shaped.proposals, [])
  assert.deepEqual(shaped.gaps, [])
})

/* ---------- the hero number ----------------------------------------------------------------- */

/* tiles.yml has named `hero: hours-saved` since the day it was written, and `hours-saved` exists
   nowhere - not in the tiles catalogue, not in any code. That is the declaration-nothing-backs bug
   this whole build exists to kill, sitting in the one place everybody looks first.

   So the hero resolves honestly or not at all. It never renders a zero, because a zero here is a
   claim about somebody's week. */

test('a hero the board can compute comes back with its number', () => {
  const hero = shapeHero({ hero: 'hours-a-week' }, shapeLedger(LEDGER))
  assert.equal(hero.defined, true)
  assert.equal(Math.round(hero.value * 100) / 100, 6.33)
  assert.equal(hero.unit, 'hours a week')
})

test('a hero nothing computes is reported as undefined, not as zero', () => {
  const hero = shapeHero({ hero: 'hours-saved' }, shapeLedger(LEDGER))
  assert.equal(hero.defined, false)
  assert.equal(hero.value, undefined, 'no number at all, rather than a zero somebody would read')
  assert.match(hero.why, /hours-saved/)
})

test('a money hero with no rate behind it is undefined, not zero', () => {
  const unpriced = shapeLedger(LEDGER.replace('hourly_value: 150\n', ''))
  const hero = shapeHero({ hero: 'cost-a-week' }, unpriced)
  assert.equal(hero.defined, false)
  assert.match(hero.why, /ledger/)
})

test('a hero with no ledger behind it says so', () => {
  const hero = shapeHero({ hero: 'hours-a-week' }, null)
  assert.equal(hero.defined, false)
  assert.match(hero.why, /no ledger/)
})

test('no hero named in tiles.yml means no hero, not a broken one', () => {
  assert.equal(shapeHero({}, shapeLedger(LEDGER)), null)
  assert.equal(shapeHero(null, shapeLedger(LEDGER)), null)
})

/* ---------- the hero can never be a number it cannot source ------------------------------------ */

/* These three all produced a giant "0" on the front of the board, and the money one produced
   "$0 a week at the rate you set" — the exact this-time-is-free claim the cost field refuses to
   make, arriving through the back door. A zero here is a claim about somebody's week. */

test('a ledger with no tasks has no hero, rather than a hero of zero', () => {
  const empty = shapeLedger('owner_type: business\nhourly_value: 150\ntasks:\n')
  const hero = shapeHero({ hero: 'hours-a-week' }, empty)
  assert.equal(hero.defined, false)
  assert.equal(hero.value, undefined)
  assert.match(hero.why, /no hours/)
})

test('a ledger whose numbers will not parse says so, rather than reporting zero', () => {
  const broken = shapeLedger('owner_type: business\nhourly_value: 150\ntasks:\n  - task: X\n    words: "w"\n    times_per_week: abc\n    minutes_each: 30\n')
  assert.equal(broken.unreadable, 1, 'the unreadable row is counted, not silently dropped')
  assert.equal(broken.complete, false)
  const hero = shapeHero({ hero: 'hours-a-week' }, broken)
  assert.equal(hero.defined, false)
  assert.match(hero.why, /could not be read/)
})

test('a money hero off an empty ledger is refused, never rendered as $0', () => {
  const empty = shapeLedger('owner_type: business\nhourly_value: 150\ntasks:\n')
  assert.equal(shapeHero({ hero: 'cost-a-week' }, empty).defined, false)
})

test('a partly readable ledger still reports its readable hours, and says one row was not', () => {
  const partial = shapeLedger(
    'owner_type: business\nhourly_value: 150\ntasks:\n' +
    '  - task: Good\n    words: "w"\n    times_per_week: 5\n    minutes_each: 40\n' +
    '  - task: Bad\n    words: "w"\n    times_per_week: abc\n    minutes_each: 30\n'
  )
  assert.equal(Math.round(partial.hoursPerWeek * 100) / 100, 3.33)
  assert.equal(partial.unreadable, 1)
  assert.equal(partial.complete, false, 'a total with a hole in it is not a statement about their week')
})
