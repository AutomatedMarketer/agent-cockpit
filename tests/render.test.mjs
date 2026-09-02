import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { shapeHero } from '../api/state.js'

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
        setAttribute() {},
        removeAttribute() {},
        querySelectorAll: () => [],
        querySelector: () => null,
        addEventListener() {},
        closest: () => null,
        appendChild() {},
        focus() {},
        style: {}
      })
    }
    return nodes.get(id)
  }

  const document = {
    getElementById: (id) => node(id),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
    createElement: () => node('scratch'),
    body: node('body'),
    documentElement: node('html')
  }

  const hash = options.hash ?? ''
  const context = {
    document,
    window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), location: { hash }, scrollTo() {}, requestAnimationFrame: (fn) => fn() },
    location: { hash, search: '' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => payload }),
    console,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    JSON,
    Intl
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
  const run = new Function(
    ...Object.keys(context),
    `${script}
     ; data = arguments[arguments.length - 2]
     ; const given = arguments[arguments.length - 1]
     ; if (given.memoryQuery !== undefined) memoryQuery = given.memoryQuery
     ; if (given.memorySource !== undefined) memorySource = given.memorySource
     ; render(); return null;`
  )
  run(...Object.values(context), payload, state)
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
  // same breath that nothing fires it. What it must not do is put it on the week grid.
  const workflows = declared.get('workflows').innerHTML
  assert.match(workflows, /Nothing fires this/, 'the card must say the schedule is a wish')
  assert.ok(!workflows.includes('missed'), 'a job nothing fires cannot have missed a run')
  const strip = workflows.split('<div class="stack">')[0]
  assert.ok(!strip.includes('06:30'), 'the week strip placed a job nothing fires on the calendar')
})

test('an armed job does still appear in the week strip', () => {
  const armed = render({
    ...base,
    workflows: [workflow({ arm: 'armed', armed: true, routineId: 't1', nextRun: new Date(Date.now() + 3600_000).toISOString() })]
  })
  assert.ok(armed.get('workflows').innerHTML.includes('06:30'), 'a real job lost its time')
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
  // appearance in this markup is its own <span class="title"> - the class list and accentStyle()
  // emit only a hex colour, never the slug - so there is nothing earlier to match on.
  const neverRunCard = nodes.slice(nodes.indexOf('research'), nodes.indexOf('email'))
  assert.ok(!neverRunCard.includes('chev'), 'an agent with no runs still invited a tap')
  assert.match(nodes, /1 run logged/, 'a single run was described as "1 runs"')
  assert.ok(!/1 runs logged/.test(nodes))
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
  assert.match(drawn, /each one is listed below/)
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
  const nodes = render({ ...base, workflows: mixed })

  for (const screen of ['today', 'workflows']) {
    const drawn = nodes.get(screen).innerHTML
    assert.match(
      drawn,
      /2 other jobs name a time in their files and nothing fires them/,
      `the ${screen} screen dropped the silent-job count as soon as one job was armed`
    )
    // And it has to come BEFORE the week grid. A caveat read after four columns of a calendar
    // that looks complete has already lost - which is why the arm state prints before the
    // schedule chip everywhere else on this page.
    assert.ok(
      drawn.indexOf('other jobs name a time') < drawn.indexOf('schedule-scroll'),
      `on ${screen} the warning sits under the calendar it is there to undermine`
    )
  }
})

test('one silent job is counted in the singular, alongside something that rings', () => {
  const nodes = render({
    ...base,
    workflows: [
      workflow({ slug: 'rings', name: 'Rings', owner: 'research', schedule: 'daily 06:30', arm: 'armed', armed: true }),
      workflow({ slug: 'silent', name: 'Silent', owner: 'research', schedule: 'daily 07:00', arm: 'declared' })
    ]
  })
  assert.match(nodes.get('today').innerHTML, /1 other job names a time in its file and nothing fires it/)
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
