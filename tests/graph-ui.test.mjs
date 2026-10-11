// Memory, Graph: the page side of the memory graph. Booted for real in the small stand-in DOM, with a
// stand-in graph library handed in through the page's own seam (graphDeps), because the real ones need
// a canvas and WebGL. What these hold:
//
//  - nothing graph-shaped is on the first page: /api/graph is asked for when Memory opens, and a
//    library only when Graph does - once, the 3D one on a computer and the flat one on a phone;
//  - the library is driven safely: the d3 layout engine (the other builds code from text, which the
//    page's policy refuses), no hover label ever set from a title's text, no spin and no animated
//    layout for someone who asked for less motion, paused when nobody can see it;
//  - what a person reads is set as text, a vault shared as dots and lines shows no title anywhere,
//    and the list under the graph holds every dot and its lines, for a keyboard and a screen reader.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadPage, flush, script, app, graphView } from './helpers/page-harness.mjs'
import { basePayload } from './helpers/page-payload.mjs'
import { cssRules, sheetText } from './helpers/css-rules.mjs'
import { buildTeamGraph } from '../api/_team-graph.js'
import { shapeVaults, VAULTS_FOLDER } from '../api/_vaults.js'

const vaultsFixture = JSON.parse(readFileSync(new URL('./fixtures/vaults-parity.json', import.meta.url), 'utf8'))
const COMMIT = 'c'.repeat(40)
const HOSTILE = '<img src=x onerror=alert(1)>'

function teamOf(notes) {
  const team = buildTeamGraph(Object.entries(notes).map(([path, text]) => ({ path, text })))
  return { ...team, hidden: 0, more: 0, unread: 0 }
}
const TEAM_NOTES = {
  'CLAUDE.md': 'Read shared/business-brain.md and shared/about-me.md.',
  'shared/business-brain.md': '# Brain\n',
  'shared/about-me.md': '',
  '.claude/agents/sales.md': '',
  'agents/sales/README.md': '',
  [`notes/${HOSTILE}.md`]: '',
  'inbox/2026-10-09/a.md': '',
  'inbox/2026-10-09/b.md': ''
}
const vaultsSample = () => {
  const takenAt = new Date(Date.now() - 3600_000).toISOString().replace(/\.\d+Z$/, 'Z')
  return shapeVaults([[`${VAULTS_FOLDER}/mac-mini.json`, JSON.stringify({ ...vaultsFixture.sample, takenAt })]], Date.now(), 1)
}
const graphPayload = (patch = {}) => ({ commit: COMMIT, team: teamOf(TEAM_NOTES), vaults: vaultsSample(), generatedAt: new Date().toISOString(), ...patch })

// A stand-in for either library: every setter is recorded and returns the graph, so the page's chained
// calls work; a getter returns what was last set. `made` collects every graph the page builds.
function fakeLibraries() {
  const made = []
  const factory = (mode) => function Graph(element, config) {
    const record = { mode, element, config, calls: [], values: {}, paused: 0, resumed: 0, destroyed: 0 }
    const controls = { autoRotate: false, autoRotateSpeed: 0, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn } }
    const renderer = { ratio: null, setPixelRatio(value) { this.ratio = value } }
    const api = new Proxy({}, {
      get(_, name) {
        if (name === 'controls') return () => controls
        if (name === 'renderer') return () => renderer
        if (name === 'pauseAnimation') return () => { record.paused += 1; return api }
        if (name === 'resumeAnimation') return () => { record.resumed += 1; return api }
        if (name === '_destructor') return () => { record.destroyed += 1 }
        if (typeof name !== 'string' || name === 'then') return undefined
        return (...args) => {
          record.calls.push([name, ...args])
          if (!args.length) return record.values[name]
          record.values[name] = args[0]
          return api
        }
      }
    })
    Object.assign(record, { api, controls, renderer })
    made.push(record)
    return api
  }
  const loads = []
  return {
    made,
    loads,
    load: async (mode) => {
      loads.push(mode)
      return factory(mode)
    }
  }
}

const COLOURS = { note: '#eef1f7', lonely: '#f5b14c', picked: '#f0596a', stage: '#121826', link: '#9db8ff', mention: '#a48bf5', agent: '#5fd3a6', day: '#f472b6', tag: '#22d3ee' }

// Boots the board on `hash` with the graph answering `graph`, and hands the page the stand-in library.
async function boot({ hash = '#memory', graph = graphPayload(), graphAnswer, motion = {}, webgl = true, storage = {}, media = {}, view, frames } = {}) {
  const libraries = fakeLibraries()
  const answer = async (url) => {
    if (url.startsWith('/api/graph')) {
      if (graphAnswer) return graphAnswer(url)
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => graph }
    }
    if (url.startsWith('/api/state')) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ...basePayload(), commit: COMMIT }) }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) }
  }
  const page = loadPage({
    fetch: answer,
    hash,
    storage,
    media,
    expose: ['graphState', 'graphDeps', 'graphModel', 'graphSources', 'graphCap', 'graphModeFor', 'graphSelect', 'memorySetView', 'showScreen',
      'GRAPH_NODE_CAP', 'GRAPH_LIBRARIES', 'GRAPH_SETTLE_TICKS', 'GRAPH_DOT_SIZE', 'graphRender', 'graphSetMode', 'graphToggleKind', 'graphToggleLonely', 'graphSetSource', 'graphSetFind'],
    // `frames` holds back animation frames for the test to run, as a browser runs them after drawing.
    after: 'Object.assign(graphDeps, given.deps); if (given.frames) window.requestAnimationFrame = (fn) => { given.frames.push(fn); return 1 }',
    given: {
      frames,
      deps: {
        load: libraries.load,
        webgl: () => webgl,
        motion: () => ({ finePointer: true, reducedMotion: false, deviceMemory: 8, ...motion }),
        colours: () => COLOURS,
        pixelRatio: () => 1.5,
        ...(view ? { view } : {})
      }
    }
  })
  await flush()
  return { page, libraries, exposed: page.exposed }
}

