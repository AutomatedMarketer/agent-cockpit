// GET /api/progress?order=<id> on the board on this computer (task T12): what the runner's progress file says about a
// run that is going, and nothing else. The file is the runner's (progress/<order id>.json in its state folder).

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROGRESS_PATH, SAY, progressHandler } from '../local/progress.mjs'
import { API_ROUTES } from '../local/routes.mjs'
import { existsSync, readFileSync } from 'node:fs'
import { startBoardServer } from '../local/server.mjs'
import { makeWorld, raw, withStartedBoard } from './helpers/local-runner-world.mjs'

const ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const OTHER = '0123456789abcdef0123456789abcdef'
const GOOD = { schema: 'agent-mailbox-progress/v1', id: ID, phase: 'working', startedAt: '2026-10-17T10:00:00Z', lastEventAt: '2026-10-17T10:01:30Z', steps: 7, calls: { Read: 5, Edit: 2 }, lastTool: 'Edit', final: false }

const temp = () => realpathSync(mkdtempSync(join(tmpdir(), 'prg-')))
const put = (state, id, value, text = null) => {
  mkdirSync(join(state, 'progress'), { recursive: true })
  writeFileSync(join(state, 'progress', `${id}.json`), text ?? `${JSON.stringify(value)}\n`)
}
const ask = async (state, query, method = 'GET') => {
  let sent = { status: 200 }
  const headers = {}
  const response = {
    setHeader(name, value) { headers[name.toLowerCase()] = value },
    status(code) { sent = { status: code }; return this },
    json(value) { sent = { ...sent, body: value }; return this }
  }
  await progressHandler({ stateDir: () => state })({ method, query }, response)
  return { ...sent, headers }
}

test('the answer is the allow-listed fields of the file, and nothing else', async () => {
  const state = temp()
  try {
    put(state, ID, { ...GOOD, secretField: 'sk-nope', path: 'C:/Users/x', outcome: 'ok', final: true })
    const got = await ask(state, { order: ID })
    assert.equal(got.status, 200)
    assert.deepEqual(got.body, { phase: 'working', steps: 7, lastTool: 'Edit', startedAt: GOOD.startedAt, lastEventAt: GOOD.lastEventAt, final: true, outcome: 'ok' })
    assert.equal(got.headers['cache-control'], 'private, no-store')
    assert.equal(JSON.stringify(got.body).includes('sk-nope'), false)
  } finally { rmSync(state, { recursive: true, force: true }) }
})

test('a running file has no outcome key; an unnamed last tool is null', async () => {
  const state = temp()
  try {
    put(state, ID, { ...GOOD, lastTool: null, steps: 0 })
    const got = await ask(state, { order: ID })
    assert.deepEqual(got.body, { phase: 'working', steps: 0, lastTool: null, startedAt: GOOD.startedAt, lastEventAt: GOOD.lastEventAt, final: false })
  } finally { rmSync(state, { recursive: true, force: true }) }
})

test('an order id that is not 32 lowercase hex is refused before any path is built', async () => {
  const state = temp()
  try {
    for (const bad of [undefined, '', 'abc', ID.toUpperCase(), `${ID}0`, '../../etc/passwd', `${ID}/../${ID}`, `..\\${ID}`, [ID, ID], { a: 1 }, 5]) {
      const got = await ask(state, { order: bad })
      assert.equal(got.status, 400, String(bad))
      assert.equal(got.body.error, SAY.badId)
    }
  } finally { rmSync(state, { recursive: true, force: true }) }
})

test('nothing there, an empty state folder, or no state folder: 404', async () => {
  const state = temp()
  try {
    assert.equal((await ask(state, { order: ID })).status, 404)
    assert.equal((await ask(join(state, 'missing'), { order: ID })).status, 404)
    assert.equal((await ask(null, { order: ID })).status, 404)
  } finally { rmSync(state, { recursive: true, force: true }) }
})

test('only GET is answered', async () => {
  const state = temp()
  try {
    put(state, ID, GOOD)
    const got = await ask(state, { order: ID }, 'POST')
    assert.equal(got.status, 405)
    assert.equal(got.headers.allow, 'GET')
  } finally { rmSync(state, { recursive: true, force: true }) }
})

test('a link or junction in place of the file or the folder is not followed', async () => {
  const state = temp()
  const elsewhere = temp()
  try {
    writeFileSync(join(elsewhere, 'real.json'), `${JSON.stringify(GOOD)}\n`)
    mkdirSync(join(state, 'progress'))
    let linked = true
    try { symlinkSync(join(elsewhere, 'real.json'), join(state, 'progress', `${ID}.json`), 'file') } catch { linked = false }
    if (linked) assert.equal((await ask(state, { order: ID })).status, 404, 'file link')
    rmSync(join(state, 'progress'), { recursive: true, force: true })
    mkdirSync(join(elsewhere, 'folder'))
    writeFileSync(join(elsewhere, 'folder', `${ID}.json`), `${JSON.stringify(GOOD)}\n`)
    let junction = true
    try { symlinkSync(join(elsewhere, 'folder'), join(state, 'progress'), 'junction') } catch { junction = false }
    if (junction) assert.equal((await ask(state, { order: ID })).status, 404, 'folder junction')
    assert.ok(junction, 'a junction could be made here, so the folder case was really tried')
  } finally {
    rmSync(state, { recursive: true, force: true })
    rmSync(elsewhere, { recursive: true, force: true })
  }
})

