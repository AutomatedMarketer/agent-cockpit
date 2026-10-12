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
    expose: ['postFire', 'fireWorkflow', 'macSentWords'],
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

test('fire is sent as JSON from the board, with no view key: the signed-in cookie goes by itself', async () => {
  const { page, fires } = firePage({ answers: [json(200, { ok: true })] })
  await flush()
  await page.exposed.postFire({ workflow: 'monday-brief' })
  assert.equal(fires[0].method, 'POST')
  assert.equal(fires[0].headers['Content-Type'], 'application/json')
  assert.equal(fires[0].headers['x-view-key'], undefined)
  assert.deepEqual(JSON.parse(fires[0].body), { workflow: 'monday-brief' })
})

test('an order sent by a spoken yes never asks for the fire key: with ask off, a 401 for it is the answer', async () => {
  const { page, asked, fires } = firePage({ answers: [json(401, { needs: 'fire-key', error: 'Missing or wrong fire key.' })] })
  await flush()
  const result = await page.exposed.postFire({ action: 'task', title: 'Draft it' }, { ask: false })
  assert.equal(result.status, 401)
  assert.deepEqual(asked, [], 'a spoken yes was met with a key prompt')
  assert.equal(fires.length, 1)
})

test('a Run that started shows a "watch it run" link to its claude.ai session - and nothing for any other address', async () => {
  const run = async (sessionUrl) => {
    const { page } = firePage({ answers: [json(200, { ok: true, workflow: 'monday-brief', action: 'run', ...(sessionUrl ? { sessionUrl } : {}) })] })
    await flush()
    const row = page.node('run-row')
    const button = { dataset: { fire: 'monday-brief', action: 'run' }, parentElement: row, innerHTML: 'Run', disabled: false }
    await page.exposed.fireWorkflow(button)
    return row.children.at(-1)
  }
  const live = await run('https://claude.ai/code/session_01Live')
  assert.match(live.innerHTML, /<a href="https:\/\/claude\.ai\/code\/session_01Live" rel="noreferrer noopener">watch it run<\/a>/)
  for (const odd of ['https://evil.example/session_01X', 'javascript:alert(1)', 'https://claude.ai/code/task_01X']) {
    const note = await run(odd)
    assert.equal(note.innerHTML, '', `${odd} was put on the page as a link`)
    assert.equal(note.textContent, 'Job sent.')
  }
})

/* ---------- an order the board queued for the owner's Mac (Mac mailbox, plan 2026-10-12, C7) ----------
   On a mailbox board fire answers { via: 'mac', orderId, expiresAt, pollSeconds }. The button's note
   says it went to the Mac and when to expect it - never "started" or a session link - and the device
   remembers the order, so Today can follow it through the Mac's status file on each load. */

const MAC_ID = '0f1e2d3c4b5a69788796a5b4c3d2e1f0'
const MAC_STORE = 'agent-cockpit-mac-orders'
const macPayload = (extra = {}) => ({ ok: true, accepted: true, via: 'mac', orderId: MAC_ID, expiresAt: new Date(Date.now() + 17 * 60_000).toISOString(), pollSeconds: 300, ...extra })

test('Run on a mailbox board says it went to your Mac and when it should start, and remembers the order', async () => {
  const junk = { via: 'mac', id: 'not-an-id', kind: 'run', label: 'Old', sentAt: new Date().toISOString(), expiresAt: new Date().toISOString(), pollSeconds: 300 }
  const { page } = firePage({ answers: [json(200, macPayload({ workflow: 'monday-brief', action: 'run' }))], storage: { [MAC_STORE]: JSON.stringify([junk]) } })
  await flush()
  const row = page.node('run-row')
  const button = { dataset: { fire: 'monday-brief', action: 'run' }, parentElement: row, innerHTML: 'Run', disabled: false }
  await page.exposed.fireWorkflow(button)
  const note = row.children.at(-1)
  assert.equal(note.textContent, 'Sent to your Mac. It should start within about 5 minutes.')
  assert.equal(note.innerHTML, '', 'a link or markup was put in the note')
  const kept = JSON.parse(page.storage.getItem(MAC_STORE))
  assert.equal(kept.length, 1, 'an entry not in the shape the board writes was kept')
  assert.deepEqual(Object.keys(kept[0]).sort(), ['expiresAt', 'id', 'kind', 'label', 'pollSeconds', 'sentAt', 'via'])
  assert.equal(kept[0].id, MAC_ID)
  assert.equal(kept[0].kind, 'run')
  assert.equal(kept[0].label, 'Run monday-brief')
  // Pause says what it does there, and is remembered too.
  const pause = firePage({ answers: [json(200, macPayload({ workflow: 'monday-brief', action: 'pause' }))] })
  await flush()
  const pauseRow = pause.page.node('pause-row')
  await pause.page.exposed.fireWorkflow({ dataset: { fire: 'monday-brief', action: 'pause' }, parentElement: pauseRow, innerHTML: 'Pause', disabled: false })
  assert.equal(pauseRow.children.at(-1).textContent, 'Sent to your Mac. It switches the schedule off in the workflow file within about 5 minutes.')
})