const walk = (node, found = []) => {
  if (!node) return found
  found.push(node)
  for (const child of node.children ?? []) walk(child, found)
  return found
}
const textOf = (node) => `${node?.textContent ?? ''}${(node?.children ?? []).map(textOf).join('')}`
const withClass = (root, name) => walk(root).filter((node) => (node.className ?? '').split(/\s+/).includes(name))
const graphRoot = (page) => page.node('memory-graph')
const graphRequests = (page) => page.requests.filter((request) => request.url.startsWith('/api/graph'))
const scriptsMade = (page) => page.created.filter((node) => node.tagName === 'SCRIPT')
const latest = (libraries) => libraries.made.at(-1)
const call = (record, name) => record.calls.filter((entry) => entry[0] === name).at(-1)

/* ---------- nothing graph-shaped on the first page --------------------------------------------- */

test('the board loads without asking for the graph or either library', async () => {
  const { page, libraries } = await boot({ hash: '' })
  assert.deepEqual(graphRequests(page), [])
  assert.deepEqual(libraries.loads, [])
  assert.deepEqual(scriptsMade(page), [])
})

test('opening Memory asks for the graph once; the List view loads no library', async () => {
  const { page, libraries } = await boot()
  assert.equal(graphRequests(page).length, 1)
  assert.equal(graphRequests(page)[0].url, '/api/graph')
  assert.deepEqual(libraries.loads, [])
})

test('Graph loads one library the first time, and only once', async () => {
  const { exposed, libraries } = await boot()
  exposed.memorySetView('graph')
  // Drawn again before the library has arrived: the drawing already on its way is the one that lands.
  exposed.graphRender()
  await flush()
  assert.deepEqual(libraries.loads, ['3d'])
  exposed.memorySetView('list')
  exposed.memorySetView('graph')
  await flush()
  assert.deepEqual(libraries.loads, ['3d'], 'the library was asked for again')
})

test('the real loader adds one script tag, for this site\'s own copy, and never a second', async () => {
  const { page, exposed } = await boot({ hash: '' })
  assert.equal(exposed.GRAPH_LIBRARIES['3d'].src, '/vendor/3d-force-graph-1.80.0.min.js')
  assert.equal(exposed.GRAPH_LIBRARIES.flat.src, '/vendor/force-graph-1.51.4.min.js')
  assert.match(app, /function graphLoadLibrary\(mode\)/)
  // The loader is the page's own: a script element with a site-relative src, added once per library.
  const loader = app.slice(app.indexOf('const graphLoading'), app.indexOf('async function graphFetch'))
  assert.match(loader, /createElement\('script'\)/)
  assert.match(loader, /graphLoading\[src\] \?\?=/, 'a second ask does not wait for the first')
  assert.doesNotMatch(loader, /https?:/, 'the loader names another site')
  assert.deepEqual(scriptsMade(page), [])
})

test('the page\'s own loader asks for each library once, and tries again after a failed load', async () => {
  // The real loader, not the stand-in: no deps are replaced here.
  const page = loadPage({ payload: basePayload(), expose: ['graphLoadLibrary'] })
  await flush()
  const first = page.exposed.graphLoadLibrary('flat')
  page.exposed.graphLoadLibrary('flat')
  first.catch(() => {})
  let tags = scriptsMade(page)
  assert.equal(tags.length, 1, 'the library was asked for twice')
  assert.equal(tags[0].src, '/vendor/force-graph-1.51.4.min.js')
  tags[0].listeners.error[0]()
  await assert.rejects(first)
  page.exposed.graphLoadLibrary('flat').catch(() => {})
  tags = scriptsMade(page)
  assert.equal(tags.length, 2, 'a failed load was never tried again')
})

test('the drawing\'s pixel ratio is the screen\'s, up to 1.5', async () => {
  for (const [screen, used] of [[3, 1.5], [1, 1], [undefined, 1]]) {
    const page = loadPage({ payload: basePayload(), expose: ['graphDeps'], after: 'window.devicePixelRatio = given.ratio', given: { ratio: screen } })
    await flush()
    assert.equal(page.exposed.graphDeps.pixelRatio(), used)
  }
})

test('the drawing code is a file of its own, asked for the first time Graph opens and never before', async () => {
  // /app.js alone: the page as it is until somebody opens Graph.
  const page = loadPage({ source: app, payload: { ...basePayload(), commit: COMMIT }, hash: '#memory', expose: ['memorySetView'] })
  await flush()
  assert.deepEqual(scriptsMade(page), [], 'the view or a library was asked for before Graph was opened')
  page.exposed.memorySetView('graph')
  page.exposed.memorySetView('list')
  page.exposed.memorySetView('graph')
  await flush()
  const tags = scriptsMade(page)
  assert.deepEqual(tags.map((tag) => tag.src), ['/memory-graph.js'], 'the view file was not asked for once, and only it')
  assert.ok(!app.includes('function graphShell'), 'the drawing code is still in /app.js, paid for by every visit')
  assert.ok(graphView.includes('function graphShell'))
})

test('the view file is the page\'s own plain script: no markup written, no storage touched directly', () => {
  assert.doesNotMatch(graphView, /innerHTML|insertAdjacentHTML/)
  assert.doesNotMatch(graphView, /\blocalStorage\b/)
  assert.ok(graphView.startsWith("'use strict'"))
})

