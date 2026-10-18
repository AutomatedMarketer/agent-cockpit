// The start files of the board on this computer (Student Edition, task T5): what can be checked from
// node. What only a double-click can show is listed in local/README.md ("Only a double-click proves").

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, rmSync, statSync, readdirSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { askCode, answerCode } from '../local/starter-auth.mjs'
import { spawnSync } from 'node:child_process'
import { runStart, stateDirFor, openerFor, pickPort, readRunning } from '../local/start.mjs'
import { createRequire } from 'node:module'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const { nodeIsNewEnough, MIN_MAJOR } = require('../local/check-node.cjs')

const ENV_KEYS = ['VIEW_KEY', 'PUBLIC_FIRE', 'PUBLIC_DASHBOARD', 'EDIT_KEY', 'BOARD_PASSWORD', 'BOARD_USERNAME', 'REPO_SOURCE', 'REPO_FOLDER', 'PICTURE_STORE', 'PICTURE_FOLDER']

// Runs one or more starts against a private state folder. `opened` records what the "browser" was asked to open.
async function withStarter(run) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  const home = mkdtempSync(join(tmpdir(), 'board-start-'))
  const opened = []
  const logged = []
  const stateDir = join(home, 'state')
  const common = {
    platform: process.platform,
    env: { ...process.env, LOCALAPPDATA: join(home, 'local'), XDG_STATE_HOME: join(home, 'xdg') },
    home,
    stateDir,
    basePort: 20000 + Math.floor(Math.random() * 8000),
    lingerMs: 30,
    // The test's "browser": it reads the launcher file the way a browser would, then reports it.
    openFile: async (file) => { opened.push({ file, text: readFileSync(file, 'utf8'), mode: statSync(file).mode }) },
    log: (line) => logged.push(String(line))
  }
  const noisy = { log: console.log, error: console.error }
  console.log = (...parts) => logged.push(parts.join(' '))
  console.error = (...parts) => logged.push(parts.join(' '))
  const started = []
  const start = async (extra = {}) => {
    const result = await runStart({ ...common, ...extra })
    started.push(result)
    return result
  }
  try {
    await run({ start, opened, logged, home, stateDir, common })
  } finally {
    console.log = noisy.log
    console.error = noisy.error
    for (const result of started) await result.close?.()
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    rmSync(home, { recursive: true, force: true })
  }
}

const linkIn = (text) => /http:\/\/127\.0\.0\.1:\d+\/open-board\?t=[\w-]+/.exec(text)?.[0]

// ---- the start itself --------------------------------------------------------------------------------

test('start: the board comes up, the "browser" is given a FILE (not the link), and the link works once', async () => {
  await withStarter(async ({ start, opened }) => {
    const result = await start()
    assert.equal(result.mode, 'started')
    assert.equal(opened.length, 1)
    const link = linkIn(opened[0].text)
    assert.ok(link, 'the launcher file should send the browser to the one-time link')
    assert.ok(!opened[0].file.includes('open-board') && !opened[0].file.includes('t='), 'the file NAME must not hold the link')
    const first = await fetch(link, { redirect: 'manual' })
    assert.equal(first.status, 200)
    assert.equal((await fetch(link, { redirect: 'manual' })).status, 403)
  })
})

test('start: the link is never printed, logged, or put in the state file', async () => {
  await withStarter(async ({ start, opened, logged, stateDir }) => {
    await start()
    const token = new URL(linkIn(opened[0].text)).searchParams.get('t')
    assert.ok(token)
    assert.ok(!logged.join('\n').includes(token), 'the link reached a log line')
    const everyFile = []
    const walk = (dir) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else everyFile.push(path) } }
    walk(stateDir)
    for (const file of everyFile) {
      if (file.includes('launch')) continue // the short-lived launcher is the one place, and is checked below
      assert.ok(!readFileSync(file, 'utf8').includes(token), `${file} holds the link`)
    }
  })
})

test('start: the launcher file is private, short-lived, and gone after the linger time', async () => {
  await withStarter(async ({ start, opened }) => {
    await start()
    const { file, mode } = opened[0]
    if (process.platform !== 'win32') assert.equal(mode & 0o077, 0, 'the launcher file is readable by other users')
    assert.equal(existsSync(file), false, 'the launcher file was left behind once the start finished')
  })
})

