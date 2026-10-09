// The orb and its sheet on the page: whether they are drawn, what a screen reader is told, how they
// look at a phone's width and a laptop's, and that what the assistant says is only ever set as text.
//
// The page is booted for real in a small stand-in DOM (tests/helpers/page-harness.mjs) and
// /api/brand is answered with voice on or off; the stylesheet is read as rules
// (tests/helpers/css-rules.mjs), the same way render.test.mjs reads it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { cssRules } from './helpers/css-rules.mjs'
import { loadPage, flush, classesIn, script } from './helpers/page-harness.mjs'
import { basePayload, brandAnswer, VOICE_ON } from './helpers/page-payload.mjs'

// A browser whose /api/brand answers `brand`.
const answering = (brand, extra = {}) => async (url) => {
  if (url.startsWith('/api/brand')) return { ok: true, status: 200, json: async () => brand }
  if (url in extra) return extra[url]
  return { ok: true, status: 200, json: async () => (url.startsWith('/api/state') ? basePayload() : {}) }
}

async function boot(brand, options = {}) {
  const page = loadPage({ fetch: answering(brand), ...options })
  await flush()
  return page
}

// Everything a microphone-capable browser hands the page, as far as drawing the orb needs.
const ABLE = { mediaDevices: { getUserMedia: () => new Promise(() => {}) }, RTCPeerConnection: function RTCPeerConnection() {} }

/* ---------- drawn or not ---------- */

test('the orb is drawn only when /api/brand says voice is on - with or without a picture store', async () => {
  for (const enabled of [false, true]) {
    const page = await boot(brandAnswer({ enabled, voice: VOICE_ON }))
    const dock = page.node('voice-dock')
    assert.equal(dock.hidden, false, `voice on, personalising ${enabled}: the orb is hidden`)
    assert.match(dock.innerHTML, /class="voice-orb"/)
    assert.ok(page.node('body').classList.contains('voice-on'), 'nothing makes room at the bottom of the page for the orb')
  }
  for (const voice of [undefined, null, { on: false, why: 'No key.' }, { on: 'true' }, { on: 1 }, 'on']) {
    const page = await boot(brandAnswer({ enabled: true, voice }))
    const dock = page.node('voice-dock')
    assert.equal(dock.hidden, true, `${JSON.stringify(voice)}: the orb is shown`)
    assert.equal(dock.innerHTML, '')
  }
  const failed = loadPage({ fetch: async (url) => (url.startsWith('/api/brand') ? Promise.reject(new TypeError('offline')) : { ok: true, status: 200, json: async () => basePayload() }) })
  await flush()
  assert.equal(failed.node('voice-dock').hidden, true, 'a failed /api/brand showed the orb')
})

test('the page has a dock for the orb outside every screen, hidden until the brand says otherwise', async () => {
  const { html } = await import('./helpers/page-harness.mjs')
  assert.match(html, /<div class="voice-dock" id="voice-dock" hidden><\/div>/)
  const dockAt = html.indexOf('id="voice-dock"')
  assert.ok(dockAt > html.indexOf('</nav>') && dockAt < html.indexOf('<script>'), 'the dock is inside something that is redrawn')
})

/* ---------- what a screen reader is told ---------- */

test('the orb is a real button with a name and aria-pressed, and the state is read out politely', async () => {
  const page = await boot(brandAnswer({ enabled: true, assistantName: 'Penny', voice: VOICE_ON }), { expose: ['voiceDockHtml'] })
  const markup = page.node('voice-dock').innerHTML
  const orb = /<button\b[^>]*class="voice-orb"[^>]*>/.exec(markup)?.[0]
  assert.ok(orb, 'the orb is not a button')
  assert.match(orb, /type="button"/)
  assert.match(orb, /aria-pressed="false"/)
  assert.match(orb, /aria-controls="voice-sheet"/)
  assert.match(markup, /<span class="visually-hidden" id="voice-label">Talk to Penny<\/span>/, 'the orb has no name a screen reader can say')
  assert.match(markup, /<p class="voice-state" id="voice-state" role="status" aria-live="polite">/)
  assert.match(markup, /<button class="fire voice-stop" type="button" id="voice-stop">Stop<\/button>/)
  const unnamed = await boot(brandAnswer({ voice: VOICE_ON }))
  assert.match(unnamed.node('voice-dock').innerHTML, />Talk to your assistant</)
})

