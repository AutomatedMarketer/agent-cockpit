// End-to-end over a stubbed GitHub. Proves all five screens can render a team repo without
// a network, a token, or a live account.
import test from 'node:test'
import assert from 'node:assert/strict'
import handler, { isTaskCard, shapeHero, markOwnerSwitchedOff, shapeSkills, shapeSetup } from '../api/state.js'

// This suite covers the endpoint's data logic, not the view gate - that has its own
// suite in gate.test.mjs. Opting out here keeps every case from carrying a key header.
process.env.PUBLIC_DASHBOARD = 'true'

// Relative, so the fixture stays correct whatever day the suite runs on.
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString().replace(/\.\d+Z$/, 'Z')
const recent = isoAgo(3600_000)
const older = isoAgo(20 * 86400_000)
const freshBeat = isoAgo(5 * 60_000)
const staleBeat = isoAgo(3 * 3600_000)

const TREE = {
  tree: [
    { type: 'blob', path: '.claude/agents/research.md' },
    { type: 'blob', path: '.claude/agents/email.md' },
    { type: 'blob', path: 'runs/2026-08/2026-08-07T0600Z-research.json' },
    { type: 'blob', path: 'runs/2026-08/2026-08-07T0700Z-research.json' },
    { type: 'blob', path: 'runs/2026-08/broken.json' },
    { type: 'blob', path: 'runs/heartbeat/hermes.json' },
    { type: 'blob', path: 'runs/heartbeat/openclaw.json' },
    { type: 'blob', path: 'shared/about-me.md' },
    { type: 'blob', path: 'shared/business-brain.md' },
    { type: 'blob', path: 'shared/writing-rules.md' },
    { type: 'blob', path: 'workflows/monday-brief.yml' },
    { type: 'blob', path: 'workflows/hourly-sweep.yml' },
    { type: 'blob', path: 'workflows/broken.yml' },
    { type: 'blob', path: '.agent-team/routines.json' },
    { type: 'blob', path: 'skills/pull-calendar/SKILL.md' },
    { type: 'blob', path: 'skills/write-brief/SKILL.md' },
    { type: 'blob', path: 'skills/scan-inbox/SKILL.md' },
    { type: 'blob', path: 'tasks/README.md' },
    { type: 'blob', path: 'tasks/2026-08-19-draft-post.md' },
    { type: 'blob', path: 'tasks/2026-08-18-call-supplier.md' },
    { type: 'blob', path: 'runtimes.yml' },
    { type: 'blob', path: 'connections/register.yml' },
    { type: 'blob', path: 'tiles.yml' },
    { type: 'blob', path: 'stack.yml' },
    { type: 'blob', path: 'wiki/INDEX.md', size: 2048 },
    { type: 'blob', path: 'wiki/offers.md', size: 512 },
    { type: 'blob', path: 'inbox/2026-08-07/monday-brief.md', size: 300 },
    { type: 'tree', path: 'agents' },
    { type: 'blob', path: 'README.md' }
  ]
}

