// End-to-end over a stubbed GitHub. Proves all five screens can render a team repo without
// a network, a token, or a live account.
import test from 'node:test'
import assert from 'node:assert/strict'
import handler from '../api/state.js'

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
    { type: 'blob', path: 'tasks/2026-08-19-draft-post.md' },
    { type: 'blob', path: 'tasks/2026-08-18-call-supplier.md' },
    { type: 'blob', path: 'runtimes.yml' },
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
  'runtimes.yml':
    'runtimes:\n  - name: Hermes\n    kind: agent-runtime\n    url: http://hermes.tail.ts.net:8080\n    heartbeat: runs/heartbeat/hermes.json\n  - name: OpenClaw\n    kind: gateway\n    url: http://openclaw.tail.ts.net:3000\n    heartbeat: runs/heartbeat/openclaw.json\n',
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

test('the setup ladder judges all five rungs from the repo', async () => {
  const { body } = await run()
  const byRung = Object.fromEntries(body.setup.map((rung) => [rung.rung, rung]))
  assert.equal(body.setup.length, 5)
  assert.equal(byRung.brief.pass, false, 'fill markers remain, so Brief fails')
  assert.equal(byRung.access.pass, true, 'runtimes and tiles are registered')
  assert.equal(byRung.training.pass, true, 'three skills exist')
  assert.equal(byRung.workflows.pass, true, 'a scheduled workflow ran this week')
  assert.equal(byRung.oversight.pass, true, 'a fire button is registered')
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
  ])
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
