// The Settings box of the local board (task T10): a student pastes an OpenAI key; it is kept in the
// locked state folder, put in the handlers' environment, and never shown, logged or sent back.

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { request as httpRequest } from 'node:http'
import { createSettings, SETTINGS_PATH, SAY, SLOTS } from '../local/settings.mjs'
import { startLocalBoard, createBoardServer } from '../local/server.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const KEY = 'sk-proj-' + 'A1b2C3d4'.repeat(6)
const FISH = 'f1sh' + 'abcd0123'.repeat(4)
const ROUTER = 'sk-or-v1-' + 'a1b2c3d4'.repeat(4)
const ENV_KEYS = ['VIEW_KEY', 'PUBLIC_FIRE', 'PUBLIC_DASHBOARD', 'EDIT_KEY', 'BOARD_PASSWORD', 'BOARD_USERNAME', 'OPENAI_API_KEY', 'FISH_API_KEY', 'OPENROUTER_API_KEY']

function folder() {
  const dir = mkdtempSync(join(tmpdir(), 'board-settings-'))
  return { dir, file: join(dir, 'settings.json'), done: () => rmSync(dir, { recursive: true, force: true }) }
}

// Everything printed while `run` goes: a key must never be among it.
async function watchingConsole(run) {
  const noisy = { log: console.log, error: console.error, warn: console.warn }
  const lines = []
  for (const name of ['log', 'error', 'warn']) console[name] = (...parts) => lines.push(parts.map(String).join(' '))
  try {
    await run()
  } finally {
    Object.assign(console, noisy)
  }
  return lines
}

const call = async (settings, body, method = 'POST') => {
  let sent
  const response = {
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value },
    status(code) { sent = { status: code }; return this },
    json(value) { sent = { ...sent, body: value }; return this }
  }
  await settings.handler({ method, body }, response)
  return { ...sent, headers: response.headers }
}

// ---- what a key may look like ------------------------------------------------------------------------------

test('shapes: a real-looking key is accepted for its slot; anything else is refused with a plain sentence that does not repeat it', async () => {
  const { file, done } = folder()
  try {
    const env = {}
    const settings = createSettings({ file, env })
    const good = [['OPENAI_API_KEY', KEY], ['OPENAI_API_KEY', 'sk-' + 'x'.repeat(48)], ['FISH_API_KEY', FISH], ['OPENROUTER_API_KEY', ROUTER]]
    for (const [slot, value] of good) assert.equal((await call(settings, { action: 'save', slot, value })).status, 200, `${slot} ${value}`)
    const bad = [
      ['OPENAI_API_KEY', ''], ['OPENAI_API_KEY', 'sk-'], ['OPENAI_API_KEY', 'sk-short'], ['OPENAI_API_KEY', 'pk-' + 'x'.repeat(40)], ['OPENAI_API_KEY', 'x'.repeat(60)],
      ['OPENAI_API_KEY', 'sk-' + 'x'.repeat(300)], ['OPENAI_API_KEY', 'sk-' + 'x'.repeat(20) + '!'], ['OPENAI_API_KEY', 'sk-' + 'é'.repeat(30)],
      ['OPENAI_API_KEY', ` ${KEY}`], ['OPENAI_API_KEY', `${KEY} `], ['OPENAI_API_KEY', `${KEY}\n`], ['OPENAI_API_KEY', `${KEY}\r\n`], ['OPENAI_API_KEY', `${KEY}\t`],
      ['OPENAI_API_KEY', `sk-${'x'.repeat(10)} ${'x'.repeat(20)}`], ['OPENAI_API_KEY', `${KEY}\u0000`], ['OPENAI_API_KEY', `${KEY} `], ['OPENAI_API_KEY', `${KEY} `], ['OPENAI_API_KEY', `${KEY}​`],
      ['OPENAI_API_KEY', `${KEY}\n${KEY}`], ['OPENAI_API_KEY', `"${KEY}"`], ['OPENAI_API_KEY', `OPENAI_API_KEY=${KEY}`],
      ['OPENAI_API_KEY', 12345], ['OPENAI_API_KEY', null], ['OPENAI_API_KEY', undefined], ['OPENAI_API_KEY', [KEY]], ['OPENAI_API_KEY', { toString: () => KEY }], ['OPENAI_API_KEY', true],
      ['OPENROUTER_API_KEY', 'sk-' + 'x'.repeat(40)], ['OPENROUTER_API_KEY', KEY], ['FISH_API_KEY', 'short'], ['FISH_API_KEY', FISH + ' '], ['FISH_API_KEY', 'a b c d e f g h i j k l m n o p']
    ]
    for (const [slot, value] of bad) {
      const answer = await call(settings, { action: 'save', slot, value })
      assert.equal(answer.status, 400, `${slot} ${JSON.stringify(value)} was accepted`)
      assert.ok(typeof answer.body.error === 'string' && answer.body.error.length > 10)
      assert.ok(!JSON.stringify(answer.body).includes(typeof value === 'string' && value.length > 6 ? value.trim() : '\u0001none'), 'the refusal repeated what was pasted')
    }
  } finally {
    done()
  }
})