/* ---------- 3D or flat ------------------------------------------------------------------------- */

test('3D on a computer that can draw it; flat on a phone, a slow device, or for someone who asked for less motion', (t) => {
  return boot({ hash: '' }).then(({ exposed }) => {
    const pick = exposed.graphModeFor
    const desk = { finePointer: true, webgl: true, reducedMotion: false, deviceMemory: 8 }
    assert.equal(pick(desk), '3d')
    assert.equal(pick({ ...desk, deviceMemory: undefined }), '3d', 'a browser that does not say its memory is not held back')
    assert.equal(pick({ ...desk, finePointer: false }), 'flat')
    assert.equal(pick({ ...desk, webgl: false }), 'flat')
    assert.equal(pick({ ...desk, reducedMotion: true }), 'flat')
    assert.equal(pick({ ...desk, deviceMemory: 2 }), 'flat')
    // The switch wins, except that 3D needs WebGL.
    assert.equal(pick({ ...desk, finePointer: false, saved: '3d' }), '3d')
    assert.equal(pick({ ...desk, saved: 'flat' }), 'flat')
    assert.equal(pick({ ...desk, webgl: false, saved: '3d' }), 'flat')
  })
})

test('a phone gets the flat library; the switch is remembered on the device, and storage refusing it breaks nothing', async () => {
  const phone = await boot({ motion: { finePointer: false } })
  phone.exposed.memorySetView('graph')
  await flush()
  assert.deepEqual(phone.libraries.loads, ['flat'])
  phone.exposed.graphSetMode('3d')
  await flush()
  assert.deepEqual(phone.libraries.loads, ['flat', '3d'])
  assert.equal(phone.page.storage.getItem('agent-cockpit-graph-mode'), '3d')
  const again = await boot({ motion: { finePointer: false }, storage: { 'agent-cockpit-graph-mode': '3d', 'agent-cockpit-memory-view': 'graph' } })
  await flush()
  assert.deepEqual(again.libraries.loads, ['3d'], 'the remembered choice was not used')
})

/* ---------- driving the library safely --------------------------------------------------------- */

test('3D runs on the d3 layout engine, at a pixel ratio of at most 1.5, with the orbit controls', async () => {
  const { exposed, libraries } = await boot()
  exposed.memorySetView('graph')
  await flush()
  const graph = latest(libraries)
  assert.equal(graph.mode, '3d')
  assert.deepEqual(call(graph, 'forceEngine'), ['forceEngine', 'd3'])
  assert.equal(graph.renderer.ratio, 1.5)
  assert.equal(graph.config.controlType, 'orbit')
  assert.deepEqual(call(graph, 'showNavInfo'), ['showNavInfo', false])
})

test('a hover label is never set from a title\'s text: it is an element with the title as its text', async () => {
  const { exposed, libraries } = await boot()
  exposed.memorySetView('graph')
  await flush()
  const graph = latest(libraries)
  const label = graph.values.nodeLabel
  assert.equal(typeof label, 'function')
  const node = graph.values.graphData.nodes.find((one) => one.label.includes('<img'))
  assert.ok(node, 'the hostile note is not a dot')
  const shown = label(node)
  assert.notEqual(typeof shown, 'string', 'a string label is put in the page as markup')
  assert.equal(shown.textContent, node.label)
  assert.equal(shown.innerHTML, '')
  assert.equal(graph.values.linkLabel?.({ kind: 'link' }) ?? null, null)
})

test('the page never sets a node label or link label that is a string, anywhere in its source', () => {
  // The graph's code in /app.js, and the view it loads when Graph opens.
  const block = app.slice(app.indexOf('/* ---------- Memory graph: begin'), app.indexOf('/* ---------- Memory graph: end')) +
    graphView.slice(graphView.indexOf('/* ---------- Memory graph view: begin'), graphView.indexOf('/* ---------- Memory graph view: end'))
  assert.ok(block.length > 2000, 'the Memory graph block was not found')
  assert.doesNotMatch(block, /\.innerHTML\s*=/, 'the graph writes markup')
  assert.doesNotMatch(block, /insertAdjacentHTML/)
})

test('when motion is allowed the 3D view turns slowly and settles as it lays out', async () => {
  const { exposed, libraries } = await boot()
  exposed.memorySetView('graph')
  await flush()
  const graph = latest(libraries)
  assert.equal(graph.controls.autoRotate, true)
  // It lays out on screen: not worked out in advance, not frozen at once (it settles by its own steps).
  assert.ok(graph.values.cooldownTicks > 0, 'the layout was frozen for someone who did not ask')
  assert.equal(graph.values.warmupTicks, undefined, 'the layout was worked out before it was drawn')
  // It stops turning the moment somebody takes hold of it.
  graph.controls.listeners.start()
  assert.equal(graph.controls.autoRotate, false)
})

test('for someone who asked for less motion: no turning, and the layout is worked out before it is drawn', async () => {
  for (const mode of ['3d', 'flat']) {
    const { exposed, libraries } = await boot({ motion: { reducedMotion: true }, storage: { 'agent-cockpit-graph-mode': mode } })
    exposed.memorySetView('graph')
    await flush()
    const graph = latest(libraries)
    assert.equal(graph.mode, mode)
    assert.equal(graph.values.cooldownTicks, 0, `${mode}: the layout moves on screen`)
    assert.ok(graph.values.warmupTicks > 0, `${mode}: the layout is not worked out first`)
    assert.equal(graph.controls.autoRotate, false, `${mode}: it turns`)
  }
})

