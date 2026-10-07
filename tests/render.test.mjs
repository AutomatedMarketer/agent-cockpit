import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { shapeHero } from '../api/state.js'
import { AGENT_PALETTE, agentColorIndex, PICTURE_BUDGET, DEFAULT_ART_STYLE } from '../api/lib.js'
import { cssRules } from './helpers/css-rules.mjs'

/* Every other test in this repo checks the API, or greps the page source for a string. None of
   them has ever RENDERED a screen. A verifier had to build its own DOM shim to find that the week
   strip still printed times for jobs nothing fires, and that an empty ledger produced a giant "0"
   &mdash; both invisible to a regex over the source, both obvious the moment a screen is drawn.
   So the harness lives here now. */

const html = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8')
const script = html.match(/<script>([\s\S]*)<\/script>/)[1]

// The smallest DOM the page needs. Elements record what was written to them, which is the whole
// point: the assertions below read the rendered HTML rather than the source that produced it.
function render(payload, options = {}) {
  const nodes = new Map()
  const node = (id) => {
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        innerHTML: '',
        textContent: '',
        className: '',
        dataset: {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        // Attributes and listeners are RECORDED, never acted on: a test can read what the page set
        // (aria-checked on the theme switch) and call a handler itself, and nothing fires on its own.
        attributes: {},
        setAttribute(name, value) { this.attributes[name] = String(value) },
        removeAttribute(name) { delete this.attributes[name] },
        // `options.select(id, selector)` hands back stand-in elements for one query, so a test can
        // reach a handler the page binds to elements it finds inside a screen. Unanswered, nothing.
        querySelectorAll: (selector) => options.select?.(id, selector) ?? [],
        // `options.find(id, selector)` is the same for a single query - the Add agent button and the
        // form it opens are found this way. Unanswered, null, which is what every test got before.
        querySelector: (selector) => options.find?.(id, selector) ?? null,
        listeners: {},
        addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler) },
        closest: () => null,
        appendChild() {},
        focus() {},
        // Recorded like the attributes above, so a test can ask whether a jump landed on this node.
        scrollIntoView(how) { this.scrolledIntoView = how ?? true },
        style: {}
      })
    }
    return nodes.get(id)
  }

  // The page's own document-wide listeners, RECORDED like an element's, with the options they were
  // added with: an image's error event does not bubble, so whether a listener is in the capture
  // phase is the difference between catching a broken portrait and never hearing of it.
  const documentListeners = []
  nodes.documentListeners = documentListeners
  const document = {
    getElementById: (id) => node(id),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener(type, handler, options) { documentListeners.push({ type, handler, options }) },
    // `options.create(tag)` hands back a stand-in for one kind of element - a canvas with a
    // recording context, for the picture pipeline. Unanswered, the scratch node, as before.
    createElement: (tag) => options.create?.(tag) ?? node('scratch'),
    body: node('body'),
    documentElement: node('html')
  }

  const hash = options.hash ?? ''
  // `options.media` answers matchMedia by query - { '(prefers-color-scheme: light)': true } is a
  // phone set to light mode. A query it does not name does not match, which is what every test got
  // before this option existed. `options.storage` stands in for localStorage, including one whose
  // every method throws - what a private window or blocked site data hands the page.
  const media = options.media ?? {}
  // Every address the page makes from a blob, and every one it lets go of, RECORDED. A picture
  // from the store reaches a src only through createObjectURL, so this list is the whole set of
  // store pictures the page can show - and the revoked list is how a test sees one being freed.
  const objectUrls = { created: [], revoked: [] }
  nodes.objectUrls = objectUrls
  class RecordingURL extends URL {
    static createObjectURL(blob) {
      const url = `blob:cockpit/${objectUrls.created.length + 1}`
      objectUrls.created.push({ url, blob })
      return url
    }
    static revokeObjectURL(url) { objectUrls.revoked.push(url) }
  }
  // `options.history` and `options.fetch` stand in for the browser's own, so a test can read what
  // a control pushed onto the history and every request the page made. Left out, history is
  // absent - as it was before these existed - and fetch answers with the payload. The one
  // exception is a test that sets `state.brand`: the page's own boot asks /api/brand too, and is
  // told the same brand the test set, so the boot that finishes after the test's render agrees
  // with it instead of quietly switching personalising off again.
  const givenBrand = options.state?.brand
  const answer = async (url) => ({
    ok: true, status: 200,
    json: async () => (givenBrand !== undefined && String(url).startsWith('/api/brand') ? givenBrand : payload)
  })
  const context = {
    document,
    // `options.prompt` answers window.prompt - the edit key a person types when the store asks for
    // one. Left out, there is no prompt, as before.
    window: { addEventListener() {}, matchMedia: (query) => ({ matches: Boolean(media[query]), addEventListener() {} }), location: { hash }, scrollTo() {}, requestAnimationFrame: (fn) => fn(), history: options.history, prompt: options.prompt },
    location: { hash, search: '' },
    localStorage: options.storage ?? { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: options.fetch ?? answer,
    console,
    setTimeout,
    clearTimeout,
    // `options.Date` pins the clock, for the one test that compares whole screens byte for byte.
    Date: options.Date ?? Date,
    Math,
    JSON,
    Intl,
    URL: RecordingURL,
    // Neither exists in node. A test of the picture pipeline hands in its own; left out, the page
    // sees what node would show it - nothing.
    createImageBitmap: options.createImageBitmap,
    Image: options.Image
  }

  // The page defines everything as top-level declarations, so evaluating it and then calling
  // render() gives the real functions operating on the real payload shape.
  //
  // `options.state` sets the page's own screen state before drawing. Some of what a person does is
  // not in the payload at all - which folder button they pressed, what they typed in the search box
  // - and it lives in top-level variables the page's own listeners set. The shim's addEventListener
  // is a no-op, so simulated typing does nothing, and a test written around that fact asserted on
  // the SOURCE instead and missed a false sentence that only appears when a folder and a query are
  // both set. Review found it. These are the same variables the page assigns; nothing is faked.
  const state = options.state ?? {}
  // `options.expose` names page functions to hand back as `nodes.exposed`, so a pure one - which
  // greeting an hour gets - can be called with inputs the clock would take a day to produce. Only
  // plain identifiers: the names are written into the evaluated source.
  const exposeNames = options.expose ?? []
  for (const name of exposeNames) assert.match(name, /^[A-Za-z_$][\w$]*$/, `${name} is not a function name`)
  const run = new Function(
    ...Object.keys(context),
    `${script}
     ; data = arguments[arguments.length - 2]
     ; const given = arguments[arguments.length - 1]
     ; if (given.memoryQuery !== undefined) memoryQuery = given.memoryQuery
     ; if (given.memorySource !== undefined) memorySource = given.memorySource
     ; if (given.brand !== undefined) brand = parseBrand(given.brand)
     ; if (given.art) for (const [slot, entry] of Object.entries(given.art)) artUrls.set(slot, entry)
     ; if (given.brandPanelOpen !== undefined) brandPanelOpen = given.brandPanelOpen
     ; render(); return { ${exposeNames.join(', ')} };`
  )
  nodes.exposed = run(...Object.values(context), payload, state)
  return nodes
}

const base = {
  repo: { owner: 'o', repo: 'r', branch: 'main', url: 'https://github.com/o/r' },
  agents: [],
  runs: [],
  totalRuns: 0,
  unparseableRuns: [],
  overnight: [],
  goneQuiet: [],
  board: { todo: [], upNext: [], running: [], done: [] },
  brain: [],
  workflows: [],
  runtimes: [],
  skills: [],
  stack: null,
  memory: { files: [], indexes: [], truncated: false },
  ledger: null,
  proposals: null,
  hero: null,
  // What api/state.js sends for a repo with no name in about-me and no runs: no owner, and a
  // fortnight of activity that is complete because there was nothing to cap.
  owner: null,
  activity: { since: new Date(Date.now() - 15 * 86400_000).toISOString(), runs: [], complete: true },
  // Word for word what shapeSnapshot returns for an absent snapshot. It read 'no snapshot has been
  // taken yet' here long after the API stopped saying that, so these tests were drawing a screen
  // no student could ever see.
  routines: { takenAt: null, usable: false, stale: false, why: 'No snapshot has been taken yet.', count: 0, known: false, orphans: [], problems: [] },
  setup: [],
  generatedAt: new Date().toISOString()
}

const workflow = (over = {}) => ({
  slug: 'brief',
  path: 'workflows/brief.yml',
  name: 'Brief',
  owner: 'research',
  steps: ['scan'],
  runner: 'routine',
  schedule: 'daily 06:30',
  armed: false,
  arm: 'off',
  reason: null,
  routineId: null,
  fire: false,
  webhook: false,
  output: 'inbox/x.md',
  problems: [],
  lastRun: null,
  nextRun: null,
  state: 'never-run',
  ...over
})

const SCREENS = ['today', 'ledger', 'team', 'workflows', 'skills', 'memory', 'connections']

/* ---------- every screen draws ---------------------------------------------------------------- */

test('all seven screens render from an empty repo without throwing', () => {
  const nodes = render(base)
  for (const screen of SCREENS) {
    const drawn = nodes.get(screen)
    assert.ok(drawn, `${screen} was never rendered`)
    assert.ok(drawn.innerHTML.length > 0, `${screen} rendered nothing at all`)
  }
})

test('no screen renders undefined, NaN or [object Object]', () => {
  const nodes = render({
    ...base,
    workflows: [workflow({ arm: 'declared', armed: true })],
    ledger: { ownerType: 'business', hourlyValue: 150, hoursPerWeek: 3, costPerWeek: 450, unpriced: false, unreadable: 0, complete: true, tasks: [{ task: 'A', words: 'w', confirmed: 'twice', hoursPerWeek: 3 }] },
    proposals: { proposals: [{ task: 'A', item: 'agent:x', why: 'because', words: 'w', number: '3 hours a week' }], gaps: [{ task: 'B', question: 'why not?' }] },
    hero: { metric: 'hours-a-week', defined: true, value: 3, unit: 'hours a week', caption: 'c' }
  })
  for (const screen of SCREENS) {
    const drawn = nodes.get(screen).innerHTML
    for (const junk of ['undefined', 'NaN', '[object Object]', 'Infinity']) {
      assert.ok(!drawn.includes(junk), `${screen} rendered "${junk}"`)
    }
  }
})

/* ---------- the claim the last pass half-kept -------------------------------------------------- */

/* The week strip filtered on `workflow.schedule` alone, so a declared job appeared on every day,
   indistinguishable from a real one &mdash; and on Today it collected a "was due, no run logged" mark
   four times a week. That is an accusation, and it needs an alarm clock to exist first. */

test('a job nothing fires never appears in the week strip', () => {
  const declared = render({ ...base, workflows: [workflow({ arm: 'declared', armed: true, name: 'Wishful' })] })

  // Today is the strip with no cards on it, so any time here came from the calendar.
  const today = declared.get('today').innerHTML
  assert.ok(!today.includes('06:30'), 'Today placed a job nothing fires on the calendar')
  assert.ok(!today.includes('missed'), 'Today accused a job nothing fires of missing a run')

  // The Workflows CARD may show the time - it is the file's own text, and the card says in the
  // same breath that nothing fires it. Since the seven-day list replaced the grid here, the job
  // is also named in the list's own "In a file, not ringing" section, deliberately. What none of
  // them may do is put it among the seven days as though it were going to happen.
  const workflows = declared.get('workflows').innerHTML
  assert.match(workflows, /Nothing fires this/, 'the card must say the schedule is a wish')
  assert.ok(!workflows.includes('missed'), 'a job nothing fires cannot have missed a run')
  const list = workflows.slice(workflows.indexOf('<h2>Next 7 days'), workflows.indexOf('<div class="stack">'))
  const silentAt = list.indexOf('In a file, not ringing')
  assert.ok(silentAt > 0, 'the section that names jobs nothing fires is gone')
  assert.ok(!list.slice(0, silentAt).includes('06:30'), 'the seven days placed a job nothing fires on the calendar')
  assert.ok(list.slice(silentAt).includes('06:30'), 'the job nothing fires lost the time its own file names')
})

test('an armed job does still appear in the week strip', () => {
  const armed = render({
    ...base,
    workflows: [workflow({ arm: 'armed', armed: true, routineId: 't1', nextRun: new Date(Date.now() + 3600_000).toISOString() })]
  })
  assert.ok(armed.get('workflows').innerHTML.includes('06:30'), 'a real job lost its time')
})

/* ---------- Start and Done on a task card -----------------------------------------------------

   Buttons rather than dragging, because on a phone this board is ONE column: the four stack, and
   only sit side by side at 1024px and up. There is nothing to drag between on the device the
   course tells students to bookmark on day one. */

const boardWith = (over) => ({
  todo: [], upNext: [], running: [], done: [], finishedTasks: [], ...over
})

test('an open task card carries Start and Done, and a card already doing carries only Done', () => {
  const drawn = render({
    ...base,
    board: boardWith({
      todo: [
        { slug: 'a-card', title: 'Chase Acme', for: 'sales', doing: false },
        { slug: 'b-card', title: 'Write the brief', for: 'research', doing: true }
      ]
    })
  }).get('today').innerHTML

  assert.match(drawn, /data-move="a-card"[^>]*data-status="doing"/, 'a todo card has no Start button')
  assert.match(drawn, /data-move="a-card"[^>]*data-status="done"/, 'a todo card has no Done button')
  assert.match(drawn, /data-move="b-card"[^>]*data-status="done"/, 'a doing card has no Done button')
  assert.ok(
    !/data-move="b-card"[^>]*data-status="doing"/.test(drawn),
    'a card already being worked on was offered Start again'
  )
})

test('a task card names itself, so the button knows which file to ask about', () => {
  const drawn = render({
    ...base,
    board: boardWith({ todo: [{ slug: '2026-08-18-call-supplier', title: 'Call the supplier', for: null, doing: false }] })
  }).get('today').innerHTML
  assert.match(drawn, /data-card="2026-08-18-call-supplier"/)
})

test('a task title and slug are repo text, so both are escaped on the card', () => {
  const drawn = render({
    ...base,
    board: boardWith({ todo: [{ slug: 'a-card', title: '<img src=x onerror=1>', for: null, doing: false }] })
  }).get('today').innerHTML
  assert.ok(!drawn.includes('<img src=x'), 'a task title from the repo was rendered as markup')
  assert.match(drawn, /&lt;img src=x/)
})

/* A finished TASK and a finished RUN share the Done column on two clocks - seven days and
   fourteen. They are drawn differently on purpose: a task has no session to watch and no agent
   status, and dressing it as a run would claim something ran that a person just ticked off. */

test('a finished task in Done is marked as one, and never given a watch link', () => {
  const drawn = render({
    ...base,
    board: boardWith({
      done: [
        { kind: 'task', slug: 'a-card', title: 'Chase Acme', for: 'sales', doneAt: '2026-09-01' },
        { kind: 'run', name: 'monday-brief', agent: 'research', status: 'ok', summary: 'Brief written.', started_at: new Date().toISOString(), session_url: 'https://claude.ai/code/s1' }
      ]
    })
  }).get('today').innerHTML

  assert.match(drawn, /You marked this done/, 'a finished task is indistinguishable from a run')
  assert.match(drawn, /Chase Acme/)
  // The run keeps its watch link; the task must not have been given one.
  const taskCard = drawn.slice(drawn.indexOf('Chase Acme'), drawn.indexOf('monday-brief'))
  assert.ok(!taskCard.includes('watch'), 'a finished task was given a session to watch')
})

test('finished tasks that are not on the board are offered behind a link, counted', () => {
  const drawn = render({
    ...base,
    board: boardWith({
      done: [{ kind: 'task', slug: 'shown', title: 'Shown', for: null, doneAt: '2026-09-01' }],
      finishedTasks: [
        { kind: 'task', slug: 'shown', title: 'Shown', for: null, doneAt: '2026-09-01' },
        { kind: 'task', slug: 'old', title: 'Old one', for: null, doneAt: '2026-01-04' },
        { kind: 'task', slug: 'undated', title: 'Undated one', for: null, doneAt: null }
      ]
    })
  }).get('today').innerHTML

  assert.match(drawn, /See 2 finished tasks not shown here/, 'the hidden finished tasks are not offered')
  assert.match(drawn, /Old one/)
  assert.match(drawn, /Undated one/)
  assert.match(drawn, /no date recorded/, 'an undated card was given a date it never had')
})

test('with nothing hidden there is no link at all', () => {
  const drawn = render({
    ...base,
    board: boardWith({
      done: [{ kind: 'task', slug: 'shown', title: 'Shown', for: null, doneAt: '2026-09-01' }],
      finishedTasks: [{ kind: 'task', slug: 'shown', title: 'Shown', for: null, doneAt: '2026-09-01' }]
    })
  }).get('today').innerHTML
  assert.ok(!drawn.includes('finished task'), 'a link was offered to nothing')
})

/* ---------- Next 7 days, on the Workflows screen ----------------------------------------------

   The week grid answers "which weekday does this land on". It could not answer the question a
   student actually asks - what is coming, in order, starting today - and it hid two kinds of job
   to do it: anything nothing fires (counted in a note, never shown) and anything monthly or
   hourly (dropped to a footnote with no day at all). The list answers the asked question and
   shows every job that names a time, with the ones that do not ring in their own labelled
   section rather than absent. Today keeps the grid: it answers a different question, with marks
   for what ran, and those marks need a fixed week to sit on. */

const DAY_LABEL = (date) =>
  `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()]} ${date.getDate()}`

const sevenDays = () =>
  Array.from({ length: 7 }, (unused, index) => {
    const date = new Date()
    date.setHours(0, 0, 0, 0)
    date.setDate(date.getDate() + index)
    return date
  })

/* Two of these tests passed against the unbuilt list, because a daily job also appears on all
   seven columns of the OLD grid and the grid escapes names too. A test that passes before the
   feature exists is measuring nothing. So every assertion below reads the list's own container,
   which only the list produces - and this helper fails loudly rather than returning the whole
   screen if that container is ever renamed. */
function sevenDayList(nodes) {
  const drawn = nodes.get('workflows').innerHTML
  const opened = drawn.indexOf('<div class="days7">')
  assert.ok(opened >= 0, 'the seven-day list did not render at all')
  const ended = drawn.indexOf('<div class="stack">', opened)
  return drawn.slice(opened, ended >= 0 ? ended : undefined)
}

/* One day's block, sliced between its own heading and the next day's.

   The first version of the weekday test asserted "the job appears somewhere after Wednesday's
   heading", which is not a claim about placement at all: the window starts today, today was a
   Wednesday, so Wednesday's heading was at position zero and every possible misplacement sat
   after it. Deleting the Monday-first conversion - which moves every weekly job to the wrong day
   - left the suite green. Containment in a single block is the claim that was meant, and it holds
   whichever day of the week the tests are run on. */
function dayBlock(list, index) {
  const starts = sevenDays().map((date) => {
    const at = list.indexOf(DAY_LABEL(date))
    assert.ok(at >= 0, `the list is missing ${DAY_LABEL(date)}`)
    return at
  })
  const ends = [...starts.slice(1), list.length]
  return list.slice(starts[index], ends[index])
}

test('the Workflows screen lists the next seven days, starting today, and Today keeps its grid', () => {
  const nodes = render({
    ...base,
    workflows: [workflow({ arm: 'armed', armed: true, schedule: 'daily 06:30' })]
  })
  const workflows = nodes.get('workflows').innerHTML

  assert.match(workflows, /Next 7 days/, 'the Workflows screen lost the seven-day list')
  assert.ok(!workflows.includes('schedule-scroll'), 'the week grid is still on the Workflows screen as well as the list')

  // Every one of the seven days, in order, starting with today.
  const days = sevenDays().map(DAY_LABEL)
  let cursor = -1
  for (const label of days) {
    const at = workflows.indexOf(label, cursor + 1)
    assert.ok(at > cursor, `the seven-day list is missing ${label}, or has it out of order`)
    cursor = at
  }

  // Today's grid is untouched - it carries the ran / was-due marks, which need a fixed week.
  assert.ok(nodes.get('today').innerHTML.includes('schedule-scroll'), 'Today lost its week grid')
})

test('a daily job appears on all seven days and a weekly job on exactly one', () => {
  const nodes = render({
    ...base,
    workflows: [
      workflow({ slug: 'daily-one', name: 'Daily One', arm: 'armed', armed: true, schedule: 'daily 06:30' }),
      workflow({ slug: 'weekly-one', name: 'Weekly One', arm: 'armed', armed: true, schedule: 'weekly wed 09:00' })
    ]
  })
  const list = sevenDayList(nodes)

  assert.equal((list.match(/Daily One/g) ?? []).length, 7, 'a daily job did not land on all seven days')
  assert.equal((list.match(/Weekly One/g) ?? []).length, 1, 'a weekly job did not land on exactly one day')

  // In WEDNESDAY's block, and in none of the other six. Asserting only that it appears somewhere
  // after Wednesday's heading is not a claim about placement: run on a Wednesday, that heading is
  // first and every wrong day satisfies it.
  const wednesdayIndex = sevenDays().findIndex((date) => date.getDay() === 3)
  for (let index = 0; index < 7; index += 1) {
    const block = dayBlock(list, index)
    assert.equal(
      block.includes('Weekly One'),
      index === wednesdayIndex,
      `a weekly Wednesday job is ${index === wednesdayIndex ? 'missing from' : 'wrongly in'} the ${DAY_LABEL(sevenDays()[index])} block`
    )
    assert.ok(block.includes('Daily One'), `the daily job is missing from the ${DAY_LABEL(sevenDays()[index])} block`)
  }
})

test('an hourly job is one row a day, not twenty-four', () => {
  const nodes = render({
    ...base,
    workflows: [workflow({ slug: 'sweep', name: 'Sweep', arm: 'armed', armed: true, schedule: 'hourly' })]
  })
  const list = sevenDayList(nodes)

  assert.equal((list.match(/Sweep/g) ?? []).length, 7, 'an hourly job did not collapse to one row a day')
  assert.match(list, /every hour/, 'an hourly job lost the words that say how often it runs')
})

/* Monthly jobs had no weekday, so the grid could only put them in a footnote with no day at all.
   A list keyed on real dates can place them, and does. */
test('a monthly job lands on its real date when that date is inside the week', () => {
  const target = sevenDays()[3]
  const nodes = render({
    ...base,
    workflows: [
      workflow({ slug: 'invoices', name: 'Invoices', arm: 'armed', armed: true, schedule: `monthly ${target.getDate()} 09:00` })
    ]
  })
  const list = sevenDayList(nodes)

  for (let index = 0; index < 7; index += 1) {
    assert.equal(
      dayBlock(list, index).includes('Invoices'),
      index === 3,
      `the monthly job is ${index === 3 ? 'missing from' : 'wrongly in'} the ${DAY_LABEL(sevenDays()[index])} block`
    )
  }
})

test('a job nothing fires is listed in its own section with its reason, never among the seven days', () => {
  const nodes = render({
    ...base,
    workflows: [
      workflow({ slug: 'rings', name: 'Rings', arm: 'armed', armed: true, schedule: 'daily 06:30' }),
      workflow({
        slug: 'wishful',
        name: 'Wishful',
        arm: 'declared',
        armed: true,
        schedule: 'daily 07:00',
        reason: 'Off until the pipeline has people in it'
      })
    ]
  })
  const drawn = nodes.get('workflows').innerHTML
  const list = drawn.slice(drawn.indexOf('<div class="days7">'), drawn.indexOf('<div class="stack">'))
  const silentAt = list.indexOf('In a file, not ringing')

  assert.ok(silentAt > 0, 'the section naming the jobs nothing fires is gone')
  assert.ok(list.indexOf('Wishful') > silentAt, 'a job nothing fires was placed among the seven days')
  assert.match(list, /Off until the pipeline has people in it/, 'the file\'s own reason was dropped')
  // The seven days themselves stay honest: the only time above that section is the real one.
  assert.ok(!list.slice(0, silentAt).includes('07:00'), 'a job nothing fires put its time on the calendar')
  assert.ok(list.slice(0, silentAt).includes('06:30'), 'the job that does ring lost its time')
})

test('a day with nothing on it says so rather than rendering as a gap', () => {
  const wednesdayIndex = sevenDays().findIndex((date) => date.getDay() === 3)
  const nodes = render({
    ...base,
    workflows: [workflow({ slug: 'weekly-one', name: 'Weekly One', arm: 'armed', armed: true, schedule: 'weekly wed 09:00' })]
  })
  const list = sevenDayList(nodes)

  assert.equal((list.match(/Nothing scheduled/g) ?? []).length, 6, 'the six empty days did not each say they were empty')
  assert.ok(wednesdayIndex >= 0)
})

test('a job that rings without approval is marked on the list, because it is spending runs', () => {
  const nodes = render({
    ...base,
    workflows: [workflow({ slug: 'rogue', name: 'Rogue', arm: 'unapproved', armed: false, schedule: 'daily 06:30' })]
  })
  const list = sevenDayList(nodes)

  assert.match(list, /Rogue/, 'a job that really fires was left off the list because its file says off')
  assert.match(list, /class="[^"]*\bbad\b[^"]*"[^>]*>[^<]*(?:06:30|Rogue)|not approved/i,
    'nothing on the list marks a job that is firing without approval')
})

test('a name, an owner and a reason are text from a file, so all three are escaped', () => {
  const nodes = render({
    ...base,
    workflows: [
      workflow({ slug: 'rings', name: '<b>Loud</b>', owner: '<i>who</i>', arm: 'armed', armed: true, schedule: 'daily 06:30' }),
      workflow({ slug: 'quiet', name: 'Quiet', arm: 'declared', schedule: 'daily 07:00', reason: '<script>alert(1)</script>' })
    ]
  })
  const drawn = nodes.get('workflows').innerHTML
  const list = drawn.slice(drawn.indexOf('<div class="days7">'), drawn.indexOf('<div class="stack">'))

  assert.ok(!list.includes('<b>Loud</b>'), 'a job name from the repo was rendered as markup')
  assert.ok(!list.includes('<i>who</i>'), 'an owner from the repo was rendered as markup')
  assert.ok(!list.includes('<script>'), 'a reason from the repo was rendered as markup')
  assert.match(list, /&lt;b&gt;Loud&lt;\/b&gt;/, 'the job name was dropped rather than escaped')
})

test('with nothing ringing at all the list says so once, and still names what is waiting', () => {
  const nodes = render({
    ...base,
    workflows: [workflow({ slug: 'quiet', name: 'Quiet', arm: 'declared', schedule: 'daily 07:00', reason: 'Off until I have a run cap' })]
  })
  const list = nodes.get('workflows').innerHTML.split('<div class="stack">')[0]

  assert.ok(!list.includes('<div class="days7">'), 'seven day blocks were drawn when nothing rings at all')
  assert.ok(!list.includes('Nothing scheduled'), 'seven empty days were drawn when nothing rings at all')
  assert.match(list, /Nothing that rings is scheduled/, 'the list did not say that nothing rings')
  assert.match(list, /In a file, not ringing/, 'the jobs that are waiting were not named')
  assert.match(list, /Off until I have a run cap/, 'the waiting job lost its reason')
})

/* Day one: no snapshot has been taken, so the banner at the top of this screen says in as many
   words that whether these jobs ring is UNKNOWN. The list's own section sat three lines under
   that banner claiming "nothing fires them" - an assertion about routines the board had just
   said it could not make. Found by looking at the shipped state as a picture, not by a test.

   The section describes what it actually read: a time in a file. Whether anything fires it is the
   banner's question and the card's, and neither of them is this section. */
test('the list never claims nothing fires a job while the board says routines are unknown', () => {
  const nodes = render({
    ...base,
    routines: { usable: false, stale: false, why: 'No snapshot has been taken yet.', count: 0, takenAt: null },
    workflows: [
      workflow({ slug: 'a', name: 'A', schedule: 'daily 06:30', arm: 'off', reason: 'Off until there is an inbox.' }),
      workflow({ slug: 'b', name: 'B', schedule: 'daily 07:00', arm: 'unknown', armed: true })
    ]
  })
  const drawn = nodes.get('workflows').innerHTML
  const list = drawn.slice(drawn.indexOf('<h2>Next 7 days'), drawn.indexOf('<div class="stack">'))

  assert.match(list, /In a file, not ringing/, 'the waiting jobs were dropped')
  assert.ok(
    !/nothing fires (them|it)/.test(list),
    'the list asserted that nothing fires these jobs, on a screen that has just said it cannot know'
  )
  assert.match(list, /a wish until a routine fires it/, 'the list no longer says what a time in a file is worth')
})

/* Second home of the same defect. Today's week strip printed "and nothing fires them" - a claim
   about routines - three lines under its own banner saying which of these ring is UNKNOWN. With
   no snapshot every scheduled job falls into that count, not because nothing fires them but
   because nothing is known to. The Workflows list was fixed first; leaving this one would have
   left the two screens contradicting each other. */
test('Today does not claim nothing fires a job while its own banner says routines are unknown', () => {
  const unknown = {
    ...base,
    routines: { usable: false, stale: false, why: 'No snapshot has been taken yet.', count: 0, takenAt: null },
    workflows: [workflow({ slug: 'a', name: 'A', schedule: 'daily 06:30', arm: 'off' })]
  }
  const drawn = render(unknown).get('today').innerHTML
  assert.ok(!/nothing fires (them|it)/.test(drawn), 'Today asserted that nothing fires a job it cannot know about')
  assert.match(drawn, /whether anything fires it is unknown/, 'Today stopped accounting for the job entirely')

  // And with a usable snapshot the original, stronger sentence is still the one printed - the
  // claim is only softened where it cannot be made.
  const known = render({
    ...base,
    routines: { usable: true, stale: false, count: 1, takenAt: new Date().toISOString() },
    workflows: [
      workflow({ slug: 'rings', name: 'Rings', schedule: 'daily 06:30', arm: 'armed', armed: true }),
      workflow({ slug: 'a', name: 'A', schedule: 'daily 07:00', arm: 'declared', armed: true })
    ]
  }).get('today').innerHTML
  assert.match(known, /1 other job names a time in its file and nothing fires it/)
})

/* Tapping a row threw the reader off the Workflows screen and onto Today.

   The row is an anchor to its own job's card, and the card's id is real - the anchor resolved,
   and reading the markup said it worked. But this screen routes on the hash, and showScreen sends
   any hash it does not recognise to 'today', so following href="#job-morning-intel" navigated
   away from the screen the reader was on. Only clicking it in a browser showed that.

   The harness here cannot dispatch a click, so what it pins is the wiring the fix depends on:
   the row carries data-job, the card carries the matching id, and the handler that cancels the
   navigation is bound to that attribute. */
test('a row in the list is wired to scroll, not to navigate by hash', () => {
  const nodes = render({
    ...base,
    routines: { ...base.routines, usable: true, stale: false, known: true, count: 1, takenAt: new Date().toISOString() },
    workflows: [workflow({ slug: 'morning-intel', name: 'Morning Intel', schedule: 'daily 06:30', arm: 'armed', armed: true })]
  })
  const drawn = nodes.get('workflows').innerHTML

  assert.match(drawn, /data-job="morning-intel"/, 'the row lost the hook the click handler binds to')
  assert.match(drawn, /id="job-morning-intel"/, 'the card lost the id the row points at')

  // The handler, and its preventDefault, in the page source. Without the cancel, the browser
  // follows the href and the router sends the reader to Today.
  const source = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  const wiring = source.slice(source.indexOf("querySelectorAll('[data-job]')"))
  assert.ok(wiring.length, 'nothing binds a click handler to the seven-day rows any more')
  assert.match(wiring.slice(0, 400), /event\.preventDefault\(\)/, 'the row click no longer cancels hash navigation')
  assert.match(wiring.slice(0, 400), /scrollIntoView/, 'the row click no longer scrolls to the card')
})

test('a row in the list glides to its card only for someone who has not asked for less motion', () => {
  // A smooth scroll is a movement across the whole screen, and it ignored the phone's own setting:
  // every other movement on the board stops under reduced motion and this one did not.
  const payload = {
    ...base,
    routines: { ...base.routines, usable: true, stale: false, known: true, count: 1, takenAt: new Date().toISOString() },
    workflows: [workflow({ slug: 'morning-intel', name: 'Morning Intel', schedule: 'daily 06:30', arm: 'armed', armed: true })]
  }
  const tap = (media) => {
    const row = { dataset: { job: 'morning-intel' }, listeners: {}, addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler) } }
    const nodes = render(payload, { hash: '#workflows', media, select: (id, selector) => (id === 'workflows' && selector === '[data-job]' ? [row] : []) })
    const handlers = row.listeners.click ?? []
    assert.ok(handlers.length, 'nothing listens for a tap on the row')
    let cancelled = false
    handlers.at(-1)({ preventDefault() { cancelled = true } })
    assert.ok(cancelled, 'the tap followed the href, and the router sends an unknown hash to Today')
    const how = nodes.get('job-morning-intel').scrolledIntoView
    assert.ok(how, 'the tap did not scroll to the card')
    return how
  }
  assert.equal(tap({}).behavior, 'smooth', 'the glide is gone for everyone, not only for those who asked')
  assert.notEqual(tap({ '(prefers-reduced-motion: reduce)': true }).behavior, 'smooth',
    'the jump glides across the screen for someone whose phone asks for less motion')
})

test('jobs that do not ring are counted rather than silently dropped', () => {
  const drawn = render({ ...base, workflows: [workflow({ arm: 'declared', armed: true })] }).get('workflows').innerHTML
  assert.match(drawn, /nothing fires them|Nothing that rings is scheduled/)
})

/* ---------- the hero is never a number it cannot source ---------------------------------------- */

test('an undefined hero renders a sentence, never a zero', () => {
  const drawn = render({ ...base, hero: { metric: 'hours-saved', defined: false, why: 'nothing computes it yet' } }).get('today').innerHTML
  assert.match(drawn, /No hero number yet/)
  assert.ok(!/class="hero-value">\s*0\s*</.test(drawn), 'a zero was rendered in the hero')
})

/* ---------- the snapshot's age is on every screen that shows a schedule ------------------------- */

test('Today says when the routine evidence was last checked', () => {
  const unknown = render(base).get('today').innerHTML
  assert.match(unknown, /ring is unknown/, 'Today showed no snapshot banner at all')

  const stale = render({
    ...base,
    routines: { ...base.routines, takenAt: new Date(Date.now() - 30 * 86400_000).toISOString(), usable: true, stale: true, why: 'the snapshot was taken 4 weeks ago', count: 1 }
  }).get('today').innerHTML
  assert.match(stale, /4 weeks ago|last checked/)
})

/* ---------- escaping ---------------------------------------------------------------------------
   escapeHtml had zero coverage: mutating it to stop escaping left all 232 tests green. Everything
   on these screens comes out of somebody's repo. */

test('hostile text from the repo is escaped everywhere it lands', () => {
  const nasty = '<script>alert(1)</script>"\'&'
  const nodes = render({
    ...base,
    ledger: {
      ownerType: 'business', hourlyValue: 150, hoursPerWeek: 3, costPerWeek: 450,
      unpriced: false, unreadable: 0, complete: true,
      tasks: [{ task: nasty, words: nasty, confirmed: 'twice', parked: true, parkedBecause: nasty, hoursPerWeek: 3 }]
    },
    proposals: {
      proposals: [{ task: nasty, item: nasty, why: nasty, words: nasty, number: nasty }],
      gaps: [{ task: nasty, question: nasty }]
    },
    workflows: [workflow({ name: nasty, reason: nasty, arm: 'off' })],
    routines: { ...base.routines, usable: true, stale: false, takenAt: new Date().toISOString(), count: 1, known: true, orphans: [{ id: 'x', name: nasty }], problems: [nasty] }
  })

  for (const screen of SCREENS) {
    const drawn = nodes.get(screen).innerHTML
    assert.ok(!drawn.includes('<script>'), `${screen} rendered a raw <script> tag from repo text`)
  }
})

/* ---------- the orphan panel and the schedule problems -----------------------------------------
   Both were only ever "proved" by grepping the page source, which passes with the render
   short-circuited, and neither was ever drawn. */

test('orphan routines are drawn, with the not-adopted wording', () => {
  const drawn = render({
    ...base,
    routines: { ...base.routines, usable: true, stale: false, takenAt: new Date().toISOString(), count: 1, known: true, orphans: [{ id: 't', name: 'Something Armed' }], problems: [] }
  }).get('workflows').innerHTML
  assert.match(drawn, /Something Armed/)
  assert.match(drawn, /Reported, not adopted/)
})

test('duplicate-name problems reach the screen, not just the payload', () => {
  const drawn = render({
    ...base,
    routines: { ...base.routines, usable: true, stale: false, takenAt: new Date().toISOString(), count: 2, known: true, orphans: [], problems: ['2 routines share the name "brief" - they will all fire, and the spend is multiplied'] }
  }).get('workflows').innerHTML
  assert.match(drawn, /the spend is multiplied/, 'the one sentence explaining why a job costs twice')
})

/* ---------- the ledger week line, guarded at last ---------------------------------------------
   The hero was guarded and this line was not, so the zero moved one panel down the page. */

test('a ledger with no hours shows a sentence on the Ledger screen, not a zero', () => {
  const drawn = render({
    ...base,
    ledger: { ownerType: 'business', hourlyValue: 150, hoursPerWeek: 0, costPerWeek: 0, unpriced: false, unreadable: 0, complete: false, tasks: [] }
  }).get('ledger').innerHTML

  // Was `!includes('$0')`, which stopped meaning anything once money lost its dollar sign: the
  // cost line is now "<b>0</b> a week" or "<b>0 USD</b> a week", so guard the markup, not a symbol.
  assert.ok(!/<b>0(?: \S+)?<\/b> a week/.test(drawn), 'the Ledger screen printed "0 a week at the rate you set"')
  assert.ok(!drawn.includes('$0'), 'the Ledger screen printed "$0 a week at the rate you set"')
  assert.match(drawn, /no hours in it yet/)
  assert.match(drawn, /would say your\s+repeating work costs you nothing/)
})

