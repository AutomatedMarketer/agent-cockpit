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

import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, isAbsolute, join, win32 } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startLocalBoard } from './server.mjs'
import { OPEN_PATH, STARTER_PATH } from './gate.mjs'
import { answerCode, askCode, codesMatch } from './starter-auth.mjs'

// Short and plain. The operating system opens the LAST-USED browser profile, which may not be the window the student is looking at.
export const OPENED_SAY = "The board opened in your browser. If you don't see it, look in your other browser windows."
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

// Windows has no file modes. A folder under the user's profile usually inherits access for other
// accounts (a sandbox user, a service), so the state folder is cut off from what it inherits and
// given to the current user only. icacls by its full path, from System32, no shell.
export function lockToCurrentUser(path, { platform = process.platform, env = process.env, user = userInfo().username, domain = env.USERDOMAIN, run = execFileSync } = {}) {
  if (platform !== 'win32') return
  if (!env.SystemRoot) throw new Error('SystemRoot is not set, so the board cannot make its folder private.')
  const system = win32.join(env.SystemRoot, 'System32')
  try {
    run(win32.join(system, 'icacls.exe'), [path, '/inheritance:r', '/grant:r', `${domain ? `${domain}${String.fromCharCode(92)}${user}` : user}:(OI)(CI)F`], { cwd: system, env: { ...env, NoDefaultCurrentDirectoryInExePath: '1' }, stdio: 'ignore', windowsHide: true })
  } catch {
    throw new Error(`The board could not make its folder private to you (${path}). Run it from your own Windows account and try again.`)
  }
}

function privateDir(path, { lock = false } = {}) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  try { chmodSync(path, 0o700) } catch { /* Windows: see lockToCurrentUser */ }
  if (lock) lockToCurrentUser(path)
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

// ---- what the board reads and keeps ------------------------------------------------------------------

// Pictures live inside the user's own state folder (private to them).
export const picturesDirFor = (stateDir) => join(stateDir, 'pictures')

// Where the team repo is on this computer, or { folder: null, why } saying what to do. In order:
// board.json next to the starter, board.json in the state folder, or - when the board sits inside
// the team folder - the folder above it. board.json looks like { "teamFolder": "C:\Users\me\my-team" }.
// Two slashes of either kind at the start - \server, //server, \/server, /\server, the \?\ forms - are a network
// or device path, and touching one can send the student's sign-in to a server. Checked before the disk is.
const isSlash = (character) => character === '/' || character === String.fromCharCode(92)
export const isNetworkPath = (path) => path.length >= 2 && isSlash(path[0]) && isSlash(path[1])

export function resolveTeamFolder({ boardDir, stateDir }) {
  const ask = 'Tell the board where your team folder is: make a file called board.json next to Start Board, containing {"teamFolder": "the full path of your team folder"}.'
  const check = (candidate, source) => {
    if (typeof candidate === 'string' && isNetworkPath(candidate)) return { folder: null, why: `${source}: a network folder (${candidate.slice(0, 2)}...) is not allowed; use a folder on this computer. ${ask}` }
    if (typeof candidate !== 'string' || !isAbsolute(candidate)) return { folder: null, why: `${source}: teamFolder must be the full path of a folder. ${ask}` }
    let real
    try {
      real = realpathSync(candidate)
      if (!statSync(real).isDirectory()) throw new Error('not a folder')
    } catch {
      return { folder: null, why: `${source}: the team folder ${candidate} does not exist or is not a folder. ${ask}` }
    }
    try {
      statSync(join(real, '.git'))
    } catch {
      return { folder: null, why: `${source}: ${candidate} is not a git clone of your team repo (it has no .git). ${ask}` }
    }
    return { folder: real }
  }
  for (const [dir, source] of [[boardDir, 'board.json next to Start Board'], [stateDir, 'board.json in the state folder']]) {
    let text
    try {
      text = readFileSync(join(dir, 'board.json'), 'utf8')
    } catch {
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return { folder: null, why: `${source} is not valid JSON. ${ask}` }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('teamFolder' in parsed)) return { folder: null, why: `${source} has no teamFolder. ${ask}` }
    return check(parsed.teamFolder, source)
  }
  const parent = dirname(boardDir)
  try {
    statSync(join(parent, '.git'))
    return check(parent, 'the folder above the board')
  } catch {
    return { folder: null, why: `I could not find your team folder. ${ask}` }
  }
}

