// The week calendar on the front screen: which days it spans, and which pills earn a tick.
//
// weekDates, dateKey and ranOnDays live in api/lib.js and are mirrored verbatim inside
// public/index.html's inline script (the page has no module loading) — the last test here
// is the contract that keeps the mirror honest.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { weekDates, dateKey, ranOnDays } from '../api/lib.js'

const page = fileURLToPath(new URL('../public/index.html', import.meta.url))

/* ---------- weekDates ---------- */

test('the week starts on Monday, whatever day it is asked on', () => {
  for (const day of [1, 2, 3, 4, 5, 6, 7]) {
    // 2026-06-01 was a Monday, so this walks Mon..Sun.
    const week = weekDates(new Date(2026, 5, day, 13, 30))
    assert.equal(week.length, 7)
    assert.equal(week[0].getDay(), 1, `asked on the ${day}th, week did not start on Monday`)
    assert.equal(dateKey(week[0]), '2026-06-01')
    assert.equal(dateKey(week[6]), '2026-06-07')
  }
})

test('Sunday belongs to the week that just ended, not the one starting', () => {
  const week = weekDates(new Date(2026, 5, 7, 23, 59)) // Sunday
  assert.equal(dateKey(week[6]), '2026-06-07', 'Sunday is the last column, never the first')
})

test('a week spanning a month boundary still runs Monday to Sunday', () => {
  const week = weekDates(new Date(2026, 6, 2)) // Thu 2 Jul 2026
  assert.deepEqual(week.map(dateKey), [
    '2026-06-29', '2026-06-30', '2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05'
  ])
})

test('dateKey is local, not UTC - the calendar answers "did today run"', () => {
  // 23:30 local on the 1st is the 2nd in UTC. Keying by UTC would file the run under
  // tomorrow and the day would render as missed while the work sat in the inbox.
  assert.equal(dateKey(new Date(2026, 5, 1, 23, 30)), '2026-06-01')
  assert.equal(dateKey(new Date(2026, 5, 1, 0, 30)), '2026-06-01')
})

/* ---------- ranOnDays ---------- */

const runOn = (workflow, date) => ({ workflow, started_at: date.toISOString() })

test('a run marks the day its workflow ran', () => {
  const days = ranOnDays([runOn('morning-intel', new Date(2026, 5, 3, 6, 30))], 'morning-intel')
  assert.deepEqual([...days], ['2026-06-03'])
})

test('another workflow\'s run never marks this one', () => {
  const runs = [runOn('draft-queue', new Date(2026, 5, 3, 7, 0))]
  assert.equal(ranOnDays(runs, 'morning-intel').size, 0)
})

test('a run log with no workflow field counts for nothing, not for everything', () => {
  const runs = [{ agent: 'research', started_at: new Date(2026, 5, 3).toISOString() }]
  assert.equal(ranOnDays(runs, 'morning-intel').size, 0)
})

test('an unparseable or missing timestamp is skipped rather than throwing', () => {
  const runs = [
    { workflow: 'morning-intel', started_at: 'not a date' },
    { workflow: 'morning-intel' },
    runOn('morning-intel', new Date(2026, 5, 4, 6, 30))
  ]
  assert.deepEqual([...ranOnDays(runs, 'morning-intel')], ['2026-06-04'])
})

test('two runs on one day mark that day once', () => {
  const runs = [
    runOn('morning-intel', new Date(2026, 5, 3, 6, 30)),
    runOn('morning-intel', new Date(2026, 5, 3, 18, 0))
  ]
  assert.deepEqual([...ranOnDays(runs, 'morning-intel')], ['2026-06-03'])
})

test('no slug, no runs, and no list are all empty rather than errors', () => {
  assert.equal(ranOnDays([], 'morning-intel').size, 0)
  assert.equal(ranOnDays(undefined, 'morning-intel').size, 0)
  assert.equal(ranOnDays([runOn('x', new Date())], undefined).size, 0)
})

/* ---------- the page ---------- */

test('the calendar renders on the front screen, reading real runs', async () => {
  const html = await readFile(page, 'utf8')
  assert.match(
    html,
    /scheduleStripHtml\(data\.workflows, \{ dates: true, runs: data\.runs/,
    'Today must render the dated calendar, not the plain strip'
  )
})

test('a pill still to come is never marked missed', async () => {
  const html = await readFile(page, 'utf8')
  assert.match(html, /if \(due\.getTime\(\) > nowMs\) return \{ klass: '', mark: '' \}/,
    'calling an 18:00 job missed at 09:00 is a lie the dashboard must not tell')
})

test('a new workflow is requested as a card, because this page never writes the repo', async () => {
  const html = await readFile(page, 'utf8')
  assert.match(html, /id="wf-open"/, 'the front screen needs a New workflow button')
  assert.match(html, /submitWorkflowRequest/)
  assert.match(html, /action: 'task'[\s\S]{0,400}for: 'orchestrator'/,
    'the request must go through the task action to the orchestrator')
})

test("the page's inline script parses - a broken escape ships a blank dashboard", async () => {
  const html = await readFile(page, 'utf8')
  const blocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1])
  assert.ok(blocks.length, 'the page has no inline script')
  for (const source of blocks) {
    // Compiles without running: catches syntax errors in browser-only code that node
    // cannot import. The tests below check behaviour; this one checks it loads at all.
    assert.doesNotThrow(() => new Function(source), 'the inline script does not parse')
  }
})

test('the mirrored helpers in the page match api/lib.js exactly', async () => {
  const html = await readFile(page, 'utf8')
  const lib = await readFile(fileURLToPath(new URL('../api/lib.js', import.meta.url)), 'utf8')
  const slice = (source, start, end) => {
    const from = source.indexOf(start)
    assert.notEqual(from, -1, `could not find ${start}`)
    const to = source.indexOf(end, from)
    assert.notEqual(to, -1, `could not find ${end}`)
    return source.slice(from, to).trim()
  }
  const fromLib = slice(lib, 'export function weekDates', 'export function splitTaskText')
    .replace(/export function /g, 'function ')
    .replace(/export const /g, 'const ')
  const fromPage = slice(html, 'function weekDates', 'function scheduleStripHtml')
  assert.equal(fromPage, fromLib, 'the page copy has drifted from api/lib.js')
})
