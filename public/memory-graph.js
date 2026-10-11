'use strict'

/* ---------- Memory graph view: begin ----------
   Memory, Graph: the part of the board that draws the graph. It is its own file, not part of /app.js,
   so nobody pays for it until they open Graph: the page asks for it then (graphDeps.view, in /app.js),
   with the drawing library, and only the first time. It shares the page's own names - el,
   readinessNode, graphState, graphDeps and the rest - because both are plain scripts of one page.
   Everything a person reads is set as text: a title is whatever somebody called a note. */

// Past this many dots a drawing shows the most connected ones and says so; the list keeps every one.
const GRAPH_NODE_CAP = { flat: 800, '3d': 2400 }

// The list under the graph shows this many at once, and says how to narrow it.
const GRAPH_LIST_MAX = 200

// For someone who asked for less motion, the layout is worked out this far before the first frame and
// then frozen, so nothing drifts into place on screen.
const GRAPH_STILL_TICKS = 220

// How far one dot's push reaches, in the layout's own units.
const GRAPH_PUSH_REACH = 140

// The layout stops after this many of its own steps, then is framed. Steps, not seconds: by the clock, a
// tab that gets few animation frames (in the background, or driven by a script) froze half-spread.
const GRAPH_SETTLE_TICKS = 300

// How strongly every dot is drawn toward the middle at each step, so notes nothing links to stay near
// the rest and the framed graph is not mostly empty space.
const GRAPH_GATHER = 0.04

// A dot's size in each drawing, and the room left round the graph when it is framed (px) and the glide.
const GRAPH_DOT_SIZE = { '3d': 6, flat: 4 }
const GRAPH_FIT = { ms: 400, padding: 40, waitFrames: 10 }

// The order the server numbers line kinds in (TEAM_EDGE_KINDS), and the order they are shown in.
const GRAPH_EDGE_KINDS = ['link', 'mention', 'day', 'tag', 'agent']

const GRAPH_KINDS = ['link', 'mention', 'agent', 'day', 'tag']

const GRAPH_KIND_WORDS = {
  link: { chip: 'Links', short: 'Link', legend: 'Links: one note names the other in [[double brackets]].' },
  mention: { chip: 'Mentions', short: 'Mention', legend: 'Mentions: one note gives the other\'s path, or a [link](to/it.md).' },
  agent: { chip: 'Agents', short: 'Agent', legend: 'Agent: a note in an agent\'s folder, or a task for that agent, and the agent\'s own file.' },
  day: { chip: 'Same day', short: 'Same day', legend: 'Same day: notes dated the same day hang off one day dot.' },
  tag: { chip: 'Same tag', short: 'Same tag', legend: 'Same tag: notes that share a tag, project or person hang off one tag dot.' }
}

function graphHasWebgl() {
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch (error) {
    return false
  }
}

function graphColours() {
  const style = window.getComputedStyle(document.documentElement)
  const token = (name) => style.getPropertyValue(name).trim()
  return {
    note: token('--graph-note'), lonely: token('--graph-lonely'), picked: token('--accent'), stage: token('--graph-stage'),
    link: token('--graph-link'), mention: token('--graph-mention'), agent: token('--graph-agent'), day: token('--graph-day'), tag: token('--graph-tag')
  }
}

