// This computer's own numbers (Student Edition, task T8): the team's status collector, run by the board while it is
// open, writing its files OUTSIDE every repo. The board lays them over what git has (api/_repo.js, the status folder),
// so its readers find them at the paths they read today. Nothing is committed and nothing is pushed.
//
//   on start        every part (usage, connections, hermes, jobs, vaults)
//   every 15 min    usage only (connections runs `claude mcp list`, which starts every server, for up to 2 minutes)
//   Refresh now     every part, from the Settings box (POST /api/local-refresh)
//
// It is the collector from the runner-code folder (the student's team repo at one commit), never the team folder:
// code that runs with the student's login is never chosen by whatever lands in the repo. Node is this board's own
// Node (an absolute path), started from an empty folder the board owns, with no shell and none of the board's
// secrets in its environment.

import { spawn as realSpawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { isInside } from '../api/_repo.js'
import { LOCAL_COMPUTER, codeProblem, runnerEnvironment, runnerPlacesFor } from './runner.mjs'

export const REFRESH_PATH = '/api/local-refresh'
export const COLLECT_EVERY_MS = 15 * 60_000
export const COLLECT_TIMEOUT_MS = 4 * 60_000
const COLLECTOR_ENTRY = ['scripts', 'collect-status.mjs']

// <board state>/status: what the board lays over the team folder. <board state>/collector: the collector's own
// lock, receipts and empty folder.
export const collectorPlacesFor = (stateDir) => ({
  outDir: path.join(stateDir, 'status'),
  stateDir: path.join(stateDir, 'collector'),
  cwd: path.join(stateDir, 'collector', 'run-from')
})

export const SAY = Object.freeze({
  started: 'Refreshing this computer\'s numbers. They show on the board in a minute or two.',
  busy: 'This computer\'s numbers are already being refreshed.',
  off: 'This computer\'s numbers are not collected: the runner code is not installed next to the board.',
  badRequest: 'The board could not read that request.'
})

// Stops a program and everything it started: its process group on a Mac or Linux, taskkill by full path on Windows.
function stopTree(child, platform, env, spawn) {
  if (!child?.pid) return
  if (platform === 'win32') {
    const root = env.SystemRoot || env.SYSTEMROOT
    if (root && path.win32.isAbsolute(root)) {
      try {
        spawn(path.win32.join(root, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, cwd: path.win32.join(root, 'System32') }).on('error', () => {})
      } catch { /* nothing more can be done */ }
    }
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
  }
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}

// The collector, kicked: one run at a time; a full refresh asked for while one runs follows it.
//   run(parts)   parts: null for every part, or a list like ['usage']. Resolves { ok, code }.
//   refresh()    a full run, without waiting: 'started' or 'busy'
//   start()      a full run now, usage every 15 minutes
//   stop()       no more runs; a running one is stopped
//   onWritten()  called after each run that finished with exit code 0 (the board then shows the new files)
export function createCollector({
  codeDir, stateDir, teamFolder, boardDir,
  env = process.env, platform = process.platform, nodePath = process.execPath, spawn = realSpawn,
  log = () => {}, onWritten = () => {}, timeoutMs = COLLECT_TIMEOUT_MS, everyMs = COLLECT_EVERY_MS
}) {
  const places = collectorPlacesFor(stateDir)
  const entry = path.join(codeDir, ...COLLECTOR_ENTRY)
  if (typeof nodePath !== 'string' || !path.isAbsolute(nodePath)) throw new Error('node is not a full path')
  for (const folder of [teamFolder, codeDir, boardDir]) {
    if (folder && isInside(folder, nodePath)) throw new Error('the node program is inside a folder the board does not trust')
  }
  const childEnv = { ...runnerEnvironment(env), ...(platform === 'win32' ? { NoDefaultCurrentDirectoryInExePath: '1' } : {}) }
  let running = null
  let child = null
  let wantFull = false
  let timer = null
  let stopped = false

  function runOnce(parts) {
    return new Promise((resolve) => {
      const args = [entry, '--computer', LOCAL_COMPUTER, '--out', places.outDir, '--state-dir', places.stateDir, ...(parts ? ['--only', parts.join(',')] : [])]
      try {
        child = spawn(nodePath, args, { cwd: places.cwd, env: childEnv, stdio: ['ignore', 'ignore', 'ignore'], detached: platform !== 'win32', windowsHide: true, shell: false })
      } catch {
        resolve({ ok: false, code: null })
        return
      }
      const limit = setTimeout(() => stopTree(child, platform, env, spawn), timeoutMs)
      let done = false
      const finish = (code) => {
        if (done) return
        done = true
        clearTimeout(limit)
        child = null
        resolve({ ok: code === 0, code })
      }
      child.on('error', () => finish(null))
      child.on('close', (code) => finish(code))
    })
  }

  async function run(parts = null) {
    if (stopped) return { ok: false, code: null }
    if (running) {
      if (parts === null) wantFull = true
      return running
    }
    running = (async () => {
      let result = { ok: false, code: null }
      try {
        let next = parts
        do {
          wantFull = false
          // The folder it runs from is emptied first: nothing left in it may be picked up by a program it starts.
          await rm(places.cwd, { recursive: true, force: true })
          await mkdir(places.cwd, { recursive: true, mode: 0o700 })
          await mkdir(places.outDir, { recursive: true, mode: 0o700 })
          result = await runOnce(next)
          log(result.ok ? 'status: this computer\'s numbers were refreshed' : 'status: the collector did not finish; the board shows the numbers it had')
          if (result.ok) onWritten()
          next = null
        } while (wantFull && !stopped)
      } catch {
        log('status: the collector could not be started')
      } finally {
        running = null
      }
      return result
    })()
    return running
  }

  return {
    places,
    run,
    idle: () => running ?? Promise.resolve(),
    refresh() {
      if (stopped) return 'busy'
      if (running) {
        wantFull = true
        return 'busy'
      }
      run(null).catch(() => {})
      return 'started'
    },
    start() {
      stopped = false
      timer = setInterval(() => { run(['usage']).catch(() => {}) }, everyMs)
      timer.unref?.()
      return run(null)
    },
    async stop() {
      stopped = true
      clearInterval(timer)
      if (child) stopTree(child, platform, env, spawn)
      await (running ?? Promise.resolve()).catch(() => {})
    }
  }
}

// POST /api/local-refresh { action: 'refresh' }: start a full run and answer at once (the connections part can take
// two minutes, longer than the board waits for a handler). The page reloads the board a little later.
export function refreshHandler(collector) {
  return async function refresh(request, response) {
    response.setHeader('Cache-Control', 'no-store')
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST')
      return response.status(405).json({ error: 'POST only.' })
    }
    const body = request.body
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.action !== 'refresh' || Object.keys(body).length !== 1) {
      return response.status(400).json({ error: SAY.badRequest })
    }
    if (!collector) return response.status(503).json({ error: SAY.off })
    const result = collector.refresh()
    return response.status(202).json({ ok: true, result, say: result === 'started' ? SAY.started : SAY.busy })
  }
}