test('slots: only the three known names; names like __proto__ or constructor and other settings are refused', async () => {
  const { file, done } = folder()
  try {
    const env = {}
    const settings = createSettings({ file, env })
    for (const slot of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'PATH', 'VIEW_KEY', 'GITHUB_TOKEN', 'REPO_FOLDER', 'openai_api_key', '', null, 5, ['OPENAI_API_KEY'], undefined]) {
      for (const action of ['save', 'remove', 'test']) {
        const answer = await call(settings, { action, slot, value: KEY })
        assert.equal(answer.status, 400, `${action} ${String(slot)}`)
      }
    }
    assert.deepEqual(env, {})
    assert.equal(({}).polluted, undefined)
    assert.deepEqual(Object.keys(SLOTS).sort(), ['FISH_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'])
  } finally {
    done()
  }
})

// ---- saving, keeping, removing ---------------------------------------------------------------------------

test('save: the key goes to the private file and into the handlers\' environment at once; the answer holds only "saved" and the last four', async () => {
  const { file, done } = folder()
  try {
    const env = {}
    const settings = createSettings({ file, env })
    const answer = await call(settings, { action: 'save', slot: 'OPENAI_API_KEY', value: KEY })
    assert.equal(answer.status, 200)
    assert.equal(env.OPENAI_API_KEY, KEY)
    assert.deepEqual(answer.body.keys.OPENAI_API_KEY, { label: SLOTS.OPENAI_API_KEY.label, saved: true, last4: KEY.slice(-4) })
    assert.equal(answer.headers['cache-control'], 'no-store')
    assert.ok(!JSON.stringify(answer).includes(KEY), 'the key came back')
    assert.ok(JSON.parse(readFileSync(file, 'utf8')).keys.OPENAI_API_KEY === KEY)
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o077, 0, 'the settings file is readable by other users')
    assert.deepEqual(readdirSync(join(file, '..')), ['settings.json'], 'a temporary file was left behind')
    const again = await call(settings, { action: 'status' })
    assert.ok(!JSON.stringify(again).includes(KEY))
    assert.equal(again.body.keys.OPENAI_API_KEY.last4, KEY.slice(-4))
    assert.equal(Object.keys(again.body.keys.OPENAI_API_KEY).sort().join(), 'label,last4,saved')
  } finally {
    done()
  }
})

test('restart: a saved key is put in the environment again, and wins over one the computer already had', async () => {
  const { file, done } = folder()
  try {
    createSettings({ file, env: {} })
    await call(createSettings({ file, env: {} }), { action: 'save', slot: 'OPENAI_API_KEY', value: KEY })
    const env = { OPENAI_API_KEY: 'sk-an-old-key-from-the-system-0123456789', FISH_API_KEY: 'kept-because-nothing-saved' }
    createSettings({ file, env })
    assert.equal(env.OPENAI_API_KEY, KEY)
    assert.equal(env.FISH_API_KEY, 'kept-because-nothing-saved')
  } finally {
    done()
  }
})