// A token's colour partly see-through, for the flat drawing's lines.
function graphFaint(colour, alpha) {
  const hex = /^#([0-9a-f]{6})$/i.exec(colour ?? '')
  if (!hex) return colour
  const value = parseInt(hex[1], 16)
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`
}

// 3D where it can be drawn well and is wanted; flat on a phone, a slow device, or for someone who asked
// for less motion. The switch on the screen wins, except that 3D needs WebGL.
function graphModeFor({ finePointer, webgl, reducedMotion, deviceMemory, saved }) {
  if (saved === 'flat') return 'flat'
  if (saved === '3d') return webgl ? '3d' : 'flat'
  const enoughMemory = typeof deviceMemory !== 'number' || deviceMemory >= 4
  return finePointer && webgl && !reducedMotion && enoughMemory ? '3d' : 'flat'
}

function graphCanDraw3d() {
  graphState.webgl ??= Boolean(graphDeps.webgl())
  return graphState.webgl
}

function graphChosenMode() {
  return graphModeFor({ ...graphDeps.motion(), webgl: graphCanDraw3d(), saved: readStore(GRAPH_MODE_STORE) })
}

/* --- what the graph holds ------------------------------------------------------------------------ */

// The team repo, then each vault a computer shared, then All when there is more than one.
function graphSources(payload) {
  const sources = []
  if (payload?.team && Array.isArray(payload.team.notes)) sources.push({ key: 'team', label: 'Team repo', kind: 'team', data: payload.team })
  const computers = payload?.vaults?.status === 'ok' && Array.isArray(payload.vaults.computers) ? payload.vaults.computers : []
  computers.forEach((computer, c) => {
    const items = computer?.vaults?.status === 'found' && Array.isArray(computer.vaults.items) ? computer.vaults.items : []
    items.forEach((vault, v) => {
      const label = computers.length > 1 && computer.computer ? `${vault.name} · ${computer.computer}` : vault.name
      sources.push({ key: `vault:${c}:${v}`, label, kind: 'vault', data: vault, computer })
    })
  })
  if (sources.length > 1) sources.push({ key: 'all', label: 'All', kind: 'all' })
  return sources
}

// One source's dots and lines. A note with no title shared - a vault shared as dots and lines - is
// "Note 7", never anything read from the file.
function graphPart(source) {
  const team = source.kind === 'team'
  const data = source.data
  const count = team ? data.notes.length : (Number.isInteger(data.notes) ? data.notes : 0)
  const hubs = Array.isArray(data.hubs) ? data.hubs : []
  const nodes = []
  for (let dot = 0; dot < count; dot += 1) {
    const note = (team ? data.notes[dot] : data.nodes?.[dot]) ?? {}
    const titled = typeof note.title === 'string' && note.title !== ''
    nodes.push({
      id: `${source.key}#${dot}`, dot, kind: 'note', source: source.key, sourceLabel: source.label,
      label: titled ? note.title : `Note ${dot + 1}`, named: titled,
      path: team && typeof note.path === 'string' ? note.path : null,
      folder: typeof note.folder === 'string' ? note.folder : null,
      day: typeof note.day === 'string' ? note.day : null,
      opens: team && note.opens === true, lonely: true, degree: 0
    })
  }
  hubs.forEach((hub, index) => {
    const named = typeof hub?.label === 'string' && hub.label !== ''
    const kind = hub?.kind === 'day' ? 'day' : 'tag'
    nodes.push({
      id: `${source.key}#${count + index}`, dot: count + index, kind, source: source.key, sourceLabel: source.label,
      label: named ? hub.label : (kind === 'day' ? 'A day' : 'A tag'), named,
      path: null, folder: null, day: null, opens: false, lonely: false, degree: 0
    })
  })
  const links = []
  for (const edge of Array.isArray(data.edges) ? data.edges : []) {
    const [from, to, index] = Array.isArray(edge) ? edge : []
    const kind = GRAPH_EDGE_KINDS[index]
    if (!kind || !nodes[from] || !nodes[to]) continue
    links.push({ source: nodes[from].id, target: nodes[to].id, kind })
    nodes[from].degree += 1
    nodes[to].degree += 1
    if (kind === 'link' || kind === 'mention') {
      nodes[from].lonely = false
      nodes[to].lonely = false
    }
  }
  return { nodes, links, notes: count }
}

function graphModel(payload, key) {
  const sources = graphSources(payload)
  const source = sources.find((one) => one.key === key) ?? sources[0]
  if (!source) return null
  const parts = (source.kind === 'all' ? sources.filter((one) => one.kind !== 'all') : [source]).map(graphPart)
  const nodes = parts.flatMap((part) => part.nodes)
  const links = parts.flatMap((part) => part.links)
  return {
    source,
    nodes,
    links,
    counts: {
      notes: parts.reduce((sum, part) => sum + part.notes, 0),
      lines: links.length,
      lonely: nodes.filter((node) => node.kind === 'note' && node.lonely).length
    },
    kinds: GRAPH_KINDS.filter((kind) => links.some((link) => link.kind === kind))
  }
}

// Up to `cap` dots, the most connected first, and only the lines between dots that are kept.
function graphCap(model, cap) {
  const total = model.nodes.length
  if (total <= cap) return { nodes: model.nodes, links: model.links, shown: total, total }
  const order = new Map(model.nodes.map((node, index) => [node.id, index]))
  const kept = [...model.nodes].sort((a, b) => b.degree - a.degree || order.get(a.id) - order.get(b.id)).slice(0, cap)
  const ids = new Set(kept.map((node) => node.id))
  return {
    nodes: kept.sort((a, b) => order.get(a.id) - order.get(b.id)),
    links: model.links.filter((link) => ids.has(link.source) && ids.has(link.target)),
    shown: cap,
    total
  }
}

function graphCurrentModel() {
  if (!graphState.data) return null
  const key = graphState.source
  if (graphState.modelFor?.data !== graphState.data || graphState.modelFor.key !== key) {
    graphState.modelFor = { data: graphState.data, key, model: graphModel(graphState.data, key) }
  }
  return graphState.modelFor.model
}

const graphShowsNode = (node) => !graphState.lonelyOnly || (node.kind === 'note' && node.lonely)

