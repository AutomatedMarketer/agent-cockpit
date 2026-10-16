// The board on a student's own computer (Student Edition, task T1): local/server.mjs runs the same
// api/*.js files as Vercel on plain Node, serves public/, and listens on 127.0.0.1 only.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import net from 'node:net'
import { startBoardServer, createBoardServer, assertLoopback } from '../local/server.mjs'
import { API_ROUTES } from '../local/routes.mjs'
import { loadVercelConfig } from '../local/headers.mjs'
import { BODY_LIMIT_BYTES } from '../local/vercel-shim.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

async function running(options) {
  const board = await startBoardServer({ port: 0, ...options })
  const url = (path) => `http://127.0.0.1:${board.port}${path}`
  const stop = () => new Promise((done) => { board.server.close(done); board.server.closeAllConnections() })
  return { ...board, url, stop }
}

// A handler that reports back everything the real handlers read from request and response.
const echo = (request, response) => {
  response.setHeader('X-Custom', 'one')
  response.status(201).json({
    method: request.method,
    url: request.url,
    query: request.query,
    headers: request.headers,
    body: Buffer.isBuffer(request.body) ? { buffer: request.body.toString('hex') } : request.body ?? null,
    bodyType: request.body === undefined ? 'undefined' : Buffer.isBuffer(request.body) ? 'buffer' : typeof request.body
  })
}

async function withEcho(run, extra = {}) {
  const board = await running({ loadHandler: async () => echo, ...extra })
  try {
    await run(board)
  } finally {
    await board.stop()
  }
}

// ---- every api file is routed ------------------------------------------------------------------

test('every handler file in api/ is routed, and every route has a file', () => {
  const files = readdirSync(join(ROOT, 'api'))
    .filter((name) => name.endsWith('.js') && !name.startsWith('_'))
    .map((name) => name.slice(0, -3))
    .sort()
  assert.deepEqual([...API_ROUTES].sort(), files,
    'api/ and local/routes.mjs differ: add the new file to API_ROUTES (or remove the route) so the local board matches the website')
})

test('every routed file loads and exports a handler function', async () => {
  for (const name of API_ROUTES) {
    const loaded = await import(pathToFileURL(join(ROOT, 'api', `${name}.js`)).href)
    assert.equal(typeof loaded.default, 'function', `api/${name}.js has no default handler`)
  }
})

test('every routed endpoint answers through the real server, never a router miss, and never reaches the network', async () => {
  const realFetch = globalThis.fetch
  const outbound = []
  const board = await running()
  // The handlers talk to GitHub, OpenAI and others with fetch; this test must never do that.
  globalThis.fetch = async (input, init) => {
    const target = String(input?.url ?? input)
    if (target.startsWith(`http://127.0.0.1:${board.port}/`)) return realFetch(input, init)
    outbound.push(target)
    throw new Error('blocked in test')
  }
  try {
    for (const name of API_ROUTES) {
      const answer = await fetch(board.url(`/api/${name}`))
      const text = await answer.text()
      assert.notEqual(text, JSON.stringify({ error: 'No such endpoint.' }), `/api/${name} is not routed`)
      assert.ok(answer.status < 600 && answer.status >= 200, `/api/${name} gave ${answer.status}`)
    }
  } finally {
    globalThis.fetch = realFetch
    await board.stop()
  }
  assert.deepEqual(outbound, [], 'a handler tried to reach the network during the routing check')
})

test('an api file that is not listed, a private _ file, and odd shapes are refused as not found', async () => {
  const board = await running()
  try {
    for (const path of ['/api/nothing', '/api/_lib', '/api/_gate', '/api/', '/api', '/api/state/', '/api/state.js', '/api/../package.json', '/api/STATE', '/api/state%2f..']) {
      const answer = await fetch(board.url(path))
      assert.equal(answer.status, 404, `${path} gave ${answer.status}`)
    }
  } finally {
    await board.stop()
  }
})

// ---- request and response behave like Vercel's ---------------------------------------------------

test('request: method, url, lower-case headers, and a parsed query with repeated keys as arrays', async () => {
  await withEcho(async (board) => {
    const answer = await fetch(board.url('/api/state?since=abc&tag=a&tag=b&empty='), { headers: { 'X-Thing': 'yes' } })
    const seen = await answer.json()
    assert.equal(seen.method, 'GET')
    assert.equal(seen.url, '/api/state?since=abc&tag=a&tag=b&empty=')
    assert.deepEqual(seen.query, { since: 'abc', tag: ['a', 'b'], empty: '' })
    assert.equal(seen.headers['x-thing'], 'yes')
    assert.equal(seen.headers.host, `127.0.0.1:${board.port}`)
    assert.equal(seen.bodyType, 'undefined')
  })
})

