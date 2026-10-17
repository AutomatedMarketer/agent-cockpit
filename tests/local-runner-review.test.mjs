// Jobs on this computer (task T8), the fixes from its security review: stop() never frees the tick's lock early, no
// program the runner or the collector starts sees a key (taskkill included), the team folder's address is never on a
// command line, and Windows names reach the runner in the spelling it expects.

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createLocalRunner, makeWorkCopy, runnerEnvironment, runnerGit, runnerSpawn } from '../local/runner.mjs'
import { createCollector } from '../local/collector.mjs'
import { NO_RUNNER, RUNNER_CODE } from './helpers/local-runner-world.mjs'

const temp = (name) => realpathSync(mkdtempSync(join(tmpdir(), `${name}-`)))
const fromRunner = (...parts) => import(pathToFileURL(join(RUNNER_CODE, 'scripts', 'lib', ...parts)).href)
const KEY_NAMES = /KEY|SECRET|TOKEN|PASSWORD|MAILBOX|VIEW|FIRE/i
const ENV_WITH_KEYS = { ...process.env, OPENAI_API_KEY: 'sk-test', MAILBOX_SECRET: 's'.repeat(40), MAILBOX_KEY: 'k'.repeat(40), VIEW_KEY: 'v', FIRE_KEY: 'f', GITHUB_TOKEN: 'g', BOARD_PASSWORD: 'p', SystemRoot: process.env.SystemRoot || 'C:\\Windows' }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---- 1. stop() and the tick's lock --------------------------------------------------------------------------