test('start: the state file holds the port and a secret, is private, and is removed when the board stops', async () => {
  await withStarter(async ({ start, stateDir, common }) => {
    const result = await start()
    const running = readRunning(stateDir)
    assert.equal(running.port, result.port)
    assert.ok(running.secret.length >= 32)
    if (process.platform !== 'win32') assert.equal(statSync(join(stateDir, 'running.json')).mode & 0o077, 0)
    await result.close()
    assert.equal(existsSync(join(stateDir, 'running.json')), false)
    assert.equal(common.basePort <= result.port, true)
  })
})

test('start: a second double-click gets a fresh link from the running board, not a second server', async () => {
  await withStarter(async ({ start, opened }) => {
    const first = await start()
    const second = await start()
    assert.equal(second.mode, 'reopened')
    assert.equal(second.port, first.port)
    assert.equal(opened.length, 2)
    const [one, two] = opened.map((entry) => linkIn(entry.text))
    assert.notEqual(one, two)
    assert.equal((await fetch(two, { redirect: 'manual' })).status, 200, 'the fresh link should work')
    assert.equal((await fetch(one, { redirect: 'manual' })).status, 200, 'the first link was not used yet, so it still works too')
  })
})

test('start: a state file left by a board that is gone is replaced, not trusted', async () => {
  await withStarter(async ({ start, stateDir }) => {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'running.json'), JSON.stringify({ port: 1, secret: 'x'.repeat(40) }))
    const result = await start()
    assert.equal(result.mode, 'started')
    assert.notEqual(readRunning(stateDir).port, 1)
  })
})

test('start: a state file whose secret is wrong (another board on that port) is not used for a link', async () => {
  await withStarter(async ({ start, stateDir, opened }) => {
    const first = await start()
    writeFileSync(join(stateDir, 'running.json'), JSON.stringify({ port: first.port, secret: 'y'.repeat(40) }))
    const second = await start()
    assert.equal(second.mode, 'started')
    assert.notEqual(second.port, first.port)
    assert.equal(opened.length, 2)
  })
})

test('start: garbage in the state file is ignored', async () => {
  await withStarter(async ({ start, stateDir }) => {
    mkdirSync(stateDir, { recursive: true })
    for (const text of ['', '{', 'null', '[]', '{"port":"x","secret":1}', '{"port":99999,"secret":"abc"}']) {
      writeFileSync(join(stateDir, 'running.json'), text)
      assert.equal(readRunning(stateDir), null, JSON.stringify(text))
    }
    const result = await start()
    assert.equal(result.mode, 'started')
  })
})

// ---- the endpoint a second start uses ---------------------------------------------------------------

// What a second Start Board sends: a nonce, the time, and a code made from the run's secret. Never the secret.
function askHeaders(secret, { time = String(Date.now()), nonce = randomBytes(16).toString('hex'), code } = {}) {
  return { 'x-starter-time': time, 'x-starter-nonce': nonce, 'x-starter-code': code ?? askCode(secret, time, nonce) }
}

test('starter endpoint: answers a good ask with a link and a proof only the real board can make', async () => {
  await withStarter(async ({ start, stateDir }) => {
    const { port } = await start()
    const secret = readRunning(stateDir).secret
    const url = `http://127.0.0.1:${port}/starter/open-link`
    const nonce = randomBytes(16).toString('hex')
    const good = await fetch(url, { method: 'POST', headers: askHeaders(secret, { nonce }) })
    assert.equal(good.status, 200)
    assert.equal(good.headers.get('set-cookie'), null)
    assert.equal(good.headers.get('cache-control'), 'no-store')
    const text = await good.text()
    assert.ok(!text.includes(secret), 'the secret was sent back')
    const { link, proof } = JSON.parse(text)
    assert.match(link, new RegExp(`^http://127\\.0\\.0\\.1:${port}/open-board\\?t=`))
    assert.equal(proof, answerCode(secret, nonce, link))
    assert.notEqual(proof, answerCode(secret, nonce, `${link}x`), 'the proof must cover the link')
  })
})