test('a folder where the file should be is not read', async () => {
  const state = temp()
  try {
    mkdirSync(join(state, 'progress', `${ID}.json`), { recursive: true })
    assert.equal((await ask(state, { order: ID })).status, 404)
  } finally { rmSync(state, { recursive: true, force: true }) }
})

test('a file over 4 KB is refused, however it is padded', async () => {
  const state = temp()
  try {
    put(state, ID, { ...GOOD, pad: 'x'.repeat(5000) })
    assert.equal((await ask(state, { order: ID })).status, 404)
    put(state, ID, GOOD, `${JSON.stringify(GOOD)}${' '.repeat(5000)}`)
    assert.equal((await ask(state, { order: ID })).status, 404)
  } finally { rmSync(state, { recursive: true, force: true }) }
})

test('a file that is not the runner\'s shape is 404: bad JSON, wrong schema, another order\'s id, odd values', async () => {
  const state = temp()
  try {
    const bads = [
      ['not json', null, '{nope'],
      ['an array', [GOOD], null],
      ['wrong schema', { ...GOOD, schema: 'other/v1' }, null],
      ['another order', { ...GOOD, id: OTHER }, null],
      ['bad phase', { ...GOOD, phase: 'exploding' }, null],
      ['steps negative', { ...GOOD, steps: -1 }, null],
      ['steps text', { ...GOOD, steps: '7' }, null],
      ['steps fraction', { ...GOOD, steps: 1.5 }, null],
      ['steps huge', { ...GOOD, steps: 100001 }, null],
      ['tool with a path', { ...GOOD, lastTool: 'C:/secret.txt' }, null],
      ['tool with markup', { ...GOOD, lastTool: '<img src=x>' }, null],
      ['tool too long', { ...GOOD, lastTool: 'a'.repeat(65) }, null],
      ['start not a time', { ...GOOD, startedAt: 'yesterday' }, null],
      ['event time an object', { ...GOOD, lastEventAt: {} }, null],
      ['final not boolean', { ...GOOD, final: 'yes' }, null],
      ['outcome unknown word', { ...GOOD, final: true, outcome: 'great' }, null]
    ]
    for (const [name, value, text] of bads) {
      put(state, ID, value, text)
      assert.equal((await ask(state, { order: ID })).status, 404, name)
    }
  } finally { rmSync(state, { recursive: true, force: true }) }
})

test('the route is local-only: not one of the files in api/ that the website also serves', () => {
  assert.equal(API_ROUTES.includes('progress'), false)
  assert.equal(PROGRESS_PATH, '/api/progress')
})

test('the website: no api/progress.js to serve, no rewrite to it, and a server without the local routes answers 404 as for any unknown address', async () => {
  assert.equal(existsSync(new URL('../api/progress.js', import.meta.url)), false)
  assert.equal(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8').includes('progress'), false)
  assert.equal(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').includes("PROGRESS_PATH"), false)
  const board = await startBoardServer({ port: 0, loadHandler: async () => { throw new Error('no handler may be loaded for it') } })
  try {
    const answer = await raw(board.port, `/api/progress?order=${ID}`)
    const unknown = await raw(board.port, '/api/no-such-thing')
    assert.equal(answer.status, 404)
    assert.equal(answer.text, unknown.text)
  } finally {
    await new Promise((done) => { board.server.close(done); board.server.closeAllConnections() })
  }
})

// ---- through a started board ---------------------------------------------------------------------------------

test('through the board: refused without its key, answers with it, and only with a good order id', { timeout: 60_000 }, async () => {
  const world = makeWorld()
  try {
    mkdirSync(join(world.runnerState, 'progress'), { recursive: true })
    writeFileSync(join(world.runnerState, 'progress', `${ID}.json`), `${JSON.stringify({ ...GOOD, lastTool: 'Read' })}\n`)
    await withStartedBoard(world, false, false, async ({ started, api }) => {
      const port = started.port
      const noKey = await raw(port, `${PROGRESS_PATH}?order=${ID}`, 'GET', { Origin: `http://127.0.0.1:${port}` })
      assert.equal(noKey.status, 401)
      assert.equal(noKey.text.includes('Read'), false)
      const good = await api(`${PROGRESS_PATH}?order=${ID}`)
      assert.equal(good.status, 200, good.text)
      assert.equal(JSON.parse(good.text).lastTool, 'Read')
      assert.match(String(good.headers['cache-control']), /private, no-store/)
      assert.equal((await api(`${PROGRESS_PATH}?order=${OTHER}`)).status, 404)
      assert.equal((await api(`${PROGRESS_PATH}?order=..%2F..%2Fsettings`)).status, 400)
      assert.equal((await api(PROGRESS_PATH)).status, 400)
    })
  } finally { world.done() }
})
