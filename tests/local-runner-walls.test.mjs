// Jobs on this computer (task T8), one wall at a time: the runner's board answers only one address and only in
// this process, its programs get no secrets, git is never a planted copy, the settings it writes are private and
// never overwritten, the folders never touch the team folder, and only a queued order kicks the runner.

import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { addressHasLogin, findGit } from '../api/_repo.js'
import {
  LOCAL_BOARD_ORIGIN, LOCAL_RUNNER, MAILBOX_NAMES, SAY, allowlistText, applyJobsOff, applyJobsOn, createLocalRunner, createMailboxFetch,
  ensureRunnerFiles, kickAfterOrders, makeWorkCopy, placesProblem, prepareJobs, runnerEnvironment, runnerGit, runnerPlacesFor, workDirFor
} from '../local/runner.mjs'
import { makeHandler } from '../api/mailbox.js'
import { mailboxConfig, queueOrder } from '../api/_mailbox.js'
import { pictureStore } from '../api/_picture-store.js'
import { fakeBlob } from './helpers/fake-blob.mjs'
import { HAS_RUNNER, RUNNER_CODE, git, makeWorld } from './helpers/local-runner-world.mjs'

const NO_RUNNER = HAS_RUNNER ? false : 'the runner code (agent-team-template) is not next to this repo'
const SECRET = ['test', 'only', 'mailbox', 'signing', 'value', '0123456789'].join('-')
const POLL_KEY = ['test', 'only', 'mailbox', 'poll', 'value', 'abcdefghij'].join('-')
const ENV = { GITHUB_OWNER: 'ExampleOwner', GITHUB_REPO: 'example-team', FIRE_MODE: 'mailbox', MAILBOX_SECRET: SECRET, MAILBOX_KEY: POLL_KEY, MAILBOX_RUNNER: LOCAL_RUNNER, MAILBOX_POLL_SECONDS: '300', BLOB_STORE_ID: 'store_fake' }
const ADDRESS = `${LOCAL_BOARD_ORIGIN}/api/mailbox`
const temp = (name) => realpathSync(mkdtempSync(join(tmpdir(), `${name}-`)))

// ---- the board, answered in this process ------------------------------------------------------------------

test('mailbox fetch: only GET https://this-computer.invalid/api/mailbox is answered; every other address, method or body is refused before the board is asked', async () => {
  let asked = 0
  const fetch = createMailboxFetch({ handler: (request, response) => { asked += 1; response.status(200).json({ v: 1 }) } })
  const refusedAddresses = [
    'https://this-computer.invalid/api/mailbox/', 'https://this-computer.invalid/api/mailbox?x=1', 'https://this-computer.invalid/api/state',
    'http://this-computer.invalid/api/mailbox', 'https://this-computer.invalid:443/api/mailbox', 'https://THIS-COMPUTER.invalid/api/mailbox',
    'https://board.example.com/api/mailbox', 'https://127.0.0.1/api/mailbox', 'https://this-computer.invalid.evil.com/api/mailbox',
    'https://this-computer.invalid/api/mailbox#x', 'https://user@this-computer.invalid/api/mailbox', new URL(ADDRESS)
  ]
  for (const address of refusedAddresses) await assert.rejects(fetch(address, { method: 'GET' }), TypeError, String(address))
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) await assert.rejects(fetch(ADDRESS, { method }), TypeError, method)
  await assert.rejects(fetch(ADDRESS, { method: 'GET', body: 'x' }), TypeError)
  assert.equal(asked, 0)
  const answer = await fetch(ADDRESS, { method: 'GET' })
  assert.equal(answer.status, 200)
  assert.deepEqual(await answer.json(), { v: 1 })
  assert.equal(asked, 1)
})