const graphShowsLink = (link) => !graphState.lonelyOnly && !graphState.hiddenKinds.has(link.kind)

// The legend: what each dot and each line means, in words beside its colour, always in view.
function graphLegendNode() {
  const node = readinessNode
  const row = (swatch, words) => node('li', { cls: 'mg-legend-row' }, node('span', { cls: `mg-swatch ${swatch}`, attrs: { 'aria-hidden': 'true' } }), node('span', { text: words }))
  return node('section', { cls: 'panel mg-legend', attrs: { 'aria-label': 'What the dots and lines mean' } },
    node('p', { cls: 'eyebrow', text: 'What you are looking at' }),
    node('ul', { cls: 'mg-legend-list' },
      row('mg-dot mg-d-note', 'A dot is a note.'),
      row('mg-dot mg-d-hub', 'A bigger dot is a day or a tag that two or more notes share.'),
      row('mg-dot mg-d-lonely', 'An amber dot is lonely: nothing links to it and it links to nothing. A lonely dot is a missing link.'),
      row('mg-dot mg-d-picked', 'The red dot is the one you picked.'),
      ...GRAPH_KINDS.map((kind) => row(`mg-k-${kind}`, GRAPH_KIND_WORDS[kind].legend))))
}

// Built once per screen (the screen's markup is redrawn with the board, and this goes with it).
// The Readiness wall's element maker is the board's general one: every word goes in as text.
function graphShell(container) {
  if (graphState.refs?.container === container) return graphState.refs
  const node = readinessNode
  const button = (cls, text, attrs = {}) => node('button', { cls, text, attrs: { type: 'button', ...attrs } })
  const count = node('p', { cls: 'mg-count', attrs: { role: 'status' } })
  const status = node('p', { cls: 'mg-status small muted' })
  const sources = node('div', { cls: 'filters mg-sources', attrs: { role: 'group', 'aria-label': 'Which notes' } })
  const mode3d = button('mg-mode', '3D', { 'aria-pressed': 'false' })
  const modeFlat = button('mg-mode', 'Flat', { 'aria-pressed': 'false' })
  const toggles = node('div', { cls: 'mg-tools', attrs: { role: 'group', 'aria-label': 'Which lines' } })
  const canvas = node('div', { cls: 'mg-canvas', attrs: { 'aria-hidden': 'true' } })
  const stageNote = node('p', { cls: 'mg-stage-note' })
  const stage = node('div', { cls: 'mg-stage' }, canvas, stageNote)
  const panelTitle = node('h3', { cls: 'mg-panel-title', attrs: { id: 'mg-panel-title', tabindex: '-1' } })
  const panelMeta = node('p', { cls: 'mg-panel-meta small muted' })
  const panelLines = node('ul', { cls: 'mg-lines' })
  const panelNote = node('p', { cls: 'mg-panel-note small muted' })
  const open = button('fire mg-open', 'Open')
  const github = node('a', { cls: 'mg-github', text: 'See it on GitHub', attrs: { rel: 'noreferrer noopener', target: '_blank' } })
  const close = button('link-button mg-close', 'Close')
  const panel = node('aside', { cls: 'panel mg-panel', attrs: { 'aria-labelledby': 'mg-panel-title' } },
    panelTitle, panelMeta, panelLines, panelNote, node('div', { cls: 'mg-actions' }, open, github, close))
  panel.hidden = true
  const body = node('div', { cls: 'mg-body' }, stage, panel)
  const legend = graphLegendNode()
  const find = node('input', { cls: 'mg-find', attrs: { type: 'search', placeholder: 'Find a dot by name', 'aria-label': 'Find a dot by name' } })
  const listNote = node('p', { cls: 'mg-list-note small muted' })
  const items = node('ul', { cls: 'mg-items' })
  const list = node('details', { cls: 'panel mg-list' }, node('summary', { cls: 'mg-list-head', text: 'Every dot, as a list' }), node('div', { cls: 'mg-list-body' }, find, listNote, items))
  const foot = node('div', { cls: 'mg-foot' })
  const head = node('div', { cls: 'mg-head' }, count, status, sources,
    node('div', { cls: 'mg-tools-row' }, node('div', { cls: 'mg-modes', attrs: { role: 'group', 'aria-label': 'Draw it' } }, mode3d, modeFlat), toggles))
  readinessReplace(container, [head, body, legend, list, foot])

  mode3d.addEventListener('click', () => graphSetMode('3d'))
  modeFlat.addEventListener('click', () => graphSetMode('flat'))
  open.addEventListener('click', () => {
    const picked = graphSelectedNode()
    if (picked?.opens) openFile(picked.path)
  })
  close.addEventListener('click', () => graphSelect(null, { returnFocus: true }))
  find.addEventListener('input', (event) => graphSetFind(event.target?.value ?? ''))
  container.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && graphState.selected) graphSelect(null, { returnFocus: true })
  })
  graphState.refs = { container, count, status, sources, mode3d, modeFlat, toggles, canvas, stageNote, stage, panel, panelTitle, panelMeta, panelLines, panelNote, open, github, close, legend, find, listNote, items, list, foot, body }
  graphState.items = new Map()
  return graphState.refs
}

