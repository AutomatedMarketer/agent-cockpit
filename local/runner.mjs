// Jobs on this computer (Student Edition, task T8): the team's own mailbox runner, run INSIDE the board's
// process and kicked on each order, instead of on a Mac every five minutes.
//
// What happens when a student presses Run (plan 2026-10-16-student-edition-local-board, 2.4):
//   1. /api/fire checks the order exactly as it does on the website and, in mailbox mode, signs it and keeps it
//      in the board's queue (the picture folder). The board never writes the team repo.
//   2. Right after that answer, the board asks its runner for one tick (`--once`). A tick every five minutes
//      settles anything left over; the runner's own lock keeps it to one tick at a time.
//   3. The runner asks "the board" for its orders. Its board address is https://this-computer.invalid, a name
//      that can never resolve on any network, and the fetch it is handed answers ONLY that address, by calling
//      the real api/mailbox.js handler in this process. So the runner's own poll code, the board's own key check
//      and the real signed orders all run, and nothing new decides who is trusted.
//   4. Everything else is the runner's, unchanged: its allowlist, day limits, claims, the walls round Claude
//      (no shell, no connectors, file tools only in its own work copy), the checked commit, the lease push.
//      The status file it pushes reaches the board through git like every other file.
//
// The runner's code is the student's own team repo, cloned once at one commit into `runner-code` (never the team
// folder itself): code that runs with the student's login is never chosen by whatever lands in the repo.
//
// Every program is started by its absolute path from a folder nobody else writes to, with a short list of
// environment variables: never the board's keys, its per-run key or the mailbox secrets.

import { execFile, spawn as realSpawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { findGit, gitEnvironment, githubNames, isInside, refreshNow, runGit } from '../api/_repo.js'
import { mailboxConfig } from '../api/_mailbox.js'
import mailboxHandler from '../api/mailbox.js'
import { shimResponse } from './vercel-shim.mjs'

export const LOCAL_BOARD_ORIGIN = 'https://this-computer.invalid'
export const LOCAL_RUNNER = 'this-computer'
export const LOCAL_COMPUTER = 'This computer'
export const TICK_EVERY_MS = 5 * 60_000
// How often the runner is told to ask. The kick on each order does the real work; this only sets how long an
// order may wait (three of these and two minutes, at least fifteen minutes - api/_mailbox.js orderLifeSeconds).
export const POLL_SECONDS = 300
const RUNNER_ENTRY = ['scripts', 'lib', 'mailbox', 'command.mjs']
const GIT_TIMEOUT_MS = 120_000
const GIT_MAX_BUFFER = 16 * 1024 * 1024
// The minutes each job may run, at most (the runner's own ceiling is 30).
const JOB_MINUTES = { 'morning-intel': 20 }
const DEFAULT_JOB_MINUTES = 30

// The settings this file turns on, and every other setting that could send an order somewhere else. A student's
// computer may have any of these set already; none of them may decide what the local board does.
export const MAILBOX_NAMES = Object.freeze(['FIRE_MODE', 'FIRE_TRIGGERS', 'FIRE_KEY', 'MAILBOX_KEY', 'MAILBOX_SECRET', 'MAILBOX_SECRET_ID', 'MAILBOX_RUNNER', 'MAILBOX_POLL_SECONDS'])

export const SAY = Object.freeze({
  notGitHub: 'Jobs are off: the team folder is not on GitHub, so the board cannot send it orders.',
  noCode: 'Jobs are off: the runner code is not installed next to the board (the runner-code folder). Ask Claude to set up jobs on this computer.',
  badPlaces: 'Jobs are off: the board\'s folders overlap the team folder. Ask Claude to set up jobs on this computer again.',
  badFiles: 'Jobs are off: the runner\'s settings could not be written or read. Ask Claude to set up jobs on this computer again.',
  noWork: 'Jobs: the runner\'s own copy of the team repo could not be made yet. The board tries again at the next start.',
  on: 'Jobs are on: orders from the board run on this computer while this window is open.'
})

// ---- where things live ------------------------------------------------------------------------------------

const absoluteOr = (value, fallback, isAbsolute) => (typeof value === 'string' && isAbsolute(value) ? value : fallback)

// The runner's own clone of the team repo: next to the board's state folder, never inside it or the team folder.
export function workDirFor({ platform, env = {}, home }) {
  if (platform === 'win32') {
    const local = absoluteOr(env.LOCALAPPDATA, path.win32.join(home, 'AppData', 'Local'), path.win32.isAbsolute)
    return path.win32.join(local, 'Agent Board', 'work')
  }
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'Agent Board', 'work')
  return path.posix.join(absoluteOr(env.XDG_DATA_HOME, path.posix.join(home, '.local', 'share'), path.posix.isAbsolute), 'agent-board', 'work')
}