test('an unreadable row is named on the Ledger screen, not silently dropped', () => {
  const drawn = render({
    ...base,
    ledger: { ownerType: 'business', hourlyValue: 150, hoursPerWeek: 3, costPerWeek: 450, unpriced: false, unreadable: 1, complete: false, tasks: [{ task: 'A', words: 'w', confirmed: 'twice', hoursPerWeek: 3 }] }
  }).get('ledger').innerHTML
  assert.match(drawn, /could not be read as hours/)
  assert.match(drawn, /incomplete/)
})


/* ---------- UI3: the screens you have to click to reach ---------------------------------------
   Every test above draws the DEFAULT screen. Nothing had ever navigated, so nothing had ever
   looked at the header of a screen you reach by tapping. */

test('every screen has a title - none renders the word undefined in its header', () => {
  for (const screen of SCREENS) {
    const title = render(base, { hash: '#' + screen }).get('screen-title').textContent
    assert.ok(title, `${screen} rendered no title at all`)
    assert.notEqual(String(title), 'undefined', `the ${screen} screen header reads "undefined"`)
  }
})

test('the nav has exactly as many tabs as there are screens, and the grid fits them', () => {
  const tabs = html.split('<div class="tabs">')[1].split('</div>')[0]
  const links = tabs.match(/data-screen="/g) ?? []
  assert.equal(links.length, SCREENS.length, 'nav tabs and screens have drifted apart')

  // A 6-column grid holding 7 links wraps to a second row, and --nav-h (which the body's
  // top padding is built from) only ever described one row. The result was a strip of every
  // page sitting underneath the nav on a phone, on every screen, permanently.
  const columns = html.match(/nav \.tabs \{[^}]*grid-template-columns: repeat\((\d+)/)
  if (columns) {
    assert.ok(Number(columns[1]) >= links.length,
      `the phone nav lays ${links.length} tabs into ${columns[1]} columns, so it wraps`)
  }
})

/* ---------- UI3: an empty list is not an all-clear -------------------------------------------
   The disease this whole product exists to treat, printed on its own front page. */

test('a team with nothing armed is never told everything scheduled is running', () => {
  const drawn = render({ ...base, workflows: [workflow({ arm: 'declared', armed: true })] }).get('today').innerHTML
  assert.ok(!drawn.includes('Everything scheduled is running'),
    'nine jobs declare a schedule, nothing rings, and Today reported all clear')
  assert.match(drawn, /Nothing can go quiet yet|nothing scheduled to miss/)
})

test('a ledger that has never been matched is not told it has no gaps', () => {
  const drawn = render({
    ...base,
    ledger: { ownerType: 'business', hourlyValue: 150, hoursPerWeek: 3, costPerWeek: 450, unpriced: false, unreadable: 0, complete: true, tasks: [{ task: 'A', words: 'w', confirmed: 'twice', hoursPerWeek: 3 }] },
    proposals: null
  }).get('ledger').innerHTML
  assert.ok(!/Nothing on the gaps list/.test(drawn),
    'never having asked what the team cannot do was reported as the team being able to do everything')
  assert.match(drawn, /No gaps list yet/)
})

test('a matched ledger with a genuinely empty gaps list says so as a finding', () => {
  const drawn = render({
    ...base,
    ledger: { ownerType: 'business', hourlyValue: 150, hoursPerWeek: 3, costPerWeek: 450, unpriced: false, unreadable: 0, complete: true, tasks: [] },
    proposals: { proposals: [], gaps: [] }
  }).get('ledger').innerHTML
  assert.match(drawn, /Nothing on the gaps list/)
})

/* ---------- UI3: what will this do to my stuff, answered BEFORE the click ---------------------- */

test('every button that spends or changes something says what it does before it is clicked', () => {
  const nodes = render({
    ...base,
    workflows: [
      workflow({ slug: 'brief', arm: 'armed', armed: true, fire: true, routineId: 't1' }),
      workflow({ slug: 'cold', name: 'Cold', arm: 'declared', armed: true })
    ],
    ledger: { ownerType: 'business', hourlyValue: 150, hoursPerWeek: 3, costPerWeek: 450, unpriced: false, unreadable: 0, complete: true, tasks: [] },
    proposals: { proposals: [{ task: 'A', item: 'agent:x', why: 'because', words: 'w', number: '3 hours a week' }], gaps: [] }
  })

  const today = nodes.get('today').innerHTML
  assert.match(today, /spends one run/, 'the Run buttons never say a run costs anything')

  const workflows = nodes.get('workflows').innerHTML
  assert.match(workflows, /asks for your run cap first|before it arms/,
    'Arm is the one button that starts spending money and it explained nothing first')

  const ledger = nodes.get('ledger').innerHTML
  assert.match(ledger, /[Nn]othing is switched on/,
    'Approve gave its reassurance only after it had already been clicked')
})

/* ---------- UI3: an empty screen tells a non-technical owner what to do next ------------------- */

test('empty screens name the next step rather than only the absence', () => {
  const nodes = render(base)
  const cases = [
    ['team', /\/onboard/],
    ['skills', /\/new-skill|ask your team|\/onboard/]
  ]
  for (const [screen, expected] of cases) {
    assert.match(nodes.get(screen).innerHTML, expected,
      `the empty ${screen} screen said what was missing and not what to do about it`)
  }
})

/* ---------- UI3, second pass: found by opening the page in a browser at 375px ------------------
   The DOM harness above renders content correctly and knows nothing about what overlaps what or
   how big anything is. Two things only a real viewport could say. */

test('the timestamps a reader is asked to trust are written for a person', () => {
  const drawn = render({
    ...base,
    routines: { takenAt: new Date(Date.now() - 2 * 86400e3).toISOString(), usable: true, stale: false, why: null, count: 1, known: true, orphans: [], problems: [] }
  })
  const today = drawn.get('today').innerHTML
  const foot = drawn.get('foot').textContent

  // "as recorded 8/26/2026, 12:44:21 AM" - a raw toLocaleString, seconds and all, in the two
  // places on the board whose entire job is to make an evidence claim believable.
  for (const [where, text] of [['the snapshot banner', today], ['the footer', foot]]) {
    assert.ok(!/:\d\d:\d\d/.test(text), `${where} prints a timestamp to the second`)
  }
  assert.match(today, /days ago/, 'the snapshot never says how old it is in words')
  assert.match(foot, /ago/, 'the footer never says how old the reading is in words')
})

test('the link to a live session is big enough to hit with a thumb', () => {
  // Measured in Chromium at 375x667: every other control cleared 32px; "watch" was 34x17.
  // It is also the one control on the board that goes from a phone to a live transcript.
  const drawn = render({
    ...base,
    board: { todo: [], upNext: [], running: [], done: [{ name: 'X', owner: 'research', status: 'ok', summary: 's', started_at: new Date().toISOString(), session_url: 'https://claude.ai/code/sessions/a' }] }
  }).get('today').innerHTML
  assert.match(drawn, /class="watch"/, 'the watch link has no class, so it cannot be given a hit area')
  assert.match(html, /\.watch\s*\{[^}]*min-height/, 'nothing in the stylesheet gives .watch a minimum height')
})

test('a skill name is a link that opens a file, so it gets a thumb target too', () => {
  // Measured at 23px in the same browser pass. Every tappable thing, not just the one that
  // happened to be looked at first.
  assert.match(html, /a\.title\[data-open\]\s*\{[^}]*min-height/,
    'the link that opens a skill file has no minimum height')
})

/* The board's own headline printed "1 hours a week" - the same defect numberCitation had one repo
   along, on the very screen that fix was found from. Every ledger fixture in this file used
   hoursPerWeek: 3, so nothing had ever rendered a week rounding to exactly one hour, which is what
   a first light week looks like. */

test('a one-hour week reads as one hour on the Ledger screen', () => {
  const drawn = render({
    ...base,
    ledger: { ownerType: 'business', hourlyValue: null, hoursPerWeek: 1, costPerWeek: null, unpriced: true, unreadable: 0, complete: true, tasks: [] }
  }).get('ledger').innerHTML

  assert.match(drawn, /<b>1<\/b> hour a week/, 'the headline said "1 hours a week"')
  assert.ok(!/<b>1<\/b> hours a week/.test(drawn))
})

test('every other week keeps its plural', () => {
  for (const hours of [0.5, 1.5, 2, 12.9]) {
    const drawn = render({
      ...base,
      ledger: { ownerType: 'business', hourlyValue: null, hoursPerWeek: hours, costPerWeek: null, unpriced: true, unreadable: 0, complete: true, tasks: [] }
    }).get('ledger').innerHTML
    assert.match(drawn, new RegExp(`<b>${hours}</b> hours a week`), `${hours} lost its plural`)
  }
})

/* A parked row is decided by rule 5 - confirmed twice, nobody named to act on the output - and NOT
   by whether the owner typed a reason. The board's first version keyed on the reason, which is a
   narrower rule than check:ledger's, so a parked row with no reason rendered as live work. */

test('a parked row is marked whether or not a reason was typed', () => {
  const drawn = render({
    ...base,
    ledger: {
      ownerType: 'business', hourlyValue: null, hoursPerWeek: 3, costPerWeek: null,
      unpriced: true, unreadable: 0, complete: true,
      tasks: [
        { task: 'With a reason', words: 'a', confirmed: 'twice', parked: true, parkedBecause: 'Nobody reads them.', hoursPerWeek: 1 },
        { task: 'Without a reason', words: 'b', confirmed: 'twice', parked: true, parkedBecause: null, hoursPerWeek: 1 },
        { task: 'Handed over', words: 'c', confirmed: 'twice', parked: false, parkedBecause: null, hoursPerWeek: 1 }
      ]
    }
  }).get('ledger').innerHTML

  assert.equal((drawn.match(/>parked</g) ?? []).length, 2, 'a parked row with no reason was shown as live work')
  assert.match(drawn, /Parked: Nobody reads them\./)
  assert.match(drawn, /Parked: nobody is named to act on the result yet/)
})

/* Each agent card on the Team screen is a <details> that opens to show what that agent actually
   did, with a link to each session. The CSS hides the disclosure marker on purpose and leaves only
   `cursor: pointer` - which does not exist on a phone, and the phone is the device this board is
   built to be read on and the one the course tells people to bookmark on day one. So on that
   device the cards looked flat and static, and every agent's work history was behind a tap with
   nothing at all saying a tap did anything. Nine run logs on this repo, none of them reachable
   unless you happened to try. */

test('an agent card says it opens, and says how much is in there', () => {
  const drawn = render({
    ...base,
    agents: [
      { slug: 'research', description: 'd', model: 'sonnet', lastRun: new Date().toISOString(), lastStatus: 'ok', runsThisWeek: 2, totalRuns: 3, state: 'working' }
    ]
  }).get('team').innerHTML

  assert.match(drawn, /3 runs logged/, 'the card does not say how much is behind the tap')
  assert.match(drawn, /tap to read them/, 'nothing on the Team screen says a card opens')
  assert.match(drawn, /class="chev"/, 'no visual affordance that the card expands')
  assert.match(
    drawn,
    /<span class="chev" aria-hidden="true">/,
    'the arrow is decorative and the sentence beside it already says the card opens - a screen ' +
      'reader announcing a bare glyph after that sentence is noise'
  )
})

test('an agent that has never run says so instead of inviting a tap into nothing', () => {
  const nodes = render({
    ...base,
    agents: [
      { slug: 'research', description: 'd', model: 'sonnet', lastRun: null, lastStatus: null, runsThisWeek: 0, totalRuns: 0, state: 'never-run' },
      { slug: 'email', description: 'd', model: 'sonnet', lastRun: new Date().toISOString(), lastStatus: 'ok', runsThisWeek: 1, totalRuns: 1, state: 'working' }
    ]
  }).get('team').innerHTML

  assert.match(nodes, /Nothing logged yet/, 'a never-run agent said nothing about being empty')
  // ...and it must not carry the arrow either, or it is still inviting a tap into an empty drawer.
  // Slicing between the two agent names isolates the first card. It works because a slug's first
  // appearance in this markup is inside its own card - its portrait's file name, or its <span
  // class="title"> when it has no portrait. The class list and accentStyle() emit only a hex colour,
  // and the banner above the cards names no agent, so there is nothing earlier to match on.
  const neverRunCard = nodes.slice(nodes.indexOf('research'), nodes.indexOf('email'))
  assert.ok(!neverRunCard.includes('chev'), 'an agent with no runs still invited a tap')
  assert.match(nodes, /1 run logged/, 'a single run was described as "1 runs"')
  assert.ok(!/1 runs logged/.test(nodes))
})

/* The count on a card and the list inside it came from two different places. The count is every
   run log the agent has; the list was filtered out of the feed, and the feed is only the newest
   fifty runs across the whole team. So an agent whose work was all older than the busiest agent's
   last fifty said "8 runs logged - tap to read them" and opened to "No runs logged yet." Reproduced
   by review with fifty newer runs from one agent and eight older ones for another. The card now
   reads its own newest few, sent with the agent, and says when that is not all of them. */

const runOf = (agent, hoursAgo, summary) => ({
  run_id: `${agent}-${hoursAgo}`, agent, status: 'ok', summary,
  started_at: new Date(Date.now() - hoursAgo * 3600_000).toISOString()
})
// One agent's card, from its opening tag to the next one, and the drawer inside it.
const cardFor = (drawn, slug) => drawn.split('<details class="agent-card').find((card) => card.includes(`class="title">${slug}<`)) ?? ''
const drawerOf = (card) => card.split('<div class="agent-runs">')[1] ?? ''

test('an agent whose runs are older than the feed\'s fifty opens to its own runs, and says it is the newest few', () => {
  const busy = Array.from({ length: 50 }, (unused, index) => runOf('email', index + 1, `Swept the inbox, pass ${index}.`))
  const own = Array.from({ length: 8 }, (unused, index) => runOf('research', 100 + index, `Looked it up, pass ${index}.`))
  const drawn = render({
    ...base,
    runs: busy,
    totalRuns: 58,
    agents: [
      { slug: 'email', description: 'd', model: 'sonnet', lastRun: busy[0].started_at, lastStatus: 'ok', runsThisWeek: 50, totalRuns: 50, state: 'working', recentRuns: busy.slice(0, 5) },
      { slug: 'research', description: 'd', model: 'sonnet', lastRun: own[0].started_at, lastStatus: 'ok', runsThisWeek: 8, totalRuns: 8, state: 'working', recentRuns: own.slice(0, 5) }
    ]
  }).get('team').innerHTML

  const card = cardFor(drawn, 'research')
  assert.match(card, /8 runs logged/, 'the card no longer says how many runs it has')
  const drawer = drawerOf(card)
  assert.ok(!drawer.includes('No runs logged yet'), 'the card counted eight runs and opened to none')
  for (const run of own.slice(0, 5)) assert.ok(drawer.includes(run.summary), `the card is missing its own run "${run.summary}"`)
  assert.ok(!drawer.includes('Swept the inbox'), 'another agent\'s run was drawn on this card')
  assert.match(drawer, /newest 5 of 8/, 'the card shows five of eight runs and does not say the rest exist')
})

test('a card that holds every run of its agent does not claim there are more', () => {
  const own = [runOf('research', 1, 'One.'), runOf('research', 2, 'Two.'), runOf('research', 3, 'Three.')]
  const drawer = drawerOf(cardFor(render({
    ...base,
    runs: own,
    agents: [{ slug: 'research', description: 'd', model: 'sonnet', lastRun: own[0].started_at, lastStatus: 'ok', runsThisWeek: 3, totalRuns: 3, state: 'working', recentRuns: own }]
  }).get('team').innerHTML, 'research'))
  assert.ok(['One.', 'Two.', 'Three.'].every((summary) => drawer.includes(summary)))
  assert.ok(!/newest/.test(drawer), 'all three runs are shown and the card still said they were only the newest')
})

test('a card sent a count but no runs says so, rather than that nothing was ever logged', () => {
  // What a page gets from a server that predates recentRuns - a cached reading during a deploy -
  // with the reviewer's own numbers: fifty newer runs for one agent, eight older for another.
  const busy = Array.from({ length: 50 }, (unused, index) => runOf('email', index + 1, `Swept the inbox, pass ${index}.`))
  const drawer = drawerOf(cardFor(render({
    ...base,
    runs: busy,
    agents: [{ slug: 'research', description: 'd', model: 'sonnet', lastRun: null, lastStatus: 'ok', runsThisWeek: 0, totalRuns: 8, state: 'working' }]
  }).get('team').innerHTML, 'research'))
  assert.ok(!drawer.includes('No runs logged yet'), 'eight runs were counted on the card and denied inside it')
  assert.match(drawer, /8 runs are logged/, 'the drawer does not say the runs exist')
})

/* The Workflows screen ran to nearly four thousand pixels on a phone, and most of it was the same
   sixty words. The explanation of what arming DOES was printed on every card, and every repo ships
   nine jobs all switched off on purpose, so every repo showed it nine times. Three separate things
   were wrong on that one screen, and all three are only visible in a picture of it. */

const nineWorkflows = (overrides = {}) =>
  Array.from({ length: 9 }, (unused, index) => workflow({
    slug: `job-${index}`, name: `Job ${index}`, owner: 'research',
    schedule: 'daily 06:30', arm: 'off', reason: 'Off until there is something to read.',
    ...overrides
  }))

test('the arming explanation is given once, not on every card', () => {
  const drawn = render({ ...base, workflows: nineWorkflows() }).get('workflows').innerHTML
  const times = drawn.split('Arming is what makes a schedule real').length - 1
  assert.equal(times, 1, `the arming paragraph appears ${times} times on one screen`)
})

test('the arming explanation disappears when there is nothing left to arm', () => {
  const drawn = render({ ...base, workflows: nineWorkflows({ arm: 'armed', reason: null }) }).get('workflows').innerHTML
  assert.ok(!drawn.includes('Arming is what makes a schedule real'))
})

test('the Workflows screen does not tell you to go to the Workflows screen', () => {
  const drawn = render({ ...base, workflows: nineWorkflows() }).get('workflows').innerHTML
  assert.ok(!drawn.includes('see the Workflows screen'), 'the screen pointed at itself')
  // The count note said "each one is listed below" here. The seven-day list does better than
  // count them: it names every one, with its own reason, in its own section. The obligation the
  // count discharged - that a job declaring a time and fired by nothing is never silently absent
  // - is what has to hold, not the sentence that used to discharge it.
  assert.match(drawn, /In a file, not ringing/, 'the jobs nothing fires are neither counted nor named')
  assert.match(drawn, /jobs name a time in their files/)
})

test('Today still points at the Workflows screen, because from there it is a real direction', () => {
  const drawn = render({ ...base, workflows: nineWorkflows() }).get('today').innerHTML
  assert.match(drawn, /see the Workflows screen/)
})

test('a reason that already begins with Off is not labelled Off twice', () => {
  const drawn = render({
    ...base,
    workflows: [
      workflow({ slug: 'a', name: 'A', owner: 'research', schedule: 'daily 06:30', arm: 'off', reason: 'Off until there is an inbox.' }),
      workflow({ slug: 'b', name: 'B', owner: 'research', schedule: 'daily 06:30', arm: 'off', reason: 'Waiting on a decision from Ray.' })
    ]
  }).get('workflows').innerHTML

  assert.ok(!/Off:\s*Off /.test(drawn), 'the word Off was printed twice')
  assert.match(drawn, /Off until there is an inbox\./)
  assert.match(drawn, /Off: Waiting on a decision from Ray\./, 'a reason that needs the label lost it')
})

/* The count of jobs that name a time and are fired by nothing was computed once and printed on
   only ONE of the two branches - the one where nothing rings at all. So the moment a repo armed
   its first job it fell into the other branch and that count vanished, from Today and from the
   Workflows screen both. That is the mixed state every real repo is in after week one, and this
   count is the only guard against a board showing nine jobs as scheduled when one of them rings. */

test('the silent-job count survives a repo that has armed something', () => {
  const mixed = [
    workflow({ slug: 'rings', name: 'Rings', owner: 'research', schedule: 'daily 06:30', arm: 'armed', armed: true }),
    workflow({ slug: 'silent-a', name: 'Silent A', owner: 'research', schedule: 'daily 07:00', arm: 'declared' }),
    workflow({ slug: 'silent-b', name: 'Silent B', owner: 'research', schedule: 'daily 08:00', arm: 'declared' })
  ]
  // A job can only BE armed if a snapshot was taken - armStateFor cannot return 'armed' without
  // one. The fixture used to leave base's "no snapshot yet" in place while calling a job armed,
  // a state no repo can be in, and that inconsistency is what let it pin a sentence the board
  // could not have said truthfully.
  const nodes = render({
    ...base,
    routines: { ...base.routines, usable: true, stale: false, known: true, count: 1, takenAt: new Date().toISOString() },
    workflows: mixed
  })

  // Today counts them, above its grid. A caveat read after four columns of a calendar that looks
  // complete has already lost, which is why the arm state prints before the schedule chip
  // everywhere else on this page.
  const today = nodes.get('today').innerHTML
  assert.match(
    today,
    /2 other jobs name a time in their files and nothing fires them/,
    'Today dropped the silent-job count as soon as one job was armed'
  )
  assert.ok(
    today.indexOf('other jobs name a time') < today.indexOf('schedule-scroll'),
    'on Today the warning sits under the calendar it is there to undermine'
  )

  // The Workflows screen names them instead, which is the stronger form of the same duty: both
  // silent jobs appear, with their times, and neither is among the seven days.
  const workflows = nodes.get('workflows').innerHTML
  const list = workflows.slice(workflows.indexOf('<h2>Next 7 days'), workflows.indexOf('<div class="stack">'))
  const silentAt = list.indexOf('In a file, not ringing')
  assert.ok(silentAt > 0, 'the Workflows screen dropped the silent jobs as soon as one job was armed')
  for (const name of ['Silent A', 'Silent B']) {
    assert.ok(list.slice(silentAt).includes(name), `${name} vanished once another job was armed`)
    assert.ok(!list.slice(0, silentAt).includes(name), `${name} was placed among the seven days`)
  }
  assert.ok(list.slice(0, silentAt).includes('Rings'), 'the job that does ring left the calendar')
})

test('one silent job is counted in the singular, alongside something that rings', () => {
  const nodes = render({
    ...base,
    routines: { ...base.routines, usable: true, stale: false, known: true, count: 1, takenAt: new Date().toISOString() },
    workflows: [
      workflow({ slug: 'rings', name: 'Rings', owner: 'research', schedule: 'daily 06:30', arm: 'armed', armed: true }),
      workflow({ slug: 'silent', name: 'Silent', owner: 'research', schedule: 'daily 07:00', arm: 'declared' })
    ]
  })
  assert.match(nodes.get('today').innerHTML, /1 other job names a time in its file and nothing fires it/)
})

/* ---------- the desktop width ------------------------------------------------------------------

   `.wrap` capped content at 44rem and centred it. That is the right measure for a phone and it
   was never lifted when the desktop sidebar was added, so on a 1890px screen the page rendered as
   176px of sidebar, 498px of nothing, 704px of content and 513px more nothing - over half the
   window empty, with the task board squeezed into four 168px columns.

   These are RULE-level tests. This suite has no layout engine and cannot measure a pixel; what it
   can hold is that the desktop override exists, that it is scoped to the desktop, and that
   reading text is still capped by its measure. The browser numbers behind each are recorded in
   the commit, taken at 390, 1024 and 1890. */

const stylesheet = () => readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')

// EVERY 48rem block, joined. There is more than one - the board's columns live in their own -
// and taking the first was how the first version of these tests read the wrong rules and failed
// against code that was correct.
const desktopBlock = () => {
  const css = stylesheet()
  const blocks = []
  let from = 0
  for (;;) {
    const at = css.indexOf('@media (min-width: 48rem)', from)
    if (at < 0) break
    // Brace-counting, because a regex cannot match nested rules.
    let depth = 0
    let index = css.indexOf('{', at)
    const start = index
    for (; index < css.length; index += 1) {
      if (css[index] === '{') depth += 1
      else if (css[index] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    blocks.push(css.slice(start, index))
    from = index
  }
  assert.ok(blocks.length, 'the desktop media query is gone')
  return blocks.join('\n')
}

test('the desktop layout lifts the phone width cap rather than leaving it in place', () => {
  const desktop = desktopBlock()
  assert.match(desktop, /\.wrap\s*\{[^}]*max-width:\s*82rem/,
    'the desktop override of the 44rem cap is gone, so a wide screen is a phone column again')
})

test('the phone keeps its own measure, so lifting the cap cannot reach it', () => {
  const css = stylesheet()
  // The base rule, outside any media query, still carries the phone cap.
  assert.match(css, /\n\s*\.wrap \{ max-width: 44rem;/,
    'the phone lost its reading measure and now runs the full width of the screen')
})

test('reading text stays capped by its measure even though the layout got wider', () => {
  const desktop = desktopBlock()
  const measure = desktop.match(/\.summary \{ max-width: (\d+)ch/) || desktop.match(/max-width:\s*(\d+)ch/)
  assert.ok(measure, 'nothing caps a line of prose any more, so paragraphs run the full width')
  const chars = Number(measure[1])
  assert.ok(chars >= 55 && chars <= 85, `a measure of ${chars} characters is outside what anyone reads comfortably`)
  // The elements that actually carry running text on these screens.
  for (const selector of ['.panel.empty', '.desc', '.summary', 'p.small']) {
    assert.ok(desktop.includes(selector), `${selector} is no longer capped, and it carries prose`)
  }
})

test('the week grid on Workflows uses the width instead of stretching seven rows across it', () => {
  const desktop = desktopBlock()
  assert.match(desktop, /\.days7 \{[^}]*grid-template-columns:\s*repeat\(auto-fill/,
    'the seven-day list is a single tall column again on a screen wide enough to show the week')
})

/* A rule being PRESENT is not the same as a rule WINNING, and the test above only knew about the
   first. The seven-day grid's border override sat with the other desktop rules two hundred lines
   above the unconditional `.days7 .d7-day` it was overriding. A media query adds no specificity,
   so the later unconditional rule won the tie: on desktop every day carried both a top and a left
   border, and the first carried neither. Every test passed. The rule never reached a pixel.

   So this checks the cascade, not the text: for any selector written both inside a min-width
   query and unconditionally, the media query has to come LATER whenever they set the same
   property. It is the one part of precedence a file can be read for. The parser that reads the
   sheet as rules is `cssRules`, in tests/helpers/css-rules.mjs. */

/* A shorthand resets the longhands it covers, so `border: 1px solid red` further down cancels a
   `border-top: 0` above it just as surely as another `border-top` would. Comparing property names
   as strings missed that entirely. Only the shorthands this sheet actually uses are listed - a
   full CSS map is not the job, and an incomplete one that pretends otherwise is worse. */
const SHORTHANDS = {
  border: ['border-top', 'border-right', 'border-bottom', 'border-left', 'border-width', 'border-style', 'border-color'],
  'border-width': ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  background: ['background-color', 'background-image', 'background-position', 'background-size'],
  font: ['font-size', 'font-family', 'font-weight', 'line-height'],
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
  grid: ['grid-template-columns', 'grid-template-rows', 'grid-template-areas'],
  'grid-template': ['grid-template-columns', 'grid-template-rows', 'grid-template-areas']
}

// What a declaration actually governs: itself, plus everything it resets.
const governedBy = (name) => new Set([name, ...(SHORTHANDS[name] ?? [])])

const propertiesOf = (body) =>
  body.split(';').map((part) => part.split(':')[0].trim()).filter((name) => name && !name.startsWith('/'))

/* Two selectors a browser treats as identical must compare equal here. `.a .b` and `.a  .b` are
   the same selector and were being read as two different rules, so an override could be dead and
   this check would never look at it. */
const normaliseSelector = (selector) =>
  selector.replace(/\s*([>+~,])\s*/g, '$1').replace(/\s+/g, ' ').trim()

test('a desktop override is never cancelled by an unconditional rule further down the sheet', () => {
  const rules = cssRules()
  const problems = []

  for (const override of rules.filter((rule) => rule.inMedia)) {
    const overridden = propertiesOf(override.body)
    if (!overridden.length) continue
    const sameSelector = rules.filter((rule) =>
      !rule.inMedia &&
      normaliseSelector(rule.selector) === normaliseSelector(override.selector) &&
      rule.at > override.at)

    for (const plain of sameSelector) {
      // A later declaration clashes if what IT governs includes anything the override set - which
      // catches a shorthand cancelling a longhand, not only an exact name match.
      const clash = overridden.filter((name) =>
        propertiesOf(plain.body).some((later) => governedBy(later).has(name)))
      if (clash.length) {
        problems.push(`${override.selector} sets ${clash.join(', ')} in a media query, and the same selector sets it again unconditionally further down - the later one wins and the override is dead`)
      }
    }
  }

  assert.deepEqual(problems, [], problems.join('\n'))
})

test('the step chain wraps instead of being cut off mid-word', () => {
  const styles = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  const rule = styles.match(/\n\s*\.steps \{[^}]*\}/)[0]
  assert.ok(!rule.includes('nowrap'), 'the chain is clipped again, and the last step is the one that names the job')
  assert.ok(!rule.includes('overflow-x'), 'the chain is behind a sideways scroll again')
})

/* Twenty-five skills in one alphabetical run, five thousand pixels of it, and the single most
   useful distinction on the screen - a skill some job already runs for you versus one that only
   happens if you ask - was a three-word grey label scattered through it. Somebody wanting to know
   what they can ask for had to read all twenty-five to find the seven. "sessions only" was also
   two undefined words carrying the whole idea. */

const skill = (slug, usedBy = []) => ({ slug, path: `.claude/skills/${slug}/SKILL.md`, description: `what ${slug} does`, usedBy })

test('skills are split into the ones you ask for and the ones a job already runs', () => {
  const drawn = render({
    ...base,
    skills: [skill('capture-verdict'), skill('triage-inbox', ['inbox-triage']), skill('token-saver')]
  }).get('skills').innerHTML

  assert.match(drawn, /Not a step in any job &middot; 2|Not a step in any job · 2/)
  assert.match(drawn, /Listed as a step in a job &middot; 1|Listed as a step in a job · 1/)
  assert.ok(
    drawn.indexOf('Not a step in any job') < drawn.indexOf('Listed as a step in a job'),
    'the ones no job lists are the ones nobody would otherwise find, so they go first'
  )
  assert.ok(!drawn.includes('sessions only'), 'the undefined two-word label is still there')
})

test('a group with nothing in it does not print an empty heading', () => {
  const allScheduled = render({
    ...base,
    skills: [skill('triage-inbox', ['inbox-triage']), skill('scan-market', ['morning-intel'])]
  }).get('skills').innerHTML
  assert.ok(!allScheduled.includes('Not a step in any job'), 'an empty group printed its heading')
  assert.match(allScheduled, /Listed as a step in a job/)

  const noneScheduled = render({ ...base, skills: [skill('capture-verdict')] }).get('skills').innerHTML
  assert.ok(!noneScheduled.includes('Listed as a step in a job'), 'an empty group printed its heading')
  assert.match(noneScheduled, /Not a step in any job/)
})

test('a skill a job runs still names the job', () => {
  const drawn = render({ ...base, skills: [skill('triage-inbox', ['inbox-triage', 'gone-cold'])] }).get('skills').innerHTML
  assert.match(drawn, /used by inbox-triage, gone-cold/)
})

/* The headings on this screen may say only what `usedBy` proves - membership of a workflow's
   `steps:` list. Two earlier wordings claimed more and both were false against the real repo:

     "A job already runs these for you" - every workflow ships armed: false, so in a fresh repo
     nothing runs any of them. That is precisely the claim the Workflows screen was rebuilt to stop
     making, reintroduced one screen along.

     "Only happen if you ask" - run-log sits in that group because it is nobody's step, and its own
     description says "use at the end of every agent run, scheduled or manual".

   So this asserts the absence of the claim, not the presence of a heading. */

test('the skills screen never claims a job is currently running anything', () => {
  const drawn = render({
    ...base,
    workflows: [workflow({ slug: 'inbox-triage', name: 'Inbox Triage', owner: 'email', schedule: 'daily 06:30', arm: 'declared' })],
    skills: [
      skill('triage-inbox', ['inbox-triage']),
      { slug: 'run-log', path: '.claude/skills/run-log/SKILL.md', usedBy: [], description: 'Use at the end of every agent run, scheduled or manual, before committing.' }
    ]
  }).get('skills').innerHTML

  for (const lie of [/already runs these/i, /runs these for you/i, /only happen if you ask/i, /nothing runs these/i]) {
    assert.ok(!lie.test(drawn), `the screen asserts something the data does not prove: ${lie}`)
  }
  // And it must point at the screen that DOES know whether anything rings.
  assert.match(drawn, /the Workflows screen is the one that says which jobs ring/)
})

test('a skill nothing lists is not described as ask-only, because some run themselves', () => {
  const drawn = render({
    ...base,
    skills: [{ slug: 'run-log', path: '.claude/skills/run-log/SKILL.md', usedBy: [], description: 'Use at the end of every agent run, scheduled or manual, before committing.' }]
  }).get('skills').innerHTML

  assert.match(drawn, /Some of these run themselves as part of other work/)
  assert.match(drawn, /use at the end of every agent run/i, 'the skill\'s own description still shows')
})

/* ---------- the Memory filters -----------------------------------------------------------------

   These were a flex row with `overflow-x: auto` and the base chip's `nowrap`. At 390px that is
   804px of chips in 358px, so SEVEN of twelve sat off-screen - `shared` among them, which holds
   the business brain and 18 of a real repo's 59 pages. A chip boundary lands near the screen edge,
   so unlike the step chain on the Workflows screen there was not even a mid-word cut to hint at it.

   Wrapping alone was NOT enough, and the first attempt shipped a worse bug than it fixed: with the
   overflow container gone and `.chip` still `nowrap`, one long folder name pushed straight out of
   the row and took the WHOLE PAGE sideways. Measured in a browser: a 69-character folder name gave
   a 490px document against a 390px viewport, where the old scrolling version stayed at 390. Local
   badness turned into global badness. `.filters .chip` therefore has to break internally, which is
   the same safeguard the Workflows step chain already used - cited as precedent and not copied.

   BE HONEST ABOUT WHAT THESE TESTS ARE. The suite renders through a DOM shim with no layout engine,
   so nothing here can measure a pixel or catch an overflow. These are source-shape guards: they
   fail if somebody removes the rules, and that is all they do. The evidence that the fix WORKS is a
   real browser at 390px, recorded in the commit: 0 of 12 chips off-screen, and document scrollWidth
   375 with the safeguard against 490 without it. */

test('the memory filters wrap instead of running off the side of the phone', () => {
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  const rule = page.match(/\n\s*\.filters \{[^}]*\}/)[0]
  assert.ok(!rule.includes('overflow-x'), 'the filters are behind a sideways scroll again')
  assert.ok(!rule.includes('nowrap'), 'the filters cannot wrap, so most of them are off-screen')
  assert.match(rule, /flex-wrap:\s*wrap/, 'the filters no longer wrap')
})

test('a long folder name breaks inside its chip rather than taking the page sideways', () => {
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  const rule = page.match(/\n\s*\.filters \.chip \{[^}]*\}/)[0]
  assert.match(rule, /overflow-wrap:\s*anywhere/,
    'without this a long folder name overflows the row, and with no overflow-x to contain it that ' +
      'reaches the whole document - a 69-character name measured 490px against a 390px viewport')
  assert.match(rule, /white-space:\s*normal/,
    'the base .chip rule sets nowrap, so overflow-wrap alone cannot break anything')
})

/* The same bug on the Skills screen, found by review in a browser: "Plugin · context7@claude-plugins-
   official" is one 322px chip that cannot break, so at 320 wide the page scrolled sideways (355
   against 305). Asked of the cascade rather than of the text: which value each property ENDS UP
   with on an element carrying exactly the classes the page gave that chip, on a phone. */

// Unconditional rules only, selectors made of nothing but classes the element has; the more classes
// a selector names the stronger it is, and between equals the later one wins.
const effectiveForClasses = (classes) => {
  const won = {}
  for (const rule of cssRules().filter((candidate) => !candidate.inMedia)) {
    for (const selector of rule.selector.split(',').map((one) => one.trim())) {
      if (!/^(\.[\w-]+)+$/.test(selector)) continue
      const names = selector.slice(1).split('.')
      if (!names.every((name) => classes.includes(name))) continue
      for (const [property, value] of Object.entries(valuesIn(rule))) {
        const held = won[property]
        if (!held || names.length > held.weight || (names.length === held.weight && rule.at > held.at)) {
          won[property] = { value, weight: names.length, at: rule.at }
        }
      }
    }
  }
  return Object.fromEntries(Object.entries(won).map(([property, { value }]) => [property, value]))
}

test('a long plugin name breaks inside its chip rather than taking the phone sideways', () => {
  const plugin = 'context7@claude-plugins-official'
  const drawn = render({
    ...base,
    stack: [{ name: 'context7', source: 'plugin', plugin, skill: null, present: null, gives: 'Docs.', why: 'Real docs.', verify: null }]
  }).get('skills').innerHTML
  const chip = new RegExp(`<span class="([^"]*)">Plugin · ${plugin}</span>`).exec(drawn)
  assert.ok(chip, 'the plugin chip is not drawn')

  // A short chip keeps its look: one line, never broken mid-word.
  assert.equal(effectiveForClasses(['chip'])['white-space'], 'nowrap', 'every chip now wraps, not only the long ones')
  const drawnAs = effectiveForClasses(chip[1].split(/\s+/))
  assert.equal(drawnAs['white-space'], 'normal', 'the plugin chip is held to one line, so a long name runs off the phone')
  assert.equal(drawnAs['overflow-wrap'], 'anywhere', 'a name with no spaces in it has nowhere to break')
  assert.equal(drawnAs['max-width'], '100%', 'nothing stops the chip being wider than the card it sits in')
})

/* This one is NOT evidence for the CSS fix above - it passes with or without it, because chip
   generation was never what broke. It is a guard on the list of folders being complete, which is
   worth having on its own and is labelled as that rather than borrowed as proof of something else. */

test('every top-level folder in the repo gets its own filter chip', () => {
  const nodes = render({
    ...base,
    memory: {
      files: [
        { path: 'shared/about-me.md', size: 100 },
        { path: 'shared/business-brain.md', size: 100 },
        { path: 'runs/2026-08/a.json', size: 100 },
        { path: 'top-level.md', size: 100 }
      ],
      indexes: [],
      truncated: false
    }
  }).get('memory').innerHTML

  for (const label of ['all', '(root)', 'runs', 'shared']) {
    assert.ok(nodes.includes(`>${label}</span>`), `no filter chip for ${label}`)
  }
  assert.match(nodes, /Search 4 page names/)
})

/* ---------- Connections ------------------------------------------------------------------------

   The whole point of connections/register.yml, in its own words: "a line in here without a
   verified date and a proof is a claim, not a connection, and the dashboard shows it as unproven."
   That unproven path had NO test at all, and the Connections screen had none beyond "it draws
   something". So the one state this file exists to make visible was the one nothing checked - and
   a scratch repo where everything happens to be proved would never show it either. */

const connection = (over = {}) => ({
  name: 'Gmail', slug: 'gmail', kind: 'connector', account: 'dana@example.com',
  scopes: ['read', 'draft'], usedBy: ['inbox-triage'],
  verified: '2026-08-24', proof: 'Read the subject lines of the three most recent messages',
  proved: true, ...over
})

test('a proved connection shows its date and the thing it actually did', () => {
  const drawn = render({ ...base, connections: [connection()] }).get('connections').innerHTML
  assert.match(drawn, /Proved 2026-08-24/)
  assert.match(drawn, /Read the subject lines of the three most recent messages/)
  assert.ok(!drawn.includes('Unproven'))
})

test('a connection with no proof is called a claim, not a connection', () => {
  const drawn = render({
    ...base,
    connections: [connection({ verified: null, proof: null, proved: false })]
  }).get('connections').innerHTML

  assert.match(drawn, /Unproven/, 'an unproved connection was shown as though it were proved')
  assert.match(drawn, /a claim rather than a connection/)
  assert.match(drawn, /\/connect/, 'it says it is unproven but not what to do about it')
  assert.ok(!drawn.includes('Proved'), 'an unproved connection claimed a proof date')
})

test('a connection nothing depends on says so rather than showing an empty line', () => {
  const drawn = render({ ...base, connections: [connection({ usedBy: [] })] }).get('connections').innerHTML
  assert.match(drawn, /no workflow depends on it yet/)
})

/* A runtime is somebody's own machine. The heartbeat is the only thing that knows whether it is
   still there, and "an agent that stopped three weeks ago is worse than no agent, because you were
   counting on it" - so each of the three states has to be distinguishable on sight. */

const runtime = (over = {}) => ({ name: 'Studio box', kind: 'agent-runtime', url: 'http://box.example:8080', heartbeat: 'runs/heartbeat/box.json', status: 'live', lastBeat: new Date().toISOString(), ...over })

test('a runtime that has gone quiet does not read the same as one that is running', () => {
  const live = render({ ...base, runtimes: [runtime()] }).get('connections').innerHTML
  const silent = render({ ...base, runtimes: [runtime({ status: 'silent', lastBeat: new Date(Date.now() - 3 * 3600_000).toISOString() })] }).get('connections').innerHTML
  const never = render({ ...base, runtimes: [runtime({ status: 'no-heartbeat', lastBeat: null })] }).get('connections').innerHTML

  assert.match(live, /Live/)
  assert.match(silent, /Silent/)
  assert.match(never, /No heartbeat/)
  assert.match(never, /no heartbeat file yet/, 'a runtime that never checked in showed a blank instead of saying so')
  assert.notEqual(live, silent, 'a running box and a stopped one render identically')
})

/* The generic "hostile text is escaped everywhere it lands" test builds its payload into ledger,
   proposals, workflows and routines - never connections or runtimes. So this was the one screen in
   the repo where a dropped escapeHtml() sailed through: proved by stripping it off connection.name
   and watching all 352 tests still pass. Every field here comes out of somebody's register.yml. */

test('hostile text in a connection or a runtime is escaped', () => {
  const nasty = '<script>alert(1)</script>"\'&'
  const drawn = render({
    ...base,
    connections: [connection({
      name: nasty, kind: nasty, account: nasty, scopes: [nasty], usedBy: [nasty],
      verified: nasty, proof: nasty
    })],
    runtimes: [runtime({ name: nasty, kind: nasty, url: nasty, status: 'silent' })]
  }).get('connections').innerHTML

  assert.ok(!drawn.includes('<script>'), 'raw script tag reached the Connections screen')
  assert.match(drawn, /&lt;script&gt;/, 'the hostile text was dropped rather than escaped')
  // Every field it was fed has to come back escaped, not just the first one.
  assert.equal((drawn.match(/&lt;script&gt;/g) ?? []).length >= 7, true,
    'some fields on this screen are escaped and others are not')
})

test('an unproved connection is escaped too, not just a proved one', () => {
  const nasty = '<img src=x onerror=alert(1)>'
  const drawn = render({
    ...base,
    connections: [connection({ name: nasty, verified: null, proof: null, proved: false })]
  }).get('connections').innerHTML

  assert.ok(!drawn.includes('<img src=x'), 'the unproved branch renders its name unescaped')
  assert.match(drawn, /&lt;img src=x/)
})

/* The shipped tiles.yml carries `hero: <!-- fill: hero-metric -->` and the owner picks their number
   in onboarding phase 10, near the end. So for most of a student's first week the hero IS that
   marker - and the board quoted it back at them: `tiles.yml asks for "<!-- fill: hero-metric -->"
   and nothing computes it yet`. Raw internal markup, at the top of the screen the course tells
   them to bookmark on day one, describing a step they have not reached as though it were a fault.

   Nobody saw it because the owner fixture had already chosen a hero. It took building a student
   who is only part way through. */

test('a student who has not picked their number yet is not shown the raw marker', () => {
  const drawn = render({
    ...base,
    // the REAL shaped hero, not a hand-written copy of what it is assumed to say
    hero: shapeHero({ hero: '<!-- fill: hero-metric -->' }, null)
  }).get('today').innerHTML

  assert.ok(!drawn.includes('fill:'), 'the board printed a fill marker at a student')
  assert.ok(!drawn.includes('&lt;!--'), 'the board printed raw markup at a student')
  assert.match(drawn, /No hero number yet/)
  assert.match(drawn, /nobody has chosen yours/)
})

test('no screen ever renders a raw fill marker', () => {
  const midOnboarding = {
    ...base,
    hero: shapeHero({ hero: '<!-- fill: hero-metric -->' }, null),
    brain: [{ path: 'shared/about-me.md', missing: ['full-name', 'role'] }],
    ledger: null,
    proposals: null
  }
  const nodes = render(midOnboarding)
  for (const screen of SCREENS) {
    const drawn = nodes.get(screen).innerHTML
    assert.ok(!drawn.includes('&lt;!-- fill:'), `${screen} printed a raw fill marker`)
    assert.ok(!drawn.includes('<!-- fill:'), `${screen} printed a raw fill marker`)
  }
})

/* The panel prints `hero.why` straight after "No hero number yet.", so a lowercase fragment began
   that sentence with a lowercase letter in every state. The FIRST fix capitalised it in the
   renderer, and that was worse: one of these reasons legitimately begins with the filename
   `tiles.yml`, so the panel printed `Tiles.yml` - a file that does not exist - on the screen the
   course tells students to bookmark on day one. A wrong filename is a worse failure than an
   uncapitalised sentence, and a view layer cannot tell a word from a filename.

   My test for that first fix checked only that A capital appeared, never WHAT was capitalised, so
   its own fixture data contained the bug and it still went green. These check the thing itself. */

// Every state shapeHero can return WITHOUT a number. Named and counted, because the first version
// of this test used a fixture with usable hours, which returns defined: true and silently dropped
// out of the list - leaving the "N rows could not be read" sentence unchecked while the test was
// called "every state the board can be in". Its `>= 5` threshold then matched what actually ran
// rather than what it promised. Exact count here so a state cannot go missing quietly again.
const HERO_STATES = {
  'no number chosen yet': () => shapeHero({ hero: '<!-- fill: hero-metric -->' }, null),
  'a metric nothing computes': () => shapeHero({ hero: 'deals-closed' }, null),
  'no ledger at all': () => shapeHero({ hero: 'hours-a-week' }, null),
  'rows that could not be read': () => shapeHero({ hero: 'hours-a-week' }, { ownerType: 'job', hoursPerWeek: 0, costPerWeek: null, unpriced: true, unreadable: 2, complete: false, tasks: [] }),
  'a ledger with no hours': () => shapeHero({ hero: 'hours-a-week' }, { ownerType: 'job', hoursPerWeek: 0, costPerWeek: null, unpriced: true, unreadable: 0, complete: false, tasks: [] }),
  'a ledger missing what the metric needs': () => shapeHero({ hero: 'cost-a-week' }, { ownerType: 'job', hoursPerWeek: 3, costPerWeek: null, unpriced: true, unreadable: 0, complete: true, tasks: [] }),
  'a number too large to read': () => shapeHero({ hero: 'cost-a-week' }, { ownerType: 'business', hourlyValue: Number.MAX_VALUE, hoursPerWeek: 10, costPerWeek: Infinity, unpriced: false, unreadable: 0, complete: true, tasks: [] })
}

test('the hero reason is a finished sentence in every state the board can be in', () => {
  const reasons = Object.entries(HERO_STATES).map(([label, build]) => [label, build()])

  for (const [label, hero] of reasons) {
    assert.equal(hero.defined, false, `"${label}" no longer reaches a state without a number - the fixture stopped exercising it`)
    assert.match(hero.why, /^[A-Z0-9"]/, `"${label}" does not start a sentence: ${hero.why}`)
    assert.match(hero.why, /\.$/, `"${label}" has no full stop: ${hero.why}`)
  }
  assert.equal(reasons.length, 7, 'a hero state was added or removed without being covered here')
})

test('every hero reason renders into the panel as a whole sentence', () => {
  for (const [label, build] of Object.entries(HERO_STATES)) {
    const drawn = render({ ...base, hero: build() }).get('today').innerHTML
    assert.ok(!drawn.includes('..'), `"${label}" produced a doubled full stop`)
    assert.ok(!drawn.includes('fill:'), `"${label}" leaked a raw marker`)
    assert.ok(!drawn.includes('undefined'), `"${label}" rendered undefined`)
    assert.match(drawn, /Nothing is shown rather than a zero/, `"${label}" lost the rest of the sentence`)
  }
})

test('a filename in a hero reason keeps its real casing', () => {
  const why = shapeHero({ hero: 'deals-closed' }, null).why
  assert.match(why, /tiles\.yml/, 'the reason no longer names the file the owner has to edit')
  assert.ok(!why.includes('Tiles.yml'), 'the panel names a file that does not exist')

  const drawn = render({ ...base, hero: shapeHero({ hero: 'deals-closed' }, null) }).get('today').innerHTML
  assert.match(drawn, /tiles\.yml/)
  assert.ok(!drawn.includes('Tiles.yml'), 'the rendered panel names a file that does not exist')
})

test('the renderer no longer tries to fix the sentence itself', () => {
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  assert.ok(
    !/why\[0\]\.toUpperCase/.test(page),
    'the view layer is capitalising again, which is what turned tiles.yml into Tiles.yml'
  )
})

test('the hero panel reads as one sentence, with no doubled or missing full stop', () => {
  const drawn = render({ ...base, hero: shapeHero({ hero: '<!-- fill: hero-metric -->' }, null) }).get('today').innerHTML
  assert.ok(!drawn.includes('..'), 'a doubled full stop')
  assert.match(drawn, /nobody has chosen yours\. \/onboard asks which/)
  assert.match(drawn, /it should be\. Nothing is shown rather than a zero/)
})

/* Half the people this board is built for have a job rather than a business. The ledger's very
   first question is `owner_type: business | job | both`, and the walkthrough's employee persona is
   a bid coordinator who does not price work, choose what to bid, or spend anything. The course's
   own model of its reader has been the owner-shaped one before - 18 of that persona's 19 lesson
   runs turned up a defect, nearly all of it a worked example assuming customers or authority.

   The board was nearly clean. One line was not, and it was an empty state, which means it is the
   FIRST sentence a brand-new student reads on that screen. */

// Terms that assume the reader owns the thing. BARE words, not "your X" - the first version of
// this list only had the "your ..." forms, and the live defect it missed said "check which clients
// went quiet", which never says "your". A list I write is exactly the thing that misses what I did
// not think of, so this errs wide and the exceptions are named.
const OWNER_ASSUMPTIONS = [
  /\byour business\b/i, /\byour company\b/i, /\byour revenue\b/i, /\byour staff\b/i,
  /\bclients?\b/i, /\bcustomers?\b/i, /\bprospects?\b/i, /\brevenue\b/i, /\bpayroll\b/i
]

// A payload where every screen has something on it. The first version of this test called itself
// "empty and populated" while leaving workflows, the board, ledger tasks and proposals all empty -
// so half the branches it claimed to sweep were never rendered at all. That is the same overclaim
// this suite exists to catch, one level up.
const populated = () => ({
  ...base,
  agents: [{ slug: 'research', description: 'Looks something up and comes back with a short report.', model: 'sonnet', lastRun: new Date().toISOString(), lastStatus: 'ok', runsThisWeek: 1, totalRuns: 2, state: 'working' }],
  runs: [{ run_id: 'r1', agent: 'research', workflow: 'morning-intel', status: 'ok', started_at: new Date().toISOString(), summary: 'Checked the portals.', session_url: 'https://claude.ai/code/x' }],
  totalRuns: 1,
  workflows: [workflow({ slug: 'morning-intel', name: 'Morning Intel', owner: 'research', arm: 'off', reason: 'Off until there is something to read.', state: 'never-run' })],
  board: {
    todo: [{ slug: '2026-08-20-a', title: 'Chase the certificate', for: 'email', doing: false }],
    upNext: [], running: [],
    done: [{ slug: 'r1', title: 'Morning Intel', summary: 'Checked the portals.', at: new Date().toISOString(), status: 'ok', url: 'https://claude.ai/code/x' }]
  },
  ledger: {
    ownerType: 'job', hourlyValue: null, hoursPerWeek: 10.33, costPerWeek: null, unpriced: true, unreadable: 0, complete: true,
    tasks: [
      { task: 'Chasing documents', words: 'I chase five firms every bid', confirmed: 'twice', parked: false, parkedBecause: null, hoursPerWeek: 3 },
      { task: 'Keeping certificates current', words: 'they expire and I find out late', confirmed: 'twice', parked: true, parkedBecause: 'They live on a drive I cannot reach.', hoursPerWeek: 0.7 }
    ]
  },
  proposals: {
    proposals: [{ task: 'Chasing documents', item: 'skill:draft-chase-messages', why: 'It drafts and sends nothing.', words: 'I chase five firms every bid', number: '3 hours a week' }],
    gaps: [{ task: 'Checking a pack against its list', question: 'Nothing here reads a requirements list back - should it?' }]
  },
  connections: [connection()],
  runtimes: [runtime()],
  skills: [skill('triage-inbox', ['inbox-triage']), skill('capture-verdict')],
  stack: [{ name: 'context7', source: 'plugin', plugin: 'context7@official', skill: null, present: null, gives: 'Official docs on demand', why: 'Reading the real docs beats recalling them', verify: 'Ask it to resolve a library you use' }],
  memory: { files: [{ path: 'shared/about-me.md', size: 900 }, { path: 'runs/2026-08/a.json', size: 400 }], indexes: [], truncated: false },
  setup: [{ rung: 'brief', label: 'Brief', pass: true, detail: 'filled in' }]
})

test('no screen assumes the reader owns a business, empty or populated', () => {
  const fixtures = { empty: render(base), populated: render(populated()) }

  // The populated fixture has to actually populate, and this has to be checked by looking for
  // something only the populated branch can draw. A length threshold does not do it: six of the
  // seven screens clear 200 characters on their EMPTY state alone - Today's empty state is 3,042 -
  // so `length > 200` measured "did anything render at all", which another test already covers,
  // while reading like it measured "did the populated branch run".
  // One marker per POPULATED BRANCH, not one per screen. The first version used a single marker
  // for the Ledger, "Chasing documents" - which appears both in ledger.tasks and in the proposal
  // built from it, so emptying either one alone still left the marker behind and the guard passed.
  // Each branch that has to render needs its own string that only it can draw.
  const ONLY_WHEN_POPULATED = {
    today: ['Chase the certificate', 'Checked the portals'],
    ledger: ['Keeping certificates current', 'skill:draft-chase-messages', 'reads a requirements list back'],
    team: ['Looks something up'],
    workflows: ['Morning Intel', 'Off until there is something to read'],
    skills: ['triage-inbox', 'capture-verdict', 'context7'],
    memory: ['about-me.md'],
    connections: ['Read the subject lines', 'Studio box']
  }
  for (const screen of SCREENS) {
    const drawn = fixtures.populated.get(screen).innerHTML
    for (const marker of ONLY_WHEN_POPULATED[screen]) {
      assert.ok(
        drawn.includes(marker),
        `the populated fixture leaves part of ${screen} on its empty state ("${marker}" is missing), ` +
          'so the sweep below reads nothing there'
      )
    }
  }

  for (const [label, nodes] of Object.entries(fixtures)) {
    for (const screen of SCREENS) {
      const drawn = nodes.get(screen).innerHTML
      for (const assumption of OWNER_ASSUMPTIONS) {
        assert.ok(!assumption.test(drawn), `${screen} (${label}) assumes the reader owns the business: ${assumption}`)
      }
    }
  }
})

test('a week with no rate is counted in hours and never in money', () => {
  const drawn = render({
    ...base,
    ledger: { ownerType: 'job', hourlyValue: null, hoursPerWeek: 10.33, costPerWeek: null, unpriced: true, unreadable: 0, complete: true, tasks: [] }
  }).get('ledger').innerHTML

  assert.match(drawn, /10\.3<\/b> hours a week/)
  assert.match(drawn, /No rate recorded/)
  // Scoped to the app's OWN money markup. A real ledger can quote "$500 in review requests" in
  // somebody's own words, and both `includes('$')` and /\$\d/ fail on that - the second one was
  // committed with a comment claiming it did not, which was wrong and unrun.
  //
  // `<b>$` is the cost LINE's markup specifically, not every money figure on the board: the hero
  // renders its own money inside `.hero-value` with no <b>. That one is not this assertion's job
  // and is not left unguarded - shapeHero refuses to build a money hero at all when the ledger is
  // unpriced, so an unpriced ledger structurally cannot carry one, and that is enforced and tested
  // upstream in api/state.js. escapeHtml means repo text can never produce a literal <b>, so this
  // matches the cost line and nothing a person wrote.
  assert.ok(!/<b>\$/.test(drawn), 'a money figure appeared for somebody who gave no rate')
  // Money no longer carries a "$", so the guard above would pass against a bare cost line. This
  // is the cost line's own shape: a bold number, an optional code, then "a week".
  assert.ok(!/<b>[\d,]+(?: \S+)?<\/b> a week/.test(drawn), 'a cost line appeared for somebody who gave no rate')
  assert.ok(!drawn.includes('at the rate you set'), 'it claimed a rate that was never given')
})

test('money on the Ledger screen carries the ledger\'s own currency code, never a dollar sign', () => {
  const drawn = render({
    ...base,
    ledger: { ownerType: 'business', hourlyValue: 165, currency: 'GBP', hoursPerWeek: 12.9, costPerWeek: 2131, unpriced: false, unreadable: 0, complete: true, tasks: [] }
  }).get('ledger').innerHTML

  assert.match(drawn, /<b>2,131 GBP<\/b> a week at the rate you set/)
  assert.ok(!/<b>\$/.test(drawn), 'the board guessed a dollar sign for a ledger that said GBP')
  assert.ok(!drawn.includes('No currency recorded'), 'it said no currency was recorded when one was')
})

test('a rate with no currency prints the number bare and says so, rather than guessing a symbol', () => {
  const drawn = render({
    ...base,
    ledger: { ownerType: 'business', hourlyValue: 150, currency: null, hoursPerWeek: 16.25, costPerWeek: 2437.5, unpriced: false, unreadable: 0, complete: true, tasks: [] }
  }).get('ledger').innerHTML

  assert.match(drawn, /<b>2,438<\/b> a week at the rate you set/)
  assert.match(drawn, /No currency recorded, so the number is printed bare\./)
  assert.ok(!/<b>\$/.test(drawn), 'the board fell back to a dollar sign')
})

test('a currency code is text from a file somebody wrote, so it is escaped on both money sites', () => {
  // `<b>` fits the currency shape (no whitespace, under nine characters), so it reaches the page.
  const hostile = '<b>'
  const ledgerScreen = render({
    ...base,
    ledger: { ownerType: 'business', hourlyValue: 150, currency: hostile, hoursPerWeek: 10, costPerWeek: 1500, unpriced: false, unreadable: 0, complete: true, tasks: [] }
  }).get('ledger').innerHTML
  assert.match(ledgerScreen, /1,500 &lt;b&gt;<\/b> a week at the rate you set/)

  const today = render({
    ...base,
    hero: { metric: 'cost-a-week', defined: true, value: 1500, unit: 'a week', money: true, currency: hostile, caption: 'at the rate you set' }
  }).get('today').innerHTML
  assert.match(today, /class="hero-value">1,500 &lt;b&gt;</)
})

test('the hero prints money with the currency code after the number, or bare when there is none', () => {
  const withCode = render({
    ...base,
    hero: { metric: 'cost-a-week', defined: true, value: 2131, unit: 'a week', money: true, currency: 'GBP', caption: 'at the rate you set' }
  }).get('today').innerHTML
  assert.match(withCode, /class="hero-value">2,131 GBP</)

  const bare = render({
    ...base,
    hero: { metric: 'cost-a-week', defined: true, value: 2437.5, unit: 'a week', money: true, currency: null, caption: 'at the rate you set' }
  }).get('today').innerHTML
  assert.match(bare, /class="hero-value">2,438</)
  assert.ok(!bare.includes('$'), 'the hero fell back to a dollar sign')
})

/* Three states on this board mean "deliberately off", and two of them show the owner's own reason:
   a workflow with armed: false prints its `reason:`, and a parked ledger row prints its
   `parked_because:`. An agent switched off printed nothing - the board read the knowledge file to
   decide it, took a boolean, and threw the sentence away. So the two agents somebody had switched
   off looked exactly like two nobody had got to, separated by a small grey label. */

test('an agent switched off says why, in the owner\'s own words', () => {
  const drawn = render({
    ...base,
    agents: [
      { slug: 'sales', description: 'Researches a prospect.', model: 'opus', lastRun: null, lastStatus: null, runsThisWeek: 0, totalRuns: 0, state: 'not-in-use', notInUseBecause: 'I do not sell - the selling is Ray\'s job.' },
      { slug: 'content', description: 'Writes posts.', model: 'opus', lastRun: null, lastStatus: null, runsThisWeek: 0, totalRuns: 0, state: 'never-run', notInUseBecause: null }
    ]
  }).get('team').innerHTML

  assert.match(drawn, /I do not sell - the selling is Ray&#39;s job\./, 'the reason was thrown away')
  assert.match(drawn, /Switched off, so nothing runs it/)
  // and an agent nobody has got to yet must NOT borrow that wording
  const contentCard = drawn.slice(drawn.indexOf('content'))
  assert.ok(!contentCard.includes('Switched off'), 'an unused agent was described as switched off')
  assert.match(contentCard, /Nothing logged yet/)
})

test('a switched-off agent is not invited to be tapped into an empty drawer', () => {
  const drawn = render({
    ...base,
    agents: [{ slug: 'sales', description: 'd', model: 'opus', lastRun: null, lastStatus: null, runsThisWeek: 0, totalRuns: 0, state: 'not-in-use', notInUseBecause: 'I do not sell.' }]
  }).get('team').innerHTML
  assert.ok(!drawn.includes('tap to read them'), 'a switched-off agent invited a tap into nothing')
})

test('a long reason is capped on screen, with the whole sentence still reachable', () => {
  // There is no cap on how long somebody's sentence is, and the rule that finds it reads to the end
  // of the paragraph - so one legitimate quote listing everything the owner does not sell ran to
  // twelve lines on a phone and buried the seven cards under it. Capped to three lines in CSS, full
  // text in the tooltip. Cutting the TEXT instead would be editing somebody's words to fit a box.
  const long =
    'I do not sell televisions, radios, cookware, garden furniture, office chairs, ' +
    "children's toys, seasonal decorations, power tools or bathroom fittings, because " +
    'Ray handles all of that for this business and has done since we started trading.'
  const drawn = render({
    ...base,
    agents: [{ slug: 'sales', description: 'd', model: 'opus', lastRun: null, lastStatus: null, runsThisWeek: 0, totalRuns: 0, state: 'not-in-use', notInUseBecause: long }]
  }).get('team').innerHTML

  assert.match(drawn, /class="small muted clamp"/, 'the reason is not capped, so a long one takes the screen')
  // Both ends of the sentence, in the tooltip and in the body. The apostrophe in the middle is
  // escaped, which is why this checks the ends rather than the whole string.
  assert.match(
    drawn,
    /title="I do not sell televisions[^"]*we started trading\."/,
    'the full sentence is not reachable once it is capped'
  )
  assert.ok(
    drawn.includes('>I do not sell televisions') && drawn.includes('since we started trading.<'),
    'the sentence was shortened rather than clipped - that edits somebody\'s words to fit a box'
  )
})

test('a switched-off agent with no quotable reason still says it is switched off', () => {
  // Its refusal lives only inside a code fence, so there is nothing to quote. The card must not
  // fall back to "Nothing logged yet", which is what an agent NOBODY HAS GOT TO says.
  const drawn = render({
    ...base,
    agents: [{ slug: 'sales', description: 'd', model: 'opus', lastRun: null, lastStatus: null, runsThisWeek: 0, totalRuns: 0, state: 'not-in-use', notInUseBecause: null }]
  }).get('team').innerHTML

  assert.match(drawn, /Switched off, so nothing runs it/)
  assert.ok(!drawn.includes('Nothing logged yet'), 'a switched-off agent read as one nobody had used')
  assert.ok(!drawn.includes('tap to read them'))
})

test('a job owned by a switched-off agent says so, above the reason it contradicts', () => {
  // The reason on this card reads "Off until the pipeline has people in it who could go quiet",
  // which tells him to arm it when the data arrives. Arming it would achieve nothing: the agent
  // that owns it is one he switched off, and the workflow validator only checks the owner exists.
  // The two sentences sit on the same card, so the one that contradicts the other has to come
  // first - otherwise the card ends on the instruction that does not work.
  const drawn = render({
    ...base,
    workflows: [
      workflow({
        slug: 'gone-cold',
        name: 'Gone Cold',
        owner: 'sales',
        ownerSwitchedOff: true,
        arm: 'off',
        reason: 'Off until the pipeline has people in it who could go quiet.'
      })
    ]
  }).get('workflows').innerHTML

  assert.match(drawn, /cannot run as written/, 'the card never says the job cannot run')
  assert.match(drawn, /which you are not using/)
  assert.ok(drawn.includes('<b>sales</b>'), 'it does not name the owner, so he cannot go and fix it')
  assert.ok(
    drawn.indexOf('cannot run as written') < drawn.indexOf('Off until the pipeline'),
    'the card ends on an instruction that does not work'
  )
})

test('a job whose owner is in use is not accused of being unable to run', () => {
  const drawn = render({
    ...base,
    workflows: [workflow({ owner: 'research', ownerSwitchedOff: false, arm: 'off', reason: 'Off until you know your run cap.' })]
  }).get('workflows').innerHTML
  assert.ok(!drawn.includes('cannot run as written'), 'a job that runs fine was told it cannot')
})

test('a skill whose only job cannot run says so, without calling the skill dead', () => {
  const drawn = render({
    ...base,
    skills: [{ slug: 'collect-run-logs', path: '.claude/skills/collect-run-logs/SKILL.md', description: 'Gather the facts.', usedBy: ['weekly-review'], stalled: ['weekly-review'], stalledOwners: ['customer-service'] }]
  }).get('skills').innerHTML

  assert.match(drawn, /which cannot run as written/, 'the screen leaves him to cross-reference another one')
  assert.match(drawn, /is switched off/, 'it does not say WHY the job cannot run')
  assert.match(drawn, /weekly-review/, 'and it does not name the job or the agent behind it')
  // The narrow claim. Everything on this screen can still be asked for by name, so anything
  // stronger than "the job cannot run" is a bigger claim than the evidence supports.
  for (const overreach of ['useless', 'never used', 'cannot be used', 'does nothing']) {
    assert.ok(!drawn.includes(overreach), `the screen called a usable skill "${overreach}"`)
  }
})

test('a skill used by a job that runs is not marked, and neither is one used by nothing', () => {
  const drawn = render({
    ...base,
    skills: [
      { slug: 'scan-market', path: '.claude/skills/scan-market/SKILL.md', description: 'd', usedBy: ['morning-intel'], stalled: [] },
      { slug: 'sync', path: '.claude/skills/sync/SKILL.md', description: 'd', usedBy: [], stalled: [] }
    ]
  }).get('skills').innerHTML
  assert.ok(!drawn.includes('cannot run as written'), 'a job that runs fine was reported as stalled')
})

test('a skill used by one dead job and one live one names the dead one', () => {
  const drawn = render({
    ...base,
    skills: [{ slug: 'review-pipeline', path: '.claude/skills/review-pipeline/SKILL.md', description: 'd', usedBy: ['gone-cold', 'draft-queue'], stalled: ['gone-cold'], stalledOwners: ['sales'] }]
  }).get('skills').innerHTML
  assert.match(drawn, /gone-cold cannot run as written/)
  assert.ok(!drawn.includes('which cannot run as written'), 'it implied BOTH jobs are dead')
})

/* HOW MANY OWNERS THERE ARE. Review found the version that could not tell: it said "the owner is
   switched off" for any number of dead jobs, inventing one shared owner where there can be two -
   and the two agents somebody with a job switches off are exactly that case. The count is out of
   the sentence now; it names them instead, which is also the half he can act on. */

const skillWith = (over) => ({
  slug: 'review-pipeline',
  path: '.claude/skills/review-pipeline/SKILL.md',
  description: 'd',
  ...over
})
const noteFor = (over) =>
  render({ ...base, skills: [skillWith(over)] })
    .get('skills')
    .innerHTML.match(/<div class="small bad">([^<]*)<\/div>/)?.[1] ?? ''

test('the line names the agents behind the dead jobs, however many there are', () => {
  assert.equal(
    noteFor({ usedBy: ['gone-cold'], stalled: ['gone-cold'], stalledOwners: ['sales'] }),
    'which cannot run as written &mdash; sales is switched off'
  )
  assert.equal(
    noteFor({ usedBy: ['gone-cold', 'weekly-review'], stalled: ['gone-cold', 'weekly-review'], stalledOwners: ['sales', 'customer-service'] }),
    'none of which can run as written &mdash; sales and customer-service are switched off'
  )
  // Two dead jobs, ONE owner between them. "their owners are" would claim two agents where there
  // is one; naming them says it once and correctly.
  assert.equal(
    noteFor({ usedBy: ['a', 'b'], stalled: ['a', 'b'], stalledOwners: ['sales'] }),
    'none of which can run as written &mdash; sales is switched off'
  )
  // Three jobs, two dead, two different owners - the case review found, where the old wording said
  // "the owner is switched off" and invented a single shared one.
  assert.equal(
    noteFor({ usedBy: ['a', 'b', 'c'], stalled: ['a', 'b'], stalledOwners: ['sales', 'customer-service'] }),
    'a, b cannot run as written &mdash; sales and customer-service are switched off'
  )
  // Three owners, so the joining has to hold up past two.
  assert.equal(
    noteFor({ usedBy: ['a', 'b', 'c'], stalled: ['a', 'b', 'c'], stalledOwners: ['sales', 'customer-service', 'editor'] }),
    'none of which can run as written &mdash; sales, customer-service and editor are switched off'
  )
})

test('a payload with no stalledOwners still says the job cannot run, and claims nothing else', () => {
  const note = noteFor({ usedBy: ['gone-cold'], stalled: ['gone-cold'] })
  assert.equal(note, 'which cannot run as written')
  assert.ok(!note.includes('switched off'), 'it named an owner it was never given')
})

test('a skills payload with no stalled field at all still renders', () => {
  // Older payloads, and any path that builds a skill by hand. A missing field must not throw and
  // must not be read as a stall.
  const drawn = render({
    ...base,
    skills: [{ slug: 'sync', path: '.claude/skills/sync/SKILL.md', description: 'd', usedBy: ['draft-queue'] }]
  }).get('skills').innerHTML
  assert.ok(drawn.includes('sync'), 'the screen failed to draw at all')
  assert.ok(!drawn.includes('cannot run as written'))
})

/* WHAT THE MEMORY SEARCH ACTUALLY SEARCHES.

   The box matches file.path and nothing else. Searching for a word that IS written in the vault -
   a client's name, a phrase somebody remembers typing - answered "No pages match." The page is
   there; its NAME does not contain the word, and nothing on screen said that was the difference.

   Not made true, said. The payload carries the list of pages and their sizes, never their contents,
   and a page is fetched only when it is opened - searching inside them would be fifty-odd fetches
   per keystroke. So the box has to describe itself, in the moment the difference matters. */

const memoryPayload = {
  ...base,
  memory: {
    files: [
      { path: 'shared/business-brain.md', size: 2348 },
      { path: 'shared/about-me.md', size: 805 },
      { path: 'runs/2026-08-30-research.md', size: 1200 }
    ],
    indexes: [],
    truncated: false
  }
}

test('the search box says it searches names, before anybody types', () => {
  const drawn = render(memoryPayload).get('memory').innerHTML
  assert.match(drawn, /Search 3 page names/, 'the box promises to search pages, and searches names')
})

/* EVERY REASON THIS LIST CAN BE EMPTY, and each one gets its own sentence.

   Two false statements have been on this screen, and the second was shipped by the commit that
   fixed the first:

     "No pages match."            said for a word that IS written in the vault. The box matches
                                  file.path and nothing else, so a client's name or a remembered
                                  phrase finds nothing while the page sits right there.
     "No page NAME contains X"    said while a FOLDER BUTTON was narrowing the list - a claim about
                                  the whole vault made after looking in one folder. Search "brain"
                                  with agents chosen and shared/business-brain.md is excluded by the
                                  folder, not by its name.

   An earlier version of this test said the behaviour could not be reached from here, because the
   DOM shim ignores listeners so simulated typing does nothing, and asserted on the page source
   instead. That was true about typing and wrong about the state: the folder and the query live in
   top-level variables, and the harness can set them. Review asked whether I had missed a way in,
   and I had. */

const memoryVault = {
  ...base,
  memory: {
    files: [
      { path: 'shared/business-brain.md', size: 2348 },
      { path: 'shared/about-me.md', size: 805 },
      { path: 'agents/sales/README.md', size: 400 },
      { path: 'agents/editor/README.md', size: 400 }
    ],
    indexes: [],
    truncated: false
  }
}
const emptyStateFor = (state, payload = memoryVault) =>
  render(payload, { state })
    .get('memory')
    .innerHTML.replace(/<[^>]*>/g, ' ')
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;/g, '-')
    .replace(/\s+/g, ' ')
    .trim()

test('a folder button narrowing the list never becomes a claim about the whole vault', () => {
  // The exact case review found. "brain" is in shared/business-brain.md; the agents folder is what
  // hides it, and the old wording said no page name contained it at all.
  const said = emptyStateFor({ memorySource: 'agents', memoryQuery: 'brain' })
  assert.match(said, /No page name in agents\/ contains "brain"/)
  assert.match(said, /1 elsewhere in your vault does/, 'it does not say the page is findable')
  assert.ok(!said.includes('No page NAME contains'), 'it still claims something about the whole vault')
})

test('the count of pages hiding behind the folder filter is right, and reads as English', () => {
  const one = emptyStateFor({ memorySource: 'agents', memoryQuery: 'brain' })
  assert.match(one, /1 elsewhere in your vault does - tap all above to see it/)
  // Two matches, both outside the chosen folder, so the sentence has to count and pluralise. The
  // first term tried here was "me", which quietly matched agents/sales/README.md - so the list was
  // never empty and the test was checking nothing.
  const two = emptyStateFor(
    { memorySource: 'agents', memoryQuery: 'about' },
    { ...memoryVault, memory: { ...memoryVault.memory, files: [
      { path: 'shared/about-me.md', size: 1 },
      { path: 'shared/about-us.md', size: 1 },
      { path: 'agents/sales/notes.md', size: 1 }
    ] } }
  )
  assert.match(two, /2 elsewhere in your vault do - tap all above to see them/)
})

test('a word in no page name anywhere says so, with the folder named as well', () => {
  const said = emptyStateFor({ memorySource: 'agents', memoryQuery: 'zzzzz' })
  assert.match(said, /No page name contains "zzzzz", in agents\/ or anywhere else/)
  assert.match(said, /searches page names, not the words written inside them/)
  assert.ok(!said.includes('elsewhere in your vault'), 'it offered pages that do not exist')
})

test('a word inside a page, with no folder chosen, is told the difference', () => {
  const said = emptyStateFor({ memoryQuery: 'roofing' })
  assert.match(said, /No page NAME contains "roofing"/)
  assert.match(said, /searches page names, not the words written inside them/)
  assert.ok(!said.includes('in agents/'), 'it named a folder nobody selected')
})

test('every folder button has files behind it, so choosing one always shows something', () => {
  // This is why there is no "nothing in this folder" message: the chips are built from the file
  // list itself, so a chip cannot exist for an empty folder and nothing else sets the filter. I had
  // written that message and a test for it, and review found the test could only reach it by handing
  // the render a folder no chip would ever have offered - dead code, documented as a live screen.
  // Pinning the invariant is the honest version: if chips ever stop being derived from the files,
  // this fails and the missing message becomes a real gap rather than a silent one.
  const drawn = render(memoryVault).get('memory').innerHTML
  const chips = [...drawn.matchAll(/data-source="([^"]*)"/g)].map((m) => m[1])
  assert.ok(chips.includes(''), 'the "all" chip is gone')
  const tops = new Set(memoryVault.memory.files.map((f) => (f.path.includes('/') ? f.path.slice(0, f.path.indexOf('/')) : '(root)')))
  assert.deepEqual(
    chips.filter(Boolean).sort(),
    [...tops].sort(),
    'a folder button exists that no file lives in, or a folder has no button'
  )
})

test('an empty vault says so plainly, with no search term to quote', () => {
  const emptyVault = emptyStateFor({}, { ...memoryVault, memory: { files: [], indexes: [], truncated: false } })
  assert.match(emptyVault, /No pages match\./)
  assert.ok(!emptyVault.includes('NAME'), 'it quoted a search term nobody typed')
})

test('the search term is escaped where it is quoted back', () => {
  const said = render(memoryVault, { state: { memoryQuery: '<script>alert(1)</script>' } })
    .get('memory').innerHTML
  assert.ok(!said.includes('<script>alert(1)'), 'the search box is an injection point')
  assert.ok(said.includes('&lt;script&gt;'), 'the term was dropped rather than escaped')
})

/* THE CONNECTIONS SCREEN HAS TWO HALVES, and an empty half used to take its subject off the screen.

   `runtimes: []` is what agent-team-template SHIPS, so a student with one connection and no machine
   registered - every student on day one - read a screen that never mentioned machines at all. They
   could not tell whether the board does not track them or they simply have none. The employee test
   repo says why it is empty in the file itself: "I work on their laptop and I am not putting a
   machine of my own on their network."

   The empty state has to say the absence is FINE, because the neighbouring screens are busy telling
   him nothing has run. runtimes.yml calls a runtime "anything with a URL that you want one tap away
   from your dashboard" - a shortcut tile, not an engine. */

const aRuntime = (over = {}) => ({
  name: 'Studio box', kind: 'agent-runtime', status: 'live',
  lastBeat: new Date().toISOString(), url: 'http://example.invalid:8080', ...over
})
const connectionsScreen = (payload) => render({ ...base, ...payload }).get('connections').innerHTML

test('both halves are named even when one of them is empty', () => {
  const drawn = connectionsScreen({ connections: [connection({ name: 'GitHub' })], runtimes: [] })
  assert.match(drawn, /Runtimes/, 'a student with no machine never learns the board tracks them')
  assert.match(drawn, /No machines listed, which is normal/)
  // The empty state must name what an entry here DOES do, and not more than that. The first version
  // said "nothing runs or stops running because of what is in it", which is true about running and
  // reads as "this list has no consequences" - and one entry flips the Access rung on Today.
  // Sentences wrap in the markup, so match across the break rather than pinning the layout.
  assert.match(drawn, /Nothing here makes a job run/, 'it does not say what an entry cannot do')
  assert.match(drawn, /Access<\/b> step on Today/, 'it hides the one thing an entry here does change')
  // And claims NO substitute for it. The version that said "which a proved connection above also
  // satisfies" was reading the heuristic branch of shapeSetup, which a student who has run /onboard
  // never reaches - there Access is the onboarding record and nothing else.
  assert.ok(
    !/proved connection above also/.test(drawn),
    'it claims a proved connection satisfies Access, which is false once /onboard has run'
  )
  assert.ok(
    !/Nothing runs or stops running/.test(drawn),
    'the sentence claiming this list has no consequences is back'
  )
  assert.match(drawn, /Connections/, 'the half that does have rows lost its heading')
  assert.match(drawn, /GitHub/)
})

test('a runtime with no connections still gets told what is missing', () => {
  const drawn = connectionsScreen({ connections: [], runtimes: [aRuntime()] })
  assert.match(drawn, /Nothing connected yet/)
  assert.match(drawn, /Studio box/)
  assert.ok(!drawn.includes('No machines listed'), 'it said there are no machines while listing one')
})

test('neither half present keeps the one message that covers the whole screen', () => {
  const drawn = connectionsScreen({ connections: [], runtimes: [] })
  assert.match(drawn, /Nothing connected yet/)
  // Day zero should not carry two empty states arguing with each other.
  assert.ok(!drawn.includes('No machines listed'), 'day one shows two empty panels instead of one')
})

test('a real runtime is still drawn with its state and its last heartbeat', () => {
  const drawn = connectionsScreen({ connections: [connection({ name: 'GitHub' })], runtimes: [aRuntime({ status: 'silent', lastBeat: '2026-08-31T09:00:00Z' })] })
  assert.match(drawn, /Studio box/)
  assert.match(drawn, /heartbeat/)
  assert.ok(!drawn.includes('No machines listed'), 'a listed machine was reported as missing')
})

/* ---------- Add skill, and add an agent ---------------------------------------------------
 *
 * The last two of the five asks. Both are the same shape as "+ Add task": a sentence goes to
 * /api/fire, a session writes the file, this page writes nothing.
 *
 * These render the screens rather than grepping the source, because the defect this project
 * keeps hitting is a control that exists in the markup and cannot be reached on the screen.
 */

const agent = (over = {}) => ({
  slug: 'research', description: 'Looks something up.', model: 'sonnet',
  lastRun: null, lastStatus: null, runsThisWeek: 0, totalRuns: 0, state: 'never-run', ...over
})

const withSkills = (over = {}) => ({
  ...base,
  skills: [{ slug: 'draft-replies', path: '.claude/skills/draft-replies/SKILL.md', description: 'Drafts replies.', usedBy: [], stalled: [], stalledOwners: [] }],
  ...over
})

test('the Skills screen offers a way to add one', () => {
  const drawn = render(withSkills()).get('skills').innerHTML
  assert.ok(drawn.includes('Add skill'), 'the Skills screen has no Add skill button')
  assert.match(drawn, /id="skill-open"/, 'the Add skill button has no id to bind a handler to')
  assert.match(drawn, /id="skill-form"/, 'there is no form behind the Add skill button')
})

test('the Team screen offers a way to add an agent', () => {
  const drawn = render({ ...base, agents: [agent()], runs: [] }).get('team').innerHTML
  assert.ok(drawn.includes('Add agent'), 'the Team screen has no Add agent button')
  assert.match(drawn, /id="agent-open"/)
  assert.match(drawn, /id="agent-form"/)
})

/* The empty state is the one that matters most and is the easiest to forget. Somebody with no
   skills and no agents is exactly the person who wants to add one, and on the old screens the
   empty state was a paragraph telling them to go and run a command somewhere else. Both empty
   states replaced their whole innerHTML, so a button appended after the list would vanish. */

test('the add buttons survive the empty state, where they are needed most', () => {
  const skills = render({ ...base, skills: [] }).get('skills').innerHTML
  assert.ok(skills.includes('Add skill'),
    'a repo with no skills is exactly when somebody wants to add one, and the button is gone')
  const team = render({ ...base, agents: [] }).get('team').innerHTML
  assert.ok(team.includes('Add agent'),
    'a repo with no agents is exactly when somebody wants to add one, and the button is gone')
})

/* Both forms promise something this board cannot see happen, so the wording is checked rather
   than left to taste - the same rule the Start/Done buttons are held to. Two things have to be
   said: it lands in about a minute, and it is written from a guess that the owner gets to read.
   The whole design rests on the review card; a form that does not mention it is asking somebody
   to trust an unattended session with nothing said out loud. */

for (const [kind, noun] of [['skill', 'skill'], ['agent', 'agent']]) {
  test(`the Add ${noun} form says when it lands and that it comes back to be checked`, () => {
    const screen = kind === 'skill' ? 'skills' : 'team'
    const payload = kind === 'skill' ? withSkills() : { ...base, agents: [agent()], runs: [] }
    const drawn = render(payload).get(screen).innerHTML
    const form = drawn.split(`id="${kind}-form"`)[1] ?? ''
    assert.ok(form, `the ${kind} form did not render`)
    assert.match(form, /minute/i, 'it never says roughly how long the change takes to land')
    assert.ok(/check|review|guess/i.test(form),
      'it never says the file is written from a guess that comes back for the owner to check')
  })

  test(`the Add ${noun} form does not promise it will be switched on`, () => {
    const screen = kind === 'skill' ? 'skills' : 'team'
    const payload = kind === 'skill' ? withSkills() : { ...base, agents: [agent()], runs: [] }
    const form = (render(payload).get(screen).innerHTML.split(`id="${kind}-form"`)[1] ?? '')
    // Without this the assertion below passes on an empty string, which is how a test for a
    // control that does not exist yet reports green.
    assert.ok(form, `the ${kind} form did not render`)
    assert.doesNotMatch(form, /schedul|armed|starts running|runs every/i,
      'nothing here is armed or scheduled, and a form that implies otherwise manufactures the one state this course exists to stop')
  })
}

/* The placeholder is the single most-read piece of copy on a board, and the employee walkthrough
   found that the Add-task one assumed the reader had customers. Half the people this is built for
   have a job. Both new placeholders get the same rule. */

test('neither placeholder assumes the reader owns a business', () => {
  const skills = render(withSkills()).get('skills').innerHTML
  const team = render({ ...base, agents: [agent()], runs: [] }).get('team').innerHTML
  for (const [where, drawn] of [['skills', skills], ['team', team]]) {
    for (const placeholder of [...drawn.matchAll(/placeholder="([^"]*)"/g)].map((m) => m[1])) {
      assert.doesNotMatch(placeholder, /\bclients?\b|\bcustomers?\b|\brevenue\b|\bsales\b/i,
        `the ${where} placeholder assumes the reader has customers: "${placeholder}"`)
    }
  }
})

/* The first version of this grepped the source for `action: 'skill'` - a literal the code never
   contains, because one submit path posts `action: kind` for both. The test was wrong and the
   code was right, which is its own warning: a source grep tests the spelling of an implementation,
   not what it does. This checks the two things that actually matter - that the kinds offered are
   exactly the two the endpoint accepts, and that the kind is what gets posted as the action. */

test('the two creations post their own action, not a task card', () => {
  const declared = /const CREATE_FORMS = \{([\s\S]*?)\n\}/.exec(script)
  assert.ok(declared, 'the page no longer declares which creations it offers')
  const kinds = [...declared[1].matchAll(/^  ([a-z]+): \{/gm)].map((m) => m[1])
  assert.deepEqual(kinds, ['skill', 'agent'],
    'the page offers creations the fire endpoint does not accept, or has lost one it does')
  const submit = script.split('async function submitCreation')[1] ?? ''
  assert.ok(submit, 'there is no submitCreation on the page')
  assert.match(submit, /action: kind/,
    'the form posts something other than the kind as its action, so Add skill and Add agent cannot both be right')
  assert.doesNotMatch(submit.split('async function')[0], /action: 'task'/,
    'a creation is being smuggled through as a task card, which skips /new-skill and /new-agent entirely')
})

/* ---------- the stylesheet, which nothing here could see ---------------------------------
 *
 * Add skill and Add agent shipped with NO matching CSS. Every rule styling an inline form was
 * written against the literal id `#task-form`, the new forms are `#skill-form` and
 * `#agent-form`, and the textarea rendered as a bare browser default on a dark page - on the
 * phone and the desktop alike. A reject-reviewer found it by reading, because no test could:
 * the render harness above pulls out the page's inline script and never reads the stylesheet.
 *
 * That blind spot is the actual defect. A form the page draws and the stylesheet has never
 * heard of is a whole class of bug, and it is checkable without a browser.
 */

const styles = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? ''

/* Reading the stylesheet as one string was not enough, and both ways it failed were found by
   mutation in review.

   Substring-searching it counts COMMENT PROSE as a rule. The comment explaining this very
   refactor names `#task-form` and `#wf-form` in a sentence, so `styles.includes('#task-form')`
   was true whether or not any rule targeted it - and stripping the shared class off the live
   Add-task form, the one on the default screen that people use every day, left the suite green
   while reintroducing the exact bug this block exists to stop.

   And a selector that exists proves nothing about what it does. Emptying the body of
   `.fire-form textarea` - deleting every property that stops a bare browser-default textarea on
   a dark page - also left it green.

   So: comments go, and the sheet is read as rules with bodies. */

// Reusing the parser the cascade tests already built rather than adding a second one — it strips
// comments and understands media queries, and two CSS parsers in one file is how they diverge.
//
// UNCONDITIONAL rules only, and that word is the whole point. This page is phone-first: every
// desktop rule lives inside `@media (min-width: 48rem)`, so a rule that exists only in there does
// not exist on a phone at all. Counting one would let an entire fix be gated to desktop with the
// suite staying green — found by mutation in review, twice, against both of the last commit's own
// fixes. A laptop would have looked right and every phone would have carried the bug back.
//
// A token matches wherever it appears in a selector, not only at the front: `.fire` is written as
// `button.fire`, and a matcher anchored to the start reported that nothing styles the button
// behind every action on this board. What it must not do is match a longer name — `.fire` is not
// `.fire-form` — so whatever follows the token has to be something that ends a name.
const NAME_CHAR = /[A-Za-z0-9_-]/

const rulesFor = (token, { desktop = false } = {}) => cssRules().filter((rule) =>
  Boolean(rule.inMedia) === desktop &&
  rule.selector.split(',').map((one) => one.trim()).some((selector) => {
    let from = selector.indexOf(token)
    while (from !== -1) {
      const after = selector[from + token.length]
      if (after === undefined || !NAME_CHAR.test(after)) return true
      from = selector.indexOf(token, from + 1)
    }
    return false
  }))

const declarationsIn = (rule) =>
  rule.body.split(';').map((one) => one.split(':')[0].trim()).filter(Boolean)

test('the page has a stylesheet these tests can actually read', () => {
  assert.ok(styles.length > 500, 'no stylesheet was found, so every check below would pass on nothing')
})

/* The guard on the guard. If comment-stripping ever breaks, every check below quietly stops
   meaning anything, and something has to say so in its own name rather than leaving the fallout
   to be noticed elsewhere.

   The first version of this asked whether `#task-form` — a name that appears only in a comment —
   resolved to zero rules. Review proved it decorative: with stripping off, a comment and the
   selector after it are read as one head, so the head starts with the comment and never with
   `#task-form`, and the check passed either way. This asks the direct question instead — no
   selector the parser hands back may contain comment syntax. */

test('the stylesheet is read as rules, not as text that happens to contain a selector', () => {
  assert.ok(/#task-form/.test(styles),
    'the comment naming #task-form is gone - this check needs updating')
  const leaking = cssRules().filter((rule) => /\/\*|\*\//.test(rule.selector))
  assert.deepEqual(leaking.map((rule) => rule.selector), [],
    'a parsed selector contains comment syntax, so comments are leaking into the rules and every check below is reading prose')
})

test('every form the page draws is covered by the stylesheet', () => {
  // Every `id="…-form"` the script emits, including the one built from a template placeholder.
  const ids = new Set()
  for (const found of script.matchAll(/<form id="([a-z-]*)\$\{kind\}-form"/g)) {
    for (const kind of Object.keys({ skill: 1, agent: 1 })) ids.add(`${found[1]}${kind}-form`)
  }
  for (const found of script.matchAll(/<form id="([a-z-]+)"/g)) ids.add(found[1])

  assert.ok(ids.size >= 3, `only found ${ids.size} forms on the page - the sweep is not finding them`)
})

test('every form the page draws is styled by a real rule, not by prose', () => {
  // Every form in the file, template placeholder included. Each is styled by a rule of its own -
  // the unlock form has one - or by carrying the shared class. Nothing else counts.
  const forms = [...html.matchAll(/<form id="([^"]+)"([^>]*)>/g)]
  assert.ok(forms.length >= 4, `the form sweep found ${forms.length} forms - it is not finding them`)
  for (const [, id, attributes] of forms) {
    if (/class="[^"]*\bfire-form\b/.test(attributes)) continue
    const own = rulesFor(`#${id}`)
    assert.ok(own.length,
      `the ${id} form neither carries the shared class nor has a rule of its own - it will render as a browser default on a dark page`)
    assert.ok(own.some((rule) => declarationsIn(rule).length),
      `every rule for #${id} has an empty body, so nothing is actually styled`)
  }
})

/* A selector that exists and a selector that does something are different claims. These name the
   properties whose ABSENCE was the shipped bug: a textarea with no width, no background and no
   border is the bare browser default this whole commit exists to stop. */

test('the shared form rules carry the properties that stop a bare browser default', () => {
  const declaredBy = (token) => new Set(rulesFor(token).flatMap(declarationsIn))

  const layout = declaredBy('.fire-form')
  for (const property of ['display', 'gap']) {
    assert.ok(layout.has(property),
      `.fire-form declares no ${property}, so every inline form on the page loses its layout`)
  }

  const field = declaredBy('.fire-form textarea')
  for (const property of ['width', 'background', 'border', 'color', 'padding']) {
    assert.ok(field.has(property),
      `nothing declares ${property} for a .fire-form textarea - that is the bare browser default on a dark page, which is the bug this exists to stop`)
  }

  assert.ok(declaredBy('.fire-form label').has('color'), 'the form label lost its colour')
  assert.ok(declaredBy('.fire-form[hidden]').has('display'),
    'a hidden form no longer hides, so both forms are open on every load')
})

/* The new forms sit on Skills and Team as siblings of the panels rather than inside one, and
   `.add-task` declares no background of its own - on Today it inherits the board column's card.
   Without a wrapper they float on the bare page background while everything around them sits on
   a card. Checked on the rendered screen, not the source. */

test('the add forms render inside a panel on the two screens that have no column to sit in', () => {
  for (const [screen, payload] of [
    ['skills', { ...base, skills: [] }],
    ['team', { ...base, agents: [] }]
  ]) {
    const drawn = render(payload).get(screen).innerHTML
    const opening = drawn.slice(0, drawn.indexOf('add-task'))
    assert.match(opening, /class="panel /,
      `the add form on ${screen} is not inside a panel, so it renders on the bare page background`)
  }
})

/* Two layout details a reviewer found by reading the box model, neither visible to any test
   before this one. `.add-task` carries a bottom border to separate it from the cards under it in
   a board column; as the only child of its own panel that border sits directly on the panel's own
   bottom border. And `.panel` declares no margin - the .6rem between panels comes from
   `.stack > .panel`, which the Team screen has no wrapper for - so the add form and the agents
   list would render flush, borders touching, reading as one card with a seam. */

test('the add form panel is spaced from what follows it and does not double its own border', () => {
  const drawn = render({ ...base, agents: [] }).get('team').innerHTML
  assert.match(drawn, /class="panel add-panel"/,
    'the add form panel has no class of its own, so nothing can space it without also changing Today')
  const spacing = new Set(rulesFor('.add-panel').flatMap(declarationsIn))
  assert.ok(spacing.has('margin-bottom'),
    'nothing spaces the add form from the panel below it - .panel has no margin of its own, and Team has no .stack wrapper')
  const inner = rulesFor('.add-panel .add-task')
  assert.ok(inner.length && inner.flatMap(declarationsIn).includes('border-bottom'),
    'the add-task bottom border is not cancelled inside its own panel, so it doubles up with the panel border')
})

/* Design rule two - nothing is armed or scheduled by a tap - is the most load-bearing rule in
   this feature, and its one piece of user-facing copy could be deleted with the suite staying
   green: the test beside this one only refuses forbidden words, it never required the promise to
   be made. Found by mutation, in review. */

test('both add forms say plainly that nothing gets switched on', () => {
  for (const [kind, screen, payload] of [
    ['skill', 'skills', { ...base, skills: [] }],
    ['agent', 'team', { ...base, agents: [] }]
  ]) {
    const drawn = render(payload).get(screen).innerHTML.split(`id="${kind}-form"`)[1] ?? ''
    assert.ok(drawn, `the ${kind} form did not render`)
    // Collapsed first: this copy wraps onto a second line in the source, and a check that reads
    // one line at a time is blind to half of what it claims to watch - the exact hole the voice
    // pass found in its own instruments.
    const form = drawn.replace(/\s+/g, ' ')
    assert.match(form, /[Nn]othing is switched on|[Nn]othing is armed/,
      `the ${kind} form never promises that nothing gets switched on, which is the one reassurance this whole design rests on`)
  }
})

/* The same defect class as everything above, found once more and this time on the rule with the
   widest reach in the whole app. Emptying `.panel { }` - background, border, radius, the three
   properties that make every card on every screen look like a card - left the suite green. The
   only test naming `.panel` at all matched a class STRING in the markup, which says nothing about
   whether the class does anything.

   So these name the properties whose absence would be visible, for the handful of classes the
   board's controls are actually built out of. Not every class in the sheet - a list nobody
   maintains is worse than none - just the ones a dispatch control cannot look right without. */

const VISIBLE_RULES = {
  '.panel': ['background', 'border'],
  '.add-task': ['padding'],
  '.fire': ['background', 'color'],
  '.fire-note': ['font-size'],
  '.fire-form .row': ['flex-wrap'],
  '.fire-form select': ['flex']
}

for (const [selector, properties] of Object.entries(VISIBLE_RULES)) {
  test(`${selector} is a rule that does something, not just a class name in the markup`, () => {
    const rules = rulesFor(selector)
    assert.ok(rules.length, `nothing in the stylesheet targets ${selector} outside a media query`)
    const declared = new Set(rules.flatMap(declarationsIn))
    for (const property of properties) {
      assert.ok(declared.has(property),
        `${selector} declares no ${property} - the class is in the markup and does nothing there`)
    }
  })
}

/* Every class the board's own controls put in the markup has to be one the stylesheet knows.
   This is the general form of the two defects that shipped: a class string is free to write and
   proves nothing. Only the classes these controls emit - the sweep stays narrow on purpose. */

test('every class the add forms emit is one the stylesheet actually styles', () => {
  const emitted = new Set()
  for (const source of [
    script.split('function createFormHtml')[1]?.split('\n}')[0] ?? '',
    script.split('function addTaskHtml')[1]?.split('\n}')[0] ?? ''
  ]) {
    assert.ok(source, 'one of the two form builders is gone')
    for (const found of source.matchAll(/class="([a-z0-9 -]+)"/g)) {
      for (const name of found[1].split(/\s+/).filter(Boolean)) emitted.add(name)
    }
  }
  assert.ok(emitted.size >= 5, `only found ${emitted.size} classes on the forms - the sweep is not reading them`)
  for (const name of emitted) {
    assert.ok(rulesFor(`.${name}`).length || rulesFor(`.${name}`, { desktop: true }).length,
      `the forms put class "${name}" in the markup and no rule anywhere targets it`)
  }
})

/* The defect the tests could not see, found by looking at the screen: on a wide window the add
   forms were a stretched phone layout - a 1225px textarea for one sentence, the explanation on
   one long line, and a 1225px submit button. 588 tests passed and four separate reads of the
   stylesheet went past it.

   This is the mirror of every other check in this block, and the reason `rulesFor` takes a
   `desktop` option rather than just dropping media rules. The measure cap MUST be inside the
   desktop query: applied unconditionally it would put a 34rem ceiling on the phone form, which
   is 327px wide and needs every pixel. So it is asserted present on desktop and absent
   everywhere else. */

test('the add forms keep a readable measure on a wide screen', () => {
  const capped = rulesFor('.add-panel .fire-form', { desktop: true })
  assert.ok(capped.length,
    'nothing caps the add form width on desktop, so it stretches the full content column - a 1225px box for one sentence')
  assert.ok(capped.flatMap(declarationsIn).includes('max-width'),
    'the desktop rule for the add form declares no max-width, which is the whole point of it')

  assert.deepEqual(rulesFor('.add-panel .fire-form').map((rule) => rule.selector), [],
    'the desktop measure cap is written unconditionally, so it also squeezes the phone form - which is 327px wide and needs all of it')
})

test('the submit button stops being full width on a wide screen', () => {
  const button = rulesFor('.add-panel .fire-form .fire', { desktop: true })
  assert.ok(button.length, 'nothing stops the submit button stretching the whole form on desktop')
  assert.ok(button.flatMap(declarationsIn).some((property) => property.startsWith('justify')),
    'the desktop rule does not release the button from the grid stretch, so it is as wide as the textarea')
})

/* A media query adds no specificity, so an override placed above the rule it overrides is dead
   code that reads as correct. This repo shipped exactly that once. The cap has to come after the
   unconditional .fire-form rules it narrows. */

test('the desktop measure cap comes after the rule it overrides', () => {
  const [cap] = rulesFor('.add-panel .fire-form', { desktop: true })
  const base = rulesFor('.fire-form').filter((rule) => rule.selector === '.fire-form')
  assert.ok(cap && base.length, 'one of the two rules is missing')
  assert.ok(cap.at > base[0].at,
    'the desktop cap is written above the .fire-form rule it narrows - a media query adds no specificity, so it never reaches a pixel')
})

/* ---------- Light or dark ----------------------------------------------------------------------
   The choice is the person's, the default is their phone's, and storage is allowed to fail. The
   stylesheet half of this - the tokens, the contrast, the two light blocks agreeing - is in
   tests/theme.test.mjs. This half draws the page and reads what the theme code actually did to it:
   the attribute on <html> that picks a token block, and aria-checked on the switch, which is what
   a screen reader announces and what the switch's own drawing keys off. */

const LIGHT_PHONE = { '(prefers-color-scheme: light)': true }

// A storage stub that holds one theme choice and records every write.
const themeStorage = (stored) => {
  const writes = []
  return {
    writes,
    getItem: (key) => (/theme/.test(key) ? stored : null),
    setItem: (key, value) => { writes.push([key, value]) },
    removeItem: (key) => { writes.push([key, null]) }
  }
}

test('a stored theme choice wins over the phone setting', () => {
  const light = render(base, { storage: themeStorage('light') })
  assert.equal(light.get('html').dataset.theme, 'light', 'a stored light choice was not applied on a dark phone')
  assert.equal(light.get('theme-switch').attributes['aria-checked'], 'true')

  const dark = render(base, { storage: themeStorage('dark'), media: LIGHT_PHONE })
  assert.equal(dark.get('html').dataset.theme, 'dark', 'a stored dark choice lost to a light phone')
  assert.equal(dark.get('theme-switch').attributes['aria-checked'], 'false')
})

test('with no stored choice the page follows the phone and stores nothing', () => {
  for (const [media, checked] of [[LIGHT_PHONE, 'true'], [{}, 'false']]) {
    // A value nobody could have chosen counts as no choice, rather than as a theme with no tokens.
    for (const stored of [null, 'purple']) {
      const storage = themeStorage(stored)
      const nodes = render(base, { storage, media })
      // No attribute at all, so the stylesheet's own prefers-color-scheme block decides - and keeps
      // deciding if the phone flips to dark at sunset.
      assert.equal('theme' in nodes.get('html').dataset, false,
        `with ${stored ?? 'nothing'} stored the page pinned a theme instead of following the phone`)
      assert.equal(nodes.get('theme-switch').attributes['aria-checked'], checked,
        'the switch does not show the theme the phone is actually in')
      assert.deepEqual(storage.writes, [], 'loading the page wrote a theme nobody chose')
    }
  }
})

test('pressing the switch flips the theme and remembers the choice', () => {
  const storage = themeStorage(null)
  const nodes = render(base, { storage })
  const press = () => nodes.get('theme-switch').listeners.click.forEach((handler) => handler({}))
  assert.equal(nodes.get('theme-switch').listeners.click?.length, 1, 'nothing listens for a press on the switch')

  press()
  assert.equal(nodes.get('html').dataset.theme, 'light')
  assert.equal(nodes.get('theme-switch').attributes['aria-checked'], 'true')
  assert.deepEqual(storage.writes.at(-1)?.[1], 'light', 'the choice was not stored, so it is gone on the next visit')

  press()
  assert.equal(nodes.get('html').dataset.theme, 'dark')
  assert.equal(nodes.get('theme-switch').attributes['aria-checked'], 'false')
  assert.deepEqual(storage.writes.at(-1)?.[1], 'dark')
})

test('storage that throws on every call breaks nothing - the page draws and the switch still works', async () => {
  const refuse = () => { throw new Error('SecurityError: storage is blocked') }
  const nodes = render(base, { storage: { getItem: refuse, setItem: refuse, removeItem: refuse }, media: LIGHT_PHONE })
  assert.ok(nodes.get('today').innerHTML.length > 0, 'the page did not draw')
  assert.equal('theme' in nodes.get('html').dataset, false)
  assert.equal(nodes.get('theme-switch').attributes['aria-checked'], 'true', 'the switch lost track of the phone setting')

  // The choice cannot be kept, but it still has to happen for this visit.
  nodes.get('theme-switch').listeners.click.forEach((handler) => handler({}))
  assert.equal(nodes.get('html').dataset.theme, 'dark', 'pressing the switch did nothing because storage refused the write')

  // boot() reads the view key on its way to the first fetch. Let it run: a bare localStorage call
  // there is a rejected promise and a page that never loads, and this is where it would surface.
  await new Promise((resolve) => setTimeout(resolve, 10))
})

test('an owner chip takes its colour from the theme, not from a hex written into it', () => {
  // The chip used to carry style="color:#…;border:1px solid #…": a dark-theme hue with nothing a
  // light theme could reach. Now it hands the stylesheet the agent's hue and the stylesheet decides
  // how to draw it - see the contrast check for every palette hue in tests/theme.test.mjs.
  const drawn = render({ ...base, workflows: [workflow({ owner: 'research' })] }, { hash: '#workflows' }).get('workflows').innerHTML
  const chip = /<span class="chip owner" style="([^"]*)">owner: research<\/span>/.exec(drawn)
  assert.ok(chip, 'the owner chip is missing or lost its class')
  assert.match(chip[1], /^--agent:#[0-9a-f]{6}$/, `the owner chip sets more than its agent hue: ${chip[1]}`)
})

/* ---------- The shell: sidebar, phone tabs, top bar ---------------------------------------------
   v2 gives a wide screen a sidebar - the board's name and line, a picture that says what is going
   on, and whose board it is - and puts a bar along the top holding the two things somebody comes
   here to do. On a phone the nav stays the two rows of tabs across the top: screens first, and a
   drawer is a menu you have to open before you can see anything. So half of what these check is
   what must NOT reach a phone, and "unconditional" is the word that carries it: a rule inside the
   desktop query does not exist on a phone at all. */

const tabsMarkup = () => html.split('<div class="tabs">')[1].split('</div>')[0]

const valuesIn = (rule) => Object.fromEntries(rule.body.split(';')
  .map((part) => part.trim()).filter(Boolean)
  .map((part) => [part.slice(0, part.indexOf(':')).trim(), part.slice(part.indexOf(':') + 1).trim()]))

// Rules whose selector list holds exactly this selector: `.profile` is not `.profile .who`.
const exactRules = (selector) => cssRules().filter((rule) =>
  rule.selector.split(',').map((one) => one.trim()).includes(selector))

const WIDE = /min-width:\s*48rem/
const TAB_LABEL = { today: 'Today', ledger: 'Ledger', team: 'Team', workflows: 'Workflows', skills: 'Skills', memory: 'Memory', connections: 'Connections' }

test('every tab is a drawn icon and its name - no character from a font standing in for a picture', () => {
  // The glyphs were whatever the phone's font made of &#9881; and &#9673; - a gear on one phone, an
  // emoji on the next, a box on a third.
  const links = [...tabsMarkup().matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)]
    .map(([, attributes, inside]) => ({ screen: /data-screen="([a-z]+)"/.exec(attributes)?.[1], inside }))
  assert.deepEqual(links.map((link) => link.screen), SCREENS, 'the tabs are not one per screen, in nav order')
  for (const { screen, inside } of links) {
    const icon = /<svg\b([^>]*)>([\s\S]*?)<\/svg>/.exec(inside)
    assert.ok(icon, `the ${screen} tab has no drawn icon`)
    assert.match(icon[1], /\bclass="ico"/, `the ${screen} icon is not an .ico, so nothing sizes it`)
    assert.match(icon[1], /\baria-hidden="true"/, `the ${screen} icon would be announced as an unlabelled picture before its name`)
    assert.match(icon[2], /<(path|circle|rect|polyline|line)\b/, `the ${screen} icon draws nothing`)
    assert.ok(!/&#\d+;|class="glyph"/.test(inside), `the ${screen} tab still carries a font glyph`)
    const words = inside.replace(/<svg[\s\S]*?<\/svg>/, '').replace(/<[^>]+>/g, '').trim()
    assert.equal(words, TAB_LABEL[screen], `the ${screen} tab does not say its own name`)
  }
  // An svg with no size is drawn 300 by 150. Seven of those would be the whole nav.
  const sized = exactRules('.ico').filter((rule) => !rule.inMedia).map(valuesIn)
  assert.ok(sized.some((rule) => rule.width && rule.height),
    'nothing gives .ico a width and a height, so every icon renders at the browser default 300x150')
})

test('the tabs count what the payload holds, and a zero is left blank rather than printed', () => {
  const full = render({
    ...base,
    agents: [agent({ slug: 'research' }), agent({ slug: 'email' }), agent({ slug: 'sales' })],
    workflows: [workflow(), workflow({ slug: 'second', name: 'Second' })],
    skills: [{ slug: 'draft-replies', path: '.claude/skills/draft-replies/SKILL.md', description: 'Drafts replies.', usedBy: [], stalled: [], stalledOwners: [] }],
    memory: { files: ['a', 'b', 'c', 'd'].map((name) => ({ path: `shared/${name}.md`, size: 10 })), indexes: [], truncated: false },
    connections: [connection()],
    runtimes: [runtime(), runtime({ name: 'Other box' })]
  })
  // Connections counts both halves of its screen: the tools in the register and the machines.
  const expected = { today: '', ledger: '', team: '3', workflows: '2', skills: '1', memory: '4', connections: '3' }
  for (const [screen, count] of Object.entries(expected)) {
    assert.equal(String(full.get(`count-${screen}`).textContent), count, `the ${screen} tab counts the wrong thing`)
  }
  // A "0" beside every tab on a new repo reads as seven things broken. Nothing is the honest count.
  const empty = render(base)
  for (const screen of SCREENS) {
    assert.equal(String(empty.get(`count-${screen}`).textContent), '', `the ${screen} tab printed a count for an empty repo`)
  }
})

test('the sidebar says whose board it is, with initials, and says nothing when the name is unknown', () => {
  const named = render({ ...base, owner: { name: 'Nuno Tavares' } })
  assert.equal(named.get('profile').hidden, false, 'a known owner is not shown')
  assert.equal(named.get('profile-name').textContent, 'Nuno Tavares')
  assert.equal(named.get('profile-initials').textContent, 'NT', 'the initials are not first and last name')
  assert.equal(render({ ...base, owner: { name: 'Jordan' } }).get('profile-initials').textContent, 'J')

  // No name in about-me: no placeholder person, no "?" in a circle.
  for (const owner of [null, undefined]) {
    const nodes = render({ ...base, owner })
    assert.equal(nodes.get('profile').hidden, true, `with owner ${owner} the profile is still on show`)
    assert.equal(String(nodes.get('profile-name').textContent), '', 'an unknown owner was given a name')
  }

  // The name is the owner's own text from their repo.
  const hostile = '<img src=x onerror=alert(1)>'
  const nodes = render({ ...base, owner: { name: hostile } })
  assert.equal(nodes.get('profile-name').textContent, hostile, 'the name was altered rather than shown as text')
  for (const [id, node] of nodes) {
    assert.ok(!String(node.innerHTML).includes('<img src=x'), `the owner name landed in #${id} as markup`)
  }
})

test('the sidebar picture says what is running and what is next, from the board', () => {
  const now = new Date().toISOString()
  const run = (name) => ({ name, agent: 'research', started_at: now, session_url: null })
  const next = [{ slug: 'morning-intel', name: 'Morning Intel', owner: 'research', when: new Date(Date.now() + 3 * 3600_000 + 60_000).toISOString() }]

  const busy = render({ ...base, board: boardWith({ running: [run('a'), run('b')], upNext: next }) }).get('side-art-caption').innerHTML
  assert.match(busy, /2 jobs running/)
  assert.match(busy, /Morning Intel/, 'the next job is not named')
  assert.match(busy, /in 3 hr/, 'the next job has no time')

  assert.match(render({ ...base, board: boardWith({ running: [run('a')] }) }).get('side-art-caption').innerHTML, /1 job running/)

  // An idle board says so, and names no next job it does not have.
  const idle = render(base).get('side-art-caption').innerHTML
  assert.match(idle, /Nothing running/)
  assert.ok(!/Next/.test(idle), 'an empty board was given a next job')

  const hostile = render({ ...base, board: boardWith({ upNext: [{ ...next[0], name: '<img src=x onerror=1>' }] }) }).get('side-art-caption').innerHTML
  assert.ok(!hostile.includes('<img src=x'), 'a job name from the repo was drawn as markup')
})

test('Run a job is offered only when a job can be run, and lands on the buttons without running anything', async () => {
  const none = render({ ...base, workflows: [workflow({ fire: false })] })
  assert.equal(none.get('jump-run').hidden, true, 'Run a job is offered with no job that has a run button')

  const pushed = []
  const requests = []
  const payload = { ...base, workflows: [workflow({ fire: true })] }
  const nodes = render(payload, {
    hash: '#team',
    history: { pushState: (state, title, url) => pushed.push(url) },
    fetch: async (url, init = {}) => {
      requests.push(`${init.method ?? 'GET'} ${url}`)
      return { ok: true, status: 200, json: async () => payload }
    }
  })
  assert.equal(nodes.get('jump-run').hidden, false, 'a runnable job is not offered from the top bar')
  assert.match(nodes.get('today').innerHTML, /id="run-jobs"/, 'the run buttons have nothing to land on')
  assert.equal(nodes.get('screen-title').textContent, 'Team')

  const handlers = nodes.get('jump-run').listeners.click ?? []
  assert.equal(handlers.length, 1, 'nothing listens for a press on Run a job')
  let cancelled = false
  handlers.forEach((handler) => handler({ preventDefault() { cancelled = true } }))
  assert.ok(cancelled, 'the link is followed as well, so the router redraws over the scroll')
  assert.deepEqual(pushed, ['#today'], 'Back does not return to the screen the jump started from')
  assert.equal(nodes.get('screen-title').textContent, 'Today', 'the jump did not change screen')
  assert.ok(nodes.get('run-jobs').scrolledIntoView, 'the jump did not scroll to the run buttons')

  // It takes you to the buttons. Pressing one is still yours to do.
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(requests.filter((request) => !request.startsWith('GET ')), [], 'Run a job sent a request that is not a read')

  // The fixed tab rows on a phone and the sticky bar on a laptop both sit over the top of the
  // page, so the landing spot has to leave room for them or it lands under them.
  assert.ok(exactRules('#run-jobs').filter((rule) => !rule.inMedia).some((rule) => valuesIn(rule)['scroll-margin-top']),
    'the run buttons land underneath the nav')
})

test('the hidden attribute hides, whatever display a rule gives the element', () => {
  // The profile, Run a job and the freshness dot are all laid out as flex and hidden with the
  // attribute. A class rule that sets display beats the browser's own [hidden] rule, so without
  // this the profile of nobody and a Run a job that leads nowhere would both be drawn.
  const rules = exactRules('[hidden]').filter((rule) => !rule.inMedia)
  assert.ok(rules.some((rule) => /^none\s*!important$/.test(valuesIn(rule).display ?? '')),
    'nothing makes [hidden] win over a class rule that sets display')
})

test('the brand, the picture and the profile are for a wide screen - a phone never draws them', () => {
  for (const selector of ['.brand', '.side-art', '.profile', '.nav-caption']) {
    const hide = exactRules(selector).filter((rule) => !rule.inMedia && valuesIn(rule).display === 'none')
    assert.ok(hide.length, `${selector} is not hidden unconditionally, so it lands in the phone's tab rows`)
    const show = exactRules(selector).filter((rule) => rule.inMedia && WIDE.test(rule.condition) &&
      valuesIn(rule).display && valuesIn(rule).display !== 'none')
    assert.ok(show.length, `${selector} never appears on a wide screen either`)
    assert.ok(show.every((rule) => rule.at > hide.at(-1).at),
      `${selector} is shown above the rule that hides it - a media query adds no specificity, so the hide wins everywhere`)
  }
  // The picture is the one thing in the sidebar that can be spared. On a 1366x640 laptop there is
  // not room for it and the profile both, and a sidebar that scrolls is a sidebar that hides a tab.
  const art = exactRules('.side-art').filter((rule) => rule.inMedia && valuesIn(rule).display && valuesIn(rule).display !== 'none')
  assert.ok(art.every((rule) => /min-height:\s*46rem/.test(rule.condition)),
    'the picture shows on a short laptop too, and pushes the profile off the bottom of the sidebar')
})

test('the sidebar picture only drifts for someone who has not asked for less motion', () => {
  const moving = cssRules().filter((rule) => /\.side-art\b/.test(rule.selector) &&
    Object.keys(valuesIn(rule)).some((name) => name === 'animation' || name.startsWith('animation-')))
  assert.ok(moving.length, 'nothing animates the picture any more - if the drift was dropped on purpose, drop this test with it')
  for (const rule of moving) {
    assert.match(rule.condition, /prefers-reduced-motion:\s*no-preference/,
      `${rule.selector} animates for someone whose phone asks for reduced motion`)
  }
})

/* The phone's tab rows, pinned as numbers. Review changed each of these in a copy of the page - 24px
   tabs, seven to a row, labels at 6px, the bar moved to the bottom - and the whole suite stayed
   green, because nothing here had ever asked what size a tab IS. These read what a phone gets:
   unconditional rules, the last one that says, with var() looked up in the unconditional :root. */

const remOf = (value) => Number(/^(\d*\.?\d+)rem$/.exec(value ?? '')?.[1] ?? NaN)
const phoneRuleSaying = (selectors, property) => cssRules().filter((rule) => !rule.inMedia &&
  rule.selector.split(',').map((one) => one.trim()).some((one) => selectors.includes(one)) &&
  valuesIn(rule)[property] !== undefined)
const phoneValue = (selectors, property) => {
  const last = phoneRuleSaying(selectors, property).at(-1)
  return last ? valuesIn(last)[property] : undefined
}
const phoneToken = (name) => phoneValue([':root'], name)
const withTokens = (value) => value?.replace(/var\((--[\w-]+)\)/g, (whole, name) => phoneToken(name) ?? whole)
const PHONE_TAB = ['nav a', 'nav .tabs > a']

test('a phone tab is as tall as a thumb needs', () => {
  const height = withTokens(phoneValue(PHONE_TAB, 'height'))
  assert.ok(remOf(height) >= 2.75, `a phone tab is ${height} tall - a thumb needs 2.75rem, 44px`)
})

test('a phone fits four tabs to a row, and the space kept for the nav is as tall as the rows that makes', () => {
  const basis = phoneValue(['nav .tabs > a'], 'flex-basis') ?? phoneValue(['nav .tabs > a'], 'flex')
  const share = Number(/(\d*\.?\d+)%/.exec(basis ?? '')?.[1])
  assert.equal(share, 25, `a phone tab takes "${basis}" of its row, not a quarter`)
  // Seven screens at four a row is two rows, and the page's top padding is built from --nav-h. If the
  // two disagree, a strip of every screen sits under the tabs - the bug this nav was rebuilt for.
  const rows = Math.ceil(tabsMarkup().match(/data-screen="/g).length / Math.floor(100 / share))
  assert.equal(phoneToken('--nav-h').replace(/\s+/g, ' '), `calc(var(--nav-row) * ${rows})`,
    `the tabs take ${rows} rows and the space kept for them says otherwise`)
})

test('a phone tab\'s name is no smaller than the smallest words on the board', () => {
  const sizes = phoneRuleSaying(PHONE_TAB, 'font-size').map((rule) => valuesIn(rule)['font-size'])
  assert.ok(sizes.length, 'nothing sets the size of a tab\'s name')
  for (const size of sizes) assert.ok(remOf(size) >= 0.6875, `a tab's name is ${size} - smaller than .6875rem, 11px, cannot be read`)
})

test('on a phone the tabs are pinned to the top, where the screens come first', () => {
  const nav = Object.assign({}, ...exactRules('nav').filter((rule) => !rule.inMedia).map(valuesIn))
  assert.equal(nav.position, 'fixed', 'the phone tabs scroll away with the page')
  assert.equal(nav.top, '0', 'the phone tabs are not held at the top of the screen')
  assert.equal(nav.bottom, undefined, 'the phone tabs are pinned to the bottom as well as, or instead of, the top')
})

/* Every movement in the sheet, not only the sidebar's drift. A transition is fine for most people
   and a real problem for some - a phone set to reduce motion is the owner asking. So each one must
   either be written to run only when nothing was asked (no-preference), or be switched off by a
   reduce rule for the very same selector that comes after it - a media query adds no specificity,
   so a reduce rule above the transition loses. Checked selector by selector, because a reduce block
   that exists but names a different element switches off nothing. */
test('nothing in the sheet moves for someone whose phone asks for less motion', () => {
  const REDUCE = /prefers-reduced-motion:\s*reduce/
  const familyOf = (property) => /^(transition|animation)(-|$)/.exec(property)?.[1]
  const rules = cssRules()
  const moving = rules.filter((rule) => !REDUCE.test(rule.condition) &&
    Object.entries(valuesIn(rule)).some(([property, value]) => familyOf(property) && !/^none\b/.test(value)))
  assert.ok(moving.length >= 4, `only ${moving.length} moving rules found - the sweep has stopped seeing the sheet`)

  for (const rule of moving) {
    if (/prefers-reduced-motion:\s*no-preference/.test(rule.condition)) continue
    const families = new Set(Object.keys(valuesIn(rule)).map(familyOf).filter(Boolean))
    for (const selector of rule.selector.split(',').map((one) => one.trim())) {
      for (const family of families) {
        const stilled = rules.some((reduce) => REDUCE.test(reduce.condition) && reduce.at > rule.at &&
          reduce.selector.split(',').map((one) => one.trim()).includes(selector) &&
          /^none\b/.test(valuesIn(reduce)[family] ?? '') &&
          // A reduce rule that also waits for a wide screen leaves the phone moving.
          reduce.condition.split(/\s*&&\s*/).every((head) => REDUCE.test(head) ? /^@media \(prefers-reduced-motion: reduce\)$/.test(head) : rule.condition.includes(head)))
        assert.ok(stilled, `${selector} keeps its ${family} for someone whose phone asks for less motion`)
      }
    }
  }
})

test('the top bar holds the title, the way out and the switch, and is sticky on a wide screen only', () => {
  const bar = /<header class="topbar"[^>]*>([\s\S]*?)<\/header>/.exec(html)?.[1]
  assert.ok(bar, 'there is no top bar')
  for (const id of ['screen-title', 'repo-link', 'fresh', 'jump-run', 'theme-switch']) {
    assert.match(bar, new RegExp(`id="${id}"`), `#${id} is not in the top bar`)
  }
  assert.match(bar, /href="https:\/\/claude\.ai\/code"[^>]*>[\s\S]*?Talk to your team/, 'Talk to your team is not in the top bar')
  assert.equal((html.match(/Talk to your team</g) ?? []).length, 1, 'Talk to your team is drawn more than once')

  // On a phone the tab rows are already fixed to the top; a sticky bar under them would hold a
  // third of a small screen on every scroll.
  const sticky = (rule) => valuesIn(rule).position === 'sticky'
  assert.deepEqual(exactRules('.topbar').filter((rule) => !rule.inMedia && sticky(rule)).map((rule) => rule.selector), [],
    'the top bar is sticky on a phone too')
  const wide = exactRules('.topbar').filter((rule) => rule.inMedia && WIDE.test(rule.condition) && sticky(rule))
  assert.ok(wide.length, 'the top bar does not stay in reach on a wide screen')
  assert.equal(valuesIn(wide.at(-1)).top, '0')
})

// The last three are Personalise's: the button on a banner, Choose a picture (a label drawn as a
// button, around the file input), and the name field a thumb has to land in.
const THUMB = ['button.fire', '.small-fire', '.theme-switch', '.topbar-btn', 'a.watch', 'a.title[data-open]', '.why > summary', '.finished-tasks > summary',
  'button.banner-btn', 'label.fire', '.brand-field']

test('every control a thumb presses is at least 44px tall on a phone', () => {
  // 2.75rem is 44px, the smallest target a thumb hits without aiming. Unconditional rules only: a
  // size set inside the desktop query does not exist on the device this is about.
  const short = []
  for (const selector of THUMB) {
    const declared = exactRules(selector).filter((rule) => !rule.inMedia).map(valuesIn)
    const last = (name) => declared.map((rule) => rule[name]).filter(Boolean).at(-1)
    const rem = (value) => Number(/^([\d.]+)rem$/.exec(value ?? '')?.[1] ?? 0)
    const tallest = Math.max(rem(last('min-height')), rem(last('height')))
    if (tallest < 2.75) short.push(`${selector} is ${tallest ? `${tallest}rem` : 'given no height'}`)
  }
  assert.deepEqual(short, [], `controls a thumb has to aim for:\n${short.join('\n')}`)
})

/* ---------- Today: the banner and the three numbers ---------------------------------------------
   v2 opens Today on a picture with a greeting, the line about the team, and how far setup has got,
   then three number cards. Every number on them has to be one the repo can source: a card with
   nothing to count says so in words, a history the server had to cut short draws no line, and the
   one number with no history at all - the owner's own - never gets a line drawn under it. */

const kpiCards = (drawn) => Object.fromEntries(
  [...drawn.matchAll(/<article class="kpi kpi-([a-z]+)"[\s\S]*?<\/article>/g)].map((found) => [found[1], found[0]]))
const textOf = (markup) => markup
  .replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&middot;/g, '·').replace(/&mdash;/g, '—')
  .replace(/\s+/g, ' ').trim()
const bannerOf = (drawn) => /<section class="banner"[\s\S]*?<\/section>/.exec(drawn)?.[0] ?? assert.fail('Today has no banner')

// `perDay[13]` runs today, `perDay[0]` thirteen days ago, newest first like the payload. Each day's
// runs start at 10:00 local and take turns between the agents, so the distinct count is
// min(runs, agents).
const fortnight = (perDay, agents = ['research', 'email', 'sales']) => {
  const runs = []
  const today = new Date()
  perDay.forEach((count, index) => {
    for (let run = 0; run < count; run += 1) {
      const at = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (13 - index), 10, run)
      runs.push({ started_at: at.toISOString(), agent: agents[run % agents.length] })
    }
  })
  return runs.reverse()
}
const activityOf = (runs, complete = true) => ({ since: new Date(Date.now() - 15 * 86400_000).toISOString(), runs, complete })

// The y of every point a sparkline passes through, in order: the M point, then each C's end point.
const sparkYs = (card) => {
  const path = /class="spark-line" d="([^"]+)"/.exec(card)?.[1] ?? assert.fail('the card draws no line')
  const start = /^M\s*([\d.]+),([\d.]+)/.exec(path)
  const ends = [...path.matchAll(/C\s*[\d.]+,[\d.]+\s+[\d.]+,[\d.]+\s+([\d.]+),([\d.]+)/g)]
  return [Number(start[2]), ...ends.map((found) => Number(found[2]))]
}

test('the greeting follows the hour', () => {
  const { greetingFor } = render(base, { expose: ['greetingFor'] }).exposed
  const expected = [[5, 'Good morning'], [11, 'Good morning'], [12, 'Good afternoon'], [17, 'Good afternoon'],
    [18, 'Good evening'], [23, 'Good evening'], [0, 'Good evening'], [4, 'Good evening']]
  for (const [hour, words] of expected) assert.equal(greetingFor(hour), words, `at ${hour}:00`)
})

test('the greeting uses the first name only, and greets nobody by a name it does not have', () => {
  const named = bannerOf(render({ ...base, owner: { name: 'Jordan Avery' } }).get('today').innerHTML)
  assert.match(named, /Good (morning|afternoon|evening), Jordan\./)
  assert.ok(!named.includes('Avery'), 'the greeting used the whole name')
  // The second line makes no claim about the team. The mock-up said "Your team is at work." over a
  // team that might have done nothing for a week.
  assert.match(named, /Here is where things stand\./)

  const nameless = bannerOf(render(base).get('today').innerHTML)
  assert.match(nameless, /Good (morning|afternoon|evening)\./)
  assert.ok(!/Good (morning|afternoon|evening),/.test(nameless), 'somebody with no name in about-me was greeted by one')

  const hostile = bannerOf(render({ ...base, owner: { name: '<img src=x onerror=1>' } }).get('today').innerHTML)
  assert.ok(!hostile.includes('<img src=x'), 'the name from about-me was drawn as markup')
})

test('the setup ring counts what passed and names the first step not done', () => {
  const rung = (label, pass) => ({ rung: label.toLowerCase(), label, pass, detail: 'd' })
  const labels = ['Brief', 'Access', 'Training', 'Workflows', 'Oversight', 'Improvement']
  const setupWith = (passed) => labels.map((label, index) => rung(label, index < passed))
  const ring = (passed) => bannerOf(render({ ...base, setup: setupWith(passed) }).get('today').innerHTML)
  const arc = (banner) => {
    const found = /class="ring-done"[^>]*stroke-dasharray="([\d.]+) ([\d.]+)"/.exec(banner) ?? assert.fail('the ring draws no arc')
    return Number(found[1]) / Number(found[2])
  }

  const four = ring(4)
  assert.match(textOf(four), /Setup 4 of 6 · next: Oversight/)
  assert.ok(Math.abs(arc(four) - 4 / 6) < 0.01, `four of six drew ${arc(four).toFixed(3)} of the ring`)
  assert.ok(Math.abs(arc(ring(1)) - 1 / 6) < 0.01, 'the arc does not follow the count')

  const all = ring(6)
  assert.match(textOf(all), /Setup 6 of 6/)
  assert.ok(!/next:/.test(all), 'a finished setup still names a next step')

  // A pass further down the ladder does not make an earlier step done.
  const gap = bannerOf(render({ ...base, setup: labels.map((label) => rung(label, label !== 'Access')) }).get('today').innerHTML)
  assert.match(textOf(gap), /5 of 6 · next: Access/)

  assert.ok(!/class="ring/.test(bannerOf(render(base).get('today').innerHTML)), 'a ring was drawn with no setup steps to count')
})

test('Work done counts the last seven local days from the activity list, and draws all fourteen', () => {
  const perDay = [1, 0, 2, 1, 0, 0, 3, 1, 2, 0, 1, 4, 0, 2] // the last seven add up to 10
  const runs = fortnight(perDay)
  // data.runs is capped at fifty and stays empty here: a card that counted from it would say 0.
  const drawn = render({ ...base, runs: [], totalRuns: runs.length + 7, activity: activityOf(runs) }).get('today').innerHTML
  const work = kpiCards(drawn).work ?? assert.fail('there is no Work done card')
  assert.match(work, /class="kpi-value">10</, 'Work done is not the number of runs in the last seven days')

  const ys = sparkYs(work)
  assert.equal(ys.length, 14, 'the line does not have one point per day')
  // Higher up the card is a smaller y. The busiest day is the top of the line, the empty days the floor.
  assert.equal(Math.min(...ys), ys[11], 'the busiest day is not the highest point')
  for (const index of [1, 4, 5, 9, 12]) assert.equal(ys[index], Math.max(...ys), `an empty day (${index}) is off the floor`)
  assert.ok(ys[6] < ys[0], 'three runs drew no higher than one')
})

test('Agents working counts the agents in use, and its line is how many different agents ran each day', () => {
  // Two days ago one agent ran five times; yesterday two agents ran once each; today three did.
  // Counted by agent the line rises; counted by run it would fall first.
  const runs = [
    ...fortnight([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3]),
    ...fortnight([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0], ['research'])
  ]
  const agents = [
    agent({ slug: 'research', state: 'working' }), agent({ slug: 'email', state: 'working' }),
    agent({ slug: 'sales', state: 'quiet' }), agent({ slug: 'editor', state: 'not-in-use' })
  ]
  const card = kpiCards(render({ ...base, agents, totalRuns: runs.length, activity: activityOf(runs) }).get('today').innerHTML).agents
  assert.ok(card, 'there is no Agents working card')
  assert.match(textOf(card), /^Agents working 2 of 3\b/, 'the switched-off agent is counted as one not working')
  assert.match(textOf(card), /1 gone quiet/)
  const ys = sparkYs(card)
  assert.equal(ys.length, 14)
  assert.ok(ys[13] < ys[12] && ys[12] < ys[11], 'the line does not count distinct agents per day')
})

test('with nothing to count, the cards say so in words and never print a 0', () => {
  const cards = kpiCards(render(base).get('today').innerHTML)
  assert.deepEqual(Object.keys(cards), ['work', 'agents', 'ledger'], 'the three cards are missing or out of order')
  assert.match(textOf(cards.work), /No runs logged yet/)
  assert.match(textOf(cards.ledger), /No number chosen yet — \/onboard asks which\./)
  for (const [name, card] of Object.entries(cards)) {
    assert.ok(!/(^|\D)0(\D|$)/.test(textOf(card)), `the ${name} card printed a zero with nothing behind it: ${textOf(card)}`)
    assert.ok(!card.includes('<svg class="spark'), `the ${name} card drew a line through no data`)
  }

  // A freshly staffed team: eight agents, none has ever run. "0 of 8" in the largest type on the
  // screen is the day-one reading the template ships with, and it reads as eight things broken.
  const staffed = kpiCards(render({ ...base, agents: ['research', 'email', 'sales'].map((slug) => agent({ slug })) }).get('today').innerHTML).agents
  assert.ok(!/(^|\D)0(\D|$)/.test(textOf(staffed)), `a team that has never run was given a zero: ${textOf(staffed)}`)
  assert.match(textOf(staffed), /None of your 3 agents has run yet/)

  // Runs logged, none in the last fortnight: that IS a count, and it is zero. Never-ran and gone
  // quiet are different answers, which is what totalRuns is for.
  const quiet = kpiCards(render({ ...base, totalRuns: 12 }).get('today').innerHTML).work
  assert.match(quiet, /class="kpi-value">0</, 'a team that has run before but not lately is shown as never having run')
  assert.ok(!/No runs logged yet/.test(quiet))
})

test('a history the server had to cut short draws no line, and says why', () => {
  const runs = fortnight([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3])
  const cut = kpiCards(render({ ...base, totalRuns: 4000, agents: [agent({ state: 'working' })], activity: activityOf(runs, false) }).get('today').innerHTML)
  for (const name of ['work', 'agents']) {
    assert.ok(!cut[name].includes('<svg class="spark'), `the ${name} card drew a line that runs out partway`)
  }
  assert.match(textOf(cut.work), /no line/i, 'the missing line is not explained')
  // The newest runs are all there but the cut fell inside the week, so this is a floor, not a count.
  assert.match(cut.work, /class="kpi-value">6\+</, 'a cut-short week is shown as an exact count')

  // Cut, but the oldest run kept is from before the week began: the week itself is whole.
  const covered = fortnight([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3])
  const whole = kpiCards(render({ ...base, totalRuns: 4000, activity: activityOf(covered, false) }).get('today').innerHTML).work
  assert.match(whole, /class="kpi-value">6</)
})

test('the owner\'s number never gets a line under it - there is no history behind it', () => {
  const runs = fortnight([1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2])
  const hero = { metric: 'cost-a-week', defined: true, value: 2131, unit: 'a week', money: true, currency: 'GBP', caption: 'at the rate you set' }
  const cards = kpiCards(render({ ...base, hero, totalRuns: runs.length, agents: [agent({ state: 'working' })], activity: activityOf(runs) }).get('today').innerHTML)
  assert.match(cards.ledger, /class="hero-value">2,131 GBP</, 'the number card lost the hero markup')
  assert.ok(!/<svg/.test(cards.ledger), 'the owner\'s number has a line drawn under it')
  assert.ok(cards.work.includes('<svg class="spark'), 'the fixture stopped drawing lines at all, so the check above proves nothing')

  const unchosen = kpiCards(render({ ...base, hero: shapeHero({ hero: '<!-- fill: hero-metric -->' }, null) }).get('today').innerHTML).ledger
  assert.match(unchosen, /No hero number yet/)
})

test('Today opens on the banner, the numbers and Plan limits, then setup, the run buttons and the board', () => {
  const drawn = render({ ...base, workflows: [workflow({ fire: true })] }).get('today').innerHTML
  const marks = ['<section class="banner"', '<div class="kpis"', '<h2>Plan limits', 'Which of these actually ring is unknown', '<h2>Setup',
    '<h2 id="run-jobs">', '<h2>Board', '<h2>Due next', '<h2>Gone quiet', '<h2>Usage']
  const at = marks.map((mark) => drawn.indexOf(mark))
  marks.forEach((mark, index) => assert.ok(at[index] >= 0, `Today has no ${mark}`))
  assert.deepEqual([...at].sort((a, b) => a - b), at, `Today is out of order: ${marks.join(' > ')}`)
})

test('the line about the team shows once on Today, in the banner, and on every other screen above it', () => {
  const nodes = render({ ...base, agents: [agent({ state: 'working' })] })
  assert.equal(nodes.get('strap').hidden, true, 'Today shows the strap twice, above the banner and inside it')
  assert.ok(bannerOf(nodes.get('today').innerHTML).includes(nodes.get('strap').textContent),
    'the banner does not carry the strap, so Today lost it altogether')
  for (const screen of SCREENS.filter((name) => name !== 'today')) {
    assert.equal(render(base, { hash: `#${screen}` }).get('strap').hidden, false, `${screen} lost the strap`)
  }
})

test('only the Today banner picture loads at once, and the head asks for it early', () => {
  // Every other picture waits until it is about to be seen. A phone opening Today should not pay
  // for the sidebar art it never draws, or for Team's portraits.
  const pictures = [...html.matchAll(/<img\b[^>]*>/g)].map((found) => found[0])
  const eager = pictures.filter((tag) => !/\bloading="lazy"/.test(tag))
  assert.equal(eager.length, 1, `expected one picture to load at once, found:\n${eager.join('\n')}`)
  assert.match(eager[0], /src="\/art\/today-harbour\.webp"/)
  assert.match(eager[0], /width="1600"/)
  assert.match(eager[0], /height="686"/, 'the banner picture has no size, so the page jumps when it lands')
  const from = html.indexOf('function bannerHtml')
  assert.ok(from >= 0, 'there is no bannerHtml')
  const bannerSource = html.slice(from, html.indexOf('\n}', from))
  assert.ok(bannerSource.includes(eager[0]), 'the one eager picture is not the Today banner')

  const head = html.slice(0, html.indexOf('</head>'))
  assert.match(head, /<link rel="preload" as="image" href="\/art\/today-harbour\.webp"/, 'the banner picture waits for the script to ask for it')
})

/* ---------- Team: a portrait for each agent, under the workshop ---------------------------------
   v2's Team is a grid of cards, each with the agent's portrait on top and its state on a pill over
   the picture, under a banner of the workshop. Only the eight template agents have a picture. Any
   other slug is the owner's own agent, and it gets its initial on its own palette colour - never a
   guessed file name, because a slug is repo data and a guessed address is a request for whatever
   that data says. */

const teamCards = (drawn) => Object.fromEntries(
  [...drawn.matchAll(/<details class="agent-card[\s\S]*?<\/details>/g)]
    .map((found) => [/<span class="title">([^<]*)</.exec(found[0])?.[1], found[0]]))
const teamBannerOf = (drawn) =>
  /<section class="banner team-banner"[\s\S]*?<\/section>/.exec(drawn)?.[0] ?? assert.fail('Team has no banner')
const SHIPPED_PORTRAITS = readdirSync(fileURLToPath(new URL('../public/art/', import.meta.url)))
  .map((file) => /^agent-(.+)\.webp$/.exec(file)?.[1]).filter(Boolean).sort()

test('the agents with a portrait are exactly the agent pictures that ship', () => {
  // A name in the list with no file behind it is a broken image on every repo that has that agent;
  // a file with no name in the list is a picture nobody ever sees.
  assert.equal(SHIPPED_PORTRAITS.length, 8, 'the art folder no longer holds the eight template portraits')
  const { PORTRAITS } = render(base, { expose: ['PORTRAITS'] }).exposed
  assert.deepEqual([...PORTRAITS].sort(), SHIPPED_PORTRAITS)
})

test('an agent with a portrait gets it, lazily, and any other agent gets its initial on its own colour', () => {
  const drawn = render({ ...base, agents: [agent({ slug: 'research' }), agent({ slug: 'bookkeeper' })] }).get('team').innerHTML
  const cards = teamCards(drawn)

  const pictured = cards.research ?? assert.fail('the research card is missing')
  const image = /<img\b[^>]*>/.exec(pictured)?.[0] ?? assert.fail('a template agent got no portrait')
  assert.match(image, /\bsrc="\/art\/agent-research\.webp"/)
  // Eight portraits on a screen most visits never open. They wait until the screen is shown.
  assert.match(image, /\bloading="lazy"/, 'the portraits load with Today, on a screen nobody has opened')
  assert.match(image, /\bdecoding="async"/)
  assert.match(image, /\bwidth="480"/)
  assert.match(image, /\bheight="480"/, 'a portrait has no size, so the grid jumps as each one lands')
  assert.match(image, /\balt=""/, 'the portrait is announced as a picture, before the name printed under it')

  const own = cards.bookkeeper ?? assert.fail('the card for an agent with no portrait is missing')
  assert.ok(!/<img\b/.test(own), 'an agent with no portrait was given a picture address anyway')
  const hex = AGENT_PALETTE[agentColorIndex('bookkeeper')].hex
  assert.match(own, new RegExp(`class="portrait" style="--agent:${hex}"`),
    'the tile is not in the agent\'s own palette colour, the one its board cards and owner chips carry')
  assert.match(own, /class="portrait-tile" aria-hidden="true">B</, 'the tile does not carry the agent\'s initial')
})

test('a slug from the repo never becomes a picture address', () => {
  // Slugs are file names in somebody's repo. Only the eight fixed names may build a src; anything
  // else - markup, a path, a near miss - gets a tile, and is escaped wherever it is printed.
  const hostile = ['"><img src=x onerror=alert(1)>', '../../api/state', 'research.webp?x=', 'Research', 'research ']
  const allowed = new Set([...SHIPPED_PORTRAITS.map((slug) => `/art/agent-${slug}.webp`), '/art/team-workshop.webp'])
  for (const slug of hostile) {
    const drawn = render({ ...base, agents: [agent({ slug })] }).get('team').innerHTML
    const sources = [...drawn.matchAll(/\bsrc="([^"]*)"/g)].map((found) => found[1])
    const strays = sources.filter((source) => !allowed.has(source))
    assert.deepEqual(strays, [], `the slug ${JSON.stringify(slug)} reached a picture address`)
    assert.ok(!drawn.includes('<img src=x'), 'a slug was drawn as markup')
  }
})

test('a portrait that fails to load leaves the agent\'s initial in its place', () => {
  const nodes = render({ ...base, agents: [agent({ slug: 'research' })] })
  // The tile is drawn under the picture, so taking the picture away is all a failure has to do.
  const card = teamCards(nodes.get('team').innerHTML).research ?? assert.fail('the research card is missing')
  const tileAt = card.indexOf('class="portrait-tile" aria-hidden="true">R<')
  assert.ok(tileAt >= 0, 'a portrait has no initial under it to fall back to')
  assert.ok(tileAt < card.indexOf('<img'), 'the initial is drawn over the picture rather than under it')

  // An image's error event does not bubble, so only a listener in the capture phase ever hears it.
  const listeners = nodes.documentListeners.filter((entry) => entry.type === 'error')
  const capturing = listeners.filter((entry) => entry.options === true || entry.options?.capture === true)
  assert.equal(capturing.length, 1, 'nothing listens for a failed picture in the capture phase')
  const imageOf = (name) => ({
    removed: false,
    classList: { contains: (token) => token === name },
    remove() { this.removed = true }
  })
  const portrait = imageOf('portrait-img')
  capturing[0].handler({ target: portrait })
  assert.equal(portrait.removed, true, 'a failed portrait stays on the card as a broken picture')
  const other = imageOf('banner-img')
  capturing[0].handler({ target: other })
  assert.equal(other.removed, false, 'a failure anywhere on the page removes pictures that are not portraits')
})

test('the Team banner counts the agents by state, skips the states nobody is in, and names no agent', () => {
  const agents = [
    agent({ slug: 'research', state: 'working' }), agent({ slug: 'email', state: 'working' }),
    agent({ slug: 'editor', state: 'working' }), agent({ slug: 'sales', state: 'quiet' }),
    agent({ slug: 'content', state: 'not-in-use' }), agent({ slug: 'security', state: 'not-in-use' })
  ]
  const drawn = render({ ...base, agents }).get('team').innerHTML
  const banner = teamBannerOf(drawn)
  assert.ok(drawn.indexOf(banner) < drawn.indexOf('<details'), 'the banner is not above the cards')
  assert.match(textOf(banner), /Six agents\. One desk each\./)
  assert.match(textOf(banner), /3 working · 1 gone quiet · 2 switched off/)
  assert.ok(!/\b0\b/.test(textOf(banner)), `a state nobody is in was counted as a zero: ${textOf(banner)}`)
  for (const { slug } of agents) assert.ok(!banner.includes(slug), `the banner names ${slug}`)
  const picture = /<img\b[^>]*>/.exec(banner)?.[0] ?? assert.fail('the banner has no picture')
  assert.match(picture, /src="\/art\/team-workshop\.webp"/)
  assert.match(picture, /loading="lazy"/)

  const one = teamBannerOf(render({ ...base, agents: [agent({ state: 'never-run' })] }).get('team').innerHTML)
  assert.match(textOf(one), /One agent\. One desk\./, 'one agent was counted as a plural')
  assert.match(textOf(one), /1 never run/)
})

test('the cards are one column on a phone and a grid on a laptop, and opening one leaves its row alone', () => {
  const drawn = render({ ...base, agents: [agent({ slug: 'research' }), agent({ slug: 'email' })] }).get('team').innerHTML
  const grid = drawn.indexOf('<div class="team-grid">')
  assert.ok(grid >= 0, 'the cards are not in the grid')
  assert.ok(grid < drawn.indexOf('<details class="agent-card'), 'a card is drawn outside the grid')

  const declared = Object.assign({}, ...exactRules('.team-grid').filter((rule) => !rule.inMedia).map(valuesIn))
  assert.equal(declared.display, 'grid')
  const track = /^repeat\(auto-fill,\s*minmax\(([\d.]+)rem,\s*1fr\)\)$/.exec(declared['grid-template-columns'] ?? '')
  assert.ok(track, `the grid does not fill the row with cards of a minimum width: ${declared['grid-template-columns']}`)
  const gap = Number(/^([\d.]+)rem$/.exec(declared.gap ?? '')?.[1] ?? 0) * 16
  const columns = (width) => Math.max(1, Math.floor((width + gap) / (Number(track[1]) * 16 + gap)))
  // 390 wide less the page's 1rem either side; 1440 less the 15rem sidebar and 1.75rem either side.
  assert.equal(columns(390 - 32), 1, 'a phone gets the cards side by side, each too narrow to read')
  assert.ok(columns(1440 - 240 - 56) >= 3, 'a laptop gets a column of cards as tall as a phone\'s')
  // A grid row stretches to its tallest item, so an opened card would pull every card beside it long.
  assert.equal(declared['align-items'], 'start', 'opening one card stretches the cards beside it')
})

/* ---------- Add agent, at the top --------------------------------------------------------------
   It was the last tile of the grid, as in the mock-up - after eight tall portrait cards on a phone,
   so most people would never scroll far enough to find out they could add an agent at all. Nuno
   decided on 2026-10-06 that it goes at the top: under the banner, above the cards, on every
   screen size. These pin where it is, that pressing it still opens the same form, and that it did
   not quietly break the tests above that find a card by the first place its slug appears. */

test('Add agent is under the banner and above the first card, and the grid holds only cards', () => {
  const drawn = render({ ...base, agents: [agent({ slug: 'research' }), agent({ slug: 'email' })] }).get('team').innerHTML
  const button = drawn.indexOf('id="agent-open"')
  const grid = drawn.indexOf('<div class="team-grid">')
  assert.ok(button >= 0 && grid >= 0, 'the Team screen lost its Add agent button or its grid')
  assert.ok(drawn.indexOf('team-banner') < button, 'Add agent is drawn above the banner rather than under it')
  assert.ok(button < drawn.indexOf('<details class="agent-card'),
    'Add agent comes after the cards, where somebody has to scroll past every portrait to learn they can add one')
  assert.ok(button < grid, 'Add agent is inside the grid of cards rather than above it')
  const inGrid = drawn.slice(grid)
  for (const leftover of ['add-panel', 'agent-open', 'agent-form', 'Add agent']) {
    assert.ok(!inGrid.includes(leftover), `an end-of-grid Add agent tile is still drawn (found ${leftover} in the grid)`)
  }
  assert.equal(drawn.split('id="agent-open"').length - 1, 1, 'Add agent is drawn more than once')
})

test('the Add agent control names no agent, so every card is still found by its slug', () => {
  // The never-run test and the switched-off test above slice the screen from the FIRST place a slug
  // appears. The control is drawn before every card now, so a slug anywhere in it - an owner list,
  // an example, a help line - would make those slices start in the control and test the wrong text.
  const slugs = [...new Set([...SHIPPED_PORTRAITS, 'research', 'email', 'content', 'sales', 'editor', 'security', 'bookkeeper'])]
  const drawn = render({ ...base, agents: slugs.map((slug) => agent({ slug })) }).get('team').innerHTML
  const grid = drawn.indexOf('<div class="team-grid">')
  const control = drawn.slice(drawn.indexOf('add-panel'), grid)
  assert.ok(control.includes('id="agent-form"'), 'the form is not part of the control above the cards')
  for (const slug of slugs) {
    assert.ok(!control.includes(slug), `the Add agent control mentions "${slug}" before that agent's own card`)
    assert.ok(drawn.indexOf(slug) > grid, `"${slug}" first appears above the cards, so a slice from it misses its card`)
  }
  // And the exact slice the never-run test takes still lands on research's card and nothing else.
  const two = render({ ...base, agents: [agent({ slug: 'research' }), agent({ slug: 'email', totalRuns: 1, state: 'working' })] }).get('team').innerHTML
  const slice = two.slice(two.indexOf('research'), two.indexOf('email'))
  assert.ok(slice.includes('class="title">research<') && !slice.includes('agent-open'),
    'the slice from "research" to "email" no longer isolates the research card')
})

test('pressing Add agent opens the same form, and pressing it again puts it away', () => {
  for (const agents of [[agent()], []]) {
    const stand = () => ({ hidden: true, focused: false, listeners: {},
      addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler) },
      focus() { this.focused = true } })
    const parts = { '#agent-open': stand(), '#agent-form': stand(), '#agent-text': stand() }
    const drawn = render({ ...base, agents }, { find: (id, selector) => (id === 'team' ? parts[selector] : undefined) }).get('team').innerHTML
    assert.match(drawn, /<form id="agent-form" class="fire-form" hidden>/, 'the form is open before anyone pressed anything')
    const press = parts['#agent-open'].listeners.click ?? []
    assert.equal(press.length, 1, `nothing listens for a press on Add agent (${agents.length} agents)`)
    press[0]({})
    assert.equal(parts['#agent-form'].hidden, false, 'pressing Add agent did not open the form')
    assert.ok(parts['#agent-text'].focused, 'the form opened without putting the cursor in the box')
    press[0]({})
    assert.equal(parts['#agent-form'].hidden, true, 'pressing Add agent again did not put the form away')
    assert.equal((parts['#agent-form'].listeners.submit ?? []).length, 1, 'the form no longer sends anything')
  }
})

test('the Add agent button is styled to be seen, and the end-of-grid tile styling is gone', () => {
  const declared = Object.assign({}, ...rulesFor('#agent-open').map(valuesIn))
  assert.match(declared.background ?? '', /^var\(--accent-soft\)$/, 'Add agent is a plain button, easy to miss at the top')
  assert.match(declared.color ?? '', /^var\(--accent\)$/, 'Add agent text is not in the accent')
  assert.ok(Number.parseFloat(declared['min-height'] ?? '2.9') >= 2.75, 'Add agent is a smaller tap target than 2.75rem')
  assert.deepEqual(cssRules().filter((rule) => /\.team-grid\s*>\s*\.add-panel/.test(rule.selector)).map((rule) => rule.selector), [],
    'the dashed end-of-grid tile is still styled, for a tile that is no longer drawn')
})

/* ---------- The look, carried to every screen, and "Why?" -----------------------------------------
   v2 moves some explanations behind a "Why?" the reader opens, so an empty screen leads with what
   it is and what to do, and keeps the reasoning one tap away. That is only safe for reasoning. A
   sentence about money being spent, or about something being switched on, is the warning itself,
   and a warning behind a tap is a warning most people never read. */

const WHY_BLOCK = /<details class="why">[\s\S]*?<\/details>/g
const whyBlocks = (markup) => markup.match(WHY_BLOCK) ?? []
// What a reader sees without opening anything: the markup with every Why? taken out, collapsed to
// single spaces because these sentences wrap in the source.
const outsideWhy = (markup) => markup.replace(WHY_BLOCK, ' ').replace(/\s+/g, ' ')
const collapsed = (markup) => markup.replace(/\s+/g, ' ')
// The reasoning is plain text, so inside a Why? it is escaped the way whyHtml escapes it.
const escapedText = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

test('a Why? is a real disclosure that prints its text as text', () => {
  const { whyHtml } = render(base, { expose: ['whyHtml'] }).exposed
  const drawn = whyHtml('Because <b>this</b> & "that" <img src=x onerror=alert(1)>')
  assert.match(drawn, /^<details class="why"><summary>Why\?<\/summary>/, 'it is not a details element with a Why? summary')
  assert.match(drawn, /<\/details>$/)
  assert.ok(drawn.includes('Because &lt;b&gt;this&lt;/b&gt; &amp; &quot;that&quot; &lt;img'), 'the text was not escaped')
  assert.ok(!/<b>|<img/.test(drawn), 'text handed to Why? reached the page as markup')
  assert.equal(whyBlocks(drawn).length, 1)
})

test('a Why? never hides a sentence about spending or switching something on', () => {
  const screens = {
    today: render({ ...base, workflows: [workflow({ fire: true, arm: 'armed', armed: true })] }).get('today').innerHTML,
    ledger: render({
      ...base,
      ledger: { ownerType: 'business', hourlyValue: 150, hoursPerWeek: 3, costPerWeek: 450, unpriced: false, unreadable: 0, complete: true, tasks: [] },
      proposals: { proposals: [{ task: 'A', item: 'agent:x', why: 'because', words: 'w', number: '3 hours a week' }], gaps: [] }
    }).get('ledger').innerHTML,
    workflows: render({
      ...base,
      workflows: [workflow({ slug: 'rogue', arm: 'unapproved' }), workflow({ slug: 'wish', name: 'Wish', arm: 'declared', armed: true })]
    }).get('workflows').innerHTML,
    team: render(base).get('team').innerHTML,
    skills: render(base).get('skills').innerHTML
  }
  const MUST_STAY_IN_VIEW = {
    today: ['spends one run'],
    ledger: ['Nothing is switched on and nothing is spent', 'arming is a separate step you take on purpose'],
    workflows: ['spending runs nobody approved', 'is a wish until you arm it', 'asks for your run cap first',
      'starts spending runs', 'never arms anything silently'],
    team: ['Nothing is switched on'],
    skills: ['Nothing is switched on']
  }
  // Taking out nothing proves nothing: these fixtures have to draw Why? disclosures to take out.
  const all = Object.values(screens).join('')
  assert.ok(whyBlocks(all).length >= 4, `only ${whyBlocks(all).length} Why? disclosures drawn, so this checks almost nothing`)
  for (const [screen, sentences] of Object.entries(MUST_STAY_IN_VIEW)) {
    for (const sentence of sentences) {
      assert.ok(collapsed(screens[screen]).includes(sentence), `${screen} no longer says "${sentence}" at all`)
      assert.ok(outsideWhy(screens[screen]).includes(sentence),
        `${screen} hides "${sentence}" behind a Why?, where most people never read it`)
    }
  }
})

test('each place that has a Why? keeps its headline and next step in view, and the reasoning behind it', () => {
  const stale = { ...base.routines, takenAt: new Date(Date.now() - 30 * 86400_000).toISOString(), usable: true, stale: true, why: 'the snapshot was taken 4 weeks ago', count: 1 }
  const matchedNever = { ownerType: 'business', hourlyValue: 150, hoursPerWeek: 3, costPerWeek: 450, unpriced: false, unreadable: 0, complete: true, tasks: [] }
  const places = [
    ['Today, nothing can go quiet', render(base).get('today').innerHTML,
      ['Nothing can go quiet yet', 'No job on this team is armed'], 'not the same as everything running'],
    ['Today, no snapshot', render(base).get('today').innerHTML,
      ['Which of these actually ring is unknown', 'Run <code>/routines</code> in your team repo'], 'exactly what this screen is here to check'],
    ['Workflows, no snapshot', render({ ...base, workflows: [workflow()] }).get('workflows').innerHTML,
      ['Which of these actually ring is unknown', 'Run <code>/routines</code> in your team repo'], 'exactly what this screen is here to check'],
    ['Today, an old snapshot', render({ ...base, routines: stale }).get('today').innerHTML,
      ['last checked', 'Run <code>/routines</code> again before'], 'the snapshot was taken 4 weeks ago'],
    ['Team, no agents', render(base).get('team').innerHTML,
      ['You have no agents yet', 'Run <code>/onboard</code>'], '.claude/agents/'],
    ['Ledger, never matched', render({ ...base, ledger: matchedNever }).get('ledger').innerHTML,
      ['No gaps list yet', 'Run <code>/match</code>'], 'Never having asked what your team cannot do'],
    ['Skills, none yet', render(base).get('skills').innerHTML,
      ['No skills yet', 'ask your team for one in plain words'], 'the single tasks your jobs are built from'],
    ['Connections, no machines', render({ ...base, connections: [connection()], runtimes: [] }).get('connections').innerHTML,
      ['No machines listed, which is normal', 'Nothing here makes a job run', 'Access</b> step on Today'], 'shortcut list']
  ]
  for (const [place, drawn, inView, reasoning] of places) {
    assert.ok(collapsed(whyBlocks(drawn).join(' ')).includes(escapedText(reasoning)), `${place}: the reasoning is not behind a Why?`)
    for (const words of inView) {
      assert.ok(outsideWhy(drawn).includes(words), `${place}: "${words}" went behind the Why? with the reasoning`)
    }
  }
})

test('Add task and New workflow sit in one row that wraps, with no margin left over to indent the second', () => {
  // The second button carried `margin-left` from `.fire + .fire`, written when the two always fitted
  // side by side. In a board column they do not, so New workflow wrapped onto its own line and kept
  // the margin there, a step in from the button above it.
  const drawn = render(base).get('today').innerHTML
  assert.match(drawn,
    /<div class="add-open">\s*<button class="fire" type="button" id="task-open">[^<]*<\/button>\s*<button class="fire" type="button" id="wf-open">[^<]*<\/button>\s*<\/div>/,
    'the two buttons are not alone together in a row of their own')
  const row = Object.assign({}, ...exactRules('.add-open').filter((rule) => !rule.inMedia).map(valuesIn))
  assert.equal(row.display, 'flex', 'the row is not a flex row on a phone')
  assert.equal(row['flex-wrap'], 'wrap', 'the row does not wrap, so a narrow column pushes the second button past its edge')
  assert.ok(row.gap, 'nothing spaces the buttons, so the spacing would come back as a margin')
  const strays = cssRules()
    .filter((rule) => /\.fire\s*\+\s*\.fire|#task-open|#wf-open|\.add-open\s*[>\s]/.test(rule.selector))
    .filter((rule) => Object.keys(valuesIn(rule)).some((name) => name.startsWith('margin')))
    .map((rule) => `${rule.selector} { ${rule.body.trim()} }`)
  assert.deepEqual(strays, [], `a margin still lands on a button in the row:\n${strays.join('\n')}`)
})

/* ---------- Personalise: pictures and names from the board's own store -------------------------
   With a picture store connected, /api/brand says personalising is on and lists the owner's own
   pictures by version; each one is fetched from /api/art with the view key and shown from memory as
   a blob: address. Everything here hangs off one rule: with personalising OFF - no store, a failed
   or slow answer, anything that is not `enabled: true` - Today and Team are byte for byte the board
   that shipped before personalising existed. That is pinned against a copy of the two screens taken
   from the board at 2750c0d, drawn from one fixed payload at one fixed moment. */

const PINNED_AT = Date.UTC(2026, 9, 7, 10, 30) // a Wednesday, mid-morning in UTC
// The clock, the time zone and the language of the dates are all pinned, so the copy is the same on
// every machine: a laptop in Lisbon and one in Los Angeles would otherwise greet differently.
class PinnedDate extends Date {
  constructor(...args) { if (args.length) super(...args); else super(PINNED_AT) }
  static now() { return PINNED_AT }
  toLocaleDateString(locales, options) { return super.toLocaleDateString('en-GB', { ...options, timeZone: 'UTC' }) }
  toLocaleString(locales, options) { return super.toLocaleString('en-GB', { ...options, timeZone: 'UTC' }) }
}
const pinnedIso = (hoursFromNow) => new Date(PINNED_AT + hoursFromNow * 3600_000).toISOString()

// Every kind of thing Today and Team draw: template agents with a robot, the owner's own agent with
// a tile, a switched-off one, a job that rings and one that does not, a board in all four columns,
// a fortnight of runs and a part-finished setup.
const pinnedRun = (agentSlug, hoursAgo, extra = {}) => ({
  workflow: 'morning-brief', agent: agentSlug, status: 'ok', started_at: pinnedIso(-hoursAgo),
  summary: `${agentSlug} did a thing`, session_url: null, ...extra
})
const pinnedRuns = [
  pinnedRun('research', 2, { session_url: 'https://claude.ai/code/session_1' }),
  pinnedRun('research', 26), pinnedRun('bookkeeper', 50), pinnedRun('research', 98), pinnedRun('content', 200)
]
const pinnedPayload = {
  ...base,
  owner: { name: 'Jordan Avery' },
  generatedAt: pinnedIso(-0.02),
  agents: [
    agent({ slug: 'research', state: 'working', model: 'sonnet', runsThisWeek: 3, totalRuns: 4, lastRun: pinnedIso(-2), recentRuns: pinnedRuns.filter((run) => run.agent === 'research') }),
    agent({ slug: 'content', state: 'quiet', totalRuns: 1, lastRun: pinnedIso(-200) }),
    agent({ slug: 'bookkeeper', state: 'working', totalRuns: 1, runsThisWeek: 1, lastRun: pinnedIso(-50) }),
    agent({ slug: 'security', state: 'not-in-use', notInUseBecause: 'I do not sell anything online.' })
  ],
  runs: pinnedRuns,
  totalRuns: pinnedRuns.length,
  activity: { since: pinnedIso(-15 * 24), runs: pinnedRuns.map(({ agent: who, started_at }) => ({ agent: who, started_at })), complete: true },
  workflows: [
    workflow({ slug: 'morning-brief', name: 'Morning brief', arm: 'armed', armed: true, routineId: 'trig_1', fire: true, nextRun: pinnedIso(2), lastRun: pinnedIso(-22), state: 'working' }),
    workflow({ slug: 'wishful', name: 'Wishful', owner: 'content', arm: 'declared', armed: true, schedule: 'weekly mon 09:00' })
  ],
  board: {
    todo: [{ slug: 'chase-acme', title: 'Chase Acme', for: 'research', doing: false }, { slug: 'books', title: 'Close the month', for: 'bookkeeper', doing: true }],
    upNext: [{ name: 'Morning brief', when: pinnedIso(2), owner: 'research' }],
    running: [{ name: 'Inbox sweep', agent: 'research', started_at: pinnedIso(-0.2), session_url: 'https://claude.ai/code/session_2' }],
    done: [{ name: 'Morning brief', agent: 'research', status: 'ok', started_at: pinnedIso(-2), summary: 'Five things worth reading', session_url: null }],
    finishedTasks: []
  },
  goneQuiet: [{ name: 'content', kind: 'agent', lastRun: pinnedIso(-200) }],
  setup: ['Brief', 'Access', 'Training'].map((label, index) => ({ rung: label.toLowerCase(), label, pass: index < 2, detail: 'd' })),
  routines: { takenAt: pinnedIso(-5), usable: true, stale: false, why: null, count: 1, known: true, orphans: [], problems: [] }
}

const BOARD_BEFORE = fileURLToPath(new URL('./fixtures/board-before-personalise.json', import.meta.url))

// Draws the pinned payload with the pinned clock in UTC. Async, because the page's own boot finishes
// after the first draw and draws again: the time zone stays pinned until it has.
async function pinnedScreens(options = {}, settle = async () => { await new Promise((resolve) => setImmediate(resolve)) }) {
  const zone = process.env.TZ
  process.env.TZ = 'UTC'
  try {
    const nodes = render(pinnedPayload, { Date: PinnedDate, ...options })
    await settle(nodes)
    return nodes
  } finally {
    if (zone === undefined) delete process.env.TZ
    else process.env.TZ = zone
  }
}

if (process.env.COCKPIT_WRITE_BOARD_BEFORE === '1') {
  // Run once, against the board at 2750c0d, to take the copy. Never again: a copy retaken from a
  // board that already changed would pin the change instead of catching it.
  const nodes = await pinnedScreens()
  const { writeFileSync } = await import('node:fs')
  writeFileSync(BOARD_BEFORE, JSON.stringify({ today: nodes.get('today').innerHTML, team: nodes.get('team').innerHTML }, null, 2) + '\n')
}

const BOARD_BEFORE_COPY = JSON.parse(readFileSync(BOARD_BEFORE, 'utf8'))
// Plan limits and the Subscriptions card arrived on Today after the copy was taken, and neither is
// part of personalising. Each is taken out - exactly one of each, and both must be there - and
// everything else still has to match the copy byte for byte. Retaking the copy instead would pin
// whatever else had changed with them.
function todayWithoutPlanLimits(markup) {
  let rest = markup
  for (const [name, pattern] of [
    ['Plan limits section', /<section class="plan-limits">[\s\S]*?<\/section>/g],
    ['Subscriptions card', /<section class="panel card subs">[\s\S]*?<\/section>/g]
  ]) {
    const found = rest.match(pattern) ?? []
    assert.equal(found.length, 1, `Today does not carry exactly one ${name}`)
    rest = rest.replace(found[0], '')
  }
  return rest
}
const flush = async (times = 4) => { for (let turn = 0; turn < times; turn += 1) await new Promise((resolve) => setImmediate(resolve)) }

const V1 = 'aaaa1111aaaa'
const V2 = 'bbbb2222bbbb'
const webpAt = (v) => ({ v, type: 'image/webp' })
// Word for word the shape /api/brand sends with a store connected and no OpenAI key.
const brandOn = (pictures = {}) => ({
  enabled: true, canGenerate: false, why: 'Making pictures from words is off.', assistantName: '', artStyle: '',
  defaultArtStyle: 'Painterly.', names: {}, pictures, left: { writes: 25, generated: 10 }
})
const EVERY_SLOT = { today: webpAt(V1), team: webpAt(V1), 'agent-research': webpAt(V1), 'agent-bookkeeper': webpAt(V1), 'agent-content': webpAt(V1) }

// A browser's answers: the payload, the brand it is given, and a picture for every /api/art asked
// for. Every request is recorded with its headers.
function storeFetch({ brand: answer = brandOn(), art = () => ({ ok: true, status: 200, type: 'image/webp' }), payload = pinnedPayload } = {}) {
  const requests = []
  const fetch = async (url, init = {}) => {
    requests.push({ url: String(url), headers: { ...(init.headers ?? {}) } })
    if (String(url).startsWith('/api/brand')) return typeof answer === 'function' ? answer() : { ok: true, status: 200, json: async () => answer }
    if (String(url).startsWith('/api/art')) {
      const picture = art(String(url))
      return { ok: picture.ok, status: picture.status, json: async () => ({}), blob: async () => ({ type: picture.type, size: 2048, from: String(url) }) }
    }
    return { ok: true, status: 200, json: async () => payload }
  }
  return { fetch, requests, art: () => requests.filter((request) => request.url.startsWith('/api/art')) }
}

// Stand-ins for the places a store picture is drawn - a banner, a portrait - found the way the page
// finds them, by data-art inside their own screen. Each holds the one picture in it, so a test reads
// what a person would see once a picture lands, without the screen being drawn again: a picture
// arriving puts itself in its place and redraws nothing (T11). Asked about a slot in the wrong
// screen, they answer nothing, as the real page would.
function artHolders() {
  const holders = new Map()
  const holderFor = (slot) => {
    if (!holders.has(slot)) {
      const holder = { slot, image: null, placed: [] }
      const place = (where, markup) => {
        holder.placed.push({ where, markup })
        let src = /\bsrc="([^"]*)"/.exec(markup)?.[1] ?? null
        holder.image = {
          getAttribute: (name) => (name === 'src' ? src : null),
          setAttribute: (name, value) => { if (name === 'src') src = String(value) },
          remove: () => { holder.image = null },
          get src() { return src }
        }
      }
      // A portrait's picture goes straight after its initial, so it is drawn over it; a banner's
      // goes first, under its words.
      const tile = { insertAdjacentHTML: (where, markup) => place(`after the tile: ${where}`, markup) }
      holder.querySelector = (selector) =>
        selector === 'img' ? holder.image : selector === '.portrait-tile' && slot.startsWith('agent-') ? tile : null
      holder.insertAdjacentHTML = (where, markup) => place(where, markup)
      holders.set(slot, holder)
    }
    return holders.get(slot)
  }
  return {
    select: (id, selector) => {
      const slot = /^\[data-art="([a-z0-9-]+)"\]$/.exec(selector)?.[1]
      if (!slot) return undefined
      return id === (slot.startsWith('agent-') ? 'team' : slot) ? [holderFor(slot)] : []
    },
    srcOf: (slot) => holders.get(slot)?.image?.src ?? null,
    holder: holderFor
  }
}

const srcsOf = (markup) => [...markup.matchAll(/\bsrc="([^"]*)"/g)].map((found) => found[1])
const cardOf = (drawn, slug) => teamCards(drawn)[slug] ?? assert.fail(`the ${slug} card is missing`)
const pictureOf = (markup) => /<img\b[^>]*>/.exec(markup)?.[0] ?? null

// With personalising off, Team is the board before it plus ONE thing: "Make it yours" in the
// banner, which is how somebody finds out personalising exists and how to switch it on. That one
// difference is on purpose (T11); anything else is a change to a board that was meant to stay put.
// The copy is still the board at 2750c0d - retaken at 1de171d it came out byte for byte the same.
const MAKE_IT_YOURS = /<button\b[^>]*>Make it yours<\/button>/g
function onlyMakeItYoursAdded(team, label) {
  const buttons = team.match(MAKE_IT_YOURS) ?? []
  assert.equal(buttons.length, 1, `Team does not carry exactly one Make it yours button (${label})`)
  assert.ok(teamBannerOf(team).includes(buttons[0]), `Make it yours is not in the Team banner (${label})`)
  assert.equal(team.replace(buttons[0], ''), BOARD_BEFORE_COPY.team, `Team changed by more than the Make it yours button (${label})`)
}

test('with personalising off, Today is byte for byte the board before personalising, and Team only gains Make it yours', async () => {
  // The control: the copy really is this payload drawn by this harness, so every comparison below
  // is a real one and not two empty strings agreeing.
  assert.match(BOARD_BEFORE_COPY.today, /src="\/art\/today-harbour\.webp"/)
  assert.match(BOARD_BEFORE_COPY.team, /src="\/art\/agent-research\.webp"/)

  // Everything that is not exactly `enabled: true` is off - including an answer that lists pictures,
  // and pictures the page already holds an address for.
  const offs = [undefined, null, 'on', [], {}, { ...brandOn(EVERY_SLOT), enabled: false }, { ...brandOn(EVERY_SLOT), enabled: 'true' }, { ...brandOn(EVERY_SLOT), enabled: 1 }]
  const art = { today: { v: V1, url: 'blob:cockpit/held' }, 'agent-research': { v: V1, url: 'blob:cockpit/held' } }
  for (const brand of offs) {
    const label = JSON.stringify(brand)?.slice(0, 40) ?? 'no brand at all'
    const nodes = await pinnedScreens(brand === undefined ? {} : { state: { brand, art } })
    assert.equal(todayWithoutPlanLimits(nodes.get('today').innerHTML), BOARD_BEFORE_COPY.today, `Today changed with personalising off (${label})`)
    onlyMakeItYoursAdded(nodes.get('team').innerHTML, `personalising off: ${label}`)
    assert.deepEqual(nodes.objectUrls.created, [], `a picture was made into an address with personalising off (${label})`)
  }
})

test('however /api/brand fails, the board boots with personalising off and draws the board as before', async () => {
  const failures = {
    'a network failure': () => Promise.reject(new TypeError('Failed to fetch')),
    // A refusal that carries something shaped like "on" is still a refusal.
    'a 503': () => ({ ok: false, status: 503, json: async () => brandOn(EVERY_SLOT) }),
    'a 401': () => ({ ok: false, status: 401, json: async () => brandOn(EVERY_SLOT) }),
    'an answer that is not JSON': () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <') } }),
    'no store connected': () => ({ ok: true, status: 200, json: async () => ({ ...brandOn(EVERY_SLOT), enabled: false }) })
  }
  for (const [what, answer] of Object.entries(failures)) {
    const browser = storeFetch({ brand: answer })
    const nodes = await pinnedScreens({ fetch: browser.fetch }, async (drawn) => {
      // Wiped, so what is compared is what the page's own boot drew once /api/brand had answered.
      drawn.get('today').innerHTML = ''
      drawn.get('team').innerHTML = ''
      await flush()
    })
    assert.ok(browser.requests.some((request) => request.url === '/api/brand'), `the boot never asked /api/brand (${what})`)
    assert.equal(todayWithoutPlanLimits(nodes.get('today').innerHTML), BOARD_BEFORE_COPY.today, `Today changed after ${what}`)
    onlyMakeItYoursAdded(nodes.get('team').innerHTML, `after ${what}`)
    assert.deepEqual(browser.art(), [], `a picture was asked for after ${what}`)
  }
})

test('an /api/brand that never answers holds the board up for three seconds, no longer, and then it is off', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const browser = storeFetch({ brand: () => new Promise(() => {}) })
    const nodes = await pinnedScreens({ fetch: browser.fetch }, async (drawn) => {
      drawn.get('today').innerHTML = ''
      await flush()
      mock.timers.tick(2999)
      await flush()
      assert.equal(drawn.get('today').innerHTML, '', 'the board was drawn before the brand had its three seconds')
      mock.timers.tick(1)
      await flush()
    })
    assert.equal(todayWithoutPlanLimits(nodes.get('today').innerHTML), BOARD_BEFORE_COPY.today, 'a silent /api/brand left the board undrawn or changed it')
    assert.deepEqual(browser.art(), [])
  } finally {
    mock.timers.reset()
  }
})

test('a picture of their own comes first, then the built-in robot, then the initial', () => {
  const agents = ['research', 'bookkeeper', 'content', 'security', 'zed'].map((slug) => agent({ slug }))
  const drawn = render({ ...base, agents }, {
    state: {
      brand: brandOn({ 'agent-research': webpAt(V1), 'agent-bookkeeper': webpAt(V1), 'agent-content': webpAt(V1) }),
      art: {
        'agent-research': { v: V1, url: 'blob:cockpit/research' },
        'agent-bookkeeper': { v: V1, url: 'blob:cockpit/bookkeeper' },
        // Fetched and failed: the robot it would have replaced, rather than nothing.
        'agent-content': { v: V1, failed: true }
      }
    }
  }).get('team').innerHTML

  // A template agent with a picture of its own: that picture, not the robot.
  assert.match(pictureOf(cardOf(drawn, 'research')) ?? '', /\bsrc="blob:cockpit\/research"/, 'the robot won over the owner\'s own picture')
  // The owner's own agent has no robot, so its own picture goes where the tile showed alone - with
  // the tile still under it, for when it fails.
  const own = cardOf(drawn, 'bookkeeper')
  assert.match(pictureOf(own) ?? '', /\bsrc="blob:cockpit\/bookkeeper"/, 'an agent with no robot never shows its own picture')
  assert.match(pictureOf(own), /class="portrait-img"[^>]*width="480" height="480" loading="lazy"/, 'its own picture is not drawn as a portrait')
  assert.ok(own.indexOf('class="portrait-tile"') < own.indexOf('<img'), 'the initial is not under the picture')
  // No picture of its own, or one that failed: the robot.
  assert.match(pictureOf(cardOf(drawn, 'content')) ?? '', /\bsrc="\/art\/agent-content\.webp"/, 'a picture that failed left no robot behind')
  assert.match(pictureOf(cardOf(drawn, 'security')) ?? '', /\bsrc="\/art\/agent-security\.webp"/)
  // Neither: the initial on its own colour, as before.
  assert.equal(pictureOf(cardOf(drawn, 'zed')), null)
  assert.match(cardOf(drawn, 'zed'), /class="portrait-tile" aria-hidden="true">Z</)
})

test('while a picture of their own is on its way, the built-in one is never drawn in its place', () => {
  const agents = ['research', 'bookkeeper', 'content'].map((slug) => agent({ slug }))
  const nodes = render({ ...base, agents }, {
    state: { brand: brandOn({ today: webpAt(V1), team: webpAt(V1), 'agent-research': webpAt(V1), 'agent-bookkeeper': webpAt(V1) }) }
  })
  // Read at once: nothing has come back from /api/art yet.
  const banner = bannerOf(nodes.get('today').innerHTML)
  assert.equal(pictureOf(banner), null, 'the harbour was drawn while the owner\'s own banner was on its way')
  assert.match(banner, /class="greeting"/, 'the banner lost its words while its picture loads')
  const team = nodes.get('team').innerHTML
  assert.equal(pictureOf(teamBannerOf(team)), null, 'the workshop was drawn while the owner\'s own banner was on its way')
  const research = cardOf(team, 'research')
  assert.equal(pictureOf(research), null, 'the robot flashed up before the owner\'s own picture')
  assert.match(research, /class="portrait-tile" aria-hidden="true">R</, 'nothing holds the place while the picture loads')
  assert.equal(pictureOf(cardOf(team, 'bookkeeper')), null)
  // An agent with no picture of its own is not held up by the ones that have one.
  assert.match(pictureOf(cardOf(team, 'content')) ?? '', /src="\/art\/agent-content\.webp"/)
  // And nothing anywhere asked for a built-in picture it is about to replace.
  for (const source of [...srcsOf(nodes.get('today').innerHTML), ...srcsOf(team)]) {
    assert.ok(!['/art/today-harbour.webp', '/art/team-workshop.webp', '/art/agent-research.webp'].includes(source), `${source} was drawn and then replaced`)
  }
})

test('a picture from the store reaches a src only as a blob: address, fetched with the view key', async () => {
  const browser = storeFetch({ brand: brandOn({ today: webpAt(V1), team: { v: V2, type: 'image/jpeg' }, 'agent-research': { v: V1, type: 'image/png' } }) })
  const holders = artHolders()
  const nodes = render(pinnedPayload, {
    fetch: browser.fetch,
    storage: { getItem: (key) => (key === 'agent-cockpit-view-key' ? 'the-view-key' : null), setItem() {}, removeItem() {} },
    select: holders.select,
    expose: ['showScreen', 'renderToday']
  })
  await flush()
  nodes.exposed.showScreen('team')
  await flush()

  const asked = browser.art()
  assert.deepEqual(asked.map((request) => request.url).sort(), [
    `/api/art?slot=agent-research&v=${V1}&t=png`, `/api/art?slot=team&v=${V2}&t=jpeg`, `/api/art?slot=today&v=${V1}&t=webp`
  ], 'the pictures were not asked for exactly as /api/brand named them')
  for (const request of asked) assert.equal(request.headers['x-view-key'], 'the-view-key', `${request.url} was asked for without the view key`)

  const made = new Set(nodes.objectUrls.created.map((entry) => entry.url))
  assert.equal(made.size, 3, 'each picture fetched was not made into exactly one address')
  // What a person sees: whatever the screens were drawn with, and each picture put in its own place
  // as it landed.
  const landed = ['today', 'team', 'agent-research'].map((slot) => holders.srcOf(slot))
  const shown = [...srcsOf(nodes.get('today').innerHTML), ...srcsOf(nodes.get('team').innerHTML), ...landed]
  const builtIn = new Set(['/art/agent-content.webp', '/art/agent-security.webp'])
  for (const source of shown) {
    assert.ok(builtIn.has(source) || made.has(source), `${source} reached a src, and it is neither a robot nor an address the page made`)
  }
  assert.ok(!shown.some((source) => source.includes('/api/')), 'the store was linked to directly, where an img cannot send the view key')
  assert.ok(made.has(holders.srcOf('today')), 'Today\'s banner is not the owner\'s picture')
  assert.ok(made.has(holders.srcOf('team')), 'Team\'s banner is not the owner\'s picture')
  assert.ok(made.has(holders.srcOf('agent-research')), 'the research card is not the owner\'s picture')
  // Today drawn with its picture in hand keeps everything that made the banner eager; only its
  // address changes.
  nodes.exposed.renderToday()
  assert.ok(made.has(/src="([^"]*)"/.exec(bannerOf(nodes.get('today').innerHTML))?.[1]), 'Today drawn again lost the owner\'s banner')
  assert.match(pictureOf(bannerOf(nodes.get('today').innerHTML)), /width="1600" height="686" fetchpriority="high"/)
})

test('a store picture that cannot be fetched gives way to the built-in one', async () => {
  const browser = storeFetch({ brand: brandOn({ today: webpAt(V1) }), art: () => ({ ok: false, status: 404, type: 'application/json' }) })
  const holders = artHolders()
  const nodes = render(pinnedPayload, { fetch: browser.fetch, select: holders.select, expose: ['renderToday'] })
  await flush()
  assert.equal(browser.art().length, 1)
  assert.equal(holders.srcOf('today'), '/art/today-harbour.webp', 'a missing picture left the banner empty')
  nodes.exposed.renderToday()
  assert.match(pictureOf(bannerOf(nodes.get('today').innerHTML)) ?? '', /src="\/art\/today-harbour\.webp"/, 'Today drawn again left the banner empty')
  assert.deepEqual(nodes.objectUrls.created, [])

  // An answer that is not a picture is a failure too, whatever status came with it.
  const html = storeFetch({ brand: brandOn({ today: webpAt(V1) }), art: () => ({ ok: true, status: 200, type: 'text/html' }) })
  const placed = artHolders()
  const second = render(pinnedPayload, { fetch: html.fetch, select: placed.select })
  await flush()
  assert.equal(placed.srcOf('today'), '/art/today-harbour.webp', 'a page of HTML was shown as the banner')
  assert.deepEqual(second.objectUrls.created, [], 'something that is not a picture was made into an address')
})

test('Today\'s picture is fetched with the board, and Team\'s only when Team is first opened', async () => {
  const browser = storeFetch({ brand: brandOn({ today: webpAt(V1), team: webpAt(V1), 'agent-research': webpAt(V1) }) })
  const nodes = render(pinnedPayload, { fetch: browser.fetch, expose: ['showScreen'] })
  await flush()
  assert.deepEqual(browser.art().map((request) => request.url), [`/api/art?slot=today&v=${V1}&t=webp`],
    'a phone opening Today paid for pictures on a screen it has not opened')
  nodes.exposed.showScreen('team')
  await flush()
  assert.equal(browser.art().length, 3, 'opening Team did not fetch its pictures')
  nodes.exposed.showScreen('today')
  nodes.exposed.showScreen('team')
  await flush()
  assert.equal(browser.art().length, 3, 'opening Team again fetched its pictures again')
})

test('a new version frees the address of the old one, and the same version is neither fetched nor freed again', async () => {
  const browser = storeFetch({ brand: brandOn({ today: webpAt(V1) }) })
  const nodes = render(pinnedPayload, { fetch: browser.fetch, expose: ['useBrand', 'loadArt', 'renderToday'] })
  await flush()
  const { useBrand, loadArt } = nodes.exposed
  const first = nodes.objectUrls.created[0]?.url ?? assert.fail('the first version was never made into an address')

  useBrand(brandOn({ today: webpAt(V1) }))
  await loadArt(['today'])
  assert.equal(browser.art().length, 1, 'the same version was fetched again')
  assert.deepEqual(nodes.objectUrls.revoked, [], 'the address on screen was freed though nothing changed')

  useBrand(brandOn({ today: webpAt(V2) }))
  await loadArt(['today'])
  assert.equal(browser.art().at(-1)?.url, `/api/art?slot=today&v=${V2}&t=webp`, 'the new version was never fetched')
  const second = nodes.objectUrls.created[1]?.url ?? assert.fail('the new version was never made into an address')
  assert.deepEqual(nodes.objectUrls.revoked, [first], 'the old version\'s address was kept after it was replaced')
  nodes.exposed.renderToday()
  assert.match(bannerOf(nodes.get('today').innerHTML), new RegExp(`src="${second}"`), 'the banner did not move to the new version')

  // Back to the default: the picture is gone from the brand, so its address goes too.
  useBrand(brandOn({}))
  assert.deepEqual(nodes.objectUrls.revoked, [first, second], 'a picture taken away kept its address')
  nodes.exposed.renderToday()
  assert.match(bannerOf(nodes.get('today').innerHTML), /src="\/art\/today-harbour\.webp"/, 'back to the default did not bring the harbour back')
})

test('a picture just uploaded is shown from the copy in hand, without fetching it back', async () => {
  const browser = storeFetch({ brand: brandOn({ today: webpAt(V1) }) })
  const holders = artHolders()
  const nodes = render(pinnedPayload, { fetch: browser.fetch, select: holders.select, expose: ['adoptPicture'] })
  await flush()
  const before = nodes.objectUrls.created[0].url
  const inHand = { type: 'image/webp', size: 30_000 }
  nodes.exposed.adoptPicture('today', { v: V2, type: 'image/webp' }, inHand)
  await flush()
  assert.equal(browser.art().length, 1, 'the picture just sent was fetched straight back')
  const made = nodes.objectUrls.created.at(-1)
  assert.equal(made.blob, inHand, 'the address was not made from the copy in hand')
  assert.deepEqual(nodes.objectUrls.revoked, [before], 'the picture it replaced kept its address')
  assert.equal(holders.srcOf('today'), made.url, 'Today does not show the picture just sent')
})

test('an answer from /api/brand is read only as far as it is shaped like one', () => {
  const { parseBrand } = render(base, { expose: ['parseBrand'] }).exposed
  for (const off of [undefined, null, 'yes', [], {}, { enabled: 'true' }, { enabled: false }]) assert.equal(parseBrand(off), null, JSON.stringify(off))
  const pictures = JSON.parse(JSON.stringify({
    today: webpAt(V1),
    'agent-research': { v: V1, type: 'image/png' },
    // Every one of these would become part of an /api/art address, or of the page's own lookups.
    'agent-../x': webpAt(V1), 'agent-A': webpAt(V1), constructor: webpAt(V1), 'today.webp': webpAt(V1),
    team: { v: '../../x', type: 'image/webp' },
    'agent-email': { v: V1, type: 'image/svg+xml' },
    'agent-sales': { v: V1, type: 'constructor' },
    'agent-editor': { v: 'short', type: 'image/webp' }
  }))
  // As JSON.parse hands it over: an own key called __proto__, not a prototype.
  Object.defineProperty(pictures, '__proto__', { value: webpAt(V1), enumerable: true })
  const names = JSON.parse('{"research":"Penny","sales":42,"__proto__":"x","A":"Bad"}')
  const parsed = parseBrand({ ...brandOn(), pictures, names })
  assert.deepEqual(Object.keys(parsed.pictures).sort(), ['agent-research', 'today'])
  assert.deepEqual(Object.entries(parsed.names), [['research', 'Penny']])
  assert.deepEqual(parseBrand({ ...brandOn(), pictures: 'today' }).pictures, {}, 'a string of pictures was read letter by letter')
})

/* ---------- Personalise: a chosen picture, cropped and shrunk on the device ---------------------
   Before anything is sent, the browser crops the picture from its centre - square for a portrait,
   21:9 for a banner - and shrinks it under the server's budget. There is no canvas in node, so these
   hand the page's own functions stand-in canvases and blobs and read what was asked of them. */

const pipeline = (options = {}) => render(base, {
  expose: ['PICTURE_BUDGET', 'PICTURE_SIZE', 'QUALITY_STEPS', 'cropBox', 'encodeUnderCap', 'decodePicture', 'shrinkPicture'],
  ...options
}).exposed

// A canvas whose encoder answers with `produce(type, quality, width)` -> { type, size }, recording
// every encode it was asked for.
function encoder(produce) {
  const asked = []
  const draw = (width, height) => ({
    width, height,
    toBlob(done, type, quality) {
      asked.push({ width, height, type, quality })
      const made = produce(type, quality, width)
      done(made ? { ...made } : null)
    }
  })
  return { draw, asked }
}

test('the picture budgets in the page are the ones the server holds pictures to', () => {
  const { PICTURE_BUDGET: inPage } = pipeline()
  assert.deepEqual({ ...inPage }, { ...PICTURE_BUDGET }, 'the page shrinks to one size and the server refuses at another')
  // And word for word, the way the other mirrored helpers are held to api/lib.js.
  const lib = readFileSync(fileURLToPath(new URL('../api/lib.js', import.meta.url)), 'utf8')
  const line = (source, start) => source.slice(source.indexOf(start), source.indexOf('\n', source.indexOf(start)))
  assert.equal(line(html, 'const PICTURE_BUDGET'), line(lib, 'export const PICTURE_BUDGET').replace('export ', ''))
})

test('a picture is cropped from its centre, to a square or to the banner\'s 21:9', () => {
  const { cropBox } = pipeline()
  const plain = (box) => ({ ...box })
  assert.deepEqual(plain(cropBox(1000, 2000, 1)), { x: 0, y: 500, width: 1000, height: 1000 }, 'a tall photo was not cut from its middle')
  assert.deepEqual(plain(cropBox(4000, 1000, 1)), { x: 1500, y: 0, width: 1000, height: 1000 }, 'a wide photo was not cut from its middle')
  assert.deepEqual(plain(cropBox(1000, 1000, 21 / 9)), { x: 0, y: 285, width: 1000, height: 429 }, 'a square photo was not cut to a banner strip across its middle')
  assert.deepEqual(plain(cropBox(3000, 1000, 21 / 9)), { x: 333, y: 0, width: 2333, height: 1000 })
  // A picture already the banner's shape - the two that ship are 1600 by 686 - loses nothing.
  assert.deepEqual(plain(cropBox(1600, 686, 21 / 9)), { x: 0, y: 0, width: 1600, height: 686 })
})

test('when the browser hands back something other than the webp it asked for, the picture is made as a JPEG', async () => {
  const { encodeUnderCap } = pipeline()
  // Safari before 17 cannot write webp. Asked for one, it does not fail: it hands back a PNG - here a
  // small one, under the budget, which a check on the type ASKED for would happily send.
  const safari = encoder((type) => ({ type: type === 'image/webp' ? 'image/png' : type, size: 20_000 }))
  const made = await encodeUnderCap(safari.draw, 'portrait')
  assert.equal(made.type, 'image/jpeg', 'a PNG the browser made in place of a webp was sent as it was')
  assert.deepEqual(safari.asked.map((call) => call.type), ['image/webp', 'image/jpeg'])
  assert.equal(safari.asked[1].quality, safari.asked[0].quality, 'the JPEG did not start at the quality the webp was asked for')

  // A browser that can write webp is never moved off it.
  const chrome = encoder((type) => ({ type, size: 20_000 }))
  assert.equal((await encodeUnderCap(chrome.draw, 'portrait')).type, 'image/webp')
  assert.deepEqual(chrome.asked.map((call) => call.type), ['image/webp'])
})

test('the quality steps down until the picture fits, and stops there', async () => {
  const { encodeUnderCap, QUALITY_STEPS } = pipeline()
  assert.equal(QUALITY_STEPS[0], 0.85)
  assert.equal(QUALITY_STEPS.at(-1), 0.35)
  for (let index = 1; index < QUALITY_STEPS.length; index += 1) assert.ok(QUALITY_STEPS[index] < QUALITY_STEPS[index - 1], 'the quality does not step down')
  // Size goes with quality; this one fits the portrait budget from 0.55 down.
  const cap = PICTURE_BUDGET.portrait
  const sized = encoder((type, quality) => ({ type, size: Math.round(cap * quality / 0.55) }))
  const made = await encodeUnderCap(sized.draw, 'portrait')
  assert.ok(made.size <= cap, `${made.size} bytes is over the ${cap}-byte budget`)
  assert.deepEqual(sized.asked.map((call) => call.quality), QUALITY_STEPS.filter((quality) => quality >= 0.55),
    'it did not walk down the steps and stop at the first that fits')
  assert.ok(sized.asked.every((call) => call.width === 480 && call.height === 480), 'a portrait was not made 480 square')
  // The banner is held to its own budget, which a portrait-sized one would have refused.
  const banner = encoder((type) => ({ type, size: PICTURE_BUDGET.banner }))
  assert.equal((await encodeUnderCap(banner.draw, 'banner')).size, PICTURE_BUDGET.banner)
  assert.deepEqual(banner.asked.map((call) => [call.width, call.height]), [[1600, 686]])
})

test('a picture too big even at the lowest quality is made smaller, down to a floor and no smaller', async () => {
  const { encodeUnderCap } = pipeline()
  // Fits only once it is narrower than 350 pixels, at the lowest quality.
  const portrait = encoder((type, quality, width) => ({ type, size: width < 350 && quality === 0.35 ? 1000 : PICTURE_BUDGET.portrait + 1 }))
  await encodeUnderCap(portrait.draw, 'portrait')
  const widths = [...new Set(portrait.asked.map((call) => call.width))]
  assert.deepEqual(widths, [480, 408, 347], 'a portrait was not shrunk by steps of 0.85')
  assert.ok(portrait.asked.every((call) => call.height === call.width), 'a smaller portrait stopped being square')
  // Each size starts again from the top quality: a smaller picture can afford a better one.
  assert.equal(portrait.asked.find((call) => call.width === 408).quality, 0.85)

  const banner = encoder((type, quality, width) => ({ type, size: width === 1200 && quality === 0.35 ? 1000 : PICTURE_BUDGET.banner + 1 }))
  await encodeUnderCap(banner.draw, 'banner')
  assert.deepEqual([...new Set(banner.asked.map((call) => `${call.width}x${call.height}`))], ['1600x686', '1360x583', '1200x514'],
    'a banner did not stop at 1200 wide, or lost its 21:9 on the way')
})

test('a picture that will not fit even small and soft is refused with a sentence that says what to do', async () => {
  const { encodeUnderCap, QUALITY_STEPS } = pipeline()
  const stubborn = encoder((type) => ({ type, size: PICTURE_BUDGET.portrait + 1 }))
  await assert.rejects(encodeUnderCap(stubborn.draw, 'portrait'), (error) => {
    assert.match(error.message, /45 KB/, 'the sentence does not say what it would not fit under')
    assert.match(error.message, /\.$/, 'the refusal is not a sentence')
    assert.match(error.message, /[Tt]ry /, 'the sentence does not say what to do instead')
    return true
  })
  assert.equal(Math.min(...stubborn.asked.map((call) => call.width)), 320, 'it gave up before trying the smallest portrait, or went below it')
  assert.equal(stubborn.asked.length, 4 * QUALITY_STEPS.length, 'it did not try every quality at every size before giving up')

  const banner = encoder((type) => ({ type, size: PICTURE_BUDGET.banner + 1 }))
  await assert.rejects(encodeUnderCap(banner.draw, 'banner'), /100 KB/)

  // A browser that cannot write the picture at all is told so, rather than looping.
  const broken = encoder(() => null)
  await assert.rejects(encodeUnderCap(broken.draw, 'portrait'), (error) => /\.$/.test(error.message))
  assert.equal(broken.asked.length, 2, 'a browser that wrote nothing was asked again and again')
})

test('a photo is opened the right way up, and one the quick way cannot open is tried as an image', async () => {
  const file = { type: 'image/jpeg', size: 3_000_000 }
  const calls = []
  const bitmap = { width: 4032, height: 3024, close() {} }
  const quick = pipeline({ createImageBitmap: async (...args) => { calls.push(args); return bitmap } })
  assert.equal(await quick.decodePicture(file), bitmap)
  assert.equal(calls[0][0], file)
  assert.equal(calls[0][1]?.imageOrientation, 'from-image', 'a phone photo taken on its side would be drawn on its side')

  // createImageBitmap refuses some files a plain image still opens, and is missing in older
  // browsers. The image is pointed at a blob: address for the file, which is let go of after.
  class OpensImage { set src(value) { this.loadedFrom = value; queueMicrotask(() => this.onload?.()) } }
  for (const createImageBitmap of [async () => { throw new DOMException('The source image could not be decoded.') }, undefined]) {
    const page = render(base, { createImageBitmap, Image: OpensImage, expose: ['decodePicture'] })
    const opened = await page.exposed.decodePicture(file)
    assert.ok(opened instanceof OpensImage, 'nothing fell back to an image')
    assert.match(opened.loadedFrom, /^blob:/, 'the image was pointed at something other than the file in hand')
    assert.equal(page.objectUrls.created[0].blob, file)
    assert.deepEqual(page.objectUrls.revoked, [opened.loadedFrom], 'the address made to open the file was kept')
  }

  // Neither can open it - an iPhone HEIC on a browser that does not read them: a sentence.
  class FailsImage { set src(value) { queueMicrotask(() => this.onerror?.(new Error('no'))) } }
  const neither = render(base, { createImageBitmap: async () => { throw new Error('no') }, Image: FailsImage, expose: ['decodePicture'] })
  await assert.rejects(neither.exposed.decodePicture(file), (error) => /JPEG/.test(error.message) && /\.$/.test(error.message))
  assert.equal(neither.objectUrls.revoked.length, 1, 'a file that would not open kept its address')
})

test('a picture that opens bigger than 12000 pixels on a side is refused before any canvas is made', async () => {
  // A canvas that size is gigabytes; a phone tab dies drawing it. Refused with a sentence, and the
  // decoded picture let go of at once.
  const canvases = []
  let closed = 0
  for (const [width, height] of [[16383, 16383], [12001, 10], [10, 12001]]) {
    const { shrinkPicture } = pipeline({
      createImageBitmap: async () => ({ width, height, close() { closed += 1 } }),
      create: (tag) => (tag === 'canvas' ? (canvases.push(tag), { getContext: () => ({ drawImage() {} }), toBlob: (done, type) => done({ type, size: 1 }) }) : undefined)
    })
    await assert.rejects(shrinkPicture({ type: 'image/webp' }, 'portrait'), (error) => /too big/.test(error.message) && /\.$/.test(error.message))
  }
  assert.equal(canvases.length, 0, 'a canvas was made for a picture too big to draw')
  assert.equal(closed, 3, 'a decoded picture too big to draw was kept in memory')
})

test('a chosen picture is drawn from its centre crop at the size it is sent at, and what was opened is closed', async () => {
  const drawn = []
  const canvases = []
  const canvas = () => {
    const made = {
      width: 0, height: 0,
      getContext: () => ({ drawImage: (...args) => drawn.push(args) }),
      toBlob(done, type) { done({ type, size: 9_000 }) }
    }
    canvases.push(made)
    return made
  }
  let closed = 0
  const bitmap = { width: 3000, height: 4000, close() { closed += 1 } }
  const { shrinkPicture } = pipeline({
    createImageBitmap: async () => bitmap,
    create: (tag) => (tag === 'canvas' ? canvas() : undefined)
  })
  const made = await shrinkPicture({ type: 'image/jpeg' }, 'portrait')
  assert.equal(made.type, 'image/webp')
  assert.deepEqual(drawn[0], [bitmap, 0, 500, 3000, 3000, 0, 0, 480, 480], 'the picture was not drawn from its centre square into 480 by 480')
  assert.deepEqual([canvases[0].width, canvases[0].height], [480, 480])
  assert.equal(closed, 1, 'the decoded photo was kept in memory after use')

  // A banner from the same photo: a 21:9 strip across its middle, drawn into 1600 by 686.
  await shrinkPicture({ type: 'image/jpeg' }, 'banner')
  assert.deepEqual(drawn[1], [bitmap, 0, 1357, 3000, 1286, 0, 0, 1600, 686])
  assert.equal(closed, 2)
})

/* ---------- Personalise: the controls -------------------------------------------------------------
   With a store connected, every Team card opens to a Personalise section - its name, Choose a
   picture, Describe it and Make it, Back to the default - and each banner has a small Personalise
   button for its own picture. "Make it yours" in the Team banner opens the assistant's name and the
   art style straight under the banner, with no dialog. With personalising off, that button is the
   only new thing on the board, and it opens to the one sentence saying how to switch it on.

   Every write carries the view key, the edit key once there is one, and the exact Content-Type the
   server's write gate insists on. A picture is shrunk on the device, sent as its bytes and shown from
   the copy in hand. And a picture arriving never redraws a screen: it is put into its own place, so
   a form somebody is halfway through typing is still there when it lands. */

const jsonAnswer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
// What /api/generate sends back: a picture's bytes, never JSON.
const madePicture = (made) => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token R') }, blob: async () => made })
// /api/brand with OpenAI connected, as the server words it, and some of the day already spent.
const brandMaking = (over = {}) => ({ ...brandOn(), canGenerate: true, why: '', left: { writes: 7, generated: 3 }, ...over })

// A browser that answers the board, the brand it is given and the pictures, and hands every write to
// `writes` - recording each request with its method, headers and body.
function writingBrowser({ brand = brandOn(), writes = () => jsonAnswer(500, {}) } = {}) {
  const requests = []
  const fetch = async (url, init = {}) => {
    const request = { url: String(url), method: init.method ?? 'GET', headers: { ...(init.headers ?? {}) }, body: init.body }
    requests.push(request)
    if (request.method === 'POST') return writes(request)
    if (request.url.startsWith('/api/brand')) return jsonAnswer(200, brand)
    if (request.url.startsWith('/api/art')) return { ok: true, status: 200, json: async () => ({}), blob: async () => ({ type: 'image/webp', size: 2048 }) }
    return jsonAnswer(200, pinnedPayload)
  }
  return { fetch, requests, posts: () => requests.filter((request) => request.method === 'POST'), art: () => requests.filter((request) => request.url.startsWith('/api/art')) }
}

// localStorage holding these keys, recording every write the page makes to it.
function keyStorage(held = {}) {
  const values = { ...held }
  const writes = []
  return {
    writes,
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => { values[key] = String(value); writes.push([key, String(value)]) },
    removeItem: (key) => { delete values[key]; writes.push([key, null]) }
  }
}
const VIEW_ONLY = { 'agent-cockpit-view-key': 'the-view-key' }

// A canvas and a decoder, so a picture can be shrunk in node: whatever is drawn comes out as a small
// webp marked as shrunk, and every picture opened is recorded.
function shrinker() {
  const opened = []
  return {
    opened,
    createImageBitmap: async (source) => { opened.push(source); return { width: 2000, height: 1500, close() {} } },
    create: (tag) => (tag === 'canvas'
      ? { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toBlob(done, type) { done({ type, size: 9_000, shrunk: true }) } }
      : undefined)
  }
}

// The parts of the page one control touches: the box it sits in and that box's note, and - for a
// card's name - the card around it. Anything else it asks for, it is told is not there.
const noteStand = () => ({ className: 'fire-note', textContent: '' })
function pictureBox() {
  const note = noteStand()
  return { note, querySelector: (selector) => (selector === '.fire-note' ? note : null), querySelectorAll: () => [] }
}
const fileInput = (slot, file, box) => ({
  dataset: { upload: slot }, files: [file], value: 'C:\\fakepath\\photo.jpg',
  closest: (selector) => (selector === '.picture-controls' ? box : null)
})
function makeForm(slot, words, box) {
  const field = { value: words }
  return { dataset: { make: slot }, field, querySelector: (selector) => (selector === 'textarea' ? field : null), closest: (selector) => (selector === '.picture-controls' ? box : null) }
}
function changeForm({ change, slug, value = '', card = null }) {
  const note = noteStand()
  const field = { value }
  const form = {
    dataset: slug ? { change, slug } : { change }, note, field,
    querySelector: (selector) => (selector === '.fire-note' ? note : selector === 'input, textarea' ? field : null),
    querySelectorAll: () => [],
    closest: (selector) => (selector === 'form[data-change]' ? form : selector === '.agent-card' ? card : null)
  }
  return form
}
// A card, holding its display name the way the page leaves it: as text in a span it makes.
function cardStand() {
  const classes = new Set()
  let label = null
  const body = { insertAdjacentHTML: (where, markup) => { if (where === 'afterbegin' && /class="display-name"/.test(markup)) label = { textContent: '', remove: () => { label = null } } } }
  return {
    classes,
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
    querySelector: (selector) => (selector === '.display-name' ? label : selector === '.agent-body' ? body : null),
    shownName: () => label?.textContent ?? null
  }
}

// Does to the page what the browser would on an event: every listener the page put on the document
// for that kind of event hears it, and then whatever it started is let run.
async function dispatch(nodes, type, target) {
  const event = { target, prevented: false, preventDefault() { this.prevented = true } }
  for (const listener of nodes.documentListeners) if (listener.type === type) listener.handler(event)
  await flush(8)
  return event
}
// A control the page's click listener can be handed: it is its own closest match for `own`, and
// sits in nothing else.
const pressable = (own, extra = {}) => {
  const control = { ...extra, closest: (selector) => (selector === own ? control : extra.closest?.(selector) ?? null) }
  return control
}

const EVERY_TEMPLATE_AGENT = [...new Set([...SHIPPED_PORTRAITS, 'research', 'email', 'content', 'sales', 'editor', 'security', 'bookkeeper'])]

test('with personalising off, Make it yours opens straight under the banner to the one sentence saying how to switch it on', () => {
  const placed = []
  let panel = null
  const banner = { insertAdjacentHTML: (where, markup) => { placed.push({ where, markup }); panel = { removed: false, remove() { this.removed = true; panel = null } } } }
  const nodes = render(pinnedPayload, {
    find: (id, selector) => (id !== 'team' ? undefined : selector === '.team-banner' ? banner : selector === '#brand-panel' ? panel : undefined),
    expose: ['toggleBrandPanel']
  })
  const button = { attributes: {}, setAttribute(name, value) { this.attributes[name] = String(value) } }
  nodes.exposed.toggleBrandPanel(button)
  assert.equal(placed.length, 1, 'pressing Make it yours put nothing on the screen')
  assert.equal(placed[0].where, 'afterend', 'the sentence is not straight under the banner')
  const words = textOf(placed[0].markup)
  assert.match(words, /Private Blob store/, 'the sentence does not say what to create')
  assert.match(words, /Vercel/)
  assert.match(words, /redeploy/i, 'the sentence leaves out the redeploy, the step most people miss')
  assert.equal((words.match(/[.!?](?=\s|$)/g) ?? []).length, 1, `that is not one sentence: ${words}`)
  assert.ok(!/<(form|input|button|textarea|select|label)\b/.test(placed[0].markup), 'with personalising off the panel offers controls that cannot work')
  assert.equal(button.attributes['aria-expanded'], 'true', 'a screen reader is not told it opened')

  const first = panel
  nodes.exposed.toggleBrandPanel(button)
  assert.ok(first.removed, 'pressing it again left the sentence on the screen')
  assert.equal(placed.length, 1, 'pressing it again put a second one up')
  assert.equal(button.attributes['aria-expanded'], 'false')
})

test('with a store that is connected but broken, Make it yours shows the server\'s sentence, not how to switch it on', async () => {
  // Switching it on is not the fix for a damaged settings file or a public store, and saying so
  // would send the owner round in circles. The server says which it is; the page shows that.
  const said = 'The board\'s settings file in the picture store is damaged, so delete it <b>now</b>.'
  const placed = []
  const banner = { insertAdjacentHTML: (where, markup) => { placed.push(markup) } }
  for (const [answer, expected] of [
    [{ enabled: false, fault: true, why: said }, 'The board&#39;s settings file in the picture store is damaged, so delete it &lt;b&gt;now&lt;/b&gt;.'],
    [{ enabled: false, why: said }, 'Private Blob store']
  ]) {
    placed.length = 0
    const browser = writingBrowser({ brand: answer })
    const nodes = render(pinnedPayload, {
      fetch: browser.fetch, storage: keyStorage(VIEW_ONLY),
      find: (id, selector) => (id !== 'team' ? undefined : selector === '.team-banner' ? banner : undefined),
      expose: ['toggleBrandPanel']
    })
    await flush()
    nodes.exposed.toggleBrandPanel({ setAttribute() {} })
    assert.equal(placed.length, 1)
    assert.ok(placed[0].includes(expected), `the panel says: ${placed[0]}`)
    assert.ok(!/<(form|input|button|textarea)\b/.test(placed[0]), 'the panel offers controls that cannot work')
  }
})

test('with personalising on, nothing drawn above the first agent card names an agent or says "content"', () => {
  // The older Team tests find a card by the first place its slug appears, and the template has an
  // agent called content. Everything personalising draws above the cards - the banner's buttons, its
  // picture controls, the open Make it yours panel - has to stay clear of both.
  const names = Object.fromEntries(EVERY_TEMPLATE_AGENT.map((slug, index) => [slug, `Helper ${index + 1}`]))
  for (const canGenerate of [true, false]) {
    const brand = { ...brandOn({ team: webpAt(V1) }), canGenerate, why: canGenerate ? '' : brandOn().why, names, defaultArtStyle: DEFAULT_ART_STYLE }
    const drawn = render({ ...base, agents: EVERY_TEMPLATE_AGENT.map((slug) => agent({ slug })) }, { state: { brand, brandPanelOpen: true } }).get('team').innerHTML
    const first = drawn.indexOf('<details class="agent-card')
    assert.ok(first > 0, 'there are no cards to be above')
    const above = drawn.slice(0, first)
    // The control: what personalising adds above the cards really is in this slice.
    for (const part of ['id="brand-panel"', 'data-personalise="team"', 'data-upload="team"', 'data-reset="team"', 'Make it yours', 'data-change="style"']) {
      assert.ok(above.includes(part), `${part} is not above the cards, so this checks less than it says`)
    }
    if (canGenerate) assert.ok(above.includes('data-make="team"'), 'Make it is not offered for the Team banner')
    assert.ok(!/content/i.test(above), `"content" appears above the first card (canGenerate ${canGenerate})`)
    for (const slug of EVERY_TEMPLATE_AGENT) {
      assert.ok(!above.includes(slug), `"${slug}" appears above the cards, so a slice from it misses its card`)
      assert.ok(drawn.indexOf(slug) >= first)
    }
  }
})

test('a display name is drawn above the slug, and the slug stays what the card is found and routed by', () => {
  const brand = { ...brandOn(), names: { research: 'Penny' } }
  const drawn = render({ ...base, agents: [agent({ slug: 'research' }), agent({ slug: 'email' })] }, { state: { brand } }).get('team').innerHTML
  const cards = teamCards(drawn)
  assert.deepEqual(Object.keys(cards).sort(), ['email', 'research'], 'a card is no longer found by its slug')
  const penny = cards.research
  assert.match(penny.slice(0, penny.indexOf('>')), /class="agent-card[^"]*\bnamed\b/, 'the named card is not marked, so its slug is not drawn smaller')
  const summary = penny.slice(0, penny.indexOf('</summary>'))
  const nameAt = summary.indexOf('<span class="display-name">Penny</span>')
  assert.ok(nameAt > 0, 'the display name is not on the card')
  assert.ok(nameAt < summary.indexOf('<span class="title">research</span>'), 'the display name is not above the slug')
  assert.ok(!/class="display-name"/.test(cards.email), 'an agent with no name of its own was given one')
  assert.ok(!/\bnamed\b/.test(cards.email.slice(0, cards.email.indexOf('>'))))

  // Personalise is in the drawer. In the summary, a tap on any of it would open and shut the card.
  assert.ok(!/data-change|data-upload|data-make|data-reset|<form|<input|<textarea/.test(summary), 'a Personalise control is inside the part of the card a tap opens')
  const drawer = penny.slice(penny.indexOf('</summary>'))
  assert.match(drawer, /<form class="fire-form" data-change="name" data-slug="research">/, 'the name is not saved against the slug')
  assert.match(drawer, /id="name-research"[^>]*value="Penny"/)
  assert.match(drawer, /data-upload="agent-research"/, 'the picture is not kept against the slug')
  assert.match(textOf(drawer), /research/, 'the drawer does not say what jobs still call this agent')
})