// The settings the board's handlers read, set so a student's board uses the folder modes: the team
// repo is read with git from their own clone, and pictures are kept in a folder - no GitHub token,
// no Vercel. Replaces whatever the computer already had under these names.
export function applyStudentEnv(env, { teamFolder, pictureFolder }) {
  env.REPO_SOURCE = 'folder'
  env.REPO_FOLDER = teamFolder
  env.PICTURE_STORE = 'folder'
  env.PICTURE_FOLDER = pictureFolder
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
    // The secret itself is never sent: only a code made from it, over a fresh nonce and the time.
    const nonce = randomBytes(16).toString('hex')
    const time = String(Date.now())
    const answer = await fetchImpl(`http://127.0.0.1:${running.port}${STARTER_PATH}`, {
      method: 'POST',
      headers: { 'x-starter-time': time, 'x-starter-nonce': nonce, 'x-starter-code': askCode(running.secret, time, nonce) },
      signal: AbortSignal.timeout(3000)
    })
    if (answer.status !== 200) return null
    const { link, proof } = await answer.json()
    // Whatever answered must hand back a link to the same place, and prove it knows the secret by a
    // code over THIS nonce and THIS link - a different program that took over the port cannot.
    if (typeof link !== 'string' || !link.startsWith(`http://127.0.0.1:${running.port}${OPEN_PATH}?t=`)) return null
    if (!codesMatch(proof, answerCode(running.secret, nonce, link))) return null
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
  log = console.log,
  boardDir = join(dirname(fileURLToPath(import.meta.url)), '..'),
  teamFolder, // undefined: leave the settings alone (tests); null: not found, so stop; a path: use it
  teamFolderWhy = 'I could not find your team folder.'
} = {}) {
  privateDir(stateDir, { lock: true })

  const already = await askRunningBoard({ stateDir, fetchImpl })
  if (already) {
    await openLink({ link: already.link, stateDir, openFile, lingerMs })
    log(OPENED_SAY)
    return { mode: 'reopened', port: already.port }
  }
  rmSync(join(stateDir, STATE_FILE), { force: true }) // a board that is gone, or not ours
  if (teamFolder === null) throw new Error(teamFolderWhy)

  if (teamFolder) {
    const pictureFolder = picturesDirFor(stateDir)
    privateDir(pictureFolder)
    applyStudentEnv(process.env, { teamFolder, pictureFolder })
  }
  const board = await pickPort(basePort, tries, (port) => startBoard({ port }))
  const stateFile = join(stateDir, STATE_FILE)
  writePrivateFile(stateFile, JSON.stringify({ port: board.port, secret: board.starterSecret, startedAt: new Date().toISOString() }))

  const close = async () => {
    const mine = readRunning(stateDir)
    if (mine && mine.secret === board.starterSecret) rmSync(stateFile, { force: true })
    await new Promise((done) => { board.server.close(done); board.server.closeAllConnections?.() })
  }

  await openLink({ link: board.openLink(), stateDir, openFile, lingerMs })
  log(OPENED_SAY)
  log('Keep this window open while you use the board. Close it to stop the board.')
  return { mode: 'started', port: board.port, server: board.server, close }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const boardDir = join(dirname(fileURLToPath(import.meta.url)), '..')
    const stateDir = stateDirFor({ platform: process.platform, env: process.env, home: homedir() })
    const found = resolveTeamFolder({ boardDir, stateDir })
    const board = await runStart({ boardDir, stateDir, teamFolder: found.folder, teamFolderWhy: found.why })
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
