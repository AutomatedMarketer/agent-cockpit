// The README's Mac mailbox (plan 2026-10-12-mac-mailbox, task C9): how it works, what it costs at the
// pace Nuno chose (every 5 minutes, decision D4) and at the default, how to switch it on and back off,
// every setting in the settings table, where an order's words go, and a line for each new refusal.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { orderLifeSeconds } from '../api/_mailbox.js'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const README = read('README.md')
const section = (heading) => {
  const from = README.indexOf(`\n## ${heading}\n`)
  assert.ok(from >= 0, `README.md has no "## ${heading}" section`)
  const to = README.indexOf('\n## ', from + 1)
  return README.slice(from, to < 0 ? undefined : to)
}
const MAILBOX = 'Orders on your own computer (Mac mailbox)'

test('the README has the Mac mailbox section the board\'s own sentences point to', () => {
  const sentences = read('api/_mailbox.js') + read('api/_voice.js')
  assert.match(sentences, /"Orders on your own computer"/)
  section(MAILBOX)
})

test('it says how it works: signed orders, the Mac\'s own key, the life of an order, what runs with AI and what does not', () => {
  const text = section(MAILBOX)
  for (const words of ['FIRE_MODE=mailbox', 'HMAC-SHA256', 'MAILBOX_SECRET', 'MAILBOX_KEY', '/api/mailbox', 'no AI', 'no shell', 'no connectors', 'files a card for you to finish', '.agent-team/status/mailbox/', 'expired', 'outcome unknown']) {
    assert.ok(text.includes(words), `the mailbox section does not say "${words}"`)
  }
  // The life of an order at the two paces it names, worked out by the board's own rule.
  assert.equal(orderLifeSeconds(300), 17 * 60)
  assert.equal(orderLifeSeconds(600), 32 * 60)
  assert.ok(text.includes('17 minutes') && text.includes('32 minutes'))
})

test('the costs are counted at a 5-minute pace (Nuno\'s), the 10-minute default, and the 1 minute it warns against', () => {
  const text = section(MAILBOX)
  const polls = (minutes) => (31 * 24 * 60) / minutes
  assert.equal(polls(5), 8928)
  assert.equal(polls(10), 4464)
  assert.equal(polls(1), 44640)
  for (const words of ['8,928', '4,464', '44,640', '89%', '45%', 'MAILBOX_POLL_SECONDS=300', 'locked for 30 days', 'vercel.com/docs/vercel-blob/usage-and-pricing', 'checked 12 October 2026']) {
    assert.ok(text.includes(words), `the costs do not say "${words}"`)
  }
  assert.match(text, /8 orders a day/)
})

test('the budget section has the mailbox\'s split: 2 x 15 + 10 + 2 + 8 + 5 = 55', () => {
  assert.ok(README.includes('2 × 15 + 10 + 2 + 8 + 5 = 55'), 'the budget section does not give the mailbox split')
})

test('every mailbox setting the board reads is in the settings table and in .env.example', () => {
  const names = new Set([...read('api/_mailbox.js').matchAll(/env\.(MAILBOX_[A-Z_]+|FIRE_MODE)\b/g)].map((match) => match[1]))
  assert.ok(names.size >= 6, 'the settings were not read from api/_mailbox.js')
  const rows = README.split('\n').filter((line) => line.startsWith('| `'))
  const example = read('.env.example')
  for (const name of names) {
    assert.ok(rows.some((line) => line.startsWith(`| \`${name}\``)), `${name} is not in the settings table`)
    assert.match(example, new RegExp(`^#? ?${name}=`, 'm'), `${name} is not in .env.example`)
  }
  const fireKey = rows.find((line) => line.startsWith('| `FIRE_KEY`'))
  assert.match(fireKey, /24 characters/)
})

test('"What goes where" says an order\'s words wait in the picture store, then go to the Mac', () => {
  const row = README.split('\n').find((line) => line.startsWith('| In mailbox mode'))
  assert.ok(row, 'no "What goes where" row for mailbox mode')
  assert.match(row, /picture store/)
  assert.match(row, /your Mac/)
})

test('When it breaks has a line for each new refusal and state', () => {
  const text = section('When it breaks')
  // In the words the board and the voice actually say (api/_voice.js, macOrderSaid; api/_mailbox.js).
  for (const words of ['The Mac mailbox is not configured', 'FIRE_KEY must be 24 characters', 'all 8 orders it allows today', 'has not picked it up yet', 'expired before your Mac picked it up', 'Your Mac refused it', 'lost track of this one part-way', 'not switched on for this board', 'Missing or wrong mailbox key']) {
    assert.ok(text.includes(words), `When it breaks has no line for "${words}"`)
  }
})