const FILES = {
  '.claude/agents/research.md':
    '---\nname: research\ndescription: Looks something up and comes back with links.\nmodel: sonnet\n---\n\n# Research\n',
  '.claude/agents/email.md':
    '---\nname: email\ndescription: Sweeps your inbox and drafts replies.\nmodel: sonnet\n---\n\n# Email\n',
  'runs/2026-08/2026-08-07T0600Z-research.json': JSON.stringify({
    schema: 'run-log/v1',
    run_id: '2026-08-07T0600Z-research',
    agent: 'research',
    model: 'sonnet',
    trigger: 'schedule',
    started_at: older,
    status: 'ok',
    summary: 'An older run that should sort second.',
    artifacts: ['agents/research/output/old.md'],
    session_url: 'https://claude.ai/code/session_old'
  }),
  'runs/2026-08/2026-08-07T0700Z-research.json': JSON.stringify({
    schema: 'run-log/v1',
    run_id: '2026-08-07T0700Z-research',
    agent: 'research',
    workflow: 'monday-brief',
    model: 'sonnet',
    trigger: 'schedule',
    started_at: recent,
    status: 'ok',
    summary: 'The newest run, which should sort first and mark the agent as working.',
    artifacts: ['agents/research/output/new.md'],
    session_url: 'https://claude.ai/code/session_new'
  }),
  'runs/2026-08/broken.json': '{ not json',
  'runs/heartbeat/hermes.json': JSON.stringify({ runtime: 'hermes', at: freshBeat }),
  'runs/heartbeat/openclaw.json': JSON.stringify({ runtime: 'openclaw', at: staleBeat }),
  'shared/about-me.md': '# About me\n<!-- fill: full-name -->\n',
  'shared/business-brain.md': '# Business brain\n\nAll filled in.\n',
  'shared/writing-rules.md': '# Writing rules\n<!-- fill: voice-samples -->\n<!-- fill: default-cta -->\n',
  'workflows/monday-brief.yml':
    'name: Monday Brief\nowner: research\nsteps: [pull-calendar, scan-inbox, write-brief]\ntrigger:\n  schedule: "weekly mon 06:00"\n  armed: true\n  fire: true\noutput: inbox/{date}/monday-brief.md\n',
  'workflows/broken.yml': 'name: Broken\nsteps: []\n',
  'workflows/hourly-sweep.yml':
    'name: Hourly Sweep\nowner: email\nsteps: [scan-inbox]\ntrigger:\n  schedule: "every 2 hours"\n  armed: true\noutput: inbox/{date}/sweep.md\n',
  '.agent-team/routines.json':
    JSON.stringify({ takenAt: isoAgo(3600_000), routines: [{ id: 'trig_monday', name: 'Monday Brief' }, { id: 'trig_sweep', name: 'Hourly Sweep' }] }),
  'tasks/2026-08-19-draft-post.md':
    '---\nstatus: doing\nfor: email\n---\n\n# Draft the launch post\n\nHalf-written.\n',
  'tasks/2026-08-18-call-supplier.md': '# Call the supplier\n\nNo frontmatter on purpose.\n',
  // The folder's own README, which the template ships in every repo. It is not a to-do, and it
  // must never reach the board - it did, as a card titled "tasks/ - your to-do column", counted
  // in the To-do badge, in every repo ever created from the template.
  'tasks/README.md': '# tasks/ - your to-do column\n\nDrop a card here and the team picks it up.\n',
  'runtimes.yml':
    'runtimes:\n  - name: Hermes\n    kind: agent-runtime\n    url: http://hermes.tail.ts.net:8080\n    heartbeat: runs/heartbeat/hermes.json\n  - name: OpenClaw\n    kind: gateway\n    url: http://openclaw.tail.ts.net:3000\n    heartbeat: runs/heartbeat/openclaw.json\n',
  'connections/register.yml':
    'connections:\n  - name: Gmail\n    slug: gmail\n    kind: connector\n    account: owner@example.com\n    scopes: [read, draft]\n    verified: 2026-08-20\n    proof: \"Read the subjects of the three most recent messages\"\n    used_by: [inbox-triage]\n  - name: Stripe\n    slug: stripe\n    kind: connector\n    account: acct_live\n    verified: 2026-08-21\n',
  'tiles.yml': 'hero: pipeline-value\nchosen: [inbox, calendar]\n',
  'skills/pull-calendar/SKILL.md': '---\nname: pull-calendar\ndescription: Reads the next seven days of the calendar.\n---\n# Pull calendar\n',
  'skills/write-brief/SKILL.md': '---\nname: write-brief\ndescription: Writes the brief.\n---\n',
  'skills/scan-inbox/SKILL.md': 'no frontmatter here\n',
  'stack.yml':
    'stack:\n  - name: last30days\n    plugin: last30days@last30days-skill\n    gives: What people said in the last 30 days\n    why: Training data is out of date\n    verify: "Run it on a topic you know"\n  - name: token-saver\n    skill: skills/pull-calendar/SKILL.md\n    gives: Cost awareness\n  - name: ghost\n    skill: skills/ghost/SKILL.md\n    gives: Listed but not in the repo\n'
}

function stubGitHub({ dropPaths = [], overrideFiles = {}, extraTree = [] } = {}) {
  const original = globalThis.fetch
  const tree = dropPaths.length || extraTree.length
    ? { ...TREE, tree: [...TREE.tree.filter((node) => !dropPaths.includes(node.path)), ...extraTree] }
    : TREE
  const files = { ...FILES, ...overrideFiles }
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('/git/trees/')) {
      return new Response(JSON.stringify(tree), { status: 200 })
    }
    const match = /\/contents\/(.+?)\?ref=/.exec(target)
    const path = match ? decodeURI(match[1]) : null
    const body = path && !dropPaths.includes(path) ? files[path] : undefined
    if (body === undefined) return new Response('Not Found', { status: 404 })
    return new Response(body, { status: 200 })
  }
  return () => {
    globalThis.fetch = original
  }
}

function fakeResponse() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(key, value) {
      this.headers[key] = value
    },
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return this
    }
  }
}

async function run(env = {}, options = {}) {
  const restore = stubGitHub(options)
  const previous = { ...process.env }
  Object.assign(process.env, { GITHUB_OWNER: 'someone', GITHUB_REPO: 'my-agent-team', ...env })
  const response = fakeResponse()
  try {
    await handler({}, response)
  } finally {
    restore()
    process.env = previous
  }
  return response
}

test('missing configuration explains itself instead of failing silently', async () => {
  const restore = stubGitHub()
  const previous = { ...process.env }
  delete process.env.GITHUB_OWNER
  delete process.env.GITHUB_REPO
  const response = fakeResponse()
  try {
    await handler({}, response)
  } finally {
    restore()
    process.env = previous
  }
  assert.equal(response.statusCode, 500)
  assert.match(response.body.error, /GITHUB_OWNER and GITHUB_REPO/)
})

