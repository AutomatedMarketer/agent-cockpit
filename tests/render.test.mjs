import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/* Every other test in this repo checks the API, or greps the page source for a string. None of
   them has ever RENDERED a screen. A verifier had to build its own DOM shim to find that the week
   strip still printed times for jobs nothing fires, and that an empty ledger produced a giant "0"
   — both invisible to a regex over the source, both obvious the moment a screen is drawn.
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
  const run = new Function(
    ...Object.keys(context),
    `${script}\n; data = arguments[arguments.length - 1]; render(); return null;`
  )
  run(...Object.values(context), payload)
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
  routines: { takenAt: null, usable: false, stale: false, why: 'no snapshot has been taken yet', count: 0, known: false, orphans: [], problems: [] },
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
   indistinguishable from a real one — and on Today it collected a "was due, no run logged" mark
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