test('starter endpoint: refuses a wrong code, a stale or future time, a reused nonce, the bare secret, a GET and a browser', async () => {
  await withStarter(async ({ start, stateDir }) => {
    const { port } = await start()
    const secret = readRunning(stateDir).secret
    const url = `http://127.0.0.1:${port}/starter/open-link`
    const ask = (headers) => fetch(url, { method: 'POST', redirect: 'manual', headers })
    const now = Date.now()
    const nonce = randomBytes(16).toString('hex')
    const bad = [
      {},
      { 'x-starter-secret': secret },
      askHeaders('y'.repeat(48)),
      askHeaders(secret, { code: 'short' }),
      askHeaders(secret, { code: askCode(secret, String(now), 'someone-elses-nonce-0000') }),
      askHeaders(secret, { time: String(now - 120_000) }),
      askHeaders(secret, { time: String(now + 120_000) }),
      askHeaders(secret, { time: 'soon' }),
      { ...askHeaders(secret), 'x-starter-nonce': 'tiny' },
      { ...askHeaders(secret), 'x-starter-nonce': 'x'.repeat(200) },
      { ...askHeaders(secret), 'x-starter-nonce': 'has spaces in it ... ok?' }
    ]
    for (const headers of bad) {
      const answer = await ask(headers)
      assert.equal(answer.status, 403, JSON.stringify(headers))
      assert.doesNotMatch(await answer.text(), /open-board/)
    }
    // A good ask works once; the same ask again (a replay) does not.
    const once = askHeaders(secret, { nonce })
    assert.equal((await ask(once)).status, 200)
    assert.equal((await ask(once)).status, 403, 'a replayed ask was answered')
    assert.equal((await fetch(url, { headers: askHeaders(secret) })).status, 401, 'a GET is not an ask')
    for (const site of ['same-site', 'cross-site', 'same-origin']) {
      const answer = await ask({ ...askHeaders(secret), 'Sec-Fetch-Site': site, Origin: 'https://evil.example' })
      assert.equal(answer.status, 403, `a browser call (${site}) was answered`)
    }
  })
})

test('starter endpoint: a wrong Host is refused before anything', async () => {
  await withStarter(async ({ start, stateDir }) => {
    const { port } = await start()
    const secret = readRunning(stateDir).secret
    const headers = askHeaders(secret)
    const answer = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write(`POST /starter/open-link HTTP/1.1\r\nHost: evil.example\r\nx-starter-time: ${headers['x-starter-time']}\r\nx-starter-nonce: ${headers['x-starter-nonce']}\r\nx-starter-code: ${headers['x-starter-code']}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`))
      let text = ''
      socket.on('data', (data) => { text += data })
      socket.on('close', () => resolve(text))
      socket.on('error', () => resolve(text))
    })
    assert.match(answer, /^HTTP\/1\.1 421/)
    assert.doesNotMatch(answer, /open-board/)
  })
})

test('start: the second double-click never sends the secret, and only trusts an answer with the right proof', async () => {
  await withStarter(async ({ start, stateDir, opened }) => {
    const first = await start()
    const secret = readRunning(stateDir).secret
    const sent = []
    // A program that took over the port: it answers like the real thing, with a plausible link, but cannot prove it.
    const impostor = async (url, init) => {
      sent.push(JSON.stringify({ url, headers: init.headers }))
      return new Response(JSON.stringify({ link: `http://127.0.0.1:${first.port}/open-board?t=stolen`, proof: 'not-a-real-proof' }), { status: 200 })
    }
    const second = await start({ fetchImpl: impostor })
    assert.equal(second.mode, 'started', 'an answer without the right proof must not be trusted')
    assert.ok(opened.every((entry) => !entry.text.includes('stolen')), 'the browser was opened on the impostor\'s page')
    assert.equal(sent.length, 1)
    assert.ok(!sent[0].includes(secret), 'the secret was sent to whatever listens on the port')
    const real = await start()
    assert.equal(real.mode, 'reopened')
  })
})

test('start: the ask a real second double-click sends does not contain the secret either', async () => {
  await withStarter(async ({ start, stateDir }) => {
    await start()
    const secret = readRunning(stateDir).secret
    const sent = []
    await start({ fetchImpl: async (url, init) => { sent.push(JSON.stringify(init.headers)); return fetch(url, init) } })
    assert.equal(sent.length, 1)
    assert.ok(!sent[0].includes(secret))
  })
})

// ---- ports ------------------------------------------------------------------------------------------

test('ports: the first free port from the base is used, skipping busy ones', async () => {
  const base = 30000 + Math.floor(Math.random() * 15000)
  const busy = []
  for (const port of [base, base + 1]) {
    const server = net.createServer()
    await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done) })
    busy.push(server)
  }
  try {
    const tried = []
    const port = await pickPort(base, 10, async (candidate) => { tried.push(candidate); return candidate })
    assert.equal(port, base) // pickPort only returns what the starter accepted; busy-port skipping is below
    const skipped = await pickPort(base, 10, async (candidate) => {
      await new Promise((done, fail) => { const probe = net.createServer(); probe.once('error', fail); probe.listen(candidate, '127.0.0.1', () => probe.close(done)) })
      return candidate
    })
    assert.equal(skipped, base + 2)
  } finally {
    for (const server of busy) server.close()
  }
})