test('once the layout settles the whole graph is framed, once, with room round it, and with no glide for someone who asked for less motion', async () => {
  for (const [mode, motion, time] of [['3d', {}, 400], ['flat', {}, 400], ['3d', { reducedMotion: true }, 0], ['flat', { reducedMotion: true }, 0]]) {
    const { exposed, libraries } = await boot({ motion, storage: { 'agent-cockpit-graph-mode': mode } })
    exposed.memorySetView('graph')
    await flush()
    const graph = latest(libraries)
    graph.values.onEngineStop()
    graph.values.onEngineStop()
    const fits = graph.calls.filter((entry) => entry[0] === 'zoomToFit')
    assert.equal(fits.length, 1, `${mode}: it framed the graph more than once, taking the view from the person`)
    assert.deepEqual(fits[0].slice(1, 3), [time, 40], `${mode}: framed with the wrong glide or padding`)
  }
})

test('the layout settles by its own progress, not by the clock, so a slow or background tab never freezes it half-spread', async () => {
  // Found on prod: the drawing stopped after five seconds by the clock. A tab that gets few animation
  // frames - in the background, or driven by a script - had laid out only a few steps by then, so the
  // graph froze bunched up and was framed that way: a handful of giant spheres filling the stage.
  for (const mode of ['3d', 'flat']) {
    const { exposed, libraries } = await boot({ storage: { 'agent-cockpit-graph-mode': mode } })
    exposed.memorySetView('graph')
    await flush()
    const graph = latest(libraries)
    assert.equal(graph.values.cooldownTime, Infinity, `${mode}: the layout is still stopped by the clock`)
    assert.equal(graph.values.cooldownTicks, exposed.GRAPH_SETTLE_TICKS, `${mode}: the layout does not stop after a set number of steps`)
    assert.ok(exposed.GRAPH_SETTLE_TICKS >= 200)
  }
})

test('a gentle pull to the middle keeps notes nothing links to near the rest, so the framed graph is not mostly empty space', async () => {
  const { exposed, libraries } = await boot()
  exposed.memorySetView('graph')
  await flush()
  const gather = latest(libraries).calls.find((entry) => entry[0] === 'd3Force' && entry[1] === 'gather')?.[2]
  assert.equal(typeof gather, 'function', 'there is no pull to the middle')
  const far = { x: 400, y: -300, z: 200, vx: 0, vy: 0, vz: 0 }
  const flatNode = { x: 400, y: -300, vx: 0, vy: 0 }
  gather.initialize([far, flatNode])
  gather(1)
  assert.ok(far.vx < 0 && far.vy > 0 && far.vz < 0, 'a far dot is not pulled back toward the middle')
  assert.ok(flatNode.vx < 0 && flatNode.vy > 0, 'a flat dot is not pulled back toward the middle')
  assert.equal(flatNode.vz, undefined, 'a flat dot was given a depth')
})

test('the 3D dots are sized to read as dots in a graph of a hundred or so notes', async () => {
  const { exposed, libraries } = await boot()
  exposed.memorySetView('graph')
  await flush()
  assert.equal(latest(libraries).values.nodeRelSize, exposed.GRAPH_DOT_SIZE['3d'])
  assert.ok(exposed.GRAPH_DOT_SIZE['3d'] >= 6)
})

test('framing waits for nobody who has already taken hold of the 3D view', async () => {
  const { exposed, libraries } = await boot()
  exposed.memorySetView('graph')
  await flush()
  const graph = latest(libraries)
  graph.controls.listeners.start()
  graph.values.onEngineStop()
  assert.equal(graph.calls.filter((entry) => entry[0] === 'zoomToFit').length, 0, 'the camera was taken from the person mid-turn')
})

test('switching Flat to 3D starts a fresh camera that is framed when its layout settles; a hidden tab is framed too', async () => {
  const { page, exposed, libraries } = await boot({ storage: { 'agent-cockpit-graph-mode': 'flat' } })
  page.document.visibilityState = 'hidden'
  exposed.memorySetView('graph')
  await flush()
  exposed.graphSetMode('3d')
  await flush()
  const graph = latest(libraries)
  assert.equal(graph.mode, '3d')
  assert.equal(libraries.made.length, 2, 'the 3D view reused the flat one')
  graph.values.onEngineStop()
  assert.equal(graph.calls.filter((entry) => entry[0] === 'zoomToFit').length, 1, 'the hidden tab skipped the fit')
})

test('dragging dots is for a mouse only: on a touch screen a finger moves the view, not the notes', async () => {
  const phone = await boot({ motion: { finePointer: false } })
  phone.exposed.memorySetView('graph')
  await flush()
  assert.equal(latest(phone.libraries).values.enableNodeDrag, false)
  const desk = await boot()
  desk.exposed.memorySetView('graph')
  await flush()
  assert.equal(latest(desk.libraries).values.enableNodeDrag, true)
})

test('the drawing pauses when the tab is hidden or Memory is left, and picks up again on return', async () => {
  const { page, exposed, libraries } = await boot()
  exposed.memorySetView('graph')
  await flush()
  const graph = latest(libraries)
  const visibility = page.documentListeners.filter((entry) => entry.type === 'visibilitychange').map((entry) => entry.handler)
  page.document.visibilityState = 'hidden'
  visibility.forEach((handler) => handler())
  assert.ok(graph.paused >= 1, 'a hidden tab keeps drawing')
  page.document.visibilityState = 'visible'
  visibility.forEach((handler) => handler())
  assert.ok(graph.resumed >= 1, 'coming back did not resume it')
  const pausedBefore = graph.paused
  page.location.hash = '#today'
  exposed.showScreen('today')
  assert.ok(graph.paused > pausedBefore, 'leaving Memory keeps it drawing')
  exposed.memorySetView('list')
  assert.equal(libraries.made.length, 1)
})