test('agents come back with their model and a state', async () => {
  const { body } = await run()
  assert.deepEqual(
    body.agents.map((agent) => agent.slug),
    ['email', 'research']
  )
  const research = body.agents.find((agent) => agent.slug === 'research')
  assert.equal(research.model, 'sonnet')
  assert.equal(research.state, 'working')
  assert.equal(research.totalRuns, 2)
  const email = body.agents.find((agent) => agent.slug === 'email')
  assert.equal(email.state, 'never-run', 'an agent with no run logs has never run')
})

test('runs are newest first and keep their session link', async () => {
  const { body } = await run()
  assert.equal(body.runs[0].run_id, '2026-08-07T0700Z-research')
  assert.equal(body.runs[0].session_url, 'https://claude.ai/code/session_new')
  assert.equal(body.totalRuns, 2)
})

test('an unparseable run log is reported, not swallowed', async () => {
  const { body } = await run()
  assert.deepEqual(body.unparseableRuns, ['runs/2026-08/broken.json'])
})

test('empty business-brain fields come back by name', async () => {
  const { body } = await run()
  const byPath = Object.fromEntries(body.brain.map((file) => [file.path, file]))
  assert.deepEqual(byPath['shared/about-me.md'].missing, ['full-name'])
  assert.deepEqual(byPath['shared/business-brain.md'].missing, [])
  assert.deepEqual(byPath['shared/writing-rules.md'].missing, ['voice-samples', 'default-cta'])
})

test('the overnight feed holds only the last day of runs', async () => {
  const { body } = await run()
  assert.deepEqual(
    body.overnight.map((run) => run.run_id),
    ['2026-08-07T0700Z-research']
  )
})

test('workflows render from their files: chain, trigger, last result, next run', async () => {
  const { body } = await run()
  const brief = body.workflows.find((workflow) => workflow.slug === 'monday-brief')
  assert.equal(brief.name, 'Monday Brief')
  assert.equal(brief.owner, 'research')
  assert.deepEqual(brief.steps, ['pull-calendar', 'scan-inbox', 'write-brief'])
  assert.equal(brief.schedule, 'weekly mon 06:00')
  assert.equal(brief.fire, true)
  assert.deepEqual(brief.problems, [])
  assert.equal(brief.lastRun.session_url, 'https://claude.ai/code/session_new')
  assert.equal(brief.state, 'working')
  // The next run is a real future Monday 06:00 UTC - and it exists ONLY because a routine named
  // "Monday Brief" is in the snapshot. A schedule alone no longer buys a next-run time.
  assert.equal(brief.arm, 'armed')
  const next = new Date(brief.nextRun)
  assert.ok(next.getTime() > Date.now())
  assert.equal(next.getUTCDay(), 1)
  assert.equal(next.getUTCHours(), 6)
})

test('a broken workflow file is flagged with the template validation words', async () => {
  const { body } = await run()
  const broken = body.workflows.find((workflow) => workflow.slug === 'broken')
  assert.equal(broken.state, 'attention')
  assert.ok(broken.problems.some((problem) => problem.includes('owner is required')))
  assert.ok(broken.problems.some((problem) => problem.includes('steps is required')))
  assert.ok(broken.problems.some((problem) => problem.includes('trigger is required')))
})

test('the connections rail reads runtimes.yml and judges each heartbeat', async () => {
  const { body } = await run()
  assert.equal(body.runtimes.length, 2)
  const hermes = body.runtimes.find((runtime) => runtime.name === 'Hermes')
  assert.equal(hermes.status, 'live')
  assert.equal(hermes.url, 'http://hermes.tail.ts.net:8080')
  const openclaw = body.runtimes.find((runtime) => runtime.name === 'OpenClaw')
  assert.equal(openclaw.status, 'silent', 'a three-hour-old heartbeat is silent')
})

/* Lesson 4 is the Access stage: the student connects Gmail and a calendar. `/connect` writes
   what it proved into connections/register.yml, and the register's own header says a line
   without a `verified` date and a `proof` is a claim, not a connection.

   The rail rendered runtimes.yml only, while being called Connections, and the Access rung read
   `runtimes.length > 0 || chosenTiles.length > 0` while its failure line said "No connections or
   runtimes registered yet" - naming a file nothing read. A student could do the Access lesson
   perfectly and be told Access had not happened.
   Found 2026-08-28 walking Lesson 4 as a student. */

test('the connections rail reads connections/register.yml, not just runtimes', async () => {
  const { body } = await run()
  assert.equal(body.connections.length, 2, 'both register entries are returned')

  const gmail = body.connections.find((connection) => connection.name === 'Gmail')
  assert.equal(gmail.proved, true)
  assert.equal(gmail.verified, '2026-08-20')
  assert.equal(gmail.account, 'owner@example.com')
  assert.deepEqual(gmail.scopes, ['read', 'draft'])
  assert.deepEqual(gmail.usedBy, ['inbox-triage'])

  const stripe = body.connections.find((connection) => connection.name === 'Stripe')
  assert.equal(stripe.proved, false, 'a verified date with no proof is still a claim')
})