test('ports: other errors are not swallowed, and running out of ports says so plainly', async () => {
  await assert.rejects(pickPort(40000, 3, async () => { throw Object.assign(new Error('permission denied'), { code: 'EINVAL' }) }), /permission denied/)
  await assert.rejects(pickPort(40000, 3, async () => { throw Object.assign(new Error('busy'), { code: 'EADDRINUSE' }) }), /ports 40000 to 40002/)
  // Windows reserves ranges of ports and answers EACCES: that is "busy" to the student.
  let tried = 0
  const port = await pickPort(40000, 5, async (candidate) => { tried += 1; if (tried < 3) throw Object.assign(new Error('reserved'), { code: 'EACCES' }); return candidate })
  assert.equal(port, 40002)
})

test('ports: the default is 4317 and never 80', () => {
  const source = readFileSync(join(ROOT, 'local', 'start.mjs'), 'utf8')
  assert.match(source, /4317/)
})

// ---- where things live, and which program opens the browser -----------------------------------------

const slash = (path) => path.split(String.fromCharCode(92)).join("/")

test('state folder: per user, per operating system', () => {
  assert.equal(stateDirFor({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, home: 'C:\\Users\\a' }).replace(/\\/g, '/'), 'C:/Users/a/AppData/Local/Agent Board/state')
  assert.equal(slash(stateDirFor({ platform: 'darwin', env: {}, home: '/Users/a' })), '/Users/a/Library/Application Support/Agent Board/state')
  assert.equal(slash(stateDirFor({ platform: 'linux', env: {}, home: '/home/a' })), '/home/a/.local/state/agent-board')
  assert.equal(slash(stateDirFor({ platform: 'linux', env: { XDG_STATE_HOME: '/x' }, home: '/home/a' })), '/x/agent-board')
  assert.equal(stateDirFor({ platform: 'win32', env: {}, home: 'C:\\Users\\a' }).replace(/\\/g, '/'), 'C:/Users/a/AppData/Local/Agent Board/state')
})

test('opening the browser: absolute program paths, a neutral folder, no shell, nothing from the folder it was started in', () => {
  const win = openerFor({ platform: 'win32', env: { SystemRoot: 'C:\\Windows', Path: 'C:\\evil' }, file: 'C:\\s\\launch-1.html' })
  assert.equal(win.command.replace(/\\/g, '/'), 'C:/Windows/System32/rundll32.exe')
  assert.deepEqual(win.args, ['url.dll,FileProtocolHandler', 'C:\\s\\launch-1.html'])
  assert.equal(win.cwd, 'C:\\Windows\\System32')
  assert.equal(win.env.NoDefaultCurrentDirectoryInExePath, '1')
  const mac = openerFor({ platform: 'darwin', env: {}, file: '/tmp/x.html' })
  assert.deepEqual([mac.command, mac.args, mac.cwd], ['/usr/bin/open', ['/tmp/x.html'], '/'])
  const linux = openerFor({ platform: 'linux', env: {}, file: '/tmp/x.html' })
  assert.deepEqual([linux.command, linux.args, linux.cwd], ['/usr/bin/xdg-open', ['/tmp/x.html'], '/'])
  for (const opener of [win, mac, linux]) {
    assert.ok(/^([A-Za-z]:)?[\\/]/.test(opener.command), 'the program must be an absolute path')
    assert.equal(opener.shell, undefined, 'no shell')
  }
  assert.throws(() => openerFor({ platform: 'win32', env: {}, file: 'x' }), /SystemRoot/)
})

test('opening the browser: the link is not in the program, its arguments or its environment', async () => {
  const { openFileWith } = await import('../local/start.mjs')
  const calls = []
  const fakeSpawn = (command, args, options) => { calls.push({ command, args, options }); return { unref() {}, on() {} } }
  await openFileWith({ platform: 'linux', env: { PATH: '/bin' }, file: '/tmp/launch-ab12.html', spawnImpl: fakeSpawn })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.shell, undefined)
  assert.equal(calls[0].options.stdio, 'ignore')
  assert.equal(calls[0].options.detached, true)
  assert.doesNotMatch(JSON.stringify(calls[0]), /open-board|t=/)
})

// ---- node check -------------------------------------------------------------------------------------

