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
function render(payload) {
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

  const context = {
    document,
    window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), location: { hash: '' }, scrollTo() {}, requestAnimationFrame: (fn) => fn() },
    location: { hash: '', search: '' },
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