test('a proved connection lights the Access rung on its own', async () => {
  // Drop runtimes.yml and tiles.yml, or this passes on the old runtimes-only rule and proves
  // nothing. The whole point is that a connection alone is enough.
  const { body } = await run({}, { dropPaths: ['runtimes.yml', 'tiles.yml'] })
  assert.deepEqual(body.runtimes, [], 'the fixture must not be able to pass this rung another way')
  const access = body.setup.find((rung) => rung.rung === 'access')
  assert.equal(access.pass, true, 'a proved Gmail connection is Access, with no runtime and no tile')
  assert.match(access.detail, /Gmail connected and proved/,
    'a passing rung should name what it is passing on')
})

test('an unproved connection cannot light the Access rung', async () => {
  const { body } = await run({}, {
    dropPaths: ['runtimes.yml', 'tiles.yml'],
    overrideFiles: {
      'connections/register.yml':
        'connections:\n  - name: Gmail\n    kind: connector\n    account: owner@example.com\n'
    }
  })
  const access = body.setup.find((rung) => rung.rung === 'access')
  assert.equal(access.pass, false,
    'a register line with no verified date and no proof is a claim, and claims must not pass a rung')
  assert.equal(body.connections[0].proved, false)
})

test('a repo with no register at all still renders', async () => {
  const { body } = await run({}, { dropPaths: ['connections/register.yml'] })
  assert.deepEqual(body.connections, [], 'an older repo without the file is not an error')
})

test('the memory browser gets every markdown page and knows its index files', async () => {
  const { body } = await run()
  const paths = body.memory.files.map((file) => file.path)
  assert.ok(paths.includes('wiki/INDEX.md'))
  assert.ok(paths.includes('wiki/offers.md'))
  assert.ok(paths.includes('inbox/2026-08-07/monday-brief.md'))
  assert.ok(!paths.some((path) => path.startsWith('.claude/')), 'dotfolders are not vault pages')
  assert.ok(body.memory.indexes.includes('wiki/INDEX.md'))
  const index = body.memory.files.find((file) => file.path === 'wiki/INDEX.md')
  assert.equal(index.size, 2048)
})

test('the setup ladder judges all six rungs from the repo', async () => {
  const { body } = await run()
  const byRung = Object.fromEntries(body.setup.map((rung) => [rung.rung, rung]))
  assert.equal(body.setup.length, 6, 'one rung per stage the course teaches')
  assert.equal(byRung.brief.pass, false, 'fill markers remain, so Brief fails')
  assert.equal(byRung.access.pass, true, 'runtimes and tiles are registered')
  assert.equal(byRung.training.pass, true, 'three skills exist')
  assert.equal(byRung.workflows.pass, true, 'a scheduled workflow ran this week')
  assert.equal(byRung.oversight.pass, true, 'a fire button is registered')
  assert.equal(byRung.improvement.pass, false, 'no verdicts in quality/, so Improvement has not started')
})

test('gone-quiet lists agents and workflows that stopped, and nothing that is fine', async () => {
  const { body } = await run()
  assert.deepEqual(body.goneQuiet, [], 'this fixture has nothing quiet')
})

test('the board ships in the payload with its four columns filled from the repo', async () => {
  const { body } = await run()
  // To do: both task files — oldest first by date-prefixed filename, the frontmatter-less
  // one tolerated as a plain todo, the doing one flagged and colored by its agent.
  assert.deepEqual(body.board.todo, [
    { slug: '2026-08-18-call-supplier', title: 'Call the supplier', for: null, doing: false },
    { slug: '2026-08-19-draft-post', title: 'Draft the launch post', for: 'email', doing: true }
  ], 'tasks/README.md is in this fixture on purpose and must not appear here as a card')
  // Up Next: the two-hour sweep is always inside the 48-hour window; the weekly brief
  // only lands here on the right days, so the sweep is the one deterministic member.
  const sweep = body.board.upNext.find((card) => card.slug === 'hourly-sweep')
  assert.equal(sweep.name, 'Hourly Sweep')
  assert.equal(sweep.owner, 'email')
  assert.ok(Date.parse(sweep.when) - Date.now() <= 48 * 3600_000)
  for (const card of body.board.upNext) {
    assert.ok(Date.parse(card.when) - Date.now() <= 48 * 3600_000)
  }
  // Running: both fixture runs carry a settled ok status older than the grace window.
  assert.deepEqual(body.board.running, [])
  // Done: the hour-old run is in, the twenty-day-old run is outside the 14-day window.
  assert.deepEqual(body.board.done, [
    {
      name: 'monday-brief',
      agent: 'research',
      status: 'ok',
      summary: 'The newest run, which should sort first and mark the agent as working.',
      started_at: recent,
      session_url: 'https://claude.ai/code/session_new'
    }
  ])
})

