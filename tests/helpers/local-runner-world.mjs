// The world the jobs-on-this-computer tests run in (task T8): a team repo on a bare "GitHub" folder, the student's
// clone, a stand-in Claude like the runner's own tests use, and the board as Start Board brings it up.

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { request as httpRequest } from 'node:http'
import { findGit } from '../../api/_repo.js'
import { runStart } from '../../local/start.mjs'
import { MAILBOX_NAMES } from '../../local/runner.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
// The runner's code: the template checkout beside this repo (or AGENT_TEAM_TEMPLATE). Read only.
export const RUNNER_CODE = process.env.AGENT_TEAM_TEMPLATE || join(ROOT, '..', 'agent-team-template')
export const HAS_RUNNER = existsSync(join(RUNNER_CODE, 'scripts', 'lib', 'mailbox', 'command.mjs'))
export const NO_RUNNER = HAS_RUNNER ? false : `the runner code (agent-team-template) is not at ${RUNNER_CODE}; set AGENT_TEAM_TEMPLATE`

const GIT = findGit()
export const GH = 'https://github.com/ExampleOwner/example-team.git'
export const FAKE_CLAUDE = join(tmpdir(), 'no-such-folder', 'claude')
const ENV_KEYS = ['VIEW_KEY', 'PUBLIC_FIRE', 'PUBLIC_DASHBOARD', 'EDIT_KEY', 'BOARD_PASSWORD', 'BOARD_USERNAME', 'REPO_SOURCE', 'REPO_FOLDER', 'PICTURE_STORE', 'PICTURE_FOLDER', 'GITHUB_OWNER', 'GITHUB_REPO', ...MAILBOX_NAMES]
const gitCleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')))
export const git = (cwd, ...args) => execFileSync(GIT, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, env: { ...gitCleanEnv, GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8' }).trim()
const fromTemplate = (relative) => readFileSync(join(RUNNER_CODE, ...relative.split('/')), 'utf8')

// A team repo on "GitHub" (a bare folder that GH is pointed at), the student's clone of it, and an empty home.
export function makeWorld() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'local-runner-')))
  const bare = join(base, 'github.git')
  const seed = join(base, 'seed')
  const team = join(base, 'team')
  git(base, 'init', '-q', '--bare', '-b', 'main', bare)
  mkdirSync(seed)
  git(seed, 'init', '-q', '-b', 'main')
  const files = {
    'README.md': '# Team\n',
    'tasks/README.md': '# tasks\n',
    'workflows/morning-intel.yml': fromTemplate('workflows/morning-intel.yml'),
    'workflows/task-sweep.yml': fromTemplate('workflows/task-sweep.yml'),
    '.claude/agents/research.md': fromTemplate('.claude/agents/research.md'),
    '.claude/agents/orchestrator.md': fromTemplate('.claude/agents/orchestrator.md'),
    'inbox/.gitkeep': ''
  }
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(seed, ...name.split('/'))), { recursive: true })
    writeFileSync(join(seed, ...name.split('/')), text)
  }
  git(seed, 'add', '-A')
  git(seed, 'commit', '-q', '-m', 'seed')
  git(seed, 'push', '-q', bare, 'main:main')
  git(base, 'clone', '-q', bare, team)
  git(team, 'remote', 'set-url', 'origin', GH)
  git(team, 'config', `url.${bare}.insteadOf`, GH)
  git(team, 'fetch', '-q', 'origin')
  const state = join(base, 'state')
  const board = join(base, 'Agent Board')
  mkdirSync(board)
  return {
    base, bare, team, state, board,
    work: join(base, 'work'),
    runnerState: join(state, 'runner'),
    inOrigin: (path) => { try { return git(base, '--git-dir', bare, 'show', `refs/heads/main:${path}`) } catch { return null } },
    done: () => rmSync(base, { recursive: true, force: true })
  }
}

// ---- Claude, as the runner's own tests make it: writes the job's output and its run log from the prompt -----

