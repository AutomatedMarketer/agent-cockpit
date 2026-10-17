'use strict'

/* ---------- Storage that is allowed to fail ----------
   A private window, or a browser told to block site data, throws on the first touch of
   localStorage. Every read and write on this page goes through these two, so a refused one costs
   a remembered choice and never the page. (tests/theme.test.mjs refuses a bare call anywhere else.) */
// storage-guard:start
const readStore = (key) => {
  try { return localStorage.getItem(key) } catch (error) { return null }
}
const writeStore = (key, value) => {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
    return true
  } catch (error) { return false }
}
// storage-guard:end

/* ---------- Light or dark ----------
   First in the script so the theme is settled before anything else draws. With no choice made
   here the page sets nothing at all and the stylesheet's prefers-color-scheme block follows the
   phone - including when it flips at sunset. A choice is stored, and wins over the phone. There is
   no script in the head to apply it any earlier (the page loads exactly one script, this file, at
   its end), so someone whose choice differs from their phone sees one frame of the phone's theme on load. Accepted.

   THEME_BG is each theme's --bg, for the phone's status bar. tests/theme.test.mjs holds the two in
   step with the stylesheet. */
const THEME_STORE = 'agent-cockpit-theme'
const THEME_BG = { dark: '#0b0f17', light: '#f5f6fa' }
const phoneIsLight = window.matchMedia('(prefers-color-scheme: light)')

function storedTheme() {
  const value = readStore(THEME_STORE)
  return value === 'light' || value === 'dark' ? value : null
}

// Kept here as well as in storage: when storage refuses the write, the choice still holds for
// this visit instead of the switch doing nothing.
let themeChoice = storedTheme()

function applyTheme() {
  const root = document.documentElement
  if (themeChoice) root.dataset.theme = themeChoice
  else delete root.dataset.theme
  const showing = themeChoice ?? (phoneIsLight.matches ? 'light' : 'dark')
  // Each meta answers its own media query. With no choice, each keeps its own scheme's colour; with
  // one, both say the chosen colour, whichever the phone is set to.
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    const scheme = /light/.test(meta.getAttribute('media') ?? '') ? 'light' : 'dark'
    meta.setAttribute('content', THEME_BG[themeChoice ?? scheme])
  }
  const button = document.getElementById('theme-switch')
  if (button) button.setAttribute('aria-checked', String(showing === 'light'))
}

applyTheme()
// Older Safari has no addEventListener on a media query list; there the switch simply catches up
// on the next load.
phoneIsLight.addEventListener?.('change', () => { if (!themeChoice) applyTheme() })
document.getElementById('theme-switch')?.addEventListener('click', () => {
  const showing = themeChoice ?? (phoneIsLight.matches ? 'light' : 'dark')
  themeChoice = showing === 'light' ? 'dark' : 'light'
  writeStore(THEME_STORE, themeChoice)
  applyTheme()
})

/* One list, in nav order. TITLES was maintained by hand alongside SCREENS and lost `ledger`
   somewhere, so tapping Ledger - the screen the whole measured-week idea lives on - put the
   literal word "undefined" in the page header. Deriving one from the other makes a screen
   without a title unrepresentable rather than merely unlikely. */
const TITLES = { today: 'Today', ledger: 'Ledger', team: 'Team', workflows: 'Workflows', readiness: 'Flight readiness', skills: 'Skills', memory: 'Memory', connections: 'Connections' }
const SCREENS = Object.keys(TITLES)
const STATE_LABEL = {
  working: 'Working', quiet: 'Gone quiet', 'never-run': 'Never run', attention: 'Needs a look',
  'not-in-use': 'Not in use',
  live: 'Live', silent: 'Silent', 'no-heartbeat': 'No heartbeat'
}

const el = (id) => document.getElementById(id)
// Money as words, the same shape as api/state.js formatMoney and the template's: the ledger's own
// currency code after the number, or the bare number when the ledger names none. Never a symbol.
const formatMoney = (value, currency) => {
  const number = Math.round(value).toLocaleString('en-US')
  return currency ? `${number} ${currency}` : number
}
const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])

/* "Why?" - the reasoning behind an empty state, one tap away, so the screen leads with what it is
   and what to do. Plain text only, escaped here, because some of what lands in one is a reason the
   server read out of the repo. Reasoning only: a sentence about something being spent or switched
   on is the warning itself, and it stays in view (tests/render.test.mjs holds that line). */
const whyHtml = (text) =>
  `<details class="why"><summary>Why?</summary><p>${escapeHtml(text)}</p></details>`

/* Each screen's own line icon - the same drawing as its tab (tests/render.test.mjs holds the two
   equal). Fixed markup, never data: it is put into the empty states below. */
const SCREEN_ICONS = {
  today: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  ledger: '<path d="M4 19V5M4 19h16M8 15l3-4 3 2 5-6"/>',
  team: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17.5" cy="9" r="2.5"/><path d="M16 14.2c2.9.2 5 2.6 5 5.8"/>',
  workflows: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>',
  readiness: '<rect x="8" y="2.5" width="8" height="19" rx="4"/><circle cx="12" cy="8" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="16" r="1.4"/>',
  skills: '<path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z"/>',
  memory: '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 0V4.5A2.5 2.5 0 0 0 9 4zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 0"/>',
  connections: '<path d="M9 7H6a4 4 0 0 0 0 8h3M15 7h3a4 4 0 0 1 0 8h-3M8 11h8"/>',
  hermes: '<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>'
}
const screenIconHtml = (screen) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${SCREEN_ICONS[screen]}</svg>`

/* An empty screen: centred, the screen's icon in a soft round tile, then the words it always had.
   `inner` is the screen's own markup, already escaped where it carries anything read from the repo. */
const emptyStateHtml = (screen, inner) =>
  `<div class="panel empty empty-state"><span class="empty-ico" aria-hidden="true">${screenIconHtml(screen)}</span><div class="empty-words">${inner}</div></div>`

// The same empty state built from elements, for a screen that is drawn from elements and set as text
// (Readiness). The icon is made in the SVG namespace from the fixed shapes above, never from markup.
function emptyStateNode(screen, ...children) {
  const svgNs = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(svgNs, 'svg')
  for (const [name, value] of [['class', 'ico'], ['viewBox', '0 0 24 24'], ['aria-hidden', 'true']]) svg.setAttribute(name, value)
  for (const [, tag, attributes] of SCREEN_ICONS[screen].matchAll(/<(\w+)([^>]*)\/>/g)) {
    const shape = document.createElementNS(svgNs, tag)
    for (const [, name, value] of attributes.matchAll(/([\w-]+)="([^"]*)"/g)) shape.setAttribute(name, value)
    svg.appendChild(shape)
  }
  const tile = document.createElement('span')
  tile.className = 'empty-ico'
  tile.setAttribute('aria-hidden', 'true')
  tile.appendChild(svg)
  const words = document.createElement('div')
  words.className = 'empty-words'
  for (const child of children) words.appendChild(child)
  const box = document.createElement('div')
  box.className = 'panel empty empty-state'
  box.appendChild(tile)
  box.appendChild(words)
  return box
}

// A section's heading with a small line over it, the mock-up's pattern. The heading is handed in
// whole because several are found by their exact opening tag, `<h2>Board` and `<h2 id="run-jobs">`
// among them, and an attribute added here would lose them.
const sectionHead = (eyebrow, heading) =>
  `<div class="section-head"><p class="eyebrow">${escapeHtml(eyebrow)}</p>${heading}</div>`

/* ---------- Agent identity colors + schedule expansion ----------
   KEEP IN SYNC: AGENT_PALETTE, agentColorIndex, and scheduleWeekView are mirrored verbatim
   as exports in api/_lib.js, where the test suite exercises them (this page has no module
   loading). Change them here, change them there. */

// Eight distinct dark-theme-friendly hues. Agent color is IDENTITY only — status colors
// (ok/warn/bad) stay on dots and state labels, never on the same element as an agent color.
const AGENT_PALETTE = [
  { name: 'blue', hex: '#60a5fa' },
  { name: 'violet', hex: '#a78bfa' },
  { name: 'teal', hex: '#2dd4bf' },
  { name: 'amber', hex: '#facc15' },
  { name: 'rose', hex: '#fb7185' },
  { name: 'green', hex: '#34d399' },
  { name: 'cyan', hex: '#22d3ee' },
  { name: 'orange', hex: '#fb923c' }
]

// Deterministic slug → palette index. Hash: FNV-1a 32-bit over the slug's UTF-16 code
// units (offset basis 0x811c9dc5, prime 0x01000193, Math.imul for 32-bit wrap), then
// unsigned mod 8 — the same slug maps to the same color forever, with no stored state.
function agentColorIndex(slug) {
  const text = String(slug ?? '')
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % AGENT_PALETTE.length
}

// Expands one schedule string into what the Schedule strip draws. Days are Monday-first:
// 0 = Mon … 6 = Sun. Unrecognised forms → null. (Mirrored in api/_lib.js — see above.)
const WEEK_MON_FIRST = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

function scheduleWeekView(schedule) {
  if (typeof schedule !== 'string') return null
  const trimmed = schedule.trim()
  let match
  if (trimmed === 'hourly') return { type: 'interval', label: 'hourly' }
  if ((match = /^every (\d+) (minutes|hours)$/.exec(trimmed))) {
    return { type: 'interval', label: `every ${match[1]}${match[2] === 'hours' ? 'h' : 'm'}` }
  }
  if ((match = /^daily (\d{2}:\d{2})$/.exec(trimmed))) {
    return { type: 'days', days: [0, 1, 2, 3, 4, 5, 6], time: match[1] }
  }
  if ((match = /^weekdays (\d{2}:\d{2})$/.exec(trimmed))) {
    return { type: 'days', days: [0, 1, 2, 3, 4], time: match[1] }
  }
  if ((match = /^weekly (sun|mon|tue|wed|thu|fri|sat) (\d{2}:\d{2})$/.exec(trimmed))) {
    return { type: 'days', days: [WEEK_MON_FIRST.indexOf(match[1])], time: match[2] }
  }
  if ((match = /^monthly (\d{1,2}) (\d{2}:\d{2})$/.exec(trimmed))) {
    return { type: 'monthly', day: Number(match[1]), time: match[2] }
  }
  return null
}

/* Page-side helpers over the mirrored pure functions. The hex values are constants from
   AGENT_PALETTE above, never data from the repo — slugs, which are, stay escaped. */
const agentColor = (slug) => (slug ? AGENT_PALETTE[agentColorIndex(slug)].hex : null)
const accentStyle = (slug) => {
  const hex = agentColor(slug)
  return hex ? ` style="border-left-color:${hex}"` : ''
}
const ownerChipHtml = (slug) => {
  if (!slug) return ''
  const hex = agentColor(slug)
  return `<span class="chip owner" style="--agent:${hex}">owner: ${escapeHtml(slug)}</span>`
}

function ago(iso) {
  if (!iso) return 'never'
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000
  if (Number.isNaN(seconds)) return 'unknown'
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hr ago`
  const days = Math.round(seconds / 86400)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

// Two places on this board exist purely to make an evidence claim believable - the snapshot
// banner and the footer - and both printed a raw toLocaleString: "as recorded 8/26/2026,
// 12:44:21 AM". Seconds serve nobody, and a bare date makes a reader do arithmetic to find out
// whether it is old. How long ago first, in words, with the exact moment kept in brackets.
function stamp(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'at an unreadable time'
  const exact = date.toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
  })
  return `${ago(iso)} (${exact})`
}

function until(iso) {
  if (!iso) return null
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000
  if (Number.isNaN(seconds)) return null
  if (seconds <= 0) return 'now'
  if (seconds < 3600) return `in ${Math.max(1, Math.round(seconds / 60))} min`
  if (seconds < 86400) return `in ${Math.round(seconds / 3600)} hr`
  return `in ${Math.round(seconds / 86400)} days`
}

let data = null
let repoBase = ''
let repoBranch = 'main'
const blobUrl = (path) => `${repoBase}/blob/${repoBranch}/${encodeURI(path)}`

/* ---------- Today ---------- */

function ladderHtml(setup) {
  const passed = setup.filter((rung) => rung.pass).length
  const rungs = setup.map((rung) =>
    `<div class="rung ${rung.pass ? 'pass' : ''}" title="${escapeHtml(rung.detail)}"><div class="bar"></div>${escapeHtml(rung.label)}</div>`
  ).join('')
  return sectionHead('Getting set up', `<h2>Setup &middot; ${passed} of ${setup.length} rungs</h2>`) +
    `<div class="panel"><div class="ladder">${rungs}</div></div>`
}

// The play mark on a run button, drawn rather than typed: &#9654; is one of the characters a phone
// may swap for an emoji, and then every run button carries a different-looking picture.
const PLAY = '<span class="play" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 5.5l11 6.5-11 6.5z"/></svg></span>'

function fireButtonsHtml(workflows) {
  const firing = workflows.filter((workflow) => workflow.fire)
  if (!firing.length) return ''
  // Each button POSTs /api/fire { workflow: slug } same-origin. The fire key never lives
  // in this page's source — the endpoint asks for it (401) and the prompt keeps it in
  // sessionStorage for this tab only. See fireWorkflow() below.
  const buttons = firing.map((workflow) =>
    `<button class="fire job" type="button" data-fire="${escapeHtml(workflow.slug)}" data-action="run">${PLAY}${escapeHtml(workflow.name)}</button>`
  ).join('')
  // id="run-jobs" is where the top bar's Run a job lands, from any screen.
  return sectionHead('One tap', '<h2 id="run-jobs">Run a job</h2>') + `<div class="fires">${buttons}</div>
    <p class="small muted">Starts that job now rather than waiting for its schedule. It spends one run
    from your Claude account and leaves its work in your repo as a draft &mdash; nothing is sent
    anywhere and nothing is deleted.</p>`
}

// The Board lives here on Today, in the slot Overnight used to hold, rather than as a
// extra nav tab: the phone nav is already seven tabs across two rows, and each one added
// costs vertical space on every screen. Four per row at 375px is ~94px a tab, which fits the
// longest label and clears the 44px thumb target with room to spare.
// The Done column carries everything the Overnight feed used to show, and more.
const STATUS_GLYPH = { ok: '&#10003;', partial: '&#9680;', blocked: '&#9940;', failed: '&#10007;' }

function boardColumnHtml(title, cards, emptyText, extra = '', footer = '') {
  const rows = cards.length
    ? cards.join('')
    : `<div class="empty">${escapeHtml(emptyText)}</div>`
  return `<div class="panel col">
    <div class="col-title"><span>${escapeHtml(title)}</span><span>${cards.length}</span></div>
    ${extra}${rows}${footer}</div>`
}

// "3 days ago" from a YYYY-MM-DD, which is a DAY and not an instant - so it is compared at the
// same hour each side rather than pretending to know a time nobody recorded.
function dayAgo(day) {
  if (!day) return ''
  const at = Date.parse(`${day}T12:00:00Z`)
  if (!Number.isFinite(at)) return ''
  const days = Math.round((Date.now() - at) / 86400_000)
  if (days <= 0) return 'today'
  return days === 1 ? 'yesterday' : `${days} days ago`
}

// The inline Add-task form. Submitting POSTs /api/fire { action: "task", … } — the same
// client path as the Run buttons (prompt-once key, sessionStorage, PUBLIC_FIRE) — and the
// task-intake routine's session writes the card; this page still never writes the repo.
// Agent slugs come from the live team list; slugs are repo data, so they stay escaped.
// The "what job should run on its own?" placeholder used to read "check which clients went quiet".
// Half the people this is built for have a job and no clients at all, and this box sits on the
// Today screen on every load - not behind an empty state. A worked example that assumes customers
// is the single most common defect the employee walkthrough found, and it was in the one box on
// the board where somebody types what they want. Kept concrete, but about work anybody has.
//
// This note is a JS comment, not an HTML one: an HTML comment inside the template literal ends up
// in innerHTML, where the test that sweeps every screen for owner-shaped words reads it and fails
// on the explanation rather than on the page.
function addTaskHtml() {
  const options = (data.agents ?? []).map((agent) =>
    `<option value="${escapeHtml(agent.slug)}">${escapeHtml(agent.slug)}</option>`
  ).join('')
  // The two buttons share a row of their own, spaced by its gap. A margin on the second one left it
  // a step in from the first whenever a narrow column wrapped it onto a line of its own.
  return `<div class="add-task">
    <div class="add-open">
      <button class="fire" type="button" id="task-open">+ Add task</button>
      <button class="fire" type="button" id="wf-open">+ New workflow</button>
    </div>
    <form id="task-form" class="fire-form" hidden>
      <label for="task-text">What do you want done?</label>
      <textarea id="task-text" rows="3" maxlength="2200"
        placeholder="e.g. Research podcast sponsors - or - Build me a skill that drafts YouTube descriptions"></textarea>
      <div class="row">
        <select id="task-for" aria-label="Who should do it">
          <option value="">Anyone — let the team route it</option>
          ${options}
        </select>
        <button class="fire" type="submit" id="task-send">Add</button>
      </div>
      <span class="fire-note" id="task-note"></span>
    </form>
    <form id="wf-form" class="fire-form" hidden>
      <label for="wf-text">What job should run on its own?</label>
      <textarea id="wf-text" rows="3" maxlength="2200"
        placeholder="e.g. Every Monday at 7, gather what changed last week and write it up for me"></textarea>
      <span class="small muted">Say what it does and when. Your team writes the workflow and
        asks you anything it still needs.</span>
      <button class="fire" type="submit" id="wf-send">Request it</button>
      <span class="fire-note" id="wf-note"></span>
    </form>
  </div>`
}

// The "+ Add skill" and "+ Add agent" forms. One function, because from a phone a skill and an
// agent are described exactly the same way: one sentence. What differs is the word on the button,
// the example, and the action the sentence is posted under.
//
// It renders in the empty state too, at the top. Somebody with no skills is the person most likely
// to want one, and both empty states replace their whole innerHTML — a button appended after the
// list would simply not exist on the screen that needs it most. With agents to show, Team draws it
// under its banner and above the cards; Skills keeps it at the top too.
//
// Because Team draws it BEFORE the cards, nothing in here may name an agent - no owner list, no
// slug in the example. Tests find a card by the first place its slug appears in the screen.
//
// The copy carries two facts this page cannot show happening. It lands in about a minute, same as
// every other dispatch here. And the file is written from a guess: nobody is in front of the
// session that writes it, so it works the answers out from the sentence and leaves a card in the
// To-do column listing what it filled in. That card is the whole safety net, so the form says so
// rather than leaving somebody to discover it.
//
// Nothing is armed or scheduled by this. Saying so is not padding — the most expensive state in
// this whole course is a job that rings without anyone approving it, and a button that quietly
// created one from a sentence would be the easiest way yet to manufacture it.
//
// The examples avoid clients, customers and revenue on purpose. Half the people this is built for
// have a job, not a business, and the Add-task placeholder assuming otherwise is the single most
// common defect the employee walkthrough found.
const CREATE_FORMS = {
  skill: {
    button: '+ Add skill',
    label: 'What should your team know how to do?',
    example: 'e.g. Turn my meeting notes into a short summary I can send on'
  },
  agent: {
    button: '+ Add agent',
    label: 'What should this specialist look after?',
    example: 'e.g. Watches the sites I care about and tells me what changed'
  }
}

function createFormHtml(kind) {
  const form = CREATE_FORMS[kind]
  // Wrapped in a .panel because on Today this block is nested inside one - it is a column of the
  // board - and .add-task declares no background of its own. On Skills and Team it is a sibling
  // of the panels rather than inside one, so without this it renders on the bare page background
  // while every other block on those two screens sits on a card.
  return `<div class="panel add-panel"><div class="add-task">
    <button class="fire" type="button" id="${kind}-open">${form.button}</button>
    <form id="${kind}-form" class="fire-form" hidden>
      <label for="${kind}-text">${form.label}</label>
      <textarea id="${kind}-text" rows="3" maxlength="2200"
        placeholder="${escapeHtml(form.example)}"></textarea>
      <span class="small muted">Your team writes the file and commits it &mdash; about a minute.
        Nobody is there to ask you questions, so it works the rest out from your sentence and
        leaves a card in <b>To do</b> listing what it guessed, for you to check. Nothing is
        switched on.</span>
      <button class="fire" type="submit" id="${kind}-send">Ask for it</button>
      <span class="fire-note" id="${kind}-note"></span>
    </form>
  </div></div>`
}

// One submit path for both, for the same reason there is one form: the only difference is the
// action, and two near-identical copies of this is how the two drift apart.
async function submitCreation(kind) {
  const note = el(`${kind}-note`)
  const send = el(`${kind}-send`)
  note.className = 'fire-note'
  note.textContent = ''
  const parts = splitTaskText(el(`${kind}-text`).value)
  if (!parts) {
    note.className = 'fire-note bad'
    note.textContent = `Say what the ${kind} should do first.`
    return
  }
  const body = { action: kind, title: parts.title }
  if (parts.details) body.details = parts.details
  send.disabled = true
  send.textContent = 'Sending…'
  try {
    const result = await postFire(body)
    if (result.ok) {
      note.className = 'fire-note ok'
      // Says what was ASKED, like every other note on this board. The file is not there until the
      // session commits it, and this page does not get to guess in between.
      if (!macNote(note, kind, `New ${kind}: ${parts.title}`, result.payload)) {
        note.textContent =
          `Asked for — your team writes it and commits in about a minute, then leaves you a card ` +
          `saying what it guessed.`
      }
      el(`${kind}-text`).value = ''
    } else {
      note.className = 'fire-note bad'
      note.textContent = result.payload.error || `Dispatch failed (${result.status}).`
    }
  } catch {
    note.className = 'fire-note bad'
    note.textContent = 'Could not reach the fire endpoint.'
  }
  send.disabled = false
  send.textContent = 'Ask for it'
}

// Binding is separate from drawing because both screens re-render on every load, and a listener
// attached to a node that has since been replaced is a button that silently does nothing.
function bindCreateForm(kind, container) {
  const open = container.querySelector(`#${kind}-open`)
  const form = container.querySelector(`#${kind}-form`)
  if (!open || !form) return
  open.addEventListener('click', () => {
    form.hidden = !form.hidden
    if (!form.hidden) container.querySelector(`#${kind}-text`)?.focus()
  })
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    submitCreation(kind)
  })
}

function boardHtml(board) {
  // To do cards come from tasks/*.md in the team repo — read-only here. "+ Add task" and the
  // Start / Done buttons below both dispatch through /api/fire to the task-intake routine, whose
  // session makes the edit and commits it. This page still never writes the repo.
  //
  // Buttons rather than dragging, and that is a decision about the device: on a phone this board
  // is ONE column — the four stack, and only sit side by side at 1024px and up. There is nothing
  // to drag between on the screen the course tells students to bookmark on day one, and a drag
  // gesture there fights the page scroll. A button works on a phone, a keyboard and a screen
  // reader, which dragging does not.
  //
  // The left border is the `for:` agent's identity color; no agent, no color.
  const todo = (board.todo ?? []).map((card) =>
    `<div class="kcard agent-accent" data-card="${escapeHtml(card.slug)}"${accentStyle(card.for)}>
      <div class="row between">
        <b>${escapeHtml(card.title)}</b>
        ${card.doing ? '<span class="chip on">doing</span>' : ''}
      </div>
      <div class="row between">
        ${ownerChipHtml(card.for)}
        <span class="row">
          ${card.doing ? '' : `<button class="fire small-fire" type="button" data-move="${escapeHtml(card.slug)}" data-status="doing">Start</button>`}
          <button class="fire small-fire" type="button" data-move="${escapeHtml(card.slug)}" data-status="done">Done</button>
        </span>
      </div>
      <div class="move-note small" hidden></div>
    </div>`)
  const upNext = board.upNext.map((card) =>
    `<div class="kcard agent-accent"${accentStyle(card.owner)}>
      <div class="row between">
        <b>${escapeHtml(card.name)}</b>
        <span class="small muted">${escapeHtml(until(card.when) ?? '')}</span>
      </div>
      ${ownerChipHtml(card.owner)}
    </div>`)
  const running = board.running.map((card) =>
    `<div class="kcard agent-accent"${accentStyle(card.agent)}>
      <div class="row between">
        <b>${escapeHtml(card.name)}</b>
        <span class="small muted">started ${escapeHtml(ago(card.started_at))}</span>
      </div>
      ${card.session_url ? `<a class="small watch" href="${escapeHtml(card.session_url)}" rel="noreferrer noopener">watch</a>` : ''}
    </div>`)
  // Two kinds of card share this column now, on two clocks: a RUN is the team's record of work
  // it did and stays a fortnight; a TASK is the owner's own card and stays a week. They are drawn
  // differently on purpose — a finished task has no status glyph and no session to watch, and
  // dressing it as a run would claim an agent ran something that a person just ticked off.
  const done = board.done.map((card) => {
    if (card.kind === 'task') {
      return `<div class="kcard agent-accent done-task"${accentStyle(card.for)}>
        <div class="row between">
          <span><span class="st st-ok">&#10003;</span> <b>${escapeHtml(card.title)}</b></span>
          <span class="small muted">${escapeHtml(dayAgo(card.doneAt))}</span>
        </div>
        <p class="summary">You marked this done${card.for ? ` &middot; ${escapeHtml(card.for)}` : ''}</p>
      </div>`
    }
    const glyph = STATUS_GLYPH[card.status] ?? '&#10003;'
    return `<div class="kcard agent-accent"${accentStyle(card.agent)}>
      <div class="row between">
        <span><span class="st st-${escapeHtml(card.status)}">${glyph}</span> <b>${escapeHtml(card.name)}</b></span>
        <span class="small muted">${escapeHtml(ago(card.started_at))}</span>
      </div>
      <p class="summary">${escapeHtml(card.summary)}${card.session_url ? ` &middot; <a class="watch" href="${escapeHtml(card.session_url)}" rel="noreferrer noopener">watch</a>` : ''}</p>
    </div>`
  })

  // Finished tasks older than seven days, and any finished before done_at existed, are not on
  // the board — but they are not gone either, and saying so is the difference between hidden and
  // lost. The link expands them in place rather than opening a screen that would have to exist.
  const hidden = (board.finishedTasks ?? []).filter((task) =>
    !done.length || !board.done.some((card) => card.kind === 'task' && card.slug === task.slug))
  const finishedLink = hidden.length
    ? `<details class="finished-tasks"><summary class="small">See ${hidden.length} finished task${hidden.length === 1 ? '' : 's'} not shown here</summary>
        ${hidden.map((task) => `<div class="kcard agent-accent"${accentStyle(task.for)}>
          <div class="row between">
            <span><span class="st st-ok">&#10003;</span> <b>${escapeHtml(task.title)}</b></span>
            <span class="small muted">${escapeHtml(task.doneAt ? dayAgo(task.doneAt) : 'no date recorded')}</span>
          </div>
        </div>`).join('')}
      </details>`
    : ''
  return `<div class="board">
    ${boardColumnHtml('To do', todo, 'No open tasks in tasks/ yet.', addTaskHtml())}
    ${boardColumnHtml('Up Next', upNext, 'Nothing scheduled in the next 48 hours.')}
    ${boardColumnHtml('Running', running, 'Nothing is running right now.')}
    ${boardColumnHtml('Done', done, 'No finished runs in the last 14 days.', '', finishedLink)}
  </div>`
}

/* ---------- The hero number ---------- */

/* One figure, at the top, and the only one on this board that says what somebody's week costs
   rather than what the agents did.

   tiles.yml has named `hero: hours-saved` since the day it was written, and nothing has ever
   computed it. So when the number cannot be produced this says so, plainly, instead of rendering
   a zero - a zero here is a claim about their week, made in the largest type on the screen. */

// The two halves are shared by the Ledger panel and Today's third number card, so the one number
// on this board that is the owner's own is written, and refused, the same way in both places.
function heroMissingHtml(hero) {
  // `hero.why` arrives as a finished sentence, ending with its own full stop. It used to be a
  // lowercase fragment dropped after "No hero number yet.", which started that sentence with a
  // lowercase letter in every state. Capitalising it HERE was the first fix and it was worse:
  // one of those reasons begins with the filename `tiles.yml`, so the panel started printing
  // `Tiles.yml`, a file that does not exist, on the screen students are told to bookmark. A view
  // layer cannot tell an English word from a filename. The sentences are written correctly at
  // source instead - see shapeHero in api/state.js.
  return `<b>No hero number yet.</b> <span class="small">${escapeHtml(hero.why ?? '')} Nothing is shown rather than a zero, because a zero here would be a claim about your week.</span>`
}

function heroValueHtml(hero) {
  // Money carries the ledger's own currency code after the number, or nothing at all when the
  // ledger names none. Never a symbol: this line printed "$" for every student in every country.
  const value = hero.money
    ? formatMoney(hero.value, hero.currency)
    : (Math.round(hero.value * 10) / 10).toLocaleString('en-US')
  return `<div class="hero-value">${escapeHtml(value)}</div>
    <div class="hero-unit">${escapeHtml(hero.unit ?? '')}</div>
    <div class="small muted">${escapeHtml(hero.caption ?? '')}</div>`
}

function heroHtml(hero) {
  if (!hero) return ''
  if (!hero.defined) return `<div class="panel empty">${heroMissingHtml(hero)}</div>`
  // The same card as the third number on Today, so the owner's number looks like one thing
  // wherever it is shown. It never gets a line under it, here or there.
  return `<div class="kpis kpis-one">${kpiCardHtml('ledger', 'Your number', heroValueHtml(hero))}</div>`
}

/* ---------- Today: the banner and the three numbers ----------
   The top of Today is a picture with a greeting, the line about the team, and how far setup has
   got; then three numbers. The rule for all of it is the board's rule: nothing is printed that the
   repo cannot source. A card with nothing to count says so in words, never a 0. A line is drawn
   only under a count that has a history, from the activity list the server sends for exactly this
   - the run feed stops at fifty, which an hourly job fills in two days, so a fortnight drawn from
   it would show twelve empty days that were not. */

// Which part of the day an hour is in. Nobody is wished good morning at two at night.
function greetingFor(hour) {
  if (hour >= 5 && hour < 12) return 'Good morning'
  if (hour >= 12 && hour < 18) return 'Good afternoon'
  return 'Good evening'
}

const plural = (count, one, many = one + 's') => `${count} ${count === 1 ? one : many}`

// The line about the team. On every other screen it sits under the top bar; on Today it is inside
// the banner instead, so showScreen hides the one under the bar there rather than print it twice.
function strapText() {
  const working = data.agents.filter((agent) => agent.state === 'working').length
  // An agent switched off on purpose is not a shortfall, so it leaves the denominator too.
  // "2 of 8 working" read as four missing agents when two of them were never wanted.
  const inUse = data.agents.filter((agent) => agent.state !== 'not-in-use').length
  // "1 runs in the last day" was on the front page. The count is usually plural, so the bug
  // only shows on the quietest days — which are exactly the days somebody is looking closely.
  return `${working} of ${inUse} agents working · ` +
    `${plural(data.workflows.length, 'workflow')} · ` +
    `${plural(data.overnight.length, 'run')} in the last day.`
}

// "Setup 4 of 6 · next: Oversight", with a ring filled by the same share. The next step is the
// first one not passed, wherever the passes are: a later rung lit does not make an earlier one
// done. No steps at all, no ring - an empty ring would read as nought out of something.
const RING_R = 14
function setupRingHtml(setup) {
  if (!Array.isArray(setup) || !setup.length) return ''
  const passed = setup.filter((rung) => rung.pass).length
  const next = setup.find((rung) => !rung.pass)
  const around = 2 * Math.PI * RING_R
  const done = (passed / setup.length) * around
  const words = `Setup <b>${passed} of ${setup.length}</b>` +
    (next ? ` &middot; next: ${escapeHtml(next.label)}` : '')
  return `<div class="score" title="Your setup steps, each one a real test of your repo">
    <svg class="ring" viewBox="0 0 36 36" aria-hidden="true"><circle class="ring-track" cx="18" cy="18" r="${RING_R}"/><circle class="ring-done" cx="18" cy="18" r="${RING_R}" stroke-dasharray="${done.toFixed(1)} ${around.toFixed(1)}" transform="rotate(-90 18 18)"/></svg>
    <span>${words}</span></div>`
}

function ownerFirstName() {
  const name = typeof data?.owner?.name === 'string' ? data.owner.name.trim() : ''
  return name.split(/\s+/)[0] ?? ''
}

// The banner's words for a moment, as plain text. One function for the first draw and the
// in-place update, so they cannot disagree.
function bannerWords(now, first) {
  const part = (options) => now.toLocaleDateString(undefined, options)
  return {
    greeting: `${greetingFor(now.getHours())}${first ? `, ${first}` : ''}.`,
    day: `${part({ weekday: 'long' })} · ${part({ day: 'numeric', month: 'long' })}`
  }
}

// The picture is the one image on the board fetched at once rather than when it scrolls into view:
// it is the first thing Today shows, the head preloads it, and its size is written down so
// nothing jumps when it lands. The owner's own banner, when they have put one in, takes its place
// and keeps all of that - only the address changes.
function bannerHtml(now = new Date()) {
  const words = bannerWords(now, ownerFirstName())
  const greeting = escapeHtml(words.greeting)
  const day = escapeHtml(words.day).replace('·', '&middot;')
  return pictureSwap(`<section class="banner"${artMark('today')}>
    <img src="/art/today-harbour.webp" alt="" width="1600" height="686" fetchpriority="high" decoding="async" />
    <div class="banner-text">
      <div class="banner-words">
        <p class="eyebrow">${day}</p>
        <h2 class="greeting">${greeting} <span class="soft">Here is where things stand.</span></h2>
        <p class="banner-strap">${escapeHtml(strapText())}</p>
      </div>
      ${setupRingHtml(data.setup)}${bannerButtonsHtml('today')}
    </div>
  </section>`, '/art/today-harbour.webp', 'today')
}

// Keeps the greeting and the day line true to the clock while a tab stays open: the board redraws
// only when the repo changes. Just those two are rewritten - a full redraw wipes half-typed text.
function refreshBannerWords(root = document, now = new Date(), first = ownerFirstName()) {
  const heading = root.querySelector('#today .banner .greeting')
  const eyebrow = root.querySelector('#today .banner .eyebrow')
  const words = bannerWords(now, first)
  if (heading?.firstChild?.nodeType === 3) heading.firstChild.nodeValue = `${words.greeting} `
  if (eyebrow) eyebrow.textContent = words.day
}

// Next 5:00, 12:00, 18:00 or midnight; hour 24 is the next midnight, so there is always one.
function nextBannerChange(now = new Date()) {
  return [5, 12, 18, 24].map((hour) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour)).find((moment) => moment > now)
}

// One timer, re-armed each time. The 500 ms pad stops an early wake-up landing on the old words.
// globalThis, so the polling tests' fake timers do not count this one; unref lets Node exit.
const bannerClock = { timer: null, set: (fn, ms) => globalThis.setTimeout(fn, ms), clear: (id) => globalThis.clearTimeout(id) }
function armBannerClock(now = new Date()) {
  bannerClock.clear(bannerClock.timer)
  bannerClock.timer = bannerClock.set(() => { refreshBannerWords(); armBannerClock() }, nextBannerChange(now) - now + 500)
  bannerClock.timer?.unref?.()
}
// A hidden tab's timers stall, and a cached page never reloads: re-read the clock on return.
const wakeBannerClock = () => { refreshBannerWords(); armBannerClock() }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wakeBannerClock() })
window.addEventListener('pageshow', wakeBannerClock)
window.addEventListener('focus', wakeBannerClock)
armBannerClock()

// A smooth line through the values with the area under it washed in the card's colour, drawn
// across a 400x80 box the card stretches to its own width. One point per value, so fourteen days
// is an M and thirteen curves. All zeros is a flat line on the floor - a true picture of nothing.
const SPARK_W = 400
const SPARK_H = 80
function sparkSvg(values, id) {
  const top = Math.max(...values, 0)
  const step = values.length > 1 ? SPARK_W / (values.length - 1) : 0
  const points = values.map((value, index) => [
    Math.round(index * step * 10) / 10,
    Math.round((SPARK_H - 8 - (top ? value / top : 0) * (SPARK_H - 24)) * 10) / 10
  ])
  let line = `M${points[0][0]},${points[0][1]}`
  for (let index = 1; index < points.length; index += 1) {
    const [x0, y0] = points[index - 1]
    const [x1, y1] = points[index]
    const middle = Math.round(((x0 + x1) / 2) * 10) / 10
    line += ` C${middle},${y0} ${middle},${y1} ${x1},${y1}`
  }
  return `<svg class="spark" viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".35"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>
    <path class="spark-fill" d="${line} L${SPARK_W},${SPARK_H} L0,${SPARK_H} Z" fill="url(#${id})"/>
    <path class="spark-line" d="${line}"/></svg>`
}

function kpiCardHtml(kind, label, body, spark = '') {
  return `<article class="kpi kpi-${kind}"><p class="kpi-label"><i aria-hidden="true"></i>${label}</p>${body}${spark}</article>`
}

const CUT_SHORT = '<p class="kpi-note">More runs than the board reads at once, so no line is drawn rather than one that runs out partway.</p>'

function workCardHtml(days, activity) {
  if (!data.totalRuns) {
    return kpiCardHtml('work', 'Work done', `<p class="kpi-words">No runs logged yet.</p>
      <p class="kpi-foot">The first job your team runs shows up here.</p>`)
  }
  if (!days) {
    return kpiCardHtml('work', 'Work done', `<p class="kpi-words">Runs are logged, but this reading carries no history to count them from.</p>`)
  }
  const week = days.slice(-7).reduce((sum, day) => sum + day.runs, 0)
  // Cut short by the server's cap, the list still holds the NEWEST runs. If the oldest it kept is
  // from before this week began, the whole week is in it and the count is exact; if not, some of
  // the week was cut and the count is only a floor, and says so with its +.
  const weekStart = new Date()
  weekStart.setHours(0, 0, 0, 0)
  weekStart.setDate(weekStart.getDate() - 6)
  const oldest = Date.parse(activity.runs.at(-1)?.started_at)
  const whole = activity.complete || (Number.isFinite(oldest) && oldest < weekStart.getTime())
  return kpiCardHtml('work', 'Work done', `<p class="kpi-value">${week}${whole ? '' : '+'}</p>
    <p class="kpi-foot">${week === 1 ? 'run' : 'runs'} in the last 7 days</p>
    <p class="kpi-source">Counted from runs/ in your repo</p>${activity.complete ? '' : CUT_SHORT}`,
  activity.complete ? sparkSvg(days.map((day) => day.runs), 'spark-work') : '')
}

function agentsCardHtml(days, activity) {
  if (!data.agents.length) {
    return kpiCardHtml('agents', 'Agents working', `<p class="kpi-words">No agents yet.</p>
      <p class="kpi-foot">Run <code>/onboard</code> and it writes the first ones.</p>`)
  }
  const inUse = data.agents.filter((agent) => agent.state !== 'not-in-use')
  if (!inUse.length) {
    return kpiCardHtml('agents', 'Agents working', `<p class="kpi-words">Every agent is switched off.</p>
      <p class="kpi-foot">That was a choice in your repo, so nothing here counts it as a fault.</p>`)
  }
  // A team nobody has run yet is the template's day-one reading. "0 of 8" there, in the largest
  // type on the screen, reads as eight things broken rather than eight things not started.
  if (!data.totalRuns) {
    const words = inUse.length === 1 ? 'Your one agent has not run yet.' : `None of your ${inUse.length} agents has run yet.`
    return kpiCardHtml('agents', 'Agents working', `<p class="kpi-words">${words}</p>
      <p class="kpi-foot">Each one shows as working here once it has run.</p>`)
  }
  const count = (state) => inUse.filter((agent) => agent.state === state).length
  const others = [[count('quiet'), 'gone quiet'], [count('never-run'), 'never run'], [count('attention'), 'need a look']]
    .filter(([number]) => number).map(([number, words]) => `${number} ${words}`)
  // The line is how many different agents ran each day - only when there is a history to count,
  // and only a whole one.
  const spark = data.totalRuns && days && activity.complete ? sparkSvg(days.map((day) => day.agents), 'spark-agents') : ''
  return kpiCardHtml('agents', 'Agents working', `<p class="kpi-value">${count('working')}<small> of ${inUse.length}</small></p>
    <p class="kpi-foot">${others.length ? others.join(' &middot; ') : 'in use, none gone quiet'}</p>
    <p class="kpi-source">Each agent's state, from its own runs</p>`, spark)
}

// The owner's own number. It has no history - tiles.yml names one figure, not a series - so this
// card never gets a line, whatever the other two draw.
function heroCardHtml(hero) {
  if (!hero) {
    return kpiCardHtml('ledger', 'Your number', `<p class="kpi-words">No number chosen yet &mdash; <code>/onboard</code> asks which.</p>`)
  }
  if (!hero.defined) return kpiCardHtml('ledger', 'Your number', `<p class="kpi-words">${heroMissingHtml(hero)}</p>`)
  return kpiCardHtml('ledger', 'Your number', heroValueHtml(hero))
}

function kpiCardsHtml() {
  const activity = data.activity
  const days = activity && Array.isArray(activity.runs) ? activityByDay(activity.runs, new Date()) : null
  return `<div class="kpis">${workCardHtml(days, activity)}${agentsCardHtml(days, activity)}${heroCardHtml(data.hero)}</div>`
}

/* ---------- Plan limits ----------
   How much of each plan is used, from the reading a collector on the owner's own computer commits.
   The board never reaches an account itself, so this is always a reading with an age, and every
   state says which state it is in - never a zero for a number nobody read. The server has already
   checked every name and number (api/state.js shapeUsage); this escapes them anyway, because a
   check in one file is not a reason to trust the next one.

   "unofficial" and "estimate" are in plain view. They are not reasoning about the number, they ARE
   what the number is - the same line tests/render.test.mjs holds for spend - so neither goes behind
   a Why?. */
const METER_R = 18
const USAGE_SERVICES = [
  { key: 'claude', name: 'Claude', letters: 'Cl' },
  { key: 'codex', name: 'Codex', letters: 'Cx' }
]

// Under 75% is fine, 75 to 89 is worth knowing, 90 and over is close to the wall.
const meterLevel = (percent) => (percent >= 90 ? 'bad' : percent >= 75 ? 'warn' : 'ok')

// The owner's local time. A reset inside the day is a clock time; further off, the day goes first.
function resetWords(iso) {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return 'at an unreadable time'
  const soon = at.getTime() - Date.now() < 20 * 3600_000
  return at.toLocaleString(undefined, soon
    ? { hour: 'numeric', minute: '2-digit' }
    : { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

function meterHtml(window) {
  const label = escapeHtml(window.label)
  const track = `<circle class="meter-track" cx="22" cy="22" r="${METER_R}"/>`
  if (window.resetSinceReading || typeof window.usedPercent !== 'number') {
    return `<div class="meter"><div class="meter-dial">
      <svg class="meter-ring" viewBox="0 0 44 44" role="img" aria-label="${label}: reset since this reading, so there is no current figure">${track}</svg>
      <span class="meter-value meter-none" aria-hidden="true">&ndash;</span></div>
      <p class="meter-label">${label}</p><p class="meter-reset">Reset since this reading</p></div>`
  }
  const percent = Math.round(window.usedPercent)
  const around = 2 * Math.PI * METER_R
  // Past the limit is a full ring - it cannot be drawn fuller - and the number says how far past.
  const used = (Math.min(percent, 100) / 100) * around
  // A window Claude has not started yet comes with no reset time. The number is still a reading;
  // only the reset is unknown, and the page says so rather than inventing a time.
  const reset = window.resetsAt ? resetWords(window.resetsAt) : null
  const resetSaid = reset ? `resets ${escapeHtml(reset)}` : 'reset time unknown'
  const resetLine = reset ? `Resets <span class="meter-when">${escapeHtml(reset)}</span>` : 'Reset time unknown'
  // Nothing used is an empty track. A zero-length arc with round ends still paints a dot, which
  // reads as a sliver of use that is not there.
  const arc = percent > 0
    ? `<circle class="meter-used level-${meterLevel(percent)}" cx="22" cy="22" r="${METER_R}" stroke-dasharray="${used.toFixed(2)} ${around.toFixed(2)}" transform="rotate(-90 22 22)"/>`
    : ''
  return `<div class="meter"><div class="meter-dial">
    <svg class="meter-ring" viewBox="0 0 44 44" role="img" aria-label="${label}: ${percent}% used, ${resetSaid}">${track}${arc}</svg>
    <span class="meter-value" aria-hidden="true">${percent}%</span></div>
    <p class="meter-label">${label}</p><p class="meter-reset">${resetLine}</p></div>`
}

// Where the number came from, said in the card's head. The live address and the saved copy are ones
// Anthropic does not document. The status line is Claude Code's own, documented data, so it is the
// official reading and says so. Codex's is its own log of what the server told it, a different claim.
function sourceChipHtml(source) {
  if (source === 'claude-code-statusline') return '<span class="chip ok">From Claude Code</span>'
  if (source === 'unofficial-live') return '<span class="chip warn">unofficial</span>'
  if (source === 'claude-code-saved') return '<span class="chip warn">unofficial</span><span class="chip">saved copy</span>'
  if (source === 'codex-session-log') return '<span class="chip">from Codex&rsquo;s own log</span>'
  return ''
}

function planNameHtml(plan) {
  if (plan?.status === 'found' && plan.name) return escapeHtml(plan.name)
  return plan?.status === 'unavailable' ? 'Plan could not be read' : 'Plan not found'
}

function estimateHtml(activity) {
  if (!activity) return ''
  if (activity.status === 'found') {
    const replies = `${activity.replies} repl${activity.replies === 1 ? 'y' : 'ies'}`
    const sessions = `${activity.sessions} session${activity.sessions === 1 ? '' : 's'}`
    return `<p class="plan-estimate"><span class="chip">estimate</span> About ${replies} in ${sessions} over the
      last 7 days, counted from Claude Code&rsquo;s own logs.</p>`
  }
  return activity.status === 'unavailable'
    ? '<p class="plan-estimate">The estimate from Claude Code&rsquo;s logs could not be read.</p>'
    : '<p class="plan-estimate">No Claude Code logs were found to estimate from.</p>'
}

function planCardHtml(service, reading) {
  const where = reading.computer ? ` on ${escapeHtml(reading.computer)}` : ''
  const limits = reading.limits ?? { status: 'not found', windows: [] }
  let body
  if (limits.status === 'found' && Array.isArray(limits.windows) && limits.windows.length) {
    body = `<div class="meters">${limits.windows.map(meterHtml).join('')}</div>`
    if (limits.source === 'claude-code-statusline') {
      body += whyHtml(`These figures come from Claude Code’s own status line on ${reading.computer ?? 'the computer that took the reading'}: the plan limits Claude Code reports in its documented status line data, saved by a small script on that computer.`)
    }
  } else if (limits.status === 'unavailable') {
    body = `<p class="plan-missing"><b>${service.name} limits were unavailable when this was taken.</b></p>` +
      whyHtml(limits.why ?? 'The collector reached for the reading and did not get one it could trust, so it wrote down that it could not rather than a number.')
  } else {
    body = `<p class="plan-missing">No ${service.name} limits were found${where}.</p>`
  }
  // The server ages the card by when the limits were read, which a saved copy or a Codex log can put
  // hours before the file was collected. Said as one line when the two are minutes apart; when they
  // are not, both, so "1 min ago" never dates a five-hour-old figure.
  const readAt = limits.readAt ?? reading.takenAt
  const apart = Math.abs(new Date(reading.takenAt).getTime() - new Date(readAt).getTime())
  const foot = apart > 10 * 60_000
    ? `Reading from ${escapeHtml(ago(readAt))}, collected ${escapeHtml(ago(reading.takenAt))}${where}.`
    : `Taken ${escapeHtml(ago(readAt))}${where}.`
  const stale = reading.stale
    ? `<p class="plan-stale">This reading is older than 8 hours, so it may be out of date. Run
       <code>/snapshot</code>, or check the collector${where}.</p>`
    : ''
  return `<article class="panel card plan-card" data-service="${service.key}">
    <div class="plan-head"><span class="tile tile-${service.key}" aria-hidden="true">${service.letters}</span>
      <div class="plan-name"><p class="title">${service.name}</p><p class="plan-tier">${planNameHtml(reading.plan)}</p></div>
      <div class="plan-chips">${limits.status === 'found' ? sourceChipHtml(limits.source) : ''}</div></div>
    ${body}
    <p class="plan-foot">${foot}</p>${stale}
    ${service.key === 'claude' ? estimateHtml(reading.activity) : ''}</article>`
}

function planLimitsHtml(usage) {
  const head = sectionHead('From your always-on computer', '<h2>Plan limits</h2>')
  if (!usage || usage.status === 'none' || (usage.status === 'ok' && !usage.claude && !usage.codex)) {
    return `<section class="plan-limits">${head}<div class="panel empty"><b>No usage reading yet.</b>
      <span class="small">Run <code>/snapshot</code> in your team repo, or set up the collector on the
      computer that is always on.</span>${whyHtml('These meters come from a file a collector on your own computer commits to your repo. Until one exists there is nothing to read, and nothing is shown rather than a zero.')}</div></section>`
  }
  if (usage.status !== 'ok') {
    return `<section class="plan-limits">${head}<div class="panel empty"><b>Your usage reading could not be used.</b>
      <span class="small">${escapeHtml(usage.why ?? '')} Run <code>/snapshot</code> again.</span></div></section>`
  }
  const notes = []
  if (usage.unreadable) {
    notes.push(`${usage.unreadable} usage file${usage.unreadable === 1 ? '' : 's'} could not be used (damaged, too big, or not returned by GitHub), so ${usage.unreadable === 1 ? 'it was' : 'they were'} left out.`)
  }
  if (usage.skipped) {
    notes.push(`${usage.skipped} more usage file${usage.skipped === 1 ? ' was' : 's were'} not read - the board reads only five.`)
  }
  const cards = USAGE_SERVICES.filter((service) => usage[service.key])
    .map((service) => planCardHtml(service, usage[service.key])).join('')
  return `<section class="plan-limits">${head}<div class="plan-cards">${cards}</div>` +
    (notes.length ? `<p class="plan-note">${notes.map(escapeHtml).join(' ')}</p>` : '') + '</section>'
}

/* ---------- Subscriptions ----------
   What the owner says they pay, from `subscriptions:` in stack.yml - their own words, not a bill.
   The server has totalled it per currency and never converted (api/state.js shapeSubscriptions).
   A price here keeps its cents, unlike formatMoney's whole numbers: 19.99 rounded to 20 is a
   different number from the one on the receipt, and this is the one place a receipt is copied. */
function priceWords(value, currency) {
  const number = Number.isInteger(value)
    ? value.toLocaleString('en-US')
    : value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return currency ? `${number} ${escapeHtml(currency)}` : number
}

function subscriptionRowHtml(item) {
  let price
  if (typeof item.price !== 'number') {
    price = '<span class="subs-price muted">No price recorded</span>'
  } else if (typeof item.monthly !== 'number') {
    // A price with no currency or no month-or-year cannot join a total without a guess.
    price = `<span class="subs-price">${priceWords(item.price, item.currency)}${item.per ? ` a ${item.per}` : ''}</span>
      <span class="subs-sub">Not counted: it needs a three-letter currency, and month or year.</span>`
  } else if (item.per === 'year') {
    price = `<span class="subs-price">${priceWords(item.monthly, item.currency)} a month</span>
      <span class="subs-sub">${priceWords(item.price, item.currency)} a year, counted as a twelfth each month.</span>`
  } else {
    price = `<span class="subs-price">${priceWords(item.price, item.currency)} a month</span>`
  }
  const mismatch = item.mismatch && item.planRead
    ? `<span class="subs-mismatch">Your usage reading found ${escapeHtml(item.planRead)}. Worth checking which one you pay for.</span>`
    : ''
  return `<li class="subs-row"><span class="subs-name">${brandTileHtml(item.name, 'subs-tile')}<span class="subs-label">${escapeHtml(item.name)}</span></span>${price}${mismatch}</li>`
}

function subscriptionsHtml(subscriptions) {
  const items = Array.isArray(subscriptions?.items) ? subscriptions.items : []
  const unreadable = subscriptions?.unreadable ?? 0
  const skippedNote = unreadable
    ? `<p class="subs-note">${unreadable} line${unreadable === 1 ? '' : 's'} under subscriptions: ${unreadable === 1 ? 'was' : 'were'} not shown,
       because ${unreadable === 1 ? 'its name does' : 'their names do'} not read as plain names.</p>`
    : ''
  if (!items.length) {
    return `<section class="panel card subs"><p class="title">Subscriptions</p>
      <p class="subs-empty">No subscriptions recorded yet. <code>/onboard</code> asks what you pay each
      month, or add them under <code>subscriptions:</code> in <code>stack.yml</code>.</p>${skippedNote}</section>`
  }
  const totals = Array.isArray(subscriptions.totals) ? subscriptions.totals : []
  const totalHtml = totals.length
    ? `<p class="subs-total">${totals.map((total) => `<b>${priceWords(total.monthly, total.currency)}</b>`).join(' and ')} a month in total${
        totals.length > 1 ? ' &mdash; each currency added up on its own, never converted.' : '.'}</p>`
    : ''
  const unpriced = subscriptions.unpriced ?? 0
  const unpricedNote = unpriced
    ? `<p class="subs-note">${unpriced === 1 ? '1 subscription is' : `${unpriced} subscriptions are`} left out of the total,
       because ${unpriced === 1 ? 'it has' : 'they have'} no price the board can add up.</p>`
    : ''
  return `<section class="panel card subs"><p class="title">Subscriptions</p>
    <ul class="subs-list">${items.map(subscriptionRowHtml).join('')}</ul>
    ${totalHtml}${unpricedNote}${skippedNote}
    <p class="subs-note">From <code>subscriptions:</code> in <code>stack.yml</code> &mdash; what you wrote down, not a bill.</p></section>`
}

/* ---------- Ledger ---------- */

function renderLedger() {
  const ledger = data.ledger
  const proposals = data.proposals

  if (!ledger) {
    el('ledger').innerHTML =
      screenBannerHtml('ledger') +
      heroHtml(data.hero) +
      emptyStateHtml('ledger', `<b>No ledger yet.</b> <span class="small">Run <code>/ledger</code> in your
        team repo. It measures where your week actually goes, and everything on this screen is
        derived from it.</span>`)
    return
  }

  /* The hero was guarded and this line was not, so the zero simply moved down the page: an empty
     ledger printed "0 hours a week - $0 a week at the rate you set" here instead. Same claim,
     same screen, one panel lower. Guarded at the source now, in the same terms. */
  const hoursKnown = Number.isFinite(ledger.hoursPerWeek) && ledger.hoursPerWeek > 0
  const costKnown = hoursKnown && !ledger.unpriced && Number.isFinite(ledger.costPerWeek)

  const money = ledger.unpriced
    ? '<span class="small muted">No rate recorded, so this is counted in hours only.</span>'
    : costKnown
      ? `<b>${escapeHtml(formatMoney(ledger.costPerWeek, ledger.currency))}</b> a week at the rate you set` +
        // On its own line: run on from "at the rate you set" it read as one sentence on a phone.
        (ledger.currency ? '' : '<br><span class="small muted">No currency recorded, so the number is printed bare.</span>')
      : '<span class="small muted">No cost, because there are no hours to cost.</span>'

  const unreadableNote = ledger.unreadable
    ? `<p class="small bad">${ledger.unreadable} row${ledger.unreadable === 1 ? '' : 's'} in your
       ledger could not be read as hours, so the total below is incomplete. Fix
       <code>ledger.yml</code> and re-run <code>npm run check:ledger</code>.</p>`
    : ''

  // Same defect as numberCitation had one repo along: round to a decimal, then print a bare number
  // in front of a hardcoded "hours". Somebody whose whole week rounds to exactly one hour - a
  // light week, which is most first weeks - read "1 hours a week" as the headline of this screen.
  const roundedHours = Math.round(ledger.hoursPerWeek * 10) / 10
  const weekHtml = hoursKnown
    ? `<div class="panel card"><p class="week-line"><b>${roundedHours}</b> hour${roundedHours === 1 ? '' : 's'} a week &middot; ${money}</p>
       ${unreadableNote}
       <p class="small muted">Your numbers, from <code>ledger.yml</code>. Disagree with any of it and the
       answer is to change that file - nothing here is a recommendation.</p></div>`
    : `<div class="panel empty"><b>Your ledger has no hours in it yet.</b>
       <span class="small">Nothing is shown rather than a zero, because a zero here would say your
       repeating work costs you nothing.</span>${unreadableNote}</div>`

  const tasksHtml = ledger.tasks.length
    ? `<div class="panel">${ledger.tasks.map((task) =>
        `<div class="gap"><b>${escapeHtml(task.task)}</b>
          <span class="small">${task.hoursPerWeek === null ? '' : (Math.round(task.hoursPerWeek * 10) / 10) + 'h'}</span>
          ${task.confirmed === 'once' ? '<span class="chip">said once</span>' : ''}
          ${task.parked ? '<span class="chip">parked</span>' : ''}
          <div class="small muted">&ldquo;${escapeHtml(task.words)}&rdquo;</div>
          ${
            task.parked
              ? `<div class="small muted">Parked: ${
                  task.parkedBecause
                    ? escapeHtml(task.parkedBecause)
                    : 'nobody is named to act on the result yet'
                }</div>`
              : ''
          }</div>`
      ).join('')}</div>`
    : `<div class="panel empty"><b>Your ledger names no tasks yet.</b> <span class="small">Run
       <code>/ledger</code> again and tell it what you actually repeat each week &mdash; everything
       proposed below is derived from those lines and nothing else.</span></div>`

  /* Every proposal shows all three citations, because the whole point is that it can be checked
     without trusting anybody - their words, their number, and a thing that already exists. */
  const proposalHtml = proposals && proposals.proposals.length
    ? '<div class="stack">' + proposals.proposals.map((row) =>
        `<div class="panel card"><div class="row between"><b>${escapeHtml(row.task)}</b>
            <span class="chip">${escapeHtml(row.item)}</span></div>
          <div class="small">you said: &ldquo;${escapeHtml(row.words)}&rdquo;</div>
          <div class="small">that is: ${escapeHtml(row.number)}</div>
          ${row.why ? `<div class="small muted">why this one: ${escapeHtml(row.why)}</div>` : ''}
          <div class="approve"><button class="fire" type="button" data-approve="${escapeHtml(row.task)}">Approve</button>
            <span class="fire-note"></span>
            <div class="small muted">Records your decision in <code>proposals.yml</code>.
            Nothing is switched on and nothing is spent &mdash; arming is a separate step you take on
            purpose.</div></div></div>`
      ).join('') + '</div>'
    : '<div class="panel empty">No proposals yet. Run <code>/match</code> after your ledger is checked.</div>'

  /* The gaps are half the answer and the more useful half - they are the specification for what
     gets built next. Shown at the same weight as the proposals, never tucked away. */
  const gapHtml = !proposals
    ? `<div class="panel empty"><b>No gaps list yet.</b> <span class="small">Run <code>/match</code>
       in your team repo.</span>${whyHtml('Never having asked what your team cannot do is not the same as your team being able to do everything, so nothing is claimed here either way.')}</div>`
    : proposals.gaps.length
      ? `<div class="panel">${proposals.gaps.map((gap) =>
          `<div class="gap"><b>${escapeHtml(gap.task)}</b><div class="small muted">${escapeHtml(gap.question)}</div></div>`
        ).join('')}</div>`
      : `<div class="panel empty">Nothing on the gaps list &mdash; <code>/match</code> found
         something already in your repo for every line of your ledger.</div>`

  el('ledger').innerHTML =
    screenBannerHtml('ledger') +
    heroHtml(data.hero) +
    sectionHead('From your ledger', '<h2>Your week</h2>') + weekHtml +
    sectionHead('Repeating work', '<h2>What eats it</h2>') + tasksHtml +
    sectionHead('From /match', '<h2>Proposed</h2>') + proposalHtml +
    sectionHead('Gaps', '<h2>Nothing on the team does these yet</h2>') + gapHtml
}

function renderToday() {
  const board = data.board ?? { todo: [], upNext: [], running: [], done: [] }
  const due = data.workflows
    .filter((workflow) => workflow.nextRun && new Date(workflow.nextRun).getTime() - Date.now() <= 86400000)
    .sort((a, b) => String(a.nextRun).localeCompare(String(b.nextRun)))
  const dueHtml = due.length
    ? `<div class="panel">${due.map((workflow) =>
        `<div class="gap row between"><span><b>${escapeHtml(workflow.name)}</b> <span class="small muted">${escapeHtml(workflow.schedule ?? '')}</span></span><span class="small">${escapeHtml(until(workflow.nextRun) ?? '')}</span></div>`
      ).join('')}</div>`
    : `<div class="panel empty">Nothing scheduled in the next 24 hours.</div>`

  /* An empty quiet list used to print "Everything scheduled is running". On a repo where nine
     files declare a schedule and no routine exists, nothing CAN go quiet - and the board was
     reporting all clear about jobs that had never been switched on. That is precisely the claim
     this whole product exists to refuse, printed on its own front page. */
  const ringing = data.workflows.filter((workflow) => workflow.arm === 'armed').length
  const quietHtml = data.goneQuiet.length
    ? `<div class="panel">${data.goneQuiet.map((item) =>
        `<div class="gap"><b>${escapeHtml(item.name)}</b> <span class="chip">${escapeHtml(item.kind)}</span> <span class="small muted">last ran ${escapeHtml(ago(item.lastRun))}</span></div>`
      ).join('')}</div>`
    : ringing
      ? `<div class="panel empty">Nothing has gone quiet. All ${ringing} armed job${ringing === 1 ? '' : 's'}
         ran when ${ringing === 1 ? 'it was' : 'they were'} last due.</div>`
      // "No job is armed" stays in view: it is the fact, and the Why? only explains what it means.
      : `<div class="panel empty"><b>Nothing can go quiet yet.</b> <span class="small">No job on this
         team is armed.</span>${whyHtml('With nothing armed there is nothing scheduled to miss. That is not the same as everything running.')}</div>`

  // The snapshot banner belongs here too. Today is the first screen anybody opens, and it was the
  // one place a month-old snapshot was presented with no age at all.
  el('today').innerHTML =
    bannerHtml() + bannerPersonaliseHtml('today') +
    kpiCardsHtml() +
    planLimitsHtml(data.usage) +
    snapshotBannerHtml(data.routines) +
    ladderHtml(data.setup) +
    fireButtonsHtml(data.workflows) +
    macOrdersHtml() +
    sectionHead('What everyone is on', '<h2>Board</h2>') + boardHtml(board) +
    sectionHead('Next 24 hours', '<h2>Due next</h2>') + dueHtml +
    sectionHead('Worth a look', '<h2>Gone quiet</h2>') + quietHtml +
    // The week, last: what is scheduled, what already ran, what was due and did not.
    scheduleStripHtml(data.workflows, { dates: true, runs: data.runs, heading: 'This week', eyebrow: 'Schedule', routines: data.routines }) +
    // Spec B.2: remaining routine runs are linked, never scraped — there is no API for them.
    sectionHead('Your Claude account', '<h2>Usage</h2>') + `<div class="panel"><p class="small">Remaining routine runs live on your
      <a href="https://claude.ai/settings/usage" rel="noreferrer noopener">claude.ai usage page</a> —
      the dashboard links there rather than guessing.</p></div>` +
    // Under it, what the owner says they pay - the one thing on this section the repo can source.
    subscriptionsHtml(data.subscriptions) +
    // And what talking to the board has cost, while voice is on.
    voiceSpendHtml()
}

/* ---------- Team ---------- */

/* The eight agents the template ships, which are the eight with a portrait in public/art. Anybody
   else on the team is the owner's own agent, and gets its initial on its own palette colour. The
   address of a picture is only ever built from a name in this list: a slug is a file name from the
   repo, and a src made from it would ask the server for whatever that file name says. */
const PORTRAITS = new Set(['content', 'customer-service', 'editor', 'email', 'orchestrator', 'research', 'sales', 'security'])

// The initial is always drawn, and the picture over it. It is what shows while a lazy picture is on
// its way, and what is left if one fails. Array.from so a slug starting with an emoji or an
// accented letter gives a whole character rather than half of one. The owner's own picture of the
// agent comes first, then the robot, then the initial alone - and the owner's own agent, which has
// no robot, can have a picture this way too.
function portraitHtml(agent) {
  const initial = Array.from(String(agent.slug ?? ''))[0] ?? '?'
  const src = pictureSrc(`agent-${agent.slug}`, PORTRAITS.has(agent.slug) ? `/art/agent-${agent.slug}.webp` : null)
  const picture = src
    ? `<img class="portrait-img" src="${escapeHtml(src)}" alt="" width="480" height="480" loading="lazy" decoding="async" />`
    : ''
  return `<div class="portrait"${artMark(`agent-${agent.slug}`)} style="--agent:${agentColor(agent.slug) ?? AGENT_PALETTE[0].hex}">
      <span class="portrait-tile" aria-hidden="true">${escapeHtml(initial.toUpperCase())}</span>${picture}
      <span class="status-pill"><span class="dot"></span><span class="state">${escapeHtml(STATE_LABEL[agent.state] ?? agent.state)}</span></span>
    </div>`
}

// A picture that fails - renamed, or lost to a bad connection - is taken away, and the initial under
// it shows instead of a broken-image box. On the document in the capture phase, because an image's
// error event does not bubble, and the cards are redrawn on every reading of the repo.
function dropBrokenPortrait(event) {
  const image = event.target
  if (image?.classList?.contains('portrait-img')) image.remove()
}
document.addEventListener('error', dropBrokenPortrait, true)

const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve']

// The workshop, with how many agents there are and how many are in each state. A state nobody is in
// is left out rather than printed as a 0, and no agent is named - this is the team, the cards below
// are the agents.
function teamBannerHtml(agents) {
  const count = agents.length
  const headline = count === 1
    ? 'One agent. <span class="soft">One desk.</span>'
    : `${NUMBER_WORDS[count] ?? count} agents. <span class="soft">One desk each.</span>`
  const states = [
    ['working', () => 'working'], ['quiet', () => 'gone quiet'],
    ['attention', (number) => (number === 1 ? 'needs a look' : 'need a look')],
    ['never-run', () => 'never run'], ['not-in-use', () => 'switched off']
  ]
  const counts = states
    .map(([state, words]) => [agents.filter((agent) => agent.state === state).length, words])
    .filter(([number]) => number)
    .map(([number, words]) => `${number} ${words(number)}`)
  return pictureSwap(`<section class="banner team-banner"${artMark('team')}>
    <img src="/art/team-workshop.webp" alt="" width="1600" height="686" loading="lazy" decoding="async" />
    <div class="banner-text">
      <div class="banner-words">
        <p class="eyebrow">Your team</p>
        <h2 class="headline">${headline}</h2>
        ${counts.length ? `<p class="banner-strap">${counts.join(' &middot; ')}</p>` : ''}
      </div>${bannerButtonsHtml('team')}
    </div>
  </section>`, '/art/team-workshop.webp', 'team')
}

function renderTeam() {
  if (!data.agents.length) {
    // "asks about your business" was the only line on this board that assumed the reader owns the
    // thing. Half the people this is built for have a job: the ledger's very first question is
    // owner_type: business | job | both, and the walkthrough's employee persona is a bid
    // coordinator who does not price work, choose what to bid, or spend anything. It is the empty
    // state, so it is the FIRST sentence a brand-new student reads on this screen.
    el('team').innerHTML = `${createFormHtml('agent')}${emptyStateHtml('team', `<b>You have no agents yet.</b>
      <span class="small">Run <code>/onboard</code> in your team repo.</span>${whyHtml('It asks about your work and writes the first agents into .claude/agents/, and they appear here.')}`)}`
    bindCreateForm('agent', el('team'))
    return
  }
  const cards = data.agents.map((agent) => {
    // The agent's OWN newest runs, sent with it. Filtering the feed is what made a card count eight
    // runs and open to "No runs logged yet": the feed is the newest fifty across the whole team, so
    // a quiet agent's work fell out of it while its count did not. The feed stays only as a fallback
    // for a reading from a server that does not send them yet - a cached one during a deploy.
    const mine = (agent.recentRuns ?? data.runs.filter((run) => run.agent === agent.slug)).slice(0, 5)
    const runRows = mine.map((run) =>
      `<div class="run"><div class="row between">
        <span class="small">${escapeHtml(run.summary ?? '')}</span>
        <span class="small muted">${escapeHtml(ago(run.started_at))}${run.session_url ? ` &middot; <a class="watch" href="${escapeHtml(run.session_url)}" rel="noreferrer noopener">watch</a>` : ''}</span>
      </div></div>`
    ).join('')
    // The drawer never contradicts the count on the card above it. Fewer rows than runs says so; no
    // rows at all for an agent with runs says the page was not sent them, never that none exist.
    const total = agent.totalRuns ?? mine.length
    const runsNote = !mine.length
      ? total
        ? `<div class="empty">${total} run${total === 1 ? ' is' : 's are'} logged, but this page was sent none of them. Reload to fetch them.</div>`
        : '<div class="empty">No runs logged yet.</div>'
      : mine.length < total
      ? `<div class="run small muted">The newest ${mine.length} of ${total}. The rest are files in runs/ in your repo.</div>`
      : ''
    // The portrait and the words are both inside the summary, so a tap anywhere on the card opens it.
    // A name the owner gave the agent goes over its slug; the slug stays, as what jobs call it.
    const name = displayName(agent.slug)
    return `<details class="agent-card agent-accent ${agent.state}${name ? ' named' : ''}"${accentStyle(agent.slug)}>
      <summary>
        ${portraitHtml(agent)}
        <div class="agent-body">${name ? `<span class="display-name">${escapeHtml(name)}</span>` : ''}
        <div class="row between">
          <span class="row"><span class="swatch" style="background:${agentColor(agent.slug)}"></span><span class="title">${escapeHtml(agent.slug)}</span></span>
          <span class="chip">${escapeHtml(agent.model)}</span>
        </div>
        <p class="desc">${escapeHtml(agent.description)}</p>
        <div class="row">
          <span class="chip">${agent.runsThisWeek} this week</span>
          <span class="small muted">last run ${escapeHtml(ago(agent.lastRun))}</span>
        </div>
        ${
          // Why this one is switched off, in the owner's own words, taken from the knowledge file
          // the board already read to decide it. The other two deliberately-off states on this
          // board both show their reason - a workflow prints its `reason:`, a parked ledger row
          // prints its `parked_because:` - and this one showed nothing, so an agent somebody
          // switched off on purpose looked like an agent nobody had got to.
          //
          // Capped at three lines because there is no cap on how long somebody's sentence is. The
          // rule that finds it reads to the end of the paragraph, so a single sentence listing
          // everything the owner does not sell is one legitimate quote and ran to twelve lines on a
          // phone, burying the eight agent cards under it. The full text stays in the tooltip.
          agent.notInUseBecause
            ? `<div class="small muted clamp" title="${escapeHtml(agent.notInUseBecause)}">${escapeHtml(
                agent.notInUseBecause
              )}</div>`
            : ''
        }
        <span class="runcount">${
          // Keyed on the STATE, not on whether a reason came back. A refusal that only exists
          // inside a code fence or a heading leaves nothing quotable, and this card still has to
          // say the agent is off rather than falling back to "Nothing logged yet", which is what
          // an agent nobody has got to says.
          agent.state === 'not-in-use'
            ? 'Switched off, so nothing runs it'
            : agent.totalRuns === 0
            ? 'Nothing logged yet'
            : `${agent.totalRuns} run${agent.totalRuns === 1 ? '' : 's'} logged &mdash; tap to read them` +
              // Decorative. The sentence beside it already says the card opens, so a screen reader
              // announcing a bare "›" after it is noise - and a fix about one modality has no
              // business making another one worse.
              '<span class="chev" aria-hidden="true">&rsaquo;</span>'
        }</span>
        </div>
      </summary>
      <div class="agent-runs">${runRows}${runsNote}</div>${personaliseHtml(agent)}
    </details>`
  }).join('')
  // Add agent goes under the banner and above the cards, on every screen size. It was the last tile
  // of the grid, as in the mock-up - after eight tall portraits on a phone, where most people never
  // scrolled far enough to learn they could add one (Nuno's call, 2026-10-06). With no agents it is
  // at the top as well, above the sentence saying how to get some.
  // Make it yours, when it is open, and the banner's own picture controls sit between the banner
  // and Add agent: straight under the button that opened them, and above every card.
  el('team').innerHTML = `${teamBannerHtml(data.agents)}${brandPanelOpen ? brandPanelHtml() : ''}${bannerPersonaliseHtml('team')}` +
    `${createFormHtml('agent')}<div class="team-grid">${cards}</div>`
  bindCreateForm('agent', el('team'))
}

/* ---------- Workflows ---------- */

// The Schedule strip: a Mon..Sun week computed client-side from the parsed schedule
// strings via scheduleWeekView. Monthly and interval schedules get a footnote row —
// they have no fixed weekday — and the legend maps each owner agent to its color.
// --- the week calendar -------------------------------------------------------------------
// Mirrored verbatim in api/_lib.js. Monday-first, local time: the calendar answers
// "did today's job run", and a UTC week would answer it for the wrong day either side of
// midnight.

/* The week strip. This is the site the last pass missed: it filtered on `workflow.schedule`
   alone, so a job nothing fires still appeared on every day of the week, visually identical to a
   real one - and on the Today strip it collected a "was due, no run logged" mark four times a
   week. That is an accusation, and it needs an alarm clock to exist before it can be made.

   Only jobs that actually ring appear here. The rest are counted underneath, so their absence is
   visible rather than silent. */

function ringsNow(workflow) {
  return workflow.arm === 'armed' || workflow.arm === 'unapproved'
}

function weekDates(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
  return Array.from({ length: 7 }, (unused, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    return date
  })
}

const dateKey = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

// Which local days a workflow actually ran on, from the run logs. Runs match a workflow by
// its slug - the same field the Workflows board matches on - so a run log missing
// `workflow` counts for nothing rather than for everything.
function ranOnDays(runs, slug) {
  const days = new Set()
  if (!slug) return days
  for (const run of runs ?? []) {
    if (run.workflow !== slug) continue
    const at = Date.parse(run.started_at)
    if (!Number.isFinite(at)) continue
    days.add(dateKey(new Date(at)))
  }
  return days
}

// Runs, and how many different agents ran them, on each of the last `days` local days, oldest
// first and ending today - what the two lines on Today's number cards are drawn from. Local for
// the calendar's reason: a run at 23:30 belongs to that evening, and keyed by UTC it lands on
// tomorrow's bar for anybody west of Greenwich. A day with nothing on it is a zero, not a gap.
function activityByDay(runs, now = new Date(), days = 14) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const tally = new Map()
  for (let back = days - 1; back >= 0; back -= 1) {
    const date = new Date(today)
    date.setDate(today.getDate() - back)
    tally.set(dateKey(date), { runs: 0, agents: new Set() })
  }
  for (const run of runs ?? []) {
    const at = Date.parse(run?.started_at)
    if (!Number.isFinite(at)) continue
    const day = tally.get(dateKey(new Date(at)))
    if (!day) continue
    day.runs += 1
    if (typeof run.agent === 'string' && run.agent) day.agents.add(run.agent)
  }
  return [...tally].map(([date, day]) => ({ date, runs: day.runs, agents: day.agents.size }))
}
function scheduleStripHtml(workflows, options = {}) {
  const scheduled = workflows.filter((workflow) => workflow.schedule && ringsNow(workflow))
  const silent = workflows.filter((workflow) => workflow.schedule && !ringsNow(workflow))
  // This strip is drawn on Today and nowhere else: the Workflows screen shows the seven-day list
  // instead, which names these jobs rather than counting them. It used to take a `here` flag for
  // when it was drawn ON the Workflows screen, where pointing the reader at the Workflows screen
  // sends them nowhere - that branch went with the caller, and is deleted rather than left as a
  // condition the next reader has to assume both sides of.
  // "and nothing fires them" is a claim about ROUTINES, and with no snapshot this board has no
  // routines to claim anything about. In the shipped state it printed that sentence three lines
  // under its own banner saying which of these ring is unknown: two answers on one screen, and
  // the confident one wrong. Every job with a schedule lands in `silent` when the snapshot is
  // unusable - not because nothing fires them, but because nothing is known to.
  //
  // Found by looking at the day-one screen as a picture while replacing the Workflows strip, and
  // fixed here as well because otherwise the two screens now disagree with each other.
  const routinesKnown = options.routines ? Boolean(options.routines.usable && !options.routines.stale) : true
  const silentNote = silent.length
    ? `<p class="small muted">${
        routinesKnown
          ? (silent.length === 1 ? '1 other job names a time in its file and nothing fires it' : silent.length + ' other jobs name a time in their files and nothing fires them')
          : (silent.length === 1 ? '1 other job names a time in its file, and whether anything fires it is unknown' : silent.length + ' other jobs name a time in their files, and whether anything fires them is unknown')
      } - see the Workflows screen.</p>`
    : ''
  if (!scheduled.length) {
    return silentNote
      ? sectionHead(options.eyebrow ?? 'Schedule', `<h2>${escapeHtml(options.heading ?? 'Schedule')}</h2>`) +
        `<div class="panel empty">Nothing that rings is scheduled. ${silentNote}</div>`
      : ''
  }
  const { dates = false, runs = [], heading = 'Schedule' } = options
  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const dayPills = DAY_NAMES.map(() => [])
  const footnotes = []
  const week = weekDates()
  const todayKey = dateKey(new Date())
  const nowMs = Date.now()
  for (const workflow of scheduled) {
    const view = scheduleWeekView(workflow.schedule)
    if (!view) continue
    const hex = agentColor(workflow.owner) ?? 'var(--muted)'
    const ran = dates ? ranOnDays(runs, workflow.slug) : new Set()
    // Outcome is only claimed for days that have finished. A pill for later today is
    // still pending, not missed - calling it missed at 09:00 for an 18:00 job is a lie.
    const outcome = (dayIndex, time) => {
      if (!dates) return { klass: '', mark: '' }
      const key = dateKey(week[dayIndex])
      if (ran.has(key)) return { klass: ' done', mark: '<span class="mark">&#10003;</span>' }
      const due = new Date(week[dayIndex])
      const [hours, minutes] = String(time ?? '23:59').split(':').map(Number)
      due.setHours(hours || 0, minutes || 0, 0, 0)
      if (due.getTime() > nowMs) return { klass: '', mark: '' }
      return { klass: ' missed', mark: '<span class="mark">&#9679;</span>' }
    }
    const pill = (label, extra = { klass: '', mark: '' }) =>
      `<span class="pill${extra.klass}" style="border-left-color:${hex}"><b>${escapeHtml(workflow.name)}</b> <span class="t">${escapeHtml(label)}</span>${extra.mark}</span>`
    if (view.type === 'days') {
      for (const day of view.days) dayPills[day].push(pill(view.time, outcome(day, view.time)))
    } else if (view.type === 'monthly') {
      footnotes.push(`<span class="small muted">monthly:</span> ${pill(`day ${view.day} ${view.time}`)}`)
    } else {
      footnotes.push(pill(view.label))
    }
  }
  const columns = DAY_NAMES.map((name, index) => {
    const isToday = dates && dateKey(week[index]) === todayKey
    const dayLabel = dates
      ? `${name} <span class="daydate">${week[index].getDate()}</span>`
      : name
    return `<div class="day${isToday ? ' today' : ''}"><div class="dayname">${dayLabel}</div>${dayPills[index].join('')}</div>`
  }).join('')
  const owners = [...new Set(scheduled.map((workflow) => workflow.owner).filter(Boolean))].sort()
  const legend = owners.map((owner) =>
    `<span><span class="swatch" style="background:${agentColor(owner)}"></span>${escapeHtml(owner)}</span>`
  ).join('')
  const key = dates
    ? `<div class="cal-key"><span>&#10003; ran</span><span>&#9679; was due, no run logged</span><span>no mark: still to come</span></div>`
    : ''
  // silentNote belongs on BOTH branches. It was computed above and then only ever printed on the
  // "nothing rings at all" branch, so the moment a repo armed its first job it fell into this
  // branch and the count of jobs that declare a time and are fired by nothing silently vanished -
  // from Today and from here. That is the exact mixed state every real repo is in after week one,
  // and this count is the one guard against a board that shows nine jobs "running" when one is.
  // silentNote goes ABOVE the calendar, not after it. It belongs on both branches - it used to be
  // printed only on the "nothing rings at all" one, so the moment a repo armed its first job it
  // fell into this branch and the count of jobs that declare a time and are fired by nothing
  // silently vanished, from Today and from here. That is the mixed state every real repo is in
  // after week one, and this count is the one guard against a board that shows nine jobs as
  // scheduled when one rings.
  //
  // First, because this file already works that way everywhere else it has to undermine something
  // that looks like a fact: the snapshot banner prints before the workflow list, and the arm state
  // prints before the schedule chip precisely so the chip is never left standing on its own. A
  // week grid is that same chip at the size of a whole panel, and a caveat read after four columns
  // of a calendar that looks complete has already lost.
  return sectionHead(options.eyebrow ?? 'Schedule', `<h2>${escapeHtml(heading)}</h2>`) + `<div class="panel">
    ${silentNote}
    <div class="schedule-scroll"><div class="week">${columns}</div></div>
    ${footnotes.length ? `<div class="sched-foot">${footnotes.join(' ')}</div>` : ''}
    ${key}
    ${legend ? `<div class="legend">${legend}</div>` : ''}
  </div>`
}

/* ---------- Next 7 days -------------------------------------------------------------------

   The week grid above answers "which weekday does this land on". It cannot answer the question a
   student actually asks - what is coming, in order, starting today - and to answer its own it has
   to hide two kinds of job: anything nothing fires (counted in a note, never shown) and anything
   monthly or every-N (dropped to a footnote with no day at all).

   This list answers the asked question, and because it is keyed on real dates rather than
   weekday columns, a monthly job lands on its own date instead of in a footnote. Every job that
   names a time appears somewhere: the ones that ring under a day, the ones that do not in their
   own labelled section underneath, with the file's own reason. Absent is what made the grid
   confusing; labelled is the fix.

   The grid stays on Today. It answers a different question - did today's job run - and its marks
   need a fixed week to sit on.

   TIMES ARE PRINTED AS THE FILE WRITES THEM. The page does not convert them, and does not claim a
   timezone it has not checked: the server computes next-run times in UTC while this list reads
   the schedule string, so a sentence here saying "your local time" would be a claim nothing
   verifies. The day a job lands on is this device's calendar, exactly as the grid already does. */

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function sevenDayDates(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Array.from({ length: 7 }, (unused, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    return date
  })
}

/* Does this schedule fire on this date, and with what label? Returns null for "not that day".
   scheduleWeekView's day indexes are Monday-first (0 = Mon); a JS date is Sunday-first, hence
   the conversion. Getting that backwards would put every weekly job on the wrong day, which is
   the sort of mistake that looks like data and reads like a fact. */
function firingOnDate(view, date) {
  if (!view) return null
  if (view.type === 'interval') return { sort: -1, label: view.label === 'hourly' ? 'every hour' : view.label }
  if (view.type === 'days') {
    return view.days.includes((date.getDay() + 6) % 7) ? { sort: timeSort(view.time), label: view.time } : null
  }
  if (view.type === 'monthly') {
    return date.getDate() === view.day ? { sort: timeSort(view.time), label: view.time } : null
  }
  return null
}

const timeSort = (time) => {
  const [hours, minutes] = String(time ?? '').split(':').map(Number)
  return (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0)
}

function nextSevenDaysHtml(workflows, options = {}) {
  const heading = options.heading ?? 'Next 7 days'
  const scheduled = workflows.filter((workflow) => workflow.schedule && ringsNow(workflow))
  const silent = workflows.filter((workflow) => workflow.schedule && !ringsNow(workflow))

  // Every job that names a time and is fired by nothing, named rather than counted. The count
  // note the grid prints is not repeated here: a list of them says the same thing and more, and
  // two statements of one fact on one screen is how a reader learns to skim both.
  const silentHtml = silent.length
    ? `<div class="d7-silent">
        <h3>In a file, not ringing</h3>
        <p class="small muted">${silent.length === 1 ? 'This job names' : 'These ' + silent.length + ' jobs name'} a time in ${silent.length === 1 ? 'its file' : 'their files'}. A time in a file is a wish until a routine fires it, and arming is a decision you make with your team, not here.</p>
        ${silent.map((workflow) => `<div class="d7-row muted">
          <span class="d7-t">${escapeHtml(workflow.schedule)}</span>
          <span class="d7-what"><b>${escapeHtml(workflow.name)}</b>${workflow.owner ? ` <span class="small muted">${escapeHtml(workflow.owner)}</span>` : ''}
            ${
              // The owner note comes BEFORE the reason, for the same cause the card below states
              // it first: a reason like "Off until the pipeline has people in it" tells the reader
              // to arm this when the data arrives, and arming it would achieve nothing while the
              // agent that owns it is switched off. Printing the reason here unqualified put that
              // instruction ABOVE the fact that contradicts it, higher up the screen than the card
              // that does the contradicting - re-opening, one panel further up, the exact defect
              // stage 3 closed on the card itself.
              workflow.ownerSwitchedOff
                ? `<span class="small bad d7-why">Owned by <b>${escapeHtml(workflow.owner)}</b>, which you are not using &mdash; this cannot run as written.</span>`
                : ''
            }${workflow.reason ? `<span class="small muted d7-why">${escapeHtml(workflow.reason)}</span>` : ''}</span>
        </div>`).join('')}
      </div>`
    : ''

  if (!scheduled.length) {
    // Seven days of "Nothing scheduled" is a worse answer than one sentence saying so.
    return sectionHead('Coming up', `<h2>${escapeHtml(heading)}</h2>`) + `<div class="panel">
      <div class="empty">Nothing that rings is scheduled.</div>
      ${silentHtml}
    </div>`
  }

  const days = sevenDayDates().map((date, index) => {
    const rows = []
    for (const workflow of scheduled) {
      const firing = firingOnDate(scheduleWeekView(workflow.schedule), date)
      if (!firing) continue
      const hex = agentColor(workflow.owner) ?? 'var(--muted)'
      // A job whose file says off while a routine fires it is spending runs nobody approved.
      // The card below says so in full; the list says enough that it is not read as normal.
      const rogue = workflow.arm === 'unapproved'
      rows.push({
        sort: firing.sort,
        // `data-job`, and the handler calls preventDefault - the same shape as data-open and
        // data-fire elsewhere on this page, and it is load-bearing here. This screen routes on
        // the hash, and showScreen sends any hash it does not recognise to Today. So letting the
        // browser follow a bare href="#job-..." threw the reader off the Workflows screen
        // entirely: tap a job, land on Today. The anchor still resolved to the right card, which
        // is why reading the markup could not catch it. Clicking it did.
        html: `<a class="d7-row${rogue ? ' bad' : ''}" href="#job-${escapeHtml(workflow.slug)}" data-job="${escapeHtml(workflow.slug)}" style="border-left-color:${hex}">
          <span class="d7-t">${escapeHtml(firing.label)}</span>
          <span class="d7-what"><b>${escapeHtml(workflow.name)}</b>${workflow.owner ? ` <span class="small muted">${escapeHtml(workflow.owner)}</span>` : ''}${rogue ? ' <span class="chip bad">not approved</span>' : ''}</span>
        </a>`
      })
    }
    rows.sort((a, b) => a.sort - b.sort)
    const label = `${DAY_SHORT[date.getDay()]} ${date.getDate()} ${MONTH_SHORT[date.getMonth()]}`
    return `<div class="d7-day${index === 0 ? ' today' : ''}">
      <div class="d7-date">${escapeHtml(label)}${index === 0 ? ' <span class="small muted">today</span>' : ''}</div>
      ${rows.length ? rows.map((row) => row.html).join('') : '<div class="small muted d7-none">Nothing scheduled</div>'}
    </div>`
  }).join('')

  return sectionHead('Coming up', `<h2>${escapeHtml(heading)}</h2>`) + `<div class="panel">
    <div class="days7">${days}</div>
    ${silentHtml}
  </div>`
}

/* Which jobs actually ring.

   A file saying `schedule: "daily 06:30"` makes nothing happen at 06:30 - a routine is the alarm
   clock. This board reported nine jobs running, each with a next-run time, against one real
   routine. The schedule chip alone said "daily 06:30" and looked exactly like a fact.

   So the arm state is shown first, in words, and the schedule chip is never allowed to stand on
   its own again. */

const ARM_LABELS = {
  armed: { text: 'ARMED', cls: 'on', note: 'a routine exists and this fires' },
  declared: { text: 'DECLARED', cls: 'bad', note: 'this file says run it and NOTHING rings' },
  unapproved: { text: 'UNAPPROVED', cls: 'bad', note: 'something is firing that this file never approved' },
  off: { text: 'OFF', cls: '', note: 'deliberately not running' },
  // Not a fifth kind of job - the same jobs, with the evidence missing. Saying UNKNOWN is the
  // honest answer when the snapshot cannot be trusted; saying DECLARED would be a claim.
  unknown: { text: 'UNKNOWN', cls: '', note: 'this file says run it, and there is no snapshot to check it against' }
}

function armChipHtml(workflow) {
  const label = ARM_LABELS[workflow.arm] ?? ARM_LABELS.off
  return `<span class="chip ${label.cls}" title="${escapeHtml(label.note)}">${label.text}</span>`
}

/* The snapshot is how the truth reaches a web app that cannot call the routines API. It is always
   presented AS a snapshot, with its age - a snapshot passed off as live would be the same class of
   lie as the declared job this screen exists to expose. */

function snapshotBannerHtml(routines) {
  if (!routines) return ''
  if (!routines.usable) {
    return `<div class="panel empty"><b>Which of these actually ring is unknown.</b>
      <span class="small">${escapeHtml(routines.why ?? '')} Run <code>/routines</code> in your team repo
      to record what is really scheduled.</span>${whyHtml('Until then the states below come from your files alone, and a file claiming a schedule is exactly what this screen is here to check.')}</div>`
  }
  const when = stamp(routines.takenAt)
  // The age is in the headline and what to do is beside it. The server's account of why that age is
  // too old is the reasoning, so that is the part behind Why?.
  if (routines.stale) {
    return `<div class="panel empty"><b>These routines were last checked ${escapeHtml(when)}.</b>
      <span class="small">Run <code>/routines</code> again before
      trusting it.</span>${routines.why ? whyHtml(routines.why) : ''}</div>`
  }
  return `<div class="panel card"><span class="small muted">${routines.count} routine${routines.count === 1 ? '' : 's'}
    on your account, recorded ${escapeHtml(when)}. This is a snapshot, not a live reading.</span></div>`
}

/* Both duplicate-name checks were computed server-side and displayed nowhere, so the owner never
   saw "they will all fire, and the spend is multiplied" - the one sentence that explains why a
   job arrives twice and costs twice. */
function routineProblemsHtml(routines) {
  if (!routines || !routines.problems || !routines.problems.length) return ''
  return sectionHead('Needs a look', '<h2>Problems with your schedule</h2>') + `<div class="panel">${routines.problems.map((problem) =>
    `<div class="gap small bad">${escapeHtml(problem)}</div>`
  ).join('')}</div>`
}

function orphanRoutinesHtml(routines) {
  if (!routines || !routines.orphans || !routines.orphans.length) return ''
  return sectionHead('On your account', '<h2>Routines with no workflow file</h2>') + `<div class="panel">${routines.orphans.map((orphan) =>
    `<div class="gap"><b>${escapeHtml(orphan.name)}</b>
      <div class="small muted">Something was armed and then renamed or removed. Reported, not adopted —
      the dashboard will not attach it to a file it does not match.</div></div>`
  ).join('')}</div>`
}

function renderWorkflows() {
  // An early return here used to hide the orphan panel and the schedule problems entirely, so a
  // repo with no workflow files but a live routine on the account showed nothing about it at all.
  // That is the one case where those panels matter most.
  if (!data.workflows.length) {
    el('workflows').innerHTML =
      screenBannerHtml('workflows') +
      snapshotBannerHtml(data.routines) +
      emptyStateHtml('workflows', 'No workflow files in <code>workflows/</code> yet. Ask for one — <code>/new-workflow</code> — and it appears here.') +
      routineProblemsHtml(data.routines) +
      orphanRoutinesHtml(data.routines)
    return
  }
  const cards = data.workflows.map((workflow) => {
    const chain = workflow.steps.map((step) => `<b>${escapeHtml(step)}</b>`).join(' &rarr; ')
    // The schedule chip is deliberately NOT "on" unless something rings. A green chip reading
    // "daily 06:30" beside a job nothing fires is the whole bug, rendered.
    const scheduleLive = workflow.arm === 'armed' || workflow.arm === 'unapproved'
    const triggers = [
      armChipHtml(workflow),
      workflow.schedule ? `<span class="chip ${scheduleLive ? 'on' : ''}">${escapeHtml(workflow.schedule)}</span>` : '',
      workflow.fire ? `<span class="chip on">button</span>` : '',
      workflow.webhook ? `<span class="chip on">webhook</span>` : ''
    ].filter(Boolean).join('')
    const last = workflow.lastRun
      ? `Last: ${escapeHtml(workflow.lastRun.status)} ${escapeHtml(ago(workflow.lastRun.started_at))}${workflow.lastRun.session_url ? ` &middot; <a class="watch" href="${escapeHtml(workflow.lastRun.session_url)}" rel="noreferrer noopener">watch</a>` : ''}`
      : 'Never run'
    const next = workflow.nextRun ? ` &middot; next ${escapeHtml(until(workflow.nextRun) ?? '')}` : ''
    // No next-run time is invented for anything that does not ring. Instead the card says why.
    const armNote = workflow.arm === 'unknown'
      ? `<div class="small muted">This file says it should run. Whether anything actually fires it is unknown until you run <code>/routines</code> and commit the result.</div>`
      : workflow.arm === 'declared'
      ? `<div class="small bad">Nothing fires this. The schedule above is a wish until you arm it — <code>/arm</code>.</div>`
      : workflow.arm === 'unapproved'
        ? `<div class="small bad">A routine is firing for this and the file says it is off. It is spending runs nobody approved.</div>`
        : workflow.arm === 'off' && workflow.reason
          // Every reason the template ships already opens with "Off until ...", so labelling it
          // "Off:" printed the word twice on all nine cards. The label only earns its place when
          // the owner's own reason does not already say it.
          ? `<div class="small muted">${/^off\b/i.test(workflow.reason.trim()) ? '' : 'Off: '}${escapeHtml(workflow.reason)}</div>`
          : ''
    // Printed ABOVE the reason, because it is the thing the reason contradicts. "Off until the
    // pipeline has people in it who could go quiet" tells him to arm this when the data arrives;
    // arming it would achieve nothing, because the agent that owns it is one he switched off. The
    // wording matches what `check:arming` prints in the terminal, so the two cannot disagree.
    const ownerNote = workflow.ownerSwitchedOff
      ? `<div class="small bad">Owned by <b>${escapeHtml(workflow.owner)}</b>, which you are not using &mdash; this cannot run as written. Give it a different owner, or leave it off on purpose.</div>`
      : ''
    const problems = workflow.problems.length
      ? `<ul class="problems">${workflow.problems.map((problem) => `<li>${escapeHtml(problem)}</li>`).join('')}</ul>`
      : ''
    // Run posts /api/fire {action:"run"}, pause posts {action:"pause"} — pausing is a
    // dispatch too: the agent session edits the workflow file, the dashboard itself never
    // writes to the repo (spec B.2). Both need trigger.fire: true, because dispatch goes
    // through the workflow's registered trigger URL.
    const runButton = workflow.fire
      ? `<button class="fire job" type="button" data-fire="${escapeHtml(workflow.slug)}" data-action="run">${PLAY}Run</button>`
      : ''
    const pauseButton = workflow.schedule
      ? (workflow.fire
        ? `<button class="fire" type="button" data-fire="${escapeHtml(workflow.slug)}" data-action="pause">&#10074;&#10074; Pause</button>`
        : `<button class="fire" type="button" disabled title="Pause dispatches through this workflow's trigger URL — add fire: true to its trigger block first">&#10074;&#10074; Pause</button>`)
      : ''
    // Arming goes through the general intake, not this workflow's own trigger - a job being armed
    // has no routine yet, so it has no trigger URL of its own to dispatch to.
    // The explanation of what arming DOES is printed once at the top of this screen, not on every
    // card. It shipped per-card, so a repo with nine unarmed jobs - which is every repo, because
    // everything ships off on purpose - showed the same sixty words nine times and the screen ran
    // to nearly four thousand pixels on the phone it is meant to be read on.
    const armButton = workflow.arm === 'declared' || workflow.arm === 'off'
      ? `<button class="fire" type="button" data-arm="${escapeHtml(workflow.slug)}"
           title="Asks your team to create a real routine for this job">Arm</button>`
      : ''
    // The seven-day list links here. `job-` and not `wf-`, which is already the prefix of this
    // screen's New-workflow form controls (wf-open, wf-form, wf-text) - a job whose slug was
    // "open" would have scrolled the reader to a button instead of to their own job.
    return `<div id="job-${escapeHtml(workflow.slug)}" class="panel card agent-accent ${workflow.state}"${accentStyle(workflow.owner)}>
      <div class="row between">
        <span class="row"><span class="dot"></span><span class="title">${escapeHtml(workflow.name)}</span></span>
        <span class="state">${escapeHtml(STATE_LABEL[workflow.state] ?? workflow.state)}</span>
      </div>
      <div class="steps">${chain || '<span class="muted">no steps</span>'}</div>
      <div class="row" style="margin:.35rem 0">
        ${ownerChipHtml(workflow.owner)}${triggers}
        <span class="chip">${escapeHtml(workflow.runner)}</span>
      </div>
      <div class="row between">
        <span class="small muted">${last}${next}</span>
        <span class="row">${runButton}${armButton}${pauseButton}</span>
      </div>
      ${ownerNote}
      ${armNote}
      ${problems}
    </div>`
  }).join('')
  // Said once, above the list, rather than on each of nine cards.
  const armable = data.workflows.some((workflow) => workflow.arm === 'declared' || workflow.arm === 'off')
  const armingNote = armable
    ? `<p class="small muted">Arming is what makes a schedule real, and it is the point where a job
       starts spending runs. Your team asks for your run cap first and confirms the routine exists
       afterwards; it never arms anything silently.</p>`
    : ''
  el('workflows').innerHTML = screenBannerHtml('workflows') + snapshotBannerHtml(data.routines) + nextSevenDaysHtml(data.workflows) + armingNote + `<div class="stack">${cards}</div>` + routineProblemsHtml(data.routines) + orphanRoutinesHtml(data.routines)

  // A row in the seven-day list scrolls to that job's card. preventDefault is the whole point:
  // this screen routes on the hash, and an unrecognised one sends the reader to Today, so the
  // browser must not be allowed to follow the href. The glide is a movement across the whole
  // screen, so a phone set to reduce motion jumps instead - asked at the tap, so a setting changed
  // since the page loaded is the one that counts.
  el('workflows').querySelectorAll('[data-job]').forEach((row) =>
    row.addEventListener('click', (event) => {
      event.preventDefault()
      const card = document.getElementById(`job-${row.dataset.job}`)
      const still = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
      if (card) card.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' })
    }))
}

/* ---------- Memory ---------- */

let memoryQuery = ''
let memorySource = ''

function memoryTreeHtml() {
  const topOf = (path) => (path.includes('/') ? path.slice(0, path.indexOf('/')) : '(root)')
  const inFolder = (file) => !memorySource || topOf(file.path) === memorySource
  const nameMatches = (file) => !memoryQuery || file.path.toLowerCase().includes(memoryQuery)
  const files = data.memory.files.filter((file) => inFolder(file) && nameMatches(file))
  if (!files.length) {
    // Three different reasons this list can be empty, and each one needs its own sentence. Both
    // false statements below were on this screen, one of them shipped by the commit that fixed the
    // other - which is the reason all three are spelled out here rather than sharing a message.
    //
    // "No pages match." was said for a word that IS written in the vault. This box matches
    // file.path and nothing else, so a client's name or a phrase somebody remembers typing finds
    // nothing, and the page is right there. Its NAME does not contain the word, and nothing on
    // screen said that was the difference.
    //
    // "No page NAME contains X" was then said while a FOLDER BUTTON was selected - a claim about
    // the whole vault, made after looking in one folder. Search "brain" with the agents folder
    // chosen and shared/business-brain.md is excluded by the folder, not by its name. Whatever it
    // is on screen for, this screen must not tell somebody a page of theirs does not exist.
    //
    // Not made true, said: the payload carries the list of pages and their sizes, never their
    // contents, and a page is fetched only when it is opened, so searching inside them would be
    // fifty-odd fetches per keystroke.
    const elsewhere = memoryQuery ? data.memory.files.filter(nameMatches).length : 0
    const notInNames = `<span class="small">This searches page names, not the words written inside
      them &mdash; the board holds the list of your pages and only opens one when you ask for it. If
      you know roughly where it lives, use the folder buttons above instead.</span>`
    if (memoryQuery && memorySource && elsewhere) {
      return `<div class="panel empty"><b>No page name in ${escapeHtml(memorySource)}/ contains
        &ldquo;${escapeHtml(memoryQuery)}&rdquo;.</b>
        <span class="small">${elsewhere} elsewhere in your vault ${elsewhere === 1 ? 'does' : 'do'}
        &mdash; tap <b>all</b> above to see ${elsewhere === 1 ? 'it' : 'them'}.</span></div>`
    }
    if (memoryQuery && memorySource) {
      return `<div class="panel empty"><b>No page name contains
        &ldquo;${escapeHtml(memoryQuery)}&rdquo;, in ${escapeHtml(memorySource)}/ or anywhere
        else.</b> ${notInNames}</div>`
    }
    if (memoryQuery) {
      return `<div class="panel empty"><b>No page NAME contains
        &ldquo;${escapeHtml(memoryQuery)}&rdquo;.</b> ${notInNames}</div>`
    }
    // No branch for "a folder with nothing in it", because there is no such folder. The chips are
    // built from data.memory.files itself, so a chip exists only for a folder that has files in it,
    // and nothing else can set memorySource. A message for that state would be code claiming a
    // screen nobody can reach - and the test I wrote for it could only get there by handing the
    // render a folder no chip would have offered. Review caught that; the invariant is pinned in
    // tests/render.test.mjs instead, where it is a fact about the page rather than a dead sentence.
    return emptyStateHtml('memory', 'No pages match.')
  }
  const folders = new Map()
  for (const file of files) {
    const top = file.path.includes('/') ? file.path.slice(0, file.path.indexOf('/')) : '(root)'
    if (!folders.has(top)) folders.set(top, [])
    folders.get(top).push(file)
  }
  const isIndex = new Set(data.memory.indexes)
  const open = memoryQuery || memorySource ? ' open' : ''
  const sections = [...folders.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([folder, entries]) => {
    const rows = entries.map((file) =>
      `<div class="file" data-path="${escapeHtml(file.path)}" role="button" tabindex="0">
        <span>${escapeHtml(file.path.includes('/') ? file.path.slice(file.path.indexOf('/') + 1) : file.path)}${isIndex.has(file.path) ? ' <span class="idx">INDEX</span>' : ''}</span>
        <span class="small muted">${file.size ? Math.round(file.size / 1024) + ' kb' : ''}</span>
      </div>`
    ).join('')
    return `<details class="folder"${open}><summary><span>${escapeHtml(folder)}/</span><span class="small muted">${entries.length}</span></summary>${rows}</details>`
  }).join('')
  return `<div class="panel">${sections}</div>`
}

// Pages ranked by what is written in them, once the graph has brought what search may use; until then,
// the folder tree filtered by name, as memoryTreeHtml says.
const memoryHitsWanted = () => Boolean(memoryQuery) && memorySearchIndex() !== null && typeof memoryFindNode === 'function'

function memoryDrawTree() {
  const tree = el('memory-tree')
  if (!tree) return
  if (memoryHitsWanted()) readinessReplace(tree, [memoryFindNode()])
  else tree.innerHTML = memoryTreeHtml()
}

function renderMemory() {
  const tops = [...new Set(data.memory.files.map((file) =>
    file.path.includes('/') ? file.path.slice(0, file.path.indexOf('/')) : '(root)'
  ))].sort()
  const chips = ['', ...tops].map((top) =>
    `<span class="chip ${memorySource === top ? 'on' : ''}" data-source="${escapeHtml(top)}">${escapeHtml(top || 'all')}</span>`
  ).join('')
  // The graph's drawing belongs to the markup about to be replaced.
  graphTeardown()
  const asGraph = memoryView === 'graph'
  el('memory').innerHTML = `${screenBannerHtml('memory')}
    <div class="mem-switch" id="memory-switch" role="group" aria-label="Show your memory as">
      <button type="button" class="mem-view" id="memory-view-list" data-view="list" aria-pressed="${!asGraph}">List</button>
      <button type="button" class="mem-view" id="memory-view-graph" data-view="graph" aria-pressed="${asGraph}">Graph</button>
    </div>
    <div id="memory-list"${asGraph ? ' hidden' : ''}>
    <input type="search" id="memory-search" placeholder="${escapeHtml(memorySearchPlaceholder())}" value="${escapeHtml(memoryQuery)}" />
    <p id="memory-meaning" class="small muted mem-meaning" aria-live="polite" hidden></p>
    <div class="filters" id="memory-filters">${chips}</div>
    <div id="memory-tree">${memoryHitsWanted() ? '' : memoryTreeHtml()}</div>
    ${data.memory.truncated ? '<p class="small muted">Showing the first pages only — this vault is very large.</p>' : ''}
    </div>
    <div id="memory-graph" class="mg"${asGraph ? '' : ' hidden'}></div>`

  if (memoryHitsWanted()) memoryDrawTree()
  el('memory-search').addEventListener('input', (event) => {
    memoryQuery = event.target.value.trim().toLowerCase()
    if (typeof memoryFindTyped === 'function') memoryFindTyped()
    memoryDrawTree()
  })
  // Enter asks the board by meaning at once; otherwise it waits for a pause in the typing (memory-find.js).
  el('memory-search').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && typeof memoryFindTyped === 'function') memoryFindTyped(true)
  })
  el('memory-filters').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-source]')
    if (!chip) return
    memorySource = chip.dataset.source === memorySource ? '' : chip.dataset.source
    renderMemory()
    // Drawn again, so drawn where it was: the graph box comes back empty and is filled from here.
    memoryScreenShown(location.hash.slice(1) === 'memory')
  })
  el('memory-switch').addEventListener('click', (event) => {
    const button = event.target.closest('[data-view]')
    if (button) memorySetView(button.dataset.view)
  })
}

async function openFile(path) {
  el('viewer-path').textContent = path
  el('viewer-github').href = blobUrl(path)
  el('viewer-body').textContent = 'Loading…'
  el('viewer').classList.add('open')
  try {
    const result = await apiGet(`/api/file?path=${encodeURIComponent(path)}`)
    el('viewer-body').textContent = result.ok
      ? result.payload.content
      : (result.payload.error || 'Could not load this file.')
  } catch (error) {
    el('viewer-body').textContent = 'Could not load this file.'
  }
}

/* ---------- Memory graph: begin ----------
   Memory, Graph: every note a dot, and every reason two notes belong together a line. The lines come
   from the server with their reason (api/_team-graph.js for the team repo, api/_vaults.js for a vault
   a computer shared); nothing here invents one, so a repo whose notes do not point at each other is
   lonely dots, and the screen says what that means.

   None of it is on the first page. The graph is asked of /api/graph the first time Memory opens -
   reading every note costs a GitHub call each, so never with the board - and a drawing library only
   the first time Graph does: 3d-force-graph on a computer, the flat force-graph on a phone, both this
   site's own copies in public/vendor/. Everything a person reads is set as text: a title is whatever
   somebody called a note. The canvas is a picture, hidden from screen readers; the list under it holds
   every dot and its lines, and is the way in for a keyboard. */

const MEMORY_VIEW_STORE = 'agent-cockpit-memory-view'
const GRAPH_MODE_STORE = 'agent-cockpit-graph-mode'
const GRAPH_LIBRARIES = {
  '3d': { src: '/vendor/3d-force-graph-1.80.0.min.js', global: 'ForceGraph3D' },
  flat: { src: '/vendor/force-graph-1.51.4.min.js', global: 'ForceGraph' }
}
// The graph's drawing code: its own file, so no visit pays for it until somebody opens Graph. Memory's
// search is one too, asked for when Memory first opens.
const GRAPH_VIEW_SRC = '/memory-graph.js'
const MEMORY_FIND_SRC = '/memory-find.js'
// Coming back to Memory within a minute asks nothing; after that, one "has anything changed?" call.
const GRAPH_RECHECK_MS = 60_000

let memoryView = readStore(MEMORY_VIEW_STORE) === 'graph' ? 'graph' : 'list'

const graphState = {
  data: null, loading: false, fetching: null, error: null, retryAt: 0, checkedAt: 0, boardCommit: null,
  source: 'team', hiddenKinds: new Set(), lonelyOnly: false, mode: null, note: null, selected: null, find: '',
  refs: null, instance: null, drawn: null, drawing: null, paused: false, modelFor: null, items: new Map(), webgl: null
}

// The seams a test hands its stand-ins through: the view and library loaders, what this device can do,
// and the colours, which live in the stylesheet's tokens like every other colour on the board.
// webgl and colours are the view file's (memory-graph.js), and are only ever called once it is here.
const graphDeps = {
  view: () => graphLoadScript(GRAPH_VIEW_SRC, () => typeof graphShell === 'function'),
  find: () => graphLoadScript(MEMORY_FIND_SRC, () => typeof memoryFindNode === 'function'),
  load: (mode) => graphLoadLibrary(mode),
  webgl: () => graphHasWebgl(),
  motion: () => ({
    finePointer: Boolean(window.matchMedia?.('(pointer: fine)')?.matches),
    reducedMotion: Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches),
    deviceMemory: typeof navigator === 'undefined' ? undefined : navigator.deviceMemory
  }),
  colours: () => graphColours(),
  pixelRatio: () => Math.min(window.devicePixelRatio || 1, 1.5)
}

const graphLoading = {}

// One of this site's own scripts, by one script element, added once: a second ask waits for the first.
// `ready` says whether it has arrived, and is what the promise gives. A load that failed is forgotten,
// so the next open tries again.
function graphLoadScript(src, ready) {
  if (ready()) return Promise.resolve(ready())
  graphLoading[src] ??= new Promise((resolve, reject) => {
    const tag = document.createElement('script')
    tag.src = src
    tag.async = true
    tag.addEventListener('load', () => (ready() ? resolve(ready()) : reject(new Error('not there'))))
    tag.addEventListener('error', () => {
      delete graphLoading[src]
      reject(new Error('not loaded'))
    })
    ;(document.head ?? document.body).appendChild(tag)
  })
  return graphLoading[src]
}

function graphLoadLibrary(mode) {
  const library = GRAPH_LIBRARIES[mode]
  return graphLoadScript(library.src, () => window[library.global])
}

/* --- asking the board ------------------------------------------------------------------------------ */

function graphFetch() {
  if (graphState.loading) return graphState.fetching
  graphState.fetching = graphFetchNow()
  return graphState.fetching
}

async function graphFetchNow() {
  const now = Date.now()
  if (now < graphState.retryAt) return
  const boardCommit = data?.commit ?? null
  if (graphState.data && graphState.boardCommit === boardCommit && now - graphState.checkedAt < GRAPH_RECHECK_MS) return
  graphState.loading = true
  graphState.checkedAt = now
  graphState.boardCommit = boardCommit
  const since = graphState.data?.commit
  try {
    const result = await apiGet(since ? `/api/graph?since=${encodeURIComponent(since)}` : '/api/graph')
    if (result.ok && result.payload?.unchanged === true) {
      graphState.error = null
    } else if (result.ok && result.payload?.team) {
      graphState.data = result.payload
      graphState.error = null
    } else {
      // GitHub's rate limit: nothing is asked again until the time it gave has passed.
      if (result.retryAfter !== null && (result.status === 429 || result.status === 403)) graphState.retryAt = Date.now() + result.retryAfter * 1000
      else graphState.checkedAt = 0
      graphState.error = result.redirected
        ? (LOCAL_BOARD ? 'The board was closed. Double-click Start Board to open it again.' : 'Your sign-in to Vercel ran out on this device. Reload the board to sign in again.')
        : typeof result.payload?.error === 'string' ? result.payload.error : `The graph could not be read: the board answered ${result.status}.`
    }
  } catch (error) {
    graphState.checkedAt = 0
    graphState.error = 'The graph could not be read: the connection dropped. Leave Memory and come back to try again.'
  } finally {
    graphState.loading = false
  }
  if (location.hash.slice(1) === 'memory') memoryRefreshSearch()
  // The view may still be on its way; when it lands, graphMount draws from what is here by then.
  if (memoryView === 'graph' && location.hash.slice(1) === 'memory' && typeof graphRender === 'function') graphRender()
}

// Called whenever the screen changes: Memory asks for the graph (the list's search uses it too), and
// anything else pauses the drawing.
function memoryScreenShown(showing) {
  if (!showing) {
    graphPause()
    return
  }
  graphFetch()
  memoryFindOpen()
  if (memoryView === 'graph') graphMount()
}

function memorySetView(view) {
  memoryView = view === 'graph' ? 'graph' : 'list'
  writeStore(MEMORY_VIEW_STORE, memoryView)
  const list = el('memory-list')
  const graph = el('memory-graph')
  if (list) list.hidden = memoryView === 'graph'
  if (graph) graph.hidden = memoryView !== 'graph'
  el('memory-view-list')?.setAttribute('aria-pressed', String(memoryView === 'list'))
  el('memory-view-graph')?.setAttribute('aria-pressed', String(memoryView === 'graph'))
  if (memoryView === 'graph') graphMount()
  else graphPause()
}

/* --- the screen ------------------------------------------------------------------------------------ */

// The drawing code is fetched the first time (memory-graph.js), then the screen is built and drawn -
// unless the person has moved on while it came.
async function graphMount() {
  const container = el('memory-graph')
  if (!container) return
  try {
    await graphDeps.view()
  } catch (error) {
    container.textContent = 'The graph could not be shown: part of the page did not load. Reload the board to try again; the list still works.'
    return
  }
  if (memoryView !== 'graph' || el('memory-graph') !== container) return
  graphShell(container)
  graphRender()
}

/* --- pausing and letting go ------------------------------------------------------------------------ */

function graphPause() {
  if (!graphState.instance || graphState.paused) return
  graphState.instance.pauseAnimation()
  graphState.paused = true
}

function graphResume() {
  if (!graphState.instance || !graphState.paused) return
  if (memoryView !== 'graph' || location.hash.slice(1) !== 'memory' || document.visibilityState === 'hidden') return
  graphState.instance.resumeAnimation()
  graphState.paused = false
}

function graphTeardownInstance() {
  const instance = graphState.instance
  graphState.instance = null
  graphState.drawn = null
  graphState.paused = false
  if (!instance) return
  try {
    instance.pauseAnimation()
    instance._destructor?.()
  } catch (error) {
    // Already gone with its canvas.
  }
}

// The screen's markup is about to be drawn again: the drawing and its references go with it.
function graphTeardown() {
  graphTeardownInstance()
  graphState.drawing = null
  graphState.refs = null
}

document.addEventListener('visibilitychange', () => (document.visibilityState === 'hidden' ? graphPause() : graphResume()))

/* --- searching inside pages, on Memory's List --------------------------------------------------------
   The graph brings, for each team note, what search may use: its headings, description, tags and
   opening words (api/_team-graph.js). Once it is here the List's box ranks pages by those as well as by
   name. The ranking is the page's own arithmetic over what is already loaded - typing never asks the
   board for anything. Until the graph is here, the box searches names and says so (memoryTreeHtml). */

// path -> what search may use for that note, or null until the graph is here.
function memorySearchIndex() {
  const team = graphState.data?.team
  if (!team || !Array.isArray(team.notes) || !Array.isArray(team.search)) return null
  const index = new Map()
  team.notes.forEach((note, position) => index.set(note.path, team.search[position] ?? {}))
  return index
}

function memorySearchPlaceholder() {
  return memorySearchIndex()
    ? `Search ${data.memory.files.length} pages: names, headings, descriptions and opening words…`
    : `Search ${data.memory.files.length} page names…`
}

// Memory's search, fetched the first time Memory opens; then the board may learn the notes by meaning.
async function memoryFindOpen() {
  try {
    await graphDeps.find()
  } catch (error) {
    return
  }
  if (location.hash.slice(1) !== 'memory') return
  memoryRefreshSearch()
  memoryFindLearn()
}

// The voice assistant's "find my note": Memory's search file, then the one search, shown on Memory.
async function memoryVoiceFind(query) {
  try {
    await graphDeps.find()
  } catch (error) {
    return null
  }
  return memoryFindForVoice(query)
}

// The graph arrived while Memory was open: the box says what it now searches, and searches it.
function memoryRefreshSearch() {
  const box = el('memory-search')
  if (box) box.placeholder = memorySearchPlaceholder()
  memoryDrawTree()
}
/* ---------- Memory graph: end ---------- */

document.addEventListener('click', (event) => {
  const file = event.target.closest('.file[data-path]')
  if (file) openFile(file.dataset.path)
  const arm = event.target.closest('button[data-arm]')
  if (arm) {
    armWorkflow(arm)
    return
  }
  const approve = event.target.closest('button[data-approve]')
  if (approve) {
    approveProposal(approve)
    return
  }
  const reload = event.target.closest('a[data-reload]')
  if (reload) {
    event.preventDefault()
    location.reload()
    return
  }
  const move = event.target.closest('button[data-move]')
  if (move && !move.disabled) {
    moveTask(move)
    return
  }
  const fire = event.target.closest('button[data-fire]')
  if (fire && !fire.disabled) fireWorkflow(fire)
  if (event.target.closest('#task-open')) {
    const form = el('task-form')
    form.hidden = !form.hidden
    if (!form.hidden) {
      el('wf-form').hidden = true
      el('task-text').focus()
    }
  }
  if (event.target.closest('#wf-open')) {
    const form = el('wf-form')
    form.hidden = !form.hidden
    if (!form.hidden) {
      el('task-form').hidden = true
      el('wf-text').focus()
    }
  }
})
// The Add-task form is re-rendered with the board, so its submit is delegated too.
document.addEventListener('submit', (event) => {
  if (event.target.id === 'task-form') {
    event.preventDefault()
    submitTask()
  }
  if (event.target.id === 'wf-form') {
    event.preventDefault()
    submitWorkflowRequest()
  }
})
el('viewer-close').addEventListener('click', () => el('viewer').classList.remove('open'))

/* ---------- Fire ---------- */

// --- signing in ------------------------------------------------------------------
// Every endpoint refuses to answer anybody it does not recognise, so the dashboard's own URL is
// the thing being protected rather than the domain it sits on. A device is recognised by the
// cookie the sign-in form leaves (api/login.js): the browser sends it with every request this page
// makes, because they are all on the board's own site, and no script here can read it (HttpOnly).
// So the page holds no key and sends none.
//
// The view key a device used to keep in localStorage is read only to move that device over to the
// cookie (moveSavedKey, at boot), then deleted.
const VIEW_KEY_STORE = 'agent-cockpit-view-key'

// The board on a student's own computer: its server adds a small script (local/page/local-mode.js) that
// sets this before the page runs. The website never has it, so none of the local wording below is ever
// used there.
const LOCAL_BOARD = window.__BOARD_LOCAL__ === true
// Voice that runs on this computer (Settings -> Voice engine -> Local). Set by the local server's own script
// before this one; the website never has it, so every branch on it is inert there.
const localVoiceOn = () => window.__BOARD_LOCAL_VOICE__?.engine === 'local'

// redirect: 'manual', because with Vercel Authentication on, a Vercel sign-in that has run out
// answers with a redirect to vercel.com. Followed, that is a failed fetch - the same as a dropped
// connection, which is retried. Not followed, it can be told apart, and the page says to reload.
async function apiGet(path) {
  const response = await fetch(path, { redirect: 'manual' })
  if (response.type === 'opaqueredirect') return { status: 0, ok: false, redirected: true, payload: {}, retryAfter: null }
  let payload = {}
  try { payload = await response.json() } catch (error) { /* non-JSON error page */ }
  return { status: response.status, ok: response.ok, payload, retryAfter: retryAfterSeconds(response) }
}

// Retry-After as whole seconds: a number of seconds, or an HTTP date counted from now. null for
// anything else - a missing header, words, a negative number - which is no instruction at all.
function retryAfterSeconds(response) {
  const raw = response.headers?.get?.('retry-after')
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (/^\d+$/.test(text)) return Number(text)
  if (!/[A-Za-z]{3}/.test(text)) return null
  const at = Date.parse(text)
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : null
}

// The fire key never ships in this page's source. First tap asks the endpoint; a 401 means
// this deployment wants the key (FIRE_KEY), so we prompt once and keep it in sessionStorage
// for this tab only. Deployments with PUBLIC_FIRE=true never prompt at all.
const FIRE_KEY_STORE = 'agent-cockpit-fire-key'

/* ---------- the Mac mailbox: orders the board queued for the owner's computer ----------
   On a mailbox board (FIRE_MODE=mailbox) fire answers { via: 'mac', orderId, expiresAt, pollSeconds }:
   the order waits in the board's queue until the owner's Mac collects it. A button's note says so, and
   when to expect it - never "started", never a session link - and the device remembers the order, so
   Today can follow it through the Mac's status file (data.mailbox) each time the board loads. The words
   for what the Mac did are the voice's own (macOrderSaid, in the shared block). */
const MAC_ORDERS_STORE = 'agent-cockpit-mac-orders'
const MAC_ORDERS_KEPT = 10
const MAC_KINDS = ['run', 'pause', 'task', 'move', 'approve', 'arm', 'skill', 'agent']

// The note for a button whose order went to the Mac, or null when the answer is not the board's own
// Mac answer - then the button says what it always said.
function macSentWords(kind, payload) {
  if (!macLogFields(payload).id) return null
  const minutes = macMinutesOf(payload.pollSeconds)
  if (kind === 'run') return `Sent to your Mac. It should start within about ${macWithin(minutes)}.`
  if (kind === 'pause') return `Sent to your Mac. It switches the schedule off in the workflow file within about ${macWithin(minutes)}.`
  if (kind === 'task') return `Sent to your Mac. It checks ${macEvery(minutes)}, so the card should be on the board in about ${minutes + 1} minutes.`
  if (kind === 'move') return `Sent to your Mac. It lands in about ${minutes + 1} minutes.`
  if (kind === 'approve') return 'Sent to your Mac. Nothing has been switched on.'
  // Arm, a new skill, a new agent: the Mac files a card for the owner to finish in a session (D3).
  return 'Sent to your Mac. It will file a card for you to finish in a Claude session.'
}

// The orders this device sent to the Mac, newest first: only entries in the board's own shape.
function macOrdersLog() {
  let parsed = null
  try { parsed = JSON.parse(readStore(MAC_ORDERS_STORE) ?? 'null') } catch (error) { parsed = null }
  return (Array.isArray(parsed) ? parsed : [])
    .filter((entry) => isRecord(entry) && MAC_KINDS.includes(entry.kind) && typeof entry.label === 'string' && entry.label.length <= 200 &&
      typeof entry.sentAt === 'string' && !Number.isNaN(Date.parse(entry.sentAt)))
    .map((entry) => ({ kind: entry.kind, label: entry.label, sentAt: entry.sentAt, ...macLogFields({ via: entry.via, orderId: entry.id, expiresAt: entry.expiresAt, pollSeconds: entry.pollSeconds }) }))
    .filter((entry) => entry.id)
    .slice(0, MAC_ORDERS_KEPT)
}

// Says the Mac's words on a button's note and remembers the order. False when it was not a Mac answer.
function macNote(note, kind, label, payload) {
  const words = macSentWords(kind, payload)
  if (!words) return false
  note.textContent = words
  const entry = { kind, label: String(label).slice(0, 200), sentAt: new Date().toISOString(), ...macLogFields(payload) }
  writeStore(MAC_ORDERS_STORE, JSON.stringify([entry, ...macOrdersLog().filter((one) => one.id !== entry.id)].slice(0, MAC_ORDERS_KEPT)))
  return true
}

// Today's "Your Mac" panel: each remembered order, and what the Mac's status file says of it.
function macOrdersHtml() {
  const orders = macOrdersLog()
  if (!orders.length) return ''
  let zone = 'UTC'
  try { zone = voiceZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? 'UTC' } catch (error) { zone = 'UTC' }
  const rows = orders.map((order) => {
    const said = macOrderSaid(order, data, Date.now(), zone)
    if (!said) return ''
    const words = said.state === 'sent to your Mac' ? `Sent to your Mac. It checks ${macEvery(macMinutesOf(order.pollSeconds))}.` : said.said
    return `<div class="gap"><b>${escapeHtml(order.label)}</b> <span class="small">${escapeHtml(words)}</span></div>`
  }).join('')
  return rows ? sectionHead('Orders sent to your computer', '<h2>Your Mac</h2>') + `<div class="panel">${rows}</div>` : ''
}

function fireNoteFor(button) {
  let note = button.parentElement.querySelector('.fire-note')
  if (!note) {
    note = document.createElement('span')
    note.className = 'fire-note'
    button.parentElement.appendChild(note)
  }
  return note
}

async function callFire(body, key) {
  // Fire checks the viewer first, like every other endpoint: the signed-in cookie goes with this
  // by itself. The fire key, when the board has one, is the only key the page ever sends.
  const headers = { 'Content-Type': 'application/json' }
  if (key) headers['x-fire-key'] = key
  const response = await fetch('/api/fire', {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  })
  let payload = {}
  try { payload = await response.json() } catch (error) { /* non-JSON error page */ }
  return { status: response.status, ok: response.ok, payload }
}

// One client path for every dispatch — Run, Pause, and Add task all go through here, so
// the prompt-once key handling exists exactly once. A 401 is a reason to ask for the fire key only
// when the answer says that is what is missing: the viewer is checked first, and a signed-out
// person asked for the fire key would be asked for the wrong thing.
const needsFireKey = (result) => result.status === 401 && result.payload?.needs === 'fire-key'

// `ask: false` never prompts: an order sent by the owner's spoken yes has no hands free to type a key,
// so it is only spoken when the key is already in this tab (or the board needs none).
async function postFire(body, { ask = true } = {}) {
  let key = sessionStorage.getItem(FIRE_KEY_STORE) || ''
  let result = await callFire(body, key)
  if (needsFireKey(result) && ask) {
    const entered = window.prompt(
      LOCAL_BOARD
        ? 'This board needs its fire key to start jobs.\n\nPaste the fire key from your board settings. It is kept in this tab only, never in the page.'
        : 'This dashboard needs its fire key to dispatch jobs.\n\nPaste the FIRE_KEY you set in the hosting environment — it is kept in this tab only, never in the page.'
    )
    if (entered !== null && entered.trim()) {
      key = entered.trim()
      sessionStorage.setItem(FIRE_KEY_STORE, key)
      result = await callFire(body, key)
    }
  }
  if (needsFireKey(result)) sessionStorage.removeItem(FIRE_KEY_STORE)
  return result
}

/* Arming creates a real routine, which spends runs on a schedule forever. The dashboard only
   dispatches: an agent session runs the /arm skill, which refuses to proceed until the owner has
   said their run cap out loud, arms one job, and confirms it exists afterwards. */
async function armWorkflow(button) {
  const slug = button.dataset.arm
  const note = fireNoteFor(button)
  const original = button.innerHTML
  button.disabled = true
  button.innerHTML = 'Sending&hellip;'
  note.className = 'fire-note'
  note.textContent = ''
  try {
    const result = await postFire({ workflow: slug, action: 'arm' })
    if (result.ok) {
      note.className = 'fire-note ok'
      if (!macNote(note, 'arm', `Arm ${slug}`, result.payload)) note.textContent = 'Sent. It will ask for your run cap before it arms anything.'
    } else {
      note.className = 'fire-note bad'
      note.textContent = result.payload.error || `Dispatch failed (${result.status}).`
    }
  } catch (error) {
    note.className = 'fire-note bad'
    note.textContent = 'Could not reach the dashboard.'
  } finally {
    button.disabled = false
    button.innerHTML = original
  }
}

/* Approving records that the owner said yes to a line they read. It builds nothing and arms
   nothing - that is a separate action, deliberately. */
async function approveProposal(button) {
  const task = button.dataset.approve
  const note = fireNoteFor(button)
  const original = button.innerHTML
  button.disabled = true
  button.innerHTML = 'Recording&hellip;'
  note.className = 'fire-note'
  note.textContent = ''
  try {
    const result = await postFire({ action: 'approve', task })
    if (result.ok) {
      note.className = 'fire-note ok'
      if (!macNote(note, 'approve', `Approve: ${task}`, result.payload)) note.textContent = 'Approved. Nothing has been switched on.'
    } else {
      note.className = 'fire-note bad'
      note.textContent = result.payload.error || `Dispatch failed (${result.status}).`
    }
  } catch (error) {
    note.className = 'fire-note bad'
    note.textContent = 'Could not reach the dashboard.'
  } finally {
    button.disabled = false
    button.innerHTML = original
  }
}

// The run's own claude.ai session, as the routines API names it. The server checks this too
// (SESSION_URL in api/fire.js, KEEP IN SYNC); the page checks again because it becomes a link.
const SESSION_LINK = /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]{1,100}$/

async function fireWorkflow(button) {
  const slug = button.dataset.fire
  const action = button.dataset.action === 'pause' ? 'pause' : 'run'
  const note = fireNoteFor(button)
  const original = button.innerHTML
  button.disabled = true
  button.innerHTML = action === 'pause' ? 'Pausing&hellip;' : 'Starting&hellip;'
  note.className = 'fire-note'
  note.textContent = ''
  try {
    const result = await postFire({ workflow: slug, action })
    if (result.ok) {
      note.className = 'fire-note ok'
      if (macNote(note, action, `${action === 'pause' ? 'Pause' : 'Run'} ${slug}`, result.payload)) {
        // Sent to the owner's Mac: the note says so (macNote).
      } else if (SESSION_LINK.test(String(result.payload.sessionUrl ?? ''))) {
        note.innerHTML = `Sent &middot; <a href="${escapeHtml(result.payload.sessionUrl)}" rel="noreferrer noopener">watch it run</a>`
      } else {
        note.textContent = action === 'pause' ? 'Pause sent to the agent.' : 'Job sent.'
      }
    } else {
      note.className = 'fire-note bad'
      note.textContent = result.payload.error || `Dispatch failed (${result.status}).`
    }
  } catch (error) {
    note.className = 'fire-note bad'
    note.textContent = 'Could not reach the fire endpoint.'
  }
  button.disabled = false
  button.innerHTML = original
}

/* ---------- Add task ---------- */

// KEEP IN SYNC: splitTaskText is mirrored verbatim as an export in api/_lib.js, where the
// test suite exercises it (this page has no module loading). Change it here, change it
// there. First line → title (clipped to the endpoint's 200-char cap); anything beyond the
// title rides as details.
function splitTaskText(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return null
  const title = trimmed.split(/\r?\n/)[0].trim().slice(0, 200).trim()
  return trimmed === title ? { title } : { title, details: trimmed.slice(0, 2000) }
}

/* Start and Done on a task card.

   The card does NOT move, and does not claim to. This page loads its data once and never polls,
   so nothing here can watch the file change - and the change itself is a Claude session editing
   the card and committing, which takes about a minute. A card that slid into another column on
   tap would be showing a state that does not exist yet, on the one board whose whole job is
   saying true things about a repo.

   So: the buttons disable, the card says what was asked and that it lands in about a minute, and
   it offers the reload that would show it. The wording is the Add-task form's, because it is the
   same promise. */
async function moveTask(button) {
  const card = button.closest('[data-card]')
  const note = card ? card.querySelector('.move-note') : null
  const buttons = card ? [...card.querySelectorAll('button[data-move]')] : [button]
  const asked = button.dataset.status === 'done' ? 'done' : 'started'

  for (const other of buttons) other.disabled = true
  if (note) {
    note.hidden = false
    note.className = 'move-note small muted'
    note.textContent = 'Sending…'
  }

  try {
    const result = await postFire({ action: 'move', task: button.dataset.move, status: button.dataset.status })
    if (result.ok) {
      if (note) {
        note.className = 'move-note small ok'
        // Says what was ASKED, not what is true. The card is still whatever the repo says it is
        // until the session commits, and this board does not get to guess in between.
        if (!macNote(note, 'move', `Move ${button.dataset.move} to ${button.dataset.status}`, result.payload)) {
          note.innerHTML = `Asked your team to mark this ${asked} — it lands in about a minute. <a href="#" data-reload="1">Refresh</a>`
        }
      }
      card?.classList.add('pending')
    } else {
      for (const other of buttons) other.disabled = false
      if (note) {
        note.className = 'move-note small bad'
        note.textContent = result.payload.error || `Could not send it (${result.status}).`
      }
    }
  } catch {
    for (const other of buttons) other.disabled = false
    if (note) {
      note.className = 'move-note small bad'
      note.textContent = 'Could not reach the fire endpoint.'
    }
  }
}

async function submitTask() {
  const note = el('task-note')
  const send = el('task-send')
  note.className = 'fire-note'
  note.textContent = ''
  const parts = splitTaskText(el('task-text').value)
  if (!parts) {
    note.className = 'fire-note bad'
    note.textContent = 'Say what you want done first.'
    return
  }
  const body = { action: 'task', title: parts.title }
  if (parts.details) body.details = parts.details
  const agent = el('task-for').value
  if (agent) body.for = agent
  send.disabled = true
  send.textContent = 'Sending…'
  try {
    const result = await postFire(body)
    if (result.ok) {
      note.className = 'fire-note ok'
      if (!macNote(note, 'task', `Task: ${parts.title}`, result.payload)) note.textContent = 'Card sent — it appears once your team commits it (about a minute).'
      el('task-text').value = ''
      el('task-for').value = ''
    } else {
      note.className = 'fire-note bad'
      note.textContent = result.payload.error || `Dispatch failed (${result.status}).`
    }
  } catch (error) {
    note.className = 'fire-note bad'
    note.textContent = 'Could not reach the fire endpoint.'
  }
  send.disabled = false
  send.textContent = 'Add'
}

// A new workflow is a repo change, and this page never writes the repo. So the request
// becomes a task card for the orchestrator, which runs /new-workflow in a session, asks
// whatever it still needs, and commits the file. Same one-way street as everything else.
async function submitWorkflowRequest() {
  const note = el('wf-note')
  const send = el('wf-send')
  note.className = 'fire-note'
  note.textContent = ''
  const asked = String(el('wf-text').value ?? '').trim()
  if (!asked) {
    note.className = 'fire-note bad'
    note.textContent = 'Say what the job does and when it should run.'
    return
  }
  send.disabled = true
  send.textContent = 'Sending…'
  try {
    const result = await postFire({
      action: 'task',
      title: `New workflow: ${splitTaskText(asked).title.slice(0, 180)}`,
      details: `Run /new-workflow for this job. Asked for: ${asked.slice(0, 1800)}`,
      for: 'orchestrator'
    })
    if (result.ok) {
      note.className = 'fire-note ok'
      if (!macNote(note, 'task', `New workflow: ${splitTaskText(asked).title.slice(0, 180)}`, result.payload)) {
        note.textContent = 'Requested — your team picks it up on the next sweep and will ask if it needs more.'
      }
      el('wf-text').value = ''
    } else {
      note.className = 'fire-note bad'
      note.textContent = result.payload.error || `Dispatch failed (${result.status}).`
    }
  } catch (error) {
    note.className = 'fire-note bad'
    note.textContent = 'Could not reach the fire endpoint.'
  }
  send.disabled = false
  send.textContent = 'Request it'
}

/* ---------- Connections ---------- */

/* The wall: what each computer found - its tools, Claude Code's servers, Codex's servers and
   plugins - from the files the collector commits (api/state.js shapeFound). Every state is said in
   the contract's own words, so colour only ever repeats what a word already says. "Needs sign-in"
   stays grey (decision D9): some servers are signed out on purpose, and an alarm for each would
   teach the owner to ignore the colour. Only Failed is amber, and nothing here is red.

   A phone gets one computer open and the rest folded, because three computers' worth of servers is
   a scroll nobody finishes. Server names are whatever somebody typed into a config file; the server
   has checked them, and every one is escaped here all the same. */
const FOUND_SCOPE_ORDER = [
  ['user', 'Your servers'], ['plugin', 'Plugin servers'], ['claude.ai', 'claude.ai connectors'], ['other', 'Other']
]
const FOUND_CHIP = { connected: 'chip ok', failed: 'chip warn', 'waiting for approval': 'chip on' }
// A sentence read out of a file ends with its full stop, wherever it came from.
const sentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`)

/* ---------- Tool tiles ----------
   A tile beside every tool the board names. Our own letter tile for every brand - a soft wash of
   the brand's colour and the first letter of the name - because a colour is not a logo. A real mark
   only where the brand's own rules let a site show that it uses the product, and Nuno approved it
   (2026-10-10): GitHub and Vercel, Simple Icons 16.32.0 drawings (CC0), unmodified, in the one plain
   colour each allows (--mark-mono). Each brand's rule, with the page it was read from, is in
   docs/logo-rules.md. Colours are Simple Icons 16.32.0's own data; a brand it does not have takes
   one of the board's hues. Hermes is ours on purpose: Simple Icons' "Hermes" is another company. */
const BRANDS = [
  { key: 'github', hex: '#181717', mark: true, names: ['github', 'github cli', 'gh'] },
  { key: 'vercel', hex: '#000000', mark: true, names: ['vercel'] },
  { key: 'claude', hex: '#D97757', names: ['claude', 'claude code', 'claude app', 'anthropic'] },
  { key: 'codex', tone: 'kpi-agents', names: ['codex'] },
  { key: 'hermes', tone: 'link', names: ['hermes', 'hermes agent'] },
  { key: 'openai', tone: 'muted', names: ['openai', 'chatgpt', 'chatgpt app'] },
  { key: 'gmail', hex: '#EA4335', names: ['gmail'] },
  { key: 'googlecalendar', hex: '#4285F4', names: ['google calendar'] },
  { key: 'googledrive', hex: '#4285F4', names: ['google drive'] },
  { key: 'google', hex: '#4285F4', names: ['google', 'google docs', 'google sheets'] },
  { key: 'nodejs', hex: '#5FA04E', names: ['node.js', 'nodejs', 'node'] },
  { key: 'git', hex: '#F03C2E', names: ['git'] },
  { key: 'tailscale', hex: '#242424', names: ['tailscale'] },
  { key: 'n8n', hex: '#EA4B71', names: ['n8n'] },
  { key: 'elevenlabs', hex: '#000000', names: ['elevenlabs', 'eleven labs'] },
  { key: 'fishaudio', hex: '#9B90E8', names: ['fish audio', 'fish'] },
  { key: 'notion', hex: '#000000', names: ['notion'] },
  { key: 'supabase', hex: '#3FCF8E', names: ['supabase'] },
  { key: 'openrouter', hex: '#94A3B8', names: ['openrouter'] },
  { key: 'perplexity', hex: '#1FB8CD', names: ['perplexity', 'perplexity-ask'] },
  { key: 'figma', hex: '#F24E1E', names: ['figma'] },
  { key: 'clickup', hex: '#7B68EE', names: ['clickup'] },
  { key: 'fathom', hex: '#9187FF', names: ['fathom'] },
  { key: 'obsidian', hex: '#7C3AED', names: ['obsidian'] },
  { key: 'davinciresolve', hex: '#233A51', names: ['davinci resolve', 'davinci-resolve'] },
  { key: 'similarweb', hex: '#092540', names: ['similarweb'] },
  { key: 'stripe', hex: '#635BFF', names: ['stripe'] },
  { key: 'cloudflare', hex: '#F38020', names: ['cloudflare'] },
  { key: 'youtube', hex: '#FF0000', names: ['youtube'] },
  { key: 'substack', hex: '#FF6719', names: ['substack'] },
  { key: 'telegram', hex: '#26A5E4', names: ['telegram'] },
  { key: 'discord', hex: '#5865F2', names: ['discord'] },
  { key: 'zapier', hex: '#FF4F00', names: ['zapier'] },
  { key: 'docker', hex: '#2496ED', names: ['docker'] },
  { key: 'linear', hex: '#5E6AD2', names: ['linear'] },
  { key: 'airtable', hex: '#18BFFF', names: ['airtable'] },
  { key: 'calendly', hex: '#006BFF', names: ['calendly'] },
  { key: 'zoom', hex: '#0B5CFF', names: ['zoom'] }
]

// The words under the tiles on the Connections wall, and in the README.
const LOGO_CREDITS = 'Product names and logos belong to their owners. They appear only to name the tools your own computer reports, and no endorsement is implied. Logo drawings from Simple Icons (CC0). Vercel, the Vercel design, Next.js and related marks, designs and logos are trademarks or registered trademarks of Vercel, Inc. or its affiliates in the US and other countries.'

// A name as the wall writes it, down to the brand's part: "claude.ai Gmail" is Gmail,
// "plugin:marketing:notion" is Notion, "n8n-mcp" is n8n. The longest name that matches wins, and a
// name matches only whole or followed by a space, so "Claude Max" is Claude and "github-x" is not.
const brandWords = (name) => String(name ?? '').toLowerCase()
  .replace(/^claude\.ai\s+/, '').split(':').at(-1)
  .replace(/[\s_-]+(mcp(\s+server)?|server)$/, '').trim()
function brandOf(name) {
  const words = brandWords(name)
  if (!words) return null
  let best = null
  for (const brand of BRANDS) {
    for (const alias of brand.names) {
      if ((words === alias || words.startsWith(`${alias} `)) && (!best || alias.length > best.alias.length)) best = { brand, alias }
    }
  }
  return best?.brand ?? null
}

// The tile itself: decoration (aria-hidden); the name is always in words beside it. A mark keeps its
// letter underneath, which is what shows where a browser cannot draw masks.
function brandTileHtml(name, extraClass = '') {
  const brand = brandOf(name)
  const letter = escapeHtml(foundLetter(name))
  const classes = ['tile', extraClass, brand?.mark ? 'has-mark' : ''].filter(Boolean).join(' ')
  const colour = brand?.hex ?? (brand?.tone ? `var(--${brand.tone})` : null)
  const style = colour ? ` style="--tile:${escapeHtml(colour)}"` : ''
  const inner = brand?.mark ? `<span class="tile-letter">${letter}</span><span class="tile-mark mark-${brand.key}"></span>` : letter
  return `<span class="${classes}" aria-hidden="true"${style}>${inner}</span>`
}

// The letter on a server's tile: its own name's first letter or number, after the parts every
// plugin server or claude.ai connector shares - so three plugin servers are not three Ps.
function foundLetter(name) {
  const bare = String(name ?? '').replace(/^claude\.ai\s+/i, '').split(':').at(-1)
  return (/[\p{L}\p{N}]/u.exec(bare)?.[0] ?? '·').toUpperCase()
}

function foundItemHtml(entry, { meta = '', label, chip = 'chip' }) {
  return `<li class="found-item">${brandTileHtml(entry.name, 'found-tile')}
    <span class="found-name"><span class="found-title">${breakable(entry.name)}</span>${meta ? `<span class="found-meta">${meta}</span>` : ''}</span>
    <span class="found-chips"><span class="${chip}">${escapeHtml(label)}</span>${entry.proved === true ? '<span class="chip ok">Proved</span>' : ''}</span></li>`
}

// A plugin server's name is one long word to a browser. A break offered after each colon lets
// `plugin:marketing:supermetrics` wrap at its own parts instead of mid-word.
const breakable = (name) => escapeHtml(name).replace(/:/g, ':<wbr>')

const foundListHtml = (items) => `<ul class="found-list">${items.join('')}</ul>`

function foundGroupHtml(name, count, body, open) {
  return `<details class="found-group"${open ? ' open' : ''}><summary><span class="found-group-name">${name}</span>
    <span class="found-count">${count}</span></summary>${body}</details>`
}

// A block that found nothing: not found, or there and unreadable, with the collector's reason.
function foundMissingHtml(block, notFound, unreadable) {
  if (block?.status === 'not found') return `<p class="found-missing">${notFound}</p>`
  const why = block?.why ? `: ${escapeHtml(sentence(block.why))}` : '.'
  return `<p class="found-missing">${unreadable}${why}</p>`
}

function foundClaudeHtml(claude, open) {
  if (claude?.status !== 'found') {
    return foundGroupHtml('Claude Code', claude?.status === 'not found' ? 'Not found' : 'Could not be read',
      foundMissingHtml(claude, 'Claude Code was not found on this computer.', 'Claude Code&rsquo;s servers could not be read'), open)
  }
  const servers = claude.servers ?? []
  const counts = ['connected', 'failed', 'needs sign-in']
    .map((state) => [servers.filter((server) => server.state === state), state])
    .filter(([matching]) => matching.length)
    .map(([matching, state]) => `${matching.length} ${state}`)
  const count = [plural(servers.length, 'server', 'servers'), ...counts].join(' &middot; ')
  let body = `<p class="found-live"><span class="chip">${escapeHtml(claude.liveLabel)}</span></p>`
  if (!servers.length) body += '<p class="found-missing">No servers are set up in Claude Code on this computer.</p>'
  for (const [scope, heading] of FOUND_SCOPE_ORDER) {
    const inScope = servers.filter((server) => server.scope === scope)
    if (!inScope.length) continue
    body += `<p class="found-sub">${heading}</p>` + foundListHtml(inScope.map((server) =>
      foundItemHtml(server, { meta: escapeHtml(server.transportLabel), label: server.stateLabel, chip: FOUND_CHIP[server.state] ?? 'chip' })))
  }
  if (claude.projectServers > 0) {
    body += `<p class="found-note">${claude.projectServers === 1 ? '1 project has its own servers' : `${claude.projectServers} projects have their own servers`}. Their names are not shown.</p>`
  }
  if (claude.more > 0) body += `<p class="found-note">${plural(claude.more, 'more server was', 'more servers were')} not listed - the list stops at 100.</p>`
  return foundGroupHtml('Claude Code', count, body, open)
}

function foundCodexHtml(codex, open) {
  if (codex?.status !== 'found') {
    return foundGroupHtml('Codex', codex?.status === 'not found' ? 'Not found' : 'Could not be read',
      foundMissingHtml(codex, 'Codex was not found on this computer.', 'Codex&rsquo;s servers and plugins could not be read'), open)
  }
  const servers = codex.servers ?? []
  const plugins = codex.plugins ?? []
  const codexChip = (entry) => (entry.state === 'found' ? 'chip on' : 'chip')
  let body = ''
  if (!servers.length && !plugins.length) body += '<p class="found-missing">No servers or plugins are set up in Codex on this computer.</p>'
  if (servers.length) {
    body += '<p class="found-sub">Servers</p>' + foundListHtml(servers.map((server) => foundItemHtml(server, { label: server.label, chip: codexChip(server) })))
  }
  if (plugins.length) {
    body += '<p class="found-sub">Plugins</p>' + foundListHtml(plugins.map((plugin) =>
      foundItemHtml(plugin, { meta: `from ${escapeHtml(plugin.from)}`, label: plugin.label, chip: codexChip(plugin) })))
  }
  if (codex.more > 0) body += `<p class="found-note">${plural(codex.more, 'more Codex server or plugin was', 'more Codex servers or plugins were')} not listed.</p>`
  const count = `${plural(servers.length, 'server', 'servers')} &middot; ${plural(plugins.length, 'plugin', 'plugins')}`
  return foundGroupHtml('Codex', count, body, open)
}

function foundToolsHtml(tools, open) {
  if (!tools?.length) return foundGroupHtml('Installed tools', 'None checked', '<p class="found-missing">No tools were checked in this reading.</p>', open)
  const found = tools.filter((tool) => tool.state === 'found').length
  const rows = tools.map((tool) => {
    const value = tool.state === 'found'
      ? `<span class="found-version">${escapeHtml(tool.version ?? tool.label)}</span>`
      : `<span class="found-version muted">${escapeHtml(tool.label)}</span>`
    return `<li class="found-tool"><span class="found-tool-name">${brandTileHtml(tool.name, 'found-tile')}<span class="found-title">${escapeHtml(tool.name)}</span></span>${value}</li>`
  }).join('')
  return foundGroupHtml('Installed tools', `${found} of ${tools.length} found`, `<ul class="found-tools">${rows}</ul>`, open)
}

function foundComputerHtml(computer, open) {
  const where = computer.computer ? escapeHtml(computer.computer) : 'a computer with no name shown'
  const stale = computer.freshness === 'stale'
    ? `<p class="found-stale">Checked more than 8 hours ago, so this may be out of date. Run <code>/snapshot</code>
       on ${computer.computer ? where : 'that computer'}, or check its collector.</p>`
    : ''
  const hidden = ['claude', 'codex'].reduce((total, key) => total + (computer[key]?.status === 'found' ? computer[key].hidden ?? 0 : 0), 0)
  const hiddenNote = hidden > 0
    ? `<p class="found-note">${hidden === 1
      ? '1 name was left out because it did not read as a plain name - it could have been a key, an address or a path.'
      : `${hidden} names were left out because they did not read as plain names - any of them could have been a key, an address or a path.`}</p>`
    : ''
  return `<article class="panel card found-computer">
    <p class="found-head"><span class="title">Found on ${where}</span> <span class="found-age">&middot; checked ${escapeHtml(ago(computer.takenAt))}</span></p>
    ${stale}${foundClaudeHtml(computer.claude, open)}${foundCodexHtml(computer.codex, open)}${foundToolsHtml(computer.tools, open)}${hiddenNote}</article>`
}

function foundWallHtml(found) {
  const head = `${sectionHead('What your computers have set up', '<h2>Found on your computers</h2>')}
    <p class="found-intro">From each computer&rsquo;s last <code>/snapshot</code>. Found is not the same as proved:
    only the list above says a connection has worked with your own data.</p>`
  const wrap = (inner) => `<section class="found-wall">${head}${inner}</section><!-- found-wall -->`
  const computers = Array.isArray(found?.computers) ? found.computers : []
  if (!found || found.status === 'none' || (found.status === 'ok' && !computers.length)) {
    return wrap(`<div class="panel empty"><b>Nothing found yet.</b>
      <span class="small">Run <code>/snapshot</code> in your team repo on each computer you use, and this fills in
      with its tools, servers and plugins.</span>${whyHtml('A collector on your own computer writes down what it has set up and commits that list to your repo. The board only reads that list; it never reaches your computer.')}</div>`)
  }
  if (found.status !== 'ok') {
    return wrap(`<div class="panel empty"><b>Your found list could not be used.</b>
      <span class="small">${escapeHtml(found.why ?? '')} Run <code>/snapshot</code> again.</span></div>`)
  }
  const notes = []
  if (found.notShown) notes.push(`${plural(found.notShown, 'more computer was', 'more computers were')} not shown - the wall shows the newest three.`)
  if (found.unreadable) notes.push(`${plural(found.unreadable, 'connections file', 'connections files')} could not be used (damaged, too big, or not returned by GitHub), so ${found.unreadable === 1 ? 'it was' : 'they were'} left out.`)
  if (found.skipped) notes.push(`${plural(found.skipped, 'more connections file was', 'more connections files were')} not read - the board reads only five.`)
  return wrap(computers.map((computer, index) => foundComputerHtml(computer, index === 0)).join('') +
    (notes.length ? `<p class="found-note">${notes.map(escapeHtml).join(' ')}</p>` : '') +
    `<p class="found-note logo-credits">${escapeHtml(LOGO_CREDITS)}</p>`)
}

/* ---------- Hermes ----------
   The card at the top of Connections and the #hermes page, from api/state.js shapeHermes. Both
   exist only for somebody whose Hermes reading found Hermes (decision D6): a student without it
   never sees a Hermes card, tab or page. Running / Down at last check / Not checked for N h is
   worked out by the server from the times in the file, and is always said in words - the colour on
   the word repeats it, never replaces it. */

// A computer whose reading found any part of Hermes. "Hermes not found" everywhere is a computer
// without Hermes, and gets nothing.
const hasHermes = (computer) => ['install', 'gateway', 'profiles'].some((part) => computer?.[part]?.status === 'found')
const hermesComputers = () => (data?.hermes?.status === 'ok' && Array.isArray(data.hermes.computers)
  ? data.hermes.computers.filter(hasHermes) : [])
const hermesShown = () => hermesComputers().length > 0
// The runtimes.yml entry called Hermes, whose url the server has already held to http and https.
const hermesRuntime = () => (data?.runtimes ?? []).find((runtime) => /^hermes$/i.test(String(runtime?.name ?? '').trim())) ?? null

function hermesSessionsWords(sessions) {
  if (sessions?.status !== 'found') return escapeHtml(sessions?.label ?? 'No sessions recorded')
  const parts = [
    plural(sessions.conversations, 'conversation'),
    `${plural(sessions.scheduled, 'scheduled run')} this week`
  ]
  if (sessions.lastActiveAt) parts.push(`last active ${escapeHtml(ago(sessions.lastActiveAt))}`)
  return parts.join(' &middot; ')
}

function hermesProfileHtml(item, detail) {
  const skills = typeof item.skills === 'number' ? plural(item.skills, 'skill') : 'Skills not counted'
  const line = [escapeHtml(item.modelLabel), skills, hermesSessionsWords(item.sessions)].join(' &middot; ')
  const scheduler = detail
    ? `<span class="hermes-profile-more">${item.schedulerBeatAt ? `Scheduler last beat ${escapeHtml(ago(item.schedulerBeatAt))}` : 'No scheduler beat found'}</span>`
    : ''
  return `<li class="hermes-profile"><span class="hermes-profile-name">${escapeHtml(item.name)}</span>
    <span class="hermes-profile-line">${line}</span>${scheduler}</li>`
}

// The shared contract's alive rule (tests/fixtures/hermes-parity.json `alive`), mirrored so the card's
// words say which signal the server's Running or Down came from. A test fails if the two drift.
const HERMES_PAGE_ALIVE = { withinSeconds: 300, gatewayStates: ['running'] }
const hermesNearCheck = (iso, takenAt) => {
  const gap = Math.abs(Date.parse(iso) - Date.parse(takenAt))
  return Number.isFinite(gap) && gap <= HERMES_PAGE_ALIVE.withinSeconds * 1000
}

// A gateway stamp far from the check is a file nobody has written since - on Nuno's Mac the root
// gateway file stopped in early September while Hermes ran on. The card says so, instead of
// offering "Running, last stamp 37 days ago" beside a Running that came from somewhere else.
function hermesGatewayWords(computer) {
  const gateway = computer.gateway
  if (gateway?.status !== 'found') return gateway?.status === 'not found' ? 'Gateway not found' : 'Gateway could not be read'
  const state = escapeHtml(gateway.stateLabel)
  if (!gateway.beatAt) return `Gateway: ${state}, with no time on it, so the board does not go by it.`
  if (hermesNearCheck(gateway.beatAt, computer.takenAt)) return `Gateway: ${state}, last stamp ${escapeHtml(ago(gateway.beatAt))}`
  const day = new Date(gateway.beatAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  return `Gateway: its status file still says ${state}, but it was last written ${escapeHtml(ago(gateway.beatAt))} (${escapeHtml(day)}), so the board does not go by it.`
}

// When Running did not come from the gateway, it came from the profiles' schedulers: name them.
function hermesRunningBecause(computer) {
  if (computer.alive !== 'running') return ''
  const gateway = computer.gateway
  if (gateway?.status === 'found' && HERMES_PAGE_ALIVE.gatewayStates.includes(gateway.state) &&
    gateway.beatAt && hermesNearCheck(gateway.beatAt, computer.takenAt)) return ''
  const names = (computer.profiles?.items ?? [])
    .filter((item) => item.schedulerBeatAt && hermesNearCheck(item.schedulerBeatAt, computer.takenAt))
    .map((item) => escapeHtml(item.name))
  if (!names.length) return ''
  const shown = names.slice(0, 3)
  const list = names.length > 3 ? `${shown.join(', ')} and ${names.length - 3} more`
    : shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
  const who = computer.computer ? escapeHtml(computer.computer) : 'the computer'
  return `Running because the ${list} ${names.length === 1 ? 'scheduler' : 'schedulers'} checked in when ${who} looked.`
}

function hermesCardHtml(computer, detail) {
  const where = computer.computer ? escapeHtml(computer.computer) : 'a computer with no name shown'
  const profiles = computer.profiles ?? { status: 'not found', items: [], hidden: 0, more: 0 }
  const items = profiles.items ?? []
  let list
  if (items.length) list = `<ul class="hermes-profiles">${items.map((item) => hermesProfileHtml(item, detail)).join('')}</ul>`
  else if (profiles.status === 'found') list = '<p class="hermes-note">No profiles were listed.</p>'
  else list = `<p class="hermes-note">${profiles.status === 'not found' ? 'No profiles found.' : 'The profiles could not be read.'}</p>`
  const notes = []
  if (profiles.hidden > 0) {
    notes.push(profiles.hidden === 1
      ? '1 profile was left out because its name did not read as a plain name.'
      : `${profiles.hidden} profiles were left out because their names did not read as plain names.`)
  }
  if (profiles.more > 0) notes.push(`${plural(profiles.more, 'more profile was', 'more profiles were')} not listed - the card shows twelve.`)
  const stale = computer.alive === 'stale'
    ? `<p class="hermes-old">This reading is too old to say whether Hermes is up. Run <code>/snapshot</code> on
       ${computer.computer ? where : 'that computer'}, or check its collector.</p>`
    : ''
  const runtime = hermesRuntime()
  const links = detail
    ? ''
    : `<p class="hermes-links"><a class="watch" href="#hermes">Hermes page &rarr;</a>${runtime?.url
      ? `<a class="watch" href="${escapeHtml(runtime.url)}" rel="noreferrer noopener">Open Hermes &rarr;</a>` : ''}</p>`
  // A word the server did not send is drawn as no word at all, never as the class "undefined".
  const alive = ['running', 'down', 'stale'].includes(computer.alive) ? computer.alive : 'stale'
  const because = hermesRunningBecause(computer)
  return `<article class="panel card hermes-card">
    <div class="hermes-top"><span class="tile tile-hermes" aria-hidden="true">H</span>
      <div class="hermes-name"><p class="title">Hermes</p><p class="hermes-version">${escapeHtml(computer.install?.label ?? '')}</p></div>
      <p class="hermes-alive hermes-${alive}">${escapeHtml(computer.aliveLabel)}</p></div>
    <p class="hermes-foot">checked ${escapeHtml(ago(computer.takenAt))} on ${where}${alive === 'stale' ? '' : ` &middot; ${hermesGatewayWords(computer)}`}</p>
    ${because ? `<p class="hermes-foot">${because}</p>` : ''}${stale}${list}${notes.length ? `<p class="hermes-note">${notes.map(escapeHtml).join(' ')}</p>` : ''}${links}</article>`
}

// The top of Connections: a card per computer that has Hermes, or one sentence when the reading
// itself could not be used. Nothing at all for somebody without Hermes.
function hermesSectionHtml() {
  if (data?.hermes?.status === 'unusable') {
    return `${sectionHead('Your always-on helper', '<h2>Hermes</h2>')}<div class="panel empty"><b>Your Hermes reading could not be used.</b>
      <span class="small">${escapeHtml(data.hermes.why ?? '')} Run <code>/snapshot</code> again.</span></div>`
  }
  if (!hermesShown()) return ''
  return `${sectionHead('Your always-on helper', '<h2>Hermes</h2>')}<div class="hermes-cards">${hermesComputers().map((computer) => hermesCardHtml(computer, false)).join('')}</div>`
}

/* The copy cards: each a short explanation and the exact words to paste, for a Mac and for
   Windows. The words are pasted into Claude Code or into Hermes - the board itself sends nothing. */
function copyCardHtml(title, intro, variants, extra = '') {
  const blocks = variants.map(([os, lead, text]) => `<div class="copy-variant"><p class="copy-os">${os}</p>
    <p class="copy-lead">${lead}</p><pre class="copy-text">${escapeHtml(text)}</pre>
    <button type="button" class="copy-btn" data-copy>Copy</button></div>`).join('')
  return `<details class="panel copy-card"><summary>${title}</summary><div class="copy-body"><p class="copy-intro">${intro}</p>${extra}${blocks}</div></details>`
}

function hermesCopyCardsHtml() {
  const runtime = hermesRuntime()
  const open = runtime?.url
    ? `<p class="copy-lead"><a class="hermes-open" href="${escapeHtml(runtime.url)}" rel="noreferrer noopener">Open Hermes</a></p>`
    : '<p class="copy-lead">Once it opens on your phone, add its address as <code>url:</code> on the Hermes entry in <code>runtimes.yml</code>, and an Open Hermes button appears here.</p>'
  // The login is what Hermes's own code says it does off this computer - read, not seen working
  // here. So the words make the person SEE the login page before anything is saved, and stop the
  // dashboard if it is not there, rather than trusting this page's say-so.
  const phone = (where, keep) => `I want to open the Hermes dashboard from my phone over Tailscale.
On this ${where}:
1. Check Tailscale is running and tell me this computer's Tailscale address.
2. Start the Hermes dashboard (hermes dashboard) so it listens only on that Tailscale address - never on 0.0.0.0 or all addresses.
3. I will open that address on my phone. Wait until I tell you whether a Hermes login page appears, and help me set the login if it asks.
4. If no login page appears, stop the dashboard straight away and tell me why it did not ask.
5. Only once I have seen the login page: ${keep}
6. Then add the address as url: on the Hermes entry in runtimes.yml in my team repo.
Show me each change and ask before you make it.`
  const health = `Health check, please. In short bullet points:
- your version, and whether an update is waiting
- whether your gateway is running
- each profile, its model, and when its scheduler last ran
- any scheduled job that failed in the last 24 hours, and why
Do not show me keys, tokens, addresses or file paths.`
  const board = (where, schedule) => `Hermes is not showing on my dashboard. Check these in order and stop at the first one that is wrong:
1. Run /snapshot on this ${where} and tell me whether .agent-team/status/hermes/ now has a file for it.
2. ${schedule}
3. Check runtimes.yml has a Hermes entry with heartbeat: runs/heartbeat/hermes.json and stale_after_minutes: 200.
Tell me what you found, and ask before changing anything.`
  return [
    copyCardHtml('Open Hermes from your phone',
      'Hermes has its own dashboard: a web page with a chat, on the computer Hermes runs on. Tailscale is a private network between your own devices, so your phone can open that page without it ever being on the public internet. Before you rely on it, check that it asks for a login when your phone opens it: if it does not, stop it.',
      [
        ['On a Mac', 'Paste this into Claude Code on the Mac that runs Hermes:', phone('Mac', 'keep it running after a restart, as its own LaunchAgent.')],
        ['On Windows', 'Paste this into Claude Code on the PC that runs Hermes:', phone('Windows PC', 'keep it running after a restart, starting when I sign in.')]
      ], open),
    copyCardHtml('Ask Hermes for a health check',
      'A quick way to hear from Hermes itself whether all is well. Hermes answers from its own state.',
      [
        ['On a Mac', 'Open Hermes (its dashboard, or type <code>hermes</code> in Terminal) and paste:', health],
        ['On Windows', 'Open Hermes (Hermes Desktop, its dashboard, or <code>hermes</code> in PowerShell) and paste:', health]
      ]),
    copyCardHtml('Hermes is not on my board',
      'The card comes from a small file a collector writes on the computer that runs Hermes, every three hours. These are the checks, in order.',
      [
        ['On a Mac', 'Paste this into Claude Code in your team repo, on the Mac that runs Hermes:',
          board('Mac', 'Check the collector\'s schedule on this Mac (the LaunchAgent in .agent-team/status/README.md, under The Mac schedule) is loaded and ran in the last 3 hours.')],
        ['On Windows', 'Paste this into Claude Code in your team repo, on the PC that runs Hermes:',
          board('PC', 'There is no schedule on Windows: the list is only taken when /snapshot runs. If Hermes runs on another computer, the check has to run there.')]
      ])
  ].join('')
}

function renderHermes() {
  if (!hermesShown()) {
    el('hermes').innerHTML = ''
    return
  }
  el('hermes').innerHTML = `${screenBannerHtml('hermes')}
    ${sectionHead('Your always-on helper', '<h2>Hermes</h2>')}
    <div class="hermes-cards">${hermesComputers().map((computer) => hermesCardHtml(computer, true)).join('')}</div>
    ${sectionHead('When you need it', '<h2>Help</h2>')}
    <div class="copy-cards">${hermesCopyCardsHtml()}</div>`
}

// The copy buttons. Delegated, like every button on this page, because the screens are drawn again
// on every reading. The text copied is the block's own, exactly as shown.
document.addEventListener('click', async (event) => {
  const button = event.target.closest?.('button[data-copy]')
  if (!button) return
  const text = button.parentElement?.querySelector('.copy-text')?.textContent ?? ''
  try {
    await navigator.clipboard.writeText(text)
    button.textContent = 'Copied'
  } catch {
    button.textContent = 'Select and copy it'
  }
  setTimeout(() => { button.textContent = 'Copy' }, 2000)
})

// "3 hr 20 min", for a runtime's own heartbeat window.
function minutesWords(minutes) {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (!hours) return `${rest} min`
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`
}

// Two rails, and they answer different questions. Connections are what the team can reach on
// the owner's behalf — Gmail, a calendar, a CRM — read from connections/register.yml, which
// /connect writes after a tool has answered with the owner's own data. Runtimes are machines
// with a URL the owner wants one tap away.
//
// This screen used to render runtimes only, while being called Connections. A student who did
// Lesson 4, connected Gmail and ran /connect saw "No runtimes registered" and a suggestion to
// add Hermes or OpenClaw — neither of which they have or need.
function renderConnections() {
  const connections = data.connections ?? []
  const runtimes = data.runtimes ?? []
  const found = data.found ?? null
  // Day zero keeps its one message. Once a computer has sent its list, the screen is drawn whole.
  const foundAny = found?.status === 'ok' || found?.status === 'unusable'

  const hermesTop = hermesSectionHtml()

  if (!connections.length && !runtimes.length && !foundAny && !hermesTop) {
    el('connections').innerHTML = screenBannerHtml('connections') + emptyStateHtml('connections', 'Nothing connected yet. Run <code>/connect</code> in your team repo and it will wire one tool, prove it by reading your own data back to you, and register it here.')
    return
  }

  const connectionRows = connections.map((connection) => {
    const proof = connection.proved
      ? `<span class="chip ok">Proved ${escapeHtml(connection.verified)}</span>`
      : `<span class="chip warn">Unproven</span>`
    const detail = connection.proved
      ? escapeHtml(connection.proof)
      : 'No verified date and proof in the register, so this is a claim rather than a connection. Run <code>/connect</code> to prove it.'
    const scopes = connection.scopes.length ? `<span class="chip">${escapeHtml(connection.scopes.join(', '))}</span>` : ''
    const usedBy = connection.usedBy.length
      ? `<span class="small muted">used by ${escapeHtml(connection.usedBy.join(', '))}</span>`
      : `<span class="small muted">no workflow depends on it yet</span>`
    return `
    <div class="conn ${connection.proved ? 'live' : 'attention'}">
      <div class="row between">
        <span class="row"><span class="dot"></span>${brandTileHtml(connection.name, 'conn-tile')}<span class="title">${escapeHtml(connection.name)}</span><span class="chip">${escapeHtml(connection.kind)}</span>${scopes}</span>
        ${proof}
      </div>
      <p class="small" style="margin:.35rem 0 .25rem">${detail}</p>
      <div class="row between">
        ${usedBy}
        ${connection.account ? `<span class="small muted">${escapeHtml(connection.account)}</span>` : ''}
      </div>
    </div>`
  }).join('')

  const runtimeRows = runtimes.map((runtime) => `
    <!-- status is escaped even though shapeRuntimes only ever emits live | silent | no-heartbeat
         today. Nothing stops that changing, and the connection row two blocks up already guards
         its own class the same way. -->
    <div class="conn ${escapeHtml(runtime.status)}">
      <div class="row between">
        <span class="row"><span class="dot"></span>${brandTileHtml(runtime.name, 'conn-tile')}<span class="title">${escapeHtml(runtime.name)}</span><span class="chip">${escapeHtml(runtime.kind)}</span></span>
        <span class="state">${escapeHtml(STATE_LABEL[runtime.status] ?? runtime.status)}</span>
      </div>
      <div class="row between" style="margin-top:.35rem">
        <span class="small muted">${runtime.lastBeat ? `heartbeat ${escapeHtml(ago(runtime.lastBeat))}` : 'no heartbeat file yet'}${
          // Said only when the owner set their own window in runtimes.yml; 30 is what every runtime had before.
          Number.isInteger(runtime.staleAfterMinutes) && runtime.staleAfterMinutes !== 30
            ? ` &middot; silent after ${minutesWords(runtime.staleAfterMinutes)} without one` : ''}${
          // A setting the server could not read is said, so the owner knows why it did nothing.
          runtime.staleAfterUnderstood === false
            ? ' &middot; <code>stale_after_minutes</code> not understood, using 30 min' : ''}</span>
        <span class="row">${hermesShown() && runtime === hermesRuntime() ? '<a href="#hermes">Hermes page &rarr;</a>' : ''}${runtime.url ? `<a href="${escapeHtml(runtime.url)}" rel="noreferrer noopener">Open &rarr;</a>` : ''}</span>
      </div>
    </div>`).join('')

  // Both halves always have a heading and something under it. They used to appear only if they had
  // rows, so an empty half took its subject off the screen with it - and `runtimes: []` is what the
  // template SHIPS, so that is every student on day one, not a corner case. The employee test repo
  // says it in the file itself: "I work on their laptop and I am not putting a machine of my own on
  // their network." He reads a screen that never mentions machines and cannot tell whether the board
  // does not track them or he has none.
  //
  // The empty state has to say the absence is FINE, because the neighbouring screens are telling him
  // nothing has run. A runtime is a shortcut tile, not an engine: runtimes.yml calls it "anything
  // with a URL that you want one tap away from your dashboard".
  //
  // But it is not inert, and this sentence has been wrong twice.
  //
  // First it said "nothing runs or stops running because of what is in it" - true about RUNNING and
  // read as "this list has no consequences". One entry here flips the Access rung on Today.
  //
  // Then it said the Access step is one "which a proved connection above also satisfies". That is
  // the HEURISTIC branch of shapeSetup, which the code's own comment calls "the path a student never
  // takes". Once /onboard has run, Access is `onboarding.access === true` and nothing else - a
  // student mid-onboarding can prove every connection they own and the rung stays red. Worse, the
  // check I did against the employee repo could not have caught it: that repo HAS an onboarding
  // record marking Access done, so its rung was green either way, and green was consistent with my
  // sentence and with the truth at the same time.
  //
  // So no substitute mechanism is claimed. Access is the only other place a runtime shows up at all
  // (grep: accessDetail, the rung's pass in the heuristic branch, its detail in both), and the
  // sentence now says exactly that and stops.
  el('connections').innerHTML = `${screenBannerHtml('connections')}
    ${hermesTop}
    ${sectionHead('What your team can reach', '<h2>Connections</h2>')}
    ${connectionRows
      ? `<div class="panel">${connectionRows}</div>`
      : `<div class="panel empty"><b>Nothing connected yet.</b>
         <span class="small">Run <code>/connect</code> in your team repo and it will wire one tool,
         prove it by reading your own data back to you, and register it here.</span></div>`}
    ${foundWallHtml(found)}
    ${sectionHead('Machines', '<h2>Runtimes</h2>')}
    ${runtimeRows
      ? `<div class="panel">${runtimeRows}</div>`
      : `<div class="panel empty"><b>No machines listed, which is normal.</b>
         <span class="small">Nothing here makes a job run; the only other place it shows up is the
         <b>Access</b> step on Today. Ask your team to add one when you have one.</span>${whyHtml('This is a shortcut list — anything of yours with a web address you want one tap away, like a home server.')}</div>`}`
}

/* ---------- skills ---------- */

// Two lists. The starter stack is what every team gets before anything else (stack.yml);
// the repo skills are what this team's workflows actually call. Plugins live on the
// owner's machine, so for those the card says how to check rather than guessing.
function renderSkills() {
  const stack = data.stack ?? []
  const skills = data.skills ?? []
  const stackCards = stack.map((entry) => {
    const presence = entry.source === 'repo'
      ? (entry.present ? '<span class="chip ok">Ships in this repo</span>' : '<span class="chip warn">Listed but missing from the repo</span>')
      : `<span class="chip wraps">Plugin · ${escapeHtml(entry.plugin ?? '')}</span>`
    return `
    <div class="agent">
      <div class="row between">
        <span class="title">${escapeHtml(entry.name)}</span>
        ${presence}
      </div>
      <p class="small" style="margin:.35rem 0 .25rem">${escapeHtml(entry.gives)}</p>
      <p class="small muted" style="margin:0 0 .35rem">${escapeHtml(entry.why)}</p>
      ${entry.verify ? `<p class="small muted" style="margin:0"><strong>Check it:</strong> ${escapeHtml(entry.verify)}</p>` : ''}
    </div>`
  }).join('')
  // Split rather than one alphabetical run of twenty-five, because the one useful distinction on
  // this screen was a three-word grey label - "sessions only" - scattered through five thousand
  // pixels, and two undefined words were carrying the whole idea.
  //
  // The headings say ONLY what `usedBy` proves, which is membership of a workflow's `steps:` list
  // and nothing else. Two earlier wordings claimed more than that and both were false:
  //
  //   "A job already runs these for you" - every workflow ships `armed: false`, so in a fresh repo
  //   nothing runs any of them. That is the exact claim the Workflows screen was hardened against
  //   ("the schedule chip alone said 'daily 06:30' and looked exactly like a fact"), reintroduced
  //   one screen along. Arm state lives on that screen and this one points at it instead.
  //
  //   "Only happen if you ask" - `run-log` is in this group because it is nobody's step, and its
  //   own description, rendered two lines below the heading, says "use at the end of every agent
  //   run, scheduled or manual". A heading contradicted by the text under it is worse than no
  //   heading.
  // "a", "a and b", "a, b and c" - so the sentence below never has to say how many there are.
  const inWords = (items) =>
    items.length < 3
      ? items.join(' and ')
      : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
  const stalledNote = (skill) => {
    const stalled = skill.stalled ?? []
    if (!stalled.length) return ''
    // Which jobs. When every job listing this skill is dead there is no point naming them again -
    // the "used by" line directly above already did.
    const which = stalled.length === (skill.usedBy ?? []).length
      ? stalled.length === 1 ? 'which cannot run as written' : 'none of which can run as written'
      : `${stalled.map(escapeHtml).join(', ')} cannot run as written`
    // And why, by naming the agents rather than counting them. An earlier version said "the owner
    // is switched off" whatever the number, which invents one shared owner where there can be two -
    // and the two agents somebody with a job switches off are exactly that case. Naming them is
    // also the more useful half: it is the thing he would go and change.
    const owners = skill.stalledOwners ?? []
    const why = owners.length
      ? ` &mdash; ${inWords(owners.map(escapeHtml))} ${owners.length === 1 ? 'is' : 'are'} switched off`
      : ''
    return `<div class="small bad">${which}${why}</div>`
  }
  const skillRow = (skill) => `
    <div class="agent">
      <div class="row between">
        <a href="#" data-open="${escapeHtml(skill.path)}" class="title">${escapeHtml(skill.slug)}</a>
        ${skill.usedBy.length ? `<span class="small muted">used by ${skill.usedBy.map(escapeHtml).join(', ')}</span>` : ''}
      </div>
      ${
        // A job that cannot run as written is still listed as a step here, and the heading above only
        // says membership. Four skills in this repo are listed by exactly one job and that job is one
        // of the two an employee switches off, so without this line he reads "used by weekly-review"
        // and has to go to another screen to learn that weekly-review never fires.
        //
        // Deliberately narrow: it says the JOB cannot run, never that the skill is dead. Everything
        // on this screen can still be asked for by name, which is what the other group says about
        // itself, and "this skill is useless" would be a bigger claim than the evidence supports.
        stalledNote(skill)
      }
      <p class="small" style="margin:.3rem 0 0">${escapeHtml(skill.description)}</p>
    </div>`
  const onAsk = skills.filter((skill) => !skill.usedBy.length)
  const onSchedule = skills.filter((skill) => skill.usedBy.length)
  const skillGroup = (heading, note, list) => list.length
    ? `<h3 class="group">${heading} &middot; ${list.length}</h3>
       <p class="small muted group-note">${note}</p>
       <div class="panel">${list.map(skillRow).join('')}</div>`
    : ''
  el('skills').innerHTML = `${screenBannerHtml('skills')}
    ${createFormHtml('skill')}
    ${sectionHead('Every team starts with', `<h2>Starter stack &middot; ${stack.length}</h2>`)}
    ${stack.length ? `<div class="panel">${stackCards}</div>` : '<div class="panel empty">No <code>stack.yml</code> in this repo yet. Run <code>/install-stack</code> and it appears here.</div>'}
    ${sectionHead('In this repo', `<h2>This team's skills &middot; ${skills.length}</h2>`)}
    ${skills.length ? skillGroup(
        'Not a step in any job',
        'Some of these run themselves as part of other work; the rest only happen when you ask for them. Each one says which, in its own line below.',
        onAsk
      ) + skillGroup(
        'Listed as a step in a job',
        'Whether that job actually runs is a separate question - the Workflows screen is the one that says which jobs ring.',
        onSchedule
      ) : emptyStateHtml('skills', `<b>No skills yet.</b>
      <span class="small">Run <code>/onboard</code> to get the starter set, or ask your team for one in
      plain words &mdash; you never write the file yourself.</span>${whyHtml('Skills are the single tasks your jobs are built from.')}`)}`
  bindCreateForm('skill', el('skills'))
  el('skills').querySelectorAll('[data-open]').forEach((link) =>
    link.addEventListener('click', (event) => { event.preventDefault(); openFile(link.dataset.open) }))
}

/* ---------- Personalise: the owner's own pictures ----------
   With a picture store connected, /api/brand says personalising is on and lists the owner's own
   pictures, each by version. A picture sits behind the view key, and an img cannot send a header,
   so each one is fetched here with the key and shown from memory as a blob: address - the only
   kind of address a store picture ever gets on this page.

   Everything hangs off one rule: with personalising off - no store, an answer that failed or did
   not come, anything that is not exactly `enabled: true` - `brand` stays null, every function below
   hands back what it was given, and Today and Team are the board as it was before any of this
   existed (tests/render.test.mjs holds the two screens to a copy of that board, byte for byte). */

// How long the board waits for /api/brand before drawing without it. The board is the point: a
// store slow to answer costs three seconds once, and never the board.
const BRAND_WAIT_MS = 3000
// What /api/art can be asked for: the server's own shapes - parseSlot in api/_lib.js, and the
// version and three types in api/_picture-store.js. Anything else in an answer is dropped here,
// before it can become part of an address or a key the page looks things up by.
const ART_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ART_VERSION = /^[a-z0-9]{8,32}$/
const ART_TYPES = { 'image/webp': 'webp', 'image/jpeg': 'jpeg', 'image/png': 'png' }
const isArtSlug = (slug) => typeof slug === 'string' && slug.length <= 100 && ART_SLUG.test(slug)
// The banner slots, word for word BANNER_SLOTS in api/_lib.js: one per screen, each named after it.
const BANNER_SLOTS = ['today', 'team', 'ledger', 'workflows', 'readiness', 'skills', 'memory', 'connections', 'hermes']
const isArtSlot = (slot) => BANNER_SLOTS.includes(slot) ||
  (typeof slot === 'string' && slot.startsWith('agent-') && isArtSlug(slot.slice('agent-'.length)))
const isArtPicture = (picture) => Boolean(picture) && typeof picture.v === 'string' &&
  ART_VERSION.test(picture.v) && Object.hasOwn(ART_TYPES, picture.type)
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

let brand = null
let meaningSaid = null
let brandFault = ''
// slot -> { v, url } once a picture is in hand, or { v, failed: true } once fetching it failed.
// A slot the brand lists with no entry here, or an entry for another version, is on its way.
const artUrls = new Map()
// slot -> the version being fetched for it, so a second ask while the first is out is not a second fetch.
const artLoading = new Map()
// The screens whose pictures have been asked for, once each: a screen's pictures are fetched the
// first time it is shown, never with Today.
const artAsked = new Set()

function parseBrand(answer) {
  if (!isRecord(answer) || answer.enabled !== true) return null
  const text = (value) => (typeof value === 'string' ? value : '')
  const count = (value) => (Number.isInteger(value) && value >= 0 ? value : 0)
  const pictures = {}
  for (const [slot, picture] of Object.entries(isRecord(answer.pictures) ? answer.pictures : {})) {
    if (isArtSlot(slot) && isArtPicture(picture)) pictures[slot] = { v: picture.v, type: picture.type }
  }
  const names = {}
  for (const [slug, name] of Object.entries(isRecord(answer.names) ? answer.names : {})) {
    if (isArtSlug(slug) && typeof name === 'string' && name.trim()) names[slug] = name
  }
  return {
    canGenerate: answer.canGenerate === true,
    why: text(answer.why),
    assistantName: text(answer.assistantName),
    artStyle: text(answer.artStyle),
    defaultArtStyle: text(answer.defaultArtStyle),
    names,
    pictures,
    left: { writes: count(answer.left?.writes), generated: count(answer.left?.generated) }
  }
}

const storePicture = (slot) => (brand && Object.hasOwn(brand.pictures, slot) ? brand.pictures[slot] : null)

// Holds one slot's picture, letting go of the address it replaces. An address is only freed once
// nothing will draw it again.
function holdArt(slot, entry) {
  const old = artUrls.get(slot)
  if (old?.url && old.url !== entry?.url) URL.revokeObjectURL(old.url)
  if (entry) artUrls.set(slot, entry)
  else artUrls.delete(slot)
}

// A new answer from /api/brand. A picture it no longer lists, or lists at another version, is let
// go of here; the new version is fetched when its screen asks.
function useBrand(answer) {
  brand = parseBrand(answer)
  // Voice rides on the same answer, and does not need personalising on.
  voiceInfo = parseVoice(answer)
  // So does search by meaning: { on, why }, or null when the board did not say (memory-find.js asks then).
  meaningSaid = isRecord(answer) && isRecord(answer.meaning) && typeof answer.meaning.on === 'boolean'
    ? { on: answer.meaning.on, why: typeof answer.meaning.why === 'string' ? answer.meaning.why : '' }
    : null
  // Off because the store is connected but failing - a damaged settings file, a public store - the
  // server's sentence is the one to show: "connect a store" would send the owner round in circles.
  brandFault = !brand && isRecord(answer) && answer.fault === true && typeof answer.why === 'string' ? answer.why : ''
  for (const [slot, held] of artUrls) {
    if (storePicture(slot)?.v !== held.v) holdArt(slot, null)
  }
}

// Which address a picture is drawn from: the owner's own when it is in hand, the built-in one
// (null for an agent with none) when they have not put one in or theirs could not be fetched, and
// null - nothing at all - while theirs is on its way, so the built-in one never flashes up first.
function pictureSrc(slot, builtIn) {
  const wanted = storePicture(slot)
  if (!wanted) return builtIn
  const held = artUrls.get(slot)
  if (held?.v !== wanted.v) return null
  return held.url ?? builtIn
}

// The same, for markup that already carries its built-in picture as src="...". The tag is found by
// that attribute rather than rebuilt, so the Today banner keeps the very tag the head preloads and
// the tests pin. Unchanged whenever the built-in picture is the one to show.
function pictureSwap(markup, builtIn, slot) {
  const src = pictureSrc(slot, builtIn)
  if (src === builtIn) return markup
  const attribute = `src="${builtIn}"`
  const at = markup.indexOf(attribute)
  if (at < 0) return markup
  if (src) return markup.slice(0, at) + `src="${escapeHtml(src)}"` + markup.slice(at + attribute.length)
  return markup.slice(0, markup.lastIndexOf('<', at)) + markup.slice(markup.indexOf('>', at) + 1)
}

// One picture from the store, or null - asked for by the signed-in browser, whose cookie goes with
// it. Only what came back as one of the three picture types counts: anything else - an error page,
// a refusal - is a picture that failed.
async function fetchPicture(slot, wanted) {
  const response = await fetch(`/api/art?slot=${encodeURIComponent(slot)}&v=${wanted.v}&t=${ART_TYPES[wanted.type]}`)
  if (!response.ok) return null
  const blob = await response.blob()
  return blob && Object.hasOwn(ART_TYPES, blob.type) && blob.size > 0 ? blob : null
}

// With personalising on, each place a store picture can be drawn - a banner, a portrait - carries
// its slot, so a picture that lands later can find its own place. Off, nothing is added: the board
// stays the board it was.
const artMark = (slot) => (brand && isArtSlot(slot) ? ` data-art="${slot}"` : '')

// The picture that ships for a slot, or null for an agent the template has no robot for.
const builtInArt = (slot) => (slot === 'today' ? '/art/today-harbour.webp'
  : slot === 'team' ? '/art/team-workshop.webp'
  : Object.hasOwn(SCREEN_BANNERS, slot) ? SCREEN_BANNERS[slot].file
  : PORTRAITS.has(slot.slice('agent-'.length)) ? `/art/${slot}.webp` : null)

// Where a slot's picture is drawn: a portrait on Team, a banner on its own screen - except
// Readiness's, which sits in its own holder just before the wall (the wall is never markup).
const artHome = (slot) => (slot.startsWith('agent-') ? 'team' : slot === 'readiness' ? 'readiness-banner' : slot)

// The tag a picture is put in its place with. Lazy like every picture but Today's first one - by
// now it is an address in memory, so there is nothing to wait for anyway.
const artImageHtml = (slot, src) => (slot.startsWith('agent-')
  ? `<img class="portrait-img" src="${escapeHtml(src)}" alt="" width="480" height="480" loading="lazy" decoding="async" />`
  : `<img src="${escapeHtml(src)}" alt="" width="1600" height="686" loading="lazy" decoding="async" />`)

/* Puts one slot's picture right where it is drawn, and touches nothing else on the screen.

   This used to be a redraw of the whole screen once its pictures had landed. On a slow connection
   that is seconds after the screen first appears - time enough to open Add task, a card, or its
   Personalise, and start typing - and a redraw puts the screen back as it was drawn: the half-typed
   words gone, the open card shut. So now each picture changes its own img and nothing more: a new
   address on the one already there, a new img where there was none (a portrait's goes after its
   initial, so it is drawn over it; a banner's goes first, under its words), or the img taken away
   while nothing is ready to go there. */
function paintArt(slot) {
  if (!brand || !isArtSlot(slot)) return
  const src = pictureSrc(slot, builtInArt(slot))
  for (const holder of el(artHome(slot))?.querySelectorAll?.(`[data-art="${slot}"]`) ?? []) {
    const image = holder.querySelector('img')
    if (!src) {
      image?.remove()
    } else if (image) {
      if (image.getAttribute('src') !== src) image.setAttribute('src', src)
    } else {
      const tile = holder.querySelector('.portrait-tile')
      if (tile) tile.insertAdjacentHTML('afterend', artImageHtml(slot, src))
      else holder.insertAdjacentHTML('afterbegin', artImageHtml(slot, src))
    }
  }
}

// Fetches the store pictures for these slots that are not already in hand, and puts each in its
// place as it lands. A version already held is never fetched again. Says whether anything changed.
// Never throws: a picture that cannot be had leaves the built-in one, and the board goes on.
async function loadArt(slots) {
  const changed = await Promise.all(slots.map(async (slot) => {
    const wanted = storePicture(slot)
    if (!wanted || artUrls.get(slot)?.v === wanted.v || artLoading.get(slot) === wanted.v) return false
    artLoading.set(slot, wanted.v)
    let picture = null
    try { picture = await fetchPicture(slot, wanted) } catch (error) { picture = null }
    if (artLoading.get(slot) === wanted.v) artLoading.delete(slot)
    // The brand moved on while this was out: a version nobody wants any more is not kept.
    if (storePicture(slot)?.v !== wanted.v) return false
    holdArt(slot, picture ? { v: wanted.v, url: URL.createObjectURL(picture) } : { v: wanted.v, failed: true })
    paintArt(slot)
    return true
  }))
  return changed.includes(true)
}

// Which pictures each screen shows.
const ART_SCREENS = {
  today: () => ['today'],
  team: () => ['team', ...data.agents.map((agent) => `agent-${agent.slug}`)],
  ledger: () => ['ledger'],
  workflows: () => ['workflows'],
  readiness: () => ['readiness'],
  skills: () => ['skills'],
  memory: () => ['memory'],
  connections: () => ['connections'],
  hermes: () => ['hermes']
}

async function showArt(screen) {
  if (!brand) return
  await loadArt(ART_SCREENS[screen]())
}

// A picture just sent to the store is already here, as the very bytes that were sent. It is shown
// from them rather than fetched straight back.
function adoptPicture(slot, picture, blob) {
  if (!brand || !isArtSlot(slot) || !isArtPicture(picture)) return
  brand.pictures[slot] = { v: picture.v, type: picture.type }
  holdArt(slot, { v: picture.v, url: URL.createObjectURL(blob) })
  paintArt(slot)
}

// The answer from /api/brand, or null - off - if it fails, is refused, or takes longer than
// BRAND_WAIT_MS.
async function readBrand() {
  let timer
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), BRAND_WAIT_MS) })
  const answer = apiGet('/api/brand').then((result) => (result.ok ? result.payload : null), () => null)
  try {
    return await Promise.race([answer, late])
  } finally {
    clearTimeout(timer)
  }
}

/* ---------- Personalise: a chosen picture, made small enough to send ----------
   A phone photo is several megabytes; the store takes 45 KB for a portrait and 100 KB for a
   banner. So the picture is cropped and shrunk here, on the device, before anything is sent: the
   centre of it, at the size the board draws it, in the smallest file that still looks right. */

// Mirrored word for word from api/_lib.js, which refuses anything over these
// (tests/render.test.mjs holds the two copies together).
const PICTURE_BUDGET = { portrait: 45 * 1024, banner: 100 * 1024 }
// The size each is drawn at - the robots are 480 square, the banners 1600 by 686 - and the
// narrowest it may be made to fit the budget, below which it would look soft on a laptop.
const PICTURE_SIZE = {
  portrait: { width: 480, aspect: 1, floor: 320 },
  banner: { width: 1600, aspect: 21 / 9, floor: 1200 }
}
const QUALITY_STEPS = [0.85, 0.75, 0.65, 0.55, 0.45, 0.35]
const PICTURE_UNREADABLE = 'This picture could not be opened here. Save it as a JPEG or PNG and choose it again.'
// A canvas this big is gigabytes, and a phone's tab dies drawing it. Nothing a camera makes comes
// near it; a file built to be enormous once opened does.
const PICTURE_MAX_SIDE = 12000
const PICTURE_TOO_BIG_TO_DRAW = 'This picture is too big to open here, so choose a smaller one.'
const PICTURE_UNWRITABLE = 'This browser could not make a small copy of the picture. Try it again in Chrome, Edge or Safari.'
const pictureTooBig = (kind) =>
  `This picture would not shrink under ${PICTURE_BUDGET[kind] / 1024} KB, even small and soft, so it was not sent. ` +
  'Try a simpler picture, or crop it closer first.'

// The largest piece of a width-by-height picture in the given shape, taken from its middle -
// where the subject of a photo almost always is.
function cropBox(width, height, aspect) {
  if (width / height > aspect) {
    const cropped = Math.round(height * aspect)
    return { x: Math.floor((width - cropped) / 2), y: 0, width: cropped, height }
  }
  const cropped = Math.round(width / aspect)
  return { x: 0, y: Math.floor((height - cropped) / 2), width, height: cropped }
}

// Each width to try: the full size, then 0.85 of it each time, ending exactly on the floor.
function pictureWidths({ width, floor }) {
  const widths = [width]
  while (widths.at(-1) > floor) widths.push(Math.max(floor, Math.round(widths.at(-1) * 0.85)))
  return widths
}

const canvasBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality))

// The smallest good-enough file of the picture `draw(width, height)` paints: every quality step at
// full size, then the same at each smaller size, stopping at the first that fits the budget.
async function encodeUnderCap(draw, kind) {
  const size = PICTURE_SIZE[kind]
  let type = 'image/webp'
  for (const width of pictureWidths(size)) {
    const canvas = draw(width, Math.round(width / size.aspect))
    for (let step = 0; step < QUALITY_STEPS.length; step += 1) {
      const blob = await canvasBlob(canvas, type, QUALITY_STEPS[step])
      if (blob?.type !== type) {
        // Safari before 17 cannot write webp, and does not say so: asked for one, it hands back a
        // PNG. So what decides is the type that CAME BACK, never the one asked for - and the answer
        // to a browser that will not write webp is a JPEG, which every browser writes.
        if (type !== 'image/webp') throw new Error(PICTURE_UNWRITABLE)
        type = 'image/jpeg'
        step -= 1
        continue
      }
      if (blob.size <= PICTURE_BUDGET[kind]) return blob
    }
  }
  throw new Error(pictureTooBig(kind))
}

// The chosen file as something a canvas can draw. createImageBitmap is asked to turn a phone photo
// the right way up, from the rotation the camera wrote into it. It is missing in older browsers and
// refuses some files an image still opens, so an image is the second try - and browsers turn an
// image the right way up by themselves. Neither opening it is usually an iPhone HEIC photo on a
// browser that cannot read them.
async function decodePicture(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch (error) { /* the second try, below */ }
  }
  if (typeof Image === 'function') {
    const address = URL.createObjectURL(file)
    try {
      const image = new Image()
      await new Promise((resolve, reject) => {
        image.onload = resolve
        image.onerror = reject
        image.src = address
      })
      return image
    } catch (error) {
      /* the sentence, below */
    } finally {
      // Loaded, the image holds its own copy; the address is only how it got one.
      URL.revokeObjectURL(address)
    }
  }
  throw new Error(PICTURE_UNREADABLE)
}

// A chosen file, as the file to send for a portrait or a banner: opened, cut from its centre to
// the right shape, and shrunk under the budget. Throws a sentence to show the person.
async function shrinkPicture(file, kind) {
  const source = await decodePicture(file)
  try {
    const width = source.naturalWidth || source.width
    const height = source.naturalHeight || source.height
    if (!width || !height) throw new Error(PICTURE_UNREADABLE)
    if (width > PICTURE_MAX_SIDE || height > PICTURE_MAX_SIDE) throw new Error(PICTURE_TOO_BIG_TO_DRAW)
    const box = cropBox(width, height, PICTURE_SIZE[kind].aspect)
    return await encodeUnderCap((targetWidth, targetHeight) => {
      const canvas = document.createElement('canvas')
      canvas.width = targetWidth
      canvas.height = targetHeight
      const context = canvas.getContext('2d')
      context.imageSmoothingQuality = 'high'
      context.drawImage(source, box.x, box.y, box.width, box.height, 0, 0, targetWidth, targetHeight)
      return canvas
    }, kind)
  } finally {
    // A decoded photo is its full size in memory - tens of megabytes for a phone's camera.
    source.close?.()
  }
}

/* ---------- Personalise: the controls ----------
   With a store connected, every Team card opens to a Personalise section, each banner has a small
   Personalise button for its own picture, and Make it yours in the Team banner opens the assistant's
   name and the art style under it. All of it happens here on the board, at once - and the board's
   only write power is over its own picture store: names and pictures, never the team repo.

   With personalising off, Make it yours is the one control there is, and it opens to a single
   sentence saying how to switch personalising on. Nothing else is drawn (tests/render.test.mjs holds
   Today to the board before personalising, byte for byte, and Team to that plus this one button). */

// Kept on this device like the view key, through the same two guarded helpers - and in this
// variable too, so a browser that refuses storage still gets the change it just typed the key for.
const EDIT_KEY_STORE = 'agent-cockpit-edit-key'
let editKeyHeld = ''
const editKey = () => readStore(EDIT_KEY_STORE) || editKeyHeld
const EDIT_KEY_ASK = 'Changing this board needs its edit key.\n\n' + (LOCAL_BOARD
  ? 'Paste the edit key from your board settings. It is kept on this device and never appears in this page.'
  : 'Paste the EDIT_KEY you set in Vercel. It is kept on this device, like the view key, and never appears in this page.')
const SWITCH_ON = LOCAL_BOARD
  ? 'Personalising is off: the board could not use its pictures folder. Look in the Start Board window for the reason.'
  : 'Personalising is off: to switch it on, create a Private Blob store in Vercel (your project, then ' +
    'Storage, Create Storage, Blob), connect it to this project and redeploy.'

let brandPanelOpen = false

const pictureKind = (slot) => (slot.startsWith('agent-') ? 'portrait' : 'banner')
const allowanceCount = (value) => (Number.isInteger(value) && value >= 0 ? value : 0)
// The name an agent has been given, or '' for none. Own keys only: an agent called "constructor"
// must not be named after a function every object has.
const displayName = (slug) => (brand && Object.hasOwn(brand.names, slug) ? brand.names[slug] : '')

// What is left of today's allowance, in words. Pictures from words are not counted out loud on a
// board that cannot make them.
function allowanceText() {
  const changes = plural(brand.left.writes, 'change')
  return brand.canGenerate
    ? `Left today: ${changes} and ${plural(brand.left.generated, 'new picture')}.`
    : `Left today: ${changes}.`
}

// A made picture is kept by an upload, which is a change: with none left today, Make it would only
// charge OpenAI for a picture the board could not keep (the server refuses it as well).
const NO_CHANGE_LEFT = 'No changes are left today to keep a new picture with, so Make it is off until midnight UTC.'

function showAllowance() {
  if (!brand) return
  for (const line of document.querySelectorAll('.allowance')) line.textContent = allowanceText()
  const none = brand.left.writes === 0
  for (const button of document.querySelectorAll('form[data-make] button[type="submit"]')) button.disabled = none
  for (const line of document.querySelectorAll('.no-change-left')) line.hidden = !none
}

/* A banner on every screen (look and feel, 2026-10-10): the screen's own picture and one line about
   what it is for, laid over the picture like Today's and Team's. Lazy: a screen's picture is fetched
   when the screen is first opened. No banner names an agent, or the word the Team tests look for
   first. Each is a Personalise slot named after its screen. */
const SCREEN_BANNERS = {
  ledger: { file: '/art/ledger-counting-room.webp', eyebrow: 'Ledger', headline: 'What your team gave back.' },
  workflows: { file: '/art/workflows-clock-tower.webp', eyebrow: 'Workflows', headline: 'Every job, and when it runs.' },
  readiness: { file: '/art/readiness-lighthouse.webp', eyebrow: 'Every scheduled job', headline: 'Flight readiness.' },
  skills: { file: '/art/skills-drawers.webp', eyebrow: 'Skills', headline: 'What your team knows how to do.' },
  memory: { file: '/art/memory-archive.webp', eyebrow: 'Memory', headline: 'Everything your team remembers.' },
  connections: { file: '/art/connections-bridges.webp', eyebrow: 'Connections', headline: 'Where your team plugs in.' },
  hermes: { file: '/art/hermes-loft.webp', eyebrow: 'Hermes', headline: 'The helper that never sleeps.' }
}
// What each banner's picture controls are called, under it.
const BANNER_NAMES = { today: 'Today', team: 'Team', ledger: 'Ledger', workflows: 'Workflows', readiness: 'Readiness', skills: 'Skills', memory: 'Memory', connections: 'Connections', hermes: 'Hermes' }

function screenBannerHtml(slot) {
  const banner = SCREEN_BANNERS[slot]
  return pictureSwap(`<section class="banner screen-banner banner-${slot}"${artMark(slot)}>
    <img src="${banner.file}" alt="" width="1600" height="686" loading="lazy" decoding="async" />
    <div class="banner-text">
      <div class="banner-words">
        <p class="eyebrow">${banner.eyebrow}</p>
        <h2 class="headline">${banner.headline}</h2>
      </div>
      ${bannerButtonsHtml(slot)}
    </div>
  </section>`, banner.file, slot) + bannerPersonaliseHtml(slot)
}

// The buttons on a banner. Off, Today gets none and Team gets only Make it yours.
function bannerButtonsHtml(slot) {
  const personalise = brand
    ? `<button class="fire banner-btn" type="button" data-personalise="${slot}" aria-expanded="false">Personalise</button>`
    : ''
  const yours = slot === 'team'
    ? `<button class="fire banner-btn" type="button" id="brand-open" aria-expanded="${brandPanelOpen}">Make it yours</button>`
    : ''
  return personalise + yours
}

// Choose a picture, Describe it and Make it, Back to the default, and what is left today - the same
// for a card and a banner. The file input is inside the label, so pressing the button opens the
// picker; image/* is what makes a phone offer its camera and its photo library both.
function pictureControlsHtml(slot) {
  const make = brand.canGenerate
    ? `<form class="fire-form" data-make="${slot}">
        <label for="describe-${slot}">Describe it</label>
        <textarea id="describe-${slot}" rows="2" maxlength="400"
          placeholder="${pictureKind(slot) === 'portrait' ? 'e.g. a cheerful fox in a tweed waistcoat, holding a lantern' : 'e.g. a quiet harbour at dusk, the lamps coming on'}"></textarea>
        <button class="fire" type="submit"${brand.left.writes === 0 ? ' disabled' : ''}>Make it</button>
        <span class="small muted no-change-left"${brand.left.writes === 0 ? '' : ' hidden'}>${NO_CHANGE_LEFT}</span>
      </form>`
    : `<p class="small muted">${escapeHtml(brand.why || 'Making pictures from words is off on this board.')}</p>`
  return `<div class="picture-controls">
      <div class="fires">
        <label class="fire">Choose a picture<input class="visually-hidden" type="file" accept="image/*" data-upload="${slot}" /></label>
        <button class="fire" type="button" data-reset="${slot}">Back to the default</button>
      </div>
      ${make}
      <p class="small muted allowance">${allowanceText()}</p>
      <span class="fire-note"></span>
    </div>`
}

// A banner's own controls, straight under it and shut until its Personalise button is pressed.
// Nothing in here may name an agent: on Team it is drawn above every card.
function bannerPersonaliseHtml(slot) {
  if (!brand) return ''
  return `<div class="panel banner-personalise" id="personalise-${slot}" hidden>
    <p class="eyebrow">The ${BANNER_NAMES[slot]} picture</p>
    ${pictureControlsHtml(slot)}
  </div>`
}

// A card's Personalise, in its drawer - never in the summary, where a tap on a field would open and
// shut the card. An agent whose slug the store would refuse gets none; there is nothing it could save.
function personaliseHtml(agent) {
  if (!brand || !isArtSlug(agent.slug)) return ''
  const slug = escapeHtml(agent.slug)
  return `<div class="personalise">
      <p class="eyebrow">Personalise</p>
      <form class="fire-form" data-change="name" data-slug="${slug}">
        <label for="name-${slug}">Name on the card</label>
        <div class="row">
          <input id="name-${slug}" class="brand-field" type="text" maxlength="40" autocomplete="off" value="${escapeHtml(displayName(agent.slug))}" placeholder="${slug}" />
          <button class="fire" type="submit">Save</button>
        </div>
        <span class="small muted">Jobs and task cards still call this agent <b>${slug}</b>. Leave the name empty to show that again.</span>
        <span class="fire-note"></span>
      </form>
      ${pictureControlsHtml(`agent-${agent.slug}`)}
    </div>`
}

// Make it yours. Off, the one sentence saying how to switch it on. On, the assistant's name and the
// art style every picture made from words follows. It is drawn above every card, so nothing in it
// may name an agent.
function brandPanelHtml() {
  if (!brand) return `<div class="panel brand-panel" id="brand-panel"><p class="small">${brandFault ? escapeHtml(brandFault) : SWITCH_ON}</p></div>`
  return `<div class="panel brand-panel" id="brand-panel">
    <p class="eyebrow">Make it yours</p>
    <p class="small muted">Rename an agent or change its picture from its own card below. Each banner has a Personalise button for its picture.</p>
    <form class="fire-form" data-change="assistant">
      <label for="brand-assistant">Your assistant's name</label>
      <div class="row">
        <input id="brand-assistant" class="brand-field" type="text" maxlength="40" autocomplete="off" value="${escapeHtml(brand.assistantName)}" placeholder="No name yet" />
        <button class="fire" type="submit">Save</button>
      </div>
      <span class="fire-note"></span>
    </form>
    <form class="fire-form" data-change="style">
      <label for="brand-style">The art style new pictures are made in</label>
      <textarea id="brand-style" rows="5" maxlength="600">${escapeHtml(brand.artStyle || brand.defaultArtStyle)}</textarea>
      <span class="small muted" data-style-says>${styleSaysHtml()}</span>
      <div class="fires">
        <button class="fire" type="submit">Save the style</button>
        <button class="fire" type="button" data-default-style="1">Back to the default</button>
      </div>
      <span class="fire-note"></span>
    </form>
    <p class="small muted allowance">${allowanceText()}</p>
    ${voicePanelHtml()}
  </div>`
}

// Talking to the board, in Make it yours: which voice speaks, or why there is no orb.
function voicePanelHtml() {
  if (voiceInfo.on) {
    const words = VOICE_MOUTH_WORDS[voiceInfo.mouth] + (voiceInfo.note ? ` ${voiceInfo.note}` : '')
    return `<p class="small muted">${escapeHtml(words)}</p>`
  }
  return voiceInfo.why ? `<p class="small muted">${escapeHtml(voiceInfo.why)}</p>` : ''
}

// Whose style is in the box: the default, or the owner's own - with the default shown beside it, so
// going back is never a guess.
const styleSaysHtml = () => (brand.artStyle
  ? `Your own style. The default is: ${escapeHtml(brand.defaultArtStyle)}`
  : 'This is the default style. Change it, and every picture made from words after that follows it.')

// Make it yours, opened or put away under the Team banner. Put in and taken out on its own, so
// nothing else on the screen is drawn again - Add agent half-typed stays half-typed.
function toggleBrandPanel(button) {
  brandPanelOpen = !brandPanelOpen
  button.setAttribute('aria-expanded', String(brandPanelOpen))
  const team = el('team')
  team.querySelector('#brand-panel')?.remove()
  if (brandPanelOpen) team.querySelector('.team-banner')?.insertAdjacentHTML('afterend', brandPanelHtml())
}

// A banner's picture controls, opened or put away.
function togglePersonalise(button) {
  const controls = el(`personalise-${button.dataset.personalise}`)
  if (!controls) return
  controls.hidden = !controls.hidden
  button.setAttribute('aria-expanded', String(!controls.hidden))
}

// --- writing to the picture store ---------------------------------------------------------------

// Every write carries the edit key once there is one, and exactly the type the server's write gate
// asks for - it refuses anything else. Who is writing goes with it by itself: the signed-in cookie.
function writeHeaders(type) {
  const headers = { 'Content-Type': type }
  const edit = editKey()
  if (edit) headers['x-edit-key'] = edit
  return headers
}

async function answerOf(response) {
  try {
    const answer = await response.json()
    return isRecord(answer) ? answer : {}
  } catch (error) {
    return {}
  }
}

/* One write. A 401 that names the edit key asks for it once, keeps it, and sends the same change
   again; any other refusal is thrown as the server's own sentence, which says what to do. Returns
   the response when the store took the change. */
async function storeWrite(path, body, type) {
  const send = async () => {
    try {
      return await fetch(path, { method: 'POST', headers: writeHeaders(type), body })
    } catch (error) {
      throw new Error('Could not reach the board, so nothing was changed.')
    }
  }
  let response = await send()
  if (response.ok) return response
  let refusal = await answerOf(response)
  if (response.status === 401 && refusal.needs === 'edit-key') {
    const entered = window.prompt?.(EDIT_KEY_ASK)
    if (typeof entered !== 'string' || !entered.trim()) throw new Error('Nothing was changed: this board needs its edit key for that.')
    editKeyHeld = entered.trim()
    writeStore(EDIT_KEY_STORE, editKeyHeld)
    response = await send()
    if (response.ok) return response
    refusal = await answerOf(response)
    // A key the store refused is not kept, so the next change asks again instead of failing the
    // same way every time.
    if (response.status === 401 && refusal.needs === 'edit-key') {
      editKeyHeld = ''
      writeStore(EDIT_KEY_STORE, null)
    }
  }
  throw new Error(typeof refusal.error === 'string' && refusal.error ? refusal.error : `That did not go through (${response.status}), so nothing was changed.`)
}

// The board's new names and pictures, from /api/brand's answer to a change. A picture that went or
// moved is put right in its place; one that moved on another device is fetched.
function takeBrand(answer) {
  if (!brand || !parseBrand(answer)) return
  const before = { ...brand.pictures }
  useBrand(answer)
  const moved = [...new Set([...Object.keys(before), ...Object.keys(brand.pictures)])]
    .filter((slot) => before[slot]?.v !== storePicture(slot)?.v)
  for (const slot of moved) paintArt(slot)
  loadArt(moved)
  showAllowance()
}

function takeLeft(left) {
  if (!brand || !isRecord(left)) return
  brand.left = { writes: allowanceCount(left.writes), generated: allowanceCount(left.generated) }
  showAllowance()
}

// A shrunk picture into the store, then shown from the copy in hand.
async function sendPicture(slot, picture) {
  const response = await storeWrite(`/api/upload?slot=${encodeURIComponent(slot)}`, picture, 'application/octet-stream')
  const answer = await answerOf(response)
  if (!isArtPicture(answer.picture)) throw new Error('The store took the picture but did not say which it is, so reload the board to see it.')
  takeLeft(answer.left)
  adoptPicture(slot, answer.picture, picture)
}

// --- what the controls do -----------------------------------------------------------------------

function tell(note, words, tone = '') {
  if (!note) return
  note.className = tone ? `fire-note ${tone}` : 'fire-note'
  note.textContent = words
}

// One change from a control: everything in its box is off while it is out, the box's note says what
// is happening and then what happened, and a refusal is shown as the sentence it came with.
async function personaliseDo(control, working, work) {
  const box = control.closest?.('form[data-change]') ?? control.closest?.('.picture-controls') ?? null
  const note = box?.querySelector?.('.fire-note') ?? null
  const parts = [...(box?.querySelectorAll?.('button, input, textarea') ?? [])]
  for (const part of parts) part.disabled = true
  tell(note, working)
  try {
    tell(note, await work((words) => tell(note, words)), 'ok')
  } catch (error) {
    tell(note, error?.message || 'That did not work, so nothing was changed.', 'bad')
  } finally {
    for (const part of parts) part.disabled = false
    // Everything went back on above; Make it stays off if the day's changes ran out meanwhile.
    showAllowance()
  }
}

async function choosePicture(input) {
  const slot = input.dataset.upload
  const file = input.files?.[0]
  // Emptied straight away, so choosing the same photo again is still a choice.
  input.value = ''
  if (!brand || !isArtSlot(slot) || !file) return
  await personaliseDo(input, 'Making it small enough to send…', async (say) => {
    const picture = await shrinkPicture(file, pictureKind(slot))
    say('Sending…')
    await sendPicture(slot, picture)
    return 'Done. This is the picture now.'
  })
}

async function makePicture(form) {
  const slot = form.dataset.make
  if (!brand || !isArtSlot(slot)) return
  const field = form.querySelector('textarea')
  const description = String(field?.value ?? '').trim()
  await personaliseDo(form, 'Making the picture. This can take up to a minute…', async (say) => {
    if (brand.left.writes === 0) throw new Error(NO_CHANGE_LEFT)
    if (description.length < 3) throw new Error('Describe the picture in a few words first.')
    const response = await storeWrite('/api/generate', JSON.stringify({ slot, description }), 'application/json')
    // Spent the moment OpenAI was asked, whatever happens next.
    takeLeft({ ...brand.left, generated: brand.left.generated - 1 })
    const made = await response.blob()
    if (!made || !Object.hasOwn(ART_TYPES, made.type)) throw new Error('What came back was not a picture, so nothing was changed. Try again.')
    say('Making it small enough to send…')
    const picture = await shrinkPicture(made, pictureKind(slot))
    say('Sending…')
    await sendPicture(slot, picture)
    if (field) field.value = ''
    return 'Done. This is the picture now.'
  })
}

async function resetPicture(button) {
  const slot = button.dataset.reset
  if (!brand || !isArtSlot(slot)) return
  await personaliseDo(button, 'Putting the default back…', async () => {
    // Nothing of the owner's to take away, so no write is spent on it.
    if (!storePicture(slot)) return 'This already shows the default picture.'
    const response = await storeWrite('/api/brand', JSON.stringify({ change: 'reset-picture', slot }), 'application/json')
    takeBrand(await answerOf(response))
    return 'Done. The default picture is back.'
  })
}

// A card's name on the card, put right in place: the name over the slug, or the slug alone again.
function showDisplayName(form, slug) {
  const card = form.closest?.('.agent-card')
  if (!card) return
  const name = displayName(slug)
  let shown = card.querySelector('.display-name')
  if (name && !shown) {
    card.querySelector('.agent-body')?.insertAdjacentHTML('afterbegin', '<span class="display-name"></span>')
    shown = card.querySelector('.display-name')
  }
  if (shown) {
    if (name) shown.textContent = name
    else shown.remove()
  }
  card.classList.toggle('named', Boolean(name))
}

const BRAND_CHANGES = ['name', 'assistant', 'style']

// A name, the assistant's name or the art style. An empty value is "back to the default".
async function saveBrand(form, value) {
  const change = form?.dataset?.change
  if (!brand || !BRAND_CHANGES.includes(change)) return
  const field = form.querySelector('input, textarea')
  const typed = String(value ?? field?.value ?? '').trim()
  const slug = form.dataset.slug
  await personaliseDo(form, 'Saving…', async () => {
    const body = change === 'name' ? { change, slug, value: typed } : { change, value: typed }
    const response = await storeWrite('/api/brand', JSON.stringify(body), 'application/json')
    takeBrand(await answerOf(response))
    if (change === 'name') showDisplayName(form, slug)
    if (field) {
      field.value = change === 'name' ? displayName(slug)
        : change === 'assistant' ? brand.assistantName
        : brand.artStyle || brand.defaultArtStyle
    }
    if (change === 'style') {
      const says = form.querySelector('[data-style-says]')
      if (says) says.innerHTML = styleSaysHtml()
    }
    return typed ? 'Saved.' : 'Back to the default.'
  })
}

// Delegated, because the screens are drawn again on every reading of the repo and a listener on a
// node that has since been replaced is a button that does nothing.
document.addEventListener('click', (event) => {
  const target = event.target
  const yours = target.closest?.('#brand-open')
  if (yours) {
    toggleBrandPanel(yours)
    return
  }
  const banner = target.closest?.('button[data-personalise]')
  if (banner) {
    togglePersonalise(banner)
    return
  }
  const reset = target.closest?.('button[data-reset]')
  if (reset) {
    if (!reset.disabled) resetPicture(reset)
    return
  }
  const plain = target.closest?.('button[data-default-style]')
  if (plain && !plain.disabled) saveBrand(plain.closest('form[data-change]'), '')
})
document.addEventListener('submit', (event) => {
  const form = event.target
  if (form?.dataset?.change) {
    event.preventDefault()
    saveBrand(form)
  } else if (form?.dataset?.make) {
    event.preventDefault()
    makePicture(form)
  }
})
document.addEventListener('change', (event) => {
  if (event.target?.dataset?.upload) choosePicture(event.target)
})

/* ---------- Talk to the board: the helpers shared with the server ----------
   KEEP IN SYNC: everything between the two markers below is api/_voice.js's block of the same name,
   word for word with `export` taken off (tests/voice-client.test.mjs holds the two together). It is
   tested there, through the module; here it is what the orb, the sheet and the meter card run. */
// voice-page:start

// A count the meter can use: a whole number above zero. Anything else counts for nothing rather
// than for something - a count is never guessed.
const wholeCount = (value) => (Number.isInteger(value) && value > 0 ? value : 0)
const ownRow = (table, key) => (table && typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : null)

// Which count is priced by which rate, and how an unpriced one is named.
const REALTIME_PARTS = [
  ['textIn', 'textIn', 'text in'],
  ['cachedTextIn', 'cachedTextIn', 'cached text in'],
  ['audioIn', 'audioIn', 'audio in'],
  ['cachedAudioIn', 'cachedAudioIn', 'cached audio in'],
  ['textOut', 'textOut', 'text out'],
  ['audioOut', 'audioOut', 'audio out']
]
const CAPTION_PARTS = [
  ['transcribeTextIn', 'textIn', 'text in'],
  ['transcribeAudioIn', 'audioIn', 'audio in'],
  ['transcribeOut', 'textOut', 'text out']
]

// A conversation's counts, in dollars: { micros, usd, incomplete, fishBytes }. Worked in millionths
// of a dollar and rounded once, at the end. A count with no rate to price it is named in
// `incomplete` and left out of the total - the total is then less than the truth and says so, which
// is the opposite of counting it as free. A count of zero needs no rate.
function costOf(counts, models, prices) {
  const incomplete = []
  let micros = 0
  const price = (row, parts, label) => {
    for (const [field, rate, words] of parts) {
      const used = wholeCount(counts?.[field])
      if (!used) continue
      const perMillion = row?.[rate]
      if (typeof perMillion === 'number' && perMillion >= 0) micros += used * perMillion
      else incomplete.push(`${label} ${words}`)
    }
  }
  price(ownRow(prices?.realtime, models?.model), REALTIME_PARTS, String(models?.model ?? 'voice'))
  price(ownRow(prices?.transcription, models?.transcribeModel), CAPTION_PARTS, `captions (${models?.transcribeModel})`)
  const fishBytes = wholeCount(counts?.fishBytes)
  if (fishBytes) {
    const row = ownRow(prices?.fish, models?.fishModel)
    if (typeof row?.perMillionBytes === 'number' && row.perMillionBytes >= 0) micros += fishBytes * row.perMillionBytes
    else incomplete.push(`Fish ${models?.fishModel ?? 'voice'}`)
  }
  const rounded = Math.round(micros)
  return { micros: rounded, usd: rounded / 1e6, incomplete, fishBytes }
}

// --- cutting a reply into pieces Fish can speak (the Fish mouth only) ---
// Jack's rule: the first piece goes at the first pause - a comma, a dash, a full stop - once there
// are 12 characters to say, so the first sound comes early; after that, a sentence at a time. A
// mark only counts with a space after it, so "1,000" and "3.5" are never cut, and a mark at the very
// end of what has arrived waits for the next characters. A run with no pause at all is cut before
// 220 characters, at the last pause or space. When the reply is done, whatever is left is spoken.
const FIRST_PIECE_AT = 12
const LONGEST_PIECE = 220
const PAUSE = /[,;:—–.!?](?=\s)/g
const SENTENCE_END = /[.!?](?=\s)/g

function takeSpeakable(text, { first = false, done = false } = {}) {
  const buffer = typeof text === 'string' ? text : ''
  if (done) {
    const piece = buffer.replace(/\s+/g, ' ').trim()
    return { piece: piece || null, rest: '' }
  }
  let cut = -1
  for (const mark of buffer.matchAll(first ? PAUSE : SENTENCE_END)) {
    if (!first || mark.index + 1 >= FIRST_PIECE_AT) {
      cut = mark.index + 1
      break
    }
  }
  if (cut < 0 && buffer.length > LONGEST_PIECE) {
    const head = buffer.slice(0, LONGEST_PIECE)
    const pauses = [...head.matchAll(PAUSE)]
    const space = head.lastIndexOf(' ')
    cut = pauses.length ? pauses[pauses.length - 1].index + 1 : space > 0 ? space : LONGEST_PIECE
  }
  if (cut < 0) return { piece: null, rest: buffer }
  const piece = buffer.slice(0, cut).replace(/\s+/g, ' ').trim()
  const rest = buffer.slice(cut).replace(/^\s+/, '')
  return piece ? { piece, rest } : { piece: null, rest }
}

// --- turns ---
// Every reply is a turn. Talking over it starts a new one, and anything still arriving for an old
// turn - a piece of speech, a late answer from /api/speak - is dropped rather than played.
function newTurn(turns) {
  turns.current = (turns.current ?? 0) + 1
  return turns.current
}
const isStale = (turns, turn) => turn !== turns.current

// --- counting what a conversation used, for the meter ---
// The counts are OpenAI's own (realtime-costs): response.done carries a reply's usage, and each
// caption carries its own. Cached tokens are counted apart from the rest, because they are priced
// apart; the cached part is taken OUT of the plain count, so nothing is ever priced twice.
const TALLY_FIELDS = [
  'textIn', 'cachedTextIn', 'audioIn', 'cachedAudioIn', 'textOut', 'audioOut',
  'transcribeTextIn', 'transcribeAudioIn', 'transcribeOut', 'fishBytes'
]
function emptyTally() {
  return Object.fromEntries(TALLY_FIELDS.map((field) => [field, 0]))
}

// A new tally with this usage added; the one given is left as it was. `kind` is 'reply' for a
// response.done, 'captions' for a transcription. Anything else, or usage that is not usage, adds
// nothing.
function addUsage(tally, usage, kind) {
  const next = { ...emptyTally(), ...tally }
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return next
  const input = usage.input_token_details ?? {}
  const output = usage.output_token_details ?? {}
  if (kind === 'reply') {
    const cached = input.cached_tokens_details ?? {}
    const cachedText = wholeCount(cached.text_tokens)
    const cachedAudio = wholeCount(cached.audio_tokens)
    next.textIn += Math.max(0, wholeCount(input.text_tokens) - cachedText)
    next.cachedTextIn += cachedText
    next.audioIn += Math.max(0, wholeCount(input.audio_tokens) - cachedAudio)
    next.cachedAudioIn += cachedAudio
    next.textOut += wholeCount(output.text_tokens)
    next.audioOut += wholeCount(output.audio_tokens)
  } else if (kind === 'captions') {
    const split = input.text_tokens !== undefined || input.audio_tokens !== undefined
    next.transcribeTextIn += wholeCount(input.text_tokens)
    // With no split, a caption's input is the person's audio.
    next.transcribeAudioIn += split ? wholeCount(input.audio_tokens) : wholeCount(usage.input_tokens)
    next.transcribeOut += wholeCount(usage.output_tokens)
  }
  return next
}

// Fish bills by the UTF-8 bytes of the text it is sent, so that is what is counted.
function addFishBytes(tally, text) {
  return { ...emptyTally(), ...tally, fishBytes: wholeCount(tally?.fishBytes) + new TextEncoder().encode(String(text ?? '')).length }
}

// --- the outbox: conversations on this device not yet recorded by the board ---
// Saved after every reply, so a closed tab loses nothing; sent at hang-up and when the board opens.
// One entry per conversation, updated as it goes. Kept to the newest MAX_OUTBOX_ITEMS, so a board
// with no store - where the outbox IS the meter - cannot grow it for ever; the ones let go are
// counted in `dropped`, by the month each happened in, so the card can say that month's total is
// short rather than quietly being so - and a month nothing was let go from stays a known total.
const MAX_OUTBOX_ITEMS = 200
const OUTBOX_BATCH = 20
// A conversation still going is marked open, and is never reported: the board would count its counts
// so far and then refuse the final ones as a session it already had. OpenAI ends every call at 60
// minutes, so an entry still open after this was left by a tab that closed mid-call, and is reported.
const LIVE_CALL_MS = 65 * 60_000
const OUTBOX_TICKET = /^[A-Za-z0-9_-]{1,600}\.[A-Za-z0-9_-]{1,64}$/
const OUTBOX_SID = /^[0-9a-f]{32}$/
const OUTBOX_MODEL = /^[a-z0-9][a-z0-9.-]{0,39}$/
const OUTBOX_MONTH = /^\d{4}-\d{2}$/
// A year and a month of counts is all a card ever asks about.
const DROPPED_MONTHS = 13

// The dropped counts as stored, months the page could have written only, newest kept; then the
// conversations in `gone` added, each to its own month.
function droppedCounts(raw, gone = []) {
  const counts = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [month, count] of Object.entries(raw)) if (OUTBOX_MONTH.test(month) && wholeCount(count)) counts[month] = count
  }
  for (const item of gone) counts[item.at.slice(0, 7)] = (counts[item.at.slice(0, 7)] ?? 0) + 1
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => b.localeCompare(a)).slice(0, DROPPED_MONTHS))
}

function outboxItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (typeof raw.ticket !== 'string' || !OUTBOX_TICKET.test(raw.ticket)) return null
  if (typeof raw.sid !== 'string' || !OUTBOX_SID.test(raw.sid)) return null
  if (typeof raw.at !== 'string' || Number.isNaN(Date.parse(raw.at))) return null
  if (typeof raw.model !== 'string' || !OUTBOX_MODEL.test(raw.model)) return null
  if (raw.mouth !== 'openai' && raw.mouth !== 'fish') return null
  const counts = {}
  for (const field of TALLY_FIELDS) {
    const value = raw.counts?.[field] ?? 0
    if (!Number.isInteger(value) || value < 0) return null
    counts[field] = value
  }
  const fishModel = raw.mouth === 'fish' && typeof raw.fishModel === 'string' && OUTBOX_MODEL.test(raw.fishModel) ? raw.fishModel : null
  return {
    ticket: raw.ticket, sid: raw.sid, at: raw.at, model: raw.model, mouth: raw.mouth,
    ...(fishModel ? { fishModel } : {}), ...(raw.open === true ? { open: true } : {}), counts
  }
}

// The outbox from what storage held (a string, or null), keeping only entries the page could have
// written: storage can be edited by hand, by an extension, by anything on the device.
function readOutbox(stored) {
  let parsed = null
  try {
    parsed = typeof stored === 'string' ? JSON.parse(stored) : null
  } catch (error) {
    parsed = null
  }
  const items = Array.isArray(parsed?.items) ? parsed.items.map(outboxItem).filter(Boolean) : []
  const kept = items.slice(-MAX_OUTBOX_ITEMS)
  return { version: 1, items: kept, dropped: droppedCounts(parsed?.dropped, items.slice(0, items.length - kept.length)) }
}

function outboxPut(outbox, entry) {
  const item = outboxItem(entry)
  if (!item) return outbox
  const items = outbox.items.filter((kept) => kept.sid !== item.sid)
  const at = outbox.items.findIndex((kept) => kept.sid === item.sid)
  if (at >= 0) items.splice(at, 0, item)
  else items.push(item)
  const kept = items.slice(-MAX_OUTBOX_ITEMS)
  return { version: 1, items: kept, dropped: droppedCounts(outbox.dropped, items.slice(0, items.length - kept.length)) }
}

// What a ticket says - its session, when it started, which model and which mouth - read, not checked:
// only the server can check one. The page needs these to file the conversation in its outbox. Null
// for anything not shaped like a ticket.
function ticketSays(ticket) {
  if (typeof ticket !== 'string' || !OUTBOX_TICKET.test(ticket)) return null
  let claims = null
  try {
    const body = ticket.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')
    const bytes = Uint8Array.from(atob(body + '='.repeat((4 - (body.length % 4)) % 4)), (character) => character.charCodeAt(0))
    claims = JSON.parse(new TextDecoder().decode(bytes))
  } catch (error) {
    return null
  }
  if (!claims || typeof claims !== 'object' || typeof claims.sid !== 'string' || !OUTBOX_SID.test(claims.sid)) return null
  if (!Number.isInteger(claims.iat) || claims.iat < 0) return null
  if ((claims.mouth !== 'openai' && claims.mouth !== 'fish') || typeof claims.model !== 'string' || !OUTBOX_MODEL.test(claims.model)) return null
  const fishModel = claims.mouth === 'fish' && typeof claims.fishModel === 'string' && OUTBOX_MODEL.test(claims.fishModel) ? claims.fishModel : null
  return { sid: claims.sid, iat: claims.iat, mouth: claims.mouth, model: claims.model, ...(fishModel ? { fishModel } : {}) }
}

// The next report to send: the oldest 20 conversations that have ended, and which session each one
// is, by position.
function outboxBatch(outbox, now = Date.now()) {
  const ended = (item) => !item.open || now - Date.parse(item.at) >= LIVE_CALL_MS
  const items = outbox.items.filter(ended).slice(0, OUTBOX_BATCH)
  return { reports: items.map((item) => ({ ticket: item.ticket, counts: item.counts })), sids: items.map((item) => item.sid) }
}

// The outbox after the server answered `batch`: what it counted, and what it says can never count,
// go; everything else - kept for later, or not sent - stays. An answer that is not one clears nothing.
function outboxSettle(outbox, batch, answer) {
  const accepted = Array.isArray(answer?.accepted) ? answer.accepted : []
  const refused = Array.isArray(answer?.refused) ? answer.refused : []
  const gone = new Set(accepted.filter((sid) => typeof sid === 'string'))
  for (const one of refused) {
    if (Number.isInteger(one?.at) && one.at >= 0 && one.at < batch.sids.length) gone.add(batch.sids[one.at])
  }
  return { version: 1, items: outbox.items.filter((item) => !gone.has(item.sid)), dropped: droppedCounts(outbox.dropped) }
}

// This device's own total for one month, priced by the table the server sent - what the meter shows
// with no store, and the "not recorded yet" count with one.
function outboxSummary(outbox, prices, month) {
  const summary = { conversations: 0, usd: 0, incomplete: [], fishBytes: {}, waiting: outbox.items.length, dropped: droppedCounts(outbox.dropped)[month] ?? 0 }
  if (!prices) summary.incomplete.push('no price table yet')
  let micros = 0
  for (const item of outbox.items) {
    if (item.at.slice(0, 7) !== month) continue
    summary.conversations += 1
    if (item.counts.fishBytes > 0 && item.fishModel) {
      summary.fishBytes[item.fishModel] = (summary.fishBytes[item.fishModel] ?? 0) + item.counts.fishBytes
    }
    if (!prices) continue
    const cost = costOf(item.counts, { model: item.model, transcribeModel: prices.transcribeModel, fishModel: item.fishModel }, prices)
    micros += cost.micros
    for (const label of cost.incomplete) if (!summary.incomplete.includes(label)) summary.incomplete.push(label)
  }
  summary.usd = micros / 1e6
  return summary
}

// --- the six tools, answered from the board the page already has ---
// Read-only, every one: no new request, no new read of the repo, no cost. Each answer is small (4 KB
// at most) and plain (no string over 120 characters), because it goes back to OpenAI as the tool's
// output and the model reads it out. What the repo says is passed on as data; the session's
// instructions tell the model it is never an instruction. When the board does not know, the answer
// says "unknown" - a zero here would be a number the model then reads out as fact.
const VOICE_PAGE_SCREENS = ['today', 'ledger', 'team', 'workflows', 'skills', 'memory', 'connections', 'hermes']
const TOOL_ANSWER_BYTES = 4096
const TOOL_TEXT = 120
const toolText = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, TOOL_TEXT) : '')
// Times are said in the owner's local time, never UTC: "your job runs at 3 am" when it is 11 pm
// where they are breaks trust. The zone is this device's own (the page's Intl), held to the shape of
// an IANA name and to one this runtime knows - an offset like +05:00 is not one, as it never moves for
// summer time. Anything else is UTC in a tool answer, which says so, and is left out of the instructions.
const VOICE_ZONE = /^(?:UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2})$/
function voiceZone(zone) {
  if (typeof zone !== 'string' || !VOICE_ZONE.test(zone)) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return zone
  } catch (error) {
    return null
  }
}
const toolClock = (ms, zone) => new Intl.DateTimeFormat('en-US', {
  timeZone: zone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
}).format(new Date(ms))
const toolTime = (value, zone) => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? toolClock(Date.parse(value), zone) : null)
const toolList = (value) => (Array.isArray(value) ? value.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) : [])
const toolFew = (items, how, many = 5) => items.slice(0, many).map(how)

// The biggest list in an answer loses its last entry until the whole answer fits, and then says so.
function toolFits(answer) {
  let size = JSON.stringify(answer).length
  for (let guard = 0; size > TOOL_ANSWER_BYTES && guard < 2000; guard += 1) {
    let biggest = null
    const visit = (value) => {
      if (Array.isArray(value)) {
        if (value.length && (!biggest || JSON.stringify(value).length > JSON.stringify(biggest).length)) biggest = value
        value.forEach(visit)
      } else if (value && typeof value === 'object') {
        Object.values(value).forEach(visit)
      }
    }
    visit(answer)
    if (!biggest) break
    biggest.pop()
    answer.truncated = true
    size = JSON.stringify(answer).length
  }
  return answer
}

function teamStatus({ data, names, zone }) {
  if (!Array.isArray(data?.agents)) return { status: 'unknown' }
  return {
    agents: toolList(data.agents).map((agent) => {
      const slug = toolText(agent.slug)
      const given = names && typeof agent.slug === 'string' && Object.hasOwn(names, agent.slug) ? toolText(names[agent.slug]) : ''
      return { name: given || slug, slug, state: toolText(agent.state), lastRun: toolTime(agent.lastRun, zone) }
    })
  }
}

function whatsDue({ data, now, zone }, args) {
  const ahead = (args?.hours === 48 ? 48 : 24) * 3600_000
  if (!Array.isArray(data?.workflows)) return { status: 'unknown' }
  const due = toolList(data.workflows)
    .filter((job) => toolTime(job.nextRun) && Date.parse(job.nextRun) - now <= ahead)
    .sort((a, b) => Date.parse(a.nextRun) - Date.parse(b.nextRun))
  return {
    hours: ahead / 3600_000,
    due: toolFew(due, (job) => ({ name: toolText(job.name), at: toolTime(job.nextRun, zone) }), 10),
    goneQuiet: toolFew(toolList(data.goneQuiet), (item) => ({ name: toolText(item.name), kind: toolText(item.kind), lastRun: toolTime(item.lastRun, zone) }), 10),
    upNext: toolFew(toolList(data.board?.upNext), (card) => ({ name: toolText(card.name), at: toolTime(card.when, zone), owner: toolText(card.owner) }), 10)
  }
}

function taskBoard({ data }) {
  if (!data?.board || typeof data.board !== 'object') return { status: 'unknown' }
  const todo = toolList(data.board.todo)
  const column = (cards) => ({ count: cards.length, first: toolFew(cards, (card) => toolText(card.title)) })
  return {
    todo: column(todo.filter((card) => !card.doing)),
    doing: column(todo.filter((card) => card.doing)),
    done: column(toolList(data.board.done).filter((card) => card.kind === 'task'))
  }
}

// This month's voice spend as the model may say it. A month it does not fully know - a price it has
// no source for, or conversations a device let go - is never a plain number: "at least" when there
// is one, "unknown" when it would be $0.
function voiceSpendSaid(spend) {
  if (!spend || typeof spend.usd !== 'number') return 'unknown'
  const complete = !(Array.isArray(spend.incomplete) && spend.incomplete.length) && !wholeCount(spend.droppedOnDevice)
  const usd = Math.round(spend.usd * 100) / 100
  return {
    estimate: true,
    complete,
    ...(complete ? { thisMonthUsd: usd } : usd > 0 ? { thisMonthUsdAtLeast: usd } : { thisMonthUsd: 'unknown' }),
    conversations: wholeCount(spend.conversations),
    waitingOnDevice: wholeCount(spend.waitingOnDevice),
    droppedOnDevice: wholeCount(spend.droppedOnDevice),
    keptByBoard: spend.keptByBoard !== false
  }
}

function usageNow({ data, spend, zone }) {
  const voiceSpend = voiceSpendSaid(spend)
  const usage = data?.usage
  if (!usage || usage.status !== 'ok') return { status: 'unknown', voiceSpend }
  const services = [['claude', 'Claude'], ['codex', 'Codex']]
    .filter(([key]) => usage[key] && typeof usage[key] === 'object')
    .map(([key, service]) => {
      const reading = usage[key]
      const limits = reading.limits && typeof reading.limits === 'object' ? reading.limits : {}
      return {
        service,
        computer: toolText(reading.computer),
        plan: reading.plan?.status === 'found' ? toolText(reading.plan.name) : 'unknown',
        unofficial: limits.source === 'unofficial-live' || limits.source === 'claude-code-saved',
        takenAt: toolTime(reading.takenAt, zone),
        stale: reading.stale === true,
        windows: limits.status === 'found'
          ? toolList(limits.windows).map((limit) => ({
            label: toolText(limit.label),
            usedPercent: typeof limit.usedPercent === 'number' && !limit.resetSinceReading ? Math.round(limit.usedPercent) : null,
            resetsAt: toolTime(limit.resetsAt, zone)
          }))
          : []
      }
    })
  return { status: 'ok', services, voiceSpend }
}

function connectionsNow({ data, zone }) {
  const computers = data?.found?.status === 'ok' ? toolList(data.found.computers) : null
  const hermes = data?.hermes?.status === 'ok' ? toolList(data.hermes.computers) : null
  if (!computers && !hermes) return { status: 'unknown' }
  const servers = (block, key) => {
    if (block?.status !== 'found') return toolText(block?.status) || 'unknown'
    const list = toolList(block.servers)
    const named = (state) => toolFew(list.filter((server) => server[key] === state), (server) => toolText(server.name))
    return key === 'state'
      ? { connected: list.filter((server) => server.state === 'connected').length, needsSignIn: named('needs sign-in'), failed: named('failed') }
      : { found: list.filter((server) => server.state === 'found').length }
  }
  return {
    computers: (computers ?? []).map((computer) => ({
      computer: toolText(computer.computer),
      checkedAt: toolTime(computer.takenAt, zone),
      stale: computer.freshness === 'stale',
      claude: servers(computer.claude, 'state'),
      codex: servers(computer.codex, 'codex')
    })),
    hermes: (hermes ?? [])
      .filter((computer) => ['install', 'gateway', 'profiles'].some((part) => computer?.[part]?.status === 'found'))
      .map((computer) => ({ computer: toolText(computer.computer), running: computer.alive === 'running', words: toolText(computer.aliveLabel) }))
  }
}

// `view` is { data, names, now, timeZone, hermes, spend }: the board's payload, the owner's names
// for agents, the time and this device's time zone, whether this board shows Hermes, and this month's
// voice spend if the meter has one. Every answer but open_screen's starts with the zone and the local
// time now, so "today" and "in an hour" mean the owner's.
function voiceToolAnswer(name, args, view) {
  const safe = { data: null, names: null, now: Date.now(), hermes: false, spend: null, ...view }
  safe.zone = voiceZone(safe.timeZone) ?? 'UTC'
  const when = { timeZone: safe.zone, localNow: toolClock(safe.now, safe.zone) }
  switch (name) {
    case 'open_screen': {
      const screen = args?.screen
      const allowed = VOICE_PAGE_SCREENS.filter((one) => one !== 'hermes' || safe.hermes)
      return typeof screen === 'string' && allowed.includes(screen)
        ? { opened: screen }
        : { error: 'There is no screen with that name on this board.' }
    }
    case 'team_status': return toolFits({ ...when, ...teamStatus(safe) })
    case 'whats_due': return toolFits({ ...when, ...whatsDue(safe, args) })
    case 'task_board': return toolFits({ ...when, ...taskBoard(safe) })
    case 'usage': return toolFits({ ...when, ...usageNow(safe) })
    case 'connections_status': return toolFits({ ...when, ...connectionsNow(safe) })
    default: return { error: 'There is no tool with that name.' }
  }
}

// --- "is it done?" (job_status) ---
// Answered from the board, re-checked first by the page, and from this device's own log of the orders
// it sent. A run order is matched to the newest run of that job that began no earlier than two minutes
// before it was sent (a routine stamps its start from its own clock); a task order to the card with the
// same title. Never a guess: an order nothing has answered yet says so, with when it was sent.
const ORDER_RUN_SLACK_MS = 120_000
const FINISHED_BADLY = ['failed', 'blocked', 'partial']
const firstSentence = (value) => toolText(toolText(value).split(/(?<=[.!?])\s/)[0])

function runSaid(run, running, zone) {
  if (running) return { state: 'running', since: toolTime(run.started_at, zone) }
  if (FINISHED_BADLY.includes(run.status)) {
    return { state: 'did not finish', status: toolText(run.status), at: toolTime(run.finished_at ?? run.started_at, zone), summary: firstSentence(run.summary) }
  }
  return { state: 'finished', status: toolText(run.status) || 'ok', at: toolTime(run.finished_at ?? run.started_at, zone), summary: firstSentence(run.summary) }
}

// --- an order sent to the owner's Mac (the Mac mailbox, FIRE_MODE=mailbox) ---
// The Mac pushes a status file with each order it does (data.mailbox, shaped by the board), matched by
// the order's id - never by words. What is said of it is the board's own: a time, a pace and one of the
// fixed reasons below, which are the shared contract's (tests/fixtures/mailbox-parity.json, status
// reasons; KEEP IN SYNC - tests/mailbox-voice.test.mjs holds the two together).
const MAC_REASON_WORDS = {
  refused: {
    expired: 'it expired before your Mac picked it up',
    'wrong-repo': 'it was meant for another team repo',
    'wrong-runner': 'it was meant for another computer',
    'not-allowed': 'that kind of order is not on its list',
    'job-not-allowed': 'that job is not on its list',
    'daily-limit': 'it has done all the orders it allows today',
    'not-valid': 'the order did not pass its checks',
    'card-not-found': 'that card is not in the team repo',
    'no-such-row': 'no row in proposals.yml matches it',
    'several-rows': 'more than one row in proposals.yml matches it',
    'no-workflow': 'that job has no workflow file',
    'not-ready': 'its daily check found a problem with its login or settings'
  },
  failed: {
    'change-refused': 'the change touched files it may not touch',
    'tool-refused': 'Claude tried a tool it may not use',
    'claude-failed': 'Claude stopped with an error',
    'timed-out': 'it ran past its time limit',
    'run-log-refused': 'its run log did not pass the check',
    'push-failed': 'the change could not be pushed'
  }
}
const MAC_ORDER_ID = /^[0-9a-f]{32}$/
// The pace the board said when the order was sent; anything else is the board's default, never a guess.
const macPace = (value) => (Number.isInteger(value) && value >= 60 && value <= 3600 ? value : 600)
// After this many of the Mac's checks with no sign of it, the order is waiting, not just sent.
const MAC_CHECKS_BEFORE_WAITING = 3
const macReason = (state, why) => (typeof why === 'string' && Object.hasOwn(MAC_REASON_WORDS[state] ?? {}, why) ? MAC_REASON_WORDS[state][why] : null)

// { state, said } for an order sent to the Mac, from its status file first; done: true when the Mac
// says it finished, so the card or the run can say the rest. null for an order that did not go to the
// Mac, or whose id or expiry is not the board's own shape.
function macOrderSaid(order, data, now, zone) {
  if (order?.via !== 'mac' || typeof order.id !== 'string' || !MAC_ORDER_ID.test(order.id)) return null
  const expires = typeof order.expiresAt === 'string' ? Date.parse(order.expiresAt) : NaN
  const sentAt = typeof order.sentAt === 'string' ? Date.parse(order.sentAt) : NaN
  if (!Number.isFinite(expires) || !Number.isFinite(sentAt)) return null
  const entry = toolList(data?.mailbox?.computers).flatMap((computer) => toolList(computer.orders)).find((one) => one.id === order.id)
  if (entry?.state === 'claimed') return { state: 'picked up by your Mac', said: `Your Mac picked it up at ${toolTime(entry.at, zone)}.` }
  if (entry?.state === 'running') return { state: 'running on your Mac', said: `Your Mac picked it up at ${toolTime(entry.startedAt ?? entry.at, zone)} and is running it.` }
  if (entry?.state === 'refused') return { state: 'refused by your Mac', said: `Your Mac refused it: ${macReason('refused', entry.why) ?? 'it did not say why'}.` }
  if (entry?.state === 'failed') {
    const why = macReason('failed', entry.why)
    return { state: 'failed on your Mac', said: `Your Mac tried and it failed${why ? `: ${why}` : ''}. Nothing changed on the board.` }
  }
  if (entry?.state === 'unknown') {
    const checked = entry.landed === true
      ? 'Checked afterwards: the change is on the board.'
      : entry.landed === false ? 'Checked afterwards: the change is not on the board.' : 'It has not checked yet whether the change landed.'
    return { state: 'outcome unknown', said: `Your Mac lost track of this one part-way. It will not run it again by itself. ${checked}` }
  }
  if (entry?.state === 'ok') {
    return { state: 'done on your Mac', done: true, said: `Your Mac finished it at ${toolTime(entry.finishedAt ?? entry.at, zone)}. It shows on the board after the next refresh.` }
  }
  if (now >= expires) return { state: 'expired', said: 'It expired before your Mac picked it up, so nothing ran.' }
  const pace = macPace(order.pollSeconds)
  if (now - sentAt > MAC_CHECKS_BEFORE_WAITING * pace * 1000) {
    return { state: 'waiting for your Mac', said: `Your Mac has not picked it up yet. It may be asleep or offline. If it has not started by ${toolTime(order.expiresAt, zone)}, it will not run at all.` }
  }
  const minutes = Math.max(1, Math.round(pace / 60))
  const every = minutes === 1 ? 'every minute' : `every ${minutes} minutes`
  const next = order.kind === 'run'
    ? `it should start within about ${minutes === 1 ? 'a minute' : `${minutes} minutes`}`
    : `the card should be on the board in about ${minutes + 1} minutes`
  return { state: 'sent to your Mac', said: `Sent to your Mac. It checks ${every}, so ${next}.` }
}

function jobStatusAnswer(args, { data, now = Date.now(), timeZone, log = [], fresh = false } = {}) {
  const zone = voiceZone(timeZone) ?? 'UTC'
  const when = {
    timeZone: zone,
    localNow: toolClock(now, zone),
    checkedJustNow: fresh === true,
    ...(fresh === true ? {} : { note: 'The board could not be re-checked just now, so this is what it showed before.' })
  }
  const runs = toolList(data?.runs)
  const running = toolList(data?.board?.running)
  const isRunning = (run) => running.some((one) => one.name === run.workflow && one.started_at === run.started_at)
  const which = typeof args?.which === 'string' ? args.which.trim().toLowerCase() : ''
  if (which === 'last order' || which === 'last' || which === '') {
    const order = Array.isArray(log) ? log[0] : null
    if (!order) return { ...when, which: 'last order', state: 'unknown', said: 'No order has been sent from this device yet.' }
    const sentAt = Date.parse(order.sentAt)
    const sent = { sentAt: toolTime(order.sentAt, zone) }
    // Sent to the Mac: its status file first; once it says done, the card or the run as for any order.
    const mac = macOrderSaid(order, data, now, zone)
    const fromMac = (base) => ({ ...when, ...base, state: mac.state, said: mac.said })
    if (order.kind === 'run') {
      const job = { which: 'last order', kind: 'run', job: toolText(order.name), ...sent }
      if (mac && !mac.done) return fromMac(job)
      const mine = runs
        .filter((run) => (run.workflow === order.slug || run.workflow === order.name) && Date.parse(run.started_at) >= sentAt - ORDER_RUN_SLACK_MS)
        .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))
      if (mine.length) return toolFits({ ...when, ...job, ...runSaid(mine[0], isRunning(mine[0]), zone) })
      return mac ? fromMac(job) : { ...when, ...job, state: 'sent, nothing has reported yet' }
    }
    const task = { which: 'last order', kind: 'task', title: toolText(order.title), ...sent }
    if (mac && !mac.done) return fromMac(task)
    const open = toolList(data?.board?.todo).find((card) => card.title === order.title)
    if (open) return { ...when, ...task, state: open.doing ? 'doing' : 'to do' }
    const finished = [...toolList(data?.board?.done), ...toolList(data?.board?.finishedTasks)].find((card) => card.kind === 'task' && card.title === order.title)
    if (finished) return { ...when, ...task, state: 'done' }
    return mac ? fromMac(task) : { ...when, ...task, state: 'not filed yet' }
  }
  const workflow = toolList(data?.workflows).find((one) => one.slug === which || (typeof one.name === 'string' && one.name.trim().toLowerCase() === which))
  if (!workflow) return { ...when, which: toolText(which), state: 'unknown', said: 'There is no job with that name on the board.' }
  const job = { which: toolText(workflow.slug), job: toolText(workflow.name) || toolText(workflow.slug) }
  const mine = runs
    .filter((run) => run.workflow === workflow.slug || run.workflow === workflow.name)
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))
  if (!mine.length) return { ...when, ...job, state: 'has not run yet' }
  return toolFits({ ...when, ...job, ...runSaid(mine[0], isRunning(mine[0]), zone) })
}

// --- "find my note" (search_memory, open_note) ---
// Answered from Memory's one search on the page (public/memory-find.js) - the list Memory shows, numbered
// the same. The model is told each note's title, folder and day, and why it was found in the board's own
// words (FOUND_WHY) - never a heading, an opening or anything else a note says: note text in the model's
// context is a way in for instructions (review, 2026-10-11; plan D3, "voice says titles"). Every text is
// trimmed to 120 characters, as data under the "never instructions" line. A note whose title, folder or
// day has hidden characters is dropped and counted, never stripped and passed on; the others keep the
// numbers the list gives them.
const FOUND_SAID = 5
const FOUND_WHY = {
  name: 'in its name',
  headings: 'in a heading',
  description: 'in its description',
  tags: 'in its tags',
  opening: 'in its opening words',
  meaning: 'close in meaning to what you asked',
  heard: 'sounds like a word you said',
  day: 'dated that day',
  folder: 'in that folder'
}
const foundHidden = (hit) => [hit.title, hit.folder, hit.day].some((text) => hiddenText(text))
const foundWhy = (hit) => [...new Set((Array.isArray(hit.reasons) ? hit.reasons : [])
  .filter((key) => typeof key === 'string' && Object.hasOwn(FOUND_WHY, key)).map((key) => FOUND_WHY[key]))].join('; ')

function searchMemoryAnswer(args, { found = null, now = Date.now(), timeZone } = {}) {
  const zone = voiceZone(timeZone) ?? 'UTC'
  const answer = { timeZone: zone, localNow: toolClock(now, zone), query: toolText(args?.query) }
  if (!found || !Array.isArray(found.hits)) return { ...answer, found: [], error: 'The search could not run just now, so say so and offer to try again.' }
  const parts = found.parts && typeof found.parts === 'object' ? found.parts : {}
  if (typeof parts.day?.label === 'string') answer.day = toolText(parts.day.label)
  if (typeof parts.place === 'string') answer.folder = toolText(parts.place)
  const hits = toolList(found.hits)
  answer.found = []
  let dropped = 0
  hits.slice(0, FOUND_SAID).forEach((hit, at) => {
    if (foundHidden(hit)) {
      dropped += 1
      return
    }
    answer.found.push({
      n: at + 1,
      title: toolText(hit.title),
      folder: toolText(hit.folder),
      day: typeof hit.day === 'string' ? toolText(hit.day) : null,
      why: toolText(foundWhy(hit))
    })
  })
  answer.more = Math.max(0, hits.length - FOUND_SAID)
  if (dropped) answer.dropped = dropped
  answer.byMeaning = found.byMeaning === 'off' ? 'off' : found.byMeaning === true
  if (found.late === true) answer.note = 'Search by meaning did not answer in 4 seconds, so these were found by their words.'
  if (typeof found.said === 'string' && found.said && !hiddenText(found.said)) answer.said = toolText(found.said)
  return toolFits(answer)
}

// open_note: number N of the last search, as the list numbers it - or a sentence for any other number.
function openNoteAnswer(args, found) {
  const hits = toolList(found?.hits).slice(0, FOUND_SAID)
  const n = args?.n
  if (!Number.isInteger(n) || n < 1 || n > hits.length) return { error: 'There is no note with that number in the last search.' }
  const hit = hits[n - 1]
  return {
    opened: foundHidden(hit) ? `note ${n}` : toolText(hit.title),
    others: hits.map((one, at) => ({ n: at + 1, one })).filter(({ n: other, one }) => other !== n && !foundHidden(one)).map(({ n: other, one }) => ({ n: other, title: toolText(one.title) }))
  }
}

// --- the owner's yes ---
// One of the two ways an order card is answered yes (voice orders, Phase 11). Only the person's own
// click on the card, or Enter or Space on it, says yes: a real Event that the browser itself marks
// isTrusted. Never the model's words, a tool's result, a page or an email the team read, a click a
// script made (isTrusted is false on those), or an object merely shaped like an event. The other way is
// the owner's own spoken yes, judged by spokenYesCounts below from the transcript of THEIR audio only.
function confirmsYes(event) {
  if (typeof Event !== 'function' || !(event instanceof Event) || event.isTrusted !== true) return false
  if (event.type === 'click') return true
  return event.type === 'keydown' && (event.key === 'Enter' || event.key === ' ')
}

// --- the model tiers a task may ask for ---
// The tiers a Claude Code agent file names in its own "model:" line. A task card may carry one (Jev's
// pick, or the owner's), and /api/fire takes only these, exactly. The page offers only the ones the
// team's agent files actually use.
const VOICE_MODEL_TIERS = ['opus', 'sonnet', 'haiku']
const inUse = (data) => (Array.isArray(data?.agents) ? data.agents : [])
  .filter((agent) => agent && typeof agent.slug === 'string' && agent.state !== 'not-in-use')
// The tiers a card offers: the ones the team's agents in use name, in tier order.
function boardModels(data) {
  const named = new Set(inUse(data).map((agent) => agent.model))
  return VOICE_MODEL_TIERS.filter((tier) => named.has(tier))
}

// --- text a person cannot see ---
// THE one rule for every title and details an order or a task card carries - this check, the spoken-
// yes rule, and /api/fire (which imports it) - so the page and the server cannot disagree. Refused,
// never stripped: hidden characters mean the words are not what they look like. A reviewer hid 31
// Unicode TAG characters spelling an instruction inside a title that showed as "Draft it" (2026-10-10).
// Hidden: format characters (zero-width, bidi overrides and isolates, tags, the soft hyphen),
// private-use and unassigned code points, and variation selectors - except the two emoji ones
// (U+FE0E, U+FE0F) straight after an emoji, and a zero-width joiner between two emoji, which is how a
// family, a coder or a flag is written. Written without lookbehind, which older Safari cannot parse.
const HIDDEN_CHAR = /[\p{Cf}\p{Co}\p{Cn}\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u
const EMOJI_CHAR = /\p{Emoji}/u
const EMOJI_PART = /\p{Extended_Pictographic}|\p{Emoji_Modifier}/u

function hiddenText(value) {
  if (typeof value !== 'string') return false
  const chars = [...value]
  for (let at = 0; at < chars.length; at += 1) {
    const char = chars[at]
    if (!HIDDEN_CHAR.test(char)) continue
    if ((char === '\uFE0E' || char === '\uFE0F') && at > 0 && EMOJI_CHAR.test(chars[at - 1])) continue
    if (char === '\u200D') {
      const before = chars[at - 1] === '\uFE0F' ? chars[at - 2] : chars[at - 1]
      if (before !== undefined && EMOJI_PART.test(before) && chars[at + 1] !== undefined && EMOJI_PART.test(chars[at + 1])) continue
    }
    return true
  }
  return false
}

// --- an order the assistant proposes, checked before any card ---
// The rules /api/fire holds a task card to - a title of 3 to 200 characters on one plain line - and a
// shorter cap on details for a spoken order; a job only when this board can fire it: its slug is one
// with a trigger link (orders.jobs) and its file says fire: true. Fire checks all of it again. A
// refusal is our own sentence and never repeats what the model sent.
const VOICE_DETAILS_MAX = 500
const ORDER_TITLE = { least: 3, most: 200 }
const ORDER_CONTROL = /[\u0000-\u001f\u007f]/

function orderFrom(name, args, { orders, data } = {}) {
  if (orders?.on !== true) return { error: 'Orders are off on this board, so nothing can be sent.' }
  if (name === 'add_task') {
    if (orders.tasks !== true) return { error: 'Task cards are not set up on this board: there is no task-intake routine.' }
    const title = typeof args?.title === 'string' ? args.title.trim() : ''
    if (title.length < ORDER_TITLE.least || title.length > ORDER_TITLE.most || ORDER_CONTROL.test(title)) {
      return { error: 'A task needs a title of 3 to 200 characters on one plain line, so ask for a shorter one.' }
    }
    const raw = args?.details
    if (raw !== undefined && raw !== null && typeof raw !== 'string') return { error: 'The details of a task must be words.' }
    const details = typeof raw === 'string' ? raw.trim() : ''
    if (details.length > VOICE_DETAILS_MAX) return { error: `The details of a task can be at most ${VOICE_DETAILS_MAX} characters by voice.` }
    // The words as sent, before any trimming: a hidden character at either end (a BOM) is still hidden.
    if (hiddenText(args?.title) || hiddenText(raw)) {
      return { error: 'That task has characters in it nobody can see, so it cannot be sent. Ask for it again in plain words.' }
    }
    // Who, and on which tier, when the person named them: kept only if the card offers them - an agent
    // in use, a tier one of them names. Anything else is as if nothing was said.
    const agent = typeof args?.agent === 'string' && inUse(data).some((one) => one.slug === args.agent) ? args.agent : ''
    const model = typeof args?.model === 'string' && boardModels(data).includes(args.model) ? args.model : ''
    return { order: { kind: 'task', title, ...(details ? { details } : {}), ...(agent ? { agent } : {}), ...(model ? { model } : {}) } }
  }
  if (name === 'run_job') {
    const slug = args?.workflow
    if (typeof slug !== 'string' || !Array.isArray(orders.jobs) || !orders.jobs.includes(slug)) {
      return { error: 'That job has no trigger link on this board, so it cannot be started from here.' }
    }
    const workflow = (Array.isArray(data?.workflows) ? data.workflows : []).find((one) => one?.slug === slug)
    if (!workflow) return { error: 'That job is not on the board, so it cannot be started from here.' }
    if (workflow.fire !== true) {
      return { error: 'That job is not set to be started from the board (fire: true in its file), so it cannot be started from here.' }
    }
    const named = typeof workflow.name === 'string' && workflow.name.trim() ? workflow.name.trim().slice(0, 120) : slug
    return { order: { kind: 'run', slug, name: named } }
  }
  return { error: 'There is no order with that name.' }
}

// --- the owner's spoken yes ---
// Nuno's rule (2026-10-10): a spoken yes counts only after the card appears, within 60 s, as a plain
// yes, with the microphone open and no reply playing. A trusted tap always works. In full, every one of:
//  1. the utterance began after the card appeared (the page matches the turn by its item id);
//  2. within CONFIRM_WINDOW_MS of the card appearing, and the card is still open;
//  3. the whole utterance is a plain yes (plainYes): a short affirmative and nothing else;
//  4. the microphone was on for all of it (speakers mode rests it while a reply plays), no reply sound
//     played during it, and the last one ended at least YES_QUIET_BEFORE_MS before it began - 300 ms of
//     tail, 300 ms of the server's prefix padding and about 500 ms of event delay, to be tuned live;
//  5. the echo guard did not take the turn for the assistant's own voice;
//  6. sending needs no key typed in: a typed key needs hands, so then only a tap can send.
// The answer: 'yes' sends; 'no' (a plain no, under the same echo rules) closes the card and sends
// nothing; 'unclear' is a yes-sounding turn that did not count - the card stays and the panel asks
// for a tap; null is a turn that had nothing to do with the card. It is never sent on a guess.
const CONFIRM_WINDOW_MS = 60_000
const YES_QUIET_BEFORE_MS = 1100
// After a send, the same order proposed again within this long is not shown again: it is on its way.
const DOUBLE_SEND_MS = 15_000

// The utterance as words: lower case, no punctuation, single spaces. Apostrophes stay ("don't").
const spokenWords = (text) => (typeof text === 'string'
  ? text.toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim()
  : '')
const YES_UNITS = ['yes', 'yeah', 'yep', 'yup', 'sure', 'confirm', 'do it', 'go ahead', 'send it', 'go for it']
const NO_UNITS = ['no', 'nope', 'nah', 'cancel', 'cancel it', "don't", 'do not', "don't send it", 'not now', 'never mind', 'stop']
const POLITE = ['please', 'thanks', 'thank you']
const SAID_MOST_WORDS = 5

// Whether the words are made only of these units (and polite words), word by word from the start, with
// at least one unit, and short.
function onlyUnits(words, units) {
  const tokens = words ? words.split(' ') : []
  if (!tokens.length || tokens.length > SAID_MOST_WORDS) return false
  const phrases = [...units, ...POLITE].map((unit) => unit.split(' ')).sort((a, b) => b.length - a.length)
  let found = false
  for (let at = 0; at < tokens.length;) {
    const match = phrases.find((phrase) => phrase.every((word, n) => tokens[at + n] === word))
    if (!match) return false
    if (!POLITE.includes(match.join(' '))) found = true
    at += match.length
  }
  return found
}

// What a spoken yes may approve at all (the coordinator's decision, 2026-10-10): a job run - a fixed
// job, no words of its own - or a task card whose title is SPOKEN_TITLE_MAX characters or less and has
// no details. Anything longer was not all heard before the yes, so it takes a tap.
const SPOKEN_TITLE_MAX = 80
function spokenYesFits(order) {
  if (order?.kind === 'run') return typeof order.slug === 'string' && order.slug.length > 0
  if (order?.kind !== 'task' || typeof order.title !== 'string') return false
  return order.title.length <= SPOKEN_TITLE_MAX && !order.details && !hiddenText(order.title)
}

const plainYes = (text) => onlyUnits(spokenWords(text), YES_UNITS)
const plainNo = (text) => onlyUnits(spokenWords(text), NO_UNITS)
const soundsLikeYes = (text) => YES_UNITS.some((unit) => ` ${spokenWords(text)} `.includes(` ${unit} `))

function spokenYesCounts(heard) {
  const { utterance, card, mic, sound, keyReady, now } = heard ?? {}
  if (!utterance || typeof utterance !== 'object' || !card || typeof card !== 'object') return null
  if (typeof utterance.transcript !== 'string' || card.open !== true) return null
  const started = utterance.startedAt
  if (!Number.isFinite(started) || !Number.isFinite(card.openedAt) || !Number.isFinite(now)) return null
  if (started <= card.openedAt || now - card.openedAt > CONFIRM_WINDOW_MS) return null
  const quiet = mic?.mutedDuring === false && sound?.playingDuring === false &&
    (sound?.endedAt === null || (Number.isFinite(sound?.endedAt) && started - sound.endedAt >= YES_QUIET_BEFORE_MS))
  const own = quiet && utterance.suspect === false
  if (own && plainNo(utterance.transcript)) return 'no'
  if (own && keyReady === true && plainYes(utterance.transcript)) return 'yes'
  return soundsLikeYes(utterance.transcript) ? 'unclear' : null
}

// voice-page:end

/* ---------- Talk to the board: the orb and the sheet ----------
   Tap the orb and talk; the board answers out loud from what it already shows. The orb sits
   bottom-right on every screen, drawn only when /api/brand says voice is on - which needs
   OPENAI_API_KEY, and EDIT_KEY on a board open to everyone - and never otherwise: with voice off
   there is nothing to tap and Make it yours says why. The sheet above it says, in words, what is
   happening, what it heard, what it is saying and what this conversation has cost so far.

   Everything the assistant or a caption says is put on the page with textContent, never as markup
   (tests/voice-ui.test.mjs reads the source to hold that). The focus never moves on its own. */

const VOICE_OFF = { on: false, why: '', mouth: 'openai', note: '' }
// What /api/brand said about voice: off - nothing drawn at all - unless it said exactly on.
let voiceInfo = VOICE_OFF
// The live call, while there is one.
let voiceSession = null

function parseVoice(answer) {
  const voice = isRecord(answer) && isRecord(answer.voice) ? answer.voice : null
  const words = (value) => (typeof value === 'string' ? value : '')
  if (localVoiceOn()) return { on: true, why: '', mouth: 'local', note: '' }
  if (voice?.on !== true) return { ...VOICE_OFF, why: words(voice?.why) }
  return { on: true, why: '', mouth: voice.mouth === 'fish' ? 'fish' : 'openai', note: words(voice.note) }
}

// The name the orb and the sheet use: the one given in Make it yours, or "your assistant".
const voiceName = () => (brand?.assistantName?.trim() ? brand.assistantName.trim() : 'your assistant')

const voiceWords = (state, name = voiceName()) => ({
  idle: `Talk to ${name}`,
  connecting: 'Connecting…',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking - talk to interrupt',
  ended: 'Ended. Tap the orb to talk again.'
})[state] ?? ''

// Speakers or headphones, on a computer: "I'm on headphones" is remembered on this device.
const VOICE_HEADPHONES_STORE = 'agent-cockpit-voice-headphones'
const VOICE_DEBUG_STORE = 'agent-cockpit-voice-debug'
const voiceOnHeadphones = () => readStore(VOICE_HEADPHONES_STORE) === 'on'
const VOICE_MODE_WORDS = {
  speakers: 'Speakers mode: the microphone rests while it talks, so tap the orb or press Space to interrupt.',
  headphones: 'Headphones mode: talk over it to interrupt.'
}

const VOICE_MOUTH_WORDS = {
  openai: 'Speaking with OpenAI\'s voice - add Fish for your own voice.',
  fish: 'Speaking with your Fish voice.',
  local: 'Listening and speaking on this computer: nothing is sent to OpenAI.'
}

// Whether this browser can do it at all - a microphone and WebRTC - asked of what is there, never of
// the browser's name.
const VOICE_NO_MIC = 'This browser cannot use a microphone for the board, so talking is off here. Try Safari on an iPhone, or Chrome.'
const voiceCanListen = (deps) =>
  Boolean(typeof deps?.mediaDevices?.getUserMedia === 'function' && (typeof deps?.RTCPeerConnection === 'function' || localVoiceOn()))

// This device's own time zone, which is where the owner is when they talk to it.
const voiceTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone ?? null

// The names the person may say: the assistant's, the owner's, and each agent's - its name on the card
// and its slug as words. Only what the board already shows; the server holds each to the name rule.
function voiceNamesOnBoard() {
  const names = []
  const add = (value) => {
    if (typeof value === 'string' && value.trim() && !names.includes(value.trim())) names.push(value.trim())
  }
  add(brand?.assistantName)
  add(data?.owner?.name)
  for (const agent of Array.isArray(data?.agents) ? data.agents : []) {
    if (typeof agent?.slug !== 'string') continue
    add(displayName(agent.slug))
    add(agent.slug.replace(/-/g, ' '))
  }
  // Memory's top folders, so "in my inbox" is heard right the first time (the server keeps its caps).
  for (const file of Array.isArray(data?.memory?.files) ? data.memory.files : []) {
    if (typeof file?.path === 'string' && file.path.includes('/')) add(file.path.slice(0, file.path.indexOf('/')))
  }
  return names.slice(0, 24)
}

// What the voice code reaches for in the browser, in one place, so the tests can hand in their own.
function voiceDeps() {
  // A mouse means a computer, where speakers and microphone sit together: speakers mode's ground,
  // and - on headphones - the echo guard's.
  const finePointer = window.matchMedia?.('(pointer: fine)')?.matches === true
  return {
    mediaDevices: typeof navigator === 'undefined' ? undefined : navigator.mediaDevices,
    RTCPeerConnection: window.RTCPeerConnection,
    AudioContext: window.AudioContext ?? window.webkitAudioContext,
    // Kept in the dock, so it is in the page (an iPhone plays a call's sound more reliably from an
    // element that is), and taken out again when the call ends.
    createAudio() {
      const audio = document.createElement('audio')
      audio.autoplay = true
      audio.setAttribute('playsinline', '')
      el('voice-dock').appendChild(audio)
      return audio
    },
    // The person tapped, so a missing edit key may be asked for - once, as every change asks. Sent as
    // JSON: Vercel hands a function no application/sdp body at all.
    // echoGuardHere lets the session ask for the transcript the echo guard reads only where it runs: a
    // computer on headphones. The names on this board are spelling hints for that transcript, and a
    // computer on its own speakers is a far microphone.
    startCall: (sdp) => storeWrite('/api/voice-session', JSON.stringify({
      sdp,
      echoGuardHere: finePointer && voiceOnHeadphones(),
      names: voiceNamesOnBoard(),
      micDistance: finePointer && !voiceOnHeadphones() ? 'far' : 'near',
      timeZone: voiceTimeZone()
    }), 'application/json'),
    view: () => ({ data, names: brand?.names ?? {}, now: Date.now(), timeZone: voiceTimeZone(), hermes: hermesShown(), spend: voiceSpendNow() }),
    openScreen: (screen) => { location.hash = `#${screen}` },
    prices: () => voiceMeter?.prices ?? null,
    saveOutbox: (entry) => writeStore(VOICE_OUTBOX_STORE, JSON.stringify(outboxPut(readOutbox(readStore(VOICE_OUTBOX_STORE)), entry))),
    // The call is over: let it go, and report it - the one report a conversation sends.
    onEnd: () => {
      voiceSession = null
      sendVoiceReports()
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    cancelOnBargeIn: VOICE_CANCEL_ON_BARGE_IN,
    finePointer,
    headphones: voiceOnHeadphones,
    now: () => Date.now(),
    // The orb's glow follows the reply's loudness only where the device has not asked for less motion.
    reducedMotion: () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true,
    requestAnimationFrame: (fn) => window.requestAnimationFrame(fn),
    cancelAnimationFrame: (id) => window.cancelAnimationFrame(id),
    // A developer's machine - the board served from this computer, or VOICE_DEBUG_STORE switched on
    // here - where the page logs how long the first sound took.
    debug: () => ['localhost', '127.0.0.1'].includes(location.hostname) || readStore(VOICE_DEBUG_STORE) === 'on',
    // Orders go the way the board's buttons go: postFire, which asks for the fire key once - on a tap
    // only, never for a spoken yes.
    dispatch: (body, options) => postFire(body, options),
    fireKeyHeld: () => {
      try { return Boolean(sessionStorage.getItem(FIRE_KEY_STORE)) } catch (error) { return false }
    },
    saveOrder: (entry) => writeStore(VOICE_ORDERS_STORE, JSON.stringify([entry, ...voiceOrdersLog()].slice(0, VOICE_ORDERS_KEPT))),
    ordersLog: voiceOrdersLog,
    // The Readiness wall's own check: one small call when nothing changed, the new board when it has.
    recheck: () => recheckBoardNow(),
    // "Find my note": Memory's one search (memory-find.js), the list it showed, and number N of it.
    findNotes: (query) => memoryVoiceFind(query),
    lastFound: () => (typeof memoryVoiceList === 'function' ? memoryVoiceList() : null),
    openNote: (n) => typeof memoryOpenFound === 'function' && memoryOpenFound(n),
    // Jev's suggestion of who should do a task (only when the board has it switched on). A change like
    // any other - JSON, with the edit key when there is one - but never a prompt mid-card: anything
    // but a clean answer is no suggestion, and the orchestrator routes.
    routeTask: async (body) => {
      try {
        const response = await fetch('/api/route-task', { method: 'POST', headers: writeHeaders('application/json'), body: JSON.stringify(body) })
        return response.ok ? await answerOf(response) : null
      } catch (error) {
        return null
      }
    },
    fish: fishMouth({
      speak: (body, signal) => fetch(localVoiceOn() ? '/api/local-voice/speak' : '/api/speak', { method: 'POST', headers: writeHeaders('application/json'), body: JSON.stringify(body), signal }),
      now: () => Date.now()
    })
  }
}

// The sheet first, so it sits above the orb in the column the dock lays out.
function voiceDockHtml() {
  const name = escapeHtml(voiceName())
  const able = voiceCanListen(voiceDeps())
  const mouth = VOICE_MOUTH_WORDS[voiceInfo.mouth] + (voiceInfo.note ? ` ${voiceInfo.note}` : '')
  // Only a computer chooses: a phone always talks over, which its echo cancelling is built for.
  const headphones = voiceOnHeadphones()
  const mode = voiceDeps().finePointer
    ? `<p class="voice-mode" id="voice-mode">${escapeHtml(VOICE_MODE_WORDS[headphones ? 'headphones' : 'speakers'])}</p>
      <button class="fire voice-toggle" type="button" id="voice-headphones" aria-pressed="${headphones}">${escapeHtml("I'm on headphones")}</button>`
    : ''
  return `<section class="voice-sheet" id="voice-sheet" aria-label="Talking to ${name}" hidden>
      <p class="voice-state" id="voice-state" role="status" aria-live="polite"></p>
      <section class="voice-order" id="voice-order" role="group" aria-labelledby="voice-order-title" hidden>
        <h3 class="voice-order-title" id="voice-order-title"></h3>
        <p class="voice-order-what" id="voice-order-what"></p>
        <p class="voice-order-text" id="voice-order-text" hidden></p>
        <p class="voice-order-details" id="voice-order-details" hidden></p>
        <label class="voice-order-for" id="voice-order-for-label" for="voice-order-for" hidden>Who does it</label>
        <select class="voice-order-owner" id="voice-order-for"></select>
        <label class="voice-order-for" id="voice-order-model-label" for="voice-order-model" hidden>Model</label>
        <select class="voice-order-owner" id="voice-order-model"></select>
        <p class="voice-order-pick" id="voice-order-pick" hidden></p>
        <div class="voice-order-actions">
          <button class="fire voice-order-yes" type="button" id="voice-order-yes">Yes, send it</button>
          <button class="fire voice-order-no" type="button" id="voice-order-no">No</button>
        </div>
        <p class="voice-order-say" id="voice-order-say" hidden></p>
        <p class="voice-order-time" id="voice-order-time" aria-hidden="true"></p>
        <p class="voice-order-note" id="voice-order-note" role="status" aria-live="polite"></p>
      </section>
      <p class="voice-line"><span class="voice-who">You</span><span class="voice-said" id="voice-you"></span></p>
      <p class="voice-line"><span class="voice-who" id="voice-who">${name}</span><span class="voice-said" id="voice-said"></span></p>
      <p class="voice-note" id="voice-note" role="status" aria-live="polite"></p>
      <p class="voice-cost" id="voice-cost"></p>
      <p class="voice-mouth">${escapeHtml(mouth)}</p>
      ${mode}
      <button class="fire voice-stop" type="button" id="voice-stop">Stop</button>
    </section>
    <button class="voice-orb" type="button" id="voice-orb" data-state="idle" aria-pressed="false" aria-controls="voice-sheet"${able ? '' : ' aria-disabled="true"'} title="${able ? `Talk to ${name}` : escapeHtml(VOICE_NO_MIC)}">
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>
      <span class="visually-hidden" id="voice-label">Talk to ${name}</span>
    </button>`
}

// Drawn when the board is drawn, and only then - and never while a call is live: a reading of the
// repo redraws every screen, and redrawing the sheet mid-call would wipe what was said.
function renderVoiceDock() {
  const dock = el('voice-dock')
  document.body.classList.toggle('voice-on', voiceInfo.on)
  if (voiceSession) return
  if (!voiceInfo.on) {
    document.body.classList.remove('voice-open')
    dock.hidden = true
    dock.innerHTML = ''
    return
  }
  dock.hidden = false
  dock.innerHTML = voiceDockHtml()
}

// Every change the sheet shows, in words, and the orb's state for its shape. `live` is whether a
// call is open, which is what aria-pressed says and what turns Stop into Close.
const voiceUi = {
  show(state, { words, live = Boolean(voiceSession) } = {}) {
    const orb = el('voice-orb')
    orb.dataset.state = state
    orb.setAttribute('aria-pressed', String(live))
    el('voice-sheet').hidden = state === 'idle' && !live
    document.body.classList.toggle('voice-open', !el('voice-sheet').hidden)
    el('voice-state').textContent = words ?? voiceWords(state)
    el('voice-stop').textContent = live ? 'Stop' : 'Close'
  },
  you(text) { el('voice-you').textContent = text },
  said(text) { el('voice-said').textContent = text },
  cost(text) { el('voice-cost').textContent = text },
  note(text) { el('voice-note').textContent = text },
  who(name) { el('voice-who').textContent = name },
  level(value) { el('voice-orb')?.style.setProperty('--voice-level', String(value)) },
  // The order card: `card` is { heading, what, text, details, owners: [{ value, label }], owner, pick,
  // sayYes }, or null to take it away. Every word is set as text; the owner list is built from option
  // elements, never markup. Nothing here moves the focus: the person finds the card, it does not find them.
  order(card) {
    const box = el('voice-order')
    const owners = card && Array.isArray(card.owners) ? card.owners : []
    const set = (id, words) => {
      el(id).textContent = words ?? ''
      el(id).hidden = !words
    }
    el('voice-order-title').textContent = card?.heading ?? ''
    el('voice-order-what').textContent = card?.what ?? ''
    set('voice-order-text', card?.text)
    set('voice-order-details', card?.details)
    set('voice-order-pick', card?.pick)
    const picker = (id, label, choices, value) => {
      const select = el(id)
      select.replaceChildren(...choices.map((choice) => {
        const option = document.createElement('option')
        option.value = choice.value
        option.textContent = choice.label
        return option
      }))
      select.value = value ?? ''
      select.hidden = choices.length === 0
      el(label).hidden = choices.length === 0
    }
    picker('voice-order-for', 'voice-order-for-label', owners, card?.owner)
    picker('voice-order-model', 'voice-order-model-label', card && Array.isArray(card.models) ? card.models : [], card?.model)
    // What the person may say: "Or say yes", why this one needs a tap, or nothing.
    el('voice-order-say').textContent = card?.say ?? ''
    el('voice-order-say').hidden = !card?.say
    // Yes carries the card it answers, so a tap can only ever send that card.
    el('voice-order-yes').dataset.card = card?.id ?? ''
    el('voice-order-time').textContent = ''
    el('voice-order-note').textContent = ''
    this.orderBusy(false)
    box.hidden = !card
    // The card is at the top of the sheet; a sheet scrolled down a long conversation is put back
    // there, so Yes is in sight on a phone. The focus stays where it was.
    if (card) el('voice-sheet').scrollTop = 0
  },
  orderTime(seconds) { el('voice-order-time').textContent = `${seconds} s to answer` },
  // Jev's picks: both pickers set, and a line each saying who and which model, and how sure it was.
  orderPick({ owner, model, words }) {
    el('voice-order-for').value = owner
    el('voice-order-model').value = model
    el('voice-order-pick').textContent = words
    el('voice-order-pick').hidden = !words
  },
  // Who does it, and on which tier, as the card says right now: the owner may have changed either.
  orderOwner() { return el('voice-order-for')?.value ?? '' },
  orderModel() { return el('voice-order-model')?.value ?? '' },
  orderNote(words) { el('voice-order-note').textContent = words },
  orderBusy(busy) {
    el('voice-order-yes').disabled = busy === true
    el('voice-order-no').disabled = busy === true
  }
}

// A tap on the orb: ends a live call, or starts one. A browser that cannot listen is told why.
function voiceTap(deps = voiceDeps()) {
  if (voiceSession) {
    // In speakers mode a tap while it talks - or just after - interrupts; otherwise it ends the call.
    if (voiceSession.handlesTap ? voiceSession.handlesTap() : voiceSession.interrupt?.()) return
    voiceSession.stop('stopped')
    return
  }
  if (!voiceCanListen(deps)) {
    voiceUi.show('error', { words: VOICE_NO_MIC, live: false })
    return
  }
  voiceSession = openVoice(deps, voiceUi)
}

// Stop ends a live call; once it has ended, the same button closes the sheet.
function voiceStopPressed() {
  if (voiceSession) voiceSession.stop('stopped')
  else voiceUi.show('idle', { live: false })
}

// "I'm on headphones", pressed: remembered on this device, said in the sheet, and told to a live call.
function toggleHeadphones() {
  const on = !voiceOnHeadphones()
  writeStore(VOICE_HEADPHONES_STORE, on ? 'on' : null)
  el('voice-headphones').setAttribute('aria-pressed', String(on))
  el('voice-mode').textContent = VOICE_MODE_WORDS[on ? 'headphones' : 'speakers']
  voiceSession?.setSpeakersMode?.(!on)
}

// Space is for typing and for pressing buttons wherever the focus is one of those.
const voiceTypingIn = (target) =>
  ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(String(target?.tagName ?? '').toUpperCase()) || target?.isContentEditable === true

document.addEventListener('click', (event) => {
  const target = event.target
  if (target?.closest?.('#voice-orb')) voiceTap()
  else if (target?.closest?.('#voice-stop')) voiceStopPressed()
  else if (target?.closest?.('#voice-headphones')) toggleHeadphones()
  // The card's Yes: the event itself goes along, so the call can check it was the person's own tap.
  else if (target?.closest?.('#voice-order-yes')) {
    voiceSession?.confirm?.(event, el('voice-order-for')?.value ?? '', target.closest('#voice-order-yes').dataset?.card ?? '', el('voice-order-model')?.value ?? '')
  }
  else if (target?.closest?.('#voice-order-no')) voiceSession?.decline?.()
})
// Space on the orb itself: a browser focuses the orb when it is clicked, and would then press it with
// Space - a tap, which can end the call. Space is the interrupt and never ends a call, so on the orb
// the browser's press is stopped, both on the way down and up.
const voiceOrbIn = (target) => Boolean(target?.closest?.('#voice-orb'))
document.addEventListener('keydown', (event) => {
  if (!voiceSession) return
  // Esc interrupts a reply in speakers mode (or just after one), and otherwise ends the call.
  // Space only ever interrupts. With an order card open, Esc is its No and nothing else.
  if (event?.key === 'Escape' && voiceSession.orderOpen?.()) {
    voiceSession.decline?.()
  } else if (event?.key === 'Escape') {
    if (!(voiceSession.handlesTap ? voiceSession.handlesTap() : voiceSession.interrupt?.())) voiceSession.stop('stopped')
  } else if (event?.key === ' ' && voiceOrbIn(event.target)) {
    event.preventDefault?.()
    voiceSession.interrupt?.()
  } else if (event?.key === ' ' && !voiceTypingIn(event.target)) {
    if (voiceSession.interrupt?.()) event.preventDefault?.()
  }
})
document.addEventListener('keyup', (event) => {
  if (voiceSession && event?.key === ' ' && voiceOrbIn(event.target)) event.preventDefault?.()
})
// A call never carries on where nobody can see it: a hidden tab, or one being closed, ends it.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && voiceSession) voiceSession.stop('hidden')
})
window.addEventListener('pagehide', () => {
  if (voiceSession) voiceSession.stop('hidden')
})

/* ---------- Talk to the board: the call ----------
   Jack's flow, on a website: the tap opens the microphone (echo-cancel, noise-suppress) and the
   sound; a WebRTC call is offered through /api/voice-session, which adds the key and the session
   on the server; then the audio and the events go straight between this page and OpenAI. OpenAI's
   own voice plays from the call's track through an <audio> element - no address is loaded, so the
   Content-Security-Policy stays as it is. The server decides you stopped talking after 450 ms of
   quiet; talking over a reply stops it.

   openVoice takes everything it reaches for in `deps`, so tests/voice-call.test.mjs runs a whole call
   against a fake browser. The page hands it voiceDeps(). */

// Whether to cancel a reply and clear its sound ourselves when the person talks over it. OpenAI's
// docs say it does both by itself over WebRTC (interrupt_response); this stays off unless the live
// proof (A2) shows a lag, and the tests cover it both ways.
const VOICE_CANCEL_ON_BARGE_IN = false

const VOICE_MIC_BLOCKED = 'The microphone is blocked for this board, so it cannot hear you. On an iPhone: Settings > Safari > ' +
  'Microphone, and allow it. In Chrome: tap the icon left of the address and allow the microphone. Then tap the orb again.'
const VOICE_MIC_MISSING = 'No microphone was found, so connect or allow one, then tap the orb again.'
const VOICE_NO_START = 'The call could not start in this browser, so tap the orb to try again.'
const VOICE_DROPPED = 'The call dropped, so tap the orb to start again.'
const VOICE_UNHEARD = 'OpenAI could not answer that, so try asking again.'
// A reply that came back with nothing in it - no sound, no words, no tool call - and that the page
// did not cancel itself. Seen live (2026-10-09): the first turn of a call got an empty response
// 367 ms after it started, and the person heard silence with nothing to say why.
const VOICE_NO_REPLY = 'No reply came back. Say it again.'
// A reply OpenAI stopped at its length limit (VOICE_REPLY_TOKENS): said under it, until the next reply.
const VOICE_CUT_SHORT = 'That answer was cut short. Ask me to go on.'
// Fish refused (its key, its credit, or no answer at all) and the call moved to OpenAI's voice. One line, once.
const VOICE_FISH_FELL_BACK = 'Your Fish voice is not working, so the rest of that answer was not spoken. Ask me again and it will use the OpenAI voice.'
// OpenAI did not take the voice switch: the call carries on in text.
const VOICE_TEXT_ONLY = 'OpenAI would not switch voices, so this call is text only. The answers are on screen.'
// What /api/speak calls a refusal that will not get better within a call.
const FISH_GIVES_UP = ['key', 'credit']
// 'down' (no answer, or a 5xx) counts: the call switches on the second in a row.
const FISH_DOWN_LIMIT = 2
// What it is doing while it looks something up: a short line for each tool it asked for, in the
// state line, so the wait between a question and its answer is not a blank on screen. The board's
// own words for each tool it defines - never the name the model sent.
const VOICE_DOING = {
  whats_due: "Checking what's due…",
  team_status: 'Checking on the team…',
  task_board: 'Reading the task board…',
  usage: 'Checking your usage…',
  connections_status: 'Checking your connections…',
  open_screen: 'Opening that screen…'
}
VOICE_DOING.add_task = 'Putting the card up…'
VOICE_DOING.run_job = 'Putting the card up…'
VOICE_DOING.job_status = 'Checking on it…'
VOICE_DOING.search_memory = 'Searching your notes…'
VOICE_DOING.open_note = 'Opening that note…'
// "Is it done?" re-checks the board first - the same one-call check the Readiness wall makes - but
// never waits more than JOB_STATUS_WAIT_MS for it, and asks GitHub at most once every
// JOB_STATUS_EVERY_MS however often it is asked.
const JOB_STATUS_WAIT_MS = 3500
const JOB_STATUS_EVERY_MS = 20_000
const VOICE_DOING_ELSE = 'Looking that up…'
// Orders by voice (Phase 11): the card's words, what the model is told in a system note, and what the
// sheet says. The model is never told an order went until the board's answer says it did.
const VOICE_ORDER_TOOLS = ['add_task', 'run_job']
const VOICE_ORDER = {
  taskHeading: 'Send to the team?',
  taskWhat: 'A task card goes to your team. It shows on the board about a minute after you say yes.',
  runWhat: 'Starts this job now. It uses one routine run.',
  // On a mailbox board the order waits for the owner's computer, which collects it every few minutes.
  taskWhatMac: 'A task card goes to your Mac, which files it for your team. It shows on the board a few minutes after you say yes.',
  runWhatMac: 'Your Mac runs this job on your own Claude plan, a few minutes after you say yes.',
  sentTaskMac: (minutes) => `The owner said yes. It was sent to their Mac, which checks ${macEvery(minutes)}: the card should be on the board in about ${minutes + 1} minutes. It is not done yet.`,
  sentRunMac: (slug, minutes) => `The owner said yes. The job ${VOICE_NOTE_SLUG.test(slug) ? `${slug} ` : ''}was sent to their Mac, which checks ${macEvery(minutes)}: it should start within about ${macWithin(minutes)}. It has not started yet.`,
  orchestrator: 'Let the orchestrator choose',
  waiting: { status: 'waiting', for: 'the owner', expiresInSeconds: CONFIRM_WINDOW_MS / 1000 },
  justSent: 'That was just sent, so it is on its way. Nothing more to do.',
  sentTask: 'The owner said yes. The task card was sent to the team; it shows on the board in about a minute.',
  // A system note is the board's own words only: never a name from the repo (a workflow's name is
  // the team's text), and never a refusal's text. A job is named by its slug, held to the slug shape.
  sentRun: (slug) => `The owner said yes. The job ${VOICE_NOTE_SLUG.test(slug) ? `${slug} ` : ''}was started.`,
  no: 'The owner said no. Nothing was sent.',
  expired: 'The card ran out after 60 seconds without a yes. Nothing was sent.',
  replaced: 'That card was replaced by a newer one. Nothing was sent for it.',
  unclear: "Didn't catch a clear yes - tap Yes.",
  sending: 'Sending it…',
  unreachable: 'the board could not be reached.',
  sayYes: 'Or say "yes".',
  tapDetails: 'This one has details, so tap Yes to send it.',
  tapLong: 'This one is long, so tap Yes to send it.',
  ownModel: "The agent's own model",
  askingJev: 'Asking Jev who should do it…'
}
// The page waits this long for Jev's picks (the board's own wait for Jev is 1.5 s), then sends the
// card as if Jev were off and says so.
const JEV_WAIT_MS = 2000
// One line each for who and which tier: a name the card offers and Jev's odds, "you chose", or the
// fallback and why. Only allow-listed names, a number and our own words: nothing Jev wrote.
function voicePickWords(agent, model) {
  const reason = (side) => (side.why === 'unsure' ? ' · Jev was not sure' : side.why ? ' · Jev did not answer in time' : '')
  const line = (label, side, fallback) => (side.pick
    ? `${label}: ${side.pick} · ${side.chose ? 'you chose' : `${side.odds}%`}`
    : `${label}: ${fallback}${reason(side)}`)
  return `${line('Agent', agent, 'the orchestrator decides')}\n${line('Model', model, "the agent's own")}`
}
const VOICE_NOTE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
// The Mac mailbox's pace, said: minutes from the seconds the board gave (macPace keeps them the board's
// own shape, or its default).
const macMinutesOf = (pollSeconds) => Math.max(1, Math.round(macPace(pollSeconds) / 60))
const macEvery = (minutes) => (minutes === 1 ? 'every minute' : `every ${minutes} minutes`)
const macWithin = (minutes) => (minutes === 1 ? 'a minute' : `${minutes} minutes`)
// What the device logs of an order the board queued for the Mac: its id, expiry and pace, each only in
// the board's own shape - otherwise nothing, and "is it done?" answers it as any other order.
function macLogFields(payload) {
  if (!isRecord(payload) || payload.via !== 'mac') return {}
  if (typeof payload.orderId !== 'string' || !MAC_ORDER_ID.test(payload.orderId)) return {}
  if (typeof payload.expiresAt !== 'string' || Number.isNaN(Date.parse(payload.expiresAt))) return {}
  return { via: 'mac', id: payload.orderId, expiresAt: new Date(Date.parse(payload.expiresAt)).toISOString(), pollSeconds: macPace(payload.pollSeconds) }
}
// Why an order was not sent, for the model: fixed words chosen by the answer's status. The person sees
// the board's own sentence in the sheet; the model never gets any text that came over the network.
function voiceRefusalWords(result) {
  const status = result?.status
  if (status === 503) return "Fire is not set up on this board: the README's Orders by voice steps switch it on."
  if (status === 401) return result?.payload?.needs === 'fire-key' ? 'The board needs its fire key, so the owner must tap Yes and type it.' : 'The owner is signed out of the board.'
  if (status === 403) return 'The board refused it.'
  if (status === 404) return 'That job or routine has no trigger link.'
  if (status === 400) return 'The board found something wrong with the order.'
  // A refused routine token is a 502 as well (api/fire.js), so 502 says both.
  if (status === 502) return 'The routine refused it or did not answer.'
  if (status === 504) return 'The routine did not answer.'
  if (status === 429) return 'The routine has reached its hourly limit, so nothing was started.'
  if (status === 0) return 'The board could not be reached.'
  return `The board answered ${Number.isInteger(status) && status > 0 && status < 1000 ? status : 'nothing'}.`
}
// After any card appears or changes, Yes waits this long: a tap aimed at the card that was there a
// moment ago must not land on the one that replaced it.
const CARD_SETTLE_MS = 800
// The orders sent from this device, newest first, for "is it done?": at most ten, kept on the device.
const VOICE_ORDERS_STORE = 'agent-cockpit-voice-orders'
const VOICE_ORDERS_KEPT = 10
function voiceOrdersLog() {
  let parsed = null
  try { parsed = JSON.parse(readStore(VOICE_ORDERS_STORE) ?? 'null') } catch (error) { parsed = null }
  const text = (value) => typeof value === 'string' && value.length <= 200
  return (Array.isArray(parsed) ? parsed : []).filter((entry) => isRecord(entry) && text(entry.sentAt) && !Number.isNaN(Date.parse(entry.sentAt)) &&
    ((entry.kind === 'task' && text(entry.title)) || (entry.kind === 'run' && text(entry.slug) && text(entry.name)))).slice(0, VOICE_ORDERS_KEPT)
    // An order sent to the Mac keeps its id, expiry and pace only in the board's own shape.
    .map(({ via, id, expiresAt, pollSeconds, ...entry }) => ({ ...entry, ...macLogFields({ via, orderId: id, expiresAt, pollSeconds }) }))
}
// What the board said orders may do on this call (api/_orders.js, ordersView), or off.
function voiceOrdersFrom(raw) {
  if (!isRecord(raw) || raw.on !== true) return { on: false }
  return {
    on: true,
    tasks: raw.tasks === true,
    jobs: Array.isArray(raw.jobs) ? raw.jobs.filter((slug) => typeof slug === 'string').slice(0, 40) : [],
    key: raw.key === 'public' ? 'public' : 'fire-key',
    spokenYes: raw.spokenYes === true,
    jev: raw.jev === true,
    ...(raw.via === 'mac' ? { via: 'mac' } : {})
  }
}
const voiceDoing = (calls) =>
  [...new Set(calls.map((call) => (Object.hasOwn(VOICE_DOING, call.name) ? VOICE_DOING[call.name] : VOICE_DOING_ELSE)))].join('\n')
const VOICE_OUTBOX_STORE = 'agent-cockpit-voice-outbox'
// The echo guard. On a computer on speakers, its own voice can reach the microphone however well the
// browser cancels echo: the live test (desktop, quiet room, 2026-10-09) heard "It happened.", "Still
// fight.", "Adios." 1.3 to 1.5 s into replies, which cut them off and set it answering itself. A
// turn that starts within this long of the reply's sound, and turns out to be under ECHO_MOST_WORDS
// words, is taken for that: the response started for it is cancelled, the turn deleted so the model
// never sees it, and the reply asked for again - once per real question, so an echo that keeps
// coming cannot keep paying for replies. Echo turns never restart the idle hang-up. The clock starts
// when a reply's sound starts (OpenAI's voice, or Fish's first piece) and stops when it ends. Only
// with a mouse (a computer), and only when VOICE_ECHO_GUARD is not off. Barge-in is untouched - still
// instant, on every device - so a real short "stop" in that first second and a half is the one thing
// it can mistake, and the README says to use Stop or Esc there.
const ECHO_WINDOW_MS = 1500
const ECHO_MOST_WORDS = 2
// Speakers mode. On a computer the reply's sound can come back into the microphone however the
// browser cancels echo - live test #2 (2026-10-09) ran through Elgato Wave Link, a virtual output and
// its own microphone input, which the echo canceller cannot reach, and the assistant kept answering
// itself. So on a computer, unless the person says they are on headphones, the microphone track is
// switched off from a reply's first sound until VOICE_MIC_TAIL_MS after its last - nothing goes to
// OpenAI meanwhile - and the orb, Esc or Space interrupts instead of talking over it. Phones keep
// talk-over: their echo cancelling is built for exactly this, and barge-in there stays instant.
const VOICE_MIC_TAIL_MS = 300
// After a reply ends (or is interrupted), a tap on the orb or Esc is still taken as an interrupt for
// this long, not as a hang-up: people react in about 400 ms, so "stop" pressed as the reply finishes
// must not end the call. Only Stop, or the orb or Esc after this, ends it. Space never does.
const VOICE_TAP_GRACE_MS = 1500
// The longest the microphone rests with no new sound before it comes back by itself. The longest
// reply anyone can set is 800 output tokens (VOICE_REPLY_TOKENS) - at most 40 s of OpenAI's voice at
// ~20 audio tokens a second - and a Fish piece is a sentence, and every new sound starts this again;
// 45 s without one means the event that ends the sound was lost, and the person must not be left
// unable to talk. It must outlast the longest reply, or the microphone opens mid-sentence.
const VOICE_MIC_MAX_REST_MS = 45_000
// Fish's pieces are scheduled ahead on the AudioContext clock, so their end is known: the safety
// then waits for the last queued piece to finish, plus this, rather than 30 s from each queueing -
// 25 pieces queued at once play for 37.5 s, and the microphone must not open in the middle.
const VOICE_MIC_REST_MARGIN_MS = 5_000
const VOICE_SPEAKING_TAP = 'Speaking - tap the orb or press Space to interrupt'
// How long a reply held for the person's turn waits for that turn's own response before it is asked
// for anyway, so a turn that never gets one cannot leave the tool outputs unanswered.
const VOICE_REPLY_WAIT_MS = 1500

// The voice meter as GET /api/voice-meter last said it, price table included; null until it answers.
let voiceMeter = null

// Why a call ended, in words.
function voiceEndWords(reason, idleMinutes) {
  if (reason === 'idle') {
    return `Ended after ${plural(idleMinutes, 'minute')} with no talking, so nothing more is spent. Tap the orb to talk again.`
  }
  if (reason === 'hidden') return 'Ended because the board was put away. Tap the orb to talk again.'
  if (reason === 'dropped') return VOICE_DROPPED
  return voiceWords('ended')
}

// Money as the sheet and the card say it: never more exact than the estimate is.
const voiceMoney = (usd) => (usd > 0 && usd < 0.01 ? 'under $0.01' : `$${usd.toFixed(2)}`)

// A sentence of our own - the board's refusal, or one of the ones above - as opposed to an error a
// browser threw, whose words are for developers.
const voiceSaid = (words) => Object.assign(new Error(words), { said: true })

// The orb's glow while a reply plays follows how loud it really is. An AnalyserNode reads the sound
// already playing - the call's own track for OpenAI's voice, Fish's pieces on their way to the
// speakers - so nothing is fetched and nothing is sent. The level, 0 to 1, rises with the voice at
// once and falls slowly, so it reads as speech rather than flicker. A device that asks for less
// motion gets no meter at all: nothing is measured, and no frame is asked for.
const VOICE_LEVEL_FALL = 0.85 // kept each frame as it falls: about half a second from loud to still
const VOICE_LEVEL_GAIN = 4 // speech is mostly 0.05 to 0.25 of full scale; this spreads it over 0 to 1

function voiceLevel(context, deps, { playing, show }) {
  if (!context?.createAnalyser || !deps.requestAnimationFrame || deps.reducedMotion?.() !== false) return null
  let analyser
  try {
    analyser = context.createAnalyser()
  } catch (error) {
    return null
  }
  analyser.fftSize = 512
  const samples = new Uint8Array(analyser.fftSize)
  let source = null
  let toSpeakers = false
  let frame = null
  let level = 0
  const tick = () => {
    frame = null
    analyser.getByteTimeDomainData(samples)
    let sum = 0
    for (const sample of samples) sum += ((sample - 128) / 128) ** 2
    const loud = playing() ? Math.min(1, Math.sqrt(sum / samples.length) * VOICE_LEVEL_GAIN) : 0
    level = Math.max(loud, level * VOICE_LEVEL_FALL)
    if (level < 0.01) level = 0
    show(Math.round(level * 100) / 100)
    if (playing() || level > 0) frame = deps.requestAnimationFrame(tick)
  }
  return {
    // OpenAI's voice: the call's own track, read here while the <audio> element plays it. Never on to
    // the speakers from here, or it would be heard twice.
    listen(stream) {
      try {
        source?.disconnect()
        source = context.createMediaStreamSource(stream)
        source.connect(analyser)
      } catch (error) {
        source = null
      }
    },
    // Fish: the node its pieces play into, which passes them on to the speakers.
    input() {
      if (!toSpeakers) analyser.connect(context.destination)
      toSpeakers = true
      return analyser
    },
    // A reply's sound has started: measure until it has ended and the glow has settled.
    wake() {
      if (frame === null) frame = deps.requestAnimationFrame(tick)
    },
    stop() {
      if (frame !== null) deps.cancelAnimationFrame?.(frame)
      frame = null
      level = 0
      show(0)
      try { source?.disconnect() } catch (error) { /* already let go */ }
      try { analyser.disconnect() } catch (error) { /* already let go */ }
    }
  }
}

function openVoice(deps, ui) {
  const session = {
    state: 'connecting', stopped: false, turns: { current: 0 }, tally: emptyTally(), claims: null, ticket: '',
    mouth: 'openai', idleMinutes: 2, captions: true, responding: false, calls: new Map(), said: '',
    userSpeaking: false, replyOwed: false, replyRetries: 0, replyTimer: null, turnTakesReply: false,
    echoGuard: false, soundStartedAt: null, suspectTurn: false, echoRetryLeft: 1,
    speakersMode: false, micMuted: false, soundPlaying: false, tailTimer: null, restTimer: null,
    replyHadOutput: false, cancelledByUs: false, hearing: { item: null, words: '' }, heardAt: null,
    soundEndedAt: null, listenPending: null, noteIsCut: false,
    // Orders: what this call may propose, the card waiting for a yes, what was just sent, and each of
    // the person's turns as it began - when, and whether the mic rested or a reply played in it.
    orders: { on: false }, card: null, cardSeq: 0, sent: [], utterances: new Map(), hearingNow: null,
    recheckedAt: -Infinity, recheckOk: false,
    timer: null, stream: null, pc: null, channel: null, audio: null, context: null
  }
  const show = (state, words) => {
    // "Listening" only when the microphone is on: while it rests, it is said when it comes back.
    if (state === 'listening' && session.micMuted && !session.stopped) {
      session.listenPending = { words }
      return
    }
    session.listenPending = null
    session.state = state
    ui.show(state, { words: words ?? (state === 'speaking' && session.speakersMode ? VOICE_SPEAKING_TAP : undefined), live: !session.stopped })
  }
  // Decided now, at the tap: a computer, and not on headphones. The person can change it mid-call.
  session.speakersMode = deps.finePointer === true && deps.headphones?.() !== true
  session.show = show
  session.armIdle = () => armIdle()

  // The microphone, switched off at the track while a reply plays in speakers mode: nothing it hears
  // is sent. The idle hang-up waits too - the person cannot talk while it rests, so that time is not
  // their silence - and starts again when the microphone does.
  const micTracks = () => session.stream?.getAudioTracks?.() ?? session.stream?.getTracks?.() ?? []
  function restMic() {
    deps.clearTimeout(session.tailTimer)
    session.tailTimer = null
    if (session.micMuted) return
    session.micMuted = true
    for (const track of micTracks()) track.enabled = false
    deps.clearTimeout(session.timer)
    session.timer = null
  }
  function wakeMic() {
    deps.clearTimeout(session.tailTimer)
    deps.clearTimeout(session.restTimer)
    session.tailTimer = null
    session.restTimer = null
    if (!session.micMuted) return
    session.micMuted = false
    for (const track of micTracks()) track.enabled = true
    armIdle()
    // Listening, now that it is: what was put off while it rested, or a reply's end that never came.
    if (session.listenPending || (session.state === 'speaking' && !session.soundPlaying)) show('listening', session.listenPending?.words)
  }
  // A reply's sound has started (OpenAI's voice, or Fish's first piece) or ended.
  // `endsInMs`, when the sound's end is known (Fish's scheduled pieces), is how long until it finishes.
  session.soundStarted = ({ endsInMs } = {}) => {
    // On a developer's machine: the wait the person hears, from their turn ending to the reply's first
    // sound - once a turn, a number and the mouth, never anything said.
    if (session.heardAt !== null && deps.debug?.() === true) {
      console.info(`voice: first sound ${Math.round(deps.now() - session.heardAt)} ms after the person stopped talking (${session.mouth})`)
    }
    session.heardAt = null
    session.soundStartedAt ??= deps.now()
    session.soundPlaying = true
    if (session.hearingNow) session.hearingNow.soundDuring = true
    session.level?.wake()
    if (!session.speakersMode) return
    restMic()
    // Every new sound starts the safety wait again - from the end of all that is queued when that is
    // known, else VOICE_MIC_MAX_REST_MS; past it, the microphone comes back by itself.
    const wait = Number.isFinite(endsInMs) && endsInMs >= 0 ? endsInMs + VOICE_MIC_REST_MARGIN_MS : VOICE_MIC_MAX_REST_MS
    deps.clearTimeout(session.restTimer)
    session.restTimer = deps.setTimeout(() => {
      session.restTimer = null
      if (session.stopped) return
      // The sound's end was never heard: take it as ended, now - the yes rule's quiet counts from here.
      session.soundPlaying = false
      session.soundStartedAt = null
      session.soundEndedAt = deps.now()
      wakeMic()
    }, wait)
  }
  session.soundEnded = ({ finished }) => {
    session.soundStartedAt = null
    session.soundEndedAt = deps.now()
    session.soundPlaying = false
    if (session.micMuted) {
      // The tail: the last of the sound is still in the room for a moment.
      deps.clearTimeout(session.tailTimer)
      session.tailTimer = deps.setTimeout(() => {
        session.tailTimer = null
        if (!session.stopped) wakeMic()
      }, VOICE_MIC_TAIL_MS)
    } else if (finished) {
      armIdle()
    }
  }
  // Fish speaks only for a Fish session; with OpenAI's voice it is never asked anything.
  const fish = () => (session.mouth === 'fish' ? deps.fish ?? null : null)
  show('connecting')
  // A new call starts with an empty sheet: the last call's words and cost are not this one's.
  ui.you('')
  ui.said('')
  ui.cost('')
  ui.note?.('')

  // Both inside the tap itself: an iPhone allows the microphone and sound only from a person's tap.
  try {
    session.context = deps.AudioContext ? new deps.AudioContext() : null
    session.context?.resume?.()
  } catch (error) {
    session.context = null
  }
  session.level = voiceLevel(session.context, deps, {
    playing: () => session.soundPlaying && !session.stopped,
    show: (value) => ui.level?.(value)
  })
  const mic = deps.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })

  const send = (event) => {
    // Whatever cancels it - the interrupt, the echo guard, a barge-in - the reply ending empty is ours.
    if (event.type === 'response.cancel') session.cancelledByUs = true
    if (session.channel?.readyState === 'open') session.channel.send(JSON.stringify(event))
  }

  // Fish refused for good: the rest of the call is in OpenAI's voice, once, with one plain line saying so.
  // Only a Fish session that was told which OpenAI voice to use can move; anything else stays as it was.
  session.fishRefused = () => {
    if (session.stopped || session.mouth !== 'fish' || !session.fallback) return
    deps.fish?.stop(session)
    session.mouth = 'openai'
    send({
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: ['audio'],
        max_output_tokens: session.fallback.replyTokens,
        audio: { output: { voice: session.fallback.voice } }
      }
    })
    ui.note?.(VOICE_FISH_FELL_BACK)
    session.noteIsCut = false
    // Until OpenAI says session.updated, the switch is unconfirmed; an error in that time is its refusal.
    session.voiceSwitchPending = true
  }

  // No talking for idleMinutes - the person's or the assistant's - ends the call. Not a cap: a
  // forgotten tab stops costing.
  const armIdle = () => {
    deps.clearTimeout(session.timer)
    if (!session.stopped) session.timer = deps.setTimeout(() => end('idle'), session.idleMinutes * 60_000)
  }

  const saveTally = () => {
    if (!session.claims || session.local || !Object.values(session.tally).some((value) => value > 0)) return
    deps.saveOutbox({
      ticket: session.ticket,
      sid: session.claims.sid,
      at: new Date(session.claims.iat).toISOString(),
      model: session.claims.model,
      mouth: session.claims.mouth,
      ...(session.claims.fishModel ? { fishModel: session.claims.fishModel } : {}),
      // Still going until the call ends, so no report carries it half-counted.
      open: !session.stopped,
      counts: session.tally
    })
  }

  const showCost = () => {
    if (session.local) {
      ui.cost('This conversation runs on this computer: no cost.')
      return
    }
    const prices = deps.prices()
    if (!prices || !session.claims) {
      ui.cost('This conversation: no estimate yet, because the price table has not loaded.')
      return
    }
    const cost = costOf(session.tally, { model: session.claims.model, transcribeModel: prices.transcribeModel, fishModel: session.claims.fishModel }, prices)
    ui.cost(`This conversation ≈ ${voiceMoney(cost.usd)} (estimate${cost.incomplete.length ? ', incomplete' : ''})`)
  }

  // Everything that was opened, closed; the conversation's counts kept for the meter.
  function end(reason) {
    if (session.stopped) return
    session.stopped = true
    deps.clearTimeout(session.timer)
    deps.clearTimeout(session.replyTimer)
    deps.clearTimeout(session.tailTimer)
    deps.clearTimeout(session.restTimer)
    deps.fish?.stop(session)
    session.level?.stop()
    closeCard(null)
    try { session.channel?.close() } catch (error) { /* already closed */ }
    try { session.pc?.close() } catch (error) { /* already closed */ }
    for (const track of session.stream?.getTracks?.() ?? []) track.stop()
    if (session.audio) {
      session.audio.srcObject = null
      session.audio.remove?.()
    }
    try { session.context?.close?.() } catch (error) { /* already closed */ }
    saveTally()
    show(reason === 'error' ? 'error' : 'ended', reason === 'error' ? session.failure : voiceEndWords(reason, session.idleMinutes))
    deps.onEnd(reason)
  }

  function fail(error) {
    if (session.stopped) return
    session.failure = error?.said ? error.message : VOICE_NO_START
    end('error')
  }

  // A tool the model asked for, answered from the board this page already has.
  // The outputs go the moment they are ready, a request for the reply only when OpenAI can take one.
  // A batch with job_status in it waits for the board's re-check first (at most JOB_STATUS_WAIT_MS);
  // any other batch is answered at once, as it always was.
  // A batch with search_memory in it waits for the page's search first (Memory's own, which waits at most
  // 4 s for the meaning part and then opens Memory on the same list).
  function answerTools(calls, fresh = null, found = null) {
    const argsOf = (call) => {
      try { return JSON.parse(call.arguments || '{}') } catch (error) { return {} }
    }
    if (found === null && calls.some((call) => call.name === 'search_memory')) {
      Promise.all(calls.filter((call) => call.name === 'search_memory').map(async (call) => {
        const query = argsOf(call).query
        try {
          return [call.call_id, await deps.findNotes?.(typeof query === 'string' ? query.slice(0, 300) : '')]
        } catch (error) {
          return [call.call_id, null]
        }
      })).then((pairs) => {
        if (!session.stopped) answerTools(calls, fresh, new Map(pairs))
      })
      return
    }
    if (fresh === null && calls.some((call) => call.name === 'job_status')) {
      recheckBoard().then((checked) => {
        if (!session.stopped) answerTools(calls, checked, found)
      })
      return
    }
    for (const call of calls) {
      const args = argsOf(call)
      const answer = VOICE_ORDER_TOOLS.includes(call.name) ? proposeOrder(call.name, args)
        : call.name === 'job_status' ? jobStatusAnswer(args, { ...deps.view(), log: deps.ordersLog?.() ?? [], fresh: fresh === true })
          : call.name === 'search_memory' ? searchMemoryAnswer(args, { found: found?.get(call.call_id) ?? null, now: deps.now(), timeZone: deps.view().timeZone })
            : call.name === 'open_note' ? openNoteAnswer(args, deps.lastFound?.() ?? null)
              : voiceToolAnswer(call.name, args, deps.view())
      if (call.name === 'open_note') {
        if (answer.opened) deps.openNote?.(args.n)
      } else if (answer.opened) deps.openScreen(answer.opened)
      send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(answer) } })
    }
    session.replyRetries = 1
    askForReply()
  }

  // True when the board was re-checked just now. At most once every JOB_STATUS_EVERY_MS (the answer
  // then is the last one's), and never waited on longer than JOB_STATUS_WAIT_MS.
  async function recheckBoard() {
    if (deps.now() - session.recheckedAt < JOB_STATUS_EVERY_MS) return session.recheckOk
    session.recheckedAt = deps.now()
    let timer = null
    const late = new Promise((resolve) => { timer = deps.setTimeout(() => resolve(false), JOB_STATUS_WAIT_MS) })
    const checked = Promise.resolve().then(() => deps.recheck?.()).then((ok) => ok === true, () => false)
    session.recheckOk = await Promise.race([checked, late])
    deps.clearTimeout(timer)
    return session.recheckOk
  }

  // The reply to a batch of tool outputs. OpenAI refuses response.create while another response is
  // running ("Conversation already has an active response"), and its server VAD starts one of its own
  // the moment it hears a turn end - which can fall between our outputs and our request (seen live,
  // 2026-10-09). So the request goes only when no response is running and nobody is talking; else it
  // is owed, and asked once after the next response.done - unless that response answered the person's
  // own new turn, which already had the outputs, so it was the reply. Refused anyway, it is asked once
  // more after that - never again for the same batch, so it cannot loop.
  function askForReply() {
    deps.clearTimeout(session.replyTimer)
    session.replyTimer = null
    if (session.responding || session.userSpeaking) {
      session.replyOwed = true
      return
    }
    session.replyOwed = false
    send({ type: 'response.create' })
  }

  // A turn has ended with a reply still owed: its own response normally starts at once, and the reply
  // waits for that one to finish. If none starts, the reply is asked for after a short wait.
  function waitThenAsk() {
    deps.clearTimeout(session.replyTimer)
    session.replyTimer = deps.setTimeout(() => {
      session.replyTimer = null
      if (!session.stopped && session.replyOwed && !session.responding) askForReply()
    }, VOICE_REPLY_WAIT_MS)
  }

  // The turn the echo guard took for the assistant's own voice: the response the server started for it
  // stopped, the turn taken out of the conversation, and the reply it cut off asked for again, once.
  // Not the person, so its response never stands in for a tool reply (response.done, below).
  function heardItself(itemId) {
    session.turnTakesReply = false
    if (session.responding) {
      send({ type: 'response.cancel' })
      send({ type: 'output_audio_buffer.clear' })
      if (session.echoRetryLeft > 0) {
        session.echoRetryLeft = 0
        session.replyRetries = 1
        session.replyOwed = true
      }
    }
    if (typeof itemId === 'string' && itemId) send({ type: 'conversation.item.delete', item_id: itemId })
  }

  // --- orders by voice ---
  // The model proposes; the card waits; only the owner's trusted tap, or their own spoken yes under
  // spokenYesCounts, sends it, through the board's own fire path. The model hears the outcome in a
  // system note, and only then is asked to say it.
  const keyReady = () => session.orders.key === 'public' || deps.fireKeyHeld?.() === true
  const orderKey = (order) => (order.kind === 'task' ? `task:${order.title}` : `run:${order.slug}`)
  const tellModel = (text) => send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] } })
  const showOutcome = (words) => {
    session.noteIsCut = false
    ui.note?.(words)
  }

  function closeCard(said) {
    const card = session.card
    if (!card) return
    deps.clearTimeout(card.expiry)
    deps.clearTimeout(card.tick)
    deps.clearTimeout(card.settle)
    session.card = null
    ui.order?.(null)
    if (said && !session.stopped) tellModel(said)
  }

  function cardWords(order) {
    const view = deps.view()
    const names = isRecord(view?.names) ? view.names : {}
    const agents = Array.isArray(view?.data?.agents) ? view.data.agents : []
    const owners = order.kind !== 'task' ? [] : [
      { value: '', label: VOICE_ORDER.orchestrator },
      ...agents
        .filter((agent) => typeof agent?.slug === 'string' && agent.state !== 'not-in-use')
        .map((agent) => ({ value: agent.slug, label: Object.hasOwn(names, agent.slug) && names[agent.slug] ? `${names[agent.slug]} (${agent.slug})` : agent.slug }))
    ]
    const models = order.kind !== 'task' ? [] : [
      { value: '', label: VOICE_ORDER.ownModel },
      ...boardModels(view?.data).map((tier) => ({ value: tier, label: tier }))
    ]
    // A name the person said is on the card from the start; Jev is asked only about the rest.
    const named = order.agent || order.model
    const asking = order.kind === 'task' && session.orders.jev === true && !(order.agent && order.model)
    return {
      heading: order.kind === 'task' ? VOICE_ORDER.taskHeading : `Run ${order.name}?`,
      what: session.orders.via === 'mac'
        ? (order.kind === 'task' ? VOICE_ORDER.taskWhatMac : VOICE_ORDER.runWhatMac)
        : (order.kind === 'task' ? VOICE_ORDER.taskWhat : VOICE_ORDER.runWhat),
      text: order.kind === 'task' ? order.title : '',
      details: order.details ?? '',
      owners,
      owner: order.agent ?? '',
      models,
      model: order.model ?? '',
      pick: asking ? VOICE_ORDER.askingJev
        : named ? voicePickWords(order.agent ? { pick: order.agent, chose: true } : {}, order.model ? { pick: order.model, chose: true } : {})
          : '',
      // "Or say yes" only where a spoken yes can count: allowed on this board, no key to type, and an
      // order it may approve (spokenYesFits); otherwise, plainly, why this one needs a tap.
      say: session.orders.spokenYes !== true || !keyReady() ? ''
        : spokenYesFits(order) ? VOICE_ORDER.sayYes
          : order.details ? VOICE_ORDER.tapDetails : VOICE_ORDER.tapLong
    }
  }

  // A card has appeared or changed: Yes waits CARD_SETTLE_MS, and a yes must begin after this moment.
  function settle(card) {
    card.shownAt = deps.now()
    ui.orderBusy?.(true)
    deps.clearTimeout(card.settle)
    card.settle = deps.setTimeout(() => {
      card.settle = null
      if (session.card === card && !card.busy) ui.orderBusy?.(false)
    }, CARD_SETTLE_MS)
  }

  function openCard(order) {
    closeCard(VOICE_ORDER.replaced)
    session.cardSeq += 1
    const card = { id: `card-${session.cardSeq}`, order, openedAt: deps.now(), shownAt: deps.now(), busy: false, left: CONFIRM_WINDOW_MS / 1000, words: cardWords(order), expiry: null, tick: null, settle: null }
    card.words.id = card.id
    session.card = card
    ui.order?.(card.words)
    settle(card)
    ui.orderTime?.(card.left)
    const countdown = () => {
      card.left -= 1
      if (session.card !== card || card.left <= 0) return
      ui.orderTime?.(card.left)
      card.tick = deps.setTimeout(countdown, 1000)
    }
    card.tick = deps.setTimeout(countdown, 1000)
    card.expiry = deps.setTimeout(() => {
      if (session.card !== card || card.busy) return
      closeCard(VOICE_ORDER.expired)
      session.replyRetries = 1
      askForReply()
    }, CONFIRM_WINDOW_MS)
    if (order.kind === 'task' && session.orders.jev === true && !(order.agent && order.model)) suggestPicks(card)
  }

  // Jev's picks for who does a task and on which tier (the board has it switched on), asked only about
  // what the person did not name. Jev's answer is untrusted: a pick counts only if the card offers it,
  // with whole odds from 60 to 100; anything else - unsure, silent, slower than JEV_WAIT_MS - leaves the
  // orchestrator to decide, on the agent's own model, and the card says which and why. Only while the
  // card is still up; it changes the card, so Yes waits again (settle).
  async function suggestPicks(card) {
    const described = new Map((Array.isArray(deps.view()?.data?.agents) ? deps.view().data.agents : [])
      .map((agent) => [agent?.slug, typeof agent?.description === 'string' ? agent.description : '']))
    const offered = (choices) => choices.map((one) => one.value).filter(Boolean)
    const agents = card.order.agent ? [] : offered(card.words.owners).slice(0, 16).map((slug) => ({ slug, description: described.get(slug) ?? '' }))
    const models = card.order.model ? [] : offered(card.words.models)
    let timer = null
    const late = new Promise((resolve) => { timer = deps.setTimeout(() => resolve(null), JEV_WAIT_MS) })
    // Asked at once (an async function runs up to its first wait), and a throw is no answer.
    const asked = (async () => deps.routeTask?.({ title: card.order.title, ...(card.order.details ? { details: card.order.details } : {}), agents, models }))()
      .catch(() => null)
    const answer = await Promise.race([asked, late])
    deps.clearTimeout(timer)
    if (session.stopped || session.card !== card || card.busy) return
    const side = (named, said, allowed) => {
      if (named) return { pick: named, chose: true }
      const odds = said?.odds
      if (typeof said?.pick === 'string' && allowed.includes(said.pick) && Number.isInteger(odds) && odds >= 60 && odds <= 100) return { pick: said.pick, odds }
      return { pick: null, why: said?.why === 'unsure' || typeof said?.pick === 'string' ? 'unsure' : 'no answer' }
    }
    const agent = side(card.order.agent, answer?.agent, offered(card.words.owners))
    const model = side(card.order.model, answer?.model, offered(card.words.models))
    card.words.owner = agent.pick ?? ''
    card.words.model = model.pick ?? ''
    card.words.pick = voicePickWords(agent, model)
    ui.orderPick?.({ owner: card.words.owner, model: card.words.model, words: card.words.pick })
    settle(card)
  }

  // A proposal: checked first (orderFrom), then shown. The model is told it waits for the owner.
  function proposeOrder(name, args) {
    const made = orderFrom(name, args, { orders: session.orders, data: deps.view()?.data })
    if (made.error) return { error: made.error }
    const key = orderKey(made.order)
    if (session.sent.some((one) => one.key === key && deps.now() - one.at < DOUBLE_SEND_MS)) return { error: VOICE_ORDER.justSent }
    openCard(made.order)
    return { ...VOICE_ORDER.waiting }
  }

  // One send per card, whoever asks - a tap, a second tap, a spoken yes during a tap's send: the guard
  // is here, and busy is set before anything waits. True when this call started the send.
  function sendOrder(card, owner, how, model = '') {
    if (session.stopped || session.card !== card || card.busy) return false
    card.busy = true
    deliverOrder(card, owner, how, model)
    return true
  }

  async function deliverOrder(card, owner, how, model) {
    deps.clearTimeout(card.expiry)
    deps.clearTimeout(card.tick)
    deps.clearTimeout(card.settle)
    ui.orderBusy?.(true)
    ui.orderNote?.(VOICE_ORDER.sending)
    const order = card.order
    const forAgent = order.kind === 'task' && owner && card.words.owners.some((one) => one.value === owner) ? owner : ''
    const tier = order.kind === 'task' && model && card.words.models.some((one) => one.value === model) ? model : ''
    // The card's own id, with this call's: the board fires an id it has already answered only once, so a
    // double yes or a retry that reaches it twice starts one run (api/_once.js).
    const requestId = `${session.claims.sid}-${card.id}`
    const body = order.kind === 'task'
      ? { requestId, action: 'task', title: order.title, ...(order.details ? { details: order.details } : {}), ...(forAgent ? { for: forAgent } : {}), ...(tier ? { model: tier } : {}) }
      : { requestId, workflow: order.slug, action: 'run' }
    const sent = { key: orderKey(order), at: deps.now() }
    session.sent.push(sent)
    let result
    try {
      result = await deps.dispatch(body, { ask: how === 'tap' })
    } catch (error) {
      result = { ok: false, status: 0, payload: { error: VOICE_ORDER.unreachable } }
    }
    if (session.stopped) return
    closeCard(null)
    if (result?.ok) {
      deps.saveOrder?.({
        kind: order.kind,
        ...(order.kind === 'task' ? { title: order.title } : { slug: order.slug, name: order.name }),
        sentAt: new Date(sent.at).toISOString(),
        ...macLogFields(result.payload)
      })
      if (result.payload?.via === 'mac') {
        // Waiting for the owner's computer: never "started", and the pace is the board's own.
        const minutes = macMinutesOf(result.payload.pollSeconds)
        showOutcome(order.kind === 'task'
          ? `Sent to your Mac: "${order.title}". It checks ${macEvery(minutes)}, so the card should be on the board in about ${minutes + 1} minutes.`
          : `Sent to your Mac: ${order.name}. It should start within about ${macWithin(minutes)}.`)
        tellModel(order.kind === 'task' ? VOICE_ORDER.sentTaskMac(minutes) : VOICE_ORDER.sentRunMac(order.slug, minutes))
      } else {
        showOutcome(order.kind === 'task' ? `Sent: "${order.title}". It shows on the board in about a minute.` : `Started: ${order.name}.`)
        tellModel(order.kind === 'task' ? VOICE_ORDER.sentTask : VOICE_ORDER.sentRun(order.slug))
      }
    } else {
      // Not sent, so not "just sent" either: the same order may be proposed again at once.
      session.sent = session.sent.filter((one) => one !== sent)
      const words = voiceRefusalWords(result)
      const said = typeof result?.payload?.error === 'string' && result.payload.error.trim() ? result.payload.error.trim().slice(0, 300) : words
      showOutcome(`Not sent: ${said}`)
      tellModel(`Not sent: ${words} Do not say it was sent.`)
    }
    session.replyRetries = 1
    askForReply()
  }

  // The card's Yes, tapped: only a real, trusted click (or Enter or Space) by the person - confirmsYes -
  // on the Yes of THIS card (its id is on the button), once it has been up CARD_SETTLE_MS.
  function confirm(event, owner, cardId, model) {
    const card = session.card
    if (session.stopped || !card || !confirmsYes(event)) return false
    if (cardId !== card.id || deps.now() - card.shownAt < CARD_SETTLE_MS) return false
    return sendOrder(card, typeof owner === 'string' ? owner : '', 'tap', typeof model === 'string' ? model : '')
  }

  // The card's No, or Esc.
  function decline() {
    if (!session.card || session.card.busy) return false
    closeCard(VOICE_ORDER.no)
    session.replyRetries = 1
    askForReply()
    return true
  }

  // A turn's words are in: was it the owner answering the card? Only their own transcript, judged by
  // spokenYesCounts against how that turn began. A "no" turn gets the server's own reply, so the model
  // is only told; a yes is told once the board answers.
  function heardForCard(itemId, transcript) {
    const record = typeof itemId === 'string' ? session.utterances.get(itemId) : undefined
    if (record) session.utterances.delete(itemId)
    const card = session.card
    if (!record || !card || card.busy || session.orders.spokenYes !== true) return
    const verdict = spokenYesCounts({
      utterance: { startedAt: record.startedAt, transcript, suspect: record.suspect },
      card: { openedAt: card.shownAt, open: true },
      mic: { mutedDuring: record.mutedDuring },
      sound: { playingDuring: record.soundDuring, endedAt: record.soundEndedAt },
      keyReady: keyReady(),
      now: deps.now()
    })
    if (verdict === 'yes' && !spokenYesFits(card.order)) ui.orderNote?.(card.words.say || VOICE_ORDER.unclear)
    else if (verdict === 'yes') sendOrder(card, ui.orderOwner?.() ?? card.words.owner, 'spoken', ui.orderModel?.() ?? card.words.model)
    else if (verdict === 'no') closeCard(VOICE_ORDER.no)
    else if (verdict === 'unclear') ui.orderNote?.(VOICE_ORDER.unclear)
  }

  // The person started talking: over a reply, that is a new turn. OpenAI cancels the reply and cuts
  // its sound by itself; the page just listens.
  function bargeIn() {
    newTurn(session.turns)
    const replying = session.responding || session.state === 'speaking'
    if (deps.cancelOnBargeIn && replying) {
      send({ type: 'response.cancel' })
      send({ type: 'output_audio_buffer.clear' })
    }
    fish()?.bargeIn(session, send)
  }

  function onEvent(event) {
    if (session.stopped || !event || typeof event.type !== 'string') return
    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        session.userSpeaking = true
        session.heardAt = null
        // Early in the reply's sound: maybe its own voice. The words will say (the caption, below),
        // and until they do it does not count as the person talking for the idle hang-up.
        session.suspectTurn = session.echoGuard && session.soundStartedAt !== null &&
          deps.now() - session.soundStartedAt < ECHO_WINDOW_MS
        // How this turn began, for a card it may answer: kept by its item id until its words are in.
        session.hearingNow = {
          startedAt: deps.now(), mutedDuring: session.micMuted, soundDuring: session.soundPlaying,
          soundEndedAt: session.soundEndedAt, suspect: session.suspectTurn
        }
        if (typeof event.item_id === 'string') {
          session.utterances.set(event.item_id, session.hearingNow)
          if (session.utterances.size > 20) session.utterances.delete(session.utterances.keys().next().value)
        }
        if (!session.suspectTurn) armIdle()
        bargeIn()
        ui.you('')
        show('listening')
        break
      case 'input_audio_buffer.speech_stopped':
        session.userSpeaking = false
        session.hearingNow = null
        session.heardAt = deps.now()
        // A turn ending with the tool reply owed: the outputs went before it, so the response OpenAI
        // starts for it already has them.
        session.turnTakesReply = session.replyOwed
        if (!session.suspectTurn) armIdle()
        if (session.replyOwed && !session.responding) waitThenAsk()
        show('thinking')
        break
      // The person's words as they are heard, so they can see they are: the finished words replace
      // them. Not while the turn might be the assistant's own voice - its finished words decide that.
      case 'conversation.item.input_audio_transcription.delta':
        if (!session.captions || session.suspectTurn || typeof event.delta !== 'string') break
        if (event.item_id !== session.hearing.item) session.hearing = { item: event.item_id, words: '' }
        session.hearing.words += event.delta
        ui.you(session.hearing.words)
        break
      case 'conversation.item.input_audio_transcription.completed': {
        session.tally = addUsage(session.tally, event.usage, 'captions')
        saveTally()
        heardForCard(event.item_id, event.transcript)
        const suspect = session.suspectTurn
        session.suspectTurn = false
        const words = typeof event.transcript === 'string' ? event.transcript.split(/\s+/).filter(Boolean).length : 0
        if (suspect && words <= ECHO_MOST_WORDS) {
          heardItself(event.item_id)
          break
        }
        // A real turn: a new question, so an echo may cut its reply short once more.
        session.echoRetryLeft = 1
        if (suspect) armIdle()
        if (session.captions && typeof event.transcript === 'string') ui.you(event.transcript)
        break
      }
      case 'response.created':
        session.responding = true
        session.replyHadOutput = false
        session.cancelledByUs = false
        session.soundStartedAt = null
        // A response started: an owed reply now waits for it to finish, not for the clock.
        deps.clearTimeout(session.replyTimer)
        session.replyTimer = null
        session.replyTurn = session.turns.current
        session.said = ''
        // The cut-short line belongs to the last reply; an order's outcome stays until the next one.
        if (session.noteIsCut) {
          ui.note?.('')
          session.noteIsCut = false
        }
        fish()?.replyStarted(session)
        break
      case 'response.output_audio_transcript.delta':
      case 'response.output_text.delta':
        if (typeof event.delta !== 'string') break
        session.replyHadOutput = true
        session.said += event.delta
        ui.said(session.said)
        if (event.type === 'response.output_text.delta') fish()?.replyText(session, event.delta)
        else if (session.state !== 'speaking') show('speaking')
        break
      case 'response.output_text.done':
        fish()?.replyText(session, '', true)
        break
      case 'output_audio_buffer.started':
        session.replyHadOutput = true
        session.soundStarted()
        show('speaking')
        break
      // A reply's sound has ended: the echo clock stops, and the idle wait counts from here (or from
      // when the microphone comes back, in speakers mode).
      case 'output_audio_buffer.stopped':
        session.soundEnded({ finished: true })
        if (!session.responding) show('listening')
        break
      // Cut short (talked over, or cancelled): the sound has ended, but nobody finished talking.
      case 'output_audio_buffer.cleared':
        session.soundEnded({ finished: false })
        break
      case 'response.function_call_arguments.done':
        if (typeof event.call_id === 'string' && typeof event.name === 'string') session.calls.set(event.call_id, event)
        break
      case 'response.done': {
        session.responding = false
        // Empty: nothing said or heard, no message and no tool call in it. Not ours to report when the
        // page cancelled it, the person is talking over it, or a tool reply is owed after it.
        const output = Array.isArray(event.response?.output) ? event.response.output : []
        const empty = !session.replyHadOutput && session.calls.size === 0 &&
          !output.some((item) => item?.type === 'message' || item?.type === 'function_call')
        const unexplained = empty && !session.cancelledByUs && !session.userSpeaking && !session.replyOwed
        // The person's own turn (its words showed it is not an echo) has had its response, with the
        // tool outputs in hand: that was the reply. Asking for another would answer twice. One that
        // said nothing did not reply, so the reply is still asked for.
        if (session.replyOwed && session.turnTakesReply && !session.suspectTurn && !empty) {
          session.replyOwed = false
          session.replyRetries = 0
          deps.clearTimeout(session.replyTimer)
          session.replyTimer = null
        }
        session.turnTakesReply = false
        session.tally = addUsage(session.tally, event.response?.usage, 'reply')
        saveTally()
        showCost()
        for (const item of Array.isArray(event.response?.output) ? event.response.output : []) {
          if (item?.type === 'function_call' && typeof item.call_id === 'string' && typeof item.name === 'string') session.calls.set(item.call_id, item)
        }
        const calls = [...session.calls.values()]
        session.calls.clear()
        if (calls.length) {
          answerTools(calls)
          show('thinking', voiceDoing(calls))
        } else if (session.replyOwed) {
          askForReply()
          show('thinking')
        } else if (fish()) {
          fish().replyDone(session)
        } else if (session.state !== 'speaking') {
          show('listening')
        }
        if (event.response?.status === 'incomplete' && event.response?.status_details?.reason === 'max_output_tokens') {
          ui.note?.(VOICE_CUT_SHORT)
          session.noteIsCut = true
        }
        if (unexplained) {
          show('listening', VOICE_NO_REPLY)
          // The status alone, for whoever is debugging - never anything that was said.
          console.info('voice: a reply came back empty', event.response?.status ?? null, event.response?.status_details ?? null)
        }
        break
      }
      case 'session.updated':
        session.voiceSwitchPending = false
        break
      case 'error':
        if (session.voiceSwitchPending) {
          session.voiceSwitchPending = false
          ui.note?.(VOICE_TEXT_ONLY)
          session.noteIsCut = false
          show('listening')
          break
        }
        // Cancelling a reply that had already finished is not worth a word.
        if (event.error?.code === 'response_cancel_not_active') break
        // Our request for a tool reply arrived while a response was running: ask again once, after it.
        if (event.error?.code === 'conversation_already_has_active_response' || /already has an active response/i.test(String(event.error?.message ?? ''))) {
          if (session.replyRetries > 0) {
            session.replyRetries -= 1
            session.replyOwed = true
            if (!session.responding) waitThenAsk()
          }
          break
        }
        show('listening', VOICE_UNHEARD)
        break
      default:
        break
    }
  }

  async function connect() {
    let stream
    try {
      stream = await mic
    } catch (error) {
      throw voiceSaid(error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError' ? VOICE_MIC_MISSING : VOICE_MIC_BLOCKED)
    }
    session.stream = stream
    if (session.stopped) {
      for (const track of stream.getTracks()) track.stop()
      return
    }
    if (localVoiceOn()) {
      await connectLocal(stream)
      return
    }
    const pc = new deps.RTCPeerConnection()
    session.pc = pc
    session.audio = deps.createAudio()
    pc.ontrack = (event) => {
      if (!session.audio || session.stopped) return
      session.audio.srcObject = event.streams?.[0] ?? null
      if (event.streams?.[0]) session.level?.listen(event.streams[0])
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') end('dropped')
    }
    for (const track of stream.getTracks()) pc.addTrack(track, stream)
    // The events channel is made BEFORE the offer, so the offer carries it.
    const channel = pc.createDataChannel('oai-events')
    session.channel = channel
    channel.onmessage = (message) => {
      let event = null
      try { event = JSON.parse(message.data) } catch (error) { event = null }
      onEvent(event)
    }
    channel.onopen = () => {
      if (session.stopped) return
      show('listening')
      armIdle()
    }
    channel.onclose = () => end('dropped')

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    if (session.stopped) return
    let answer
    try {
      answer = await (await deps.startCall(offer.sdp)).json()
    } catch (error) {
      throw voiceSaid(error?.message || VOICE_NO_START)
    }
    if (session.stopped) return
    const claims = ticketSays(answer?.ticket)
    if (typeof answer?.sdp !== 'string' || !answer.sdp.startsWith('v=0') || !claims) throw voiceSaid(VOICE_NO_START)
    session.ticket = answer.ticket
    session.claims = claims
    session.mouth = claims.mouth
    // With Fish: the OpenAI voice to move to if Fish refuses (a name and a number from the board).
    const fallback = answer.fallback
    session.fallback = claims.mouth === 'fish' && /^[a-z]{3,20}$/.test(fallback?.voice) && Number.isInteger(fallback?.replyTokens) && fallback.replyTokens > 0
      ? { voice: fallback.voice, replyTokens: fallback.replyTokens } : null
    session.idleMinutes = Number.isInteger(answer.idleMinutes) && answer.idleMinutes >= 1 && answer.idleMinutes <= 10 ? answer.idleMinutes : 2
    session.captions = answer.captions !== false
    // The echo guard is for a computer in talk-over mode (headphones); in speakers mode the microphone
    // rests while it talks, so there is no echo to guard - and the two never act on the same turn.
    session.echoGuard = answer.echoGuard === true && deps.finePointer === true && !session.speakersMode
    session.orders = voiceOrdersFrom(answer.orders)
    if (typeof answer.name === 'string' && answer.name) ui.who(answer.name)
    if (!session.captions) ui.you('Captions are off on this board.')
    showCost()
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
  }

  // The same call, with the parts running on this computer: local/page/voice-local.js stands in for OpenAI's
  // connection. It records until silence, sends what was said to the board, and hands back the same events a
  // realtime call would (a heard turn, a reply as text, tool calls), so everything below - the yes cards, the
  // tool answers, the pieces spoken one by one - is the cloud voice's own code.
  async function connectLocal(stream) {
    let local
    try {
      local = await window.__BOARD_LOCAL_VOICE__.open({ stream, context: session.context, name: voiceName(), names: voiceNamesOnBoard(), timeZone: voiceTimeZone(), note: (words) => ui.note?.(words), resting: () => session.micMuted })
    } catch (error) {
      throw voiceSaid(error?.message || VOICE_NO_START)
    }
    if (session.stopped) {
      local.channel.close()
      return
    }
    const answer = local.answer
    const claims = ticketSays(answer?.ticket)
    if (!claims) {
      local.channel.close()
      throw voiceSaid(VOICE_NO_START)
    }
    session.local = true
    session.ticket = answer.ticket
    session.claims = claims
    session.mouth = claims.mouth
    session.idleMinutes = Number.isInteger(answer.idleMinutes) && answer.idleMinutes >= 1 && answer.idleMinutes <= 10 ? answer.idleMinutes : 2
    session.captions = true
    session.echoGuard = false
    session.orders = voiceOrdersFrom(answer.orders)
    if (typeof answer.name === 'string' && answer.name) ui.who(answer.name)
    session.channel = local.channel
    local.channel.onmessage = (message) => {
      let event = null
      try { event = JSON.parse(message.data) } catch (error) { event = null }
      onEvent(event)
    }
    local.channel.onopen = () => {
      if (session.stopped) return
      show('listening')
      armIdle()
    }
    showCost()
    local.start()
  }

  // The interrupt in speakers mode - the orb, Esc or Space. True when there was a reply to stop: it is
  // cancelled, its sound cut (or Fish stopped), and the microphone switched on at once. False when
  // nothing is being said, so the orb and Esc can go back to ending the call.
  function interrupt() {
    if (session.stopped || !session.speakersMode) return false
    if (!session.responding && !session.soundPlaying && !session.micMuted) return false
    newTurn(session.turns)
    if (session.responding) send({ type: 'response.cancel' })
    if (fish()) fish().stop(session)
    else if (session.soundPlaying) send({ type: 'output_audio_buffer.clear' })
    session.soundPlaying = false
    session.soundStartedAt = null
    session.soundEndedAt = deps.now()
    wakeMic()
    armIdle()
    show('listening')
    return true
  }

  // "I'm on headphones" pressed mid-call: talk-over from now on, the microphone listening at once.
  function setSpeakersMode(on) {
    session.speakersMode = on === true && deps.finePointer === true
    if (!session.speakersMode) wakeMic()
  }

  // What a tap on the orb, or Esc, means in speakers mode: an interrupt while a reply plays, and for
  // VOICE_TAP_GRACE_MS after one ends - a late "stop" does nothing rather than hang up. True when the
  // tap is taken; false means it ends the call, as it always has.
  function handlesTap() {
    if (interrupt()) return true
    return session.speakersMode && session.soundEndedAt !== null && deps.now() - session.soundEndedAt < VOICE_TAP_GRACE_MS
  }

  connect().catch(fail)
  return { stop: (reason) => end(reason), interrupt, handlesTap, setSpeakersMode, confirm, decline, orderOpen: () => Boolean(session.card), session }
}

/* ---------- Talk to the board: Fish's voice ----------
   Only when the owner has set up Fish. OpenAI then answers in text, and this cuts each reply into
   pieces as it arrives (takeSpeakable: the first clause at once, then a sentence at a time), sends
   each to /api/speak the moment it is cut, and plays them in the order they were cut, back to back,
   through the AudioContext the tap started - decoded from the bytes, so no address is loaded and the
   Content-Security-Policy stays as it is.

   Talking over it stops it at once: every piece playing is stopped, every piece still coming is
   aborted, the reply is cancelled, and anything that arrives for the old turn is dropped. A piece
   Fish could not speak is skipped; its words are still on screen. While the person talks, one
   warm-up keeps /api/speak ready - once a turn, once every 20 seconds at most.

   `io.speak(body, signal)` is the request to /api/speak; `io.now()` the clock. Both handed in, so the
   tests can answer each piece when they choose. */
const FISH_WARM_EVERY_MS = 20_000

function fishMouth(io) {
  const stateOf = (session) => (session.fish ??= {
    buffer: '', first: true, playhead: 0, nodes: new Set(), aborts: new Set(),
    chain: Promise.resolve(), pending: 0, replyDone: false, warmTurn: -1, warmAt: -Infinity
  })

  // Listening again once the reply is finished, nothing is left to fetch and nothing is playing.
  const settle = (session) => {
    const fish = stateOf(session)
    if (!session.stopped && fish.replyDone && !fish.pending && !fish.nodes.size && !session.responding) {
      // The reply's sound has ended: as output_audio_buffer.stopped is for OpenAI's voice.
      session.soundEnded?.({ finished: true })
      session.show('listening')
    }
  }

  function stopAll(session) {
    const fish = stateOf(session)
    for (const node of fish.nodes) {
      try { node.stop() } catch (error) { /* already stopped */ }
    }
    fish.nodes.clear()
    for (const controller of fish.aborts) controller.abort()
    fish.aborts.clear()
    fish.playhead = 0
    fish.buffer = ''
  }

  function speakPiece(session, piece, turn) {
    const fish = stateOf(session)
    // Counted as sent: Fish bills for the text it is given, in UTF-8 bytes.
    session.tally = addFishBytes(session.tally, piece)
    const controller = new AbortController()
    fish.aborts.add(controller)
    fish.pending += 1
    const fetched = io.speak({ ticket: session.ticket, text: piece }, controller.signal)
      .then(async (response) => {
        if (response?.ok) {
          session.fishDown = 0
          return response.arrayBuffer()
        }
        // The board names the refusals that will not get better; any other piece is just skipped.
        const code = await response?.json?.().then((body) => body?.code, () => null)
        if (code === 'down') session.fishDown = (session.fishDown ?? 0) + 1
        if (FISH_GIVES_UP.includes(code) || session.fishDown >= FISH_DOWN_LIMIT) session.fishRefused?.()
        return null
      })
      .catch(() => null)
      .finally(() => fish.aborts.delete(controller))
    // Each piece waits for the one cut before it, so the order is the order they were cut in -
    // and the first, with nothing before it, plays the moment it is decoded.
    fish.chain = fish.chain.then(async () => {
      const bytes = await fetched
      if (!bytes || session.stopped || session.mouth !== 'fish' || isStale(session.turns, turn)) return
      let sound
      try {
        sound = await session.context.decodeAudioData(bytes)
      } catch (error) {
        return
      }
      if (session.stopped || isStale(session.turns, turn)) return
      const node = session.context.createBufferSource()
      node.buffer = sound
      node.connect(session.level?.input() ?? session.context.destination)
      const at = Math.max(session.context.currentTime, fish.playhead)
      node.onended = () => {
        fish.nodes.delete(node)
        settle(session)
      }
      node.start(at)
      fish.playhead = at + sound.duration
      fish.nodes.add(node)
      // Fish's sound has started: as output_audio_buffer.started is for OpenAI's voice - and here its end
      // is known, the end of everything queued so far.
      session.soundStarted?.({ endsInMs: (fish.playhead - session.context.currentTime) * 1000 })
      session.show('speaking')
    }).finally(() => {
      fish.pending -= 1
      settle(session)
    })
  }

  return {
    replyStarted(session) {
      const fish = stateOf(session)
      fish.buffer = ''
      fish.first = true
      fish.replyDone = false
    },
    // More of the reply's text; `done` when there is no more to come.
    replyText(session, delta, done = false) {
      const fish = stateOf(session)
      if (!session.context || isStale(session.turns, session.replyTurn)) return
      fish.buffer += delta
      for (;;) {
        const { piece, rest } = takeSpeakable(fish.buffer, { first: fish.first, done })
        fish.buffer = rest
        if (!piece) break
        fish.first = false
        speakPiece(session, piece, session.replyTurn)
      }
    },
    replyDone(session) {
      stateOf(session).replyDone = true
      settle(session)
    },
    bargeIn(session, send) {
      stopAll(session)
      if (session.responding) send({ type: 'response.cancel' })
      const fish = stateOf(session)
      if (session.ticket && fish.warmTurn !== session.turns.current && io.now() - fish.warmAt >= FISH_WARM_EVERY_MS) {
        fish.warmTurn = session.turns.current
        fish.warmAt = io.now()
        io.speak({ ticket: session.ticket, warm: true }).catch(() => {})
      }
    },
    stop(session) {
      stopAll(session)
    }
  }
}

/* ---------- Talk to the board: the voice spend meter ----------
   There is no cap on voice - the owner's choice - so this is how they see what it costs: a Voice
   spend card in Today's Usage section, beside Plan limits and Subscriptions, drawn only while voice
   is on. It is an ESTIMATE - OpenAI's own token counts for each reply times the prices
   /api/voice-meter sends, with the date they were checked - and says so in plain view, never behind
   a Why?: that is what the number is. The bill is at platform.openai.com.

   Each conversation is kept in this device's outbox until the board has recorded it: sent once when
   a call ends, and once when the board opens with something still in it. Never more often - the
   meter shares the picture store's writes. The board may keep some for later (the day's meter writes
   are used up); they stay, and the card says how many. With no picture store, the outbox is the
   meter, for this device only. A report never asks for the edit key: nobody pressed anything. */

let voiceReporting = false
// A report asked for while one is out - a call ending as the board-open report goes - waits for it.
let voiceReportAgain = false

// This month's voice spend, as the card shows it and the usage tool reads it out: what the board has
// recorded plus what is still waiting on this device - or, with no store, this device's alone. It
// says what is waiting, what the device had to let go, and whether the board keeps voice at all.
// Null when there is no meter to read: unknown, never $0.
function voiceSpendNow() {
  if (!voiceMeter || voiceMeter.damaged === true || (voiceMeter.store === true && !isRecord(voiceMeter.thisMonth))) return null
  const outbox = readOutbox(readStore(VOICE_OUTBOX_STORE))
  const device = outboxSummary(outbox, voiceMeter.prices ?? null, new Date().toISOString().slice(0, 7))
  // A conversation the board saved whose answer never came back is in both, until the next report
  // clears it from the outbox - accepted, because this is an estimate and that report is never far off.
  const recorded = voiceMeter.store === true ? voiceMeter.thisMonth : {}
  const labels = [...(Array.isArray(recorded.incomplete) ? recorded.incomplete : []), ...device.incomplete]
  return {
    usd: (Number(recorded.usd) || 0) + device.usd,
    conversations: allowanceCount(recorded.conversations) + device.conversations,
    incomplete: [...new Set(labels)],
    waitingOnDevice: device.conversations,
    droppedOnDevice: device.dropped,
    keptByBoard: voiceMeter.store === true && voiceMeter.writesPerDay !== 0
  }
}

const voiceApprox = (usd) => (usd > 0 && usd < 0.01 ? 'under $0.01' : `≈ $${usd.toFixed(2)}`)
// A cost as words: about so much when everything in it was priced; at least so much, or not fully
// known, when something was not - never a $0 that is not known.
const voiceCostWords = (usd, complete) =>
  complete ? voiceApprox(usd) : usd >= 0.01 ? `at least $${usd.toFixed(2)}` : 'not fully known'

// Fish's share, in characters (Fish counts bytes; most letters are one), and whether it was free.
function voiceFishHtml(fishBytes) {
  const parts = Object.entries(isRecord(fishBytes) ? fishBytes : {})
    .filter(([, bytes]) => Number.isInteger(bytes) && bytes > 0)
    .map(([model, bytes]) => `about ${bytes.toLocaleString('en-US')} characters (${model === 's2.1-pro-free' ? 'free model, $0' : `${escapeHtml(model)}, priced in the total`})`)
  return parts.length ? `<p class="voice-spend-line voice-fish">${brandTileHtml('Fish Audio', 'voice-tile')}<span>Fish: ${parts.join('; ')}</span></p>` : ''
}

function voiceSpendInnerHtml() {
  const head = `<div class="voice-spend-head">${brandTileHtml('OpenAI', 'voice-tile')}<p class="title">Voice spend</p></div>`
  const checked = typeof voiceMeter?.prices?.checked === 'string' ? voiceMeter.prices.checked : ''
  const estimate = `<p class="voice-spend-note"><span class="chip">estimate</span> From OpenAI&rsquo;s own token counts
    &times; prices ${checked ? `checked ${escapeHtml(checked)}` : 'not loaded yet'}. Your bill is at
    <a href="https://platform.openai.com/usage" rel="noreferrer noopener">platform.openai.com</a>.</p>`
  const outbox = readOutbox(readStore(VOICE_OUTBOX_STORE))
  const waitingNow = outbox.items.length
    ? `<p class="voice-spend-line">${plural(outbox.items.length, 'conversation')} on this device not recorded yet.</p>`
    : ''

  if (!voiceMeter) return `${head}<p class="voice-spend-line">Reading the voice meter&hellip;</p>${waitingNow}${estimate}`
  if (voiceMeter.damaged === true) {
    return `${head}<p class="voice-spend-warn">${escapeHtml(typeof voiceMeter.why === 'string' ? voiceMeter.why : 'The voice meter could not be read.')}</p>${waitingNow}${estimate}`
  }
  const spend = voiceSpendNow()
  if (!spend) return `${head}<p class="voice-spend-line">The voice meter said nothing this board can read.</p>${waitingNow}${estimate}`
  const complete = !spend.incomplete.length && !spend.droppedOnDevice
  const cost = voiceCostWords(spend.usd, complete)
  const last = voiceMeter.store === true && isRecord(voiceMeter.last) && typeof voiceMeter.last.usd === 'number'
    ? ` &middot; last one ${voiceCostWords(voiceMeter.last.usd, !(Array.isArray(voiceMeter.last.incomplete) && voiceMeter.last.incomplete.length))}`
    : ''
  const total = spend.conversations
    ? `<p class="voice-spend-total"><b>This month${cost === 'not fully known' ? ': cost not fully known' : ` ${cost}`}</b> &middot; ${plural(spend.conversations, 'conversation')}${last}</p>`
    : '<p class="voice-spend-line">No conversations yet this month.</p>'
  const lines = []
  if (voiceMeter.store === false) {
    lines.push('<p class="voice-spend-line">This device only &mdash; connect a picture store to keep one total across your devices.</p>')
  } else if (!spend.keptByBoard) {
    lines.push('<p class="voice-spend-warn">The picture caps use every store write the board has a day, so voice is only counted on each device, never kept by the board. Lower <code>WRITE_DAILY_CAP</code> or <code>GENERATE_DAILY_CAP</code> to keep it.</p>')
  } else if (spend.waitingOnDevice) {
    lines.push(`<p class="voice-spend-line">Including ${spend.waitingOnDevice} on this device not recorded yet.</p>`)
  }
  const month = voiceMeter.store === true ? voiceMeter.thisMonth.fishBytes : outboxSummary(outbox, voiceMeter.prices ?? null, new Date().toISOString().slice(0, 7)).fishBytes
  lines.push(voiceFishHtml(month))
  const labels = spend.incomplete.filter((label) => label !== 'no price table yet')
  if (labels.length) {
    lines.push(`<p class="voice-spend-warn">Incomplete: no price yet for ${labels.map((label) => escapeHtml(label)).join(', ')}, so the real cost is higher.</p>`)
  }
  if (spend.droppedOnDevice) {
    lines.push(`<p class="voice-spend-warn">${plural(spend.droppedOnDevice, 'older conversation')} on this device ${spend.droppedOnDevice === 1 ? 'was' : 'were'} let go before the board could record ${spend.droppedOnDevice === 1 ? 'it' : 'them'}, so the real total is higher.</p>`)
  }
  return `${head}${total}${lines.join('')}${estimate}`
}

// The card in Today's Usage section. Drawn only while voice is on, so with voice off Today is the
// board it always was.
const voiceSpendHtml = () => (voiceInfo.on ? `<section class="panel card voice-spend" id="voice-spend">${voiceSpendInnerHtml()}</section>` : '')

// The card again, in place, once the meter has answered or a report has gone - nothing else redrawn.
function showVoiceSpend() {
  const card = el('voice-spend')
  if (card && voiceInfo.on) card.innerHTML = voiceSpendInnerHtml()
}

// One report: the oldest 20 conversations in the outbox. What the board counted, or says can never
// count, leaves the outbox; everything else stays for next time. Never asks for a key.
async function sendVoiceReports() {
  if (!voiceInfo.on) return
  // One report at a time: two at once would both carry the same conversations. One asked for now goes
  // as soon as this one has settled, so a call that ends meanwhile is still reported.
  if (voiceReporting) {
    voiceReportAgain = true
    return
  }
  const batch = outboxBatch(readOutbox(readStore(VOICE_OUTBOX_STORE)), Date.now())
  if (!batch.reports.length) return
  voiceReporting = true
  try {
    const response = await fetch('/api/voice-meter', {
      method: 'POST',
      headers: writeHeaders('application/json'),
      body: JSON.stringify({ reports: batch.reports })
    })
    const answer = await answerOf(response)
    if (response.ok) {
      // Read again: a call may have added to the outbox while this was out.
      writeStore(VOICE_OUTBOX_STORE, JSON.stringify(outboxSettle(readOutbox(readStore(VOICE_OUTBOX_STORE)), batch, answer)))
      if (isRecord(answer.meter)) voiceMeter = answer.meter
    }
  } catch (error) {
    // Nothing is lost: the conversations stay in the outbox, and the card says how many.
  } finally {
    voiceReporting = false
    showVoiceSpend()
    if (voiceReportAgain) {
      voiceReportAgain = false
      sendVoiceReports()
    }
  }
}

// When the board opens with voice on: the meter, then anything this device has not reported yet.
async function loadVoiceMeter() {
  if (!voiceInfo.on) return
  try {
    const result = await apiGet('/api/voice-meter')
    voiceMeter = result.ok && isRecord(result.payload) ? result.payload : voiceMeter
  } catch (error) {
    /* the card keeps saying it is reading the meter */
  }
  showVoiceSpend()
  await sendVoiceReports()
}

/* ---------- Readiness: begin ----------
   Flight readiness: every scheduled job, one light each, NO GO first. The server decides each light
   and writes each sentence (api/_readiness.js); this draws them, and ages them while the board is
   open. Everything is set as TEXT on elements made here - a job's name and a run's summary are
   repo text, and none of it is ever parsed as markup. A test reads this block and refuses every call
   that would build markup from a string. */

const READINESS_RANK = { 'no-go': 0, silent: 1, go: 2 }
const READINESS_WORD = { 'no-go': 'NO GO', silent: 'SILENT', go: 'GO' }

// Mirrors orderCards and countCards in api/_readiness.js - the page has no module loading, so the two
// are held together by a test that runs both on the same cards.
function readinessOrder(a, b) {
  if (a.light !== b.light) return READINESS_RANK[a.light] - READINESS_RANK[b.light]
  if (a.faded !== b.faded) return a.faded ? 1 : -1
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
}

function readinessCount(cards) {
  const counts = { noGo: 0, silent: 0, go: 0, faded: 0 }
  for (const card of cards) {
    if (card.light === 'no-go') counts.noGo += 1
    else if (card.light === 'silent') counts.silent += 1
    else counts.go += 1
    if (card.faded) counts.faded += 1
  }
  return counts
}

// A card as it is at `nowMs`. The server says when each will age: past its silentAt it is the silent
// card it described, past its fadesAt it is faded. No request - the instants came with the answer.
function ageReadinessCard(card, nowMs, fadedNote) {
  const silentAt = card.silentAt ? Date.parse(card.silentAt) : NaN
  if (nowMs >= silentAt && card.silentSentence) {
    return { ...card, light: 'silent', word: READINESS_WORD.silent, pill: null, faded: false, sentence: card.silentSentence, fadesAt: null, silentAt: null, silentSentence: null }
  }
  const fadesAt = card.fadesAt ? Date.parse(card.fadesAt) : NaN
  if (!card.faded && nowMs >= fadesAt) {
    return { ...card, faded: true, sentence: { text: `${card.sentence.text} ${fadedNote}`, at: card.sentence.at }, fadesAt: null }
  }
  return card
}

function ageReadiness(readiness, nowMs) {
  const cards = (readiness?.cards ?? []).map((card) => ageReadinessCard(card, nowMs, readiness.fadedNote ?? '')).sort(readinessOrder)
  const counts = readinessCount(cards)
  return { cards, counts, badge: counts.noGo + counts.silent }
}

// The times in a sentence are filled in here, in the reader's own clock. `readinessClock` is only
// ever changed by a test, to pin the language and the zone.
const readinessClock = { locale: undefined, zone: undefined }
const readinessFormatIn = (zone, options) => new Intl.DateTimeFormat(readinessClock.locale, { timeZone: zone, ...options })
const readinessFormat = (options) => readinessFormatIn(readinessClock.zone, options)

function readinessWhen(iso, kind, nowMs) {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return 'an unknown time'
  const dayOf = (value) => readinessFormat({ year: 'numeric', month: 'numeric', day: 'numeric' }).format(value)
  const dateText = dayOf(ms) === dayOf(nowMs) ? 'today'
    : dayOf(ms) === dayOf(nowMs - 86400_000) ? 'yesterday'
      : readinessFormat({ weekday: 'short', day: 'numeric', month: 'short' }).format(ms)
  const clock = readinessFormat({ hour: 'numeric', minute: '2-digit' }).format(ms)
  // "Not checked since today" says nothing: earlier today is said as the time.
  if (kind === 'date') return dateText === 'today' ? clock : dateText
  if (dateText === 'today') return clock
  return dateText === 'yesterday' ? `${clock} yesterday` : `${clock} on ${dateText}`
}

// A team-repo schedule in the reader's own time. A routine runs in UTC, so the server sends the clock
// time and the page converts it - which can move the day as well as the hour (06:00 UTC on a Monday
// is 02:00 Monday in New York and 15:00 Monday in Tokyo, but 02:00 UTC is Sunday evening in New York).
// Anything it cannot convert is said as the server wrote it.
const READINESS_DAY_NAMES = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']
const READINESS_DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const readinessOrdinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'}`

function readinessDay(ms, zone) {
  const parts = Object.fromEntries(readinessFormatIn(zone, { year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(ms).map((part) => [part.type, part.value]))
  return { stamp: Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)), day: Number(parts.day) }
}

function readinessScheduleText(schedule, nowMs, zone = readinessClock.zone) {
  if (typeof schedule === 'string') return schedule
  if (!schedule || typeof schedule.text !== 'string') return 'Not known'
  const at = schedule.clock
  if (!at || !['day', 'weekdays', 'weekly', 'monthly'].includes(at.every)) return schedule.text
  try {
    const now = new Date(nowMs)
    const [year, month, day] = [now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()]
    let reference = Date.UTC(year, month, day, at.hour, at.minute)
    if (at.every === 'weekly') {
      for (let ahead = 0; ahead < 7; ahead += 1) {
        const candidate = Date.UTC(year, month, day + ahead, at.hour, at.minute)
        if (new Date(candidate).getUTCDay() === at.weekday) {
          reference = candidate
          break
        }
      }
    } else if (at.every === 'monthly') {
      // The next month that has that date: there is no 31st of September.
      for (let ahead = 0; ahead < 14; ahead += 1) {
        const candidate = Date.UTC(year, month + ahead, at.day, at.hour, at.minute)
        if (new Date(candidate).getUTCDate() === at.day && candidate > nowMs) {
          reference = candidate
          break
        }
      }
    }
    const local = readinessDay(reference, zone)
    const shift = Math.round((local.stamp - readinessDay(reference, 'UTC').stamp) / 86400_000)
    const time = readinessFormatIn(zone, { hour: 'numeric', minute: '2-digit' }).format(reference)
    if (at.every === 'day') return `Every day at ${time}`
    if (at.every === 'weekly') return `${READINESS_DAY_NAMES[(at.weekday + shift + 7) % 7]} at ${time}`
    if (at.every === 'monthly') return `Monthly on the ${readinessOrdinal(local.day)} at ${time}`
    const days = [1, 2, 3, 4, 5].map((weekday) => (weekday + shift + 7) % 7).sort((a, b) => a - b)
    if (days.join() === '1,2,3,4,5') return `Weekdays at ${time}`
    const run = days.every((value, index) => index === 0 || value === days[index - 1] + 1)
    return `${run ? `${READINESS_DAY_SHORT[days[0]]} to ${READINESS_DAY_SHORT[days.at(-1)]}` : days.map((value) => READINESS_DAY_SHORT[value]).join(', ')} at ${time}`
  } catch (error) {
    return schedule.text
  }
}

// "7:56 PM on Tue, Oct 13": the clock time and the short date together, always - the line at the top of the
// wall that says the Mac restarted is read days later as often as minutes later.
function readinessStamp(iso) {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return 'an unknown time'
  const clock = readinessFormat({ hour: 'numeric', minute: '2-digit' }).format(ms)
  return `${clock} on ${readinessFormat({ weekday: 'short', day: 'numeric', month: 'short' }).format(ms)}`
}

function readinessSentence(sentence, nowMs) {
  const at = sentence?.at ?? null
  return String(sentence?.text ?? '').replace(/\{(time|date|hours|stamp)\}/g, (token, kind) => {
    if (!at) return ''
    if (kind === 'stamp') return readinessStamp(at)
    if (kind === 'hours') return String(Math.max(0, Math.floor((nowMs - Date.parse(at)) / 3600_000)))
    return readinessWhen(at, kind, nowMs)
  })
}

function readinessNode(tag, { cls, text, attrs } = {}, ...children) {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  for (const [name, value] of Object.entries(attrs ?? {})) node.setAttribute(name, value)
  for (const child of children) if (child) node.appendChild(child)
  return node
}

function readinessReplace(container, children) {
  if (typeof container.replaceChildren === 'function') {
    container.replaceChildren(...children)
    return
  }
  container.textContent = ''
  for (const child of children) container.appendChild(child)
}

function readinessCardNode(card, nowMs) {
  const light = readinessNode('span', { cls: 'rd-light', attrs: { 'aria-hidden': 'true' } })
  const top = readinessNode('div', { cls: 'rd-top' }, light, readinessNode('span', { cls: 'rd-word', text: card.word }),
    card.pill ? readinessNode('span', { cls: 'chip ok rd-pill', text: card.pill }) : null)
  const row = (label, value) => readinessNode('div', { cls: 'rd-row' }, readinessNode('dt', { text: label }), readinessNode('dd', { text: value }))
  const last = card.lastReport?.at ? readinessSentence(card.lastReport, nowMs) : (card.lastReport?.text ?? 'Never')
  return readinessNode('li', { cls: `rd-card rd-${card.light}${card.faded ? ' rd-faded' : ''}`, attrs: { 'data-id': card.id } },
    top,
    readinessNode('p', { cls: 'rd-name', text: card.name }),
    readinessNode('p', { cls: 'rd-sentence', text: readinessSentence(card.sentence, nowMs) }),
    readinessNode('dl', { cls: 'rd-rows' }, row('Schedule', readinessScheduleText(card.schedule, nowMs)), row('Last report', last)),
    readinessNode('p', { cls: 'rd-ref small muted', text: card.ref }))
}

const READINESS_GROUPS = [['no-go', 'No go'], ['silent', 'Silent'], ['go', 'Go']]

// What the wall could not see, said plainly under the lights.
function readinessNotes(readiness, counts) {
  const notes = []
  if (readiness.jobs?.status === 'none') notes.push("The Mac has not reported its jobs yet, so only the jobs in your team repo are shown. Your Mac's collector adds the rest.")
  else if (readiness.jobs?.status === 'unusable') notes.push(`The Mac's jobs could not be shown. ${readiness.jobs.why ?? ''}`.trim())
  if (readiness.counts?.hiddenBySafety) {
    const n = readiness.counts.hiddenBySafety
    notes.push(`${n} job${n === 1 ? ' was' : 's were'} kept off the wall by the safety check on names. Rename ${n === 1 ? 'it' : 'them'} where ${n === 1 ? 'it is' : 'they are'} made to bring ${n === 1 ? 'it' : 'them'} back.`)
  }
  if (!readiness.routinesKnown) notes.push('The list of routines on your account is not fresh, so routines with no workflow file are not shown.')
  notes.push('Windows Task Scheduler, n8n, Trigger.dev and Codex automations are not checked here.')
  return notes
}

let readinessRefs = null

function readinessShell(container) {
  if (readinessRefs?.container === container) return readinessRefs
  const stamp = readinessNode('p', { cls: 'rd-stamp small muted' })
  const counters = readinessNode('p', { cls: 'rd-counters', attrs: { role: 'status' } })
  const note = readinessNode('p', { cls: 'rd-note small muted' })
  const restarts = readinessNode('div', { cls: 'rd-restarts', attrs: { hidden: '' } })
  const refresh = readinessNode('button', { cls: 'fire rd-refresh', text: 'Refresh', attrs: { type: 'button' } })
  const body = readinessNode('div', { cls: 'rd-body' })
  readinessReplace(container, [readinessNode('div', { cls: 'rd-head' }, restarts, stamp, counters, note, refresh), body])
  readinessRefs = { container, restarts, stamp, counters, note, refresh, body }
  refresh.addEventListener('click', () => checkReadiness())
  return readinessRefs
}

// Keeping the screen current. Every 60 seconds - only while the Readiness screen is showing and the
// browser tab is in front - the page asks /api/state?since=<the commit it was built from>. If the
// branch has not moved the answer is one small object (and one call to GitHub); if it has, it is the
// whole board, built from the new commit. A full load every minute would pass GitHub's hourly limit
// on two devices, so the one-call check is what makes watching possible at all. Between checks the
// lights age on their own, from the instants the server sent. This is kept apart from boot() on
// purpose, and the Refresh button is the same check, pressed.
const READINESS_POLL_MS = 60_000
let readinessTimer = null
let readinessBusy = false
let readinessCheckedAt = null
let readinessFailed = false
// How the pace slows when checks fail: 60 s, then 120, 240, 480, and never more than fifteen minutes.
// A Retry-After from GitHub's rate limit (through the board, as a 429) is honoured if it asks for
// longer, to at most an hour. A check that works puts it all back.
const READINESS_BACKOFF_CAP_MS = 15 * 60_000
const READINESS_WAIT_CAP_MS = 60 * 60_000
let readinessFailures = 0
let readinessWaitMs = 0
let readinessAttemptedAt = 0
const readinessDelay = () => Math.min(Math.max(Math.min(READINESS_POLL_MS * 2 ** readinessFailures, READINESS_BACKOFF_CAP_MS), readinessWaitMs), READINESS_WAIT_CAP_MS)
const readinessDelayWords = () => (readinessDelay() < 120_000 ? `${Math.round(readinessDelay() / 1000)} s` : `${Math.ceil(readinessDelay() / 60_000)} min`)
// Set when the board is locked again: there is nobody left to watch for.
let readinessLocked = false

// The server names the commit it read; one that does not (an older server, or GitHub would not say)
// has nothing to ask "has it changed?" with, and is not watched.
const readinessWatching = () => !readinessLocked && Boolean(data?.commit) && location.hash.slice(1) === 'readiness' && document.visibilityState !== 'hidden'

function readinessUnschedule() {
  if (readinessTimer === null) return
  clearTimeout(readinessTimer)
  readinessTimer = null
}

function readinessSchedule(delay) {
  if (readinessTimer !== null || !readinessWatching()) return
  readinessTimer = setTimeout(async () => {
    readinessTimer = null
    if (readinessWatching()) await checkReadiness()
    readinessSchedule(readinessDelay())
  }, delay)
}

// Coming back to the screen or the tab: the lights have been ageing unseen, so look straight away -
// unless the last check failed. Then the back-off (or GitHub's Retry-After) is still running, and it
// is measured from that last attempt, not from now: on a phone every app switch is a "coming back",
// and each one would otherwise send a check through a rate limit.
const readinessResumeDelay = () => (readinessFailures > 0 ? Math.max(0, readinessDelay() - (Date.now() - readinessAttemptedAt)) : 0)

// Called when something that decides whether to watch has changed. `soon` is for coming back.
function readinessSync(soon = false) {
  if (!readinessWatching()) {
    readinessUnschedule()
    return
  }
  if (soon) readinessUnschedule()
  readinessSchedule(soon ? readinessResumeDelay() : readinessDelay())
}

// A new board, drawn in place of the old. render() ends in showScreen, which goes to the top, so the
// reader is put back where they were.
function adoptBoard(payload) {
  const scrolledTo = window.scrollY
  readinessFailed = false
  data = payload
  render()
  window.scrollTo(0, scrolledTo ?? 0)
}

async function checkReadiness() {
  if (readinessBusy) return
  readinessBusy = true
  readinessAttemptedAt = Date.now()
  try {
    const result = await apiGet(data?.commit ? `/api/state?since=${encodeURIComponent(data.commit)}` : '/api/state')
    // Signed out (the cookie ran out, or "sign out everywhere"): stop, and say so. Asking again
    // every minute would be asking a question nobody can answer from here.
    if (result.status === 401) {
      readinessLocked = true
      readinessUnschedule()
      renderSignIn('You were signed out, so sign in again.')
      return
    }
    if (result.redirected) {
      readinessLocked = true
      readinessUnschedule()
      renderReload()
      return
    }
    if (!result.ok) {
      readinessWaitMs = (result.status === 429 || result.status === 403) && result.retryAfter !== null ? result.retryAfter * 1000 : 0
      throw new Error(`The check answered ${result.status}`)
    }
    // It worked: the pace is back to a minute, and the next check is a minute from now, whatever was
    // waiting before (the Refresh button can be pressed between two scheduled checks).
    readinessFailures = 0
    readinessWaitMs = 0
    readinessUnschedule()
    if (result.payload?.unchanged === true) {
      readinessFailed = false
      readinessCheckedAt = Date.now()
      renderReadiness()
    } else {
      readinessCheckedAt = Date.now()
      adoptBoard(result.payload)
    }
  } catch (error) {
    readinessFailed = true
    readinessFailures += 1
    readinessUnschedule()
    renderReadiness()
  } finally {
    readinessBusy = false
  }
}

window.addEventListener('hashchange', () => readinessSync(true))
document.addEventListener('visibilitychange', () => readinessSync(true))

// The lines at the top that say a computer restarted: "Mac restarted at 7:56 PM on Tue, Oct 13". The server
// sends one per computer that reported a boot time in the last 7 days; the page judges the 7 days again by its
// own clock, so a board left open for a week stops saying it, and draws only entries it can read. With more
// than one computer each line starts with its name, which is text like everything else here.
const READINESS_RESTART_DAYS = 7
function readinessRestartLines(restarts, nowMs) {
  const readable = (Array.isArray(restarts) ? restarts : []).filter((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.text !== 'string' || typeof entry.at !== 'string') return false
    const ms = Date.parse(entry.at)
    return Number.isFinite(ms) && ms <= nowMs + 60_000 && nowMs - ms <= READINESS_RESTART_DAYS * 86400_000
  })
  return readable.map((entry) => {
    const said = readinessSentence({ text: entry.text, at: entry.at }, nowMs)
    return readable.length > 1 && typeof entry.where === 'string' && entry.where ? `${entry.where}: ${said}` : said
  })
}

function readinessCountsText(counts) {
  return `${counts.noGo} NO GO · ${counts.silent} SILENT · ${counts.go} GO`
}

function renderReadiness(nowMs = Date.now()) {
  const container = el('readiness')
  if (!container) return
  const readiness = data.readiness
  if (!readiness || !Array.isArray(readiness.cards)) {
    readinessRefs = null
    readinessUnschedule()
    container.textContent = 'This board does not have the Readiness wall yet. Redeploy it from the latest cockpit.'
    return
  }
  const refs = readinessShell(container)
  const aged = ageReadiness(readiness, nowMs)
  const macTime = readiness.macCheckedAt ? readinessWhen(readiness.macCheckedAt, 'time', nowMs) : null
  refs.stamp.textContent = [
    `JOBS CHECKED ${macTime ? macTime : 'NEVER'}`,
    `BOARD READ ${data.generatedAt ? readinessWhen(data.generatedAt, 'time', nowMs) : 'NEVER'}`,
    readinessCheckedAt ? `CHECKED ${readinessWhen(new Date(readinessCheckedAt).toISOString(), 'time', nowMs)}` : null,
    data.commit ? `REFRESH ${readinessDelayWords()} auto` : 'REFRESH BY BUTTON',
    readinessFailed ? 'COULD NOT CHECK' : null
  ].filter(Boolean).join(' · ')
  const restartLines = readinessRestartLines(readiness.restarts, nowMs)
  readinessReplace(refs.restarts, restartLines.map((line) => readinessNode('p', { cls: 'rd-restart', text: line })))
  refs.restarts.hidden = restartLines.length === 0
  // The counters are a live region: touched only when they change, so a screen reader hears a change
  // and not the page being drawn again.
  const counters = readinessCountsText(aged.counts)
  if (refs.counters.textContent !== counters) refs.counters.textContent = counters
  // The tab's badge follows the lights as they age, not only when a whole board is drawn.
  const badge = el('count-readiness')
  if (badge) badge.textContent = aged.badge ? String(aged.badge) : ''
  // Said only when there is a Mac reading to say it about.
  refs.note.textContent = `Counted from each job's last report.${macTime ? ` Mac and Hermes jobs as of the Mac's check at ${macTime}.` : ''} ${aged.counts.faded} faded: their last report is older than their own schedule.`

  const sections = []
  for (const [light, label] of READINESS_GROUPS) {
    const cards = aged.cards.filter((card) => card.light === light)
    if (!cards.length) continue
    const headingId = `rd-heading-${light}`
    sections.push(readinessNode('section', { cls: 'rd-group', attrs: { 'aria-labelledby': headingId } },
      readinessNode('h3', { cls: `rd-heading rd-heading-${light}`, text: `${label}, ${cards.length}`, attrs: { id: headingId } }),
      readinessNode('ul', { cls: 'rd-grid' }, ...cards.map((card) => readinessCardNode(card, nowMs)))))
  }
  if (!aged.cards.length) {
    sections.push(emptyStateNode('readiness', readinessNode('p', { text: 'No jobs to show yet. Workflows in your team repo, and the jobs on your Mac, appear here as soon as they are found.' })))
  }
  if (readiness.switchedOff?.length) {
    sections.push(readinessNode('section', { cls: 'rd-group', attrs: { 'aria-labelledby': 'rd-heading-off' } },
      readinessNode('h3', { cls: 'rd-heading', text: `Switched off, ${readiness.switchedOff.length}`, attrs: { id: 'rd-heading-off' } }),
      readinessNode('ul', { cls: 'rd-off' }, ...readiness.switchedOff.map((entry) => readinessNode('li', { cls: 'rd-off-item' },
        readinessNode('p', { cls: 'rd-name', text: entry.name }),
        readinessNode('p', { cls: 'rd-sentence', text: entry.reason }),
        readinessNode('p', { cls: 'rd-ref small muted', text: entry.ref }))))))
  }
  for (const text of readinessNotes(readiness, aged.counts)) sections.push(readinessNode('p', { cls: 'rd-foot small muted', text }))
  readinessReplace(refs.body, sections)
  readinessSync()
}
// The same check, asked for by the voice assistant's "is it done?" (job_status): true when it worked.
// Here, beside the rest of the checking, so there is one way the page asks "has anything changed?".
async function recheckBoardNow() {
  await checkReadiness()
  return !readinessFailed
}

/* ---------- Readiness: end ---------- */

/* ---------- shell ---------- */

// Hermes is a screen only for somebody who has Hermes, so it is not in TITLES: every screen there
// is always reachable. Without a Hermes reading, #hermes goes to Today like any unknown address.
const OPTIONAL_TITLES = { hermes: 'Hermes' }

function showScreen(name) {
  const routable = hermesShown() ? [...SCREENS, 'hermes'] : SCREENS
  const screen = routable.includes(name) ? name : 'today'
  for (const candidate of [...SCREENS, 'hermes']) {
    el(candidate).classList.toggle('active', candidate === screen)
  }
  document.querySelectorAll('nav a').forEach((link) =>
    link.classList.toggle('active', link.dataset.screen === screen))
  el('screen-title').textContent = TITLES[screen] ?? OPTIONAL_TITLES[screen]
  // Today's banner carries this line itself, so the copy under the top bar would say it twice.
  el('strap').hidden = screen === 'today'
  window.scrollTo(0, 0)
  // Readiness's banner lives just outside its screen (the wall is never markup), so it is shown with it.
  el('readiness-banner').hidden = screen !== 'readiness'
  // A screen's own pictures are fetched the first time it is shown, never with Today: most visits are
  // a glance at Today on a phone, and should not pay for eight portraits nobody looked at.
  if (brand && screen !== 'today' && !artAsked.has(screen)) {
    artAsked.add(screen)
    showArt(screen)
  }
  memoryScreenShown(screen === 'memory')
}

window.addEventListener('hashchange', () => showScreen(location.hash.slice(1)))

/* Run a job, in the top bar. It goes to the buttons on Today and stops there: pressing one spends a
   run, and that stays a decision made on the button itself, with its sentence about the cost in
   view. pushState rather than following the link, because the router answers a hash change by
   scrolling to the top - which would undo the scroll - and Back should still return to the screen
   the jump started from. */
function jumpToRun(event) {
  event.preventDefault()
  const current = location.hash.slice(1)
  if (SCREENS.includes(current) && current !== 'today') {
    window.history?.pushState?.(null, '', '#today')
    showScreen('today')
  }
  document.getElementById('run-jobs')?.scrollIntoView?.({ block: 'start' })
}
el('jump-run')?.addEventListener('click', jumpToRun)

// The tabs that are lists say how long the list is. Today and Ledger are not lists, and a zero is
// left blank: "0" beside every tab of a new repo reads as seven things broken.
const TAB_COUNTS = {
  team: () => data.agents.length,
  workflows: () => data.workflows.length,
  // NO GO and SILENT, as they are right now: a card that has aged into silence counts as silent.
  readiness: () => (data.readiness ? ageReadiness(data.readiness, Date.now()).badge : 0),
  skills: () => (data.skills ?? []).length,
  memory: () => (data.memory?.files ?? []).length,
  connections: () => (data.connections ?? []).length + (data.runtimes ?? []).length
}

// First and last word, so "Nuno Tavares" is NT and "Jordan" is J. Array.from takes a whole
// character, where [0] would take half of one outside the basic plane.
function initialsOf(name) {
  const words = name.split(/\s+/).filter(Boolean)
  const first = (word) => Array.from(word)[0].toUpperCase()
  if (!words.length) return ''
  return words.length > 1 ? first(words[0]) + first(words.at(-1)) : first(words[0])
}

// What the sidebar picture says: how much is running and what rings next, from the same board the
// Today screen draws. The next job's name is repo text, so it is escaped.
function sideArtCaptionHtml(board) {
  const running = board?.running?.length ?? 0
  const head = running ? `${running} job${running === 1 ? '' : 's'} running` : 'Nothing running right now'
  const next = board?.upNext?.[0]
  const when = next ? until(next.when) : null
  const tail = next
    ? `Next: ${escapeHtml(next.name)}${when ? ` ${escapeHtml(when)}` : ''}`
    : 'Nothing due in the next two days'
  return `<b>${head}</b>${tail}`
}

function renderShell() {
  for (const screen of SCREENS) {
    const count = TAB_COUNTS[screen]?.() ?? 0
    const node = el(`count-${screen}`)
    if (node) node.textContent = count ? String(count) : ''
  }

  // The owner's name from about-me, set as text - it is their own words, never markup. No name
  // means no profile at all, rather than a placeholder person.
  const name = typeof data.owner?.name === 'string' ? data.owner.name.trim() : ''
  el('profile').hidden = !name
  el('profile-name').textContent = name
  el('profile-initials').textContent = initialsOf(name)

  el('side-art-caption').innerHTML = sideArtCaptionHtml(data.board)

  el('fresh').hidden = false
  el('fresh').setAttribute('title', `Read from your repo ${stamp(data.generatedAt)}`)
  el('fresh-text').textContent = `Read ${ago(data.generatedAt)}`

  el('jump-run').hidden = !data.workflows.some((workflow) => workflow.fire)
  el('tab-hermes').hidden = !hermesShown()
}

// Today stops saying it is busy once there is something to show in its place: the board, or why not.
const doneLoading = () => el('today').removeAttribute('aria-busy')

function render() {
  doneLoading()
  repoBase = data.repo.url
  repoBranch = data.repo.branch || 'main'
  el('repo-link').innerHTML = `<a href="${escapeHtml(data.repo.url)}" rel="noreferrer noopener">${escapeHtml(data.repo.owner)}/${escapeHtml(data.repo.repo)}</a>`
  el('strap').textContent = strapText()
  renderToday()
  renderLedger()
  renderTeam()
  renderWorkflows()
  renderReadiness()
  el('readiness-banner').innerHTML = screenBannerHtml('readiness')
  renderSkills()
  renderMemory()
  renderConnections()
  renderHermes()
  renderShell()
  el('foot').textContent = footWords()
  renderVoiceDock()
  showScreen(location.hash.slice(1))
  showArt('today')
}

// The footer's promise, kept true: with voice on, the assistant's words come from OpenAI and the
// spend card is the board's own estimate, so "nothing comes from anywhere else" would not be.
function footWords() {
  const read = `Read from your repo ${stamp(data.generatedAt)}.`
  return voiceInfo.on
    ? `${read} With voice on, what the assistant says comes from OpenAI, and Voice spend is the board's own estimate.`
    : `${read} Nothing on this page comes from anywhere else.`
}

function renderError(message) {
  doneLoading()
  el('strap').textContent = ''
  if (LOCAL_BOARD) {
    // No hosting service, no environment settings: the team folder is named in board.json next to Start Board.
    el('today').innerHTML = `<div class="panel error">
    <h3>This board cannot read your team folder yet</h3>
    <p>${escapeHtml(message)}</p>
    <p class="small">Check that the folder named in <code>board.json</code> is a clone of your team repo and that git is installed, then double-click Start Board again.</p>
  </div>`
    return
  }
  el('today').innerHTML = `<div class="panel error">
    <h3>This cockpit cannot read your repo yet</h3>
    <p>${escapeHtml(message)}</p>
    <p class="small">Set <code>GITHUB_OWNER</code> and <code>GITHUB_REPO</code> in your hosting environment
    and redeploy. If your team repo is private, add <code>GITHUB_TOKEN</code> as well — it stays
    on the server and never reaches this page.</p>
  </div>`
}

/* ---------- Sign in ----------
   The whole page when this device is not signed in. A real form: a username and a password that a
   phone's keychain or a browser saves, sent with fetch, and then the page loads again - which is when
   a keychain offers to save what was typed. Under it, the spare key (VIEW_KEY), for a lost password
   or a new device. Phone-first, in the card the lock screen always had.

   The markup is fixed: nothing is put into it. The server's sentences, and anything else that
   changes, are set as text. */
// The picture behind the sign-in card: decoration, hidden from a screen reader, fixed markup.
const UNLOCK_SCENE_HTML = '<div class="unlock-scene" aria-hidden="true"><img src="/art/unlock-gate.webp" alt="" width="1600" height="686" loading="lazy" decoding="async" /></div>'

const SIGN_IN_HTML = `${UNLOCK_SCENE_HTML}<main class="unlock" aria-labelledby="sign-in-title">
    <p class="eyebrow">Agent OS</p>
    <h1 id="sign-in-title">Sign in</h1>
    <p id="sign-in-note" class="sign-in-note" role="status" aria-live="polite"></p>
    <form id="sign-in-form" class="sign-in-form">
      <label for="sign-in-user">Username</label>
      <input id="sign-in-user" name="username" type="text" autocomplete="username" autocapitalize="none"
        autocorrect="off" spellcheck="false" required />
      <label for="sign-in-password">Password</label>
      <input id="sign-in-password" name="password" type="password" autocomplete="current-password" required />
      <button class="fire" type="submit" id="sign-in-submit">Sign in</button>
    </form>
    <button type="button" class="link-button" id="spare-key-show" aria-expanded="false" aria-controls="spare-key-form">Use the spare key instead</button>
    <form id="spare-key-form" class="sign-in-form" hidden>
      <label for="spare-key">Spare key</label>
      <input id="spare-key" name="spare-key" type="password" autocomplete="off" required />
      <button class="fire" type="submit" id="spare-key-submit">Sign in with the key</button>
    </form>
    <p class="small">Your username and password are the <code>BOARD_USERNAME</code> and <code>BOARD_PASSWORD</code>
    set in Vercel; the spare key is your <code>VIEW_KEY</code>. This device then stays signed in for 30 days.</p>
  </main>`

// One try: { ok } or { ok: false, words } - the server's own sentence when it sent one.
async function signInWith(username, password) {
  let response
  try {
    response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    })
  } catch (error) {
    return { ok: false, words: 'Could not reach the board, so you are not signed in yet. Check the connection and try again.' }
  }
  if (response.ok) return { ok: true }
  const refusal = await answerOf(response)
  return { ok: false, words: typeof refusal.error === 'string' && refusal.error ? refusal.error : `Signing in did not work (${response.status}). Try again.` }
}

function renderSignIn(message = '') {
  if (LOCAL_BOARD) return renderLocalClosed()
  document.body.innerHTML = SIGN_IN_HTML
  el('sign-in-note').textContent = message
  const send = async (event, { username, password, button, retry }) => {
    event.preventDefault()
    button.disabled = true
    el('sign-in-note').textContent = 'Signing in…'
    const result = await signInWith(username, password)
    if (result.ok) {
      location.reload()
      return
    }
    el('sign-in-note').textContent = result.words
    button.disabled = false
    retry.focus()
  }
  el('sign-in-form').addEventListener('submit', (event) => send(event, {
    username: String(el('sign-in-user').value ?? ''),
    password: String(el('sign-in-password').value ?? ''),
    button: el('sign-in-submit'),
    retry: el('sign-in-password')
  }))
  // Put away until asked for: the password is what a person is expected to use.
  el('spare-key-form').hidden = true
  el('spare-key-show').addEventListener('click', () => {
    const form = el('spare-key-form')
    form.hidden = !form.hidden
    el('spare-key-show').setAttribute('aria-expanded', String(!form.hidden))
    if (!form.hidden) el('spare-key').focus()
  })
  el('spare-key-form').addEventListener('submit', (event) => send(event, {
    username: '',
    password: String(el('spare-key').value ?? '').trim(),
    button: el('spare-key-submit'),
    retry: el('spare-key')
  }))
  el('sign-in-user').focus()
}

// On a student's own computer there is no username, password or Vercel: a board that cannot tell it is
// them (the tab was left open while the board was restarted, or the page was opened some other way)
// only needs to be opened again from Start Board.
function renderLocalClosed() {
  document.body.innerHTML = `${UNLOCK_SCENE_HTML}<main class="unlock" aria-labelledby="closed-title">
    <p class="eyebrow">Agent OS</p>
    <h1 id="closed-title">Open the board again</h1>
    <p id="closed-note" role="status" aria-live="polite"></p>
  </main>`
  el('closed-note').textContent = 'Double-click Start Board to open it again. If it was already open, close this tab first.'
}

// With Vercel Authentication on, Vercel's own sign-in can run out while the board is open: the board
// cannot tell from here whether it is signed out, only that it was sent elsewhere. Reloading the
// page goes through Vercel's sign-in, and then the board's.
function renderReload() {
  if (LOCAL_BOARD) return renderLocalClosed()
  document.body.innerHTML = `${UNLOCK_SCENE_HTML}<main class="unlock" aria-labelledby="reload-title">
    <p class="eyebrow">Agent OS</p>
    <h1 id="reload-title">Reload to sign in</h1>
    <p id="reload-note" role="status" aria-live="polite"></p>
    <button class="fire" type="button" id="reload-to-sign-in">Reload</button>
  </main>`
  el('reload-note').textContent = 'The board could not check for changes: your sign-in to Vercel has probably ended. Reload to sign in again.'
  el('reload-to-sign-in').addEventListener('click', () => location.reload())
  el('reload-to-sign-in').focus()
}

// A device that kept the view key in this browser's storage - the board before it had a sign-in -
// moves over by itself: the key goes once to /api/login as the spare key, and is deleted whatever
// the answer, because a key that worked is the cookie now and one that did not is no use. Only a
// request that never reached the board keeps it, for the next load. Never more than once a load.
async function moveSavedKey() {
  const key = readStore(VIEW_KEY_STORE)
  if (!key) return
  try {
    await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '', password: key })
    })
  } catch (error) {
    return
  }
  writeStore(VIEW_KEY_STORE, null)
}

/* Sign out, and sign out everywhere: two buttons under the screens. Everywhere is a change like any
   other (it is kept in the picture store and counted in the day's changes), so it goes through
   storeWrite - which asks for the edit key when the board has one - and is asked about first. */
async function signOut(everywhere) {
  const note = el('session-note')
  note.textContent = ''
  if (everywhere && !window.confirm?.('Sign out on every device, this one included? It uses one of today\'s changes.')) return
  try {
    if (everywhere) {
      await storeWrite('/api/logout', JSON.stringify({ everywhere: true }), 'application/json')
    } else {
      const response = await fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      if (!response.ok) throw new Error((await answerOf(response)).error || `Signing out did not work (${response.status}).`)
    }
  } catch (error) {
    note.textContent = error.message
    return
  }
  readinessLocked = true
  readinessUnschedule()
  renderSignIn(everywhere ? 'Signed out on every device.' : 'Signed out.')
}
el('sign-out')?.addEventListener('click', () => signOut(false))
el('sign-out-everywhere')?.addEventListener('click', () => signOut(true))

// The repo and the brand are asked for together, so personalising adds no wait of its own unless
// /api/brand is the slower of the two - and then three seconds at most.
async function boot() {
  await moveSavedKey()
  const [result, brandAnswer] = await Promise.all([apiGet('/api/state'), readBrand()])
  if (result.status === 401) {
    renderSignIn()
    return
  }
  if (result.redirected) {
    renderReload()
    return
  }
  if (!result.ok) {
    renderError(result.payload.error || `Request failed with ${result.status}`)
    return
  }
  data = result.payload
  useBrand(brandAnswer)
  render()
  loadVoiceMeter()
}

boot()