test('the skills screen lists every repo skill with its description and callers', async () => {
  const { body } = await run()
  assert.deepEqual(body.skills.map((skill) => skill.slug), ['pull-calendar', 'scan-inbox', 'write-brief'])
  const calendar = body.skills.find((skill) => skill.slug === 'pull-calendar')
  assert.equal(calendar.description, 'Reads the next seven days of the calendar.')
  assert.equal(calendar.path, 'skills/pull-calendar/SKILL.md')
  assert.deepEqual(calendar.usedBy, ['monday-brief'])
  const inbox = body.skills.find((skill) => skill.slug === 'scan-inbox')
  assert.equal(inbox.description, '', 'a SKILL.md without frontmatter still lists, with no description')
  assert.deepEqual(inbox.usedBy.sort(), ['hourly-sweep', 'monday-brief'])
})

test('the starter stack reads stack.yml and only claims presence for repo skills', async () => {
  const { body } = await run()
  assert.equal(body.stack.length, 3)
  const plugin = body.stack.find((entry) => entry.name === 'last30days')
  assert.equal(plugin.source, 'plugin')
  assert.equal(plugin.present, null, 'a plugin lives on the owner machine - the repo cannot know')
  assert.equal(plugin.verify, 'Run it on a topic you know')
  const shipped = body.stack.find((entry) => entry.name === 'token-saver')
  assert.equal(shipped.source, 'repo')
  assert.equal(shipped.present, true)
  const ghost = body.stack.find((entry) => entry.name === 'ghost')
  assert.equal(ghost.present, false, 'listed in stack.yml but the file is not in the tree')
})

test('the payload never contains the token', async () => {
  const { body } = await run({ GITHUB_TOKEN: 'ghp_thisMustNeverLeaveTheServer' })
  assert.doesNotMatch(JSON.stringify(body), /ghp_/)
})

/* ---------- the wiring, not just the helper ---------------------------------------------------

   `snapshot.usable && !snapshot.stale` is the argument the handler passes into shapeWorkflows, and
   it decides whether the board says DECLARED or UNKNOWN. Mutating it to `true` left the whole
   suite green through three separate verification rounds: every test called the helpers directly
   and none called the handler, so the one line joining them was invisible.

   With that mutation applied, an absent snapshot makes every armed job report "Nothing fires this.
   The schedule above is a wish" while the banner directly above says the routines are unknown. */

test('with no snapshot, the handler reports UNKNOWN - never DECLARED', async () => {
  const { body } = await run({}, { dropPaths: ['.agent-team/routines.json'] })

  assert.equal(body.routines.usable, false)
  const armedInFile = body.workflows.filter((workflow) => workflow.armed)
  assert.ok(armedInFile.length > 0, 'the fixture needs an armed workflow for this to prove anything')

  for (const workflow of armedInFile) {
    assert.equal(
      workflow.arm,
      'unknown',
      `${workflow.name} was called ${workflow.arm} with no evidence about what rings`
    )
    assert.equal(workflow.nextRun, null, 'and it cannot claim a next run either')
  }
})

test('with a snapshot, the same workflows resolve to armed or declared', async () => {
  const { body } = await run()
  assert.equal(body.routines.usable, true)
  const states = new Set(body.workflows.filter((workflow) => workflow.armed).map((workflow) => workflow.arm))
  assert.ok(!states.has('unknown'), 'a usable snapshot is evidence, and unknown means there was none')
})

test('a stale snapshot is treated as no evidence at all', async () => {
  const stale = JSON.stringify({
    takenAt: new Date(Date.now() - 30 * 86400_000).toISOString(),
    routines: [{ id: 'trig_monday', name: 'Monday Brief' }]
  })
  const { body } = await run({}, { overrideFiles: { '.agent-team/routines.json': stale } })

  assert.equal(body.routines.stale, true)
  for (const workflow of body.workflows.filter((entry) => entry.armed)) {
    assert.equal(workflow.arm, 'unknown', 'a month-old snapshot is not proof that a routine exists today')
  }
  assert.deepEqual(body.routines.orphans, [], 'and nothing is accused of being an orphan on that evidence')
})

/* Two alarm clocks for one job both fire and both are billed, and the duplicate check that says so
   was computed in the handler with nothing asserting it - disabling the loop left the suite green.
   Same for two workflow files sharing a name, which both claim the one routine. */

test('two routines sharing a name are reported as a problem', async () => {
  const snapshot = JSON.stringify({
    takenAt: new Date().toISOString(),
    routines: [
      { id: 'trig_a', name: 'Monday Brief' },
      { id: 'trig_b', name: 'monday   brief' }
    ]
  })
  const { body } = await run({}, { overrideFiles: { '.agent-team/routines.json': snapshot } })
  assert.ok(
    body.routines.problems.some((problem) => /routines share the name/.test(problem)),
    `expected a duplicate-routine problem, got ${JSON.stringify(body.routines.problems)}`
  )
  assert.ok(body.routines.problems.some((problem) => /spend is multiplied/.test(problem)))
})

