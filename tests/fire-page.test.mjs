// The page's side of fire: what a Run, Pause or Add task button sends, and when it asks for the
// fire key. Fire checks the viewer first now (audit finding #1, 2026-10-10), so a 401 can mean two
// different things - "who are you?" and "this board also wants its fire key" - and only the second
// is a reason to ask for a key. Prompting on the first asked a signed-out person for the wrong key.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadPage, flush } from './helpers/page-harness.mjs'
import { basePayload } from './helpers/page-payload.mjs'

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body })

function firePage({ answers, prompt = () => 'fk_typed', storage = {} }) {
  const asked = []
  const fires = []
  const page = loadPage({
    expose: ['postFire'],
    storage,
    prompt: (text) => { asked.push(text); return prompt(text) },
    fetch: async (url, init = {}) => {
      if (url === '/api/fire') {
        fires.push(init)
        return answers.shift() ?? json(500, {})
      }
      return json(200, url.startsWith('/api/state') ? basePayload() : {})
    }
  })
  return { page, asked, fires }
}

test('fire asks for the fire key only when the answer says that is what is missing', async () => {
  const { page, asked, fires } = firePage({ answers: [json(401, { needs: 'fire-key', error: 'Missing or wrong fire key.' }), json(200, { ok: true })] })
  await flush()
  const result = await page.exposed.postFire({ workflow: 'monday-brief' })
  assert.equal(result.ok, true)
  assert.equal(asked.length, 1)
  assert.equal(fires.length, 2)
  assert.equal(fires[1].headers['x-fire-key'], 'fk_typed')
})

test('a 401 that is about the viewer never asks for the fire key, and is not sent again', async () => {
  const { page, asked, fires } = firePage({ answers: [json(401, { error: 'Signed out.' })] })
  await flush()
  const result = await page.exposed.postFire({ workflow: 'monday-brief' })
  assert.equal(result.status, 401)
  assert.equal(asked.length, 0, 'a signed-out person was asked for the fire key')
  assert.equal(fires.length, 1)
})

test('fire is sent as JSON from the board, carrying the view key like every other request', async () => {
  const { page, fires } = firePage({ answers: [json(200, { ok: true })], storage: { 'agent-cockpit-view-key': 'vk_on_this_device' } })
  await flush()
  await page.exposed.postFire({ workflow: 'monday-brief' })
  assert.equal(fires[0].method, 'POST')
  assert.equal(fires[0].headers['Content-Type'], 'application/json')
  assert.equal(fires[0].headers['x-view-key'], 'vk_on_this_device')
  assert.deepEqual(JSON.parse(fires[0].body), { workflow: 'monday-brief' })
})
