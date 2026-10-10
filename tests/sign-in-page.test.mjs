// The page's side of signing in (spec 2026-10-10, build tasks 9, 10 and 11).
//
// 9.  A real sign-in form: username and password fields a phone's keychain or a browser saves,
//     sent with fetch, then the page loads again (which is when a keychain offers to save). No key
//     is ever written to this device's storage; the cookie is the browser's, out of the page's reach.
// 10. A device that kept the old view key in storage moves over by itself: the key is sent once to
//     /api/login as the spare key and deleted, and nobody types anything.
// 11. Signed out while the board is open: the 60-second check stops and says to sign in again; a
//     Vercel sign-in that ran out (a redirect) says to reload; the voice orb says the server's
//     sentence and does not try again. Sign out, and sign out everywhere, are two buttons.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadPage, flush, html } from './helpers/page-harness.mjs'
import { basePayload } from './helpers/page-payload.mjs'

const OLD_KEY = 'agent-cockpit-view-key'
const answer = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, type: 'basic', headers: { get: () => null }, json: async () => body })

// A board whose server answers each address from `routes` (a function of the request), recording
// every request in order.
function boardWith(routes, options = {}) {
  const sent = []
  const page = loadPage({
    ...options,
    fetch: async (url, init = {}) => {
      sent.push({ url, init, method: init.method ?? 'GET', body: init.body === undefined ? undefined : JSON.parse(init.body) })
      const routed = await routes({ url, init, sent })
      if (routed) return routed
      if (url.startsWith('/api/state')) return answer(200, basePayload())
      return answer(200, {})
    }
  })
  return { page, sent, logins: () => sent.filter((one) => one.url === '/api/login') }
}

const signedOut = ({ url }) => (url.startsWith('/api/state') ? answer(401, { needs: 'sign-in', error: 'Signed out: reload the board and sign in again.' }) : null)
const submit = (page, id) => {
  const event = { prevented: false, preventDefault() { this.prevented = true } }
  for (const handler of page.node(id).listeners.submit ?? []) handler(event)
  return event
}

/* ---------- 9: the form ---------- */

test('a board that is not signed in shows a sign-in form a keychain can fill and save', async () => {
  const { page } = boardWith(signedOut)
  await flush()
  const drawn = page.node('body').innerHTML
  assert.match(drawn, /<form id="sign-in-form"/)
  assert.match(drawn, /<input id="sign-in-user"[^>]*autocomplete="username"/)
  assert.match(drawn, /<input id="sign-in-password"[^>]*type="password"[^>]*autocomplete="current-password"/)
  // A phone would otherwise capitalise the first letter and "correct" the name.
  assert.match(drawn, /<input id="sign-in-user"[^>]*autocapitalize="none"/)
  // Every field has a label a screen reader reads, and the note that answers is a live region.
  assert.match(drawn, /<label for="sign-in-user">Username<\/label>/)
  assert.match(drawn, /<label for="sign-in-password">Password<\/label>/)
  assert.match(drawn, /id="sign-in-note"[^>]*role="status"/)
  assert.match(drawn, /<button[^>]*type="submit"[^>]*>Sign in<\/button>/)
  assert.equal(page.node('sign-in-user').focused, 1, 'the cursor is not in the username field')
})

test('the form is fixed markup, and the server\'s words go in as text, never as markup', async () => {
  const hostile = '<img src=x onerror=alert(1)> did not match'
  const { page } = boardWith((request) => (request.url === '/api/login' ? answer(401, { error: hostile }) : signedOut(request)))
  await flush()
  assert.ok(!page.node('body').innerHTML.includes('${'), 'the sign-in markup has something put into it')
  page.node('sign-in-password').value = 'x'
  submit(page, 'sign-in-form')
  await flush()
  assert.equal(page.node('sign-in-note').textContent, hostile)
  assert.equal(page.node('sign-in-note').innerHTML, '', 'a sentence from the server was set as markup')
})