test('a display name, the assistant\'s name and the art style are drawn as text, never as markup', () => {
  const hostile = '<img src=x onerror=alert(1)>'
  const brand = { ...brandMaking(), names: { research: hostile }, assistantName: hostile, artStyle: `${hostile} "quoted"` }
  const drawn = render({ ...base, agents: [agent({ slug: 'research' })] }, { state: { brand, brandPanelOpen: true } }).get('team').innerHTML
  assert.ok(!drawn.includes('<img src=x'), 'something the owner typed was drawn as markup')
  const escaped = '&lt;img src=x onerror=alert(1)&gt;'
  assert.ok(cardOf(drawn, 'research').includes(`<span class="display-name">${escaped}</span>`), 'the display name is not shown as the words typed')
  assert.ok(drawn.includes(`id="name-research" class="brand-field" type="text" maxlength="40" autocomplete="off" value="${escaped}"`), 'the name field does not hold the words typed')
  assert.ok(drawn.includes(`id="brand-assistant" class="brand-field" type="text" maxlength="40" autocomplete="off" value="${escaped}"`), 'the assistant field does not hold the words typed')
  assert.ok(drawn.includes(`${escaped} &quot;quoted&quot;</textarea>`), 'the art style is not shown as the words typed')
})

test('each card opens to Personalise: a name, Choose a picture, Describe it and Make it, and Back to the default', () => {
  const drawn = render({ ...base, agents: [agent({ slug: 'research' })] }, { state: { brand: brandMaking() } }).get('team').innerHTML
  const card = cardOf(drawn, 'research')
  const drawer = card.slice(card.indexOf('</summary>'))
  const name = /<input\b[^>]*id="name-research"[^>]*>/.exec(drawer)?.[0] ?? assert.fail('the card has no name field')
  assert.match(name, /type="text"/)
  assert.match(name, /maxlength="40"/, 'the field takes more than the 40 characters the server keeps')
  assert.match(drawer, /<label for="name-research">/, 'the name field has no label')
  // The file input sits inside a label drawn as a button, so the whole button opens the picker, and
  // image/* is what makes a phone offer its camera and its photo library. No capture attribute: that
  // would force the camera and hide the library.
  const chooser = /<label class="fire">([\s\S]*?)<\/label>/.exec(drawer)?.[1] ?? assert.fail('there is no Choose a picture button')
  assert.match(chooser, /^Choose a picture/)
  const input = /<input\b[^>]*type="file"[^>]*>/.exec(chooser)?.[0] ?? assert.fail('Choose a picture has no file input in it')
  assert.match(input, /accept="image\/\*"/)
  assert.match(input, /class="visually-hidden"/, 'the browser\'s own file box is drawn as well as the button')
  assert.match(input, /data-upload="agent-research"/)
  assert.ok(!/\bcapture\b/.test(input), 'the picker is forced to the camera, so a saved photo cannot be chosen')
  const make = /<form class="fire-form" data-make="agent-research">[\s\S]*?<\/form>/.exec(drawer)?.[0] ?? assert.fail('there is no Make it')
  assert.match(make, /<label for="describe-agent-research">Describe it<\/label>/)
  assert.match(make, /<textarea id="describe-agent-research"[^>]*maxlength="400"/, 'the description takes more than the server will read')
  assert.match(make, /<button class="fire" type="submit">Make it<\/button>/)
  assert.match(drawer, /<button class="fire" type="button" data-reset="agent-research">Back to the default<\/button>/)
})