test('restart: a damaged or hand-edited settings file is ignored, not trusted', async () => {
  const { file, done } = folder()
  try {
    for (const text of ['', '{', 'null', '[]', JSON.stringify({ keys: { OPENAI_API_KEY: 'not a key' } }), JSON.stringify({ keys: { OPENAI_API_KEY: `${KEY}\n` } }), JSON.stringify({ keys: { PATH: '/evil', OPENAI_API_KEY: 5 } }), JSON.stringify({ keys: { __proto__: { polluted: 1 } } })]) {
      writeFileSync(file, text)
      const env = {}
      createSettings({ file, env })
      assert.deepEqual(env, {}, text)
    }
    assert.equal(({}).polluted, undefined)
  } finally {
    done()
  }
})

test('remove: the key leaves the file and the environment, and the page is told it is gone', async () => {
  const { file, done } = folder()
  try {
    const env = {}
    const settings = createSettings({ file, env })
    await call(settings, { action: 'save', slot: 'OPENAI_API_KEY', value: KEY })
    await call(settings, { action: 'save', slot: 'FISH_API_KEY', value: FISH })
    const removed = await call(settings, { action: 'remove', slot: 'OPENAI_API_KEY' })
    assert.equal(removed.status, 200)
    assert.equal(removed.body.keys.OPENAI_API_KEY.saved, false)
    assert.equal(env.OPENAI_API_KEY, undefined)
    assert.equal(env.FISH_API_KEY, FISH)
    assert.ok(!readFileSync(file, 'utf8').includes(KEY))
    assert.equal((await call(settings, { action: 'remove', slot: 'OPENAI_API_KEY' })).status, 200, 'removing what is not there is fine')
  } finally {
    done()
  }
})

test('save failure: one plain sentence; nothing of the error, the path or the key; nothing logged', async () => {
  const { dir, done } = folder()
  try {
    writeFileSync(join(dir, 'blocker'), 'a file where a folder should be')
    const env = {}
    const settings = createSettings({ file: join(dir, 'blocker', 'settings.json'), env })
    let answer
    const lines = await watchingConsole(async () => { answer = await call(settings, { action: 'save', slot: 'OPENAI_API_KEY', value: KEY }) })
    assert.equal(answer.status, 500)
    assert.equal(answer.body.error, SAY.cannotSave)
    assert.ok(!JSON.stringify(answer).includes(KEY) && !JSON.stringify(answer).includes(dir))
    assert.equal(env.OPENAI_API_KEY, undefined, 'a key that could not be kept must not be used either')
    assert.ok(lines.every((line) => !line.includes(KEY)))
  } finally {
    done()
  }
})

// ---- the key test ----------------------------------------------------------------------------------------

function fakeService(answers) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    const next = typeof answers === 'function' ? answers(calls.length) : answers
    if (next instanceof Error) throw next
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status })
  }
  return { fetchImpl, calls }
}

test('test: one call to the models address with the key; "works", "refused" and "no credit" in plain words', async () => {
  const cases = [
    [{ status: 200, body: { data: [] } }, 'works', SAY.works],
    [{ status: 401, body: { error: { message: 'Incorrect API key provided: sk-proj-secret' } } }, 'refused', SAY.refused],
    [{ status: 403 }, 'refused', SAY.refused],
    [{ status: 429, body: { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } } }, 'no credit', SAY.noCredit],
    [{ status: 402 }, 'no credit', SAY.noCredit],
    [{ status: 429, body: { error: { code: 'rate_limit_exceeded' } } }, 'unreachable', SAY.unreachable],
    [{ status: 500 }, 'unreachable', SAY.unreachable],
    [new Error(`socket hang up with ${KEY} in it`), 'unreachable', SAY.unreachable]
  ]
  for (const [service, result, say] of cases) {
    const { file, done } = folder()
    try {
      const fake = fakeService(service)
      const settings = createSettings({ file, env: {}, fetchImpl: fake.fetchImpl, openaiBase: 'http://stub.invalid' })
      await call(settings, { action: 'save', slot: 'OPENAI_API_KEY', value: KEY })
      let answer
      const lines = await watchingConsole(async () => { answer = await call(settings, { action: 'test', slot: 'OPENAI_API_KEY' }) })
      assert.equal(answer.status, 200)
      assert.equal(answer.body.result, result)
      assert.equal(answer.body.say, say)
      assert.ok(!JSON.stringify(answer).includes(KEY) && !JSON.stringify(answer).includes('secret'), 'the service\'s own words or the key came back')
      assert.ok(lines.every((line) => !line.includes(KEY)))
      assert.equal(fake.calls.length, 1, 'more than one call')
      assert.equal(fake.calls[0].url, 'http://stub.invalid/v1/models')
      assert.equal(fake.calls[0].init.method, 'GET')
      assert.equal(fake.calls[0].init.headers.Authorization, `Bearer ${KEY}`)
      assert.equal(fake.calls[0].init.redirect, 'error', 'a redirect would carry the key somewhere else')
      assert.ok(fake.calls[0].init.signal, 'the check needs a time limit')
    } finally {
      done()
    }
  }
})