/* ---------- what the graph holds ---------------------------------------------------------------- */

test('the team repo is the first source; each shared vault is a source of its own, and All draws every one', async () => {
  const { exposed } = await boot({ hash: '' })
  const sources = exposed.graphSources(graphPayload())
  assert.deepEqual(sources.map((source) => source.label), ['Team repo', 'Field Notes', 'Ideas', 'All'])
  const all = exposed.graphModel(graphPayload(), 'all')
  const parts = ['team', 'vault:0:0', 'vault:0:1'].map((key) => exposed.graphModel(graphPayload(), key))
  assert.equal(all.nodes.length, parts.reduce((sum, part) => sum + part.nodes.length, 0))
  assert.equal(all.links.length, parts.reduce((sum, part) => sum + part.links.length, 0))
  assert.deepEqual(all.counts, { notes: 8 + 6 + 5, lines: parts.reduce((sum, part) => sum + part.counts.lines, 0), lonely: parts.reduce((sum, part) => sum + part.counts.lonely, 0) })
  assert.equal(new Set(all.nodes.map((node) => node.id)).size, all.nodes.length, 'two dots share an id')
  // With only the team repo there is nothing to add up.
  assert.deepEqual(exposed.graphSources(graphPayload({ vaults: { status: 'none', why: 'No vault has been read yet.', read: 0, skipped: 0, unreadable: 0, notShown: 0, computers: [] } })).map((source) => source.label), ['Team repo'])
})

test('the team model: a dot per note and hub, every line with its kind, and the lonely notes marked', async () => {
  const { exposed } = await boot({ hash: '' })
  const model = exposed.graphModel(graphPayload(), 'team')
  const team = graphPayload().team
  assert.equal(model.nodes.length, team.notes.length + team.hubs.length)
  assert.equal(model.links.length, team.edges.length)
  assert.deepEqual(model.counts, { notes: team.notes.length, lines: team.lines, lonely: team.lonely })
  assert.deepEqual([...new Set(model.links.map((link) => link.kind))].sort(), ['agent', 'day', 'mention'])
  const brain = model.nodes.find((node) => node.path === 'shared/business-brain.md')
  assert.equal(brain.lonely, false)
  assert.equal(brain.opens, true)
  const hub = model.nodes.find((node) => node.kind === 'day')
  assert.equal(hub.label, '2026-10-09')
})

test('a vault shared as dots and lines has no title anywhere in its model; one shared with titles has them', async () => {
  const { exposed } = await boot({ hash: '' })
  const shape = exposed.graphModel(graphPayload(), 'vault:0:0')
  assert.deepEqual(shape.nodes.map((node) => node.label), ['Note 1', 'Note 2', 'Note 3', 'Note 4', 'Note 5', 'Note 6'])
  assert.ok(shape.nodes.every((node) => node.path === null && node.opens === false && node.folder === null))
  assert.equal(shape.counts.lonely, 1)
  const titles = exposed.graphModel(graphPayload(), 'vault:0:1')
  assert.deepEqual(titles.nodes.map((node) => node.label), ['Shopping list', 'Weekly plan', 'Pasta ideas', 'Soup', 'Note 5', '2026-10-09', 'recipes'])
  assert.ok(titles.nodes.every((node) => node.opens === false))
})

test('a 1,800-dot vault on a phone draws the most connected dots up to the cap and says so; the list keeps all of them', async () => {
  const notes = 1800
  // Fifty busy notes, the last fifty, each linked to thirty-five of the rest: a cap that kept the first
  // dots in order, rather than the most connected, would leave every one of them out.
  const edges = Array.from({ length: notes - 50 }, (_, index) => [index, notes - 50 + (index % 50), 0])
  const big = { name: 'Big', level: 'shape', notes, lines: edges.length, lonely: 0, hidden: 0, more: 0, moreLines: 0, edges }
  const graph = graphPayload({ vaults: { status: 'ok', why: null, read: 1, skipped: 0, unreadable: 0, notShown: 0, computers: [{ computer: 'Mac Mini', takenAt: new Date().toISOString(), freshness: 'fresh', vaults: { status: 'found', why: null, items: [big], hidden: 0, more: 0 } }] } })
  const { page, exposed, libraries } = await boot({ graph, motion: { finePointer: false } })
  exposed.graphSetSource('vault:0:0')
  exposed.memorySetView('graph')
  await flush()
  const drawn = latest(libraries).values.graphData
  assert.equal(drawn.nodes.length, exposed.GRAPH_NODE_CAP.flat)
  assert.ok(exposed.GRAPH_NODE_CAP.flat < notes)
  const ids = new Set(drawn.nodes.map((node) => node.id))
  assert.ok(drawn.links.every((link) => ids.has(link.source) && ids.has(link.target)), 'a line goes to a dot that is not drawn')
  for (let dot = notes - 50; dot < notes; dot += 1) assert.ok(ids.has(`vault:0:0#${dot}`), `the busy dot ${dot} was left out`)
  assert.match(textOf(graphRoot(page)), new RegExp(`Showing the ${exposed.GRAPH_NODE_CAP.flat} most connected of 1,800 dots`))
  const items = withClass(graphRoot(page), 'mg-item')
  assert.ok(items.length > 0)
  assert.match(textOf(graphRoot(page)), /Showing 200 of 1,800/)
})

/* ---------- what a person reads --------------------------------------------------------------- */