test('the assistant\'s name is escaped wherever the orb and sheet show it', async () => {
  const page = await boot(brandAnswer({ enabled: true, assistantName: '<img src=x onerror=alert(1)>', voice: VOICE_ON }))
  const markup = page.node('voice-dock').innerHTML
  assert.ok(!markup.includes('<img'), 'the name went in as markup')
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/)
})

test('every state is said in words, and the orb carries the state for its shape', async () => {
  const page = await boot(brandAnswer({ enabled: true, assistantName: 'Penny', voice: VOICE_ON }), { expose: ['voiceUi', 'voiceWords'] })
  const { voiceUi, voiceWords } = page.exposed
  const expected = {
    idle: 'Talk to Penny',
    connecting: 'Connecting…',
    listening: 'Listening',
    thinking: 'Thinking',
    speaking: 'Speaking - talk to interrupt'
  }
  for (const [state, words] of Object.entries(expected)) {
    assert.equal(voiceWords(state), words)
    voiceUi.show(state, { live: state !== 'idle' })
    assert.equal(page.node('voice-state').textContent, words)
    assert.equal(page.node('voice-orb').dataset.state, state)
    assert.equal(page.node('voice-orb').attributes['aria-pressed'], String(state !== 'idle'))
  }
  voiceUi.show('error', { words: 'The microphone is blocked. Allow it and tap again.' })
  assert.equal(page.node('voice-state').textContent, 'The microphone is blocked. Allow it and tap again.')
  assert.equal(page.node('voice-sheet').hidden, false, 'an error was said in a sheet nobody can see')
  assert.equal(page.node('voice-stop').textContent, 'Close')
  assert.equal(page.node('voice-orb').focused, 0, 'the orb took the focus on its own')
  assert.equal(page.node('voice-stop').focused, 0, 'Stop took the focus on its own')
})

/* ---------- text, never markup ---------- */

test('what was heard and what the assistant says are set as text, never as markup', async () => {
  const page = await boot(brandAnswer({ voice: VOICE_ON }), { expose: ['voiceUi'] })
  const hostile = '<img src=x onerror=alert(1)>Three jobs are due.'
  page.exposed.voiceUi.said(hostile)
  page.exposed.voiceUi.you(hostile)
  page.exposed.voiceUi.cost(hostile)
  for (const id of ['voice-said', 'voice-you', 'voice-cost']) {
    assert.equal(page.node(id).textContent, hostile)
    assert.equal(page.node(id).innerHTML, '', `${id} was given markup`)
  }
  // And in the source: inside the voice section, innerHTML is only ever the dock's own markup or the
  // spend card's, never anything the model or a caption said.
  const start = script.indexOf('/* ---------- Talk to the board: the orb and the sheet')
  const end = script.indexOf('/* ---------- shell ---------- */')
  assert.ok(start > 0 && end > start, 'the voice section is not where this test looks')
  const writes = [...script.slice(start, end).matchAll(/([\w.]+)\.innerHTML\s*=\s*([^\n]+)/g)].map((found) => `${found[1]} = ${found[2].trim()}`)
  for (const write of writes) {
    assert.match(write, /^(dock = voiceDockHtml\(\)|dock = ''|card = voiceSpendInnerHtml\(\))$/, `an innerHTML write in the voice code: ${write}`)
  }
})

/* ---------- unavailable ---------- */

test('a browser that cannot use a microphone shows the orb as unavailable, and a tap says why instead of failing', async () => {
  const page = await boot(brandAnswer({ voice: VOICE_ON }), { expose: ['voiceDockHtml', 'voiceTap', 'voiceCanListen'] })
  assert.equal(page.exposed.voiceCanListen({}), false)
  assert.equal(page.exposed.voiceCanListen({ mediaDevices: {} }), false)
  assert.equal(page.exposed.voiceCanListen(ABLE), true)
  // The harness's window has no RTCPeerConnection, like an old browser.
  assert.match(page.node('voice-dock').innerHTML, /class="voice-orb"[^>]*aria-disabled="true"/)
  page.exposed.voiceTap({})
  assert.match(page.node('voice-state').textContent, /cannot use a microphone/)
  assert.equal(page.node('voice-sheet').hidden, false)
  assert.equal(page.node('voice-orb').dataset.state, 'error')
})

/* ---------- ending ---------- */