test('node check: version 20 and up pass, older and odd ones do not, with a plain message', () => {
  assert.equal(MIN_MAJOR, 20)
  for (const version of ['20.0.0', '20.11.1', '22.3.0', '24.21.0', 'v20.1.0']) assert.equal(nodeIsNewEnough(version), true, version)
  for (const version of ['19.9.9', '18.19.0', '16.0.0', '', 'x', undefined, '2.0.0', '0.12.1']) assert.equal(nodeIsNewEnough(version), false, String(version))
  const old = spawnSync(process.execPath, [join(ROOT, 'local', 'check-node.cjs')], { encoding: 'utf8', env: { ...process.env, BOARD_FAKE_NODE_VERSION: '18.19.0' } })
  assert.equal(old.status, 1)
  assert.match(old.stdout + old.stderr, /Node.*20|nodejs\.org/i)
  const fine = spawnSync(process.execPath, [join(ROOT, 'local', 'check-node.cjs')], { encoding: 'utf8' })
  assert.equal(fine.status, 0)
})

test('node check: the file parses on very old Node (plain CommonJS, no modern syntax)', () => {
  const source = readFileSync(join(ROOT, 'local', 'check-node.cjs'), 'utf8')
  assert.doesNotMatch(source, /\bimport\s|\?\.|\?\?|=>|\bconst\b|\blet\b|`/, 'use var and function so Node 8 can still read it and say what is wrong')
})

// ---- the start files --------------------------------------------------------------------------------

test('files: .bat is CRLF and .command is LF, and .gitattributes says so', () => {
  const bat = readFileSync(join(ROOT, 'Start Board.bat'))
  const command = readFileSync(join(ROOT, 'Start Board.command'))
  const text = bat.toString('latin1')
  assert.ok(text.includes('\r\n'))
  assert.equal(text.replace(/\r\n/g, '').match(/[\r\n]/), null, 'a bare line ending in the .bat: cmd.exe misreads it')
  assert.equal(command.includes(13), false, 'a CR in the .command breaks the first line (#!/bin/bash\\r)')
  assert.match(command.toString('utf8'), /^#!\/bin\/bash\n/)
  const attributes = readFileSync(join(ROOT, '.gitattributes'), 'utf8')
  assert.match(attributes, /^\*\.bat\s+text\s+eol=crlf\s*$/m)
  assert.match(attributes, /^\*\.command\s+text\s+eol=lf\s*$/m)
})

test('files: the .command is stored executable in git (so a clone can double-click it)', () => {
  const run = spawnSync('git', ['ls-files', '-s', '--', 'Start Board.command'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' } })
  if (run.error || run.status !== 0 || !run.stdout.trim()) return // git missing, or the file not staged yet
  assert.match(run.stdout, /^100755 /)
})

test('files: .vercelignore keeps the local board and its start files off the website', () => {
  const ignore = readFileSync(join(ROOT, '.vercelignore'), 'utf8').split(/\r?\n/).map((line) => line.trim())
  for (const entry of ['local/', 'Start Board.command', 'Start Board.bat']) assert.ok(ignore.includes(entry), `${entry} would be deployed`)
})

test('files: neither start file writes a log, prints a link, or runs a bare program name from the board folder', () => {
  for (const name of ['Start Board.bat', 'Start Board.command']) {
    const text = readFileSync(join(ROOT, name), 'utf8')
    assert.doesNotMatch(text, />>?\s*\S*\.(log|txt)|\btee\b/i, `${name} writes to a file`)
    assert.doesNotMatch(text, /open-board/, `${name} knows the link`)
  }
  const bat = readFileSync(join(ROOT, 'Start Board.bat'), 'utf8')
  assert.match(bat, /NoDefaultCurrentDirectoryInExePath/)
  assert.match(bat, /System32\\where\.exe/i)
})

test('windows start file: a program planted next to it is never run', { skip: process.platform !== 'win32' }, () => {
  const folder = mkdtempSync(join(tmpdir(), 'board-planted-'))
  try {
    copyFileSync(join(ROOT, 'Start Board.bat'), join(folder, 'Start Board.bat'))
    const marker = join(folder, 'PLANTED_RAN.txt')
    for (const name of ['node.bat', 'node.cmd']) writeFileSync(join(folder, name), `@echo off\r\necho ran> "${marker}"\r\n`)
    const env = { ...process.env, BOARD_RESOLVE_ONLY: '1' }
    delete env.NoDefaultCurrentDirectoryInExePath
    const run = spawnSync(join(process.env.SystemRoot, 'System32', 'cmd.exe'), ['/d', '/c', join(folder, 'Start Board.bat')], { cwd: folder, env, encoding: 'utf8', windowsVerbatimArguments: false })
    assert.equal(existsSync(marker), false, 'the planted node in the board folder was run')
    const resolved = run.stdout.trim().split(/\r?\n/).pop().trim()
    assert.ok(resolved.toLowerCase().endsWith('node.exe') || resolved.toLowerCase().endsWith('node.cmd'), `resolved "${resolved}"`)
    assert.ok(!resolved.toLowerCase().startsWith(folder.toLowerCase()), 'the program found was the one in the board folder')
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

// An absolute path to a real bash (Git Bash on Windows, never the WSL stub in System32), or null.
function findBash() {
  const found = process.platform === 'win32'
    ? spawnSync(join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'where.exe'), ['bash'], { encoding: 'utf8' }).stdout
    : spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout
  return String(found).split(String.fromCharCode(10)).map((line) => line.trim()).find((line) => line && !/system32/i.test(line)) ?? null
}

test('start file for Mac: says plainly when Node is missing, and never runs anything from the current folder', { skip: !findBash() }, () => {
  const folder = mkdtempSync(join(tmpdir(), 'board-mac-'))
  try {
    const script = join(folder, 'Start Board.command')
    writeFileSync(script, readFileSync(join(ROOT, 'Start Board.command')))
    const bash = findBash()
    const run = spawnSync(bash, [script], { cwd: folder, encoding: 'utf8', input: '', env: { PATH: '/nonexistent', HOME: folder, BOARD_NO_OPEN: '1' } })
    assert.equal(run.status, 1)
    assert.match(run.stdout + run.stderr, /Node/)
    assert.match(run.stdout + run.stderr, /nodejs\.org/)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

// ---- a board that answers with something that is not our link ---------------------------------------------

test('start: a link that does not point back to the board that was asked is not opened', async () => {
  await withStarter(async ({ start, stateDir, opened }) => {
    const first = await start()
    const secret = readRunning(stateDir).secret
    // Even with a correct proof for it, a link that points somewhere else is not opened.
    const lying = async (url, init) => {
      const link = 'http://evil.example/steal'
      return new Response(JSON.stringify({ link, proof: answerCode(secret, init.headers['x-starter-nonce'], link) }), { status: 200 })
    }
    const second = await start({ fetchImpl: lying })
    assert.equal(second.mode, 'started', 'a foreign link must not be trusted; a real board is started instead')
    assert.notEqual(second.port, first.port)
    assert.ok(opened.every((entry) => !entry.text.includes('evil.example')))
    assert.ok(secret)
  })
})

test('start: a link with quotes or tags in it cannot break out of the launcher page', async () => {
  await withStarter(async ({ start, stateDir, opened }) => {
    const first = await start()
    const nasty = `http://127.0.0.1:${first.port}/open-board?t=a"><img src=x onerror=alert(1)><script>alert(2)</script>`
    const secret = readRunning(stateDir).secret
    const second = await start({ fetchImpl: async (url, init) => new Response(JSON.stringify({ link: nasty, proof: answerCode(secret, init.headers['x-starter-nonce'], nasty) }), { status: 200 }) })
    assert.equal(second.mode, 'reopened')
    const html = opened.at(-1).text
    assert.ok(!html.includes('"><img'), 'a quote closed the attribute')
    assert.ok(!html.includes('<script>alert(2)'), 'a tag from the link ran as a tag')
    assert.ok(stateDir)
  })
})