test('test: with no key saved there is no call at all; Fish keys are not tested; OpenRouter uses its own address', async () => {
  const { file, done } = folder()
  try {
    const fake = fakeService({ status: 200 })
    const settings = createSettings({ file, env: {}, fetchImpl: fake.fetchImpl, openaiBase: 'http://o.invalid', openrouterBase: 'http://r.invalid' })
    assert.equal((await call(settings, { action: 'test', slot: 'OPENAI_API_KEY' })).body.error, SAY.nothingSaved)
    await call(settings, { action: 'save', slot: 'FISH_API_KEY', value: FISH })
    assert.equal((await call(settings, { action: 'test', slot: 'FISH_API_KEY' })).body.result, 'untestable')
    await call(settings, { action: 'save', slot: 'OPENROUTER_API_KEY', value: ROUTER })
    assert.equal((await call(settings, { action: 'test', slot: 'OPENROUTER_API_KEY' })).body.result, 'works')
    assert.deepEqual(fake.calls.map((one) => one.url), ['http://r.invalid/api/v1/auth/key'])
  } finally {
    done()
  }
})

test('test: only one check at a time', async () => {
  const { file, done } = folder()
  try {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const settings = createSettings({ file, env: {}, fetchImpl: async () => { await gate; return new Response('{}', { status: 200 }) } })
    await call(settings, { action: 'save', slot: 'OPENAI_API_KEY', value: KEY })
    const first = call(settings, { action: 'test', slot: 'OPENAI_API_KEY' })
    const second = await call(settings, { action: 'test', slot: 'OPENAI_API_KEY' })
    assert.equal(second.status, 429)
    release()
    assert.equal((await first).body.result, 'works')
  } finally {
    done()
  }
})

// ---- the endpoint: POST only, small, JSON ---------------------------------------------------------------

test('endpoint: POST only, and a body that is not a small JSON object is refused', async () => {
  const { file, done } = folder()
  try {
    const settings = createSettings({ file, env: {} })
    for (const method of ['GET', 'PUT', 'DELETE', 'HEAD', 'PATCH']) {
      const answer = await call(settings, { action: 'status' }, method)
      assert.equal(answer.status, 405, method)
      assert.equal(answer.headers.allow, 'POST')
    }
    for (const body of [undefined, null, 'text', 5, [], [{ action: 'status' }], {}, { action: 'nope' }, { action: ['status'] }, { action: 'save', slot: 'OPENAI_API_KEY', value: 'x'.repeat(5000) }]) {
      const answer = await call(settings, body)
      assert.ok([400].includes(answer.status), JSON.stringify(body)?.slice(0, 60))
    }
  } finally {
    done()
  }
})

// ---- through the real local server ------------------------------------------------------------------------

const ENV_SAVED = () => Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
const ENV_PUT_BACK = (saved) => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }

function raw(port, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: response.headers }))
    })
    request.on('error', reject)
    request.end(body)
  })
}

