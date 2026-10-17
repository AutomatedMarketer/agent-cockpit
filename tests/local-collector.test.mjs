// This computer's own numbers (task T8): the status collector run by the board, writing outside every repo, and the
// team folder reader laying those files over what git has. The real collector reads this computer's own sign-ins and
// starts every MCP server, so it is never run here: a stand-in collect-status.mjs in a throwaway code folder is run
// instead, by the board's own code path (this Node by its full path, from an empty folder, no shell).

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { findGit, folderRepo, isOverlayPath, readOverlay, statusFolder } from '../api/_repo.js'
import { COLLECT_TIMEOUT_MS, REFRESH_PATH, SAY, collectorPlacesFor, createCollector, freshAfterRefresh, prepareCollector, refreshHandler } from '../local/collector.mjs'
import { git, makeWorld, raw, withStartedBoard } from './helpers/local-runner-world.mjs'

const temp = (name) => realpathSync(mkdtempSync(join(tmpdir(), `${name}-`)))
const USAGE = '.agent-team/status/usage/this-computer.json'
const SECRET_NAMES = ['OPENAI_API_KEY', 'MAILBOX_SECRET', 'MAILBOX_KEY', 'VIEW_KEY', 'FIRE_KEY', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY']

// A code folder whose collect-status.mjs writes one usage file into --out and notes how it was started in --state-dir.
// `mode`: 'write' (exit 0), 'fail' (exit 1), 'hang' (never ends).
function stubCode(mode = 'write') {
  const code = temp('stub-code')
  mkdirSync(join(code, 'scripts'))
  writeFileSync(join(code, 'scripts', 'collect-status.mjs'), `
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
const value = (name) => args[args.indexOf(name) + 1]
mkdirSync(value('--state-dir'), { recursive: true })
appendFileSync(join(value('--state-dir'), 'record.jsonl'), JSON.stringify({ args, cwd: process.cwd(), env: Object.keys(process.env) }) + '\\n')
if (${JSON.stringify(mode)} === 'hang') setInterval(() => {}, 1000)
else if (${JSON.stringify(mode)} === 'fail') process.exit(1)
else {
  mkdirSync(join(value('--out'), '.agent-team', 'status', 'usage'), { recursive: true })
  writeFileSync(join(value('--out'), '.agent-team', 'status', 'usage', 'this-computer.json'), JSON.stringify({ schema: 'agent-status/usage/v1', computer: value('--computer'), n: Date.now() }) + '\\n')
}
`)
  return code
}
const records = (stateDir) => readFileSync(join(collectorPlacesFor(stateDir).stateDir, 'record.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))

// ---- the collector, kicked ----------------------------------------------------------------------------------

test('collector: run by this Node from an empty folder the board owns, writing outside every repo, with none of the board\'s secrets', async () => {
  const code = stubCode()
  const state = temp('collector-state')
  const team = temp('collector-team')
  const env = { ...process.env, OPENAI_API_KEY: 'sk-test', MAILBOX_SECRET: 'm'.repeat(40), MAILBOX_KEY: 'k'.repeat(40), VIEW_KEY: 'v', FIRE_KEY: 'f', GITHUB_TOKEN: 'g', ANTHROPIC_API_KEY: 'a' }
  let written = 0
  try {
    const collector = createCollector({ codeDir: code, stateDir: state, teamFolder: team, env, onWritten: () => { written += 1 } })
    const result = await collector.run(null)
    assert.deepEqual(result, { ok: true, code: 0 })
    assert.equal(written, 1)
    const [record] = records(state)
    assert.equal(realpathSync(record.cwd), realpathSync(collectorPlacesFor(state).cwd))
    assert.deepEqual(record.args.slice(0, 6), ['--computer', 'This computer', '--out', collectorPlacesFor(state).outDir, '--state-dir', collectorPlacesFor(state).stateDir])
    assert.equal(record.args.includes('--only'), false, 'every part on a full run')
    for (const name of SECRET_NAMES) assert.ok(!record.env.includes(name), `${name} reached the collector`)
    assert.ok(existsSync(join(collectorPlacesFor(state).outDir, ...USAGE.split('/'))))
    await collector.run(['usage'])
    assert.deepEqual(records(state)[1].args.slice(-2), ['--only', 'usage'])
  } finally {
    for (const folder of [code, state, team]) rmSync(folder, { recursive: true, force: true })
  }
})

test('collector: a Node program inside the team folder, the board or the code folder is never used', () => {
  const team = temp('collector-team')
  try {
    const planted = join(team, 'node.exe')
    assert.throws(() => createCollector({ codeDir: temp('code'), stateDir: temp('state'), teamFolder: team, nodePath: planted }), /does not trust/)
    assert.throws(() => createCollector({ codeDir: temp('code'), stateDir: temp('state'), teamFolder: team, nodePath: 'node' }), /full path/)
  } finally {
    rmSync(team, { recursive: true, force: true })
  }
})

test('collector: one run at a time; Refresh now during a run is not lost (one full run follows); a failed run writes nothing new', async () => {
  const code = stubCode()
  const state = temp('collector-state')
  try {
    const collector = createCollector({ codeDir: code, stateDir: state, teamFolder: temp('team') })
    const first = collector.run(['usage'])
    assert.equal(collector.refresh(), 'busy')
    assert.equal(collector.refresh(), 'busy')
    await first
    await collector.idle()
    const seen = records(state)
    assert.equal(seen.length, 2, 'the refreshes while it ran became exactly one more run')
    assert.equal(seen[1].args.includes('--only'), false, 'and that one is a full run')
    assert.equal(collector.refresh(), 'started')
    await collector.idle()
    assert.equal(records(state).length, 3)
  } finally {
    rmSync(code, { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  }
  const failing = stubCode('fail')
  const other = temp('collector-state')
  try {
    let written = 0
    const collector = createCollector({ codeDir: failing, stateDir: other, teamFolder: temp('team'), onWritten: () => { written += 1 } })
    assert.deepEqual(await collector.run(null), { ok: false, code: 1 })
    assert.equal(written, 0)
  } finally {
    rmSync(failing, { recursive: true, force: true })
    rmSync(other, { recursive: true, force: true })
  }
})

test('collector: a run that does not end is stopped at its time limit, and stop() ends a running one', async () => {
  assert.equal(COLLECT_TIMEOUT_MS, 240_000)
  const code = stubCode('hang')
  const state = temp('collector-state')
  try {
    const collector = createCollector({ codeDir: code, stateDir: state, teamFolder: temp('team'), timeoutMs: 1500 })
    const started = Date.now()
    const result = await collector.run(['usage'])
    assert.equal(result.ok, false)
    assert.ok(Date.now() - started < 20_000)
    const again = collector.run(['usage'])
    await new Promise((resolve) => setTimeout(resolve, 300))
    await collector.stop()
    assert.equal((await again).ok, false)
    assert.equal(collector.refresh(), 'busy', 'nothing starts after stop()')
  } finally {
    rmSync(code, { recursive: true, force: true })
    rmSync(state, { recursive: true, force: true })
  }
})

test('collector: off (Refresh now says so) when the code folder is missing or touches the team folder, and the overlay setting is removed', async () => {
  const world = makeWorld()
  try {
    const lines = []
    const env = { REPO_STATUS_FOLDER: '/somewhere/else' }
    assert.equal(await prepareCollector({ boardDir: world.board, stateDir: world.state, teamFolder: world.team, env, log: (line) => lines.push(line) }), null)
    assert.equal(env.REPO_STATUS_FOLDER, undefined)
    assert.deepEqual(lines, [SAY.off])
    const inside = join(world.team, 'runner-code')
    mkdirSync(join(inside, 'scripts'), { recursive: true })
    writeFileSync(join(inside, 'scripts', 'collect-status.mjs'), 'throw new Error("never run")\n')
    assert.equal(await prepareCollector({ boardDir: world.board, stateDir: world.state, teamFolder: world.team, env, codeDir: inside, log: () => {} }), null)
  } finally {
    world.done()
  }
})

// ---- Refresh now ------------------------------------------------------------------------------------------

function fakeResponse() {
  return { statusCode: 200, headers: {}, sent: null, setHeader(name, value) { this.headers[name] = value }, status(code) { this.statusCode = code; return this }, json(value) { this.sent = value; return this } }
}

test('Refresh now: POST { action: "refresh" } only; answers at once; says plainly when nothing is collected', async () => {
  let refreshed = 0
  const handler = refreshHandler({ refresh: () => { refreshed += 1; return refreshed === 1 ? 'started' : 'busy' } })
  const ask = async (method, body) => {
    const response = fakeResponse()
    await handler({ method, body }, response)
    return response
  }
  assert.equal((await ask('GET')).statusCode, 405)
  for (const body of [undefined, null, [], 'refresh', {}, { action: 'other' }, { action: 'refresh', parts: 'all' }]) assert.equal((await ask('POST', body)).statusCode, 400, JSON.stringify(body))
  assert.equal(refreshed, 0)
  const started = await ask('POST', { action: 'refresh' })
  assert.equal(started.statusCode, 202)
  assert.deepEqual(started.sent, { ok: true, result: 'started', say: SAY.started })
  assert.equal(started.headers['Cache-Control'], 'no-store')
  assert.equal((await ask('POST', { action: 'refresh' })).sent.result, 'busy')
  const off = fakeResponse()
  await refreshHandler(null)({ method: 'POST', body: { action: 'refresh' } }, off)
  assert.equal(off.statusCode, 503)
  assert.equal(off.sent.error, SAY.off)
})

test('/api/state after a refresh: the page\'s 60-second check is answered in full once, then "unchanged" again', async () => {
  const fresh = freshAfterRefresh()
  const seen = []
  const state = fresh.wrapHandler('state', async (request, response) => {
    seen.push({ since: request.query.since, url: request.url })
    return response.status(200).json(request.query.since ? { unchanged: true, commit: 'c' } : { commit: 'c', board: true })
  })
  assert.equal(fresh.wrapHandler('fire', state), state, 'only /api/state is touched')
  const poll = async () => {
    const response = fakeResponse()
    await state({ query: { since: 'c' }, url: '/api/state?since=c' }, response)
    return response.sent
  }
  assert.deepEqual(await poll(), { unchanged: true, commit: 'c' }, 'before any refresh the check is left alone')
  fresh.bump()
  assert.deepEqual(await poll(), { commit: 'c', board: true })
  assert.equal(seen[1].url, '/api/state')
  assert.deepEqual(await poll(), { unchanged: true, commit: 'c' })
})

// ---- the overlay -----------------------------------------------------------------------------------------

const GIT = findGit()
const hashOf = (text) => execFileSync(GIT, ['hash-object', '--stdin'], { input: text, encoding: 'utf8' }).trim()

function overlayWorld() {
  const world = makeWorld()
  const out = join(world.base, 'status')
  const put = (relative, text) => {
    mkdirSync(dirname(join(out, ...relative.split('/'))), { recursive: true })
    writeFileSync(join(out, ...relative.split('/')), text)
  }
  return { ...world, out, put }
}

test('overlay: only the collector\'s own paths are laid over the repo; never a mailbox file, an agent, a link, a big file or a name off the list', async () => {
  const world = overlayWorld()
  try {
    world.put(USAGE, '{"mine":true}\n')
    world.put('.agent-team/status/connections/this-computer.json', '{"c":1}\n')
    world.put('runs/heartbeat/hermes.json', '{"h":1}\n')
    world.put('.agent-team/status/mailbox/this-computer.json', '{"fake":"order"}\n')
    world.put('.claude/agents/research.md', 'planted agent\n')
    world.put('.agent-team/status/usage/notes.txt', 'x\n')
    world.put('.agent-team/status/usage/-dash.json', '{}\n')
    world.put('.agent-team/status/jobs/big.json', 'x'.repeat(600 * 1024))
    const files = await readOverlay(world.out)
    assert.deepEqual([...files.keys()].sort(), ['.agent-team/status/connections/this-computer.json', USAGE, 'runs/heartbeat/hermes.json'].sort())
    for (const path of ['.agent-team/status/mailbox/x.json', '.claude/agents/research.md', '.agent-team/status/usage/../x.json', '.agent-team/status/usage/a/b.json', 'runs/heartbeat/other.json']) assert.equal(isOverlayPath(path), false, path)

    const reader = folderRepo(world.team, { overlay: world.out })
    const listing = await reader.tree('main')
    const laid = listing.tree.find((entry) => entry.path === USAGE)
    assert.deepEqual(laid, { path: USAGE, type: 'blob', mode: '100644', sha: hashOf('{"mine":true}\n'), size: 14 })
    assert.equal(listing.tree.some((entry) => entry.path.includes('mailbox')), false)
    assert.equal(listing.tree.find((entry) => entry.path === '.claude/agents/research.md').sha, hashOf(readFileSync(join(world.team, '.claude', 'agents', 'research.md'))), 'the repo\'s own agent, not the planted one')
    assert.equal(await reader.file('main', USAGE), '{"mine":true}\n')
    assert.notEqual(await reader.file('main', '.claude/agents/research.md'), 'planted agent\n')
    assert.equal(await reader.file('main', '.agent-team/status/mailbox/this-computer.json'), null)
    // The tree git gave is kept as git gave it: a new read with no overlay file shows none.
    rmSync(world.out, { recursive: true, force: true })
    assert.equal((await reader.tree('main')).tree.some((entry) => entry.path === USAGE), false)
  } finally {
    world.done()
  }
})

test('overlay: a folder or file on the way that is a link is not followed', async () => {
  const world = overlayWorld()
  const elsewhere = temp('elsewhere')
  try {
    mkdirSync(join(elsewhere, 'usage'), { recursive: true })
    writeFileSync(join(elsewhere, 'usage', 'this-computer.json'), '{"from":"elsewhere"}\n')
    mkdirSync(join(world.out, '.agent-team', 'status'), { recursive: true })
    try {
      symlinkSync(join(elsewhere, 'usage'), join(world.out, '.agent-team', 'status', 'usage'), 'junction')
    } catch {
      return // no right to make links here: nothing to test
    }
    assert.equal((await readOverlay(world.out)).size, 0)
    rmSync(world.out, { recursive: true, force: true })
    symlinkSync(elsewhere, world.out, 'junction')
    assert.equal((await readOverlay(world.out)).has(USAGE), false)
  } finally {
    world.done()
    rmSync(elsewhere, { recursive: true, force: true })
  }
})

test('overlay: only in folder mode, and only from REPO_STATUS_FOLDER as a full path (the website never sets it)', () => {
  assert.equal(statusFolder({}), null)
  assert.equal(statusFolder({ REPO_STATUS_FOLDER: 'relative/status' }), null)
  assert.equal(statusFolder({ REPO_STATUS_FOLDER: join(tmpdir(), 'status') }), join(tmpdir(), 'status'))
  // The only reader of the setting is the folder reader (api/_repo.js), which only exists when REPO_SOURCE=folder.
  const source = readFileSync(new URL('../api/_repo.js', import.meta.url), 'utf8')
  assert.equal(source.match(/REPO_STATUS_FOLDER/g).length, 4, 'read in one place (statusFolder) only')
  for (const file of ['state.js', 'fire.js', 'file.js', 'graph.js', '_lib.js']) {
    assert.equal(readFileSync(new URL(`../api/${file}`, import.meta.url), 'utf8').includes('REPO_STATUS_FOLDER'), false, file)
  }
})

// ---- the board, with this computer's numbers ----------------------------------------------------------------

test('through the board: the collector runs at start, its file shows on /api/state, and Refresh now needs the board\'s own page', { timeout: 60_000 }, async () => {
  const world = makeWorld()
  const code = stubCode()
  try {
    await withStartedBoard(world, false, { codeDir: code }, async ({ started, api }) => {
      assert.ok(started.collector, 'the collector did not come on')
      await started.collector.idle()
      const first = JSON.parse((await api('/api/state')).text)
      assert.equal(first.usage.read, 1, JSON.stringify(first.usage))
      assert.ok(existsSync(join(world.state, 'status', ...USAGE.split('/'))))
      assert.equal(git(world.team, 'status', '--porcelain'), '', 'nothing was written into the team folder')

      // The page's 60-second check, after a refresh: once in full, then "unchanged".
      assert.equal(JSON.parse((await api(`/api/state?since=${first.commit}`)).text).unchanged, true)
      const refreshed = await api(REFRESH_PATH, 'POST', { action: 'refresh' })
      assert.equal(refreshed.status, 202, refreshed.text)
      await started.collector.idle()
      assert.equal(JSON.parse((await api(`/api/state?since=${first.commit}`)).text).unchanged, undefined)
      assert.equal(JSON.parse((await api(`/api/state?since=${first.commit}`)).text).unchanged, true)

      // Without the page's key, or from another page, Refresh now is refused by the wall.
      const port = started.port
      const noKey = await raw(port, REFRESH_PATH, 'POST', { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` }, JSON.stringify({ action: 'refresh' }))
      assert.equal(noKey.status, 401)
    })
  } finally {
    world.done()
    rmSync(code, { recursive: true, force: true })
  }
})

test('the Settings box has Refresh now: it posts { action: "refresh" } to the board\'s own address and shows only text', () => {
  const source = readFileSync(new URL('../local/page/settings-ui.js', import.meta.url), 'utf8')
  assert.ok(source.includes("make('button', { type: 'button', id: 'board-numbers-refresh' }, 'Refresh now')"))
  assert.ok(source.includes("fetch('/api/local-refresh', { method: 'POST'"))
  assert.ok(source.includes("JSON.stringify({ action: 'refresh' })"))
  assert.equal(/innerHTML|insertAdjacentHTML|outerHTML\s*=/.test(source), false)
  assert.equal(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').includes('local-refresh'), false, 'the website page knows nothing of it')
})