test('with no change left today, every Make it is off and says why, and pressing it sends nothing', async () => {
  // A made picture is kept by an upload, which is a change. With none left, Make it would only
  // charge OpenAI for a picture the board could not keep (the server refuses it too).
  const none = render(pinnedPayload, { state: { brand: brandMaking({ left: { writes: 0, generated: 3 } }) } })
  const drawn = none.get('today').innerHTML + none.get('team').innerHTML
  const makes = [...drawn.matchAll(/<form class="fire-form" data-make="[^"]+">[\s\S]*?<\/form>/g)].map((found) => found[0])
  assert.equal(makes.length, 2 + pinnedPayload.agents.length)
  for (const make of makes) {
    assert.match(make, /<button class="fire" type="submit" disabled>Make it<\/button>/, 'Make it can still be pressed')
    assert.match(make, /<span class="small muted no-change-left">No changes are left today/, 'nothing says why Make it is off')
  }
  // With a change left, Make it is on and the sentence is drawn hidden, for the moment one runs out.
  const some = render(pinnedPayload, { state: { brand: brandMaking({ left: { writes: 1, generated: 3 } }) } })
  const today = some.get('today').innerHTML
  assert.ok(!/type="submit" disabled>Make it/.test(today), 'Make it is off with a change still left')
  assert.match(today, /<span class="small muted no-change-left" hidden>No changes are left today/, 'the sentence shows with a change still left')

  // Pressed anyway (a stale screen, a keyboard): refused on the page, before OpenAI is asked.
  const browser = writingBrowser({ brand: brandMaking({ left: { writes: 0, generated: 3 } }) })
  const nodes = render(pinnedPayload, { fetch: browser.fetch, storage: keyStorage(VIEW_ONLY) })
  await flush()
  const box = pictureBox()
  await dispatch(nodes, 'submit', makeForm('team', 'a lighthouse at dusk', box))
  assert.equal(browser.posts().length, 0, 'a picture was asked for with no change left to keep it')
  assert.equal(box.note.className, 'fire-note bad')
  assert.match(box.note.textContent, /No changes are left today/)
})

test('with no OpenAI key, Make it is not offered anywhere and one sentence says why', () => {
  const why = 'Making pictures from words is off: set OPENAI_API_KEY in Vercel (the same key the voice assistant uses) and redeploy. Choosing your own picture still works.'
  const nodes = render(pinnedPayload, { state: { brand: { ...brandOn(), why } } })
  const today = nodes.get('today').innerHTML
  const team = nodes.get('team').innerHTML
  assert.ok(!/data-make=/.test(today + team), 'Make it is offered with no key to make anything with')
  assert.ok(!/Describe it/.test(today + team))
  // One sentence where each Make it would have been: Today's banner, Team's banner, and four cards.
  assert.equal(today.split(why).length - 1, 1, 'Today\'s picture controls do not say why')
  assert.equal(team.split(why).length - 1, 1 + pinnedPayload.agents.length, 'the Team controls do not each say why')
  for (const slot of ['today', 'team', 'agent-research']) assert.ok((today + team).includes(`data-upload="${slot}"`), `choosing a picture went too, for ${slot}`)
})

test('each banner has a Personalise button that opens its own picture controls, straight under it', () => {
  const nodes = render(pinnedPayload, { state: { brand: brandMaking() }, expose: ['togglePersonalise', 'el'] })
  for (const slot of ['today', 'team']) {
    const drawn = nodes.get(slot).innerHTML
    const banner = slot === 'today' ? bannerOf(drawn) : teamBannerOf(drawn)
    assert.ok(banner.includes(`<button class="fire banner-btn" type="button" data-personalise="${slot}" aria-expanded="false">Personalise</button>`),
      `the ${slot} banner has no Personalise button`)
    const after = drawn.slice(drawn.indexOf(banner) + banner.length)
    assert.ok(after.startsWith(`<div class="panel banner-personalise" id="personalise-${slot}" hidden>`), `the ${slot} picture controls are not straight under its banner, shut`)
    const block = after.slice(0, after.indexOf(slot === 'today' ? '<div class="kpis">' : 'class="panel add-panel"'))
    for (const part of [`data-upload="${slot}"`, `data-make="${slot}"`, `data-reset="${slot}"`]) assert.ok(block.includes(part), `the ${slot} controls have no ${part}`)

    // As drawn: shut.
    const controls = nodes.exposed.el(`personalise-${slot}`)
    controls.hidden = true
    const button = { dataset: { personalise: slot }, attributes: {}, setAttribute(name, value) { this.attributes[name] = String(value) } }
    nodes.exposed.togglePersonalise(button)
    assert.equal(controls.hidden, false, `pressing Personalise did not open the ${slot} controls`)
    assert.equal(button.attributes['aria-expanded'], 'true')
    nodes.exposed.togglePersonalise(button)
    assert.equal(controls.hidden, true, `pressing it again did not put the ${slot} controls away`)
    assert.equal(button.attributes['aria-expanded'], 'false')
  }
})

test('what is left of today\'s allowance is shown beside the controls, in words', () => {
  const leftLine = (drawn) => [...drawn.matchAll(/<p class="small muted allowance">([^<]*)<\/p>/g)].map((found) => found[1])
  const making = render(pinnedPayload, { state: { brand: brandMaking({ left: { writes: 7, generated: 3 } }), brandPanelOpen: true } })
  const lines = [...leftLine(making.get('today').innerHTML), ...leftLine(making.get('team').innerHTML)]
  // Today's banner, Team's banner, the Make it yours panel, and every card.
  assert.equal(lines.length, 3 + pinnedPayload.agents.length, 'some controls do not say what is left')
  assert.ok(lines.every((line) => line === 'Left today: 7 changes and 3 new pictures.'), lines.join(' | '))
  const one = render(pinnedPayload, { state: { brand: brandMaking({ left: { writes: 1, generated: 1 } }) } })
  assert.deepEqual([...new Set(leftLine(one.get('today').innerHTML))], ['Left today: 1 change and 1 new picture.'])
  // Pictures from words that cannot be made are not counted out loud.
  const off = render(pinnedPayload, { state: { brand: { ...brandOn(), left: { writes: 0, generated: 10 } } } })
  assert.deepEqual([...new Set(leftLine(off.get('today').innerHTML))], ['Left today: 0 changes.'])
})

test('a chosen picture is shrunk, sent as its bytes with both keys and the exact type, and shown from the copy in hand', async () => {
  const browser = writingBrowser({
    brand: brandOn({ 'agent-research': webpAt(V1) }),
    writes: () => jsonAnswer(200, { slot: 'agent-research', picture: { v: V2, type: 'image/webp' }, left: { writes: 6, generated: 10 } })
  })
  const holders = artHolders()
  const pictures = shrinker()
  const nodes = render(pinnedPayload, {
    fetch: browser.fetch, select: holders.select, storage: keyStorage({ ...VIEW_ONLY, 'agent-cockpit-edit-key': 'the-edit-key' }),
    createImageBitmap: pictures.createImageBitmap, create: pictures.create, expose: ['showScreen', 'allowanceText']
  })
  await flush()
  nodes.exposed.showScreen('team')
  await flush()
  const before = holders.srcOf('agent-research')
  const fetchedBefore = browser.art().length

  const box = pictureBox()
  const photo = { type: 'image/jpeg', size: 1_800_000 }
  const input = fileInput('agent-research', photo, box)
  await dispatch(nodes, 'change', input)

  assert.equal(browser.posts().length, 1, 'choosing a picture did not send it')
  const [sent] = browser.posts()
  assert.equal(sent.url, '/api/upload?slot=agent-research')
  assert.equal(sent.headers['Content-Type'], 'application/octet-stream', 'the bytes went with a type the write gate refuses')
  assert.equal(sent.headers['x-view-key'], 'the-view-key')
  assert.equal(sent.headers['x-edit-key'], 'the-edit-key')
  assert.equal(pictures.opened[0], photo, 'the photo chosen was not the one opened')
  assert.equal(sent.body?.shrunk, true, 'the photo was sent as it came off the camera, not shrunk first')

  const made = nodes.objectUrls.created.at(-1)
  assert.equal(made.blob, sent.body, 'what is shown is not the bytes that were sent')
  assert.equal(holders.srcOf('agent-research'), made.url, 'the card does not show the picture just sent')
  assert.ok(nodes.objectUrls.revoked.includes(before), 'the picture it replaced kept its address')
  assert.equal(browser.art().length, fetchedBefore, 'the picture just sent was fetched straight back')
  assert.equal(input.value, '', 'choosing the same photo again would do nothing')
  assert.equal(box.note.className, 'fire-note ok')
  assert.equal(nodes.exposed.allowanceText(), 'Left today: 6 changes.', 'the allowance did not come down')
})

test('Make it sends the description as JSON, puts what comes back through the same shrink, and sends that', async () => {
  const fromOpenAi = { type: 'image/webp', size: 1_400_000 }
  const browser = writingBrowser({
    brand: brandMaking({ left: { writes: 5, generated: 2 } }),
    writes: (request) => (request.url === '/api/generate'
      ? madePicture(fromOpenAi)
      : jsonAnswer(200, { slot: 'team', picture: { v: V2, type: 'image/webp' }, left: { writes: 4, generated: 1 } }))
  })
  const holders = artHolders()
  const pictures = shrinker()
  const nodes = render(pinnedPayload, {
    fetch: browser.fetch, select: holders.select, storage: keyStorage(VIEW_ONLY),
    createImageBitmap: pictures.createImageBitmap, create: pictures.create, expose: ['allowanceText']
  })
  await flush()
  const box = pictureBox()
  const form = makeForm('team', '  a lighthouse at dusk  ', box)
  const event = await dispatch(nodes, 'submit', form)
  assert.ok(event.prevented, 'the form was left to submit itself and leave the page')

  const [generate, upload] = browser.posts()
  assert.equal(generate?.url, '/api/generate')
  assert.equal(generate.headers['Content-Type'], 'application/json')
  assert.equal(generate.headers['x-view-key'], 'the-view-key')
  assert.ok(!('x-edit-key' in generate.headers), 'an edit key nobody gave was sent')
  assert.deepEqual(JSON.parse(generate.body), { slot: 'team', description: 'a lighthouse at dusk' })
  assert.equal(pictures.opened[0], fromOpenAi, 'the picture OpenAI made was not the one shrunk')
  assert.equal(upload?.url, '/api/upload?slot=team')
  assert.equal(upload.headers['Content-Type'], 'application/octet-stream')
  assert.equal(upload.body?.shrunk, true, 'the made picture was sent at its full size')
  assert.equal(holders.srcOf('team'), nodes.objectUrls.created.at(-1).url, 'the banner does not show the picture just made')
  assert.equal(form.field.value, '', 'the description stayed in the box after the picture was made')
  assert.equal(box.note.className, 'fire-note ok')
  assert.equal(nodes.exposed.allowanceText(), 'Left today: 4 changes and 1 new picture.')

  // Too short to describe anything: refused here, with nothing spent.
  const short = makeForm('team', 'ab', pictureBox())
  await dispatch(nodes, 'submit', short)
  assert.equal(browser.posts().length, 2, 'a two-letter description was sent to OpenAI')
})

test('Back to the default drops the store picture and puts the built-in one back in its place', async () => {
  const browser = writingBrowser({ brand: brandOn({ today: webpAt(V1) }), writes: () => jsonAnswer(200, { ...brandOn({}), left: { writes: 9, generated: 10 } }) })
  const holders = artHolders()
  const nodes = render(pinnedPayload, { fetch: browser.fetch, select: holders.select, storage: keyStorage(VIEW_ONLY) })
  await flush()
  const shown = holders.srcOf('today')
  assert.match(shown ?? '', /^blob:/, 'the owner\'s banner never landed, so there is nothing to put back')
  const box = pictureBox()
  const button = pressable('button[data-reset]', { dataset: { reset: 'today' }, closest: (selector) => (selector === '.picture-controls' ? box : null) })
  await dispatch(nodes, 'click', button)

  const [sent] = browser.posts()
  assert.equal(sent?.url, '/api/brand')
  assert.equal(sent.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(sent.body), { change: 'reset-picture', slot: 'today' })
  assert.equal(holders.srcOf('today'), '/art/today-harbour.webp', 'the harbour did not come back')
  assert.deepEqual(nodes.objectUrls.revoked, [shown], 'the picture taken away kept its address')
  assert.equal(box.note.className, 'fire-note ok')

  // Already the default: nothing to take away, so no write is spent on it.
  await dispatch(nodes, 'click', button)
  assert.equal(browser.posts().length, 1, 'a write was spent on a picture that is already the default')
  assert.match(box.note.textContent, /already/)
})

test('a new name is saved and shown on the card at once, and an empty one goes back to the slug', async () => {
  let names = { research: 'Penny' }
  const browser = writingBrowser({ writes: () => jsonAnswer(200, { ...brandOn(), names }) })
  const nodes = render(pinnedPayload, { fetch: browser.fetch, storage: keyStorage(VIEW_ONLY) })
  await flush()
  const card = cardStand()
  const form = changeForm({ change: 'name', slug: 'research', value: '  Penny ', card })
  const event = await dispatch(nodes, 'submit', form)
  assert.ok(event.prevented)
  const [sent] = browser.posts()
  assert.equal(sent?.url, '/api/brand')
  assert.equal(sent.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(sent.body), { change: 'name', slug: 'research', value: 'Penny' })
  assert.equal(card.shownName(), 'Penny', 'the card does not show its new name')
  assert.ok(card.classes.has('named'), 'the slug under the name is not drawn smaller')
  assert.equal(form.field.value, 'Penny')
  assert.equal(form.note.className, 'fire-note ok')

  names = {}
  form.field.value = ''
  await dispatch(nodes, 'submit', form)
  assert.deepEqual(JSON.parse(browser.posts()[1].body), { change: 'name', slug: 'research', value: '' })
  assert.equal(card.shownName(), null, 'an emptied name is still on the card')
  assert.ok(!card.classes.has('named'))
})

test('the assistant\'s name and the art style are saved from Make it yours, and the style can go back to the default', async () => {
  let answer = { ...brandOn(), assistantName: 'Iris' }
  const browser = writingBrowser({ writes: () => jsonAnswer(200, answer) })
  const nodes = render(pinnedPayload, { fetch: browser.fetch, storage: keyStorage(VIEW_ONLY) })
  await flush()
  const assistant = changeForm({ change: 'assistant', value: 'Iris' })
  await dispatch(nodes, 'submit', assistant)
  assert.deepEqual(JSON.parse(browser.posts()[0].body), { change: 'assistant', value: 'Iris' })
  assert.equal(assistant.note.className, 'fire-note ok')

  answer = { ...brandOn(), artStyle: 'Watercolour foxes.' }
  const style = changeForm({ change: 'style', value: 'Watercolour foxes.' })
  await dispatch(nodes, 'submit', style)
  assert.deepEqual(JSON.parse(browser.posts()[1].body), { change: 'style', value: 'Watercolour foxes.' })

  // Back to the default sends an empty style, and the box then shows the default it went back to.
  answer = { ...brandOn(), artStyle: '' }
  const plain = pressable('button[data-default-style]', { dataset: { defaultStyle: '1' }, closest: (selector) => (selector === 'form[data-change]' ? style : null) })
  await dispatch(nodes, 'click', plain)
  assert.deepEqual(JSON.parse(browser.posts()[2].body), { change: 'style', value: '' })
  assert.equal(style.field.value, brandOn().defaultArtStyle, 'the box does not show the default style it went back to')
})

test('the edit key is asked for once, only when the store says it needs one, kept on the device, and the change sent again with it', async () => {
  const needsKey = { needs: 'edit-key', error: 'Missing or wrong edit key. Send it in the x-edit-key header.' }
  const browser = writingBrowser({
    brand: brandOn({ today: webpAt(V1) }),
    writes: (request) => (request.headers['x-edit-key'] === 'typed-key' ? jsonAnswer(200, { ...brandOn(), names: { research: 'Penny' } }) : jsonAnswer(401, needsKey))
  })
  const asked = []
  const storage = keyStorage(VIEW_ONLY)
  const nodes = render(pinnedPayload, { fetch: browser.fetch, storage, prompt: (message) => { asked.push(message); return '  typed-key  ' } })
  await flush()
  const form = changeForm({ change: 'name', slug: 'research', value: 'Penny', card: cardStand() })
  await dispatch(nodes, 'submit', form)
  assert.equal(asked.length, 1, 'the edit key was not asked for, or asked for more than once')
  assert.match(asked[0], /EDIT_KEY/, 'the question does not say which key it wants')
  const [first, again] = browser.posts()
  assert.ok(!('x-edit-key' in first.headers), 'a key was sent before there was one')
  assert.equal(again?.headers['x-edit-key'], 'typed-key', 'the change was not sent again with the key typed')
  assert.equal(again.headers['x-view-key'], 'the-view-key')
  assert.equal(again.body, first.body, 'the change sent again is not the change asked for')
  assert.deepEqual(storage.writes, [['agent-cockpit-edit-key', 'typed-key']], 'the edit key was not kept like the view key')
  assert.equal(form.note.className, 'fire-note ok')

  // The next change carries it without asking.
  await dispatch(nodes, 'submit', form)
  assert.equal(asked.length, 1, 'the edit key was asked for again')
  assert.equal(browser.posts()[2].headers['x-edit-key'], 'typed-key')

  // A key the store refuses is not kept; and putting the question away changes nothing.
  const refused = writingBrowser({ writes: () => jsonAnswer(401, needsKey) })
  const kept = keyStorage(VIEW_ONLY)
  const wrong = render(pinnedPayload, { fetch: refused.fetch, storage: kept, prompt: () => 'wrong-key' })
  await flush()
  const tried = changeForm({ change: 'assistant', value: 'Iris' })
  await dispatch(wrong, 'submit', tried)
  assert.equal(refused.posts().length, 2, 'the change was not tried once with the key typed')
  assert.deepEqual(kept.writes.at(-1), ['agent-cockpit-edit-key', null], 'a key the store refused was kept, so every change fails the same way')
  assert.equal(tried.note.className, 'fire-note bad')
  assert.equal(tried.note.textContent, needsKey.error)

  const cancelled = writingBrowser({ writes: () => jsonAnswer(401, needsKey) })
  const nobody = render(pinnedPayload, { fetch: cancelled.fetch, storage: keyStorage(VIEW_ONLY), prompt: () => null })
  await flush()
  const left = changeForm({ change: 'assistant', value: 'Iris' })
  await dispatch(nobody, 'submit', left)
  assert.equal(cancelled.posts().length, 1, 'the change was sent again with no key')
  assert.equal(left.note.className, 'fire-note bad')
  assert.match(left.note.textContent, /edit key/)
})

test('any other refusal shows the server\'s own sentence and never asks for a key', async () => {
  const refusals = [
    [401, { error: 'Missing or wrong view key. Send it in the x-view-key header.' }],
    [403, { error: 'This board is open to everyone, so changes are off. Set EDIT_KEY in your hosting environment and redeploy to turn them on.' }],
    [429, { error: 'This board has made all the changes it allows today, so try again tomorrow (the count starts again at midnight UTC), or raise WRITE_DAILY_CAP in Vercel and redeploy.' }],
    [503, { error: 'This picture store is public and the board only uses private ones, so create a private one, connect it to this project and redeploy.' }]
  ]
  for (const [status, refusal] of refusals) {
    const browser = writingBrowser({ writes: () => jsonAnswer(status, refusal) })
    let asked = 0
    const nodes = render(pinnedPayload, { fetch: browser.fetch, storage: keyStorage(VIEW_ONLY), prompt: () => { asked += 1; return 'k' } })
    await flush()
    const form = changeForm({ change: 'assistant', value: 'Iris' })
    await dispatch(nodes, 'submit', form)
    assert.equal(asked, 0, `a ${status} asked for an edit key`)
    assert.equal(browser.posts().length, 1, `a ${status} was sent again`)
    assert.equal(form.note.className, 'fire-note bad')
    assert.equal(form.note.textContent, refusal.error, `a ${status} did not show the server's sentence`)
  }

  // OpenAI saying no to a description, and the day's pictures used up, are told the same way - and
  // nothing is sent to the store after either.
  for (const refusal of [
    { error: 'OpenAI would not make that picture because of its safety rules, so describe it differently.' },
    { error: 'This board has made all the pictures it allows today, so try again tomorrow (the count starts again at midnight UTC), or raise GENERATE_DAILY_CAP in Vercel and redeploy.' }
  ]) {
    const browser = writingBrowser({ brand: brandMaking(), writes: () => jsonAnswer(refusal.error.startsWith('OpenAI') ? 400 : 429, refusal) })
    const nodes = render(pinnedPayload, { fetch: browser.fetch, storage: keyStorage(VIEW_ONLY) })
    await flush()
    const box = pictureBox()
    await dispatch(nodes, 'submit', makeForm('today', 'a quiet harbour at dusk', box))
    assert.equal(browser.posts().length, 1, 'something was uploaded after the picture was refused')
    assert.equal(box.note.className, 'fire-note bad')
    assert.equal(box.note.textContent, refusal.error)
  }
})

test('a picture arriving is put in its own place, and a form somebody is typing into is left exactly as it is', async () => {
  // Every picture waits until the test lets it through, so the forms can be half-typed first.
  let release
  const held = new Promise((resolve) => { release = resolve })
  const fetch = async (url) => {
    if (String(url).startsWith('/api/brand')) return jsonAnswer(200, brandOn({ today: webpAt(V1), team: webpAt(V1), 'agent-research': webpAt(V1) }))
    if (String(url).startsWith('/api/art')) {
      await held
      return { ok: true, status: 200, json: async () => ({}), blob: async () => ({ type: 'image/webp', size: 2048 }) }
    }
    return jsonAnswer(200, pinnedPayload)
  }
  const holders = artHolders()
  const nodes = render(pinnedPayload, { fetch, select: holders.select, expose: ['showScreen', 'adoptPicture'] })
  await flush()
  nodes.exposed.showScreen('team')
  await flush()
  for (const slot of ['today', 'team', 'agent-research']) assert.equal(holders.srcOf(slot), null, `${slot} had a picture before any arrived`)

  // Somebody opens Add task on Today and Add agent on Team and starts typing. In this harness a screen
  // is its markup, so the half-typed words are written into it: drawing the screen again would put
  // the markup back without them, which is what a phone on a slow connection used to do.
  const typedToday = nodes.get('today').innerHTML.replace('id="task-text" rows="3" maxlength="2200"', 'id="task-text" rows="3" maxlength="2200" data-typed="Call the plumber about')
  const typedTeam = nodes.get('team').innerHTML.replace('id="agent-text" rows="3" maxlength="2200"', 'id="agent-text" rows="3" maxlength="2200" data-typed="Watches my invoices and')
  assert.notEqual(typedToday, nodes.get('today').innerHTML, 'there was no Add task box to type into')
  assert.notEqual(typedTeam, nodes.get('team').innerHTML, 'there was no Add agent box to type into')
  nodes.get('today').innerHTML = typedToday
  nodes.get('team').innerHTML = typedTeam

  release()
  await flush()
  for (const slot of ['today', 'team', 'agent-research']) {
    assert.match(holders.srcOf(slot) ?? '', /^blob:/, `${slot}'s picture arrived and was never put in its place`)
  }
  assert.equal(nodes.get('today').innerHTML, typedToday, 'a picture arriving drew Today again and wiped what was being typed')
  assert.equal(nodes.get('team').innerHTML, typedTeam, 'a picture arriving drew Team again and wiped what was being typed')
  // A portrait goes in after its initial, so it is drawn over it; a banner goes in under its words.
  assert.equal(holders.holder('agent-research').placed[0].where, 'after the tile: afterend')
  assert.equal(holders.holder('today').placed[0].where, 'afterbegin')
  assert.match(holders.holder('agent-research').placed[0].markup, /class="portrait-img"[^>]*width="480" height="480"/)
  assert.match(holders.holder('today').placed[0].markup, /width="1600" height="686"/)

  // A picture just sent lands the same way.
  nodes.exposed.adoptPicture('agent-research', { v: V2, type: 'image/webp' }, { type: 'image/webp', size: 30_000 })
  assert.equal(holders.srcOf('agent-research'), nodes.objectUrls.created.at(-1).url)
  assert.equal(nodes.get('team').innerHTML, typedTeam, 'a picture just sent drew Team again and wiped what was being typed')
})

test('every Personalise control is styled, the slug under a name is smaller, and wide-screen limits come after what they narrow', () => {
  const declared = (selector, options) => Object.assign({}, ...rulesFor(selector, options).map(valuesIn))
  // Choose a picture is a label, so the button rules have to reach it by name.
  for (const property of ['background', 'border', 'color', 'min-height']) {
    assert.ok(exactRules('label.fire').some((rule) => !rule.inMedia && valuesIn(rule)[property]), `Choose a picture declares no ${property}, so it is not drawn as a button`)
  }
  assert.ok(rulesFor('label.fire:focus-within').length, 'a keyboard on the hidden file input shows nowhere on its button')
  // Hidden from sight, never from a screen reader or the keyboard - display: none would do both.
  const hidden = declared('.visually-hidden')
  assert.equal(hidden.position, 'absolute')
  assert.match(hidden['clip-path'] ?? '', /inset\(50%\)/)
  assert.ok(!('display' in hidden) && !('visibility' in hidden), 'the file input is taken out of reach of the keyboard')
  // A name over the slug: the name the larger of the two, and the slug drawn smaller under it - by a
  // rule placed after the one it overrides, or it never reaches a pixel.
  const rem = (value) => Number(/^([\d.]+)rem$/.exec(value ?? '')?.[1] ?? 0)
  const title = exactRules('.agent-card .title').filter((rule) => !rule.inMedia)
  const named = exactRules('.agent-card.named .title').filter((rule) => !rule.inMedia)
  assert.ok(title.length && named.length, 'there is no rule drawing the slug smaller under a name')
  assert.ok(named[0].at > title[0].at, 'the smaller slug is written above the rule it overrides')
  const slugSize = rem(valuesIn(named[0])['font-size'])
  assert.ok(slugSize > 0 && slugSize < rem(declared('.display-name')['font-size']), 'the slug is not smaller than the name over it')
  assert.ok(!('text-transform' in declared('.display-name')) || declared('.display-name')['text-transform'] === 'none',
    'the owner\'s own name is re-cased on the card')
  // The field and the banner button.
  const field = declared('.brand-field')
  for (const property of ['width', 'background', 'border', 'color', 'padding']) assert.ok(field[property], `the name field declares no ${property}: a bare browser box on a dark page`)
  const onArt = Object.assign({}, ...exactRules('button.banner-btn').filter((rule) => !rule.inMedia).map(valuesIn))
  assert.match(onArt.color ?? '', /var\(--on-art\)/, 'the banner button is not in the colour words over a picture take')
  const fire = exactRules('button.fire').find((rule) => !rule.inMedia && valuesIn(rule).background)
  assert.ok(exactRules('button.banner-btn').find((rule) => !rule.inMedia && valuesIn(rule).background)?.at > fire.at,
    'the banner button\'s look is written above the button rule it overrides')
  // On a laptop the forms keep a reading measure, placed after the unconditional form rules.
  const capped = rulesFor('.brand-panel .fire-form', { desktop: true })
  assert.ok(capped.some((rule) => valuesIn(rule)['max-width']), 'the Make it yours forms stretch the width of a laptop')
  assert.ok(capped[0].at > rulesFor('.fire-form').find((rule) => rule.selector === '.fire-form').at)
  assert.ok(rulesFor('.picture-controls', { desktop: true }).some((rule) => valuesIn(rule)['max-width']), 'the picture controls stretch the width of a laptop')
})

/* ---------- Today: Plan limits, under the three numbers -------------------------------------------
   How much of each plan is used, from the reading a collector on the owner's own computer commits.
   It is a reading, never live, and every state says which it is: no reading yet, a reading the board
   could not use, a stale one, a meter that was unavailable, and a window that has reset since. Two
   labels have to be in plain view rather than behind a Why?: "unofficial", because the Claude
   address is not a documented one, and "estimate", because the log count is one. */

const inHours = (hours) => new Date(Date.now() + hours * 3600_000).toISOString()
const usageService = (over = {}) => ({
  computer: 'Mac Mini',
  takenAt: inHours(-2),
  ageHours: 2,
  stale: false,
  plan: { status: 'found', name: 'Max 20x' },
  limits: {
    status: 'found', source: 'unofficial-live', readAt: inHours(-2), why: null,
    windows: [
      { kind: 'five_hour', label: '5-hour', usedPercent: 18, resetsAt: inHours(1), resetSinceReading: false },
      { kind: 'weekly_all', label: 'Weekly', usedPercent: 49, resetsAt: inHours(50), resetSinceReading: false },
      { kind: 'weekly_model', label: 'Weekly, Fable only', usedPercent: 2, resetsAt: inHours(50), resetSinceReading: false }
    ]
  },
  activity: { status: 'found', estimate: true, days: 7, replies: 150, sessions: 6 },
  ...over
})
const usagePayload = (claude = {}, codex = null, over = {}) => ({
  status: 'ok', why: null, read: 1, skipped: 0, unreadable: 0,
  claude: usageService(claude),
  codex: codex ?? usageService({
    plan: { status: 'found', name: 'Pro' },
    limits: { status: 'found', source: 'codex-session-log', readAt: inHours(-9), why: null,
      windows: [{ kind: 'weekly', label: 'Weekly', usedPercent: 0, resetsAt: inHours(100), resetSinceReading: false }] },
    activity: undefined
  }),
  ...over
})
const planLimitsOf = (drawn) => /<section class="plan-limits"[\s\S]*?<\/section>/.exec(drawn)?.[0] ?? assert.fail('Today has no Plan limits section')
const planCards = (section) => Object.fromEntries(
  [...section.matchAll(/<article class="panel card plan-card" data-service="([a-z]+)"[\s\S]*?<\/article>/g)].map((found) => [found[1], found[0]]))
const withoutWhy = (markup) => markup.replace(/<details class="why">[\s\S]*?<\/details>/g, '')
const todayWith = (usage) => render({ ...base, usage }).get('today').innerHTML

test('Plan limits sits directly under the three number cards', () => {
  const drawn = todayWith(usagePayload())
  const kpisEnd = drawn.indexOf('<div class="kpis"')
  const limits = drawn.indexOf('<section class="plan-limits"')
  assert.ok(kpisEnd >= 0 && limits > kpisEnd, 'Plan limits is not after the number cards')
  assert.ok(limits < drawn.indexOf('Which of these actually ring is unknown'), 'something sits between the number cards and Plan limits')
  assert.ok(drawn.includes('<h2>Plan limits</h2>'))
})

test('no usage reading says so in words, and draws no meter and no zero', () => {
  for (const usage of [undefined, null, { status: 'none', why: 'No usage reading has been taken yet.', read: 0, skipped: 0, unreadable: 0, claude: null, codex: null }]) {
    const section = planLimitsOf(todayWith(usage))
    assert.match(textOf(section), /No usage reading yet/)
    assert.match(section, /<code>\/snapshot<\/code>/, 'the empty state does not say what to do')
    assert.ok(!section.includes('<svg'), 'an empty state drew a meter')
    assert.ok(!/\b0%/.test(section), 'an empty state printed a zero')
  }
})

test('a reading the board could not use says why, and what to do', () => {
  const section = planLimitsOf(todayWith({ status: 'unusable', why: 'A usage file is stamped in the future, so its age cannot be trusted.', read: 1, skipped: 0, unreadable: 1, claude: null, codex: null }))
  assert.match(textOf(section), /could not be used/)
  assert.match(textOf(section), /stamped in the future/)
  assert.ok(!section.includes('<svg'))
})

test('a fresh reading draws a ring per window, each one a labelled picture', () => {
  const { claude, codex } = planCards(planLimitsOf(todayWith(usagePayload())))
  assert.ok(claude && codex, 'a card per service')
  const rings = [...claude.matchAll(/<svg class="meter-ring"[^>]*>/g)].map((found) => found[0])
  assert.equal(rings.length, 3)
  for (const ring of rings) {
    assert.match(ring, /role="img"/, 'a ring is a picture with no role')
    assert.match(ring, /aria-label="[^"]+"/, 'a ring has nothing to say to a screen reader')
  }
  assert.match(rings[0], /aria-label="5-hour: 18% used, resets [^"]+"/)
  assert.match(rings[2], /aria-label="Weekly, Fable only: 2% used/)
  assert.match(textOf(claude), /Max 20x/)
  assert.match(textOf(claude), /Taken 2 hr ago on Mac Mini/)
  assert.match(textOf(codex), /\bPro\b/)
})

test('each ring is filled exactly as far as its percentage', () => {
  const claude = planCards(planLimitsOf(todayWith(usagePayload({
    limits: { status: 'found', source: 'unofficial-live', readAt: inHours(-1), why: null, windows: [
      { kind: 'five_hour', label: '5-hour', usedPercent: 18, resetsAt: inHours(1), resetSinceReading: false },
      { kind: 'weekly_all', label: 'Weekly', usedPercent: 112, resetsAt: inHours(9), resetSinceReading: false }
    ] }
  })))).claude
  const arcs = [...claude.matchAll(/<circle class="meter-used[^"]*"[^>]*stroke-dasharray="([\d.]+) ([\d.]+)"/g)]
    .map((found) => Number(found[1]) / Number(found[2]))
  assert.equal(arcs.length, 2)
  assert.ok(Math.abs(arcs[0] - 0.18) < 0.005, `18% drew ${arcs[0]}`)
  // Past the limit is a full ring - it cannot be drawn fuller - and the number says how far past.
  assert.ok(Math.abs(arcs[1] - 1) < 0.005, `112% drew ${arcs[1]}`)
  assert.match(textOf(claude), /112%/)
  assert.match(claude, /meter-used level-bad/, 'a plan past its limit is not marked as one')
  assert.match(claude, /meter-used level-ok/)
})

test('a zero that was really read is drawn as a zero, with an empty ring', () => {
  const { codex } = planCards(planLimitsOf(todayWith(usagePayload())))
  assert.match(textOf(codex), /\b0%/, 'a real reading of nothing used was hidden')
  assert.match(codex, /aria-label="Weekly: 0% used/)
})

test('"unofficial" and "estimate" are in plain view, not behind a Why?', () => {
  const { claude, codex } = planCards(planLimitsOf(todayWith(usagePayload())))
  assert.match(textOf(withoutWhy(claude)), /unofficial/i, 'the unofficial label is hidden or gone')
  assert.match(textOf(withoutWhy(claude)), /estimate/i, 'the estimate label is hidden or gone')
  assert.match(textOf(withoutWhy(claude)), /150 replies/)
  assert.ok(!/\d+%[^<]*repl/.test(claude), 'the estimate carries a percentage')
  // Codex reads its own log, which is a different claim, and says so.
  assert.ok(!/unofficial/i.test(textOf(withoutWhy(codex))), 'Codex is labelled with the Claude address\'s caveat')
  assert.match(textOf(codex), /Codex(&rsquo;|')s own log/)
  // The saved copy is no more official than the live address.
  const saved = planCards(planLimitsOf(todayWith(usagePayload({ limits: { ...usageService().limits, source: 'claude-code-saved' } })))).claude
  assert.match(textOf(withoutWhy(saved)), /unofficial/i)
  assert.match(textOf(saved), /saved copy/i)
})

test('a stale reading says how old it is, in view', () => {
  const { claude } = planCards(planLimitsOf(todayWith(usagePayload({ takenAt: inHours(-11), ageHours: 11, stale: true }))))
  assert.match(textOf(withoutWhy(claude)), /older than 8 hours/)
  assert.match(claude, /class="plan-stale/)
})

test('a window past its reset shows no percentage, and says why', () => {
  const claude = planCards(planLimitsOf(todayWith(usagePayload({
    limits: { status: 'found', source: 'unofficial-live', readAt: inHours(-3), why: null, windows: [
      { kind: 'five_hour', label: '5-hour', usedPercent: null, resetsAt: inHours(-1), resetSinceReading: true },
      { kind: 'weekly_all', label: 'Weekly', usedPercent: 49, resetsAt: inHours(9), resetSinceReading: false }
    ] }
  })))).claude
  // Each meter runs from its own opening to the next one's, so the first piece is the 5-hour alone.
  const [reset] = claude.split('<div class="meter">').slice(1)
  assert.ok(reset, 'no meter for the reset window')
  assert.ok(!/\d%/.test(reset), 'a window that has reset still shows its old percentage')
  assert.ok(!reset.includes('meter-used'), 'a window that has reset still draws its old arc')
  assert.match(reset, /aria-label="5-hour: reset since this reading/)
  assert.match(textOf(reset), /Reset since this reading/)
})

test('unavailable and not found each have a sentence, never a ring', () => {
  const usage = usagePayload(
    { limits: { status: 'unavailable', source: null, readAt: null, why: 'Signed out.', windows: [] }, activity: { status: 'not found' } },
    usageService({ plan: { status: 'not found', name: null }, limits: { status: 'not found', source: null, readAt: null, why: null, windows: [] }, activity: undefined })
  )
  const { claude, codex } = planCards(planLimitsOf(todayWith(usage)))
  assert.match(textOf(claude), /Claude limits were unavailable when this was taken/)
  assert.match(textOf(claude), /Signed out\./, 'the collector\'s reason is not offered')
  assert.match(textOf(codex), /No Codex limits were found on Mac Mini/)
  assert.match(textOf(codex), /plan not found/i)
  for (const card of [claude, codex]) {
    assert.ok(!card.includes('<svg class="meter-ring"'), 'a reading that does not exist drew a ring')
    assert.ok(!/\b0%/.test(card), 'a reading that does not exist printed a zero')
  }
  assert.match(textOf(claude), /No Claude Code logs were found/, 'a missing estimate says nothing')
})

test('files left out of the reading are counted on the page', () => {
  const section = planLimitsOf(todayWith(usagePayload({}, null, { unreadable: 1, skipped: 2, read: 5 })))
  assert.match(textOf(section), /1 usage file could not be used/)
  assert.match(textOf(section), /2 more usage files were not read/)
})

test('everything the reading carries is escaped', () => {
  const hostile = '<img src=x onerror=alert(1)>'
  const drawn = todayWith(usagePayload({
    computer: hostile,
    plan: { status: 'found', name: hostile },
    limits: { status: 'unavailable', source: null, readAt: null, why: hostile, windows: [] }
  }, null, {}))
  const section = planLimitsOf(drawn)
  assert.ok(!section.includes('<img src=x'), 'a name from the repo reached the page as markup')
  assert.ok(section.includes('&lt;img src=x'), 'the hostile name was dropped rather than escaped, so this proves nothing')
  const labelled = todayWith(usagePayload({ limits: { ...usageService().limits, windows: [
    { kind: 'weekly_model', label: 'Weekly, "x" only', usedPercent: 5, resetsAt: inHours(9), resetSinceReading: false }] } }))
  assert.ok(!/aria-label="Weekly, "x"/.test(labelled), 'a quote in a label broke out of its attribute')
})

test('no Plan limits state renders undefined, NaN or [object Object]', () => {
  const states = [
    usagePayload(),
    usagePayload({ stale: true, ageHours: 20, takenAt: inHours(-20), computer: null }),
    usagePayload({ plan: { status: 'unavailable', name: null }, activity: { status: 'unavailable' } }),
    { status: 'unusable', why: 'A usage file could not be read.', read: 1, skipped: 0, unreadable: 1, claude: null, codex: null }
  ]
  for (const usage of states) {
    const section = planLimitsOf(todayWith(usage))
    for (const junk of ['undefined', 'NaN', '[object Object]', 'Infinity', 'null']) {
      assert.ok(!section.includes(junk), `Plan limits rendered "${junk}"`)
    }
  }
})

test('every class Plan limits puts in the markup is one the stylesheet styles', () => {
  const emitted = new Set()
  const section = planLimitsOf(todayWith(usagePayload({ stale: true }, null, { unreadable: 1, skipped: 1 })))
    + planLimitsOf(todayWith(undefined))
  for (const found of section.matchAll(/class="([a-z0-9 -]+)"/g)) {
    for (const name of found[1].split(/\s+/).filter(Boolean)) emitted.add(name)
  }
  assert.ok(emitted.size >= 10, `only found ${emitted.size} classes - the sweep is not reading them`)
  for (const name of emitted) {
    assert.ok(rulesFor(`.${name}`).length || rulesFor(`.${name}`, { desktop: true }).length,
      `Plan limits puts class "${name}" in the markup and no rule anywhere targets it`)
  }
})

test('the meters wrap on a phone rather than taking the page sideways', () => {
  const meters = Object.assign({}, ...exactRules('.meters').filter((rule) => !rule.inMedia).map(valuesIn))
  assert.equal(meters['flex-wrap'], 'wrap', 'three rings in a row that cannot wrap push a phone sideways')
  assert.ok(!('overflow-x' in meters))
  const cards = Object.assign({}, ...exactRules('.plan-cards').filter((rule) => !rule.inMedia).map(valuesIn))
  assert.match(cards['grid-template-columns'] ?? '', /auto-fit/, 'the service cards are a fixed number of columns')
  // A long computer or plan name breaks inside the card.
  const name = Object.assign({}, ...exactRules('.plan-name').filter((rule) => !rule.inMedia).map(valuesIn))
  assert.equal(name['min-width'], '0')
  assert.equal(name['overflow-wrap'], 'anywhere')
})

/* ---------- Today: Subscriptions, inside Usage ----------------------------------------------------
   What the owner says they pay, from `subscriptions:` in stack.yml. It sits in the Usage section
   under the claude.ai sentence, which stays: remaining routine runs still live on claude.ai. One
   total per currency, never converted. A yearly price says it was divided. A line with no price is
   listed and said to be left out, never counted as free. */

const usageSectionOf = (drawn) => {
  const from = drawn.indexOf('<h2>Usage</h2>')
  assert.ok(from >= 0, 'Today has no Usage section')
  return drawn.slice(from)
}
const subsCardOf = (drawn) => /<section class="panel card subs">[\s\S]*?<\/section>/.exec(usageSectionOf(drawn))?.[0] ?? assert.fail('the Usage section has no Subscriptions card')
const subItem = (over = {}) => ({ name: 'Claude Max', service: 'claude', price: 200, currency: 'USD', per: 'month', monthly: 200, planRead: null, mismatch: false, ...over })
const subsPayload = (items, totals, over = {}) => ({
  items, totals, unpriced: items.filter((item) => item.monthly === null).length, unreadable: 0, ...over
})
const todayWithSubs = (subscriptions, usage = undefined) => render({ ...base, subscriptions, usage }).get('today').innerHTML

test('the Usage section keeps its claude.ai sentence, and Subscriptions comes after it', () => {
  const section = usageSectionOf(todayWithSubs(subsPayload([subItem()], [{ currency: 'USD', monthly: 200 }])))
  const link = section.indexOf('https://claude.ai/settings/usage')
  assert.ok(link >= 0, 'the claude.ai usage link is gone')
  assert.ok(section.indexOf('<section class="panel card subs">') > link, 'Subscriptions is not under the claude.ai sentence')
  assert.match(textOf(section), /Subscriptions/)
})

test('no subscriptions recorded says how to add them, and prints no total', () => {
  for (const subscriptions of [undefined, null, subsPayload([], [])]) {
    const card = subsCardOf(todayWithSubs(subscriptions))
    assert.match(textOf(card), /No subscriptions recorded yet/)
    assert.match(card, /<code>\/onboard<\/code>/)
    assert.match(card, /<code>subscriptions:<\/code>/)
    assert.ok(!/\b0\b/.test(textOf(card)), 'an empty list printed a zero')
    assert.ok(!/in total/.test(textOf(card)), 'an empty list printed a total')
  }
})

test('each subscription shows its price, and the total is per currency', () => {
  const card = subsCardOf(todayWithSubs(subsPayload([
    subItem(),
    subItem({ name: 'ChatGPT Pro', service: 'codex' }),
    subItem({ name: 'Perplexity', service: 'perplexity', price: 19.99, currency: 'GBP', monthly: 19.99 })
  ], [{ currency: 'GBP', monthly: 19.99 }, { currency: 'USD', monthly: 400 }])))
  const words = textOf(card)
  assert.match(words, /Claude Max 200 USD a month/)
  assert.match(words, /Perplexity 19\.99 GBP a month/)
  assert.match(words, /19\.99 GBP/)
  assert.match(words, /400 USD/)
  assert.match(words, /never converted/, 'two currencies with no word that they were kept apart')
  // One currency needs no such sentence.
  const single = textOf(subsCardOf(todayWithSubs(subsPayload([subItem()], [{ currency: 'USD', monthly: 200 }]))))
  assert.match(single, /200 USD a month in total/)
  assert.ok(!/never converted/.test(single))
})

test('a yearly price says it was divided by twelve', () => {
  const words = textOf(subsCardOf(todayWithSubs(subsPayload(
    [subItem({ name: 'Domain', service: 'other', price: 99, per: 'year', monthly: 8.25 })],
    [{ currency: 'USD', monthly: 8.25 }]))))
  assert.match(words, /99 USD a year/)
  assert.match(words, /8\.25 USD a month/)
  assert.match(words, /a twelfth|divided by 12/)
})

test('a line with no price is listed and said to be left out of the total', () => {
  const words = textOf(subsCardOf(todayWithSubs(subsPayload([
    subItem(),
    subItem({ name: 'Notion', service: 'other', price: null, currency: null, per: null, monthly: null }),
    subItem({ name: 'Half done', service: 'other', price: 10, currency: null, per: 'month', monthly: null })
  ], [{ currency: 'USD', monthly: 200 }]))))
  assert.match(words, /Notion No price recorded/)
  assert.match(words, /Half done 10 a month/)
  assert.match(words, /2 subscriptions are left out of the total/)
})

test('lines in stack.yml the board would not print are counted, not dropped silently', () => {
  const words = textOf(subsCardOf(todayWithSubs(subsPayload([subItem()], [{ currency: 'USD', monthly: 200 }], { unreadable: 1 }))))
  assert.match(words, /1 line under subscriptions: was not shown/)
})

test('a subscription that disagrees with the plan the usage reading found is pointed out, in view', () => {
  const card = subsCardOf(todayWithSubs(subsPayload(
    [subItem({ name: 'Claude Pro', price: 20, monthly: 20, planRead: 'Max 20x', mismatch: true })],
    [{ currency: 'USD', monthly: 20 }])))
  assert.match(withoutWhy(card), /class="subs-mismatch"/)
  assert.match(textOf(withoutWhy(card)), /usage reading found Max 20x/)
})

test('everything in a subscription line is escaped', () => {
  const hostile = '<img src=x onerror=alert(1)>'
  const card = subsCardOf(todayWithSubs(subsPayload(
    [subItem({ name: hostile, currency: hostile, planRead: hostile, mismatch: true })],
    [{ currency: hostile, monthly: 200 }])))
  assert.ok(!card.includes('<img src=x'), 'a name from stack.yml reached the page as markup')
  assert.ok(card.includes('&lt;img src=x'))
})

test('no Subscriptions state renders undefined, NaN or [object Object]', () => {
  const states = [
    undefined,
    subsPayload([], []),
    subsPayload([subItem(), subItem({ price: null, currency: null, per: null, monthly: null }), subItem({ per: 'year', monthly: 16.67 })],
      [{ currency: 'USD', monthly: 216.67 }], { unreadable: 2 })
  ]
  for (const subscriptions of states) {
    const card = subsCardOf(todayWithSubs(subscriptions))
    for (const junk of ['undefined', 'NaN', '[object Object]', 'Infinity', 'null']) {
      assert.ok(!card.includes(junk), `Subscriptions rendered "${junk}"`)
    }
  }
})

test('every class Subscriptions puts in the markup is one the stylesheet styles', () => {
  const emitted = new Set()
  const markup = subsCardOf(todayWithSubs(subsPayload(
    [subItem({ planRead: 'Max 20x', mismatch: true }), subItem({ per: 'year', monthly: 16.67 }), subItem({ price: null, monthly: null })],
    [{ currency: 'USD', monthly: 216.67 }, { currency: 'GBP', monthly: 1 }], { unreadable: 1 }))) + subsCardOf(todayWithSubs(undefined))
  for (const found of markup.matchAll(/class="([a-z0-9 -]+)"/g)) {
    for (const name of found[1].split(/\s+/).filter(Boolean)) emitted.add(name)
  }
  assert.ok(emitted.size >= 6, `only found ${emitted.size} classes - the sweep is not reading them`)
  for (const name of emitted) {
    assert.ok(rulesFor(`.${name}`).length || rulesFor(`.${name}`, { desktop: true }).length,
      `Subscriptions puts class "${name}" in the markup and no rule anywhere targets it`)
  }
})

test('a long subscription name breaks inside its row rather than taking the phone sideways', () => {
  const name = Object.assign({}, ...exactRules('.subs-name').filter((rule) => !rule.inMedia).map(valuesIn))
  assert.equal(name['overflow-wrap'], 'anywhere')
  assert.equal(name['min-width'], '0')
  const row = Object.assign({}, ...exactRules('.subs-row').filter((rule) => !rule.inMedia).map(valuesIn))
  assert.equal(row['flex-wrap'], 'wrap')
})
