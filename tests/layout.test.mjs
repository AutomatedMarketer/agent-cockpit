// One column under 1024px.
//
// The brief's rule: a phone and a tablet get one column; more than one appears only from 64rem
// (1024px). It was broken between 768 and 1023: the task board went two-up from 48rem, and the
// number cards, plan cards and team grid used auto-fit, so beside the 240px sidebar they landed
// two to a row on a tablet (plan 2026-10-10, finding 17; screenshots layout-*-768/1023).
//
// In-card lists are exempt on purpose: the rings in a plan card, the setup ladder and the found
// lists sit INSIDE one card and wrap within it - they are not page columns.
import test from 'node:test'
import assert from 'node:assert/strict'
import { cssRules } from './helpers/css-rules.mjs'

const PAGE_GRIDS = ['.kpis', '.plan-cards', '.team-grid', '.board', '.days7', '.hermes-cards', '.rd-grid', '.rd-off', '.mg-body']
const IN_CARD = ['.meters', '.ladder', '.found-list', '.found-tools']
// Grids that are one column everywhere, wide screens included.
const ALWAYS_ONE = new Set(['.hermes-cards'])

const valuesIn = (rule) => Object.fromEntries(rule.body.split(';')
  .map((part) => part.trim()).filter(Boolean)
  .map((part) => [part.slice(0, part.indexOf(':')).trim(), part.slice(part.indexOf(':') + 1).trim()]))
const names = (rule) => rule.selector.split(',').map((one) => one.trim())
const ONE = /^(1fr|minmax\(0,\s*1fr\))$/
// The smallest width a rule waits for, in rem; 0 for a rule that does not wait for one.
const minWidth = (rule) => Math.max(0, ...[...(rule.condition ?? '').matchAll(/min-width:\s*([\d.]+)rem/g)].map((found) => Number(found[1])))

test('every page grid is one column until the screen is 64rem wide', () => {
  const rules = cssRules()
  for (const selector of PAGE_GRIDS) {
    const columns = rules.filter((rule) => names(rule).includes(selector) && valuesIn(rule)['grid-template-columns'])
    assert.ok(columns.length, `nothing sets the columns of ${selector}`)
    for (const rule of columns) {
      const value = valuesIn(rule)['grid-template-columns']
      if (minWidth(rule) >= 64) continue
      assert.match(value, ONE, `${selector} is "${value}" below 64rem${rule.condition ? ` (${rule.condition})` : ''} - a tablet gets more than one column`)
    }
    const wide = columns.filter((rule) => minWidth(rule) >= 64 && !ONE.test(valuesIn(rule)['grid-template-columns']))
    if (ALWAYS_ONE.has(selector)) assert.equal(wide.length, 0, `${selector} was meant to stay one column`)
    else assert.ok(wide.length, `${selector} never goes past one column, even on a laptop`)
  }
})

test('the in-card lists are named as exempt, and are not page grids', () => {
  for (const selector of IN_CARD) assert.ok(!PAGE_GRIDS.includes(selector))
  const rules = cssRules()
  for (const selector of IN_CARD) assert.ok(rules.some((rule) => names(rule).includes(selector)), `${selector} is gone - drop it from the exempt list`)
})