// The runner's four places (its places.mjs): state and secrets in their own folder inside the board's locked
// state folder - not the state folder itself, because the runner's Windows lock reads every file of its folder
// on every tick and the board writes pictures there all the time - the work copy beside it, and the code in the
// board's own folder.
export function runnerPlacesFor({ boardDir, stateDir, platform = process.platform, env = process.env, home = os.homedir() }) {
  const runnerState = path.join(stateDir, 'runner')
  return {
    stateDir: runnerState,
    envFile: path.join(runnerState, 'runner.env'),
    workDir: workDirFor({ platform, env, home }),
    codeDir: path.join(boardDir, 'runner-code')
  }
}

const exists = async (file) => {
  try {
    await lstat(file)
    return true
  } catch {
    return false
  }
}

// null when the code folder may be run from, else a word: a full path, not inside the team folder and not holding
// it, a real folder (not a link), with the file `entry` in it.
export async function codeProblem(codeDir, { teamFolder, entry = RUNNER_ENTRY }) {
  if (typeof codeDir !== 'string' || !path.isAbsolute(codeDir)) return 'path'
  if (isInside(teamFolder, codeDir) || isInside(codeDir, teamFolder)) return 'team-folder'
  try {
    if (!(await lstat(codeDir)).isDirectory()) return 'no-code'
    if (!(await stat(path.join(codeDir, ...entry))).isFile()) return 'no-code'
  } catch {
    return 'no-code'
  }
  return null
}

// null when the places are fit to use, else a word. On top of the runner's own check (none inside another, done
// on every tick): every one is a full path, none is inside the team folder or holds it, and the code folder is a
// real folder (not a link) that holds the runner.
export async function placesProblem(places, { teamFolder }) {
  for (const name of ['stateDir', 'envFile', 'workDir', 'codeDir']) {
    if (typeof places?.[name] !== 'string' || !path.isAbsolute(places[name])) return 'path'
  }
  for (const name of ['stateDir', 'workDir']) {
    if (isInside(teamFolder, places[name]) || isInside(places[name], teamFolder)) return 'team-folder'
  }
  return codeProblem(places.codeDir, { teamFolder })
}

// ---- the runner's settings, written once ----------------------------------------------------------------

// 64 hex digits: printable, long, and no run of letters any placeholder check could take for a placeholder.
const freshSecret = () => randomBytes(32).toString('hex')

export function allowlistText({ repo, jobs }) {
  return [
    '# Written by the board on this computer (Agent Board). Orders come only from the board in the same program.',
    `board: ${LOCAL_BOARD_ORIGIN}`,
    `repo: ${repo}`,
    `runner: ${LOCAL_RUNNER}`,
    `computer: ${LOCAL_COMPUTER}`,
    'actions: [task, move, approve, pause, run, arm, skill, agent]',
    'jobs:',
    ...jobs.flatMap((slug) => [`  - slug: ${slug}`, `    minutes: ${JOB_MINUTES[slug] ?? DEFAULT_JOB_MINUTES}`]),
    'per_day:',
    '  orders: 40',
    '  runs: 6',
    ''
  ].join('\n')
}

// A new file, never over an old one: what the student (or Claude) has put there is kept.
async function writeOnce(file, text) {
  try {
    await writeFile(file, text, { flag: 'wx', mode: 0o600 })
    return true
  } catch (failure) {
    if (failure?.code === 'EEXIST') return false
    throw failure
  }
}

// Makes the runner's state folder (private), its secrets file and its allowlist, each only if it is not there.
// The student never sees or types any of it.
export async function ensureRunnerFiles({ places, repo, jobs, platform = process.platform }) {
  await mkdir(places.stateDir, { recursive: true, mode: 0o700 })
  if (platform !== 'win32') await chmod(places.stateDir, 0o700)
  const madeSecrets = await writeOnce(places.envFile, `MAILBOX_KEY=${freshSecret()}\nMAILBOX_SECRET_k1=${freshSecret()}\n`)
  const madeAllowlist = await writeOnce(path.join(places.stateDir, 'allowed-orders.yml'), allowlistText({ repo, jobs }))
  return { madeSecrets, madeAllowlist }
}

