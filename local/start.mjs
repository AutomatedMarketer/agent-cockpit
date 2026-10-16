// What "Start Board" runs: bring the board up (or, if it is already up, get a fresh link from it),
// and open the browser on the one-time link.
//
// How the link reaches the browser without being on a command line: the starter writes a tiny
// private HTML file that forwards the browser to the link, and asks the operating system to open
// THAT FILE. The program list of the computer shows only the file's path. The file lives in the
// user's own state folder, is readable by that user only (on Mac/Linux; Windows keeps the profile
// private by default), and is deleted a few seconds later. Chosen over putting the link in the
// command (visible to every user of the computer in the process list) and over a page served by
// the board (its address would need a second secret on a command line).
//
// The link is never printed, logged or kept in the state file. If the browser does not open, the
// message says to double-click Start Board again for a new one.
//
// Every program started here is an absolute path, from a neutral folder, never through a shell.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startLocalBoard } from './server.mjs'
import { OPEN_PATH, STARTER_PATH } from './gate.mjs'

export const BASE_PORT = 4317
export const PORT_TRIES = 10
const LINGER_MS = 15_000
const STATE_FILE = 'running.json'

// ---- where things live ---------------------------------------------------------------------------------

export function stateDirFor({ platform, env, home }) {
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Agent Board', 'state')
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Agent Board', 'state')
  return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'agent-board')
}

function privateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  try { chmodSync(path, 0o700) } catch { /* Windows: the profile is already private */ }
}

// Written to a temp name and renamed, so a reader never sees half a file.
function writePrivateFile(path, text) {
  const temp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temp, text, { mode: 0o600 })
  renameSync(temp, path)
}

export function readRunning(stateDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, STATE_FILE), 'utf8'))
    if (!parsed || !Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535) return null
    if (typeof parsed.secret !== 'string' || parsed.secret.length < 32) return null
    return { port: parsed.port, secret: parsed.secret }
  } catch {
    return null
  }
}

// ---- opening the browser -------------------------------------------------------------------------------

export function openerFor({ platform, env, file }) {
  if (platform === 'win32') {
    if (!env.SystemRoot) throw new Error('SystemRoot is not set, so the browser cannot be opened safely.')
    const system = `${env.SystemRoot}\\System32`
    return {
      command: `${system}\\rundll32.exe`,
      args: ['url.dll,FileProtocolHandler', file],
      cwd: system,
      env: { ...env, NoDefaultCurrentDirectoryInExePath: '1' }
    }
  }
  return { command: platform === 'darwin' ? '/usr/bin/open' : '/usr/bin/xdg-open', args: [file], cwd: '/', env }
}

export async function openFileWith({ platform = process.platform, env = process.env, file, spawnImpl = spawn }) {
  const opener = openerFor({ platform, env, file })
  const child = spawnImpl(opener.command, opener.args, { cwd: opener.cwd, env: opener.env, detached: true, stdio: 'ignore', windowsHide: true })
  child.on?.('error', () => {}) // no browser to open: the message tells the person what to do
  child.unref()
}

const htmlEscape = (text) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

function launcherHtml(link) {
  const safe = htmlEscape(link)
  return `<!doctype html><meta charset="utf-8"><title>Opening the board</title>` +
    `<meta http-equiv="refresh" content="0;url=${safe}"><body style="font:16px system-ui;padding:2em">Opening the board...</body>` +
    `<script>location.replace(${JSON.stringify(link).replace(/</g, '\\u003c')})</script>\n`
}

// Writes the launcher, opens it, deletes it after lingerMs. Resolves once it is gone.
async function openLink({ link, stateDir, openFile, lingerMs }) {
  const folder = join(stateDir, 'launch')
  privateDir(folder)
  for (const old of readdirSync(folder)) { try { unlinkSync(join(folder, old)) } catch { /* in use */ } } // anything left by a crash
  const file = join(folder, `launch-${randomBytes(6).toString('hex')}.html`)
  writeFileSync(file, launcherHtml(link), { mode: 0o600 })
  try {
    await openFile(file)
    await new Promise((done) => setTimeout(done, lingerMs))
  } finally {
    rmSync(file, { force: true })
  }
}