async function withLocalBoard(run, { handlers = {} } = {}) {
  const saved = ENV_SAVED()
  const { dir, file, done } = folder()
  const stateStub = (request, response) => response.status(200).json({ ok: true, seen: 'state' })
  const board = await startLocalBoard({ port: 0, settingsFile: file, loadHandler: async (name) => handlers[name] ?? stateStub })
  const open = async () => {
    const link = new URL(board.openLink())
    const answer = await raw(board.port, link.pathname + link.search, 'GET', { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' })
    return { cookie: String(answer.headers['set-cookie']).split(';')[0], token: /name="board-token" content="([\w-]+)"/.exec(answer.text)[1] }
  }
  try {
    await run({ board, file, dir, open, post: (auth, body, extra = {}) => raw(board.port, SETTINGS_PATH, 'POST', { 'Content-Type': 'application/json', Cookie: auth.cookie, 'x-board-token': auth.token, Origin: `http://127.0.0.1:${board.port}`, ...extra }, JSON.stringify(body)) })
  } finally {
    await new Promise((resolve) => { board.server.close(resolve); board.server.closeAllConnections() })
    ENV_PUT_BACK(saved)
    done()
  }
}

test('through the local board: signed in and from its own page, a key can be saved; it never comes back in /api/state or anywhere', async () => {
  await withLocalBoard(async ({ board, file, open, post }) => {
    const auth = await open()
    const everything = []
    let answer
    const lines = await watchingConsole(async () => {
      answer = await post(auth, { action: 'save', slot: 'OPENAI_API_KEY', value: KEY })
      everything.push(answer.text, JSON.stringify(answer.headers))
      const status = await post(auth, { action: 'status' })
      everything.push(status.text)
      const state = await raw(board.port, '/api/state', 'GET', { Cookie: auth.cookie, 'x-board-token': auth.token })
      everything.push(state.text, JSON.stringify(state.headers))
      const page = await raw(board.port, '/', 'GET', { Cookie: auth.cookie })
      everything.push(page.text)
      for (const path of ['/local-settings.js', '/local-mode.js', '/app.js']) everything.push((await raw(board.port, path, 'GET', { Cookie: auth.cookie })).text)
    })
    assert.equal(answer.status, 200)
    assert.equal(process.env.OPENAI_API_KEY, KEY, 'the handlers do not see the key')
    for (const text of everything) assert.ok(!text.includes(KEY), 'the key came back to the page')
    assert.ok(lines.every((line) => !line.includes(KEY)), 'the key reached a log line')
    assert.ok(readFileSync(file, 'utf8').includes(KEY))
  })
})

test('through the local board: the handlers see the saved key (a real handler reads process.env at request time)', async () => {
  let seenByHandler
  await withLocalBoard(async ({ open, post, board }) => {
    const auth = await open()
    await post(auth, { action: 'save', slot: 'OPENAI_API_KEY', value: KEY })
    await raw(board.port, '/api/brand', 'GET', { Cookie: auth.cookie, 'x-board-token': auth.token })
    assert.equal(seenByHandler, KEY)
  }, { handlers: { brand: (request, response) => { seenByHandler = process.env.OPENAI_API_KEY; response.status(200).json({}) } } })
})

test('through the local board: cookie + key + the board\'s own Origin are all needed; GET is refused; a cross-site call is refused', async () => {
  await withLocalBoard(async ({ board, open, post }) => {
    const auth = await open()
    const body = { action: 'save', slot: 'OPENAI_API_KEY', value: KEY }
    const refused = [
      await post({ ...auth, token: 'wrong' }, body),
      await post({ ...auth, cookie: 'board_local_1=nope' }, body),
      await post(auth, body, { Origin: 'https://evil.example' }),
      await post(auth, body, { Origin: `http://localhost:${board.port + 1}` }),
      await post(auth, body, { 'Sec-Fetch-Site': 'cross-site' }),
      await post(auth, body, { 'Sec-Fetch-Site': 'same-site' }),
      await raw(board.port, SETTINGS_PATH, 'POST', { 'Content-Type': 'application/json', Cookie: auth.cookie, 'x-board-token': auth.token }, JSON.stringify(body)),
      await raw(board.port, SETTINGS_PATH, 'GET', { Cookie: auth.cookie, 'x-board-token': auth.token }),
      await raw(board.port, SETTINGS_PATH, 'PUT', { 'Content-Type': 'application/json', Cookie: auth.cookie, 'x-board-token': auth.token, Origin: `http://127.0.0.1:${board.port}` }, JSON.stringify(body))
    ]
    for (const answer of refused) {
      assert.ok([401, 403, 405].includes(answer.status), `answered ${answer.status}`)
      assert.ok(!answer.text.includes(KEY))
    }
    assert.equal(process.env.OPENAI_API_KEY === KEY, false, 'a refused request saved the key')
    const text = await post(auth, body, { 'Content-Type': 'text/plain' })
    assert.equal(text.status, 400, 'a plain-text form post must not work')
    assert.equal(process.env.OPENAI_API_KEY === KEY, false)
  })
})

test('through the local board: a key too big is refused before it is read', async () => {
  await withLocalBoard(async ({ open, post }) => {
    const auth = await open()
    const answer = await post(auth, { action: 'save', slot: 'OPENAI_API_KEY', value: 'sk-' + 'x'.repeat(9000) })
    assert.equal(answer.status, 400)
  })
})

test('through the local board: a restart brings the saved key back', async () => {
  const { file, done } = folder()
  const saved = ENV_SAVED()
  try {
    createSettings({ file, env: process.env })
    await call(createSettings({ file, env: {} }), { action: 'save', slot: 'OPENAI_API_KEY', value: KEY })
    delete process.env.OPENAI_API_KEY
    const board = await startLocalBoard({ port: 0, settingsFile: file })
    try {
      assert.equal(process.env.OPENAI_API_KEY, KEY)
    } finally {
      await new Promise((resolve) => { board.server.close(resolve); board.server.closeAllConnections() })
    }
  } finally {
    ENV_PUT_BACK(saved)
    done()
  }
})

// ---- the website is untouched -----------------------------------------------------------------------------

test('website mode: no settings address, no settings script, no box - the page files are byte for byte what they were', async () => {
  const server = createBoardServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const answer = await raw(port, SETTINGS_PATH, 'POST', { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' }, '{"action":"status"}')
    assert.equal(answer.status, 404)
    const page = await raw(port, '/', 'GET', { Host: `127.0.0.1:${port}` })
    assert.equal(page.text, readFileSync(join(ROOT, 'public', 'index.html'), 'utf8'))
  } finally {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections() })
  }
  for (const name of ['index.html', 'app.js']) {
    const text = readFileSync(join(ROOT, 'public', name), 'utf8')
    assert.ok(!/local-settings|board-settings|api\/local-settings/.test(text), `${name} knows about the Settings box`)
  }
  assert.ok(!existsSync(join(ROOT, 'public', 'settings-ui.js')))
  assert.ok(!readFileSync(join(ROOT, 'api', 'state.js'), 'utf8').includes('local-settings'))
})

test('the settings box page script builds with textContent only, holds no key, and never reads the key back', () => {
  const source = readFileSync(join(ROOT, 'local', 'page', 'settings-ui.js'), 'utf8')
  const code = source.split(String.fromCharCode(10)).filter((line) => !line.trim().startsWith('//')).join(' ')
  assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/)
  assert.doesNotMatch(code, /localStorage|sessionStorage|document\.cookie|console\./)
  assert.match(code, /input\.value = ''/, 'the typed key must be cleared the moment it is sent')
  assert.match(source, /type: 'password'/)
})