test('signing in sends the two fields as JSON, then loads the page again - and keeps nothing on the device', async () => {
  const { page, logins } = boardWith((request) => (request.url === '/api/login' ? answer(204) : signedOut(request)))
  await flush()
  page.node('sign-in-user').value = 'Nuno'
  page.node('sign-in-password').value = 'correct horse battery staple'
  const event = submit(page, 'sign-in-form')
  await flush()
  assert.equal(event.prevented, true, 'the form was left to submit itself (the policy forbids that, form-action none)')
  assert.equal(logins().length, 1)
  const [login] = logins()
  assert.equal(login.method, 'POST')
  assert.equal(login.init.headers['Content-Type'], 'application/json')
  assert.deepEqual(login.body, { username: 'Nuno', password: 'correct horse battery staple' })
  assert.equal(page.location.reloads, 1, 'the page did not load again, so a keychain is not offered the password')
  assert.equal(page.storage.store.size, 0, `something was kept on the device: ${[...page.storage.store.keys()]}`)
})

test('a refused sign-in says the server\'s sentence, keeps the username, and empties nothing else', async () => {
  const refusal = 'That username and password did not match. Check them and try again, or use the spare key.'
  const { page } = boardWith((request) => (request.url === '/api/login' ? answer(401, { error: refusal }) : signedOut(request)))
  await flush()
  page.node('sign-in-user').value = 'Nuno'
  page.node('sign-in-password').value = 'wrong'
  submit(page, 'sign-in-form')
  await flush()
  assert.equal(page.node('sign-in-note').textContent, refusal)
  assert.equal(page.location.reloads, 0)
  assert.equal(page.node('sign-in-user').value, 'Nuno')
  assert.equal(page.node('sign-in-submit').disabled, false, 'the button stayed off after a refusal')
  assert.ok(page.node('sign-in-password').focused >= 1, 'the cursor was not put back in the password')
})

test('a sign-in that never reached the board says so', async () => {
  const { page } = boardWith((request) => {
    if (request.url === '/api/login') throw new TypeError('offline')
    return signedOut(request)
  })
  await flush()
  page.node('sign-in-password').value = 'anything'
  submit(page, 'sign-in-form')
  await flush()
  assert.match(page.node('sign-in-note').textContent, /could not reach the board/i)
})

test('"Use the spare key" opens a one-field form that sends the key as the password', async () => {
  const { page, logins } = boardWith((request) => (request.url === '/api/login' ? answer(204) : signedOut(request)))
  await flush()
  assert.match(page.node('body').innerHTML, /<form id="spare-key-form"[^>]*hidden/)
  assert.match(page.node('body').innerHTML, /<button[^>]*id="spare-key-show"[^>]*aria-expanded="false"[^>]*>Use the spare key instead<\/button>/)
  for (const handler of page.node('spare-key-show').listeners.click ?? []) handler({})
  assert.equal(page.node('spare-key-form').hidden, false)
  assert.equal(page.node('spare-key-show').attributes['aria-expanded'], 'true')
  page.node('spare-key').value = '  vk_the_spare_key  '
  submit(page, 'spare-key-form')
  await flush()
  assert.deepEqual(logins()[0].body, { username: '', password: 'vk_the_spare_key' })
  assert.equal(page.location.reloads, 1)
})

test('no request the page makes carries a key: the signed-in cookie does that by itself', async () => {
  const { sent } = boardWith(() => null, { storage: { 'agent-cockpit-edit-key': 'ek_held' } })
  await flush()
  assert.ok(sent.length >= 2)
  for (const request of sent) {
    assert.equal(request.init.headers?.['x-view-key'], undefined, `${request.url} carried the view key`)
  }
})

/* ---------- 10: devices that kept the old key ---------- */

test('a device holding the old view key sends it once to /api/login, deletes it, and then loads the board', async () => {
  const { page, sent, logins } = boardWith((request) => (request.url === '/api/login' ? answer(204) : null), { storage: { [OLD_KEY]: 'vk_old_key' } })
  await flush()
  assert.equal(logins().length, 1)
  assert.equal(sent[0].url, '/api/login', 'the board was asked for before the device moved over')
  assert.deepEqual(logins()[0].body, { username: '', password: 'vk_old_key' })
  assert.equal(page.storage.getItem(OLD_KEY), null, 'the old key is still on the device')
  assert.ok(sent.some((request) => request.url === '/api/state'), 'the board was not loaded after the move')
  assert.equal(page.location.reloads, 0, 'moving over loaded the page again for nothing')
})

test('an old key that no longer works is deleted, the form is shown, and nothing loops', async () => {
  const { page, logins } = boardWith((request) => (request.url === '/api/login' ? answer(401, { error: 'did not match' }) : signedOut(request)), { storage: { [OLD_KEY]: 'vk_stale' } })
  await flush(12)
  assert.equal(logins().length, 1)
  assert.equal(page.storage.getItem(OLD_KEY), null)
  assert.match(page.node('body').innerHTML, /id="sign-in-form"/)
})

