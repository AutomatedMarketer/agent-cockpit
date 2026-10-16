// The start files of the board on this computer (Student Edition, task T5): what can be checked from
// node. What only a double-click can show is listed in local/README.md ("Only a double-click proves").

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, rmSync, statSync, readdirSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { spawnSync } from 'node:child_process'
import { runStart, stateDirFor, openerFor, pickPort, readRunning } from '../local/start.mjs'
import { createRequire } from 'node:module'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const { nodeIsNewEnough, MIN_MAJOR } = require('../local/check-node.cjs')

const ENV_KEYS = ['VIEW_KEY', 'PUBLIC_FIRE', 'PUBLIC_DASHBOARD', 'EDIT_KEY', 'BOARD_PASSWORD', 'BOARD_USERNAME']

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
    assert.equal(first.status, 303)
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
    assert.equal((await fetch(two, { redirect: 'manual' })).status, 303, 'the fresh link should work')
    assert.equal((await fetch(one, { redirect: 'manual' })).status, 303, 'the first link was not used yet, so it still works too')
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

test('starter endpoint: needs the run\'s secret, POST only, refuses a browser, and sets no cookie', async () => {
  await withStarter(async ({ start, stateDir }) => {
    const { port } = await start()
    const secret = readRunning(stateDir).secret
    const url = `http://127.0.0.1:${port}/starter/open-link`
    const ask = (init) => fetch(url, { method: 'POST', redirect: 'manual', ...init })
    assert.equal((await ask({ headers: { 'x-starter-secret': secret } })).status, 200)
    for (const headers of [{}, { 'x-starter-secret': 'wrong' }, { 'x-starter-secret': secret.slice(0, -1) }, { 'x-starter-secret': secret + 'x' }, { 'x-starter-secret': '' }]) {
      const answer = await ask({ headers })
      assert.equal(answer.status, 403, JSON.stringify(headers))
      assert.doesNotMatch(await answer.text(), /open-board/)
    }
    assert.equal((await fetch(url, { headers: { 'x-starter-secret': secret } })).status, 401, 'a GET is not an ask')
    for (const site of ['same-site', 'cross-site', 'same-origin']) {
      const answer = await ask({ headers: { 'x-starter-secret': secret, 'Sec-Fetch-Site': site, Origin: 'https://evil.example' } })
      assert.equal(answer.status, 403, `a browser call (${site}) with the secret was answered`)
    }
    const good = await ask({ headers: { 'x-starter-secret': secret } })
    assert.equal(good.headers.get('set-cookie'), null)
    assert.equal(good.headers.get('cache-control'), 'no-store')
  })
})

test('starter endpoint: a wrong Host is refused before anything', async () => {
  await withStarter(async ({ start, stateDir }) => {
    const { port } = await start()
    const secret = readRunning(stateDir).secret
    const answer = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write(`POST /starter/open-link HTTP/1.1\r\nHost: evil.example\r\nx-starter-secret: ${secret}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`))
      let text = ''
      socket.on('data', (data) => { text += data })
      socket.on('close', () => resolve(text))
      socket.on('error', () => resolve(text))
    })
    assert.match(answer, /^HTTP\/1\.1 421/)
    assert.doesNotMatch(answer, /open-board/)
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
    const lying = async () => new Response(JSON.stringify({ link: 'http://evil.example/steal' }), { status: 200 })
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
    const second = await start({ fetchImpl: async () => new Response(JSON.stringify({ link: nasty }), { status: 200 }) })
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