test('two workflow files sharing a name are reported as a problem', async () => {
  const copy = FILES['workflows/monday-brief.yml']
  const { body } = await run({}, {
    extraTree: [{ type: 'blob', path: 'workflows/monday-brief-copy.yml' }],
    overrideFiles: { 'workflows/monday-brief-copy.yml': copy }
  })
  assert.ok(
    body.routines.problems.some((problem) => /workflow files share the name/.test(problem)),
    `expected a duplicate-workflow problem, got ${JSON.stringify(body.routines.problems)}`
  )
})

/* The board listed `tasks/README.md` as a to-do card. It is the file that explains the folder, it
   ships in the template, and its first heading is "tasks/ — your to-do column" - so every repo
   created from the template had a phantom task on its board from the moment it existed, and the
   To-do count was one too high forever.

   The team's own side already got this right: work-the-tasks/SKILL.md says "Read every .md file in
   tasks/ (skip README.md)". The sweep ignored it, the board did not, and the two disagreed about
   the same folder - which is the shape of most of what has been found on this board. */

test('the folder README is not somebody\'s to-do', () => {
  assert.equal(isTaskCard('tasks/README.md'), false, 'the template ships this in every repo')
  assert.equal(isTaskCard('tasks/readme.md'), false, 'case should not decide it')
  assert.equal(isTaskCard('tasks/2026-08-20-chase-acme-invoice.md'), true, 'a real card was dropped')
})

test('only markdown directly inside tasks/ is a card', () => {
  for (const path of [
    'tasks/2026-08-20-a-card.md',
    'tasks/no-date-prefix.md',
    'tasks/README-of-something-else.md'
  ]) {
    assert.equal(isTaskCard(path), true, `${path} should be a card`)
  }
  for (const path of [
    'tasks/README.md',
    'tasks/.gitkeep',
    'tasks/notes.txt',
    'tasks/archive/2026-08-20-old.md',
    'runs/2026-08/a.md',
    'README.md',
    '',
    null
  ]) {
    assert.equal(isTaskCard(path), false, `${path} should not be a card`)
  }
})

/* shapeHero: an unchosen hero is a step not yet reached, not a broken metric name. */

test('an unfilled hero says what to do, not what the file literally contains', () => {
  const hero = shapeHero({ hero: '<!-- fill: hero-metric -->' }, null)
  assert.equal(hero.defined, false)
  assert.ok(!hero.why.includes('fill:'), 'the reason quotes the raw marker back at the student')
  assert.ok(!hero.why.includes('tiles.yml asks for'), 'it reads as a fault rather than an unfinished step')
  assert.match(hero.why, /nobody has chosen yours/)
})

test('a hero that is a real but unknown metric name still says so plainly', () => {
  const hero = shapeHero({ hero: 'deals-closed' }, null)
  assert.equal(hero.defined, false)
  assert.match(hero.why, /deals-closed/, 'the owner needs to see which name did not resolve')
})

test('a hero the board can compute is unaffected', () => {
  const hero = shapeHero(
    { hero: 'hours-a-week' },
    { ownerType: 'business', hoursPerWeek: 3, costPerWeek: 450, unpriced: false, unreadable: 0, complete: true, tasks: [] }
  )
  assert.equal(hero.defined, true)
})

/* A JOB OWNED BY AN AGENT SOMEBODY SWITCHED OFF.

   It validates clean and then never runs: agent-team-template's workflow validator asks whether the
   owner EXISTS, not whether it is in use, and its scripts/check-arming.mjs already prints
   "Owned by an agent you are not using - these cannot run as written" in the terminal for it.

   The board had both halves and said neither. It reads the knowledge files to decide an agent is
   switched off, and it reads every job's owner, and it drew nine cards that differed only in their
   reason for being off. Two of the nine jobs the template ships are owned by sales and
   customer-service - the two an employee switches off - so this is the state a fresh clone is in
   the moment somebody with a job answers those two files honestly. Both cards told him to arm them
   once the data arrived. */

const agentsWithTwoOff = [
  { slug: 'sales', state: 'not-in-use' },
  { slug: 'customer-service', state: 'not-in-use' },
  { slug: 'research', state: 'working' },
  { slug: 'editor', state: 'never-run' }
]

test('a job owned by a switched-off agent is marked, and the others are not', () => {
  const marked = markOwnerSwitchedOff(
    [
      { slug: 'gone-cold', owner: 'sales' },
      { slug: 'weekly-review', owner: 'customer-service' },
      { slug: 'morning-intel', owner: 'research' },
      { slug: 'quality-review', owner: 'editor' }
    ],
    agentsWithTwoOff
  )
  assert.deepEqual(
    marked.map((workflow) => [workflow.slug, workflow.ownerSwitchedOff]),
    [
      ['gone-cold', true],
      ['weekly-review', true],
      ['morning-intel', false],
      // An agent nobody has got round to yet is NOT the same as one switched off on purpose. This
      // job will run the moment it is armed; saying it cannot would be the opposite lie.
      ['quality-review', false]
    ]
  )
})

