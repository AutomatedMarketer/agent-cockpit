// The Settings box of the board on this computer, added after app.js by the local server only (the
// website has no such box: it keeps its keys in environment variables). A small button opens a panel
// where a student pastes an OpenAI key (and, if they like, a Fish Audio or OpenRouter key).
//
// Built with textContent only - nothing the server says is ever put in as markup. The page never
// holds a saved key: the server sends only "saved" and the last four characters, and a key that was
// typed is cleared from its box the moment it is sent.
(function () {
  var ADDRESS = '/api/local-settings'
  var SLOTS = ['OPENAI_API_KEY', 'FISH_API_KEY', 'OPENROUTER_API_KEY']
  var HELP = {
    OPENAI_API_KEY: 'Voice needs this. Make a key at platform.openai.com (set a monthly limit first). It stays on this computer and is never shown again.',
    FISH_API_KEY: 'Only if you want a different voice.',
    OPENROUTER_API_KEY: 'Only if you use OpenRouter.'
  }

  function make(tag, attributes, text) {
    var node = document.createElement(tag)
    Object.keys(attributes || {}).forEach(function (name) { node.setAttribute(name, attributes[name]) })
    if (text !== undefined) node.textContent = text
    return node
  }

  function call(body) {
    return fetch(ADDRESS, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (response) { return response.json().catch(function () { return {} }).then(function (json) { return { ok: response.ok, status: response.status, json: json } }) })
      .catch(function () { return { ok: false, status: 0, json: { error: 'The board could not be reached.' } } })
  }

  var open = make('button', { type: 'button', id: 'board-settings-open', 'aria-expanded': 'false', 'aria-controls': 'board-settings' }, 'Settings')
  open.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:50;padding:8px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.35);background:rgba(20,24,40,.92);color:#fff;font:600 14px system-ui;cursor:pointer'
  var panel = make('section', { id: 'board-settings', 'aria-labelledby': 'board-settings-title', hidden: '' })
  panel.style.cssText = 'position:fixed;right:12px;bottom:56px;z-index:50;width:min(420px,calc(100vw - 24px));max-height:70vh;overflow:auto;padding:16px;border-radius:14px;border:1px solid rgba(255,255,255,.3);background:rgba(20,24,40,.97);color:#fff;font:14px/1.45 system-ui'
  panel.appendChild(make('h2', { id: 'board-settings-title' }, 'Settings'))
  var note = make('p', { id: 'board-settings-note', role: 'status', 'aria-live': 'polite' }, '')
  var rows = {}

  function show(text) { note.textContent = text }

  function render(keys) {
    SLOTS.forEach(function (slot) {
      var row = rows[slot]
      var info = keys && keys[slot]
      var saved = Boolean(info && info.saved)
      row.state.textContent = saved ? 'saved · ends in ••••' + info.last4 : 'not saved'
      row.input.hidden = saved
      row.save.hidden = saved
      row.test.hidden = !saved
      row.remove.hidden = !saved
      if (saved) row.input.value = ''
    })
  }

  SLOTS.forEach(function (slot) {
    var wrap = make('div', { 'data-slot': slot })
    wrap.style.cssText = 'margin:12px 0'
    var label = make('label', { 'for': 'board-key-' + slot }, '')
    var state = make('span', { id: 'board-state-' + slot, 'aria-live': 'polite' }, 'checking...')
    state.style.cssText = 'display:block;opacity:.85;margin:2px 0 6px'
    var input = make('input', { id: 'board-key-' + slot, type: 'password', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: 'Paste the key here' })
    input.style.cssText = 'width:100%;box-sizing:border-box;padding:8px;border-radius:8px'
    var save = make('button', { type: 'button', id: 'board-save-' + slot }, 'Save')
    var test = make('button', { type: 'button', id: 'board-test-' + slot, hidden: '' }, 'Test this key')
    var remove = make('button', { type: 'button', id: 'board-remove-' + slot, hidden: '' }, 'Remove')
    var help = make('small', {}, HELP[slot])
    help.style.cssText = 'display:block;opacity:.8;margin-top:6px'
    rows[slot] = { input: input, save: save, test: test, remove: remove, state: state, label: label }
    save.addEventListener('click', function () {
      var typed = input.value
      input.value = ''
      if (!typed) { show('Paste the key first.'); return }
      show('Saving...')
      call({ action: 'save', slot: slot, value: typed }).then(function (answer) {
        typed = ''
        if (!answer.ok) { show(answer.json.error || 'The key was not saved.'); return }
        render(answer.json.keys)
        show(slot === 'OPENAI_API_KEY' ? 'Saved. Reload this page to turn voice on.' : 'Saved.')
      })
    })
    test.addEventListener('click', function () {
      show('Checking...')
      call({ action: 'test', slot: slot }).then(function (answer) { show(answer.json.say || answer.json.error || 'The board could not check the key.') })
    })
    remove.addEventListener('click', function () {
      call({ action: 'remove', slot: slot }).then(function (answer) {
        if (!answer.ok) { show(answer.json.error || 'The key was not removed.'); return }
        render(answer.json.keys)
        show('Removed.')
      })
    })
    ;[label, state, input, save, test, remove, help].forEach(function (node) { wrap.appendChild(node) })
    panel.appendChild(wrap)
  })
  SLOTS.forEach(function (slot) { rows[slot].label.textContent = { OPENAI_API_KEY: 'OpenAI key (for voice)', FISH_API_KEY: 'Fish Audio key (optional)', OPENROUTER_API_KEY: 'OpenRouter key (optional)' }[slot] })
  panel.appendChild(note)

  var reload = make('button', { type: 'button', id: 'board-settings-reload' }, 'Reload the board')
  reload.addEventListener('click', function () { location.reload() })
  panel.appendChild(reload)

  open.addEventListener('click', function () {
    var shown = panel.hidden
    panel.hidden = !shown
    open.setAttribute('aria-expanded', String(shown))
    if (shown) call({ action: 'status' }).then(function (answer) { if (answer.ok) render(answer.json.keys); else show(answer.json.error || '') })
  })

  document.body.appendChild(panel)
  document.body.appendChild(open)
})()