test('stop(): the tick keeps its lock until it really ends - another taker cannot get it mid-tick, and the tick never deletes someone else\'s lock', { skip: NO_RUNNER }, async () => {
  assert.ok(readFileSync(join(RUNNER_CODE, 'scripts', 'lib', 'mailbox', 'command.mjs'), 'utf8').includes('keepLockOnSignal'),
    `the runner code at ${RUNNER_CODE} predates keepLockOnSignal (template branch stop-lock): stop() would free the tick's lock`)
  const command = await fromRunner('mailbox', 'command.mjs')
  const { takeLock, releaseLock } = await fromRunner('status', 'commit.mjs')
  const base = temp('stop-lock')
  const stateDir = join(base, 'state')
  // runTick's shape: take the lock, mark it live, work, release in finally. Only the body is a stand-in; main, the signal
  // handler and the lock are the runner's own.
  const tick = async (ctx) => {
    const lock = await takeLock(stateDir, Date.now())
    if (!lock) return { state: 'busy' }
    ctx.live.lock = lock
    try {
      await sleep(1200)
      return { state: 'done' }
    } finally {
      ctx.live.lock = null
      await releaseLock(lock)
    }
  }
  try {
    const places = { stateDir, codeDir: join(base, 'code'), workDir: join(base, 'work'), envFile: join(stateDir, 'runner.env') }
    const local = createLocalRunner({ runner: { main: command.main }, args: { tick, places, platform: process.platform, env: {}, home: base, kill: () => {} }, teamFolder: base, everyMs: 3_600_000 })
    const running = local.tick()
    await sleep(300)
    const stopping = local.stop()
    await sleep(200)
    const other = await takeLock(stateDir, Date.now())
    await stopping
    await running
    assert.equal(other, null, 'another taker got the lock while the tick was still working')
    assert.equal(existsSync(join(stateDir, 'lock')), false, 'the tick released its own lock when it ended')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// ---- 2. no program sees a key -------------------------------------------------------------------------------

test('no program the runner starts sees a key: its spawn applies the short environment unless one is given (taskkill included)', { skip: NO_RUNNER }, async () => {
  const { killTree } = await fromRunner('mailbox', 'claude.mjs')
  const seen = []
  const spy = (file, args, options) => {
    seen.push({ file, env: options?.env })
    return Object.assign(new EventEmitter(), { unref: () => {} })
  }
  const spawnForRunner = runnerSpawn(runnerEnvironment(ENV_WITH_KEYS, 'win32'), spy)
  killTree(4242, 'SIGKILL', { platform: 'win32', spawn: spawnForRunner, systemRoot: 'C:\\Windows' })
  spawnForRunner('C:\\x\\claude.exe', [], { env: { HOME: 'h' } })
  assert.equal(seen.length, 2)
  assert.match(seen[0].file, /taskkill\.exe$/)
  for (const call of seen) {
    assert.ok(call.env && typeof call.env === 'object', `${call.file} was started with the board's whole environment`)
    for (const name of Object.keys(call.env)) assert.ok(!KEY_NAMES.test(name), `${call.file} saw ${name}`)
  }
  assert.deepEqual(seen[1].env, { HOME: 'h' }, 'an environment the runner gives is kept as given')
})

test('the collector\'s taskkill sees no key either', async () => {
  const seen = []
  let child = null
  const spy = (file, args, options) => {
    seen.push({ file, env: options?.env })
    if (!child) {
      child = Object.assign(new EventEmitter(), { pid: 4242, kill: () => true })
      return child
    }
    setImmediate(() => child.emit('close', null))
    return Object.assign(new EventEmitter(), { pid: 4243 })
  }
  const code = temp('collector-code')
  const state = temp('collector-state')
  const team = temp('collector-team')
  try {
    const collector = createCollector({ codeDir: code, stateDir: state, teamFolder: team, env: ENV_WITH_KEYS, platform: 'win32', nodePath: process.execPath, spawn: spy, timeoutMs: 50 })
    await collector.run(['usage'])
    assert.ok(seen.some((call) => /taskkill\.exe$/.test(call.file)), 'taskkill was not used')
    for (const call of seen) {
      assert.ok(call.env, `${call.file} got the board's whole environment`)
      for (const name of Object.keys(call.env)) assert.ok(!KEY_NAMES.test(name), `${call.file} saw ${name}`)
    }
  } finally {
    for (const folder of [code, state, team]) rmSync(folder, { recursive: true, force: true })
  }
})

// ---- 3. the address is never on a command line ----------------------------------------------------------------

test('the work copy is made without the team folder\'s address on any command line (an address can carry a token)', { skip: NO_RUNNER }, async () => {
  const work = join(temp('work-copy'), 'work')
  const state = temp('work-state')
  const url = 'https://x-access-token:ghp_NotARealTokenButLooksLikeOne123@github.com/ExampleOwner/example-team.git'
  const calls = []
  const realGit = runnerGit({ env: runnerEnvironment(process.env) })
  const git = async (args, cwd) => {
    calls.push([...args, cwd ?? ''].join(' '))
    return realGit(args, cwd)
  }
  try {
    assert.equal(await makeWorkCopy({ git, url, workDir: work, stateDir: state, codeDir: RUNNER_CODE }), true)
    assert.ok(calls.length > 0)
    for (const line of calls) assert.ok(!line.includes('ghp_') && !line.includes('github.com'), `the address was on a command line: ${line}`)
    const { readOrigin } = await fromRunner('mailbox', 'workcopy.mjs')
    assert.deepEqual(await readOrigin(work), { fetch: url, push: url }, 'the runner reads the address from the config as written')
  } finally {
    rmSync(dirname(work), { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  }
})

test('a work copy that could not be made is not left half-made: the next start makes it', { skip: NO_RUNNER }, async () => {
  const work = join(temp('work-retry'), 'work')
  const state = temp('work-retry-state')
  const url = 'https://github.com/ExampleOwner/example-team.git'
  const realGit = runnerGit({ env: runnerEnvironment(process.env) })
  try {
    const failing = async (args) => { if (args.includes('init')) throw new Error('git could not start'); return realGit(args) }
    assert.equal(await makeWorkCopy({ git: failing, url, workDir: work, stateDir: state, codeDir: RUNNER_CODE }), false)
    assert.equal(existsSync(work), false, 'an empty work folder was left, and every later start would take it as made')
    assert.equal(await makeWorkCopy({ git: realGit, url, workDir: work, stateDir: state, codeDir: RUNNER_CODE }), true)
    const { readOrigin } = await fromRunner('mailbox', 'workcopy.mjs')
    assert.deepEqual(await readOrigin(work), { fetch: url, push: url })
  } finally {
    rmSync(dirname(work), { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  }
})

// ---- 4. Windows names in the expected spelling ----------------------------------------------------------------

test('runner environment on Windows: SystemRoot and the profile folders are there in the spelling the runner expects, whatever case the computer used', { skip: NO_RUNNER }, async () => {
  const env = runnerEnvironment({ SYSTEMROOT: 'C:\\Windows', localappdata: 'C:\\Users\\s\\AppData\\Local', UserProfile: 'C:\\Users\\s', Temp: 'C:\\t', PATH: 'C:\\bin', OPENAI_API_KEY: 'x' }, 'win32')
  assert.equal(env.SystemRoot, 'C:\\Windows')
  assert.equal(env.LOCALAPPDATA, 'C:\\Users\\s\\AppData\\Local')
  assert.equal(env.USERPROFILE, 'C:\\Users\\s')
  assert.equal(env.TEMP, 'C:\\t')
  for (const odd of ['SYSTEMROOT', 'localappdata', 'UserProfile', 'Temp']) assert.equal(env[odd], undefined, `${odd} left beside its usual spelling`)
  assert.equal(env.OPENAI_API_KEY, undefined)
  // What Claude is then started with (the runner's own claudeEnv) has SystemRoot.
  const { claudeEnv } = await fromRunner('mailbox', 'claude.mjs')
  assert.equal(claudeEnv(env, 'win32').SystemRoot, 'C:\\Windows')
  // Not on a Mac or Linux, where names are case-sensitive.
  assert.deepEqual(runnerEnvironment({ SYSTEMROOT: 'x', HOME: '/h' }, 'darwin'), { SYSTEMROOT: 'x', HOME: '/h' })
})