test('the count line says how many notes, lines and lonely dots, for the source in view', async () => {
  const { page, exposed } = await boot()
  exposed.memorySetView('graph')
  await flush()
  const team = graphPayload().team
  const [count] = withClass(graphRoot(page), 'mg-count')
  assert.equal(count.textContent, `${team.notes.length} notes · ${team.lines} lines · ${team.lonely} lonely`)
  assert.equal(count.attributes.role, 'status')
  exposed.graphSetSource('vault:0:0')
  await flush()
  assert.equal(count.textContent, '6 notes · 5 lines · 1 lonely')
})

test('a vault shared as dots and lines shows no title anywhere on the screen', async () => {
  const { page, exposed } = await boot()
  exposed.memorySetView('graph')
  exposed.graphSetSource('vault:0:0')
  await flush()
  exposed.graphSelect('vault:0:0#0')
  const shown = textOf(graphRoot(page))
  // Its notes' names in the shared sample: Garden, Kitchen, Compost, Seeds, Tools, Lonely.
  for (const title of ['Garden', 'Kitchen', 'Compost', 'Seeds', 'Tools', 'Zzz']) assert.ok(!shown.includes(title), `${title} reached the screen`)
  assert.match(shown, /titles stay on Mac Mini/)
})

test('picking a dot opens its panel: its name as text, every line with its reason, and Open for a team note only', async () => {
  const { page, exposed } = await boot()
  exposed.memorySetView('graph')
  await flush()
  const model = exposed.graphModel(graphPayload(), 'team')
  const hostile = model.nodes.find((node) => node.label.includes('<img'))
  exposed.graphSelect(hostile.id)
  const [panel] = withClass(graphRoot(page), 'mg-panel')
  assert.equal(panel.hidden, false)
  const [title] = withClass(panel, 'mg-panel-title')
  assert.equal(title.textContent, hostile.label)
  assert.ok(walk(graphRoot(page)).every((node) => node.tagName !== 'IMG'), 'a title became an element')

  const claude = model.nodes.find((node) => node.path === 'CLAUDE.md')
  exposed.graphSelect(claude.id)
  const lines = withClass(panel, 'mg-line').map(textOf)
  assert.deepEqual(lines.sort(), ['Mention · about-me', 'Mention · business-brain'])
  assert.equal(withClass(panel, 'mg-panel-meta')[0].textContent, 'CLAUDE.md · 2 lines')
  const [open] = withClass(panel, 'mg-open')
  assert.equal(open.hidden, false)
  open.listeners.click[0]({ preventDefault() {} })
  assert.equal(page.node('viewer-path').textContent, 'CLAUDE.md')

  exposed.graphSetSource('vault:0:1')
  exposed.graphSelect('vault:0:1#0')
  assert.equal(withClass(panel, 'mg-open')[0].hidden, true, 'a vault note offered Open')
})

test('a lonely note says what a lonely dot means instead of listing lines', async () => {
  const { page, exposed } = await boot()
  exposed.memorySetView('graph')
  await flush()
  const model = exposed.graphModel(graphPayload(), 'team')
  const lonely = model.nodes.find((node) => node.kind === 'note' && node.lonely && node.degree === 0)
  exposed.graphSelect(lonely.id)
  const [panel] = withClass(graphRoot(page), 'mg-panel')
  assert.match(textOf(panel), /missing link/)
})

test('a team repo with no notes yet says so in the middle of a short stage, and loads no library', async () => {
  const empty = graphPayload({ team: { notes: [], hubs: [], edges: [], lines: 0, lonely: 0, moreLines: 0, search: [], hidden: 0, more: 0, unread: 0 }, vaults: { status: 'none', why: 'No vault has been read yet.', read: 0, skipped: 0, unreadable: 0, notShown: 0, computers: [] } })
  const { page, exposed, libraries } = await boot({ graph: empty })
  exposed.memorySetView('graph')
  await flush()
  const [stage] = withClass(graphRoot(page), 'mg-stage')
  assert.equal(stage.classList.contains('mg-stage-empty'), true)
  assert.match(textOf(stage), /No notes to draw yet/)
  assert.deepEqual(libraries.loads, [])
  assert.match(textOf(graphRoot(page)), /No other vault is shared yet\. One appears here once its own computer allows it, vaults\.yml names it/)
})

test('what was left out is counted under the graph, in sentences that agree with their numbers', async () => {
  const graph = graphPayload()
  graph.team = { ...graph.team, hidden: 1, more: 2, unread: 1, moreLines: 3 }
  const { page, exposed } = await boot({ graph })
  exposed.memorySetView('graph')
  await flush()
  const foot = () => withClass(graphRoot(page), 'mg-foot-note').map((node) => node.textContent)
  assert.deepEqual(foot(), [
    '1 note is over 64 KB, too big to read, so it is not drawn.',
    '2 notes are past the first 400 and not drawn.',
    '1 note could not be read from GitHub, so its lines are missing.',
    '3 lines are past the board\'s limit and not drawn (day and tag lines go first).'
  ])
  exposed.graphSetSource('vault:0:1')
  assert.ok(foot().includes('1 note in Ideas has a title the board does not show.'), foot().join(' | '))
  assert.match(foot()[0], /^Ideas: shared by Mac Mini /)
})

test('the legend names every dot and every line kind, in words beside each colour', async () => {
  const { page, exposed } = await boot()
  exposed.memorySetView('graph')
  await flush()
  const [legend] = withClass(graphRoot(page), 'mg-legend')
  const words = textOf(legend)
  for (const phrase of ['A dot is a note', 'day or a tag', 'lonely', 'Links:', 'Mentions:', 'Agent:', 'Same day:', 'Same tag:']) {
    assert.ok(words.includes(phrase), `the legend does not say "${phrase}"`)
  }
  for (const kind of ['link', 'mention', 'agent', 'day', 'tag']) assert.equal(withClass(legend, `mg-k-${kind}`).length, 1, `no swatch for ${kind}`)
})