test('nothing is marked when no agent is switched off', () => {
  const marked = markOwnerSwitchedOff(
    [{ slug: 'gone-cold', owner: 'sales' }],
    [{ slug: 'sales', state: 'working' }]
  )
  assert.equal(marked[0].ownerSwitchedOff, false)
})

test('a job with no owner is never marked, and never crashes the screen', () => {
  const marked = markOwnerSwitchedOff(
    [{ slug: 'a', owner: '' }, { slug: 'b' }, { slug: 'c', owner: null }],
    agentsWithTwoOff
  )
  assert.deepEqual(marked.map((workflow) => workflow.ownerSwitchedOff), [false, false, false])
  assert.deepEqual(markOwnerSwitchedOff(), [])
})

test('marking leaves every other field on the job alone', () => {
  // It returns new rows rather than mutating, so anything it drops is a field a card stops drawing.
  const before = { slug: 'gone-cold', owner: 'sales', name: 'Gone Cold', arm: 'off', reason: 'Off until.', problems: [] }
  const [after] = markOwnerSwitchedOff([before], agentsWithTwoOff)
  assert.deepEqual({ ...after, ownerSwitchedOff: undefined }, { ...before, ownerSwitchedOff: undefined })
  assert.equal(before.ownerSwitchedOff, undefined, 'the original row was mutated')
})

/* A SKILL WHOSE ONLY JOB CANNOT RUN.

   Four of this repo's skills are listed as a step by exactly one job, and that job is one of the two
   owned by sales and customer-service - the agents somebody with a job switches off. The Skills
   screen said "used by weekly-review" and left him to visit another screen to learn that
   weekly-review never fires.

   The claim stays narrow. The JOB cannot run; the skill can still be asked for by name, which is
   what the other group on that screen says about itself. */

const skillFile = (slug) => [`.claude/skills/${slug}/SKILL.md`, `---
description: what ${slug} does
---
`]

test('a skill is marked stalled only when the job listing it cannot run', () => {
  const [collect, scan, lonely] = shapeSkills(
    [skillFile('collect-run-logs'), skillFile('scan-market'), skillFile('sync')].sort(),
    [
      { slug: 'weekly-review', steps: ['collect-run-logs'], ownerSwitchedOff: true },
      { slug: 'morning-intel', steps: ['scan-market'], ownerSwitchedOff: false }
    ]
  ).sort((a, b) => a.slug.localeCompare(b.slug))

  assert.deepEqual([collect.slug, collect.usedBy, collect.stalled], ['collect-run-logs', ['weekly-review'], ['weekly-review']])
  assert.deepEqual([scan.slug, scan.usedBy, scan.stalled], ['scan-market', ['morning-intel'], []])
  // A skill no job lists at all is not stalled - it is the other group entirely, and calling it
  // stalled would be the opposite lie.
  assert.deepEqual([lonely.slug, lonely.usedBy, lonely.stalled], ['sync', [], []])
})

test('a skill used by both a dead job and a live one names only the dead one', () => {
  const [skill] = shapeSkills(
    [skillFile('review-pipeline')],
    [
      { slug: 'gone-cold', steps: ['review-pipeline'], ownerSwitchedOff: true },
      { slug: 'draft-queue', steps: ['review-pipeline'], ownerSwitchedOff: false }
    ]
  )
  assert.deepEqual(skill.usedBy, ['gone-cold', 'draft-queue'])
  assert.deepEqual(skill.stalled, ['gone-cold'])
})

test('nothing is stalled when no job carries the flag at all', () => {
  // shapeSkills is called with workflows that have been through markOwnerSwitchedOff, but it must
  // not invent a stall from a missing field either.
  const [skill] = shapeSkills([skillFile('scan-market')], [{ slug: 'morning-intel', steps: ['scan-market'] }])
  assert.deepEqual(skill.stalled, [])
})

test('the agents behind the dead jobs are listed once each, in job order', () => {
  // Two dead jobs owned by the SAME agent must name it once. Saying "their owners are switched
  // off" for that case claims two agents where there is one, which is how the display got this
  // wrong before review caught it.
  const [shared] = shapeSkills(
    [skillFile('review-pipeline')],
    [
      { slug: 'gone-cold', owner: 'sales', steps: ['review-pipeline'], ownerSwitchedOff: true },
      { slug: 'chase-again', owner: 'sales', steps: ['review-pipeline'], ownerSwitchedOff: true }
    ]
  )
  assert.deepEqual(shared.stalled, ['gone-cold', 'chase-again'])
  assert.deepEqual(shared.stalledOwners, ['sales'])

  const [two] = shapeSkills(
    [skillFile('review-pipeline')],
    [
      { slug: 'gone-cold', owner: 'sales', steps: ['review-pipeline'], ownerSwitchedOff: true },
      { slug: 'weekly-review', owner: 'customer-service', steps: ['review-pipeline'], ownerSwitchedOff: true },
      { slug: 'draft-queue', owner: 'content', steps: ['review-pipeline'], ownerSwitchedOff: false }
    ]
  )
  assert.deepEqual(two.stalledOwners, ['sales', 'customer-service'], "a live job's owner was listed as switched off")
})