export function fakeClaude() {
  const calls = []
  const line = (value) => `${JSON.stringify(value)}\n`
  const INIT = { type: 'system', subtype: 'init', tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch'], mcp_servers: [] }
  const RESULT = { type: 'result', subtype: 'success', is_error: false, num_turns: 4, result: 'Wrote the files.', permission_denials: [] }
  const tool = (name) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input: {} }] } })
  const facts = (prompt) => ({
    startedAt: /this run started at (\S+)/.exec(prompt)[1],
    stamps: /where <stamp> is one of ([0-9TZ:, -]+?) \(/.exec(prompt)[1].split(', '),
    outputPath: /nowhere else: `([^`]+)`/.exec(prompt)[1],
    model: /^- model: (\w+)$/m.exec(prompt)[1],
    owner: /owned by the agent `([a-z-]+)`/.exec(prompt)[1],
    workflow: /The job is `([a-z-]+)`/.exec(prompt)[1]
  })
  const writeAt = async (cwd, relative, text) => {
    await mkdir(dirname(join(cwd, ...relative.split('/'))), { recursive: true })
    await writeFile(join(cwd, ...relative.split('/')), text)
  }
  const good = async (cwd, args) => {
    const info = facts(args[1])
    const stamp = info.stamps[0]
    const entry = {
      schema: 'run-log/v1', run_id: `${stamp}-${info.owner}-${info.workflow}`, agent: info.owner, workflow: info.workflow, model: info.model, trigger: 'manual',
      started_at: info.startedAt, finished_at: info.startedAt, status: 'ok',
      summary: 'Ran the job once on this computer and wrote its output; nothing was sent or published.',
      artifacts: [info.outputPath], evidence: ['Wrote 2 files'], next_action: null, session_id: null, session_url: null
    }
    await writeAt(cwd, info.outputPath, `# ${info.workflow}\n\nAll quiet.\n`)
    await writeAt(cwd, `runs/${entry.run_id.slice(0, 7)}/${entry.run_id}.json`, `${JSON.stringify(entry, null, 2)}\n`)
    return [INIT, tool('Read'), tool('WebSearch'), tool('Write'), RESULT]
  }
  const spawn = (file, args, options) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 4242
    child.kill = () => true
    calls.push({ file, args, options })
    setImmediate(async () => {
      try {
        for (const event of await good(options.cwd, args)) child.stdout.write(line(event))
        child.stdout.end()
        child.stderr.end()
        let waiting = 2
        const done = () => { waiting -= 1; if (waiting === 0) child.emit('close', 0, null) }
        child.stdout.once('end', done)
        child.stderr.once('end', done)
        child.stdout.resume()
        child.stderr.resume()
      } catch (failure) {
        child.emit('error', failure)
      }
    })
    return child
  }
  // Everything the runner would otherwise ask the real computer about Claude. Never a real program.
  const overrides = {
    find: async () => ({ state: 'found', path: FAKE_CLAUDE }),
    findAll: async () => ({ paths: [FAKE_CLAUDE], refused: false }),
    exec: async (file, args) => {
      if (file !== FAKE_CLAUDE) throw new Error('an unexpected program')
      if (args[0] === '--version') return { stdout: '2.1.290 (Claude Code)\n', code: 0 }
      if (args[0] === 'auth') return { stdout: JSON.stringify({ authMethod: 'claude.ai', loggedIn: true }), code: 0 }
      throw new Error('an unexpected program')
    },
    realpath: async (path) => path,
    spawn,
    kill: () => {},
    // The Windows folder lock is the runner's own and is tested there; here it says yes, as the runner's tests do.
    privatePlaces: async () => ({ ok: true })
  }
  return { calls, overrides }
}

// The runner's own self-test proof for the stand-in, and a claim store made an hour ago (an order issued in the
// first two minutes of a brand-new store is refused by the runner's own rule, which is not what this test is about).
export async function plantRunnerProof(runnerState) {
  mkdirSync(runnerState, { recursive: true })
  const { keepProof } = await import(pathToFileURL(join(RUNNER_CODE, 'scripts', 'lib', 'mailbox', 'proof.mjs')).href)
  const { openStore } = await import(pathToFileURL(join(RUNNER_CODE, 'scripts', 'lib', 'mailbox', 'claims.mjs')).href)
  assert.equal(await keepProof({ stateDir: runnerState, codeDir: RUNNER_CODE, version: [2, 1, 290], file: FAKE_CLAUDE, now: () => Date.now() }), true)
  assert.equal((await openStore(runnerState, Date.now() - 3600_000)).ok, true)
}

export function raw(port, path, method = 'GET', headers = {}, body) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: response.headers }))
    })
    request.on('error', reject)
    request.end(body)
  })
}

// The student's board as Start Board brings it up, signed in through its own one-time link.
// `collector`: false (the real collector reads this computer's own sign-ins: never in a test) or test options.
export async function withStartedBoard(world, jobs, collector, run) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  let launcher = null
  const lines = []
  const started = await runStart({
    platform: process.platform,
    env: { ...process.env },
    home: world.base,
    stateDir: world.state,
    boardDir: world.board,
    basePort: 20000 + Math.floor(Math.random() * 8000),
    lingerMs: 20,
    openFile: async (file) => { launcher = readFileSync(file, 'utf8') },
    log: (text) => lines.push(String(text)),
    teamFolder: world.team,
    jobs,
    collector
  })
  try {
    const link = JSON.parse(/location\.replace\(("[^"]+")\)/.exec(launcher)[1])
    const url = new URL(link)
    const opened = await raw(started.port, url.pathname + url.search, 'GET', { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' })
    const auth = { cookie: String(opened.headers['set-cookie']).split(';')[0], token: /name="board-token" content="([\w-]+)"/.exec(opened.text)[1] }
    const api = (path, method = 'GET', body) => raw(started.port, path, method, {
      Cookie: auth.cookie,
      'x-board-token': auth.token,
      ...(method === 'GET' ? {} : { Origin: `http://127.0.0.1:${started.port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' })
    }, body === undefined ? undefined : JSON.stringify(body))
    await run({ started, api, lines })
  } finally {
    await started.close?.()
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
}

// Waits for the runner to have nothing left to do (a kick lands a moment after /api/fire has answered).
export async function settled(started, until = () => true) {
  for (let round = 0; round < 100; round += 1) {
    await started.jobs.idle()
    if (await until()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}