// The 60-second check the page makes (/api/state?since=<commit>) answers "unchanged" while no commit lands, which
// would hide new numbers until the next commit. So once after each refresh, that check is answered as a full read.
export function freshAfterRefresh() {
  let written = 0
  let served = 0
  return {
    bump() { written += 1 },
    wrapHandler(name, handler) {
      if (name !== 'state') return handler
      return async function stateAfterRefresh(request, response) {
        const now = written
        if (served !== now && request.query && request.query.since !== undefined) {
          delete request.query.since
          request.url = String(request.url).replace(/([?&])since=[^&#]*&?/, '$1').replace(/[?&]$/, '')
        }
        const send = response.json
        response.json = function json(value) {
          if (response.statusCode === 200 && value && typeof value === 'object' && !value.unchanged && typeof value.commit === 'string') served = now
          return send.call(response, value)
        }
        return handler(request, response)
      }
    }
  }
}

// Called by the starter once it knows the team folder. The code folder is the runner's (runner-code next to the
// board); with none there, or one that touches the team folder, nothing is collected and Refresh now says so.
// Returns null, or the collector with what the server needs: `wrapHandler` for /api/state and start/stop.
//   codeDir, spawn, nodePath   test-only
export async function prepareCollector({
  boardDir, stateDir, teamFolder, platform = process.platform, env = process.env, log = (line) => console.log(line),
  codeDir = runnerPlacesFor({ boardDir, stateDir, platform, env }).codeDir, ...options
}) {
  delete env.REPO_STATUS_FOLDER
  if (await codeProblem(codeDir, { teamFolder, entry: COLLECTOR_ENTRY })) {
    log(SAY.off)
    return null
  }
  const fresh = freshAfterRefresh()
  const collector = createCollector({ codeDir, stateDir, teamFolder, boardDir, env, platform, log, onWritten: fresh.bump, ...options })
  // The team folder reader lays what the collector wrote over the repo (api/_repo.js, statusFolder).
  env.REPO_STATUS_FOLDER = collector.places.outDir
  return { ...collector, wrapHandler: fresh.wrapHandler }
}