test('request: a key called __proto__ in the query is just a key', async () => {
  await withEcho(async (board) => {
    const seen = await (await fetch(board.url('/api/state?__proto__=x'))).json()
    assert.equal(Object.keys(seen.query).includes('__proto__'), true)
  })
})

test('request body: JSON becomes an object, octet-stream a Buffer, text a string, a form an object', async () => {
  await withEcho(async (board) => {
    const send = async (body, type) => (await fetch(board.url('/api/fire'), { method: 'POST', headers: type ? { 'Content-Type': type } : {}, body })).json()
    const json = await send('{"a":1,"b":[2]}', 'application/json; charset=utf-8')
    assert.deepEqual(json.body, { a: 1, b: [2] })
    assert.equal(json.bodyType, 'object')
    const bytes = await send(new Uint8Array([0, 1, 255]), 'application/octet-stream')
    assert.equal(bytes.bodyType, 'buffer')
    assert.equal(bytes.body.buffer, '0001ff')
    const text = await send('hello', 'text/plain')
    assert.equal(text.body, 'hello')
    assert.equal(text.bodyType, 'string')
    const form = await send('a=1&a=2&b=x', 'application/x-www-form-urlencoded')
    assert.deepEqual(form.body, { a: ['1', '2'], b: 'x' })
    const none = await send(undefined, 'application/json')
    assert.equal(none.bodyType, 'undefined')
  })
})

