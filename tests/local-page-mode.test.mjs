// The page in local mode (the board on a student's own computer): no website sign-in screen, no
// "set this in Vercel" guidance, plain local words. The website's page is unchanged.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPage, flush } from './helpers/page-harness.mjs'
import { basePayload } from './helpers/page-payload.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const answer = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, type: 'basic', headers: { get: () => null }, json: async () => body })
const redirected = () => ({ ok: false, status: 0, type: 'opaqueredirect', headers: { get: () => null }, json: async () => ({}) })

const board = (state, options = {}) => loadPage({
  ...options,
  fetch: async (url) => (url.startsWith('/api/state') ? state() : answer(200, {}))
})
const signedOut = () => answer(401, { needs: 'sign-in', error: 'Signed out: reload the board and sign in again.' })

test('website page, signed out: the username and password screen, as before', async () => {
  const page = board(signedOut)
  await flush()
  const drawn = page.node('body').innerHTML
  assert.match(drawn, /<form id="sign-in-form"/)
  assert.match(drawn, /Vercel/)
})

test('local page, signed out: no website sign-in; it says to double-click Start Board, in plain words', async () => {
  const page = board(signedOut, { windowExtras: { __BOARD_LOCAL__: true } })
  await flush()
  const drawn = page.node('body').innerHTML + page.node('closed-note').textContent
  assert.doesNotMatch(drawn, /sign-in-form|sign-in-password|sign-in-user|spare-key|VIEW_KEY|Vercel|username|password/i)
  assert.match(drawn, /Double-click Start Board/)
  assert.match(drawn, /Open the board again/)
})

test('local page, Vercel redirect answer (not possible locally, but never the website words)', async () => {
  const page = board(redirected, { windowExtras: { __BOARD_LOCAL__: true } })
  await flush()
  const drawn = page.node('body').innerHTML + page.node('closed-note').textContent
  assert.doesNotMatch(drawn, /Vercel|sign-in-form/i)
  assert.match(drawn, /Double-click Start Board/)
})

test('website page, Vercel redirect answer: unchanged', async () => {
  const page = board(redirected)
  await flush()
  assert.match(page.node('reload-note').textContent, /Vercel/)
})

test('local page: the personalise panel never tells a student to create a Blob store in Vercel', () => {
  const source = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8')
  assert.match(source, /const LOCAL_BOARD = window\.__BOARD_LOCAL__ === true/)
  assert.match(source, /const SWITCH_ON = LOCAL_BOARD\s*\?/)
})

test('website mode: nothing sets the local flag, and the page file the website serves has no mention of the local script', () => {
  const index = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8')
  assert.ok(!index.includes('local-mode'))
  assert.ok(!readFileSync(join(ROOT, 'public', 'app.js'), 'utf8').includes('x-board-token'), 'the token header belongs to local-mode.js only')
  assert.ok(basePayload)
})