test('a move that never reached the board keeps the key for the next load, once, and carries on', async () => {
  const { page, logins } = boardWith((request) => {
    if (request.url === '/api/login') throw new TypeError('offline')
    return signedOut(request)
  }, { storage: { [OLD_KEY]: 'vk_old_key' } })
  await flush(12)
  assert.equal(logins().length, 1)
  assert.equal(page.storage.getItem(OLD_KEY), 'vk_old_key')
  assert.match(page.node('body').innerHTML, /id="sign-in-form"/)
})

test('a device with nothing kept goes straight to the board', async () => {
  const { logins } = boardWith(() => null)
  await flush()
  assert.equal(logins().length, 0)
})

/* ---------- 11: signed out while the board is open ---------- */

test('a change refused because the device is signed out shows the server\'s sentence and never asks for a key', async () => {
  const asked = []
  const sentence = 'Signed out: reload the board and sign in again.'
  const { page, sent } = boardWith(({ init }) => (init.method === 'POST' ? answer(401, { needs: 'sign-in', error: sentence }) : null), {
    prompt: (text) => { asked.push(text); return 'a key' },
    expose: ['storeWrite']
  })
  await flush()
  await assert.rejects(page.exposed.storeWrite('/api/voice-session', '{}', 'application/json'), new RegExp(sentence.slice(0, 20)))
  assert.equal(asked.length, 0)
  assert.equal(sent.filter((request) => request.url === '/api/voice-session').length, 1, 'it was sent again')
})

test('the voice call is started through that same write, so a signed-out orb says the sentence and stops', async () => {
  const { script } = await import('./helpers/page-harness.mjs')
  assert.match(script, /startCall: \(sdp\) => storeWrite\('\/api\/voice-session'/)
})

/* ---------- signing out ---------- */

test('the board has Sign out and Sign out everywhere, outside every screen', () => {
  assert.match(html, /<button type="button" class="link-button" id="sign-out">Sign out<\/button>/)
  assert.match(html, /<button type="button" class="link-button" id="sign-out-everywhere">Sign out everywhere<\/button>/)
  assert.match(html, /id="session-note"[^>]*role="status"/)
})

test('Sign out takes this device out and shows the form', async () => {
  const { page, sent } = boardWith(({ url }) => (url === '/api/logout' ? answer(204) : null))
  await flush()
  for (const handler of page.node('sign-out').listeners.click ?? []) await handler({})
  await flush()
  const out = sent.find((request) => request.url === '/api/logout')
  assert.equal(out.method, 'POST')
  assert.deepEqual(out.body, {})
  assert.equal(out.init.headers['Content-Type'], 'application/json')
  assert.match(page.node('body').innerHTML, /id="sign-in-form"/)
  assert.match(page.node('sign-in-note').textContent, /signed out/i)
})

test('Sign out everywhere asks first, then signs every device out', async () => {
  const questions = []
  let yes = false
  const { page, sent } = boardWith(({ url }) => (url === '/api/logout' ? answer(204) : null), { confirm: (text) => { questions.push(text); return yes } })
  await flush()
  for (const handler of page.node('sign-out-everywhere').listeners.click ?? []) await handler({})
  await flush()
  assert.equal(questions.length, 1)
  assert.match(questions[0], /every device/i)
  assert.equal(sent.filter((request) => request.url === '/api/logout').length, 0, 'it went ahead without a yes')
  yes = true
  for (const handler of page.node('sign-out-everywhere').listeners.click ?? []) await handler({})
  await flush()
  const out = sent.find((request) => request.url === '/api/logout')
  assert.deepEqual(out.body, { everywhere: true })
  assert.match(page.node('sign-in-note').textContent, /every device/i)
})

test('a sign-out everywhere that is refused says why and leaves the board as it was', async () => {
  const why = 'Signing out everywhere is kept in the picture store, and this board has none connected.'
  const { page } = boardWith(({ url }) => (url === '/api/logout' ? answer(503, { error: why }) : null), { confirm: () => true })
  await flush()
  for (const handler of page.node('sign-out-everywhere').listeners.click ?? []) await handler({})
  await flush()
  assert.equal(page.node('session-note').textContent, why)
  assert.doesNotMatch(page.node('body').innerHTML, /sign-in-form/)
})