// ---- ports ----------------------------------------------------------------------------------------------

// Tries `base`, `base + 1`, ... and returns the first one `attempt` accepts. Only "port in use" and
// "not allowed" move on: Windows keeps ranges of ports for itself (Hyper-V, WSL) and refuses them
// with EACCES, which for the student is the same as busy.
export async function pickPort(base, tries, attempt) {
  for (let offset = 0; offset < tries; offset += 1) {
    try {
      return await attempt(base + offset)
    } catch (failure) {
      if (failure?.code !== 'EADDRINUSE' && failure?.code !== 'EACCES') throw failure
    }
  }
  throw new Error(`Every port from ${base} to ${base + tries - 1} is busy or not allowed. Close other programs that may be using them and try again (ports ${base} to ${base + tries - 1}).`)
}

// ---- the start ------------------------------------------------------------------------------------------

async function askRunningBoard({ stateDir, fetchImpl }) {
  const running = readRunning(stateDir)
  if (!running) return null
  try {
    const answer = await fetchImpl(`http://127.0.0.1:${running.port}${STARTER_PATH}`, {
      method: 'POST',
      headers: { 'x-starter-secret': running.secret },
      signal: AbortSignal.timeout(3000)
    })
    if (answer.status !== 200) return null
    const { link } = await answer.json()
    // Whatever answered must hand back a link to the same place, or it is not our board.
    if (typeof link !== 'string' || !link.startsWith(`http://127.0.0.1:${running.port}${OPEN_PATH}?t=`)) return null
    return { link, port: running.port }
  } catch {
    return null
  }
}

export async function runStart({
  platform = process.platform,
  env = process.env,
  home = homedir(),
  stateDir = stateDirFor({ platform, env, home }),
  basePort = BASE_PORT,
  tries = PORT_TRIES,
  startBoard = startLocalBoard,
  fetchImpl = fetch,
  openFile = (file) => openFileWith({ platform, env, file }),
  lingerMs = LINGER_MS,
  log = console.log
} = {}) {
  privateDir(stateDir)

  const already = await askRunningBoard({ stateDir, fetchImpl })
  if (already) {
    await openLink({ link: already.link, stateDir, openFile, lingerMs })
    log('The board is already running. A new browser tab was opened for it.')
    return { mode: 'reopened', port: already.port }
  }
  rmSync(join(stateDir, STATE_FILE), { force: true }) // a board that is gone, or not ours

  const board = await pickPort(basePort, tries, (port) => startBoard({ port }))
  const stateFile = join(stateDir, STATE_FILE)
  writePrivateFile(stateFile, JSON.stringify({ port: board.port, secret: board.starterSecret, startedAt: new Date().toISOString() }))

  const close = async () => {
    const mine = readRunning(stateDir)
    if (mine && mine.secret === board.starterSecret) rmSync(stateFile, { force: true })
    await new Promise((done) => { board.server.close(done); board.server.closeAllConnections?.() })
  }

  await openLink({ link: board.openLink(), stateDir, openFile, lingerMs })
  log(`The board is running on this computer (port ${board.port}) and should be open in your browser.`)
  log('If it did not open, close this window and double-click Start Board again. Keep this window open while you use the board.')
  return { mode: 'started', port: board.port, server: board.server, close }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const board = await runStart()
    if (board.mode === 'started') {
      const stop = () => board.close().finally(() => process.exit(0))
      process.on('SIGINT', stop)
      process.on('SIGTERM', stop)
      process.on('SIGHUP', stop)
      process.on('uncaughtException', (failure) => console.error(`[board] unexpected error, still running: ${failure?.message ?? failure}`))
      process.on('unhandledRejection', (failure) => console.error(`[board] unexpected error, still running: ${failure?.message ?? failure}`))
    }
  } catch (failure) {
    console.error(failure.message)
    process.exit(1)
  }
}