test('turning a line kind off hides those lines; Lonely only shows the lonely notes and no lines', async () => {
  const { exposed, libraries } = await boot()
  exposed.memorySetView('graph')
  await flush()
  exposed.graphToggleKind('mention')
  let graph = latest(libraries)
  const shows = graph.values.linkVisibility
  assert.equal(shows({ kind: 'mention' }), false)
  assert.equal(shows({ kind: 'agent' }), true)
  exposed.graphToggleLonely()
  graph = latest(libraries)
  const nodes = graph.values.graphData.nodes
  assert.ok(nodes.filter((node) => graph.values.nodeVisibility(node)).every((node) => node.lonely))
  assert.equal(graph.values.linkVisibility({ kind: 'agent' }), false)
  assert.equal(libraries.made.length, 1, 'a toggle rebuilt the drawing')
})

test('the list under the graph holds every dot; typing narrows it, and choosing one picks it', async () => {
  const { page, exposed } = await boot()
  exposed.memorySetView('graph')
  await flush()
  const model = exposed.graphModel(graphPayload(), 'team')
  let items = withClass(graphRoot(page), 'mg-item')
  assert.equal(items.length, model.nodes.length)
  assert.ok(items.every((item) => item.tagName === 'BUTTON'), 'a list item is not a button a keyboard can reach')
  exposed.graphSetFind('brain')
  items = withClass(graphRoot(page), 'mg-item')
  assert.equal(items.length, 1)
  items[0].listeners.click[0]({})
  assert.equal(exposed.graphState.selected, model.nodes.find((node) => node.path === 'shared/business-brain.md').id)
  const [panelTitle] = withClass(graphRoot(page), 'mg-panel-title')
  assert.ok(panelTitle.focused >= 1, 'the panel did not take the focus')
})

test('the canvas is hidden from screen readers; the list is labelled as the way in', async () => {
  const { page, exposed } = await boot()
  exposed.memorySetView('graph')
  await flush()
  const [canvas] = withClass(graphRoot(page), 'mg-canvas')
  assert.equal(canvas.attributes['aria-hidden'], 'true')
  const [list] = withClass(graphRoot(page), 'mg-list')
  assert.match(textOf(list), /Every dot, as a list/)
})

/* ---------- asking again, and when GitHub says wait ---------------------------------------------- */

test('coming back to Memory asks only whether anything changed, and a quick return asks nothing', async () => {
  const { page, exposed } = await boot()
  assert.equal(graphRequests(page).length, 1)
  exposed.showScreen('today')
  exposed.showScreen('memory')
  await flush()
  assert.equal(graphRequests(page).length, 1, 'a quick return asked again')
  exposed.graphState.checkedAt = 0
  exposed.showScreen('memory')
  await flush()
  assert.equal(graphRequests(page).at(-1).url, `/api/graph?since=${COMMIT}`)
})

test('GitHub\'s rate limit is said in words, and nothing is asked again until it has passed', async () => {
  const { page, exposed } = await boot({
    graphAnswer: async () => ({ ok: false, status: 429, headers: { get: (name) => (name === 'retry-after' ? '120' : null) }, json: async () => ({ error: "GitHub's rate limit was reached. Try again in 120 seconds." }) })
  })
  exposed.memorySetView('graph')
  await flush()
  assert.match(textOf(graphRoot(page)), /rate limit was reached/)
  exposed.graphState.checkedAt = 0
  exposed.showScreen('memory')
  await flush()
  assert.equal(graphRequests(page).length, 1, 'it asked again inside the Retry-After')
})

/* ---------- the stylesheet ------------------------------------------------------------------------ */

const rules = cssRules()
const sheet = sheetText()

test('every class the Memory graph writes has a rule, and none of its rules sets a colour but from a token', () => {
  // The graph's code in /app.js, and the view it loads when Graph opens.
  const block = app.slice(app.indexOf('/* ---------- Memory graph: begin'), app.indexOf('/* ---------- Memory graph: end')) +
    graphView.slice(graphView.indexOf('/* ---------- Memory graph view: begin'), graphView.indexOf('/* ---------- Memory graph view: end'))
  const used = new Set([...block.matchAll(/\b(mg-[a-z][a-z-]*|mem-[a-z][a-z-]*)/g)].map((match) => match[1]).filter((name) => !name.endsWith('-')))
  for (const kind of ['link', 'mention', 'agent', 'day', 'tag']) used.add(`mg-k-${kind}`)
  for (const dot of ['note', 'hub', 'lonely', 'picked']) used.add(`mg-d-${dot}`)
  used.delete('mg-k')
  used.delete('mg-d')
  assert.ok(used.size >= 20, `only ${used.size} classes were found`)
  for (const name of used) assert.ok(new RegExp(`\\.${name}(?![\\w-])`).test(sheet), `.${name} is used by the page and has no rule`)
  for (const rule of rules.filter((one) => /\.(mg|mem)-/.test(one.selector))) {
    assert.doesNotMatch(rule.body, /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i, `${rule.selector} writes a colour`)
  }
})

test('the graph\'s colours are tokens in every theme block', () => {
  const tokens = ['--graph-stage', '--graph-note', '--graph-lonely', '--graph-link', '--graph-mention', '--graph-agent', '--graph-day', '--graph-tag']
  for (const selector of [':root', ':root:not([data-theme="dark"])', ':root[data-theme="light"]']) {
    const block = rules.find((rule) => rule.selector === selector)
    for (const token of tokens) assert.ok(block.body.includes(`${token}:`), `${token} is not set in ${selector}`)
  }
})

