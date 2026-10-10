// The Readiness screen: where it sits, what it draws from the server's cards, how it ages them while
// the board is open, and how it looks on a phone and a desktop. The page is booted for real in the
// small stand-in DOM in tests/helpers/page-harness.mjs, and the stylesheet is read as rules.
//
// Everything on this screen is set as text on elements the page makes. A job's name and a run's
// summary come from a repo, so the tests plant markup in them and look for an element that should
// not exist.
import test from 'node:test'
import assert from 'node:assert/strict'
import { cssRules, sheetText } from './helpers/css-rules.mjs'
import { loadPage, flush, html, script } from './helpers/page-harness.mjs'
import { basePayload } from './helpers/page-payload.mjs'
import { shapeReadiness, orderCards, countCards } from '../api/readiness.js'

const NOW = Date.now()
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')
const walk = (node, found = []) => {
  found.push(node)
  for (const child of node.children ?? []) walk(child, found)
  return found
}
const textOf = (node) => `${node.textContent ?? ''}${(node.children ?? []).map(textOf).join('')}`.replace(/\s/g, ' ')
const withClass = (root, name) => walk(root).filter((node) => (node.className ?? '').split(/\s+/).includes(name))
const flat = (text) => text.replace(/\s+/g, ' ').trim()

const workflow = (patch = {}) => ({
  slug: 'daily-brief', name: 'Daily brief', owner: 'research', ownerSwitchedOff: false, schedule: 'daily 06:00',
  arm: 'armed', armed: true, reason: null, fire: false, webhook: false,
  lastRun: { started_at: iso(NOW - 3600_000), status: 'ok', summary: '', session_url: null },
  ...patch
})
// A wall like the reference: 2 NO GO, 5 SILENT, 23 GO.
const referenceWorkflows = () => [
  ...Array.from({ length: 2 }, (_, index) => workflow({ slug: `declared-${index}`, name: `Declared ${index}`, arm: 'declared', lastRun: null })),
  ...Array.from({ length: 5 }, (_, index) => workflow({ slug: `never-${index}`, name: `Never ${index}`, lastRun: null })),
  ...Array.from({ length: 23 }, (_, index) => workflow({ slug: `ok-${String(index).padStart(2, '0')}`, name: `Ok ${String(index).padStart(2, '0')}`, schedule: 'hourly', lastRun: { started_at: iso(NOW - 600_000), status: 'ok', summary: '', session_url: null } }))
]
const wallPayload = (workflows = referenceWorkflows(), extra = {}) => ({
  ...basePayload(),
  generatedAt: iso(NOW),
  readiness: shapeReadiness({ workflows, routines: { known: true, orphans: [] }, now: NOW, ...extra })
})

const CLOCK = "readinessClock.locale = 'en-US'; readinessClock.zone = 'UTC'"
async function boot(payload, options = {}) {
  const page = loadPage({ payload, hash: '#readiness', after: CLOCK, expose: ['ageReadiness', 'readinessScheduleText', 'readinessSentence', 'readinessWhen', 'readinessOrder', 'readinessCount', 'readinessCountsText', 'renderReadiness', 'readinessClock'], ...options })
  await flush()
  return page
}

/* ---------- where it sits ---------------------------------------------------------------------- */