function graphRender() {
  const refs = graphState.refs
  if (!refs) return
  const model = graphCurrentModel()
  for (const part of [refs.body, refs.legend, refs.list]) part.hidden = !model
  if (!model) {
    refs.count.textContent = ''
    refs.status.textContent = graphState.error ?? 'Reading your notes…'
    readinessReplace(refs.sources, [])
    readinessReplace(refs.toggles, [])
    readinessReplace(refs.foot, [])
    return
  }
  // A failed re-check keeps the graph already drawn, and says so.
  refs.status.textContent = graphState.error ?? ''
  const sources = graphSources(graphState.data)
  readinessReplace(refs.sources, sources.map((source) => {
    const on = source.key === model.source.key
    const chip = readinessNode('button', { cls: `chip mg-source${on ? ' on' : ''}`, text: source.label, attrs: { type: 'button', 'aria-pressed': String(on) } })
    chip.addEventListener('click', () => graphSetSource(source.key))
    return chip
  }))
  refs.sources.hidden = sources.length < 2
  refs.count.textContent = `${plural(model.counts.notes, 'note')} · ${plural(model.counts.lines, 'line')} · ${model.counts.lonely} lonely`
  graphState.mode ??= graphChosenMode()
  refs.mode3d.setAttribute('aria-pressed', String(graphState.mode === '3d'))
  refs.modeFlat.setAttribute('aria-pressed', String(graphState.mode === 'flat'))
  refs.mode3d.disabled = !graphCanDraw3d()
  if (refs.mode3d.disabled) refs.mode3d.setAttribute('title', 'This browser cannot draw in 3D here.')
  graphRenderToggles(model)
  graphRenderList(model)
  graphRenderPanel(model)
  graphRenderFoot(model)
  graphDraw(model)
}

function graphRenderToggles(model) {
  const swatch = (cls) => readinessNode('span', { cls: `mg-swatch ${cls}`, attrs: { 'aria-hidden': 'true' } })
  const chips = model.kinds.map((kind) => {
    const chip = readinessNode('button', { cls: 'chip mg-toggle', attrs: { type: 'button', 'aria-pressed': String(!graphState.hiddenKinds.has(kind)) } },
      swatch(`mg-k-${kind}`), readinessNode('span', { text: GRAPH_KIND_WORDS[kind].chip }))
    chip.addEventListener('click', () => graphToggleKind(kind))
    return chip
  })
  const lonely = readinessNode('button', { cls: 'chip mg-toggle', attrs: { type: 'button', 'aria-pressed': String(graphState.lonelyOnly) } },
    swatch('mg-dot mg-d-lonely'), readinessNode('span', { text: 'Lonely only' }))
  lonely.addEventListener('click', () => graphToggleLonely())
  readinessReplace(graphState.refs.toggles, [...chips, lonely])
}

const graphItemMeta = (node, model) => [
  model.source.kind === 'all' ? node.sourceLabel : null,
  node.kind === 'note' ? null : node.kind === 'day' ? 'a day' : 'a tag',
  plural(node.degree, 'line'),
  node.kind === 'note' && node.lonely ? 'lonely' : null
].filter(Boolean).join(' · ')

function graphRenderList(model) {
  const refs = graphState.refs
  const query = graphState.find.trim().toLowerCase()
  const matches = query
    ? model.nodes.filter((node) => node.label.toLowerCase().includes(query) || (node.path ?? '').toLowerCase().includes(query))
    : model.nodes
  const shown = matches.slice(0, GRAPH_LIST_MAX)
  graphState.items = new Map()
  readinessReplace(refs.items, shown.map((node) => {
    const item = readinessNode('button', { cls: 'mg-item', attrs: { type: 'button', 'aria-current': String(node.id === graphState.selected) } },
      readinessNode('span', { cls: 'mg-item-name', text: node.label }),
      readinessNode('span', { cls: 'mg-item-meta small muted', text: graphItemMeta(node, model) }))
    item.addEventListener('click', () => graphSelect(node.id, { focusPanel: true }))
    graphState.items.set(node.id, item)
    return readinessNode('li', {}, item)
  }))
  refs.listNote.textContent = matches.length > shown.length
    ? `Showing ${shown.length} of ${matches.length.toLocaleString('en-US')}. Type a name to narrow it.`
    : query && !matches.length ? `No dot is called "${graphState.find.trim()}".` : ''
}

