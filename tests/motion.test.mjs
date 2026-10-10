// Motion: what moves on the board, and that none of it moves for someone whose device asks for less.
//
// Plan 2026-10-10 (look and feel), section 3. Every moving rule - every transition and every
// animation, and the keyframes they play - sits in ONE `@media (prefers-reduced-motion:
// no-preference)` block at the end of the sheet. Written that way round, a device that asks for
// less motion never meets a moving rule at all, rather than meeting one and then a rule that
// switches it off (which loses if it is ever placed above the rule it switches off). And at the
// end, because a media query adds no specificity: an override above the rule it overrides is dead.
//
// Durations come from the motion tokens, so the whole board's pace is one block of values.
import test from 'node:test'
import assert from 'node:assert/strict'
import { cssRules } from './helpers/css-rules.mjs'

const NO_PREFERENCE = /^@media \(prefers-reduced-motion: no-preference\)/
const valuesIn = (rule) => Object.fromEntries(rule.body.split(';')
  .map((part) => part.trim()).filter(Boolean)
  .map((part) => [part.slice(0, part.indexOf(':')).trim().toLowerCase(), part.slice(part.indexOf(':') + 1).trim()]))
const isAnimation = (property) => property === 'animation' || property.startsWith('animation-')
const isTransition = (property) => property === 'transition' || property.startsWith('transition-')
const moves = (rule) => Object.entries(valuesIn(rule)).some(([property, value]) =>
  (isAnimation(property) || isTransition(property)) && !/^none\b/.test(value))
// The block a rule sits in, outermost first: the motion block is the outermost gate.
const inMotionBlock = (rule) => NO_PREFERENCE.test(rule.condition ?? '')
const names = (rule) => rule.selector.split(',').map((one) => one.trim())

test('every animation runs only when motion is allowed', () => {
  const animated = cssRules().filter((rule) => Object.entries(valuesIn(rule))
    .some(([property, value]) => isAnimation(property) && !/^none\b/.test(value)))
  assert.ok(animated.length >= 6, `only ${animated.length} animated rules found - the sweep has stopped seeing the sheet`)
  for (const rule of animated) assert.ok(inMotionBlock(rule), `${rule.selector} animates outside the motion block`)
})

test('every transition - a transform above all - moves only when motion is allowed', () => {
  const moving = cssRules().filter((rule) => Object.entries(valuesIn(rule))
    .some(([property, value]) => isTransition(property) && !/^none\b/.test(value)))
  assert.ok(moving.length >= 6, `only ${moving.length} transitions found`)
  for (const rule of moving) assert.ok(inMotionBlock(rule), `${rule.selector} has a transition outside the motion block`)
  // And so nothing needs switching off: no rule anywhere writes transition: none or animation: none
  // under reduce, because there is nothing there to switch off.
  const stillers = cssRules().filter((rule) => /prefers-reduced-motion:\s*reduce/.test(rule.condition ?? ''))
  assert.deepEqual(stillers.map((rule) => rule.selector), [], 'a reduce block is switching off motion that should never have been outside the motion block')
})

test('the keyframes live in the motion block too, so a device that asked for less never even has them', () => {
  const frames = cssRules().filter((rule) => /^(from|to|[\d.]+%(\s*,\s*[\d.]+%)*)$/.test(rule.selector))
  assert.ok(frames.length >= 4, `only ${frames.length} keyframe steps found`)
  for (const rule of frames) assert.ok(inMotionBlock(rule), `a keyframe step (${rule.selector}) sits outside the motion block`)
})

test('the motion block is one block, at the end of the sheet, below every rule it can override', () => {
  const rules = cssRules()
  const motion = rules.filter(inMotionBlock)
  const rest = rules.filter((rule) => !inMotionBlock(rule))
  assert.ok(motion.length >= 8, `only ${motion.length} rules in the motion block`)
  const lastOther = Math.max(...rest.map((rule) => rule.at))
  const firstMotion = Math.min(...motion.map((rule) => rule.at))
  assert.ok(firstMotion > lastOther, 'a rule sits below the motion block, so the block is not the end of the sheet - or there are two')
  // Every rule that moves is in it: no second no-preference block somewhere else.
  for (const rule of rules.filter(moves)) assert.ok(inMotionBlock(rule), `${rule.selector} moves outside the one block`)
})