// The settings the board's handlers read, for mailbox mode on this computer. Anything the computer had under these
// names is replaced or removed (applyJobsOff), so a stray FIRE_TRIGGERS can never send an order to a cloud routine.
export function applyJobsOn(env, { key, secret, kid, repo }) {
  for (const name of MAILBOX_NAMES) delete env[name]
  const [owner, name] = repo.split('/')
  env.FIRE_MODE = 'mailbox'
  env.MAILBOX_KEY = key
  env.MAILBOX_SECRET = secret
  env.MAILBOX_SECRET_ID = kid
  env.MAILBOX_RUNNER = LOCAL_RUNNER
  env.MAILBOX_POLL_SECONDS = String(POLL_SECONDS)
  env.GITHUB_OWNER = owner
  env.GITHUB_REPO = name
}

export function applyJobsOff(env) {
  for (const name of MAILBOX_NAMES) delete env[name]
}

// ---- the board, answered in this process ----------------------------------------------------------------

// Just enough of a Node response for the shim and api/mailbox.js: headers, a status, one body.
class HeldResponse {
  constructor() {
    this.statusCode = 200
    this.headers = new Map()
    this.body = ''
    this.writableEnded = false
    this.headersSent = false
  }

  setHeader(name, value) { this.headers.set(String(name).toLowerCase(), String(value)) }
  getHeader(name) { return this.headers.get(String(name).toLowerCase()) }
  hasHeader(name) { return this.headers.has(String(name).toLowerCase()) }
  removeHeader(name) { this.headers.delete(String(name).toLowerCase()) }
  end(chunk) {
    if (this.writableEnded) return this
    if (chunk !== undefined && chunk !== null) this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    this.writableEnded = true
    this.headersSent = true
    return this
  }
}

const refused = () => new TypeError('This runner may only ask the board on this computer.')