function graphSelectedNode() {
  return graphCurrentModel()?.nodes.find((node) => node.id === graphState.selected) ?? null
}

// What the panel says under a dot's name: where it lives, and for a vault, what of it was shared.
function graphPanelMeta(node, model) {
  if (node.kind !== 'note') return `A ${node.kind} that ${plural(node.degree, 'note')} share${node.degree === 1 ? 's' : ''}${model.source.kind === 'all' ? `, in ${node.sourceLabel}` : ''}.`
  if (node.path) return [node.path, node.day].filter(Boolean).join(' · ')
  return [node.folder, node.day, `In ${node.sourceLabel}`].filter(Boolean).join(' · ')
}

function graphVaultOf(key) {
  return graphSources(graphState.data).find((source) => source.key === key) ?? null
}

function graphPanelNote(node, lines) {
  const vault = node.path === null ? graphVaultOf(node.source) : null
  const where = vault?.computer?.computer ?? 'the computer it came from'
  const notes = []
  if (node.kind === 'note' && node.lonely) {
    notes.push(lines ? 'Lonely: no link or mention reaches this note. A lonely dot is a missing link.' : 'No lines: nothing links here and it links to nothing. A lonely dot is a missing link.')
  }
  if (vault && node.kind === 'note') notes.push(node.named ? `The note stays on ${where}: the board has only its name.` : `Its title stays on ${where}.`)
  return notes.join(' ')
}

function graphRenderPanel(model) {
  const refs = graphState.refs
  const node = model.nodes.find((one) => one.id === graphState.selected)
  refs.panel.hidden = !node
  if (!node) return
  refs.panelTitle.textContent = node.label
  const byId = new Map(model.nodes.map((one) => [one.id, one]))
  const lines = model.links.filter((link) => link.source === node.id || link.target === node.id)
  refs.panelMeta.textContent = `${graphPanelMeta(node, model)}${node.kind === 'note' && lines.length ? ` · ${plural(lines.length, 'line')}` : ''}`
  readinessReplace(refs.panelLines, lines.map((link) => {
    const other = byId.get(link.source === node.id ? link.target : link.source)
    const line = readinessNode('button', { cls: 'mg-line', attrs: { type: 'button' } },
      readinessNode('span', { cls: `mg-swatch mg-k-${link.kind}`, attrs: { 'aria-hidden': 'true' } }),
      readinessNode('span', { text: `${GRAPH_KIND_WORDS[link.kind].short} · ${other.label}` }))
    line.addEventListener('click', () => graphSelect(other.id, { focusPanel: true }))
    return readinessNode('li', {}, line)
  }))
  refs.panelNote.textContent = graphPanelNote(node, lines.length)
  refs.open.hidden = !node.opens
  // A note in .claude/ is one /api/file does not open; GitHub shows it.
  const onGithub = Boolean(node.path) && !node.opens && Boolean(repoBase)
  refs.github.hidden = !onGithub
  if (onGithub) refs.github.setAttribute('href', blobUrl(node.path))
}

function graphRenderFoot(model) {
  const notes = []
  // A count, then the words that agree with it: [one, many].
  const say = (count, one, many, [tailOne, tailMany]) => { if (count > 0) notes.push(`${plural(count, one, many)} ${count === 1 ? tailOne : tailMany}`) }
  const parts = model.source.kind === 'all' ? graphSources(graphState.data).filter((one) => one.kind !== 'all') : [model.source]
  for (const source of parts) {
    const part = source.data
    if (source.kind === 'team') {
      say(part.hidden ?? 0, 'note', 'notes', ['is over 64 KB, too big to read, so it is not drawn.', 'are over 64 KB, too big to read, so they are not drawn.'])
      say(part.more ?? 0, 'note', 'notes', ['is past the first 400 and not drawn.', 'are past the first 400 and not drawn.'])
      say(part.unread ?? 0, 'note', 'notes', ['could not be read from GitHub, so its lines are missing.', 'could not be read from GitHub, so their lines are missing.'])
      say(part.moreLines ?? 0, 'line', 'lines', ['is past the board\'s limit and not drawn (day and tag lines go first).', 'are past the board\'s limit and not drawn (day and tag lines go first).'])
      continue
    }
    const computer = source.computer?.computer ?? 'its computer'
    notes.push(`${part.name}: shared by ${computer} ${ago(source.computer?.takenAt)}.`)
    if (source.computer?.freshness === 'stale') notes.push(`${part.name} has not been updated since ${stamp(source.computer.takenAt)}: the collector on ${computer} has not shared a newer one.`)
    if (part.level === 'shape') notes.push(`The titles stay on ${computer}: ${part.name} is shared as dots and lines only.`)
    say(part.untitled ?? 0, 'note in ' + part.name, 'notes in ' + part.name, ['has a title the board does not show.', 'have titles the board does not show.'])
    say(part.hidden ?? 0, 'note in ' + part.name, 'notes in ' + part.name, ['could not be read on its computer.', 'could not be read on its computer.'])
    say(part.more ?? 0, 'note in ' + part.name, 'notes in ' + part.name, ['is past its cap and was not shared.', 'are past its cap and were not shared.'])
    say(part.moreLines ?? 0, 'line in ' + part.name, 'lines in ' + part.name, ['is past its cap and was not shared.', 'are past its cap and were not shared.'])
  }
  const vaults = graphState.data?.vaults
  if (vaults?.status === 'unusable') notes.push(`Your other vaults could not be shown. ${vaults.why ?? ''}`.trim())
  for (const computer of vaults?.status === 'ok' ? vaults.computers : []) {
    if (computer?.vaults?.status === 'unavailable') notes.push(`The vaults on ${computer.computer ?? 'a computer'} could not be shared${computer.vaults.why ? `: ${computer.vaults.why}` : ''}.`)
  }
  if (model.source.kind === 'team' && graphSources(graphState.data).length === 1) {
    notes.push('No other vault is shared yet. One appears here once its own computer allows it, vaults.yml names it, and the collector there has run.')
  }
  readinessReplace(graphState.refs.foot, notes.map((text) => readinessNode('p', { cls: 'mg-foot-note small muted', text })))
}