test('durations come from the motion tokens: no raw seconds or milliseconds in a transition or animation', () => {
  const RAW = /(^|[\s,(])\d*\.?\d+m?s\b/
  const offenders = []
  for (const rule of cssRules()) {
    if (rule.selector === ':root') continue
    for (const [property, value] of Object.entries(valuesIn(rule))) {
      if ((isAnimation(property) || isTransition(property)) && RAW.test(value)) offenders.push(`${rule.selector} { ${property}: ${value} }`)
    }
  }
  assert.deepEqual(offenders, [], `raw durations:\n${offenders.join('\n')}`)
})

/* ---------- what moves (plan section 3, task T4) ---------- */

const motionRules = () => cssRules().filter(inMotionBlock)
const animationOf = (rule) => valuesIn(rule).animation ?? valuesIn(rule)['animation-name'] ?? ''

test('a screen fades in when it is opened - on the screen itself, never on a card a redraw rebuilds', () => {
  const enter = motionRules().filter((rule) => names(rule).includes('.screen.active') && animationOf(rule))
  assert.equal(enter.length, 1, 'no enter animation on the screen that is shown')
  assert.match(animationOf(enter[0]), /var\(--dur-3\) var\(--ease-out\)/)
  // Readiness redraws its cards every minute; an animation on a card would replay each time.
  const CARDS = /\.(rd-card|rd-grid|rd-group|kpi|agent-card|found-computer|hermes-card)\b/
  for (const rule of cssRules().filter((one) => animationOf(one) && !/^none\b/.test(animationOf(one)))) {
    assert.doesNotMatch(rule.selector, CARDS, `${rule.selector} animates a card that is rebuilt on every redraw`)
  }
})

test('cards you can press lift under a mouse, and only there; a static panel never lifts', () => {
  const lifts = motionRules().filter((rule) => /translateY\(-/.test(valuesIn(rule).transform ?? ''))
  const hovered = lifts.filter((rule) => /:hover/.test(rule.selector))
  for (const rule of hovered) {
    assert.match(rule.condition, /\(hover: hover\) and \(pointer: fine\)/, `${rule.selector} lifts on a touch screen, where a hover sticks after a tap`)
  }
  for (const card of ['.agent-card', 'a.d7-row', '.copy-card', 'button.job']) {
    assert.ok(hovered.some((rule) => names(rule).some((one) => one.startsWith(card) && one.includes(':hover'))), `${card} does not lift under a mouse`)
    assert.ok(lifts.some((rule) => names(rule).some((one) => one.startsWith(card) && one.includes(':focus-visible'))), `${card} does not lift for the keyboard`)
  }
  for (const rule of lifts) {
    assert.ok(!names(rule).some((one) => /^\.panel(:hover|:focus-visible)/.test(one) || /^\.(rd-card|kpi|hermes-card)\b/.test(one)), `${rule.selector} lifts something that cannot be pressed`)
  }
})

test('a press answers: buttons and card summaries give a little under the finger', () => {
  const press = motionRules().filter((rule) => /scale\(\.98\)/.test(valuesIn(rule).transform ?? ''))
  for (const target of ['button.fire:active', '.agent-card > summary:active', '.copy-card > summary:active']) {
    assert.ok(press.some((rule) => names(rule).includes(target)), `${target} has no press feedback`)
  }
})

test('folds fade open, the sparkline draws once, and the banner pictures drift slowly', () => {
  const rules = motionRules()
  assert.ok(rules.some((rule) => /details\[open\] > :not\(summary\)/.test(rule.selector) && /var\(--dur-fold\)/.test(animationOf(rule))), 'opened folds do not fade in')
  const spark = rules.filter((rule) => names(rule).includes('.spark') && animationOf(rule))
  assert.equal(spark.length, 1, 'the sparkline does not draw in')
  assert.doesNotMatch(animationOf(spark[0]), /infinite/, 'the sparkline draws for ever')
  const drift = rules.filter((rule) => names(rule).some((one) => /\.banner img$/.test(one)) && animationOf(rule))
  assert.ok(drift.length, 'the banner pictures stand still')
  assert.match(animationOf(drift[0]), /var\(--dur-drift\).*infinite alternate/)
})