// The fetch the runner is handed. It answers exactly one request - GET https://this-computer.invalid/api/mailbox -
// by running the real api/mailbox.js handler here, with nothing but the runner's Authorization header (no Origin,
// no Sec-Fetch-Site, no cookie: what Node's own fetch to a server would send). Any other address, method or body is
// refused, so nothing the runner is told can make the board reach anything else.
export function createMailboxFetch({ handler = mailboxHandler, origin = LOCAL_BOARD_ORIGIN } = {}) {
  const address = `${origin}/api/mailbox`
  return async function boardFetch(url, options = {}) {
    if (typeof url !== 'string' || url !== address) throw refused()
    if (String(options.method ?? 'GET').toUpperCase() !== 'GET' || options.body !== undefined) throw refused()
    if (options.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    const given = new Headers(options.headers ?? {})
    const headers = { accept: 'application/json' }
    if (given.has('authorization')) headers.authorization = given.get('authorization')
    const request = { method: 'GET', url: '/api/mailbox', query: Object.create(null), headers, body: undefined }
    const response = shimResponse(new HeldResponse())
    await handler(request, response)
    const status = response.statusCode >= 200 && response.statusCode <= 599 ? response.statusCode : 500
    return new Response(status === 204 || status === 304 ? null : response.body, { status, headers: Object.fromEntries(response.headers) })
  }
}

// ---- the programs the runner starts --------------------------------------------------------------------------

// What the runner, and everything it starts, may see of the board's environment: where things are and who the
// user is - never a key, a token, the per-run key or a board setting. Names are compared without regard to case.
const RUNNER_NEEDS = new Set([
  'PATH', 'PATHEXT', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TZ', 'TMPDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'TEMP', 'TMP',
  'USERNAME', 'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH', 'SSH_AUTH_SOCK', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME'
])
export function runnerEnvironment(source = process.env) {
  const env = {}
  for (const [name, value] of Object.entries(source)) {
    const upper = name.toUpperCase()
    if (typeof value === 'string' && (RUNNER_NEEDS.has(upper) || upper.startsWith('LC_'))) env[name] = value
  }
  return env
}

// git for the runner: the absolute path found once from PATH, never one inside the team folder, the board, the
// runner's code or its work copy; started from git's own folder with `-C <folder>` saying where it works, so a
// git.exe planted in a work folder is never the one that runs. `extraConfig` is `key=value` settings put first
// (the tests use it to point a GitHub address at a folder; the board never passes any).
export function runnerGit({ env, platform = process.platform, avoid = [], gitPath = findGit(env, platform), run = promisify(execFile), extraConfig = [] }) {
  if (!gitPath) throw new Error('git was not found on PATH')
  for (const folder of avoid) {
    if (folder && isInside(folder, gitPath)) throw new Error('the git program is inside a folder the board does not trust')
  }
  const gitEnv = { ...gitEnvironment(env), ...(platform === 'win32' ? { NoDefaultCurrentDirectoryInExePath: '1' } : {}) }
  const leading = extraConfig.flatMap((setting) => ['-c', setting])
  return async (args, cwd) => {
    if (typeof cwd === 'string' && isInside(cwd, gitPath)) throw new Error('the git program is inside the folder it was asked to work in')
    return run(gitPath, [...leading, ...(typeof cwd === 'string' ? ['-C', cwd] : []), ...args], {
      cwd: path.dirname(gitPath),
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: gitEnv,
      windowsHide: true
    })
  }
}

// ---- loading the runner ----------------------------------------------------------------------------------

async function loadRunner(codeDir) {
  const load = (...parts) => import(pathToFileURL(path.join(codeDir, ...parts)).href)
  const [command, programs, windows, jobs, keys] = await Promise.all([
    load(...RUNNER_ENTRY),
    load('scripts', 'lib', 'status', 'programs.mjs'),
    load('scripts', 'lib', 'mailbox', 'windows.mjs'),
    load('scripts', 'lib', 'mailbox', 'jobs.mjs'),
    load('scripts', 'lib', 'mailbox', 'keys.mjs')
  ])
  return { main: command.main, programs, windows, knownJobs: jobs.knownJobs, readMailboxEnv: keys.readMailboxEnv }
}

// ---- the runner, kicked ----------------------------------------------------------------------------------

// One tick at a time. A kick while a tick runs is not lost: one more tick follows it.
//   tick()   run the runner's `--once` now (or after the one running), resolves when no tick is left to run
//   kick()   the same, without waiting
//   start()  one tick now and one every TICK_EVERY_MS
//   stop()   no more ticks; a Claude still running is stopped the way a signal stops the runner, and its order is
//            left "outcome unknown" for the next start to settle by reading the team repo (never run again)
//   idle()   resolves when no tick is running
export function createLocalRunner({ runner, args, teamFolder, log = () => {}, everyMs = TICK_EVERY_MS }) {
  const signalHandlers = new Map()
  // The runner listens for signals on what it is handed as `proc`. The board keeps its own process: these are
  // kept here and called by stop(), and `exit` does nothing (the board decides when to end).
  const proc = { on: (signal, handler) => { signalHandlers.set(signal, handler) }, exit: () => {} }
  let running = null
  let again = false
  let timer = null
  let stopped = false

  async function once() {
    try {
      await runner.main({ ...args, argv: ['--once'], proc, out: log, err: log })
    } catch {
      log('jobs: the runner stopped on an unexpected error')
    }
    // What it pushed is on the board's next read, not 30 seconds later.
    refreshNow(teamFolder)
  }

  function tick() {
    if (stopped) return Promise.resolve()
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      try {
        do {
          again = false
          await once()
        } while (again && !stopped)
      } finally {
        running = null
      }
    })()
    return running
  }

  return {
    tick,
    kick: () => { tick().catch(() => {}) },
    idle: () => running ?? Promise.resolve(),
    start() {
      stopped = false
      timer = setInterval(() => { tick().catch(() => {}) }, everyMs)
      timer.unref?.()
      return tick()
    },
    async stop() {
      stopped = true
      clearInterval(timer)
      if (running) {
        await signalHandlers.get('SIGTERM')?.('SIGTERM')
        await running.catch(() => {})
      }
    }
  }
}

// /api/fire, with one thing added: once it has answered that an order is in the queue, the runner is kicked.
// Nothing about the answer or the checks before it changes.
export function kickAfterOrders(handler, kick) {
  return async function fireThenKick(request, response) {
    let queued = false
    const send = response.json
    response.json = function json(value) {
      if (response.statusCode === 200 && value?.ok === true && value?.via === 'mac' && typeof value?.orderId === 'string') queued = true
      return send.call(response, value)
    }
    try {
      return await handler(request, response)
    } finally {
      if (queued) kick()
    }
  }
}

// ---- turning jobs on at start --------------------------------------------------------------------------------