/* --- drawing -------------------------------------------------------------------------------------- */

function graphTip(node) {
  // The library puts a string label into the page as markup, so a label is always an element with
  // the note's name as its text.
  const tip = document.createElement('span')
  tip.className = 'mg-tip'
  tip.textContent = node.label
  return tip
}

function graphStageSize() {
  const canvas = graphState.refs?.canvas
  return { width: Math.max(240, Math.round(canvas?.clientWidth || 640)), height: Math.max(240, Math.round(canvas?.clientHeight || 420)) }
}

function graphStageNote(capped, mode) {
  if (capped.shown < capped.total) {
    return `Showing the ${capped.shown.toLocaleString('en-US')} most connected of ${capped.total.toLocaleString('en-US')} dots. Every dot is in the list below.`
  }
  const touch = !graphDeps.motion().finePointer
  const hint = mode === '3d'
    ? (touch ? 'Drag to turn it, pinch to zoom.' : 'Drag to turn it, scroll to zoom.')
    : (touch ? 'Pinch to zoom, drag to move.' : 'Scroll to zoom, drag to move.')
  return [graphState.note, hint, `${touch ? 'Tap' : 'Click'} a dot to see its lines.`].filter(Boolean).join(' ')
}

// The colours, sizes and what is shown, read again on every change: a toggle, a pick, a theme.
function graphRestyle(instance = graphState.instance, mode = graphState.drawn?.mode ?? graphState.mode) {
  if (!instance) return
  const colours = graphDeps.colours()
  const picked = graphState.selected
  instance.backgroundColor(colours.stage)
  instance.nodeVal((node) => (node.kind === 'note' ? 1 : 4) * (node.id === picked ? 2 : 1))
  instance.nodeColor((node) => (node.id === picked ? colours.picked
    : node.kind === 'day' ? colours.day
      : node.kind === 'tag' ? colours.tag
        : node.lonely ? colours.lonely : colours.note))
  instance.linkColor((link) => (mode === '3d' ? colours[link.kind] : graphFaint(colours[link.kind], 0.6)))
  instance.nodeVisibility((node) => graphShowsNode(node))
  instance.linkVisibility((link) => graphShowsLink(link))
}

// Whether the drawing has put its dots where the layout says: what the library would frame (its box of
// what it drew) spans at least half of what the layout spans, side to side. A library that frames from
// the layout itself (the flat one) or says nothing is taken at its word.
function graphDotsPlaced(instance) {
  const box = instance.getGraphBbox?.()
  const xs = (instance.graphData?.()?.nodes ?? []).map((node) => node.x).filter(Number.isFinite)
  if (!box || !Array.isArray(box.x) || xs.length < 2) return true
  const laidOut = Math.max(...xs) - Math.min(...xs)
  return laidOut === 0 || box.x[1] - box.x[0] >= laidOut / 2
}

// A d3 force that draws every dot a little toward the middle, in depth too for 3D.
function graphGatherForce(withDepth) {
  let nodes = []
  const force = (alpha) => {
    const pull = GRAPH_GATHER * alpha
    for (const node of nodes) {
      node.vx -= (node.x || 0) * pull
      node.vy -= (node.y || 0) * pull
      if (withDepth && node.z !== undefined) node.vz -= (node.z || 0) * pull
    }
  }
  force.initialize = (given) => { nodes = given }
  return force
}