test('the Readiness screen has a nav entry after Workflows, and somewhere to render into', () => {
  const tabs = html.slice(html.indexOf('<div class="tabs">'), html.indexOf('</div>', html.indexOf('<div class="tabs">')))
  const order = [...tabs.matchAll(/data-screen="([a-z]+)"/g)].map((match) => match[1])
  assert.deepEqual(order.slice(0, 6), ['today', 'ledger', 'team', 'workflows', 'readiness', 'skills'])
  assert.match(tabs, /<a href="#readiness" data-screen="readiness">[\s\S]*?Readiness<span class="count" id="count-readiness"><\/span><\/a>/)
  const containers = [...html.matchAll(/<div id="([a-z]+)" class="screen/g)].map((match) => match[1])
  assert.deepEqual(containers.slice(0, 5), ['today', 'ledger', 'team', 'workflows', 'readiness'])
})

test('the screen is registered for routing with the title Flight readiness, in nav order', () => {
  const titles = /const TITLES = \{([^}]+)\}/.exec(html)[1]
  assert.ok(titles.includes("readiness: 'Flight readiness'"))
  assert.ok(titles.indexOf('workflows:') < titles.indexOf('readiness:') && titles.indexOf('readiness:') < titles.indexOf('skills:'))
})

test('opening #readiness shows the screen and its title', async () => {
  const page = await boot(wallPayload())
  assert.equal(page.node('screen-title').textContent, 'Flight readiness')
  assert.ok(page.node('readiness').classList.contains('active'))
  assert.ok(!page.node('today').classList.contains('active'))
})

test('the tab says how many need a look: NO GO plus SILENT, and nothing when there are none', async () => {
  const page = await boot(wallPayload())
  assert.equal(page.node('count-readiness').textContent, '7')
  const calm = await boot(wallPayload([workflow()]))
  assert.equal(calm.node('count-readiness').textContent, '')
})

/* ---------- what it draws --------------------------------------------------------------------- */

test('the counters line, the note and the stamp say what the wall is made of', async () => {
  const page = await boot(wallPayload())
  const root = page.node('readiness')
  const [counters] = withClass(root, 'rd-counters')
  assert.equal(counters.textContent, '2 NO GO · 5 SILENT · 23 GO')
  assert.equal(counters.attributes.role, 'status', 'a live region, so a change in a count is announced')
  const [note] = withClass(root, 'rd-note')
  assert.equal(flat(note.textContent), "Counted from each job's last report. 0 faded: their last report is older than their own schedule.", 'with no Mac reading, nothing is said about the Mac')
  const [stamp] = withClass(root, 'rd-stamp')
  assert.match(stamp.textContent, /^JOBS CHECKED NEVER · BOARD READ \d{1,2}:\d{2}\s?(AM|PM) · REFRESH BY BUTTON$/)
})

test('NO GO comes first in the page, then SILENT, then GO, each under a heading that says how many', async () => {
  const page = await boot(wallPayload())
  const root = page.node('readiness')
  const headings = withClass(root, 'rd-heading').map((node) => [node.tagName, node.textContent])
  assert.deepEqual(headings, [['H3', 'No go, 2'], ['H3', 'Silent, 5'], ['H3', 'Go, 23']])
  const cards = withClass(root, 'rd-card')
  assert.equal(cards.length, 30)
  assert.deepEqual(cards.map((card) => card.className.split(' ')[1]).filter((value, index, list) => list.indexOf(value) === index), ['rd-no-go', 'rd-silent', 'rd-go'])
  assert.deepEqual(cards.slice(0, 2).map((card) => card.className.includes('rd-no-go')), [true, true])
  for (const group of withClass(root, 'rd-group')) {
    assert.ok(group.attributes['aria-labelledby'], 'a group is named by its heading')
    assert.equal(walk(group).find((node) => node.className?.includes('rd-heading')).attributes.id, group.attributes['aria-labelledby'])
  }
})

test('a card is a list item with the light decorative, the status as a word, the name, a sentence and two labelled rows', async () => {
  const page = await boot(wallPayload())
  const root = page.node('readiness')
  const lists = withClass(root, 'rd-grid')
  assert.equal(lists.length, 3)
  for (const list of lists) {
    assert.equal(list.tagName, 'UL')
    for (const item of list.children) assert.equal(item.tagName, 'LI')
  }
  const [card] = withClass(root, 'rd-card')
  const light = withClass(card, 'rd-light')[0]
  assert.equal(light.attributes['aria-hidden'], 'true')
  assert.equal(light.textContent, '', 'the light carries no text of its own')
  assert.equal(withClass(card, 'rd-word')[0].textContent, 'NO GO')
  assert.equal(withClass(card, 'rd-name')[0].textContent, 'Declared 0')
  assert.equal(withClass(card, 'rd-sentence')[0].textContent, 'Declared 0 is marked on, but no routine exists, so nothing fires it.')
  const rows = withClass(card, 'rd-row').map((row) => [row.children[0].tagName, row.children[0].textContent, row.children[1].tagName, flat(row.children[1].textContent)])
  assert.deepEqual(rows, [['DT', 'Schedule', 'DD', 'Every day at 6:00 AM'], ['DT', 'Last report', 'DD', 'Never']])
  assert.equal(withClass(card, 'rd-ref')[0].textContent, 'Team repo · declared-0')
  assert.equal(card.attributes['data-id'], 'workflow:declared-0')
})

test('times in a sentence and in the Last report row are filled in the reader\'s own clock', async () => {
  const lastRun = { started_at: iso(NOW - 1800_000), status: 'ok', summary: '', session_url: null }
  const page = await boot(wallPayload([workflow({ lastRun, schedule: 'hourly' })]))
  const [card] = withClass(page.node('readiness'), 'rd-card')
  const clock = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' }).format(NOW - 1800_000)
  assert.equal(withClass(card, 'rd-sentence')[0].textContent, `Daily brief ran clean at ${clock}.`)
  assert.equal(flat(withClass(card, 'rd-row')[1].children[1].textContent), clock)
  assert.doesNotMatch(textOf(card), /\{time\}|\{date\}|\{hours\}/)
})

test('a service that is up shows the RUNNING pill, as a word', async () => {
  const takenAt = iso(NOW - 600_000)
  const hermes = { status: 'ok', computers: [{ computer: 'Mac Mini', takenAt, alive: 'running', install: { status: 'found' } }] }
  const page = await boot(wallPayload([], { hermes }))
  const [card] = withClass(page.node('readiness'), 'rd-card')
  assert.equal(withClass(card, 'rd-pill')[0].textContent, 'RUNNING')
  assert.equal(withClass(card, 'rd-word')[0].textContent, 'GO')
  assert.equal(withClass(card, 'rd-sentence')[0].textContent.startsWith('Hermes was running when the Mac checked at '), true)
})

test('a faded card says so in a sentence and is marked, not only dimmed', async () => {
  const lastRun = { started_at: iso(NOW - 26 * 3600_000), status: 'ok', summary: '', session_url: null }
  const page = await boot(wallPayload([workflow({ lastRun })]))
  const [card] = withClass(page.node('readiness'), 'rd-card')
  assert.ok(card.className.split(' ').includes('rd-faded'))
  assert.match(withClass(card, 'rd-sentence')[0].textContent, /Its last report is older than its own schedule\.$/)
  assert.match(withClass(page.node('readiness'), 'rd-note')[0].textContent, /1 faded: their last report is older/)
})

test('switched-off jobs are listed with the reason, under their own heading, and are not lit', async () => {
  const page = await boot(wallPayload([workflow(), workflow({ slug: 'old', name: 'Old one', arm: 'off', armed: false, reason: 'Off until the pipeline has people in it.' })]))
  const root = page.node('readiness')
  assert.equal(withClass(root, 'rd-card').length, 1)
  assert.deepEqual(withClass(root, 'rd-heading').map((node) => node.textContent), ['Go, 1', 'Switched off, 1'])
  const [item] = withClass(root, 'rd-off-item')
  assert.equal(withClass(item, 'rd-name')[0].textContent, 'Old one')
  assert.equal(withClass(item, 'rd-sentence')[0].textContent, 'Switched off: Off until the pipeline has people in it.')
})

test('what the wall could not see is said under the lights', async () => {
  const page = await boot(wallPayload([workflow()]))
  const notes = withClass(page.node('readiness'), 'rd-foot').map((node) => node.textContent)
  assert.ok(notes.some((text) => text.startsWith('The Mac has not reported its jobs yet')))
  assert.ok(notes.some((text) => text.startsWith('Windows Task Scheduler, n8n, Trigger.dev and Codex automations are not checked here')))
  const withRoutines = await boot({ ...wallPayload([workflow()]), readiness: { ...wallPayload([workflow()]).readiness, routinesKnown: false } })
  assert.ok(withClass(withRoutines.node('readiness'), 'rd-foot').some((node) => node.textContent.startsWith('The list of routines on your account is not fresh')))
  const hidden = wallPayload([workflow()])
  hidden.readiness.counts.hiddenBySafety = 3
  const safe = await boot(hidden)
  assert.ok(withClass(safe.node('readiness'), 'rd-foot').some((node) => node.textContent.startsWith('3 jobs were kept off the wall by the safety check on names.')))
  hidden.readiness.counts.hiddenBySafety = 1
  const one = await boot(hidden)
  assert.ok(withClass(one.node('readiness'), 'rd-foot').some((node) => node.textContent.startsWith('1 job was kept off the wall')))
})

test('an empty wall says so, and a server without the wall says that instead of showing nothing', async () => {
  const empty = await boot(wallPayload([]))
  assert.match(textOf(empty.node('readiness')), /No jobs to show yet/)
  assert.equal(withClass(empty.node('readiness'), 'rd-counters')[0].textContent, '0 NO GO · 0 SILENT · 0 GO')
  const old = await boot({ ...basePayload() })
  assert.match(old.node('readiness').textContent, /does not have the Readiness wall yet/)
  assert.equal(old.node('count-readiness').textContent, '')
})

/* ---------- repo text is only ever text -------------------------------------------------------- */

test('markup in a name or a summary is shown as the characters it is, never built into the page', async () => {
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>&amp;'
  const lastRun = { started_at: iso(NOW - 600_000), status: 'failed', summary: `${evil} broke.`, session_url: null }
  const page = await boot(wallPayload([workflow({ name: evil, schedule: 'hourly', lastRun })]))
  const root = page.node('readiness')
  const tags = new Set(walk(root).map((node) => node.tagName).filter(Boolean))
  for (const tag of ['IMG', 'SCRIPT', 'IFRAME', 'A']) assert.ok(!tags.has(tag), `a ${tag} was built from repo text`)
  assert.equal(withClass(root, 'rd-name')[0].textContent, evil)
  assert.ok(withClass(root, 'rd-sentence')[0].textContent.includes('<img src=x onerror=alert(1)>'))
  assert.equal(root.innerHTML, '', 'the screen was never written to as markup')
  for (const node of walk(root)) assert.equal(node.innerHTML, '', 'an element on this screen was written to as markup')
})

test('the code that draws the wall never builds markup', () => {
  const block = script.slice(script.indexOf('/* ---------- Readiness: begin'), script.indexOf('/* ---------- Readiness: end ---------- */'))
  assert.ok(block.length > 3000, 'the Readiness block was not found')
  for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'createContextualFragment', 'DOMParser', 'eval(', 'new Function']) {
    assert.ok(!block.includes(forbidden), `the Readiness code uses ${forbidden}`)
  }
})