test('Esc, Stop, and the page being hidden or closed all end a live session', async () => {
  const fakeSession = () => ({ stopped: [], stop(reason) { this.stopped.push(reason) } })
  const live = async (session) => boot(brandAnswer({ voice: VOICE_ON }), { after: 'voiceSession = given.session', given: { session } })
  const fire = (page, type, event, from = page.documentListeners) => {
    const found = from.filter((listener) => listener.type === type)
    assert.ok(found.length, `nothing listens for ${type}`)
    for (const listener of found) listener.handler(event)
  }

  const keys = fakeSession()
  const typing = await live(keys)
  fire(typing, 'keydown', { key: 'Enter' })
  assert.deepEqual(keys.stopped, [], 'a key other than Esc ended the session')
  fire(typing, 'keydown', { key: 'Escape' })
  assert.deepEqual(keys.stopped, ['stopped'])

  const hidden = fakeSession()
  const away = await live(hidden)
  away.document.visibilityState = 'hidden'
  fire(away, 'visibilitychange', {})
  assert.deepEqual(hidden.stopped, ['hidden'], 'a hidden tab kept talking')

  const closed = fakeSession()
  const gone = await live(closed)
  fire(gone, 'pagehide', {}, gone.windowListeners)
  assert.deepEqual(closed.stopped, ['hidden'], 'a closed tab kept talking')

  const stopped = fakeSession()
  const pressed = await live(stopped)
  const stop = { closest: (selector) => (selector === '#voice-stop' ? stop : null) }
  fire(pressed, 'click', { target: stop })
  assert.deepEqual(stopped.stopped, ['stopped'], 'Stop did not end the session')
})

test('a reading of the repo redraws the screens, never a live sheet', async () => {
  const page = await boot(brandAnswer({ voice: VOICE_ON }), { expose: ['renderVoiceDock'], after: 'voiceSession = given.session', given: { session: { stop() {} } } })
  const dock = page.node('voice-dock')
  dock.innerHTML = 'WHAT WAS SAID SO FAR'
  page.exposed.renderVoiceDock()
  assert.equal(dock.innerHTML, 'WHAT WAS SAID SO FAR')
})

/* ---------- Make it yours ---------- */