test('endpoint: a request with a large body (extra fields) is refused before it is looked at', async () => {
  const { file, done } = folder()
  try {
    const settings = createSettings({ file, env: {} })
    const answer = await call(settings, { action: 'status', padding: 'x'.repeat(3000) })
    assert.equal(answer.status, 400)
    assert.equal(answer.body.error, SAY.badRequest)
  } finally {
    done()
  }
})

test('unexpected failure inside the handler: one fixed sentence, nothing of the error (which could hold the key) is sent or logged', async () => {
  const { file, done } = folder()
  try {
    const env = new Proxy({}, { set(target, name, value) { throw new Error(`boom with ${value} in it`) } })
    const settings = createSettings({ file, env })
    let answer
    const lines = await watchingConsole(async () => { answer = await call(settings, { action: 'save', slot: 'OPENAI_API_KEY', value: KEY }) })
    assert.equal(answer.status, 500)
    assert.equal(answer.body.error, SAY.cannotSave)
    assert.ok(!JSON.stringify(answer).includes(KEY) && !JSON.stringify(answer).includes('boom'))
    assert.ok(lines.every((line) => !line.includes(KEY) && !line.includes('boom')))
  } finally {
    done()
  }
})

test('the guards that back up the key shape also hold on their own: spaces, control characters and length', () => {
  const source = readFileSync(join(ROOT, 'local', 'settings.mjs'), 'utf8')
  assert.match(source, /if \(hasSpaceOrControl\(value\)\) return SAY\.whitespace/)
  assert.match(source, /if \(value\.length > 400\) return SAY\.tooBig/)
})
