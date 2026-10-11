// Reading a search on the device (public/memory-find.js): the day it names, in the device's own time
// zone; the folder it names; the topic words left over; and, for a word the board has never seen, the
// known names that sound like it. Pure: no network, no page. The file is a plain script the page loads
// when Memory opens, so it is run here the same way, on its own.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../public/memory-find.js', import.meta.url), 'utf8')
const { memoryQueryParts, memorySoundKey, memoryStandIns, memoryHeardAs } =
  new Function(`${source}\n;return { memoryQueryParts, memorySoundKey, memoryStandIns, memoryHeardAs }`)()

// Sunday 11 October 2026, midday in London.
const SUNDAY = Date.parse('2026-10-11T11:00:00Z')
const FOLDERS = ['agents', 'docs', 'inbox', 'shared', 'workflows']
const read = (question, { now = SUNDAY, timeZone = 'Europe/London', folders = FOLDERS } = {}) => memoryQueryParts(question, { now, timeZone, folders })
const span = (parts) => (parts.day ? `${parts.day.from}..${parts.day.to}` : null)

const PHRASINGS = [
  // question, day window, place, missing place, topic words, asks meaning
  ['what did I save today', '2026-10-11..2026-10-11', null, null, [], false],
  ['yesterday', '2026-10-10..2026-10-10', null, null, [], false],
  ['notes from yesterday', '2026-10-10..2026-10-10', null, null, [], false],
  ['morning intel from last Tuesday', '2026-10-06..2026-10-06', null, null, ['morning', 'intel'], true],
  ['tuesday', '2026-10-06..2026-10-06', null, null, [], false],
  ['what did I save on Sunday', '2026-10-11..2026-10-11', null, null, [], false],
  ['last Sunday', '2026-10-04..2026-10-04', null, null, [], false],
  ['on 3 October', '2026-10-03..2026-10-03', null, null, [], false],
  ['October 3', '2026-10-03..2026-10-03', null, null, [], false],
  ['the 3rd of October', '2026-10-03..2026-10-03', null, null, [], false],
  ['oct 3rd', '2026-10-03..2026-10-03', null, null, [], false],
  ['on 2026-10-06', '2026-10-06..2026-10-06', null, null, [], false],
  ['on 12 October', '2025-10-12..2025-10-12', null, null, [], false],
  ['this week', '2026-10-05..2026-10-11', null, null, [], false],
  ['last week', '2026-09-28..2026-10-04', null, null, [], false],
  ['in shared about writing', null, 'shared', null, ['writing'], true],
  ['something in shared about how we write', null, 'shared', null, ['write'], true],
  ['in my inbox from yesterday', '2026-10-10..2026-10-10', 'inbox', null, [], false],
  ['in the inbox folder', null, 'inbox', null, [], false],
  ['in the agent folder', null, 'agents', null, [], false],
  ['under Shared', null, 'shared', null, [], false],
  ['something in my finance folder', null, null, 'finance', [], false],
  ['in my finance', null, null, 'finance', [], false],
  ['what is in the offer sheet', null, null, null, ['offer', 'sheet'], true],
  ['anything in my notes about pricing', null, null, null, ['pricing'], true],
  ['when does a task count as finished', null, null, null, ['task', 'count', 'finished'], true],
  ['what are we selling and for how much', null, null, null, ['selling'], true],
  ['who I am and what I do', null, null, null, [], true],
  ['questions customers keep asking', null, null, null, ['questions', 'customers', 'asking'], true],
  ['orkestrator', null, null, null, ['orkestrator'], true],
  ['the definition of done', null, null, null, ['definition', 'done'], true],
  ['what did I save on Tuesday in my inbox', '2026-10-06..2026-10-06', 'inbox', null, [], false],
  ['on 31 February', null, null, null, ['31', 'february'], true],
  ['', null, null, null, [], false]
]

test(`${PHRASINGS.length} ways of asking: the day, the place, the topic words, and whether meaning is asked`, () => {
  assert.ok(PHRASINGS.length >= 30)
  for (const [question, day, place, missing, words, meaning] of PHRASINGS) {
    const parts = read(question)
    assert.equal(span(parts), day, `${question}: day`)
    assert.equal(parts.place, place, `${question}: place`)
    assert.equal(parts.placeMissing, missing, `${question}: missing place`)
    assert.deepEqual(parts.words, words, `${question}: words`)
    assert.equal(Boolean(parts.meaningText), meaning, `${question}: meaning asked`)
  }
})

test('what is sent for meaning is the question without its day and place, never just a day or a place', () => {
  assert.equal(read('morning intel from last Tuesday').meaningText, 'morning intel')
  assert.equal(read('something in shared about how we write').meaningText, 'something about how we write')
  assert.equal(read('who I am and what I do').meaningText, 'who i am and what i do')
  assert.equal(read('what did I save today').meaningText, '')
  assert.equal(read('in the inbox folder').meaningText, '')
  assert.equal(read('in my finance folder').meaningText, '', 'a folder that does not exist is said, never searched for')
  assert.equal(read('hi').meaningText, '', 'fewer than 3 letters is not asked')
})

test('each day has a label for the why-line', () => {
  assert.equal(read('today').day.label, 'today')
  assert.equal(read('yesterday').day.label, 'yesterday')
  assert.equal(read('this week').day.label, 'this week')
  assert.equal(read('last week').day.label, 'last week')
  assert.equal(read('last Tuesday').day.label, 'Tuesday 6 October')
  assert.equal(read('on 3 October').day.label, 'Saturday 3 October')
  assert.equal(read('on 12 October').day.label, 'Sunday 12 October 2025')
})