test('mailbox fetch: the handler sees only the runner\'s Authorization - no Origin, Sec-Fetch-Site, cookie or forwarded header can be passed through', async () => {
  let seen = null
  const fetch = createMailboxFetch({ handler: (request, response) => { seen = request; response.status(200).json({}) } })
  await fetch(ADDRESS, { method: 'GET', headers: { Authorization: 'Bearer abc', Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site', Cookie: 'board_local_1=x', 'x-view-key': 'v', 'x-forwarded-for': '1.2.3.4' } })
  assert.deepEqual(Object.keys(seen.headers).sort(), ['accept', 'authorization'])
  assert.equal(seen.headers.authorization, 'Bearer abc')
  assert.equal(seen.method, 'GET')
})

test('mailbox fetch: an aborted signal is not answered', async () => {
  let asked = 0
  const fetch = createMailboxFetch({ handler: (request, response) => { asked += 1; response.status(200).json({}) } })
  await assert.rejects(fetch(ADDRESS, { method: 'GET', signal: AbortSignal.abort() }))
  assert.equal(asked, 0)
})

test('mailbox fetch through the REAL api/mailbox.js: the right key gets the signed orders, a wrong key a 401, and the secret never comes back', async () => {
  const fake = fakeBlob()
  const loadSdk = async () => fake.sdk
  const saved = {}
  for (const [name, value] of Object.entries(ENV)) { saved[name] = process.env[name]; process.env[name] = value }
  try {
    await queueOrder(pictureStore(ENV, loadSdk), mailboxConfig(ENV), { source: 'agent-cockpit', action: 'task', title: 'Chase the invoice', instruction: 'File one card.' })
    const fetch = createMailboxFetch({ handler: makeHandler({ env: ENV, loadSdk }) })
    const good = await fetch(ADDRESS, { method: 'GET', headers: { Authorization: `Bearer ${POLL_KEY}` } })
    assert.equal(good.status, 200)
    const text = await good.text()
    assert.equal(JSON.parse(text).orders.length, 1)
    assert.ok(!text.includes(SECRET) && !text.includes(POLL_KEY))
    const bad = await fetch(ADDRESS, { method: 'GET', headers: { Authorization: `Bearer ${POLL_KEY}x` } })
    assert.equal(bad.status, 401)
    const none = await fetch(ADDRESS, { method: 'GET' })
    assert.equal(none.status, 401)
    assert.equal(good.headers.get('cache-control'), 'private, no-store')
  } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
  }
})

// ---- what the runner and its programs may see ------------------------------------------------------------

test('runner environment: where things are and who the user is, never a key, a token, the per-run key or a board setting', () => {
  const source = {
    PATH: '/bin', Path: 'C:\\x', HOME: '/home/x', USERPROFILE: 'C:\\Users\\x', APPDATA: 'a', LOCALAPPDATA: 'l', SystemRoot: 'C:\\Windows', TEMP: 't', TMPDIR: '/t', LANG: 'en', LC_ALL: 'C', USER: 'x', USERDOMAIN: 'D', SSH_AUTH_SOCK: '/s',
    VIEW_KEY: 'v', PUBLIC_FIRE: 'true', OPENAI_API_KEY: 'sk-x', GITHUB_TOKEN: 'g', ANTHROPIC_API_KEY: 'a', ANTHROPIC_BASE_URL: 'u', MAILBOX_SECRET: 'm', MAILBOX_KEY: 'k', FIRE_KEY: 'f', FIRE_MODE: 'mailbox',
    BOARD_PASSWORD: 'p', N8N_API_KEY: 'n', HASS_TOKEN: 'h', REPO_FOLDER: '/team', PICTURE_FOLDER: '/p', FISH_API_KEY: 'f', GIT_DIR: '/evil', NODE_OPTIONS: '--require /evil.js', CLAUDE_CONFIG_DIR: '/evil'
  }
  const env = runnerEnvironment(source)
  for (const name of ['VIEW_KEY', 'PUBLIC_FIRE', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'MAILBOX_SECRET', 'MAILBOX_KEY', 'FIRE_KEY', 'FIRE_MODE', 'BOARD_PASSWORD', 'N8N_API_KEY', 'HASS_TOKEN', 'REPO_FOLDER', 'PICTURE_FOLDER', 'FISH_API_KEY', 'GIT_DIR', 'NODE_OPTIONS', 'CLAUDE_CONFIG_DIR']) {
    assert.equal(env[name], undefined, `${name} reached the runner`)
  }
  for (const name of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'SystemRoot', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'USERDOMAIN', 'SSH_AUTH_SOCK']) assert.ok(env[name] !== undefined, `${name} was dropped`)
})

// ---- git: never a planted copy -----------------------------------------------------------------------------

test('runner git: started by its absolute path from git\'s own folder, with -C naming where it works; nothing else on the command line', async () => {
  const calls = []
  const run = async (file, args, options) => { calls.push({ file, args, options }); return { stdout: '' } }
  const gitPath = join(temp('git-home'), process.platform === 'win32' ? 'git.exe' : 'git')
  const runGitHere = runnerGit({ env: { PATH: '/bin', OPENAI_API_KEY: 'sk-x' }, gitPath, run })
  await runGitHere(['status'], '/work/copy')
  await runGitHere(['clone', 'x'])
  assert.equal(calls[0].file, gitPath)
  assert.deepEqual(calls[0].args, ['-C', '/work/copy', 'status'])
  assert.equal(calls[0].options.cwd, dirname(gitPath))
  assert.equal(calls[0].options.env.OPENAI_API_KEY, undefined)
  assert.equal(calls[0].options.env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(calls[0].options.windowsHide, true)
  assert.deepEqual(calls[1].args, ['clone', 'x'])
  if (process.platform === 'win32') assert.equal(calls[0].options.env.NoDefaultCurrentDirectoryInExePath, '1')
})

test('runner git: a git program inside the team folder, the board, the runner code or the folder it is asked to work in is never run', async () => {
  const team = temp('planted-team')
  const planted = join(team, process.platform === 'win32' ? 'git.exe' : 'git')
  writeFileSync(planted, '')
  if (process.platform !== 'win32') chmodSync(planted, 0o755)
  let ran = 0
  const run = async () => { ran += 1; return { stdout: '' } }
  try {
    // Found first on PATH (the planted folder put in front), it is refused when the runner's git is made.
    assert.equal(findGit({ PATH: team }), planted)
    assert.throws(() => runnerGit({ env: { PATH: team }, avoid: [team], run }), /does not trust/)
    // And a git somewhere else is refused for a folder that holds it.
    const runGitHere = runnerGit({ env: {}, gitPath: planted, avoid: [], run })
    await assert.rejects(runGitHere(['status'], team), /inside the folder/)
    assert.equal(ran, 0)
  } finally {
    rmSync(team, { recursive: true, force: true })
  }
})

test('runner git: with a git.exe planted in the work folder and NoDefaultCurrentDirectoryInExePath deleted, the real git runs (the planted one never does)', { skip: process.platform !== 'win32' && 'Windows only: the current folder is searched first only there' }, async () => {
  const work = temp('planted-work')
  const marker = join(work, 'planted-ran.txt')
  const realGit = findGit()
  // A program that is not git: if it ran, `git --version` would not answer with "git version".
  copyFileSync(join(process.env.SystemRoot, 'System32', 'whoami.exe'), join(work, 'git.exe'))
  const saved = process.env.NoDefaultCurrentDirectoryInExePath
  delete process.env.NoDefaultCurrentDirectoryInExePath
  try {
    const runGitHere = runnerGit({ env: { ...process.env }, avoid: [work] })
    const answer = await runGitHere(['--version'], work)
    assert.match(answer.stdout, /^git version/)
    assert.notEqual(realGit, join(work, 'git.exe'))
    assert.equal(existsSync(marker), false)
  } finally {
    if (saved !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = saved
    rmSync(work, { recursive: true, force: true })
  }
})

// ---- the settings it writes -------------------------------------------------------------------------------

test('first run: the secrets file and the allowlist are made once, private, and never written over', { skip: NO_RUNNER }, async () => {
  const state = temp('runner-files')
  try {
    const places = { stateDir: join(state, 'runner'), envFile: join(state, 'runner', 'runner.env') }
    const made = await ensureRunnerFiles({ places, repo: 'ExampleOwner/example-team', jobs: ['morning-intel', 'task-sweep'] })
    assert.deepEqual(made, { madeSecrets: true, madeAllowlist: true })
    const secrets = readFileSync(places.envFile, 'utf8')
    const [, key] = /^MAILBOX_KEY=([0-9a-f]{64})$/m.exec(secrets)
    const [, secret] = /^MAILBOX_SECRET_k1=([0-9a-f]{64})$/m.exec(secrets)
    assert.notEqual(key, secret)
    if (process.platform !== 'win32') {
      assert.equal(statSync(places.envFile).mode & 0o777, 0o600)
      assert.equal(statSync(join(places.stateDir, 'allowed-orders.yml')).mode & 0o777, 0o600)
      assert.equal(statSync(places.stateDir).mode & 0o777, 0o700)
    }
    // The runner itself accepts both files.
    const { readMailboxEnv } = await import(pathToFileURL(join(RUNNER_CODE, 'scripts', 'lib', 'mailbox', 'keys.mjs')).href)
    const { readAllowedOrders } = await import(pathToFileURL(join(RUNNER_CODE, 'scripts', 'lib', 'mailbox', 'allow.mjs')).href)
    const read = await readMailboxEnv(places.envFile)
    assert.equal(read.state, 'ok')
    assert.equal(read.key, key)
    const allowed = await readAllowedOrders(places.stateDir, { username: 'student', hostname: 'laptop', home: state })
    assert.equal(allowed.state, 'ok', allowed.why)
    assert.equal(allowed.allow.board, LOCAL_BOARD_ORIGIN)
    assert.equal(allowed.allow.runner, LOCAL_RUNNER)
    assert.equal(allowed.allow.repo, 'ExampleOwner/example-team')
    assert.deepEqual([...allowed.allow.jobs.keys()], ['morning-intel', 'task-sweep'])
    // A second start, or one after the student changed a file: nothing is written over.
    writeFileSync(join(places.stateDir, 'allowed-orders.yml'), allowlistText({ repo: 'ExampleOwner/example-team', jobs: ['morning-intel'] }))
    const again = await ensureRunnerFiles({ places, repo: 'Other/repo', jobs: ['task-sweep'] })
    assert.deepEqual(again, { madeSecrets: false, madeAllowlist: false })
    assert.equal(readFileSync(places.envFile, 'utf8'), secrets)
    assert.ok(readFileSync(join(places.stateDir, 'allowed-orders.yml'), 'utf8').includes('slug: morning-intel'))
    assert.ok(!readFileSync(join(places.stateDir, 'allowed-orders.yml'), 'utf8').includes('task-sweep'))
  } finally {
    rmSync(state, { recursive: true, force: true })
  }
})

test('mailbox settings: turning jobs on replaces whatever the computer had; turning them off removes every one, so a stray FIRE_TRIGGERS can never reach a cloud routine', () => {
  const env = { FIRE_MODE: 'cloud', FIRE_TRIGGERS: '{"x":{"url":"https://evil"}}', FIRE_KEY: 'k', MAILBOX_KEY: 'old', MAILBOX_SECRET: 'old', MAILBOX_SECRET_ID: 'k9', MAILBOX_RUNNER: 'mac-mini', MAILBOX_POLL_SECONDS: '60', OTHER: 'kept' }
  applyJobsOn(env, { key: 'a'.repeat(64), secret: 'b'.repeat(64), kid: 'k1', repo: 'Owner/team' })
  assert.equal(env.FIRE_MODE, 'mailbox')
  assert.equal(env.FIRE_TRIGGERS, undefined)
  assert.equal(env.FIRE_KEY, undefined)
  assert.equal(env.MAILBOX_RUNNER, LOCAL_RUNNER)
  assert.equal(env.MAILBOX_SECRET_ID, 'k1')
  assert.equal(env.GITHUB_OWNER, 'Owner')
  assert.equal(env.GITHUB_REPO, 'team')
  applyJobsOff(env)
  for (const name of MAILBOX_NAMES) assert.equal(env[name], undefined, name)
  assert.equal(env.OTHER, 'kept')
})

// ---- where things live ------------------------------------------------------------------------------------

test('places: Windows and Mac as the plan\'s table, the runner\'s state in its own folder inside the board\'s, none overlapping', () => {
  const win = runnerPlacesFor({ boardDir: 'C:\\Users\\s\\Agent Board', stateDir: 'C:\\Users\\s\\AppData\\Local\\Agent Board\\state', platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\s\\AppData\\Local' }, home: 'C:\\Users\\s' })
  assert.equal(win.workDir, 'C:\\Users\\s\\AppData\\Local\\Agent Board\\work')
  assert.equal(workDirFor({ platform: 'win32', env: { LOCALAPPDATA: 'relative' }, home: 'C:\\Users\\s' }), 'C:\\Users\\s\\AppData\\Local\\Agent Board\\work')
  assert.equal(workDirFor({ platform: 'darwin', env: {}, home: '/Users/s' }), '/Users/s/Library/Application Support/Agent Board/work')
  assert.equal(workDirFor({ platform: 'linux', env: {}, home: '/home/s' }), '/home/s/.local/share/agent-board/work')
  const here = runnerPlacesFor({ boardDir: '/b', stateDir: '/s/state', platform: process.platform, env: {}, home: '/h' })
  assert.equal(here.stateDir, join('/s/state', 'runner'))
  assert.equal(here.envFile, join('/s/state', 'runner', 'runner.env'))
  assert.equal(here.codeDir, join('/b', 'runner-code'))
})

test('places: none may be inside the team folder or hold it, all are full paths, and the code folder must hold the runner', { skip: NO_RUNNER }, async () => {
  const team = temp('places-team')
  const elsewhere = temp('places-elsewhere')
  try {
    const good = { stateDir: join(elsewhere, 'state'), envFile: join(elsewhere, 'state', 'runner.env'), workDir: join(elsewhere, 'work'), codeDir: RUNNER_CODE }
    assert.equal(await placesProblem(good, { teamFolder: team }), null)
    assert.equal(await placesProblem({ ...good, codeDir: join(team, 'runner-code') }, { teamFolder: team }), 'team-folder')
    assert.equal(await placesProblem({ ...good, workDir: join(team, 'work') }, { teamFolder: team }), 'team-folder')
    assert.equal(await placesProblem({ ...good, stateDir: join(team, 'state') }, { teamFolder: team }), 'team-folder')
    assert.equal(await placesProblem({ ...good, workDir: dirname(team) }, { teamFolder: team }), 'team-folder', 'a folder that holds the team folder')
    assert.equal(await placesProblem({ ...good, codeDir: team }, { teamFolder: team }), 'team-folder', 'the team folder itself is never the code')
    assert.equal(await placesProblem({ ...good, workDir: 'work' }, { teamFolder: team }), 'path')
    assert.equal(await placesProblem({ ...good, codeDir: elsewhere }, { teamFolder: team }), 'no-code')
    let linked = null
    try {
      linked = join(elsewhere, 'code-link')
      symlinkSync(RUNNER_CODE, linked, 'junction')
    } catch {
      linked = null
    }
    if (linked) assert.equal(await placesProblem({ ...good, codeDir: linked }, { teamFolder: team }), 'no-code', 'a link is not the code folder')
  } finally {
    rmSync(team, { recursive: true, force: true })
    rmSync(elsewhere, { recursive: true, force: true })
  }
})

// ---- turning jobs on ---------------------------------------------------------------------------------------

test('jobs stay off, with one plain line, when the team folder is not on GitHub (and the mailbox settings are cleared)', async () => {
  const world = makeWorld()
  try {
    git(world.team, 'remote', 'set-url', 'origin', world.bare)
    const env = { FIRE_MODE: 'mailbox', FIRE_TRIGGERS: 'x' }
    const lines = []
    const jobs = await prepareJobs({ boardDir: world.board, stateDir: world.state, teamFolder: world.team, env, log: (line) => lines.push(line) })
    assert.equal(jobs, null)
    assert.deepEqual(lines, [SAY.notGitHub])
    assert.equal(env.FIRE_MODE, undefined)
    assert.equal(env.FIRE_TRIGGERS, undefined)
    assert.equal(existsSync(world.state), false, 'nothing was written')
  } finally {
    world.done()
  }
})

test('jobs stay off when the runner code is not installed next to the board, and nothing is written', async () => {
  const world = makeWorld()
  try {
    const lines = []
    const env = {}
    const jobs = await prepareJobs({ boardDir: world.board, stateDir: world.state, teamFolder: world.team, env, log: (line) => lines.push(line), places: { workDir: world.work } })
    assert.equal(jobs, null)
    assert.deepEqual(lines, [SAY.noCode])
    assert.equal(existsSync(world.state), false)
    assert.equal(existsSync(world.work), false)
  } finally {
    world.done()
  }
})

test('jobs stay off when the runner code sits inside the team folder', async () => {
  const world = makeWorld()
  try {
    mkdirSync(join(world.team, 'runner-code', 'scripts', 'lib', 'mailbox'), { recursive: true })
    writeFileSync(join(world.team, 'runner-code', 'scripts', 'lib', 'mailbox', 'command.mjs'), 'throw new Error("must never be imported")\n')
    const lines = []
    const jobs = await prepareJobs({ boardDir: world.team, stateDir: world.state, teamFolder: world.team, env: {}, log: (line) => lines.push(line), places: { workDir: world.work } })
    assert.equal(jobs, null)
    assert.deepEqual(lines, [SAY.badPlaces])
  } finally {
    world.done()
  }
})

// ---- what kicks the runner ----------------------------------------------------------------------------------

function answerWith(status, value) {
  return async (request, response) => response.status(status).json(value)
}
function fakeResponse() {
  return { statusCode: 200, sent: null, status(code) { this.statusCode = code; return this }, json(value) { this.sent = value; return this } }
}

test('kick: only an order the queue took (200, via the mailbox, with its id) kicks the runner - never a refusal, an error or a cloud answer', async () => {
  const cases = [
    [200, { ok: true, accepted: true, via: 'mac', orderId: 'a'.repeat(32) }, 1],
    [200, { ok: true, accepted: true, workflow: 'x' }, 0],
    [200, { ok: true, via: 'mac' }, 0],
    [200, { ok: false, via: 'mac', orderId: 'a'.repeat(32) }, 0],
    [429, { ok: true, via: 'mac', orderId: 'a'.repeat(32) }, 0],
    [400, { error: 'no' }, 0],
    [503, { error: 'not configured' }, 0]
  ]
  for (const [status, value, kicks] of cases) {
    let kicked = 0
    const response = fakeResponse()
    await kickAfterOrders(answerWith(status, value), () => { kicked += 1 })({}, response)
    assert.equal(kicked, kicks, JSON.stringify([status, value]))
    assert.deepEqual(response.sent, value, 'the answer is unchanged')
  }
  // A handler that throws still throws, and kicks nothing.
  let kicked = 0
  await assert.rejects(kickAfterOrders(async () => { throw new Error('boom') }, () => { kicked += 1 })({}, fakeResponse()), /boom/)
  assert.equal(kicked, 0)
})

test('ticks: one at a time; a kick while one runs is not lost (exactly one more follows); stop() ends a running one the way a signal would', async () => {
  let ticks = 0
  let release
  let gate = new Promise((resolve) => { release = resolve })
  const signals = []
  const runner = {
    main: async ({ argv, proc }) => {
      assert.deepEqual(argv, ['--once'])
      ticks += 1
      proc.on('SIGTERM', (signal) => { signals.push(signal) })
      await gate
      return 0
    }
  }
  const local = createLocalRunner({ runner, args: {}, teamFolder: tmpdir(), everyMs: 3_600_000 })
  const first = local.tick()
  local.kick()
  local.kick()
  local.kick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(ticks, 1, 'no second tick while the first runs')
  release()
  await first
  assert.equal(ticks, 2, 'the kicks while it ran became exactly one more tick')
  gate = new Promise((resolve) => { release = resolve })
  local.kick()
  await new Promise((resolve) => setImmediate(resolve))
  const stopping = local.stop()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(signals, ['SIGTERM'])
  release()
  await stopping
  local.kick()
  await local.idle()
  assert.equal(ticks, 3, 'nothing ticks after stop()')
})

// ---- a team folder address that holds a login ------------------------------------------------------------
// git hands the whole address to git-remote-https on its command line on every fetch and push, where any program on the
// computer can read it, and the runner refuses such an address on every tick (origin-has-login). So jobs never turn on for
// one, and the address is never written into the work copy. The token is made up; every address holding it is pointed at
// the bare "GitHub" folder (insteadOf), so nothing can reach the network.

const FAKE_TOKEN = ['ghp', 'NotARealTokenForJobsTests0123'].join('_')
const LOGIN_GH = `https://x-access-token:${FAKE_TOKEN}@github.com/ExampleOwner/example-team.git`
const PLAIN_GH = 'https://github.com/ExampleOwner/example-team.git'

function jobsOffForLogin(world) {
  const env = { FIRE_MODE: 'mailbox', FIRE_TRIGGERS: 'x', MAILBOX_KEY: 'old' }
  const lines = []
  return {
    env,
    lines,
    run: () => prepareJobs({ boardDir: world.board, stateDir: world.state, teamFolder: world.team, env, log: (line) => lines.push(line), places: { workDir: world.work, codeDir: RUNNER_CODE } })
  }
}

test('jobs stay off, with one plain line and no token in it, when the team folder\'s address holds a token - and nothing is written', async () => {
  const world = makeWorld()
  try {
    git(world.team, 'remote', 'set-url', 'origin', LOGIN_GH)
    git(world.team, 'config', `url.${world.bare}.insteadOf`, LOGIN_GH)
    const off = jobsOffForLogin(world)
    assert.equal(await off.run(), null)
    assert.deepEqual(off.lines, [SAY.hasLogin])
    assert.match(SAY.hasLogin, /^Jobs are off: /)
    assert.match(SAY.hasLogin, /plain https:\/\/github\.com\//)
    assert.ok(!off.lines.join('\n').includes(FAKE_TOKEN) && !off.lines.join('\n').includes('x-access-token'), 'the token was repeated')
    for (const name of ['FIRE_MODE', 'FIRE_TRIGGERS', 'MAILBOX_KEY']) assert.equal(off.env[name], undefined, `${name} was left set`)
    assert.equal(existsSync(world.state), false, 'the runner\'s files were written')
    assert.equal(existsSync(world.work), false, 'a work copy was made')
  } finally {
    world.done()
  }
})

test('jobs stay off too when git would rewrite a plain address into one holding a token (url.<base>.insteadOf)', async () => {
  const world = makeWorld()
  try {
    git(world.team, 'config', '--unset', `url.${world.bare}.insteadOf`)
    git(world.team, 'config', `url.https://x-access-token:${FAKE_TOKEN}@github.com/.insteadOf`, 'https://github.com/')
    const off = jobsOffForLogin(world)
    assert.equal(await off.run(), null)
    assert.deepEqual(off.lines, [SAY.hasLogin])
    assert.equal(existsSync(world.work), false)
  } finally {
    world.done()
  }
})

test('the work copy is never given an address that holds a login: nothing is made and no git runs', async () => {
  const work = join(temp('work-login'), 'work')
  const state = temp('work-login-state')
  const calls = []
  const refuse = async (args) => {
    calls.push(args)
    throw new Error('no git in this test')
  }
  try {
    for (const url of [LOGIN_GH, 'https://someone@github.com/ExampleOwner/example-team.git', 'ssh://git:pw@github.com/ExampleOwner/example-team.git']) {
      assert.equal(await makeWorkCopy({ git: refuse, url, workDir: work, stateDir: state, codeDir: RUNNER_CODE }), false, url)
      assert.equal(existsSync(work), false, url)
    }
    assert.deepEqual(calls, [])
  } finally {
    rmSync(dirname(work), { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  }
})

test('a work copy left with a token in its address (by an older board) is made again with the plain address', { skip: NO_RUNNER }, async () => {
  const realGit = runnerGit({ env: runnerEnvironment(process.env) })
  const { readOrigin } = await import(pathToFileURL(join(RUNNER_CODE, 'scripts', 'lib', 'mailbox', 'workcopy.mjs')).href)
  for (const [name, origin] of [['url', `\turl = ${LOGIN_GH}\n`], ['pushurl', `\turl = ${PLAIN_GH}\n\tpushurl = ${LOGIN_GH}\n`]]) {
    const work = join(temp(`work-old-${name}`), 'work')
    const state = temp(`work-old-${name}-state`)
    try {
      mkdirSync(join(work, '.git'), { recursive: true })
      writeFileSync(join(work, '.git', 'config'), `[core]\n\tbare = false\n[remote "origin"]\n${origin}\tfetch = +refs/heads/*:refs/remotes/origin/*\n`)
      assert.equal(await makeWorkCopy({ git: realGit, url: PLAIN_GH, workDir: work, stateDir: state, codeDir: RUNNER_CODE }), true, name)
      assert.ok(!readFileSync(join(work, '.git', 'config'), 'utf8').includes(FAKE_TOKEN), `the token was kept (${name})`)
      assert.deepEqual(await readOrigin(work), { fetch: PLAIN_GH, push: PLAIN_GH }, name)
    } finally {
      rmSync(dirname(work), { recursive: true, force: true })
      rmSync(state, { recursive: true, force: true })
    }
  }
})

test('a work copy with a plain address is kept as it is', async () => {
  const work = join(temp('work-kept'), 'work')
  const state = temp('work-kept-state')
  try {
    mkdirSync(join(work, '.git'), { recursive: true })
    const config = `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${PLAIN_GH}\n`
    writeFileSync(join(work, '.git', 'config'), config)
    const refuse = async () => { throw new Error('no git in this test') }
    assert.equal(await makeWorkCopy({ git: refuse, url: PLAIN_GH, workDir: work, stateDir: state, codeDir: RUNNER_CODE }), true)
    assert.equal(readFileSync(join(work, '.git', 'config'), 'utf8'), config)
  } finally {
    rmSync(dirname(work), { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  }
})

test('addressHasLogin is the runner\'s own rule, case for case (when the runner code has it)', async (t) => {
  const workcopy = await import(pathToFileURL(join(RUNNER_CODE, 'scripts', 'lib', 'mailbox', 'workcopy.mjs')).href).catch(() => null)
  if (typeof workcopy?.addressHasLogin !== 'function') {
    t.skip(`NOT CHECKED - the runner code at ${RUNNER_CODE} has no addressHasLogin yet (template branch gitguard-noargv)`)
    return
  }
  const cases = [
    LOGIN_GH, PLAIN_GH, 'https://someone@github.com/a/b', 'HTTPS://a:b@github.com/c/d', 'http://a@github.com/b/c', 'ssh://git@github.com/a/b.git',
    'ssh://git:pw@github.com/a/b.git', 'SSH://git:pw@github.com/a/b.git', 'git+ssh://git:pw@github.com/a/b.git', 'git+ssh://git@github.com/a/b.git',
    'git@github.com:a/b.git', 'a:b@github.com:c/d.git', 'https://github.com/a/b?x=a@b', 'https://github.com/a/b#x@y', 'https:// a@github.com/b',
    'file:///srv/x.git', 'file://user@host/x', '/srv/x.git', 'C:\\x', 'ext::sh -c x', '', 'origin', ' https://a:b@github.com/c/d', 'https://a:b@github.com/c/d\n',
    undefined, null, 7, {}
  ]
  for (const value of cases) assert.equal(addressHasLogin(value), workcopy.addressHasLogin(value), String(value))
})

// The user's own git config (~/.gitconfig) for the length of `work`: HOME and USERPROFILE point at a folder holding `text`.
async function withHomeConfig(text, work) {
  const home = temp('jobs-home')
  writeFileSync(join(home, '.gitconfig'), text)
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
  try {
    process.env.HOME = home
    process.env.USERPROFILE = home
    delete process.env.XDG_CONFIG_HOME
    return await work()
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(home, { recursive: true, force: true })
  }
}

test('jobs stay off when a push address holds a token: a pushurl, or a pushInsteadOf in the repo or in ~/.gitconfig', async () => {
  const pushLogin = `https://x-access-token:${FAKE_TOKEN}@github.com/`
  const cases = [
    ['pushurl', (team) => git(team, 'config', 'remote.origin.pushurl', LOGIN_GH), ''],
    ['repo pushInsteadOf', (team) => git(team, 'config', `url.${pushLogin}.pushInsteadOf`, 'https://github.com/'), ''],
    ['global pushInsteadOf', () => {}, `[url "${pushLogin}"]\n\tpushInsteadOf = https://github.com/\n`]
  ]
  for (const [name, setup, home] of cases) {
    const world = makeWorld()
    try {
      setup(world.team)
      await withHomeConfig(home, async () => {
        const off = jobsOffForLogin(world)
        assert.equal(await off.run(), null, name)
        assert.deepEqual(off.lines, [SAY.hasLogin], name)
        assert.equal(existsSync(world.work), false, name)
      })
    } finally {
      world.done()
    }
  }
})

test('jobs stay off when git would send the team repo anywhere but GitHub, or the first of two url lines holds a token', async () => {
  const cases = [
    ['a rewrite to another host', (team, world) => { git(team, 'config', '--unset', `url.${world.bare}.insteadOf`); git(team, 'config', 'url.https://evil.example/.insteadOf', 'https://github.com/') }, SAY.notGitHub],
    ['a token with a space before the @', (team, world) => { git(team, 'config', '--unset', `url.${world.bare}.insteadOf`); git(team, 'config', `url.https://${FAKE_TOKEN} @github.com/.insteadOf`, 'https://github.com/') }, SAY.notGitHub],
    ['two url lines, the first with a token', (team, world) => {
      git(team, 'config', '--unset-all', 'remote.origin.url')
      git(team, 'config', '--add', 'remote.origin.url', LOGIN_GH)
      git(team, 'config', '--add', 'remote.origin.url', PLAIN_GH)
      git(team, 'config', `url.${world.bare}.insteadOf`, LOGIN_GH)
    }, SAY.hasLogin]
  ]
  for (const [name, setup, said] of cases) {
    const world = makeWorld()
    try {
      setup(world.team, world)
      await withHomeConfig('', async () => {
        const off = jobsOffForLogin(world)
        assert.equal(await off.run(), null, name)
        assert.deepEqual(off.lines, [said], name)
        assert.ok(!off.lines.join('\n').includes(FAKE_TOKEN), name)
        assert.equal(existsSync(world.work), false, name)
      })
    } finally {
      world.done()
    }
  }
})

test('the jobs line says user name, password or token, and a user name alone keeps jobs off too', async () => {
  assert.match(SAY.hasLogin, /holds a user name, password or token/)
  const world = makeWorld()
  try {
    const named = 'https://someone@github.com/ExampleOwner/example-team.git'
    git(world.team, 'remote', 'set-url', 'origin', named)
    git(world.team, 'config', `url.${world.bare}.insteadOf`, named)
    const off = jobsOffForLogin(world)
    assert.equal(await off.run(), null)
    assert.deepEqual(off.lines, [SAY.hasLogin])
  } finally {
    world.done()
  }
})