test('a dead job with no owner recorded contributes no name', () => {
  const [skill] = shapeSkills(
    [skillFile('review-pipeline')],
    [{ slug: 'gone-cold', owner: '', steps: ['review-pipeline'], ownerSwitchedOff: true }]
  )
  assert.deepEqual(skill.stalled, ['gone-cold'])
  assert.deepEqual(skill.stalledOwners, [], 'it invented an owner it was never given')
})

/* WHAT AN ENTRY IN runtimes.yml ACTUALLY CHANGES.

   The Connections screen tells a student, in words, what an empty machine list costs them. That
   sentence is only as good as this behaviour, and the first version of it was wrong: it said
   nothing runs or stops running because of what is in the list, which is true about running and
   reads as "this list has no consequences". One entry - unproved, no heartbeat, no URL - flips the
   Access rung on the Today screen.

   Pinned here so the sentence and the rule cannot drift apart. If Access stops depending on
   runtimes, this fails, and the sentence on that screen has to be rewritten rather than quietly
   becoming wrong. */

const emptyRepo = {
  brain: [], skills: [], workflows: [], runtimes: [], tiles: null, runs: [], connections: [], verdicts: 0, onboarding: null
}
const accessRung = (over) => shapeSetup({ ...emptyRepo, ...over }).find((rung) => rung.rung === 'access')

test('one runtime entry, on its own, flips the Access rung on the Today screen', () => {
  assert.equal(accessRung({}).pass, false, 'Access passes with nothing registered at all')
  assert.equal(
    accessRung({ runtimes: [{ name: 'Studio box', status: 'live' }] }).pass,
    true,
    'the Connections screen tells students an entry here counts towards Access - it does not'
  )
})

test('a proved connection satisfies Access on its own, and an unproved one does not', () => {
  const proved = accessRung({ connections: [{ name: 'GitHub', proved: true }] })
  assert.equal(proved.pass, true, 'a proved connection no longer satisfies Access')
  const unproved = accessRung({ connections: [{ name: 'GitHub', proved: false }] })
  assert.equal(unproved.pass, false, 'an UNPROVED connection satisfies Access, so the word "proved" is doing no work')
})

/* EVERYTHING ABOVE IS THE PATH A STUDENT NEVER TAKES.

   shapeSetup has two branches and the three tests above only reach the second one, which runs when
   there is no onboarding record. The code's own comment calls that "the path a student never takes",
   and it is right: /onboard writes a record into the repo, and from then on Access is that record
   and nothing else.

   This matters because the Connections screen tells students in words what an empty machine list
   costs them, and the version of that sentence which said "the Access step, which a proved
   connection above also satisfies" was reading the branch below rather than this one. For anybody
   mid-onboarding it was false: they can prove every connection they own and the rung stays red.

   And the check I ran against the employee repo could not have caught it. That repo HAS an
   onboarding record marking Access done, so its rung was green whatever its connections said -
   green was consistent with my sentence and with the truth at the same time. An observation that
   cannot tell the two apart is not evidence for either. */

const onboarded = (over) => shapeSetup({ ...emptyRepo, onboarding: { access: true }, ...over })
  .find((rung) => rung.rung === 'access')

test('once /onboard has run, Access is the record and nothing else', () => {
  // No connections, no machines, nothing registered - and it still passes, because the record says
  // the step was done. Adding a machine cannot make this MORE true.
  const bare = onboarded({})
  assert.equal(bare.pass, true)
  assert.match(bare.detail, /Marked done in \/onboard, but nothing is registered/,
    'a record with nothing behind it should say so rather than reading as a finished step')

  const withRuntime = onboarded({ runtimes: [{ name: 'Studio box', status: 'live' }] })
  assert.equal(withRuntime.pass, true)
  assert.equal(withRuntime.detail, '1 runtime', 'a machine changes the wording, which is all it changes here')
})

test('mid-onboarding, no number of proved connections or machines lights Access', () => {
  // The case that makes the old sentence false. This is the test that would have caught it.
  const notYet = shapeSetup({
    ...emptyRepo,
    onboarding: { access: false },
    connections: [{ name: 'GitHub', proved: true }, { name: 'Gmail', proved: true }],
    runtimes: [{ name: 'Studio box', status: 'live' }]
  }).find((rung) => rung.rung === 'access')

  assert.equal(notYet.pass, false, 'proved connections lit Access for a student who has not finished /onboard')
  assert.match(notYet.detail, /Not finished in \/onboard yet/)
})