test('state file: a port outside 1-65535 is refused even with a long secret', async () => {
  await withStarter(async ({ stateDir }) => {
    mkdirSync(stateDir, { recursive: true })
    for (const port of [0, -1, 65536, 99999, 1.5]) {
      writeFileSync(join(stateDir, 'running.json'), JSON.stringify({ port, secret: 'z'.repeat(40) }))
      assert.equal(readRunning(stateDir), null, `port ${port}`)
    }
    writeFileSync(join(stateDir, 'running.json'), JSON.stringify({ port: 4317, secret: 'z'.repeat(40) }))
    assert.deepEqual(readRunning(stateDir), { port: 4317, secret: 'z'.repeat(40) })
  })
})

// ---- the state folder is for the current user only (Windows) --------------------------------------------

import { lockToCurrentUser } from '../local/start.mjs'
import { execFileSync } from 'node:child_process'
import { userInfo } from 'node:os'

test('private folder: icacls is run by its full path from System32, without a shell, for the current user only', () => {
  const calls = []
  const state = String.raw`C:\Users\a\AppData\Local\Agent Board\state`
  lockToCurrentUser(state, { platform: 'win32', env: { SystemRoot: String.raw`C:\Windows` }, user: 'a', run: (...args) => calls.push(args) })
  assert.equal(calls.length, 1)
  const [program, args, options] = calls[0]
  assert.equal(program, String.raw`C:\Windows\System32\icacls.exe`)
  assert.deepEqual(args, [state, '/inheritance:r', '/grant:r', 'a:(OI)(CI)F'])
  assert.equal(options.shell, undefined)
  assert.equal(options.cwd, String.raw`C:\Windows\System32`)
  assert.equal(options.env.NoDefaultCurrentDirectoryInExePath, '1')
})

