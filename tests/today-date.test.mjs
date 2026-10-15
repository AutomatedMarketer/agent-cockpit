// The Today banner says the day and "Good morning" from the device clock. It was drawn once, so a tab
// left open overnight on a quiet repo still read yesterday's date. These tests pin the small pieces
// that keep the two lines true while the page stays open: the words for a given moment, the next
// moment they can change, the in-place update that touches nothing else, and the timer that re-arms.

import test from 'node:test'
import assert from 'node:assert/strict'
import { loadPage, flush } from './helpers/page-harness.mjs'
import { basePayload } from './helpers/page-payload.mjs'

const EXPOSE = ['bannerWords', 'nextBannerChange', 'refreshBannerWords', 'armBannerClock', 'bannerHtml', 'bannerClock']
const load = (options = {}) => loadPage({ payload: basePayload(), expose: EXPOSE, ...options })

// Local-time dates: the banner speaks the device's clock, so the tests build dates the same way.
const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute)
const dayOf = (date) => `${date.toLocaleDateString(undefined, { weekday: 'long' })} \u00b7 ${date.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}`

test('the greeting changes exactly at 5, 12 and 18 o\'clock', () => {
  const { bannerWords } = load().exposed
  const expected = [[4, 59, 'Good evening'], [5, 0, 'Good morning'], [11, 59, 'Good morning'],
    [12, 0, 'Good afternoon'], [17, 59, 'Good afternoon'], [18, 0, 'Good evening']]
  for (const [hour, minute, words] of expected) {
    assert.equal(bannerWords(at(15, hour, minute), 'Nuno').greeting, `${words}, Nuno.`, `at ${hour}:${minute}`)
  }
})

test('no first name means no comma, and the day line follows the date across midnight', () => {
  const { bannerWords } = load().exposed
  assert.equal(bannerWords(at(15, 9), '').greeting, 'Good morning.')
  assert.equal(bannerWords(at(14, 23, 59), '').day, dayOf(at(14, 23, 59)))
  assert.equal(bannerWords(at(15, 0, 0), '').day, dayOf(at(15, 0, 0)))
  assert.notEqual(bannerWords(at(14, 23, 59), '').day, bannerWords(at(15, 0, 0), '').day)
})

test('the next change is the next 5:00, 12:00, 18:00 or midnight, strictly after now', () => {
  const { nextBannerChange } = load().exposed
  const cases = [[at(15, 4, 59), at(15, 5)], [at(15, 5), at(15, 12)], [at(15, 11, 59), at(15, 12)],
    [at(15, 12), at(15, 18)], [at(15, 17, 59), at(15, 18)], [at(15, 18), at(16, 0)], [at(15, 23, 59), at(16, 0)],
    [at(15, 0, 0), at(15, 5)], [at(31, 23, 0), new Date(2026, 10, 1, 0, 0)]]
  for (const [now, next] of cases) assert.equal(nextBannerChange(now).getTime(), next.getTime(), `after ${now}`)
})

// A banner stand-in: the greeting heading is a text node then the soft sentence, as drawn.
function fakeBanner() {
  const greetingText = { nodeType: 3, nodeValue: 'Good evening, Nuno. ' }
  const soft = { nodeType: 1, textContent: 'Here is where things stand.' }
  const heading = { firstChild: greetingText, children: [soft] }
  const eyebrow = { textContent: 'Wednesday \u00b7 October 14' }
  const strap = { textContent: '3 of 8 agents working' }
  const root = { querySelector: (selector) => ({ '#today .banner .greeting': heading, '#today .banner .eyebrow': eyebrow })[selector] ?? null }
  return { root, heading, greetingText, soft, eyebrow, strap }
}

test('an update rewrites the greeting words and the day line, and leaves everything else alone', () => {
  const { refreshBannerWords } = load().exposed
  const banner = fakeBanner()
  refreshBannerWords(banner.root, at(15, 9), 'Nuno')
  assert.equal(banner.greetingText.nodeValue, 'Good morning, Nuno. ')
  assert.equal(banner.eyebrow.textContent, dayOf(at(15, 9)))
  assert.equal(banner.soft.textContent, 'Here is where things stand.')
  assert.equal(banner.heading.children[0], banner.soft)
  assert.equal(banner.strap.textContent, '3 of 8 agents working')
})

test('a first name is written as text, never as markup', () => {
  const { refreshBannerWords } = load().exposed
  const banner = fakeBanner()
  refreshBannerWords(banner.root, at(15, 9), '<b>Zed</b>')
  assert.equal(banner.greetingText.nodeValue, 'Good morning, <b>Zed</b>. ')
})

test('with no banner on screen an update does nothing, and does not throw', () => {
  const { refreshBannerWords } = load().exposed
  assert.doesNotThrow(() => refreshBannerWords({ querySelector: () => null }, at(15, 9), 'Nuno'))
  assert.doesNotThrow(() => refreshBannerWords({ querySelector: () => ({ firstChild: null }) }, at(15, 9), 'Nuno'))
})

test('a fresh draw is the same markup as before: escaped name, &middot; between the day and the date', async () => {
  const now = at(15, 9)
  const { bannerHtml } = load({ payload: { ...basePayload(), owner: { name: '<x> Smith' } } }).exposed
  await flush()
  const markup = bannerHtml(now)
  const weekday = now.toLocaleDateString(undefined, { weekday: 'long' })
  const date = now.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })
  assert.ok(markup.includes(`<p class="eyebrow">${weekday} &middot; ${date}</p>`))
  assert.match(markup, /<h2 class="greeting">Good morning, &lt;x&gt;\. <span class="soft">Here is where things stand\.<\/span><\/h2>/)
})

test('one timer at a time: arming again cancels the earlier one, and it fires at the next change', () => {
  const calls = { set: [], cleared: [] }
  const timers = {
    setTimeout: (fn, ms) => { calls.set.push({ fn, ms }); return calls.set.length },
    clearTimeout: (id) => { calls.cleared.push(id) }
  }
  const { armBannerClock, bannerClock } = load().exposed
  Object.assign(bannerClock, { set: timers.setTimeout, clear: timers.clearTimeout })
  const before = calls.set.length
  armBannerClock(at(15, 11, 0))
  armBannerClock(at(15, 11, 30))
  const mine = calls.set.slice(before)
  assert.equal(mine.length, 2)
  assert.ok(calls.cleared.includes(before + 1), 'the first timer was not cleared')
  // 30 minutes to noon, plus a small pad so it never fires a hair early.
  assert.ok(mine[1].ms >= 30 * 60 * 1000 && mine[1].ms < 30 * 60 * 1000 + 5000)
})

test('coming back to the tab refreshes safely even when no banner is drawn', () => {
  const page = load()
  const handlers = [...page.documentListeners, ...page.windowListeners].filter((entry) => ['visibilitychange', 'pageshow'].includes(entry.type))
  assert.ok(handlers.some((entry) => entry.type === 'visibilitychange'))
  assert.ok(handlers.some((entry) => entry.type === 'pageshow'))
  for (const entry of handlers) assert.doesNotThrow(() => entry.handler({}))
})