test('"today" is the device\'s own day: at 23:30 UTC it is still Sunday in New York and already Monday in Tokyo', () => {
  const late = Date.parse('2026-10-11T23:30:00Z')
  assert.equal(span(read('today', { now: late, timeZone: 'America/New_York' })), '2026-10-11..2026-10-11')
  assert.equal(span(read('today', { now: late, timeZone: 'Asia/Tokyo' })), '2026-10-12..2026-10-12')
  assert.equal(span(read('yesterday', { now: late, timeZone: 'America/New_York' })), '2026-10-10..2026-10-10')
  assert.equal(span(read('yesterday', { now: late, timeZone: 'Asia/Tokyo' })), '2026-10-11..2026-10-11')
  assert.equal(span(read('last Sunday', { now: late, timeZone: 'Asia/Tokyo' })), '2026-10-11..2026-10-11', 'in Tokyo it is Monday, so last Sunday is yesterday')
  assert.equal(span(read('this week', { now: late, timeZone: 'Asia/Tokyo' })), '2026-10-12..2026-10-12')
  assert.equal(span(read('today', { now: late, timeZone: 'Not/AZone' })), '2026-10-11..2026-10-11', 'a zone the device cannot name is UTC')
})

test('a folder is matched without regard to case or a plural, and only when it is one of the folders', () => {
  assert.equal(read('in Agents').place, 'agents')
  assert.equal(read('in the workflow folder').place, 'workflows')
  assert.equal(read('in the doc folder').place, 'docs')
  assert.equal(read('in my Inboxes').place, 'inbox')
  assert.equal(read('in shared', { folders: ['Shared'] }).place, 'Shared', 'the folder\'s own spelling is kept')
  assert.equal(read('in the morning').place, null)
  assert.equal(read('in the morning').placeMissing, null, 'an ordinary "in the ..." is not a missing folder')
})

/* ---------- sounds like ---------- */

test('a sound key: the first letter, then the consonants as they sound', () => {
  assert.equal(memorySoundKey('orkestrator'), memorySoundKey('orchestrator'))
  assert.equal(memorySoundKey('secuirty'), memorySoundKey('security'))
  assert.equal(memorySoundKey('markting'), memorySoundKey('marketing'))
  assert.equal(memorySoundKey('custumer'), memorySoundKey('customer'))
  assert.equal(memorySoundKey('marketting'), memorySoundKey('marketing'), 'a double letter is one sound')
  assert.equal(memorySoundKey('chekk'), memorySoundKey('check'))
  assert.equal(memorySoundKey('fone'), memorySoundKey('phone').replace(/^p/, 'f'))
  assert.notEqual(memorySoundKey('sales'), memorySoundKey('tales'), 'the first letter must match')
})

test('stand-ins: known words that sound alike, same first letter, the same consonants or one different, at most 2', () => {
  const vocabulary = ['orchestrator', 'operations', 'sales', 'security', 'secretary', 'brief', 'writing', 'marketing', 'market']
  assert.deepEqual(memoryStandIns('orkestrator', vocabulary), ['orchestrator'])
  assert.deepEqual(memoryStandIns('secuirty', vocabulary), ['security'], 'one consonant more is not the same as two')
  assert.deepEqual(memoryStandIns('brieg', vocabulary), ['brief'], 'one consonant different')
  assert.deepEqual(memoryStandIns('markting', vocabulary), ['marketing', 'market'].slice(0, memoryStandIns('markting', vocabulary).length))
  assert.ok(memoryStandIns('markting', vocabulary).length <= 2)
  assert.deepEqual(memoryStandIns('writ', vocabulary), [], 'a word that starts a known word is known')
  assert.deepEqual(memoryStandIns('sale', vocabulary), [], 'known')
  assert.deepEqual(memoryStandIns('market', vocabulary), [], 'a known word is never heard as another')
  assert.deepEqual(memoryStandIns('sls', vocabulary), [], 'under 4 letters, even when it sounds like a known word')
  assert.deepEqual(memoryStandIns('tisks', ['tanks', 'tasks']), ['tasks', 'tanks'], 'the same sound before one consonant off')
  assert.deepEqual(memoryStandIns('tisps', ['tanks']), [], 'two consonants off is not a stand-in')
  assert.deepEqual(memoryStandIns('zzz', vocabulary), [], 'under 4 letters')
  assert.deepEqual(memoryStandIns('pizza', vocabulary), [], 'nothing sounds like it')
  const many = ['tasks', 'tusks', 'tasks2', 'teskes', 'tosks']
  assert.equal(memoryStandIns('tisks', many).length, 2)
})

test('heard as: stand-ins for the topic words the board does not know, at most 4 in a question', () => {
  const vocabulary = ['orchestrator', 'security', 'marketing', 'customer', 'brief']
  assert.deepEqual(memoryHeardAs(['orkestrator', 'writing'], vocabulary), [{ word: 'orkestrator', as: 'orchestrator' }])
  const heard = memoryHeardAs(['orkestrator', 'secuirty', 'markting', 'custumer', 'brieg'], vocabulary)
  assert.equal(heard.length, 4)
  assert.deepEqual(heard.map((one) => one.word), ['orkestrator', 'secuirty', 'markting', 'custumer'])
})