async function originAddress(teamFolder) {
  try {
    const { stdout } = await runGit(['config', '--get', 'remote.origin.url'], { cwd: teamFolder, maxBuffer: 4096 })
    return stdout.toString('utf8').trim()
  } catch {
    return null
  }
}

async function makeWorkCopy({ git, url, workDir, stateDir }) {
  if (await exists(workDir)) return true
  await mkdir(path.dirname(workDir), { recursive: true })
  // An empty hooks folder: nothing in the clone runs while it is made. The runner rewrites its config before git
  // is next run in it.
  const hooks = path.join(stateDir, 'empty-hooks')
  await mkdir(hooks, { recursive: true })
  try {
    await git(['-c', `core.hooksPath=${hooks}`, '-c', 'protocol.ext.allow=never', 'clone', '--quiet', '--no-recurse-submodules', '--', url, workDir])
    return true
  } catch {
    return false
  }
}

// Called by the starter once it knows the team folder. Returns null (jobs off, and why it said so) or what the
// server needs: `wrapHandler` for /api/fire, and start/stop/idle/tick.
//   overrides      test-only: replaces what the runner is handed (a fake Claude, a fake folder lock)
//   extraGitConfig test-only: settings put in front of every git the runner runs
export async function prepareJobs({
  boardDir,
  stateDir,
  teamFolder,
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  places: givenPlaces = {},
  log = (line) => console.log(line),
  overrides = {},
  extraGitConfig = [],
  everyMs = TICK_EVERY_MS
}) {
  const off = (sentence) => {
    applyJobsOff(env)
    log(sentence)
    return null
  }
  const url = await originAddress(teamFolder)
  const names = url ? githubNames(url) : null
  if (!names) return off(SAY.notGitHub)
  const repo = `${names.owner}/${names.repo}`

  const places = { ...runnerPlacesFor({ boardDir, stateDir, platform, env, home }), ...givenPlaces }
  const problem = await placesProblem(places, { teamFolder })
  if (problem === 'no-code') return off(SAY.noCode)
  if (problem) return off(SAY.badPlaces)

  let runner
  try {
    runner = await loadRunner(places.codeDir)
  } catch {
    return off(SAY.noCode)
  }

  let secrets
  try {
    await ensureRunnerFiles({ places, repo, jobs: runner.knownJobs(), platform })
    const read = await runner.readMailboxEnv(places.envFile, { platform })
    if (read.state !== 'ok') return off(SAY.badFiles)
    const kid = read.secrets.size === 1 ? [...read.secrets.keys()][0] : read.secrets.has('k1') ? 'k1' : null
    if (!kid) return off(SAY.badFiles)
    secrets = { key: read.key, secret: read.secrets.get(kid), kid }
  } catch {
    return off(SAY.badFiles)
  }
  applyJobsOn(env, { ...secrets, repo })
  if (!mailboxConfig(env).ready) return off(SAY.badFiles)

  const runnerEnv = runnerEnvironment(env)
  const git = runnerGit({ env: runnerEnv, platform, avoid: [teamFolder, boardDir, places.codeDir, places.workDir, places.stateDir], extraConfig: extraGitConfig })
  if (!(await makeWorkCopy({ git, url, workDir: places.workDir, stateDir: places.stateDir }))) log(SAY.noWork)

  const { programs, windows } = runner
  let username = null
  try {
    username = os.userInfo().username
  } catch {
    // Some containers have no user entry.
  }
  const exec = programs.createRunner({ spawn: realSpawn, platform, env: runnerEnv })
  const args = {
    home,
    now: () => Date.now(),
    platform,
    env: runnerEnv,
    identity: { username, home, hostname: os.hostname() },
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    fetch: createMailboxFetch(),
    git,
    exec,
    find: (name, extra = {}) => programs.findProgram(name, { env: runnerEnv, home, platform, ...extra }),
    findAll: (name, extra = {}) => programs.findEveryProgram(name, { env: runnerEnv, home, platform, ...extra }),
    spawn: realSpawn,
    places,
    ...(platform === 'win32' ? { privatePlaces: windows.privatePlaces({ exec, env: runnerEnv, user: username, domain: runnerEnv.USERDOMAIN }) } : {}),
    ...overrides
  }
  const local = createLocalRunner({ runner, args, teamFolder, log, everyMs })
  log(SAY.on)
  return {
    ...local,
    places,
    wrapHandler: (name, handler) => (name === 'fire' ? kickAfterOrders(handler, local.kick) : handler)
  }
}