test('private folder: icacls is given a short environment with no key in it - not the board\'s whole one', () => {
  const calls = []
  // The board's own environment holds keys (its .env, and whatever the computer has set). Git Bash hands names on in other
  // spellings (SYSTEMROOT, Path), so each is found whatever its case.
  const env = {
    SYSTEMROOT: String.raw`C:\Windows`, windir: String.raw`C:\Windows`, Path: String.raw`C:\Windows\System32;C:\bin`, ComSpec: String.raw`C:\Windows\System32\cmd.exe`,
    OPENAI_API_KEY: 'sk-test', GITHUB_TOKEN: 'ghp_test', ANTHROPIC_API_KEY: 'sk-ant-test', MAILBOX_SECRET: 's'.repeat(40), MAILBOX_KEY: 'k'.repeat(40),
    FIRE_KEY: 'f', VIEW_KEY: 'v', BOARD_PASSWORD: 'p', AWS_SECRET_ACCESS_KEY: 'a', BLOB_READ_WRITE_TOKEN: 'b', USERPROFILE: String.raw`C:\Users\a`, USERDOMAIN: 'MYPC'
  }
  lockToCurrentUser(String.raw`C:\s`, { platform: 'win32', env, user: 'a', run: (...args) => calls.push(args) })
  assert.equal(calls.length, 1)
  const [program, , options] = calls[0]
  assert.equal(program, String.raw`C:\Windows\System32\icacls.exe`, 'SystemRoot found whatever its spelling')
  assert.deepEqual(options.env, {
    SystemRoot: String.raw`C:\Windows`, windir: String.raw`C:\Windows`, PATH: String.raw`C:\Windows\System32;C:\bin`, ComSpec: String.raw`C:\Windows\System32\cmd.exe`,
    NoDefaultCurrentDirectoryInExePath: '1'
  })
  for (const name of Object.keys(options.env)) assert.doesNotMatch(name, /KEY|SECRET|TOKEN|PASSWORD/i, `icacls saw ${name}`)
  assert.equal(calls[0][1][3], String.raw`MYPC\a:(OI)(CI)F`, 'the domain still comes from the board\'s environment')
})

test('private folder: nothing is run off Windows, a missing SystemRoot is refused, and a failure says so plainly', () => {
  let ran = false
  lockToCurrentUser('/x', { platform: 'linux', env: {}, user: 'a', run: () => { ran = true } })
  assert.equal(ran, false)
  assert.throws(() => lockToCurrentUser('x', { platform: 'win32', env: {}, user: 'a', run: () => {} }), /SystemRoot/)
  assert.throws(() => lockToCurrentUser('x', { platform: 'win32', env: { SystemRoot: String.raw`C:\Windows` }, user: 'a', run: () => { throw new Error('access denied') } }), /could not make its folder private/)
})