/* ---------- ageing while the board is open ----------------------------------------------------- */

const aging = async (readiness) => {
  const page = await boot({ ...basePayload(), generatedAt: iso(NOW), readiness })
  return page.exposed
}
const card = (patch = {}) => ({
  id: 'workflow:a', source: 'workflow', name: 'A', ref: 'Team repo · a', light: 'go', word: 'GO', pill: null, faded: false,
  sentence: { text: 'A ran clean at {time}.', at: '2026-08-10T06:00:20Z' }, schedule: { text: 'Every day at 6:00am UTC', clock: { every: 'day', hour: 6, minute: 0, weekday: null, day: null } },
  lastReport: { text: '{time}', at: '2026-08-10T06:00:20Z' },
  fadesAt: '2026-08-11T06:30:00Z', silentAt: '2026-08-12T06:30:00Z', silentSentence: { text: 'Has not reported since {date}.', at: '2026-08-10T06:00:20Z' },
  ...patch
})
const wall = (cards) => ({ cards, fadedNote: 'Its last report is older than its own schedule.', switchedOff: [], counts: {}, jobs: { status: 'ok' } })

test('a card fades at its fadesAt and goes silent at its silentAt, with no request', async () => {
  const { ageReadiness } = await aging(wall([card()]))
  const at = (value) => Date.parse(value)
  const before = ageReadiness(wall([card()]), at('2026-08-11T06:29:59Z'))
  assert.deepEqual([before.cards[0].light, before.cards[0].faded], ['go', false])
  const faded = ageReadiness(wall([card()]), at('2026-08-11T06:30:00Z'))
  assert.deepEqual([faded.cards[0].light, faded.cards[0].faded, faded.counts.faded], ['go', true, 1])
  assert.equal(faded.cards[0].sentence.text, 'A ran clean at {time}. Its last report is older than its own schedule.')
  const silent = ageReadiness(wall([card()]), at('2026-08-12T06:30:00Z'))
  assert.deepEqual([silent.cards[0].light, silent.cards[0].word, silent.cards[0].faded, silent.badge], ['silent', 'SILENT', false, 1])
  assert.deepEqual(silent.cards[0].sentence, { text: 'Has not reported since {date}.', at: '2026-08-10T06:00:20Z' })
})

