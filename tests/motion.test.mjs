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

test('every animation runs only when motion is allowed', () => {
  const animated = cssRules().filter((rule) => Object.entries(valuesIn(rule))
    .some(([property, value]) => isAnimation(property) && !/^none\b/.test(value)))
  assert.ok(animated.length >= 2, `only ${animated.length} animated rules found - the sweep has stopped seeing the sheet`)
  for (const rule of animated) assert.ok(inMotionBlock(rule), `${rule.selector} animates outside the motion block`)
})

test('every transition - a transform above all - moves only when motion is allowed', () => {
  const moving = cssRules().filter((rule) => Object.entries(valuesIn(rule))
    .some(([property, value]) => isTransition(property) && !/^none\b/.test(value)))
  assert.ok(moving.length >= 2, `only ${moving.length} transitions found`)
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
