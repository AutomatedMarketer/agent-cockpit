// Type, cards and the shell (plan 2026-10-10, task T3).
//
// The big words are light and tight - a display weight around 480, numbers a step heavier - instead
// of bold. Legibility holds where it matters: body text is never under 16px (iOS zooms into a field
// under that, and Nuno reads this board), nothing anywhere is under .625rem, and the light weights
// are only for words 28px and over. Cards get the room a laptop has; a phone keeps its own.
import test from 'node:test'
import assert from 'node:assert/strict'
import { cssRules } from './helpers/css-rules.mjs'

const valuesIn = (rule) => Object.fromEntries(rule.body.split(';')
  .map((part) => part.trim()).filter(Boolean)
  .map((part) => [part.slice(0, part.indexOf(':')).trim(), part.slice(part.indexOf(':') + 1).trim()]))
const names = (rule) => rule.selector.split(',').map((one) => one.trim())
const rules = cssRules()
// The plain :root tokens (the second unconditional :root - the first holds the colours).
const tokens = Object.assign({}, ...rules.filter((rule) => !rule.inMedia && rule.selector === ':root').map(valuesIn))
const resolve = (value) => String(value ?? '').replace(/var\((--[\w-]+)\)/g, (whole, name) => tokens[name] ?? whole)
const saying = (selector, property) => rules.filter((rule) => names(rule).includes(selector) && valuesIn(rule)[property] !== undefined)

const DISPLAY = ['.banner .greeting', '.banner .headline']
const NUMBERS = ['.kpi-value', '.kpi .hero-value', '.hero-value']

test('display words are light: every weight they are given is 520 or less', () => {
  for (const selector of DISPLAY) {
    const weights = saying(selector, 'font-weight')
    assert.ok(weights.length, `${selector} has no weight of its own`)
    for (const rule of weights) {
      const weight = Number(resolve(valuesIn(rule)['font-weight']))
      assert.ok(weight <= 520, `${selector} is weight ${weight}${rule.condition ? ` (${rule.condition})` : ''} - the display words are meant to be light`)
    }
    // Light only where the words are big: the phone size is the display token, 28px at the least.
    const size = resolve(Object.assign({}, ...saying(selector, 'font-size').filter((rule) => !rule.inMedia).map(valuesIn))['font-size'])
    assert.match(size, /^clamp\(1\.75rem,/, `${selector} on a phone is ${size}, not the display size`)
  }
})

test('the big numbers are a step heavier than the display words, and never bold', () => {
  for (const selector of NUMBERS) {
    const weights = saying(selector, 'font-weight')
    assert.ok(weights.length, `${selector} has no weight of its own`)
    for (const rule of weights) {
      const weight = Number(resolve(valuesIn(rule)['font-weight']))
      assert.ok(weight <= 560, `${selector} is weight ${weight} - a number in a light family reads heavy at 700`)
      assert.ok(weight >= 450, `${selector} is weight ${weight} - too thin to read as a number`)
    }
  }
})

test('body text stays 16px, and nothing on the board is smaller than .625rem', () => {
  const body = Object.assign({}, ...rules.filter((rule) => !rule.inMedia && rule.selector === 'body').map(valuesIn))
  assert.match(body.font ?? body['font-size'] ?? '', /^16px\b/, 'body text is no longer 16px')
  const small = []
  for (const rule of rules) {
    const size = resolve(valuesIn(rule)['font-size'])
    if (!size) continue
    const rem = /^([\d.]+)rem$/.exec(size)
    const px = /^([\d.]+)px/.exec(size)
    if ((rem && Number(rem[1]) < 0.625) || (px && Number(px[1]) < 10)) small.push(`${rule.selector} ${size}`)
  }
  assert.deepEqual(small, [], `text under .625rem:\n${small.join('\n')}`)
})

test('the number cards carry our own faint ring-and-dot in a corner, as decoration only', () => {
  const mark = Object.assign({}, ...rules.filter((rule) => !rule.inMedia && rule.selector === '.kpi::after').map(valuesIn))
  assert.equal(mark.content, '""', 'no corner mark on the number cards')
  assert.equal(mark['pointer-events'], 'none', 'the corner mark can be pressed')
  assert.equal(mark.position, 'absolute')
  // A ring (a border) and a dot (a gradient) in the ink, faint.
  assert.match(mark.border ?? '', /color-mix\(in srgb, var\(--ink\) \d+%, transparent\)/)
  assert.match(mark.background ?? '', /radial-gradient/)
})

test('a laptop gives cards room: card padding, grid gaps, page padding and a taller top bar from 64rem', () => {
  const wide = (selector) => Object.assign({}, ...rules.filter((rule) => names(rule).includes(selector) && /min-width: 64rem/.test(rule.condition ?? '')).map(valuesIn))
  assert.equal(wide('.card').padding, '1.35rem 1.5rem')
  for (const grid of ['.kpis', '.plan-cards', '.team-grid', '.board']) assert.equal(wide(grid).gap, '1.1rem', `${grid} keeps its phone gap on a laptop`)
  assert.match(wide('.wrap').padding ?? '', /^[\d.]+rem 2rem/, 'the page has no 2rem sides on a laptop')
  const bar = Object.assign({}, ...rules.filter((rule) => names(rule).includes('.topbar') && /min-width: (48|64)rem/.test(rule.condition ?? '')).map(valuesIn))
  assert.equal(bar['min-height'], '4rem')
  // The phone keeps its own padding: a card's laptop room is not a phone's.
  const phone = Object.assign({}, ...rules.filter((rule) => !rule.inMedia && rule.selector === '.card').map(valuesIn))
  assert.equal(phone.padding, '1rem 1.1rem')
  // The wide rule sits below the unconditional one, so it wins.
  const phoneAt = rules.find((rule) => !rule.inMedia && rule.selector === '.card').at
  const wideAt = rules.find((rule) => names(rule).includes('.card') && /min-width: 64rem/.test(rule.condition ?? '')).at
  assert.ok(wideAt > phoneAt, 'the laptop card padding sits above the phone rule, so it never applies')
})

test('banners and number cards take the radius tokens: 18 on a phone, 22 on a wide screen', () => {
  const at = (selector, wide) => Object.assign({}, ...rules.filter((rule) => names(rule).includes(selector) &&
    (wide ? /min-width: (48|64)rem/.test(rule.condition ?? '') : !rule.inMedia)).map(valuesIn))['border-radius']
  assert.equal(at('.banner', false), 'var(--radius)')
  assert.equal(at('.banner', true), 'var(--radius-lg)')
  assert.equal(at('.kpi', false), 'var(--radius)')
  assert.equal(at('.kpi', true), 'var(--radius-lg)')
})