test('a service that has not been checked for eight hours goes silent and loses its RUNNING pill', async () => {
  const running = card({ light: 'go', pill: 'RUNNING', fadesAt: null, silentAt: '2026-10-09T23:00:00Z', silentSentence: { text: "Not checked since {date}. The Mac's last reading is {hours} h old.", at: '2026-10-09T15:00:00Z' } })
  const { ageReadiness } = await aging(wall([running]))
  const silent = ageReadiness(wall([running]), Date.parse('2026-10-09T23:00:01Z'))
  assert.deepEqual([silent.cards[0].light, silent.cards[0].pill], ['silent', null])
})

test('a card that is already silent, or has nothing to age into, never changes', async () => {
  const quiet = card({ light: 'silent', word: 'SILENT', fadesAt: null, silentAt: null, silentSentence: null })
  const { ageReadiness } = await aging(wall([quiet]))
  const later = ageReadiness(wall([quiet]), Date.parse('2030-01-01T00:00:00Z'))
  assert.deepEqual(later.cards[0], quiet)
})

test('ageing reorders and recounts: a NO GO card that goes silent drops below the other NO GOs', async () => {
  const failing = card({ id: 'workflow:f', name: 'F', light: 'no-go', word: 'NO GO', fadesAt: null, silentAt: '2026-08-12T06:30:00Z' })
  const stuck = card({ id: 'workflow:s', name: 'S', light: 'no-go', word: 'NO GO', fadesAt: null, silentAt: null, silentSentence: null })
  const { ageReadiness } = await aging(wall([failing, stuck]))
  const aged = ageReadiness(wall([failing, stuck]), Date.parse('2026-08-13T00:00:00Z'))
  assert.deepEqual(aged.cards.map((one) => [one.name, one.light]), [['S', 'no-go'], ['F', 'silent']])
  assert.deepEqual(aged.counts, { noGo: 1, silent: 1, go: 0, faded: 0 })
})