test('private folder: on this Windows PC the started board\'s state folder is open to the current user alone', { skip: process.platform !== 'win32' }, async () => {
  await withStarter(async ({ start, stateDir }) => {
    await start()
    const system = join(process.env.SystemRoot, 'System32')
    const shown = execFileSync(join(system, 'icacls.exe'), [stateDir], { encoding: 'utf8', cwd: system })
    const who = shown.split(/\r?\n/).map((line) => line.replace(stateDir, '').trim()).filter((line) => /:\(/.test(line))
    assert.ok(who.length >= 1, shown)
    for (const line of who) assert.ok(line.toLowerCase().includes(userInfo().username.toLowerCase()), `someone else can open the folder: ${line}\n${shown}`)
    assert.doesNotMatch(shown, /Everyone|Users:|Authenticated Users|CodexSandbox|SYSTEM|Administrators/i)
    assert.ok(readRunning(stateDir), 'the board still works for its owner')
  })
})

// ---- round 3 ------------------------------------------------------------------------------------------

import { OPENED_SAY } from '../local/start.mjs'

test('private folder: the grant names DOMAIN\\user, so a same-named account elsewhere is not the one let in', () => {
  const calls = []
  lockToCurrentUser(String.raw`C:\s`, { platform: 'win32', env: { SystemRoot: String.raw`C:\Windows`, USERDOMAIN: 'MYPC' }, user: 'nuno', run: (...args) => calls.push(args) })
  assert.equal(calls[0][1][3], String.raw`MYPC\nuno:(OI)(CI)F`)
  const other = []
  lockToCurrentUser(String.raw`C:\s`, { platform: 'win32', env: { SystemRoot: String.raw`C:\Windows` }, user: 'nuno', domain: 'CORP', run: (...args) => other.push(args) })
  assert.equal(other[0][1][3], String.raw`CORP\nuno:(OI)(CI)F`)
})

test('start window: says in plain words where to look, short, for a first start and a second double-click', async () => {
  await withStarter(async ({ start, logged }) => {
    await start()
    await start()
    const lines = logged.filter((line) => line === OPENED_SAY)
    assert.equal(lines.length, 2, logged.join('\n'))
    assert.equal(OPENED_SAY, "The board opened in your browser. If you don't see it, look in your other browser windows.")
    assert.ok(logged.every((line) => line.length < 120), 'a line in the Start window is too long to read at a glance')
  })
})

test('files: .gitignore keeps board.json (this computer\'s team folder) out of commits', () => {
  assert.match(readFileSync(join(ROOT, '.gitignore'), 'utf8'), /^board\.json\s*$/m)
})

// ---- the browser the starter opens does not inherit the board's secrets ----------------------------------

test('opening the browser: it is given a short allowlist of the environment, never a key, token or board setting', () => {
  const source = {
    SystemRoot: String.raw`C:\Windows`, windir: String.raw`C:\Windows`, USERPROFILE: String.raw`C:\Users\a`, LOCALAPPDATA: 'l', APPDATA: 'a', TEMP: 't', TMP: 't', PATH: 'p', HOME: '/home/a', LANG: 'en_US.UTF-8', LC_ALL: 'C', DISPLAY: ':0', XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x',
    OPENAI_API_KEY: 'sk-secret', VIEW_KEY: 'view-secret', PUBLIC_FIRE: 'true', FISH_API_KEY: 'f', OPENROUTER_API_KEY: 'o', GITHUB_TOKEN: 'g', ANTHROPIC_API_KEY: 'a', MAILBOX_SECRET: 'm', N8N_API_KEY: 'n', HASS_TOKEN: 'h', REPO_FOLDER: '/team', PICTURE_FOLDER: '/pics', BOARD_PASSWORD: 'p', EDIT_KEY: 'e', RANDOM_SECRET: 'r', NODE_OPTIONS: '--require /evil.js', ELECTRON_RUN_AS_NODE: '1'
  }
  for (const platform of ['win32', 'darwin', 'linux']) {
    const opener = openerFor({ platform, env: source, file: '/tmp/x.html' })
    const names = Object.keys(opener.env)
    for (const secret of ['OPENAI_API_KEY', 'VIEW_KEY', 'PUBLIC_FIRE', 'FISH_API_KEY', 'OPENROUTER_API_KEY', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'MAILBOX_SECRET', 'N8N_API_KEY', 'HASS_TOKEN', 'REPO_FOLDER', 'PICTURE_FOLDER', 'BOARD_PASSWORD', 'EDIT_KEY', 'RANDOM_SECRET', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) {
      assert.ok(!names.includes(secret), `${secret} reached the browser on ${platform}`)
    }
    assert.ok(!JSON.stringify(opener.env).includes('secret'), 'a secret value reached the browser')
    for (const needed of ['PATH', 'HOME', 'LANG']) assert.ok(names.includes(needed), `${needed} was dropped on ${platform}`)
  }
  const win = openerFor({ platform: 'win32', env: source, file: 'x' })
  for (const needed of ['SystemRoot', 'windir', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP']) assert.ok(needed in win.env, `${needed} was dropped`)
  assert.equal(win.env.NoDefaultCurrentDirectoryInExePath, '1')
  const linux = openerFor({ platform: 'linux', env: source, file: 'x' })
  for (const needed of ['DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) assert.ok(needed in linux.env, `${needed} (a Linux browser needs it) was dropped`)
})