test('Make it yours says which voice speaks, or why voice is off', async () => {
  const on = await boot(brandAnswer({ enabled: true, voice: { on: true, mouth: 'openai' } }), { expose: ['brandPanelHtml'] })
  assert.match(on.exposed.brandPanelHtml(), /Speaking with OpenAI&#39;s voice - add Fish for your own voice\./)
  const half = await boot(brandAnswer({ enabled: true, voice: { on: true, mouth: 'openai', note: 'Fish needs both FISH_API_KEY and FISH_VOICE_ID.' } }), { expose: ['brandPanelHtml'] })
  assert.match(half.exposed.brandPanelHtml(), /Fish needs both FISH_API_KEY and FISH_VOICE_ID\./)
  const fish = await boot(brandAnswer({ enabled: true, voice: { on: true, mouth: 'fish' } }), { expose: ['brandPanelHtml'] })
  assert.match(fish.exposed.brandPanelHtml(), /Speaking with your Fish voice/)
  const off = await boot(brandAnswer({ enabled: true, voice: { on: false, why: 'Talking to the board needs OPENAI_API_KEY <now>.' } }), { expose: ['brandPanelHtml'] })
  assert.match(off.exposed.brandPanelHtml(), /Talking to the board needs OPENAI_API_KEY &lt;now&gt;\./)
})

/* ---------- the look ---------- */

const rules = cssRules()
const unconditional = (selector) => rules.filter((rule) => rule.selector === selector && !rule.inMedia)
const declared = (rule) => Object.fromEntries(rule.body.split(';').map((part) => part.trim()).filter(Boolean)
  .map((part) => [part.slice(0, part.indexOf(':')).trim(), part.slice(part.indexOf(':') + 1).trim()]))
const valuesOf = (selector) => Object.assign({}, ...unconditional(selector).map(declared))
const rem = (value) => Number(/^([\d.]+)rem$/.exec(value ?? '')?.[1] ?? NaN)

test('every class the orb and the sheet use is one the stylesheet styles', async () => {
  const page = await boot(brandAnswer({ voice: VOICE_ON }), { expose: ['voiceDockHtml'] })
  const used = classesIn(page.exposed.voiceDockHtml())
  assert.ok(used.size >= 8, `only ${used.size} classes found`)
  for (const name of used) {
    const styled = rules.some((rule) => new RegExp(`\\.${name}(?![\\w-])`).test(rule.selector))
    assert.ok(styled, `class "${name}" has no rule`)
  }
})

test('the orb is 3.5rem and every control in the dock is at least 2.75rem, a thumb\'s width', () => {
  const orb = valuesOf('.voice-orb')
  assert.equal(orb.width, '3.5rem')
  assert.equal(orb.height, '3.5rem')
  assert.ok(rem(orb['min-width']) >= 2.75 && rem(orb['min-height']) >= 2.75)
  assert.equal(orb['border-radius'], '50%')
  // Stop is one of the board's buttons, which are 2.9rem tall.
  const buttons = rules.filter((rule) => !rule.inMedia && rule.selector.split(',').map((one) => one.trim()).includes('button.fire'))
  assert.ok(buttons.some((rule) => rem(declared(rule)['min-height']) >= 2.75), 'the board buttons are under 2.75rem')
})

test('the orb sits bottom-right above the phone\'s home bar, on every screen, and never takes the page sideways', () => {
  const dock = valuesOf('.voice-dock')
  assert.equal(dock.position, 'fixed')
  assert.equal(dock.left, '1rem', 'the dock is not held inside the screen on the left')
  assert.equal(dock.right, '1rem', 'the dock is not held inside the screen on the right')
  assert.match(dock.bottom, /env\(safe-area-inset-bottom/, 'the orb can sit under the iPhone home bar')
  assert.equal(dock['pointer-events'], 'none', 'the full-width dock would block taps on the page under it')
  assert.ok(rules.some((rule) => rule.selector === '.voice-dock > *' && /pointer-events:\s*auto/.test(rule.body)))
  // At 390px the sheet is the dock's width - the screen less two gutters - and scrolls inside itself.
  const sheet = valuesOf('.voice-sheet')
  assert.equal(sheet.width, '100%')
  assert.equal(sheet['min-width'], undefined)
  assert.equal(sheet['overflow-y'], 'auto')
  assert.ok(sheet['max-height'], 'a long conversation can push the sheet off the top of the screen')
  // From 1024px it is docked at a fixed width beside the orb.
  const wide = rules.filter((rule) => rule.selector === '.voice-sheet' && /min-width: 64rem/.test(rule.condition))
  assert.equal(wide.length, 1, 'the sheet is not docked at a fixed width on a wide screen')
  assert.equal(declared(wide[0]).width, '22rem')
  // Room at the bottom of the page, so the orb never covers the last thing on it.
  assert.ok(rules.some((rule) => rule.selector === '.voice-on .wrap' && /padding-bottom/.test(rule.body)))
})

test('the listening pulse runs only for someone who has not asked for less motion, and the shape still shows without it', () => {
  const animated = rules.filter((rule) => /\.voice-orb/.test(rule.selector) && /animation\s*:/.test(rule.body))
  assert.ok(animated.length >= 1, 'there is no pulse at all')
  for (const rule of animated) {
    assert.match(rule.condition, /prefers-reduced-motion: no-preference/, `${rule.selector} animates for someone who asked for less motion`)
  }
  // Listening is told apart by a ring that does not need to move.
  assert.ok(unconditional('.voice-orb[data-state="listening"]').some((rule) => /box-shadow/.test(rule.body)))
  for (const state of ['connecting', 'thinking', 'speaking', 'error']) {
    assert.ok(rules.some((rule) => rule.selector.includes(`[data-state="${state}"]`)), `${state} has no shape of its own`)
  }
})

/* ---------- the footer's promise ---------- */

test('with voice on, the footer no longer says nothing on the page comes from anywhere else', async () => {
  const on = await boot(brandAnswer({ voice: VOICE_ON }))
  const said = on.node('foot').textContent
  assert.match(said, /^Read from your repo /)
  assert.doesNotMatch(said, /Nothing on this page comes from anywhere else/, 'the footer promises something voice makes untrue')
  assert.match(said, /what the assistant says comes from OpenAI/)
  assert.match(said, /Voice spend is the board's own estimate/)
  const off = await boot(brandAnswer({ voice: { on: false, why: 'No key.' } }))
  assert.match(off.node('foot').textContent, /^Read from your repo .*\. Nothing on this page comes from anywhere else\.$/)
})

test('while the sheet is open, the page can scroll its last content clear of it', async () => {
  // The sheet can be min(60vh, 28rem) tall over the bottom of the screen; without room the Voice
  // spend card and the footer would sit under it with no way to scroll them out.
  const page = await boot(brandAnswer({ voice: VOICE_ON }), { expose: ['voiceUi'] })
  const body = page.node('body')
  page.exposed.voiceUi.show('speaking', { live: true })
  assert.ok(body.classList.contains('voice-open'), 'nothing tells the page the sheet is open')
  page.exposed.voiceUi.show('idle', { live: false })
  assert.ok(!body.classList.contains('voice-open'), 'the room stays after the sheet is closed')
  page.exposed.voiceUi.show('error', { words: 'x', live: false })
  assert.ok(body.classList.contains('voice-open'), 'an error in the sheet can cover the page end')

  const sheetHeight = valuesOf('.voice-sheet')['max-height']
  const room = rules.filter((rule) => rule.selector === '.voice-open .wrap' && !rule.inMedia).map(declared)
  assert.equal(room.length, 1, 'there is no room made for the open sheet')
  assert.ok(room[0]['padding-bottom'].includes(sheetHeight), `the room (${room[0]['padding-bottom']}) is not the sheet's height (${sheetHeight}) plus the orb`)
  assert.match(room[0]['padding-bottom'], /\+ [\d.]+rem/, 'the room leaves out the orb under the sheet')
  assert.match(room[0]['padding-bottom'], /safe-area-inset-bottom/)
})

/* ---------- speakers or headphones, on a computer ---------- */

const COMPUTER = { media: { '(pointer: fine)': true } }
const HEADPHONES = 'agent-cockpit-voice-headphones'

test('on a computer the sheet says it is in speakers mode, and "I\'m on headphones" is a real toggle this device remembers', async () => {
  const page = await boot(brandAnswer({ voice: VOICE_ON }), { ...COMPUTER, expose: ['voiceDeps'] })
  const markup = page.node('voice-dock').innerHTML
  assert.match(markup, /<p class="voice-mode" id="voice-mode">Speakers mode: the microphone rests while it talks, so tap the orb or press Space to interrupt\.<\/p>/)
  assert.match(markup, /<button class="fire voice-toggle" type="button" id="voice-headphones" aria-pressed="false">I&#39;m on headphones<\/button>/)
  const press = () => {
    const toggle = { closest: (selector) => (selector === '#voice-headphones' ? toggle : null) }
    for (const listener of page.documentListeners.filter((one) => one.type === 'click')) listener.handler({ target: toggle })
  }
  press()
  assert.equal(page.storage.getItem(HEADPHONES), 'on')
  assert.equal(page.node('voice-headphones').attributes['aria-pressed'], 'true')
  assert.match(page.node('voice-mode').textContent, /^Headphones mode: talk over it to interrupt\./)
  assert.equal(page.exposed.voiceDeps().headphones(), true)
  press()
  assert.equal(page.storage.getItem(HEADPHONES), null)
  assert.equal(page.node('voice-headphones').attributes['aria-pressed'], 'false')

  const again = await boot(brandAnswer({ voice: VOICE_ON }), { ...COMPUTER, storage: { [HEADPHONES]: 'on' } })
  assert.match(again.node('voice-dock').innerHTML, /id="voice-headphones" aria-pressed="true"/)
  assert.match(again.node('voice-dock').innerHTML, /Headphones mode: talk over it to interrupt\./)
})

test('pressing the toggle mid-call tells the call at once', async () => {
  const told = []
  const page = await boot(brandAnswer({ voice: VOICE_ON }), { ...COMPUTER, after: 'voiceSession = given.session', given: { session: { stop() {}, setSpeakersMode: (on) => told.push(on) } } })
  const toggle = { closest: (selector) => (selector === '#voice-headphones' ? toggle : null) }
  for (const listener of page.documentListeners.filter((one) => one.type === 'click')) listener.handler({ target: toggle })
  assert.deepEqual(told, [false])
})

test('a phone has no mode line and no toggle: it always talks over', async () => {
  const page = await boot(brandAnswer({ voice: VOICE_ON }))
  assert.doesNotMatch(page.node('voice-dock').innerHTML, /voice-headphones|voice-mode/)
})

test('the orb, Esc and Space interrupt a reply; with nothing to interrupt, the orb and Esc end the call and Space does nothing', async () => {
  const session = (replying) => ({
    stopped: [], interrupted: 0,
    interrupt() { if (replying) this.interrupted += 1; return replying },
    stop(reason) { this.stopped.push(reason) }
  })
  const live = async (one) => boot(brandAnswer({ voice: VOICE_ON }), { after: 'voiceSession = given.session', given: { session: one } })
  const fire = (page, type, event) => { for (const listener of page.documentListeners.filter((entry) => entry.type === type)) listener.handler(event) }
  const orb = { closest: (selector) => (selector === '#voice-orb' ? orb : null) }

  const replying = session(true)
  const page = await live(replying)
  fire(page, 'click', { target: orb })
  fire(page, 'keydown', { key: 'Escape' })
  let prevented = 0
  fire(page, 'keydown', { key: ' ', target: { tagName: 'BODY' }, preventDefault: () => { prevented += 1 } })
  assert.equal(replying.interrupted, 3, 'the orb, Esc and Space did not each interrupt')
  assert.deepEqual(replying.stopped, [], 'an interrupt ended the call')
  assert.equal(prevented, 1, 'Space also scrolled the page')
  for (const tagName of ['TEXTAREA', 'INPUT', 'BUTTON', 'SELECT']) fire(page, 'keydown', { key: ' ', target: { tagName } })
  fire(page, 'keydown', { key: ' ', target: { tagName: 'DIV', isContentEditable: true } })
  assert.equal(replying.interrupted, 3, 'Space typed into a field interrupted')

  const quiet = session(false)
  const idle = await live(quiet)
  fire(idle, 'keydown', { key: ' ', target: { tagName: 'BODY' } })
  assert.deepEqual(quiet.stopped, [], 'Space ended the call')
  fire(idle, 'click', { target: orb })
  fire(idle, 'keydown', { key: 'Escape' })
  assert.deepEqual(quiet.stopped, ['stopped', 'stopped'])
})

test('the page asks for the guard\'s transcript only where the guard runs: a computer on headphones', async () => {
  const call = async (options) => {
    const page = await boot(brandAnswer({ voice: VOICE_ON }), { ...options, expose: ['voiceDeps'] })
    await page.exposed.voiceDeps().startCall('v=0\r\n')
    return JSON.parse(page.requests.find((request) => request.url === '/api/voice-session').init.body).echoGuardHere
  }
  assert.equal(await call(COMPUTER), false, 'a computer in speakers mode asked for a transcript nothing reads')
  assert.equal(await call({ ...COMPUTER, storage: { [HEADPHONES]: 'on' } }), true)
  assert.equal(await call({ storage: { [HEADPHONES]: 'on' } }), false, 'a phone asked for the guard\'s transcript')
})

test('every class the computer\'s sheet adds is one the stylesheet styles', async () => {
  const page = await boot(brandAnswer({ voice: VOICE_ON }), { ...COMPUTER, expose: ['voiceDockHtml'] })
  for (const name of ['voice-mode', 'voice-toggle']) {
    assert.ok(classesIn(page.exposed.voiceDockHtml()).has(name), `${name} is not drawn`)
    assert.ok(rules.some((rule) => new RegExp(`\\.${name}(?![\\w-])`).test(rule.selector)), `class "${name}" has no rule`)
  }
})

test('Space on the focused orb never ends the call: it interrupts a reply, and otherwise does nothing', async () => {
  const session = (replying) => ({ stopped: [], interrupted: 0, interrupt() { if (replying) this.interrupted += 1; return replying }, handlesTap() { return this.interrupt() }, stop(reason) { this.stopped.push(reason) } })
  const fire = (page, type, event) => { for (const listener of page.documentListeners.filter((entry) => entry.type === type)) listener.handler(event) }
  const orb = { tagName: 'BUTTON', closest: (selector) => (selector === '#voice-orb' ? orb : null) }
  for (const replying of [true, false]) {
    const one = session(replying)
    const page = await boot(brandAnswer({ voice: VOICE_ON }), { after: 'voiceSession = given.session', given: { session: one } })
    let prevented = 0
    const press = { key: ' ', target: orb, preventDefault: () => { prevented += 1 } }
    fire(page, 'keydown', press)
    fire(page, 'keyup', press)
    assert.equal(prevented, 2, 'the browser was left to press the orb with Space')
    assert.equal(one.interrupted, replying ? 1 : 0)
    assert.deepEqual(one.stopped, [], 'Space on the orb ended the call')
  }
})

test('a tap or Esc the call takes as a late interrupt does not end it', async () => {
  const late = { stopped: [], handlesTap: () => true, interrupt: () => false, stop(reason) { this.stopped.push(reason) } }
  const page = await boot(brandAnswer({ voice: VOICE_ON }), { after: 'voiceSession = given.session', given: { session: late } })
  const orb = { closest: (selector) => (selector === '#voice-orb' ? orb : null) }
  for (const listener of page.documentListeners.filter((entry) => entry.type === 'click')) listener.handler({ target: orb })
  for (const listener of page.documentListeners.filter((entry) => entry.type === 'keydown')) listener.handler({ key: 'Escape' })
  assert.deepEqual(late.stopped, [])
})