test('the screen draws the cards as they are at the moment it is drawn', async () => {
  const stale = card({ silentAt: '2026-08-12T06:30:00Z' })
  const page = await boot({ ...basePayload(), generatedAt: iso(NOW), readiness: wall([stale]) })
  const [drawn] = withClass(page.node('readiness'), 'rd-card')
  assert.ok(drawn.className.includes('rd-silent'), 'a card past its silentAt was drawn lit')
  assert.equal(withClass(page.node('readiness'), 'rd-counters')[0].textContent, '0 NO GO · 1 SILENT · 0 GO')
  assert.equal(page.node('count-readiness').textContent, '1')
})

test('the counters are a live region that is only touched when a count changes', async () => {
  const page = await boot(wallPayload())
  const { renderReadiness } = page.exposed
  const [counters] = withClass(page.node('readiness'), 'rd-counters')
  let writes = 0
  let text = counters.textContent
  Object.defineProperty(counters, 'textContent', { get: () => text, set: (value) => { writes += 1; text = value } })
  renderReadiness(NOW)
  renderReadiness(NOW + 1000)
  assert.equal(writes, 0, 'the counters were rewritten with the same words')
  assert.equal(withClass(page.node('readiness'), 'rd-counters')[0], counters, 'the live region was replaced instead of kept')
})

/* ---------- the page's copy of the order and the count is the server's ------------------------- */

test('the page orders and counts cards exactly as the server does', async () => {
  const { readinessOrder, readinessCount } = (await boot(wallPayload([]))).exposed
  const lights = ['no-go', 'silent', 'go']
  const cards = []
  for (const light of lights) for (const faded of [false, true]) for (const name of ['b', 'a', 'B', 'ä']) cards.push({ id: `${light}:${faded}:${name}`, light, faded, name })
  const shuffled = [...cards].reverse().sort((a, b) => (a.name > b.name ? 1 : -1))
  assert.deepEqual([...shuffled].sort(readinessOrder).map((one) => one.id), orderCards(shuffled).map((one) => one.id))
  assert.deepEqual(readinessCount(cards), countCards(cards))
})

test('the sentence filler: {time} is a clock on the same day and a date and clock on another; {date} says today and yesterday; {hours} counts', async () => {
  const { readinessSentence } = (await boot(wallPayload([]))).exposed
  const now = Date.parse('2026-10-09T15:05:00Z')
  const say = (text, at) => readinessSentence({ text, at }, now).replace(/\s/g, ' ')
  assert.equal(say('At {time}.', '2026-10-09T06:15:00Z'), 'At 6:15 AM.')
  assert.equal(say('At {time}.', '2026-10-08T06:15:00Z'), 'At 6:15 AM yesterday.')
  assert.equal(say('At {time}.', '2026-10-01T06:15:00Z'), 'At 6:15 AM on Thu, Oct 1.')
  // Earlier today is the clock time, not the word "today": "not checked since today" says nothing.
  assert.equal(say('Since {date}.', '2026-10-09T06:15:00Z'), 'Since 6:15 AM.')
  assert.equal(say('Not checked since {date}.', '2026-10-09T14:59:00Z'), 'Not checked since 2:59 PM.')
  assert.equal(say('Since {date}.', '2026-10-08T23:00:00Z'), 'Since yesterday.')
  assert.equal(say('Since {date}.', '2026-10-01T06:15:00Z'), 'Since Thu, Oct 1.')
  assert.equal(say('{hours} h old', '2026-10-09T03:00:00Z'), '12 h old')
  assert.equal(say('{hours} h old', '2026-10-09T16:00:00Z'), '0 h old', 'a time that has not come yet is zero hours, not minus one')
  assert.equal(say('No time {time} here', null), 'No time  here')
  assert.equal(say('At {time}.', 'garbage'), 'At an unknown time.')
  assert.equal(say('Nothing to fill.', '2026-10-09T06:15:00Z'), 'Nothing to fill.')
  assert.equal(readinessSentence(null, now), '')
  assert.equal(say('{other} stays', '2026-10-09T06:15:00Z'), '{other} stays')
})

/* ---------- a schedule in the reader's own time ------------------------------------------------- */