test('the Mac\'s words for each button: a card, a move, an approval, and the ones it files a card for you to finish', async () => {
  const { page } = firePage({ answers: [] , storage: {} })
  await flush()
  const said = (kind, extra) => page.exposed.macSentWords(kind, macPayload(extra))
  assert.equal(said('task'), 'Sent to your Mac. It checks every 5 minutes, so the card should be on the board in about 6 minutes.')
  assert.equal(said('move'), 'Sent to your Mac. It lands in about 6 minutes.')
  assert.equal(said('approve'), 'Sent to your Mac. Nothing has been switched on.')
  for (const kind of ['arm', 'skill', 'agent']) {
    assert.equal(said(kind), 'Sent to your Mac. It will file a card for you to finish in a Claude session.', kind)
  }
  // Not the board's own shape: not a Mac answer at all, so the button says what it always did.
  assert.equal(page.exposed.macSentWords('task', macPayload({ orderId: 'Chase the invoice' })), null)
  assert.equal(page.exposed.macSentWords('task', { ok: true, accepted: true }), null)
}, )

test('Today follows each remembered Mac order through the Mac\'s status file, in the board\'s own words', async () => {
  const sentAt = new Date(Date.now() - 2 * 60_000).toISOString()
  const remembered = [{ via: 'mac', id: MAC_ID, kind: 'run', label: 'Run monday-brief', sentAt, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), pollSeconds: 300 }]
  const startedAt = new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, 'Z')
  const payload = {
    ...basePayload(),
    mailbox: { status: 'ok', computers: [{ computer: 'Mac Mini', runner: 'mac-mini', takenAt: startedAt, allows: { actions: ['run'], jobs: ['monday-brief'] }, orders: [{ id: MAC_ID, action: 'run', state: 'running', at: startedAt, startedAt, finishedAt: null, commit: null, why: null, landed: null }], hidden: 0 }] }
  }
  const page = loadPage({ payload, storage: { [MAC_STORE]: JSON.stringify(remembered) } })
  await flush()
  const today = page.node('today').innerHTML
  assert.match(today, /Your Mac/)
  assert.match(today, /Run monday-brief/)
  assert.match(today, /Your Mac picked it up at .* and is running it\./)
  // Nothing remembered: no Mac panel at all.
  const none = loadPage({ payload })
  await flush()
  assert.doesNotMatch(none.node('today').innerHTML, /Your Mac picked it up/)
  // A remembered entry that is not the board's own shape is not shown, and its words never reach the page.
  const odd = loadPage({ payload, storage: { [MAC_STORE]: JSON.stringify([{ ...remembered[0], id: '<img src=x onerror=alert(1)>' }]) } })
  await flush()
  assert.doesNotMatch(odd.node('today').innerHTML, /onerror|Run monday-brief/)
})

test('the voice\'s own order log keeps an order\'s Mac id, expiry and pace only in the board\'s own shape', async () => {
  const sentAt = new Date().toISOString()
  const good = { kind: 'task', title: 'Draft it', sentAt, via: 'mac', id: MAC_ID, expiresAt: new Date(Date.now() + 60_000).toISOString(), pollSeconds: 300 }
  const odd = { kind: 'task', title: 'Draft it too', sentAt, via: 'mac', id: 'not-an-id', expiresAt: 'soon', pollSeconds: 5 }
  const cloud = { kind: 'run', slug: 'monday-brief', name: 'Monday brief', sentAt }
  const page = loadPage({ payload: basePayload(), expose: ['voiceOrdersLog'], storage: { 'agent-cockpit-voice-orders': JSON.stringify([good, odd, cloud]) } })
  await flush()
  assert.deepEqual(page.exposed.voiceOrdersLog(), [good, { kind: 'task', title: 'Draft it too', sentAt }, cloud])
})