test('request body: bad JSON is a 400 and the handler never runs', async () => {
  let ran = false
  await withEcho(async (board) => {
    const answer = await fetch(board.url('/api/fire'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' })
    assert.equal(answer.status, 400)
    assert.equal(ran, false)
  }, { loadHandler: async () => () => { ran = true } })
})

test('request body: over Vercel\'s 4.5 MB cap is a 413, declared or streamed, and the handler never runs', async () => {
  let ran = false
  const board = await running({ loadHandler: async () => () => { ran = true } })
  try {
    const big = Buffer.alloc(BODY_LIMIT_BYTES + 1, 1)
    // The board answers 413 and hangs up without reading the rest, so the sender may see either
    // the 413 or the hang-up. What matters: it is never accepted and the handler never runs.
    const refused = await fetch(board.url('/api/upload'), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: big, signal: AbortSignal.timeout(4000) })
      .then((answer) => answer.status, () => 'hung up')
    assert.ok(refused === 413 || refused === 'hung up', `an oversized body got ${refused}`)

    // No Content-Length: sent in chunks, so only the running count can catch it.
    const status = await new Promise((resolve, reject) => {
      const socket = net.connect(board.port, '127.0.0.1', () => {
        socket.write(`POST /api/upload HTTP/1.1\r\nHost: 127.0.0.1:${board.port}\r\nContent-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\n\r\n`)
        const chunk = Buffer.alloc(1024 * 1024, 2)
        for (let sent = 0; sent < 6; sent += 1) {
          socket.write(`${chunk.length.toString(16)}\r\n`)
          socket.write(chunk)
          socket.write('\r\n')
        }
        socket.write('0\r\n\r\n')
      })
      let received = ''
      socket.on('data', (data) => {
        received += data
        if (/HTTP\/1\.1 \d+/.test(received)) { socket.destroy(); resolve(Number(/HTTP\/1\.1 (\d+)/.exec(received)[1])) }
      })
      socket.on('error', () => {}) // the server may close while the rest is still being sent
    })
    assert.equal(status, 413)
  } finally {
    await board.stop()
  }
  assert.equal(ran, false)
})

test('response: status(n).json(x), setHeader, status(n).end(), and end(bytes) all reach the browser', async () => {
  const handlers = {
    state: (request, response) => { response.setHeader('X-Custom', 'one'); response.status(201).json({ ok: true }) },
    art: (request, response) => { response.setHeader('Content-Type', 'image/webp'); response.status(200).end(Buffer.from([1, 2, 3])) },
    logout: (request, response) => { response.status(204).end() },
    file: (request, response) => { response.setHeader('Cache-Control', 'private, no-store'); response.setHeader('Allow', 'GET'); response.status(405).json({ error: 'GET only' }) },
    speak: (request, response) => { response.status(200).send({ viaSend: true }) }
  }
  const board = await running({ loadHandler: async (name) => handlers[name] })
  try {
    const created = await fetch(board.url('/api/state'))
    assert.equal(created.status, 201)
    assert.equal(created.headers.get('x-custom'), 'one')
    assert.match(created.headers.get('content-type'), /^application\/json/)
    assert.deepEqual(await created.json(), { ok: true })

    const picture = await fetch(board.url('/api/art'))
    assert.equal(picture.headers.get('content-type'), 'image/webp')
    assert.deepEqual([...new Uint8Array(await picture.arrayBuffer())], [1, 2, 3])

    const empty = await fetch(board.url('/api/logout'), { method: 'POST' })
    assert.equal(empty.status, 204)

    const refused = await fetch(board.url('/api/file'))
    assert.equal(refused.status, 405)
    assert.equal(refused.headers.get('allow'), 'GET')
    assert.equal(refused.headers.get('cache-control'), 'private, no-store')

    assert.deepEqual(await (await fetch(board.url('/api/speak'))).json(), { viaSend: true })
  } finally {
    await board.stop()
  }
})

test('a handler that throws gets a plain 500 that leaks nothing from the error', async () => {
  const noisy = console.error
  const logged = []
  console.error = (line) => logged.push(line)
  const board = await running({ loadHandler: async () => () => { throw new Error('secret path C:/Users/someone/key') } })
  try {
    const answer = await fetch(board.url('/api/state'))
    assert.equal(answer.status, 500)
    const text = await answer.text()
    assert.doesNotMatch(text, /secret|Users|key/)
  } finally {
    console.error = noisy
    await board.stop()
  }
  assert.match(logged.join('\n'), /secret path/, 'the reason should reach the window the board runs in')
})

// ---- the real handlers, through the real server --------------------------------------------------

test('the real file.js answers a bad call the way it does on Vercel (405 with Allow, no-store)', async () => {
  const board = await running()
  try {
    const answer = await fetch(board.url('/api/file'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(answer.status, 405)
    assert.equal(answer.headers.get('allow'), 'GET')
    assert.equal(answer.headers.get('cache-control'), 'private, no-store')
    assert.match((await answer.json()).error, /GET only/)
  } finally {
    await board.stop()
  }
})

// ---- security headers come from vercel.json ------------------------------------------------------

test('vercel.json headers are on pages, files, api answers, 404s and redirects alike', async () => {
  const expected = loadVercelConfig(join(ROOT, 'vercel.json')).headers
  assert.ok(expected.length >= 6, 'vercel.json should hold the security headers')
  const names = expected.map(([key]) => key.toLowerCase())
  for (const needed of ['content-security-policy', 'x-frame-options', 'x-content-type-options', 'permissions-policy', 'referrer-policy', 'cross-origin-opener-policy']) {
    assert.ok(names.includes(needed), `vercel.json lost ${needed}`)
  }
  const board = await running()
  try {
    for (const path of ['/', '/app.js', '/icon.svg', '/api/file', '/api/nothing', '/missing', '/index.html', '/%2e%2e/package.json']) {
      const answer = await fetch(board.url(path), { redirect: 'manual' })
      for (const [key, value] of expected) {
        assert.equal(answer.headers.get(key), value, `${path}: header ${key} differs from vercel.json`)
      }
    }
  } finally {
    await board.stop()
  }
})

test('the header loader refuses vercel.json rules it would otherwise ignore', () => {
  const folder = mkdtempSync(join(tmpdir(), 'board-vercel-'))
  try {
    const write = (config) => {
      writeFileSync(join(folder, 'vercel.json'), JSON.stringify(config))
      return () => loadVercelConfig(join(folder, 'vercel.json'))
    }
    assert.throws(write({ cleanUrls: true, headers: [{ source: '/api/(.*)', headers: [{ key: 'A', value: 'b' }] }] }), /only "\/\(\.\*\)"/)
    assert.throws(write({ cleanUrls: false }), /cleanUrls/)
    assert.throws(write({ cleanUrls: true, rewrites: [{ source: '/a', destination: '/b' }] }), /rewrites/)
    assert.deepEqual(write({ cleanUrls: true, headers: [{ source: '/(.*)', headers: [{ key: 'A', value: 'b' }] }] })().headers, [['A', 'b']])
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

// ---- static files --------------------------------------------------------------------------------

test('static: / is the page, files have their types, clean URLs redirect, HEAD has no body, other methods are 405', async () => {
  const board = await running()
  try {
    const page = await fetch(board.url('/'))
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type'), /^text\/html/)
    assert.equal(await page.text(), readFileSync(join(ROOT, 'public', 'index.html'), 'utf8'))

    const script = await fetch(board.url('/app.js'))
    assert.match(script.headers.get('content-type'), /^text\/javascript/)
    assert.equal(script.headers.get('cache-control'), 'public, max-age=0, must-revalidate')
    assert.equal(Buffer.from(await script.arrayBuffer()).equals(readFileSync(join(ROOT, 'public', 'app.js'))), true)

    assert.match((await fetch(board.url('/manifest.webmanifest'))).headers.get('content-type'), /manifest\+json/)
    assert.equal((await fetch(board.url('/icon.svg'))).headers.get('content-type'), 'image/svg+xml')
    assert.equal((await fetch(board.url('/fonts/inter-latin-var.woff2'))).headers.get('content-type'), 'font/woff2')

    const old = await fetch(board.url('/index.html'), { redirect: 'manual' })
    assert.equal(old.status, 308)
    assert.equal(old.headers.get('location'), '/')

    const head = await fetch(board.url('/app.js'), { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal((await head.text()), '')

    assert.equal((await fetch(board.url('/'), { method: 'POST', body: 'x' })).status, 405)
    assert.equal((await fetch(board.url('/nope'))).status, 404)
    assert.equal((await fetch(board.url('/fonts'))).status, 404, 'a folder is not a file')
  } finally {
    await board.stop()
  }
})

test('static: clean URLs find x.html for /x', async () => {
  const root = mkdtempSync(join(tmpdir(), 'board-root-'))
  try {
    mkdirSync(join(root, 'public'))
    mkdirSync(join(root, 'api'))
    writeFileSync(join(root, 'public', 'about.html'), '<p>about</p>')
    writeFileSync(join(root, 'vercel.json'), readFileSync(join(ROOT, 'vercel.json')))
    const board = await running({ root })
    try {
      assert.equal(await (await fetch(board.url('/about'))).text(), '<p>about</p>')
      const direct = await fetch(board.url('/about.html'), { redirect: 'manual' })
      assert.equal(direct.status, 308)
      assert.equal(direct.headers.get('location'), '/about')
    } finally {
      await board.stop()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---- path traversal ------------------------------------------------------------------------------

// Raw sockets, so nothing normalises the path before the server sees it (fetch and curl both do).
function rawGet(port, path) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`)
    })
    let received = ''
    socket.on('data', (data) => { received += data })
    socket.on('close', () => resolve({ status: Number(/HTTP\/1\.1 (\d+)/.exec(received)?.[1] ?? 0), text: received }))
    socket.on('error', () => {}) // a request Node itself refuses resets the connection: that is a refusal too
  })
}

test('path traversal: nothing outside public/ is ever served, in any spelling', async () => {
  const board = await running()
  const packageJson = readFileSync(join(ROOT, 'package.json'), 'utf8')
  const secretMarker = '"agent-cockpit"'
  assert.ok(packageJson.includes(secretMarker))
  try {
    const attempts = [
      '/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json', '/%2e%2e%2fpackage.json', '/%2E%2E%2Fpackage.json',
      '/..\\package.json', '/..%5cpackage.json', '/fonts/../../package.json', '/./../package.json', '/.%2e/package.json',
      '/%252e%252e/package.json', '/....//package.json', '/%00', '/index.html%00.png', '/C:/Windows/win.ini', '/c%3a/windows/win.ini',
      '/app.js::$DATA', '/.git/config', '/.env', '/api/../package.json', '//package.json', '/%ff', '/..'
    ]
    for (const path of attempts) {
      const answer = await rawGet(board.port, path)
      assert.ok([0, 400, 404, 308].includes(answer.status), `${path} gave ${answer.status}`)
      assert.ok(!answer.text.includes(secretMarker), `${path} served package.json`)
      assert.ok(!/\[fonts\]|for 16-bit app support/i.test(answer.text), `${path} served win.ini`)
    }
  } finally {
    await board.stop()
  }
})

// A folder link. A 'junction' needs no privilege on Windows; on other systems it is a plain link.
function makeFolderLink(target, path) {
  try {
    symlinkSync(target, path, 'junction')
    return true
  } catch {
    return false
  }
}

// A temp board folder: vercel.json, an api/ folder and a public/ folder holding the given files.
function tempBoard(files) {
  const root = mkdtempSync(join(tmpdir(), 'board-tmp-'))
  mkdirSync(join(root, 'api'))
  writeFileSync(join(root, 'vercel.json'), readFileSync(join(ROOT, 'vercel.json')))
  for (const [name, text] of Object.entries(files)) {
    const file = join(root, 'public', name)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  return root
}

test('path traversal: a link inside public/ that points outside is not followed', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'board-link-'))
  try {
    mkdirSync(join(root, 'public'))
    mkdirSync(join(root, 'outside'))
    writeFileSync(join(root, 'outside', 'note.txt'), 'outside the public folder')
    writeFileSync(join(root, 'vercel.json'), readFileSync(join(ROOT, 'vercel.json')))
    if (!makeFolderLink(join(root, 'outside'), join(root, 'public', 'link'))) return t.skip('this computer will not make folder links')
    const board = await running({ root })
    try {
      const answer = await fetch(board.url('/link/note.txt'))
      assert.equal(answer.status, 404)
      assert.doesNotMatch(await answer.text(), /outside the public folder/)
    } finally {
      await board.stop()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---- binds 127.0.0.1 only ------------------------------------------------------------------------

test('the server refuses to start on any address but 127.0.0.1', async () => {
  for (const host of ['0.0.0.0', '::', '::1', 'localhost', '', undefined === null ? '' : '192.168.1.5', '127.0.0.2', '127.0.0.1 ', 'LOCALHOST', null, 0]) {
    assert.throws(() => assertLoopback(host), /only listens on 127\.0\.0\.1/, `${JSON.stringify(host)} was accepted`)
    await assert.rejects(startBoardServer({ port: 0, host }), /only listens on 127\.0\.0\.1/, `${JSON.stringify(host)} was started`)
  }
  assert.doesNotThrow(() => assertLoopback('127.0.0.1'))
})

test('a running board is bound to 127.0.0.1 and is not reachable on another address of this computer', async () => {
  const board = await running()
  try {
    assert.equal(board.server.address().address, '127.0.0.1')
    assert.equal(board.host, '127.0.0.1')
    assert.equal((await fetch(board.url('/'))).status, 200)
    // Any other local address of this computer must not answer on the board's port.
    const { networkInterfaces } = await import('node:os')
    const others = Object.values(networkInterfaces()).flat().filter((entry) => entry && entry.family === 'IPv4' && entry.address !== '127.0.0.1')
    for (const entry of others) {
      const reachable = await new Promise((resolve) => {
        const socket = net.connect({ port: board.port, host: entry.address, timeout: 1500 }, () => { socket.destroy(); resolve(true) })
        socket.on('error', () => resolve(false))
        socket.on('timeout', () => { socket.destroy(); resolve(false) })
      })
      assert.equal(reachable, false, `the board answered on ${entry.address}`)
    }
  } finally {
    await board.stop()
  }
})

test('the command line refuses a host other than 127.0.0.1', async () => {
  const { spawnSync } = await import('node:child_process')
  const refused = spawnSync(process.execPath, [join(ROOT, 'local', 'server.mjs'), '--host', '0.0.0.0', '--port', '0'], { encoding: 'utf8', timeout: 20000 })
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /only listens on 127\.0\.0\.1/)
})

test('what is still missing (T2 git, T3 pictures, T5 starters) is written down where the next person will read it', () => {
  const readme = readFileSync(join(ROOT, 'local', 'README.md'), 'utf8')
  for (const task of ['T2', 'T3', 'T5']) assert.match(readme, new RegExp(task))
  assert.match(readFileSync(join(ROOT, 'local', 'server.mjs'), 'utf8').slice(0, 1200), /T2/)
})

test('the gate seam can stop a request before any handler or file runs', async () => {
  let ran = false
  const board = await running({
    gate: (request, response) => { response.statusCode = 401; response.end('no'); return false },
    loadHandler: async () => () => { ran = true }
  })
  try {
    assert.equal((await fetch(board.url('/api/state'))).status, 401)
    assert.equal((await fetch(board.url('/'))).status, 401)
  } finally {
    await board.stop()
  }
  assert.equal(ran, false)
})

test('createBoardServer alone does not listen on anything', () => {
  const server = createBoardServer()
  assert.equal(server.listening, false)
})

// ---- review round: spoofed forwarding headers, DNS rebinding, and smaller guards ------------------

// One raw request with exactly the text given, so nothing fills in or fixes a header.
function rawHttp(port, requestText, { until = /HTTP\/1\.1 \d+/ } = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    const socket = net.connect(port, '127.0.0.1', () => socket.write(requestText))
    let received = ''
    let done = false
    const finish = () => {
      if (done) return
      done = true
      socket.destroy()
      resolve({ status: Number(/HTTP\/1\.1 (\d+)/.exec(received)?.[1] ?? 0), text: received, ms: Date.now() - started })
    }
    socket.on('data', (data) => { received += data; if (until.test(received)) finish() })
    socket.on('close', finish)
    socket.on('error', () => {})
    setTimeout(finish, 5000).unref()
  })
}
const getWithHost = (port, path, host) => rawHttp(port, `GET ${path} HTTP/1.1\r\n${host === undefined ? '' : `Host: ${host}\r\n`}Connection: close\r\n\r\n`, { until: /\r\n\r\n/ })

test('forwarding headers a caller sends are replaced with the real connection address', async () => {
  await withEcho(async (board) => {
    const seen = await (await fetch(board.url('/api/state'), {
      headers: { 'X-Forwarded-For': '9.9.9.9', 'X-Real-IP': '8.8.8.8', 'X-Forwarded-Host': 'evil.example' }
    })).json()
    assert.equal(seen.headers['x-forwarded-for'], '127.0.0.1')
    assert.equal(seen.headers['x-real-ip'], '127.0.0.1')
    assert.equal(seen.headers['x-forwarded-host'], undefined)
  })
})

test('the real login.js: rotating X-Forwarded-For does not reset the guess limit', async () => {
  const saved = { VIEW_KEY: process.env.VIEW_KEY, BOARD_PASSWORD: process.env.BOARD_PASSWORD, PUBLIC_DASHBOARD: process.env.PUBLIC_DASHBOARD }
  process.env.VIEW_KEY = 'review-view-key-0123456789abcdef0123456789'
  process.env.BOARD_PASSWORD = 'correct horse battery staple'
  delete process.env.PUBLIC_DASHBOARD
  const board = await running()
  try {
    const statuses = []
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const answer = await fetch(board.url('/api/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', 'X-Forwarded-For': `10.0.0.${attempt}`, 'X-Real-IP': `10.1.0.${attempt}` },
        body: JSON.stringify({ password: 'wrong guess' })
      })
      statuses.push(answer.status)
    }
    assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401])
    assert.ok(statuses.slice(5).every((status) => status === 429), `the limit never closed: ${statuses.join(' ')}`)
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await board.stop()
  }
})

test('Host check: only 127.0.0.1:<port> and localhost:<port> are answered, for api and files alike', async () => {
  const board = await running()
  try {
    const wrong = ['evil.example', `evil.example:${board.port}`, '127.0.0.1', 'localhost', `127.0.0.1:${board.port + 1}`, `localhost:${board.port + 1}`,
      `127.0.0.1.evil.example:${board.port}`, `localhost.:${board.port}`, `user@127.0.0.1:${board.port}`, `[::1]:${board.port}`, `0.0.0.0:${board.port}`, '']
    for (const path of ['/', '/app.js', '/api/state', '/api/file']) {
      for (const host of wrong) {
        const answer = await getWithHost(board.port, path, host)
        assert.equal(answer.status, 421, `${path} with Host "${host}" gave ${answer.status}`)
        assert.doesNotMatch(answer.text, /<html|"error"|state|Not found/i, `${path} with Host "${host}" said too much`)
      }
      assert.ok([400, 421].includes((await getWithHost(board.port, path, undefined)).status), `${path} with no Host was answered`) // Node itself refuses HTTP/1.1 without Host
      for (const host of [`127.0.0.1:${board.port}`, `localhost:${board.port}`, `LOCALHOST:${board.port}`, `LocalHost:${board.port}`]) {
        assert.notEqual((await getWithHost(board.port, path, host)).status, 421, `${path} with Host "${host}" was refused`)
      }
    }
  } finally {
    await board.stop()
  }
})

test('Host check runs before the handler and before any custom gate', async () => {
  let ran = false
  let gated = false
  const board = await running({ loadHandler: async () => () => { ran = true }, gate: () => { gated = true } })
  try {
    assert.equal((await getWithHost(board.port, '/api/state', 'evil.example')).status, 421)
  } finally {
    await board.stop()
  }
  assert.equal(ran, false)
  assert.equal(gated, false)
})

test('local/README.md no longer says anything on this computer reaches the board unchecked', () => {
  const readme = readFileSync(join(ROOT, 'local', 'README.md'), 'utf8')
  assert.doesNotMatch(readme, /anything running on this\s+computer can talk to the board/i)
  assert.match(readme, /Host/)
})

test('a handler that answers twice does not crash the board', async () => {
  const handlers = {
    state: (request, response) => { response.status(200).json({ first: true }); response.json({ second: true }); response.send('again') },
    art: (request, response) => { response.status(200).send({ a: 1 }); response.status(500).json({ b: 2 }) }
  }
  const noisy = console.error
  const logged = []
  console.error = (line) => logged.push(String(line))
  const board = await running({ loadHandler: async (name) => handlers[name] })
  try {
    assert.deepEqual(await (await fetch(board.url('/api/state'))).json(), { first: true })
    assert.deepEqual(await (await fetch(board.url('/api/art'))).json(), { a: 1 })
    assert.equal((await fetch(board.url('/'))).status, 200, 'the board stopped answering')
    assert.deepEqual(logged, [], 'a second answer should be ignored quietly, not turn into an error')
  } finally {
    console.error = noisy
    await board.stop()
  }
})

test('a handler that never answers gets a 504 after the time limit', async () => {
  const board = await running({ handlerTimeoutMs: 150, loadHandler: async () => () => new Promise(() => {}) })
  try {
    const started = Date.now()
    const answer = await fetch(board.url('/api/state'))
    assert.equal(answer.status, 504)
    assert.ok(Date.now() - started < 3000)
  } finally {
    await board.stop()
  }
})

test('a handler that answers in time is not cut off by the time limit', async () => {
  const board = await running({ handlerTimeoutMs: 400, loadHandler: async () => (request, response) => { setTimeout(() => response.status(200).json({ ok: 1 }), 50) } })
  try {
    assert.equal((await fetch(board.url('/api/state'))).status, 200)
    await new Promise((done) => setTimeout(done, 600))
  } finally {
    await board.stop()
  }
})

test('static: dot files and folders are refused with no contents, at any depth', async () => {
  const root = tempBoard({ 'index.html': '<p>home</p>', '.env': 'TOP_SECRET_ENV', '.git/config': 'TOP_SECRET_GIT', 'sub/.secret': 'TOP_SECRET_SUB', 'sub/ok.txt': 'fine' })
  const board = await running({ root })
  try {
    for (const path of ['/.env', '/.git/config', '/sub/.secret', '/%2eenv', '/sub/%2esecret', '/.git']) {
      const answer = await rawHttp(board.port, `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${board.port}\r\nConnection: close\r\n\r\n`, { until: /\r\n\r\n[\s\S]/ })
      assert.equal(answer.status, 400, `${path} gave ${answer.status}`)
      assert.doesNotMatch(answer.text, /TOP_SECRET/)
    }
    // Windows short names for the same files (ENV~1, GIT~1), where this drive has them.
    for (const path of ['/ENV~1', '/GIT~1/config', '/sub/SECRET~1']) {
      const answer = await fetch(board.url(path))
      assert.doesNotMatch(await answer.text(), /TOP_SECRET/, `${path} served a hidden file`)
    }
    assert.equal(await (await fetch(board.url('/sub/ok.txt'))).text(), 'fine')
  } finally {
    await board.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test('static: a link whose real place has a dot-folder in it is refused', async (t) => {
  const root = tempBoard({ 'index.html': '<p>home</p>', '.hidden/secret.txt': 'TOP_SECRET_LINKED' })
  if (!makeFolderLink(join(root, 'public', '.hidden'), join(root, 'public', 'visible'))) {
    rmSync(root, { recursive: true, force: true })
    return t.skip('this computer will not make folder links')
  }
  const board = await running({ root })
  try {
    const answer = await fetch(board.url('/visible/secret.txt'))
    assert.equal(answer.status, 404)
    assert.doesNotMatch(await answer.text(), /TOP_SECRET/)
  } finally {
    await board.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test('static: a file name with non-ASCII letters redirects without an error', async () => {
  const root = tempBoard({ 'index.html': '<p>home</p>', 'café.html': '<p>cafe</p>' })
  const board = await running({ root })
  try {
    for (const path of ['/caf%C3%A9.html', '/caf%C3%A9']) {
      const answer = await fetch(board.url(path), { redirect: 'manual' })
      assert.notEqual(answer.status, 500, `${path} broke`)
      if (path.endsWith('.html')) {
        assert.equal(answer.status, 308)
        assert.match(answer.headers.get('location'), /^\/caf%C3%A9$/)
      } else {
        assert.equal(await answer.text(), '<p>cafe</p>')
      }
    }
  } finally {
    await board.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a declared 5 MB body that never arrives is refused at once, not waited for', async () => {
  const board = await running({ loadHandler: async () => () => {} })
  try {
    const answer = await rawHttp(board.port, `POST /api/upload HTTP/1.1\r\nHost: 127.0.0.1:${board.port}\r\nContent-Type: application/octet-stream\r\nContent-Length: 5000000\r\n\r\n`)
    assert.equal(answer.status, 413)
    assert.ok(answer.ms < 300, `took ${answer.ms} ms`)
  } finally {
    await board.stop()
  }
})

test('a server that came up on any address but 127.0.0.1 is shut down and the start fails', async () => {
  let closed = false
  const build = (options) => {
    const server = createBoardServer(options)
    const realAddress = server.address.bind(server)
    server.address = () => ({ ...realAddress(), address: '0.0.0.0' })
    const realClose = server.close.bind(server)
    server.close = (...args) => { closed = true; return realClose(...args) }
    return server
  }
  await assert.rejects(startBoardServer({ port: 0, build }), /not 127\.0\.0\.1/)
  assert.equal(closed, true)
})

test('an error on the response is written to the window, not thrown', async () => {
  const noisy = console.error
  const logged = []
  console.error = (line) => logged.push(String(line))
  const board = await running({ loadHandler: async () => (request, response) => { response.emit('error', new Error('socket trouble')); response.status(200).json({ ok: 1 }) } })
  try {
    assert.equal((await fetch(board.url('/api/state'))).status, 200)
  } finally {
    console.error = noisy
    await board.stop()
  }
  assert.match(logged.join('\n'), /socket trouble/)
})

// ---- round 2 minors ---------------------------------------------------------------------------

test('the gate and page requests see cleaned forwarding headers, not the caller\'s', async () => {
  let seenByGate
  const board = await running({ gate: (request) => { seenByGate = { ...request.headers }; return true } })
  try {
    await fetch(board.url('/'), { headers: { 'X-Forwarded-For': '9.9.9.9', 'X-Real-IP': '8.8.8.8', 'X-Forwarded-Host': 'evil.example' } })
  } finally {
    await board.stop()
  }
  assert.equal(seenByGate['x-forwarded-for'], '127.0.0.1')
  assert.equal(seenByGate['x-real-ip'], '127.0.0.1')
  assert.equal(seenByGate['x-forwarded-host'], undefined)
})

test('port 80 is refused with a plain sentence (its Host header has no port to check)', async () => {
  await assert.rejects(startBoardServer({ port: 80 }), /port 80/i)
  const { spawnSync } = await import('node:child_process')
  const run = spawnSync(process.execPath, [join(ROOT, 'local', 'server.mjs'), '--port', '80'], { encoding: 'utf8', timeout: 20000 })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /port 80/i)
})

test('a handler is told when its time ran out (request.signal), and a 504 has gone out', async () => {
  let signal
  const board = await running({ handlerTimeoutMs: 100, loadHandler: async () => (request) => { signal = request.signal; return new Promise(() => {}) } })
  try {
    assert.equal((await fetch(board.url('/api/state'))).status, 504)
  } finally {
    await board.stop()
  }
  assert.ok(signal instanceof AbortSignal)
  assert.equal(signal.aborted, true)
})

test('request.signal is not aborted for a handler that answers in time', async () => {
  let signal
  const board = await running({ handlerTimeoutMs: 1000, loadHandler: async () => (request, response) => { signal = request.signal; response.status(200).json({}) } })
  try {
    await fetch(board.url('/api/state'))
    await new Promise((done) => setTimeout(done, 100))
  } finally {
    await board.stop()
  }
  assert.equal(signal.aborted, false)
})