// The app's own rule is that times are said in the reader's local time, never UTC. A routine runs in
// UTC, so the server sends the clock time and the page puts it in the reader's zone - which can move
// the day as well as the hour.
test('a team-repo schedule is said in the reader\'s zone, and the day moves with it', async () => {
  const { readinessScheduleText } = (await boot(wallPayload([]))).exposed
  const now = Date.parse('2026-10-09T15:00:00Z')
  const clock = (every, hour, minute, extra = {}) => ({ text: 'a UTC fallback', clock: { every, hour, minute, weekday: null, day: null, ...extra } })
  const say = (schedule, zone) => {
    return readinessScheduleText(schedule, now, zone).replace(/\s/g, ' ')
  }
  // UTC readers see what the file says.
  assert.equal(say(clock('day', 6, 0), 'UTC'), 'Every day at 6:00 AM')
  assert.equal(say(clock('weekly', 6, 0, { weekday: 1 }), 'UTC'), 'Mondays at 6:00 AM')
  assert.equal(say(clock('weekdays', 7, 45), 'UTC'), 'Weekdays at 7:45 AM')
  assert.equal(say(clock('monthly', 8, 0, { day: 31 }), 'UTC'), 'Monthly on the 31st at 8:00 AM')
  // New York is four hours behind in October.
  assert.equal(say(clock('day', 6, 0), 'America/New_York'), 'Every day at 2:00 AM')
  assert.equal(say(clock('weekly', 6, 0, { weekday: 1 }), 'America/New_York'), 'Mondays at 2:00 AM')
  assert.equal(say(clock('weekdays', 14, 0), 'America/New_York'), 'Weekdays at 10:00 AM')
  // Past midnight the other way: the day before.
  assert.equal(say(clock('weekly', 2, 0, { weekday: 1 }), 'America/New_York'), 'Sundays at 10:00 PM')
  assert.equal(say(clock('weekdays', 2, 0), 'America/New_York'), 'Sun to Thu at 10:00 PM')
  assert.equal(say(clock('weekly', 1, 0, { weekday: 0 }), 'America/New_York'), 'Saturdays at 9:00 PM')
  // And ahead of UTC: the day after.
  assert.equal(say(clock('weekly', 20, 0, { weekday: 1 }), 'Asia/Tokyo'), 'Tuesdays at 5:00 AM')
  assert.equal(say(clock('weekdays', 20, 0), 'Asia/Tokyo'), 'Tue to Sat at 5:00 AM')
  assert.equal(say(clock('day', 20, 0), 'Asia/Tokyo'), 'Every day at 5:00 AM')
  assert.equal(say(clock('monthly', 20, 0, { day: 31 }), 'Asia/Tokyo'), 'Monthly on the 1st at 5:00 AM')
  assert.equal(say(clock('monthly', 1, 0, { day: 1 }), 'America/New_York'), 'Monthly on the 31st at 9:00 PM')
  // Ordinals, including the teens that are not "11st".
  for (const [day, word] of [[1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'], [11, '11th'], [12, '12th'], [13, '13th'], [21, '21st'], [22, '22nd'], [23, '23rd'], [30, '30th']]) {
    assert.equal(say(clock('monthly', 8, 0, { day }), 'UTC'), `Monthly on the ${word} at 8:00 AM`)
  }
  // A half-hour zone.
  assert.equal(say(clock('day', 6, 0), 'Asia/Kolkata'), 'Every day at 11:30 AM')
})

test('a schedule with no clock, or in a zone this browser does not know, is said as the server wrote it', async () => {
  const { readinessScheduleText } = (await boot(wallPayload([]))).exposed
  const now = Date.parse('2026-10-09T15:00:00Z')
  assert.equal(readinessScheduleText({ text: 'Every 2 hours', clock: null }, now, 'Asia/Tokyo'), 'Every 2 hours')
  assert.equal(readinessScheduleText({ text: 'Every day at 6:15am (Mac time)', clock: null }, now, 'Asia/Tokyo'), 'Every day at 6:15am (Mac time)')
  assert.equal(readinessScheduleText({ text: 'Every day at 6:00am UTC', clock: { every: 'day', hour: 6, minute: 0 } }, now, 'Mars/Olympus'), 'Every day at 6:00am UTC')
  assert.equal(readinessScheduleText({ text: 'Every day at 6:00am UTC', clock: { every: 'fortnightly', hour: 6, minute: 0 } }, now, 'UTC'), 'Every day at 6:00am UTC')
  assert.equal(readinessScheduleText(null, now, 'UTC'), 'Not known')
  assert.equal(readinessScheduleText('plain', now, 'UTC'), 'plain')
})

test('the Schedule row of a team-repo card is in the reader\'s zone, from the clock the server sent', async () => {
  const payload = wallPayload([workflow()])
  const page = await boot(payload, { after: "readinessClock.locale = 'en-US'; readinessClock.zone = 'Asia/Tokyo'" })
  const [card] = withClass(page.node('readiness'), 'rd-card')
  assert.equal(flat(withClass(card, 'rd-row')[0].children[1].textContent), 'Every day at 3:00 PM')
})

/* ---------- how it looks ----------------------------------------------------------------------- */

const rules = cssRules()
const declarationsOf = (rule) => Object.fromEntries(rule.body.split(';').map((line) => line.trim()).filter(Boolean).map((line) => [line.slice(0, line.indexOf(':')).trim(), line.slice(line.indexOf(':') + 1).trim()]))
const rulesFor = (selector, { gated = false } = {}) => rules.filter((rule) => rule.selector.split(',').map((one) => one.trim()).includes(selector) && Boolean(rule.inMedia) === gated)

test('on a phone the cards are one column, and a desktop gets a grid of about seven across', () => {
  const base = rulesFor('.rd-grid').map(declarationsOf)
  assert.ok(base.some((rule) => rule['grid-template-columns'] === 'minmax(0, 1fr)'), 'the unconditional rule is not one column')
  assert.ok(!base.some((rule) => /auto-fill|repeat\(/.test(rule['grid-template-columns'] ?? '')), 'a grid applies on a phone')
  const wide = rules.filter((rule) => rule.selector.includes('.rd-grid') && rule.inMedia)
  assert.equal(wide.length, 1)
  assert.match(wide[0].condition, /min-width:\s*64rem/, 'the grid starts at 1024px')
  assert.equal(declarationsOf(wide[0])['grid-template-columns'], 'repeat(auto-fill, minmax(10.5rem, 1fr))')
})

test('a NO GO card has a red outline from the colour token, and a faded one a dashed outline', () => {
  const noGo = rulesFor('.rd-card.rd-no-go').map(declarationsOf)[0]
  assert.equal(noGo['border-color'], 'var(--bad)')
  assert.match(noGo['box-shadow'], /var\(--bad\)/)
  assert.equal(rulesFor('.rd-card.rd-faded').map(declarationsOf)[0]['border-style'], 'dashed')
})

test('the three lights differ in shape, not only in colour: a filled dot, a hollow ring, a dot inside a ring', () => {
  const light = (selector) => declarationsOf(rules.find((rule) => rule.selector === selector))
  assert.equal(light('.rd-go .rd-light').background, 'var(--ok)')
  assert.equal(light('.rd-silent .rd-light').background, 'transparent')
  assert.match(light('.rd-silent .rd-light').border, /var\(--warn\)/)
  assert.equal(light('.rd-no-go .rd-light').background, 'var(--bad)')
  assert.match(light('.rd-no-go .rd-light')['box-shadow'], /0 0 0 \.3rem var\(--bad\)/)
})

test('the Refresh button is a real button and a thumb can hit it', async () => {
  const page = await boot(wallPayload())
  const [button] = withClass(page.node('readiness'), 'rd-refresh')
  assert.equal(button.tagName, 'BUTTON')
  assert.equal(button.attributes.type, 'button')
  assert.equal(button.textContent, 'Refresh')
  const heights = rulesFor('.rd-refresh').map(declarationsOf).map((rule) => Number(/^([\d.]+)rem$/.exec(rule['min-height'] ?? '')?.[1])).filter(Boolean)
  assert.ok(heights.some((rem) => rem >= 2.75), 'the Refresh button is shorter than 2.75rem')
})

test('every class the Readiness code writes has a rule, and none of the screen\'s rules sets a colour but from a token', () => {
  const block = script.slice(script.indexOf('/* ---------- Readiness: begin'), script.indexOf('/* ---------- Readiness: end ---------- */'))
  // Every rd- word the block writes, minus the one that is an id and the ones cut off before a ${light}
  // that is filled in when the card is made - those are listed by hand.
  const used = new Set([...block.matchAll(/rd-[a-z][a-z-]*/g)].map((match) => match[0]).filter((name) => !name.endsWith('-') && name !== 'rd-heading-off'))
  for (const name of ['rd-no-go', 'rd-silent', 'rd-go', 'rd-heading-no-go', 'rd-heading-silent', 'rd-heading-go']) used.add(name)
  assert.ok(used.size >= 20, 'the class names were not found')
  const sheet = sheetText()
  for (const name of used) assert.ok(sheet.includes(`.${name}`), `.${name} is used by the page and has no rule`)
  for (const rule of rules.filter((one) => /\.rd-/.test(one.selector))) {
    assert.doesNotMatch(rule.body, /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i, `${rule.selector} writes a colour`)
  }
})

test('nothing on the Readiness screen moves, unless motion is allowed', () => {
  for (const rule of rules.filter((one) => /\.rd-/.test(one.selector))) {
    if (/transition|animation/.test(rule.body)) assert.match(rule.condition ?? '', /prefers-reduced-motion:\s*no-preference/, `${rule.selector} moves with no motion query`)
  }
})

test('no card can push the page sideways: the cards may shrink and long words break', () => {
  const card = rulesFor('.rd-card').map(declarationsOf)[0]
  assert.equal(card['min-width'], '0')
  assert.equal(card['overflow-wrap'], 'anywhere')
  assert.equal(declarationsOf(rules.find((rule) => rule.selector === '.rd-counters'))['overflow-wrap'], 'anywhere')
})

/* ---------- the Refresh button ----------------------------------------------------------------- */

test('Refresh reads the board again, draws it, and keeps the reader where they were', async () => {
  const first = wallPayload([workflow()])
  const second = wallPayload([workflow(), workflow({ slug: 'new', name: 'New one', arm: 'declared' })])
  let calls = 0
  const page = loadPage({
    hash: '#readiness',
    after: CLOCK,
    scrollY: 321,
    fetch: async (url) => (String(url).startsWith('/api/state')
      ? { ok: true, status: 200, json: async () => (calls++ === 0 ? first : second) }
      : { ok: true, status: 200, json: async () => ({}) })
  })
  await flush()
  assert.equal(withClass(page.node('readiness'), 'rd-card').length, 1)
  const [button] = withClass(page.node('readiness'), 'rd-refresh')
  button.listeners.click[0]()
  await flush()
  assert.equal(withClass(page.node('readiness'), 'rd-card').length, 2)
  assert.equal(withClass(page.node('readiness'), 'rd-counters')[0].textContent, '1 NO GO · 0 SILENT · 1 GO')
  assert.equal(page.requests.filter((request) => request.url.startsWith('/api/state')).length, 2)
  // Drawing the board goes to the top; the refresh puts the reader back.
  assert.deepEqual(page.scrolls.at(-1), [0, 321])
})

test('a refresh that fails says so on the screen and leaves the lights as they were', async () => {
  let calls = 0
  const page = loadPage({
    hash: '#readiness',
    after: CLOCK,
    fetch: async (url) => (String(url).startsWith('/api/state')
      ? (calls++ === 0 ? { ok: true, status: 200, json: async () => wallPayload([workflow()]) } : { ok: false, status: 500, json: async () => ({ error: 'no' }) })
      : { ok: true, status: 200, json: async () => ({}) })
  })
  await flush()
  withClass(page.node('readiness'), 'rd-refresh')[0].listeners.click[0]()
  await flush()
  assert.match(withClass(page.node('readiness'), 'rd-stamp')[0].textContent, /COULD NOT CHECK$/)
  assert.equal(withClass(page.node('readiness'), 'rd-card').length, 1)
})

/* ---------- the sweeps every other screen gets, on the tree this one builds --------------------- */

// The same words render.test.mjs refuses on every screen: a board that assumes its reader owns a
// business or has customers. That test reads markup, and this screen has none.
const OWNER_ASSUMPTIONS = [
  /\byour business\b/i, /\byour company\b/i, /\byour revenue\b/i, /\byour staff\b/i,
  /\bclients?\b/i, /\bcustomers?\b/i, /\bprospects?\b/i, /\brevenue\b/i, /\bpayroll\b/i
]

test('the Readiness screen renders no undefined, NaN or [object Object], and assumes nothing about the reader\'s business', async () => {
  const takenAt = iso(NOW - 600_000)
  const hermes = { status: 'ok', computers: [{ computer: 'Mac Mini', takenAt, alive: 'down', install: { status: 'found' } }] }
  const payload = wallPayload([
    ...referenceWorkflows(),
    workflow({ slug: 'old', name: 'Old', arm: 'off', armed: false }),
    workflow({ slug: 'failed', name: 'Failed', schedule: 'hourly', lastRun: { started_at: iso(NOW - 600_000), status: 'failed', summary: 'Broke.', session_url: null } })
  ], { hermes, routines: { known: true, orphans: [{ id: 'trig', name: 'Orphan' }] } })
  for (const data of [payload, wallPayload([]), { ...basePayload() }]) {
    const page = await boot(data)
    const drawn = textOf(page.node('readiness'))
    assert.ok(drawn.length > 20)
    for (const junk of ['undefined', 'NaN', '[object Object]', 'Infinity', 'null']) assert.ok(!drawn.includes(junk), `the Readiness screen rendered "${junk}"`)
    for (const assumption of OWNER_ASSUMPTIONS) assert.ok(!assumption.test(drawn), `the Readiness screen assumes the reader owns the business: ${assumption}`)
  }
})

test('the stamp names the time of the Mac\'s newest reading, in the reader\'s clock, and the note repeats it', async () => {
  const payload = wallPayload()
  payload.readiness.macCheckedAt = iso(NOW - 1800_000)
  const page = await boot(payload)
  const clock = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' }).format(NOW - 1800_000)
  const [stamp] = withClass(page.node('readiness'), 'rd-stamp')
  assert.ok(flat(stamp.textContent).startsWith(`JOBS CHECKED ${clock} · BOARD READ `), stamp.textContent)
  assert.ok(flat(withClass(page.node('readiness'), 'rd-note')[0].textContent).includes(`as of the Mac's check at ${clock}.`))
})