function graphConfigure(instance, mode, capped) {
  const motion = graphDeps.motion()
  const still = motion.reducedMotion
  const size = graphStageSize()
  // The d3 layout engine. The other one (ngraph) builds code from text, which this page's policy refuses.
  if (mode === '3d') instance.forceEngine('d3')
  instance.width(size.width).height(size.height)
  instance.nodeId('id')
  instance.nodeLabel((node) => graphTip(node))
  instance.linkLabel(() => null)
  // A finger on a phone moves the view; only a mouse drags a dot.
  instance.enableNodeDrag(Boolean(motion.finePointer))
  instance.onNodeClick((node) => graphSelect(node.id))
  instance.onBackgroundClick(() => graphSelect(null))
  if (still) instance.warmupTicks(GRAPH_STILL_TICKS).cooldownTicks(0)
  else instance.cooldownTicks(GRAPH_SETTLE_TICKS)
  instance.cooldownTime(Infinity)
  // Dots push each other apart only nearby, and every dot is drawn gently to the middle, so a lonely note
  // settles close to the rest instead of drifting off the edge.
  instance.d3Force?.('charge')?.distanceMax?.(GRAPH_PUSH_REACH)
  instance.d3Force?.('gather', graphGatherForce(mode === '3d'))
  // Once the layout settles, the whole graph is framed in view, once - unless the person has already
  // taken hold of it, and then the view stays theirs. A new drawing (Flat to 3D) starts a new camera.
  let framed = false
  let held = false
  instance.onEngineStop(() => {
    if (framed || held) return
    framed = true
    // On the next frame, not now: the library places the dots after the layout stops, and the 3D fit
    // measures where they were drawn. Framed now, a layout that stopped on its first frame (less motion)
    // still had every dot at the middle, and the camera went inside the cloud.
    // A drawing just made from a library already in memory can take a few frames more to place its dots,
    // so the fit waits until what is drawn spans what the layout says (ten frames at most).
    const fit = (tries) => window.requestAnimationFrame(() => {
      if (held) return
      if (tries < GRAPH_FIT.waitFrames && !graphDotsPlaced(instance)) {
        fit(tries + 1)
        return
      }
      instance.zoomToFit(still ? 0 : GRAPH_FIT.ms, GRAPH_FIT.padding)
    })
    fit(0)
  })
  if (mode === '3d') {
    instance.showNavInfo(false).nodeRelSize(GRAPH_DOT_SIZE['3d']).nodeOpacity(0.92).linkOpacity(0.45).nodeResolution(10)
    instance.renderer()?.setPixelRatio?.(graphDeps.pixelRatio())
    const controls = instance.controls?.()
    if (controls) {
      // A slow turn, only for someone who has not asked for less motion, and only until they take hold.
      controls.autoRotate = !still
      controls.autoRotateSpeed = 0.6
      controls.addEventListener?.('start', () => {
        controls.autoRotate = false
        held = true
      })
    }
  } else {
    instance.nodeRelSize(GRAPH_DOT_SIZE.flat)
  }
  graphRestyle(instance, mode)
  instance.graphData({ nodes: capped.nodes.map((node) => ({ ...node })), links: capped.links.map((link) => ({ ...link })) })
}