test('nothing in the Memory graph moves unless motion is allowed, and every button a thumb can hit is 44px', () => {
  for (const rule of rules.filter((one) => /\.(mg|mem)-/.test(one.selector))) {
    if (/transition|animation/.test(rule.body)) assert.match(rule.condition ?? '', /prefers-reduced-motion:\s*no-preference/, `${rule.selector} moves with no motion query`)
  }
  for (const selector of ['.mem-view', '.mg-toggle', '.mg-item', '.mg-line', '.mg-mode']) {
    const heights = rules.filter((rule) => !rule.inMedia && rule.selector.split(',').map((one) => one.trim()).includes(selector))
      .map((rule) => /min-height:\s*([\d.]+)rem/.exec(rule.body)?.[1]).filter(Boolean).map(Number)
    assert.ok(heights.some((rem) => rem >= 2.75), `${selector} is shorter than 2.75rem`)
  }
})

test('nothing in the graph can push a phone sideways: the stage and the panels may shrink and long names break', () => {
  const body = (selector) => rules.filter((rule) => !rule.inMedia && rule.selector.split(',').map((one) => one.trim()).includes(selector)).map((rule) => rule.body).join(';')
  assert.match(body('.mg'), /min-width:\s*0/)
  assert.match(body('.mg-stage'), /overflow:\s*hidden/)
  for (const selector of ['.mg-panel-title', '.mg-item', '.mg-line']) assert.match(body(selector), /overflow-wrap:\s*anywhere/, `${selector} lets a long name run off the screen`)
  assert.match(body('.mg[hidden]'), /display:\s*none/, 'the hidden graph is still laid out')
  // Found in Chromium at 390: the page-wide input[type=search] rule outranks a bare .mg-find, so the find
  // box was full width plus its margin, and opening the list widened the page by 17px.
  assert.match(body('input[type=search].mg-find'), /width:\s*calc\(100% - 2\.1rem\)/, 'the find box can be pushed to full width by the page-wide search rule')
  assert.equal(rules.filter((rule) => rule.selector === '.mg-find').length, 0, 'a bare .mg-find rule loses to input[type=search]')
})

test('somebody who leaves Graph while its drawing code is on the way gets no drawing behind the list', async () => {
  let arrive
  const view = () => new Promise((resolve) => { arrive = resolve })
  const { exposed, libraries } = await boot({ view })
  exposed.memorySetView('graph')
  exposed.memorySetView('list')
  arrive(true)
  await flush()
  assert.equal(exposed.graphState.refs, null, 'the graph was built after the person had gone back to the list')
  assert.deepEqual(libraries.loads, [])
})

test('a graph drawn in a tab the browser calls hidden is not paused by the board, and nothing stale is left when it is seen', async () => {
  // A background tab, or one a script drives, can report hidden while it is still drawn. The browser
  // already holds back animation frames for a tab nobody sees, so the board does not add a pause of its
  // own when it first draws: the graph shows the moment the tab is looked at.
  const { page, exposed, libraries } = await boot()
  page.document.visibilityState = 'hidden'
  exposed.memorySetView('graph')
  await flush()
  const graph = latest(libraries)
  assert.equal(graph.paused, 0, 'the first drawing was paused because the tab said hidden')
  assert.equal(exposed.graphState.paused, false)
  const visibility = page.documentListeners.filter((entry) => entry.type === 'visibilitychange').map((entry) => entry.handler)
  page.document.visibilityState = 'visible'
  visibility.forEach((handler) => handler())
  assert.equal(exposed.graphState.paused, false, 'coming into view left the drawing paused')
  // Hidden after it was drawn: paused, and seen again: resumed.
  page.document.visibilityState = 'hidden'
  visibility.forEach((handler) => handler())
  assert.equal(graph.paused, 1)
  page.document.visibilityState = 'visible'
  visibility.forEach((handler) => handler())
  assert.equal(graph.resumed, 1)
  assert.equal(exposed.graphState.paused, false)
})

test('the 3D view is framed on the frame after the layout stops, once the dots have been placed, never before', async () => {
  // Found in Chromium: for someone who asked for less motion the layout stops on its first frame, before
  // the 3D library has put the dots where the layout says. Framed there, every dot was still at the middle,
  // and the camera went inside the cloud: one dot 267 px across, four in five out of view.
  const frames = []
  const { exposed, libraries } = await boot({ motion: { reducedMotion: true }, frames })
  exposed.memorySetView('graph')
  await flush()
  const graph = latest(libraries)
  graph.values.onEngineStop()
  assert.equal(graph.calls.filter((entry) => entry[0] === 'zoomToFit').length, 0, 'it framed the graph before the dots were placed')
  for (const frame of frames.splice(0)) frame()
  assert.equal(graph.calls.filter((entry) => entry[0] === 'zoomToFit').length, 1, 'it never framed the graph')
})

test('the fit waits, a frame at a time, until the drawn dots span what the layout says', async () => {
  const frames = []
  const { exposed, libraries } = await boot({ frames })
  exposed.memorySetView('graph')
  await flush()
  const graph = latest(libraries)
  const nodes = graph.values.graphData.nodes
  nodes.forEach((node, index) => { node.x = index * 10 - 40 })
  // The library still has every dot at the middle.
  graph.values.getGraphBbox = { x: [-1, 1], y: [-1, 1], z: [-1, 1] }
  graph.values.onEngineStop()
  frames.shift()()
  const fits = () => graph.calls.filter((entry) => entry[0] === 'zoomToFit').length
  assert.equal(fits(), 0, 'it framed dots that were not yet placed')
  graph.values.getGraphBbox = { x: [-40, 10 * nodes.length - 50], y: [-30, 30], z: [-30, 30] }
  frames.shift()()
  assert.equal(fits(), 1)
})