async function graphDraw(model) {
  const refs = graphState.refs
  const mode = graphState.mode
  refs.stage.classList.toggle('mg-stage-empty', !model.nodes.length)
  if (!model.nodes.length) {
    graphTeardownInstance()
    refs.stageNote.textContent = model.source.kind === 'team'
      ? 'No notes to draw yet. A page added to your team repo appears here as a dot.'
      : 'This vault has no notes to draw.'
    return
  }
  const drawn = graphState.drawn
  if (graphState.instance && drawn?.refs === refs && drawn.mode === mode) {
    // Same drawing: only what is shown changes. Another source or a newer graph: new dots, same library.
    if (drawn.data !== graphState.data || drawn.key !== model.source.key) {
      const capped = graphCap(model, GRAPH_NODE_CAP[mode])
      graphState.instance.graphData({ nodes: capped.nodes.map((node) => ({ ...node })), links: capped.links.map((link) => ({ ...link })) })
      graphState.drawn = { ...drawn, data: graphState.data, key: model.source.key }
      refs.stageNote.textContent = graphStageNote(capped, mode)
    }
    graphRestyle()
    graphResume()
    return
  }
  // A library on its way for this very drawing: let it finish.
  if (graphState.drawing?.refs === refs && graphState.drawing.mode === mode) return
  graphTeardownInstance()
  const ticket = { refs, mode }
  graphState.drawing = ticket
  refs.stageNote.textContent = 'Drawing…'
  let Factory
  try {
    Factory = await graphDeps.load(mode)
  } catch (error) {
    if (graphState.drawing !== ticket) return
    graphState.drawing = null
    refs.stageNote.textContent = 'The graph could not be drawn: its library did not load. The list below still has every note.'
    return
  }
  // The screen moved on while the library loaded.
  if (graphState.drawing !== ticket || graphState.refs !== refs) return
  graphState.drawing = null
  const current = graphCurrentModel()
  const capped = graphCap(current, GRAPH_NODE_CAP[mode])
  let instance = null
  try {
    instance = mode === '3d' ? new Factory(refs.canvas, { controlType: 'orbit' }) : new Factory(refs.canvas)
    graphConfigure(instance, mode, capped)
  } catch (error) {
    try { instance?._destructor?.() } catch (failure) { /* already gone */ }
    if (mode === '3d') {
      // 3D needs WebGL that works. When this device cannot start it, the flat drawing takes over.
      graphState.mode = 'flat'
      graphState.note = '3D could not start on this device, so the graph is flat.'
      graphRender()
      return
    }
    refs.stageNote.textContent = 'The graph could not be drawn here. The list below still has every note.'
    return
  }
  graphState.instance = instance
  graphState.drawn = { refs, mode, data: graphState.data, key: current.source.key }
  graphState.paused = false
  refs.stageNote.textContent = graphStageNote(capped, mode)
  // Not paused for a tab that says hidden: the browser already holds back frames nobody sees, and a tab
  // that reports hidden while it is drawn (one a script drives) would otherwise show an empty stage.
  if (memoryView !== 'graph' || location.hash.slice(1) !== 'memory') graphPause()
}

function graphFocusOn(id) {
  const instance = graphState.instance
  const node = (instance?.graphData?.()?.nodes ?? []).find((one) => one.id === id)
  if (!node || !Number.isFinite(node.x)) return
  const time = graphDeps.motion().reducedMotion ? 0 : 800
  if (graphState.drawn?.mode === '3d') {
    const controls = instance.controls?.()
    if (controls) controls.autoRotate = false
    const ratio = 1 + 140 / (Math.hypot(node.x, node.y, node.z ?? 0) || 1)
    instance.cameraPosition({ x: node.x * ratio, y: node.y * ratio, z: (node.z ?? 0) * ratio }, node, time)
  } else {
    instance.centerAt(node.x, node.y, time)
    instance.zoom(Math.max(instance.zoom() ?? 1, 2.5), time)
  }
}

function graphSelect(id, { focusPanel = false, returnFocus = false } = {}) {
  const previous = graphState.selected
  graphState.selected = id ?? null
  const model = graphCurrentModel()
  if (!model || !graphState.refs) return
  graphState.items.get(previous)?.setAttribute('aria-current', 'false')
  graphState.items.get(graphState.selected)?.setAttribute('aria-current', 'true')
  graphRenderPanel(model)
  graphRestyle()
  if (graphState.selected) graphFocusOn(graphState.selected)
  if (focusPanel && graphState.selected) graphState.refs.panelTitle.focus()
  if (returnFocus && previous) graphState.items.get(previous)?.focus()
}

function graphSetSource(key) {
  graphState.source = key
  graphState.selected = null
  graphState.find = ''
  if (graphState.refs) graphState.refs.find.value = ''
  graphRender()
}

function graphSetFind(text) {
  graphState.find = String(text ?? '')
  const model = graphCurrentModel()
  if (model && graphState.refs) graphRenderList(model)
}

function graphToggleKind(kind) {
  if (graphState.hiddenKinds.has(kind)) graphState.hiddenKinds.delete(kind)
  else graphState.hiddenKinds.add(kind)
  const model = graphCurrentModel()
  if (model && graphState.refs) graphRenderToggles(model)
  graphRestyle()
}

function graphToggleLonely() {
  graphState.lonelyOnly = !graphState.lonelyOnly
  const model = graphCurrentModel()
  if (model && graphState.refs) graphRenderToggles(model)
  graphRestyle()
}

function graphSetMode(mode) {
  if (mode !== '3d' && mode !== 'flat') return
  writeStore(GRAPH_MODE_STORE, mode)
  graphState.mode = mode
  graphState.note = null
  graphTeardownInstance()
  graphRender()
}

window.addEventListener('resize', () => {
  if (!graphState.instance) return
  const size = graphStageSize()
  graphState.instance.width(size.width).height(size.height)
})

// A theme change repaints the drawing from the new theme's tokens: a choice made with the switch is
// written on the root element, and a phone that changes by itself is heard from its own media query.
if (typeof MutationObserver === 'function') {
  new MutationObserver(() => graphRestyle()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
}

phoneIsLight.addEventListener?.('change', () => graphRestyle())
/* ---------- Memory graph view: end ---------- */
