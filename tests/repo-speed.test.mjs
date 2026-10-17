// Reading a team repo from a folder must not cost one git program per file: on a repo of about 300 files the
// board took 15 seconds to load. Files are read through one long-lived `git cat-file --batch` process,
// and what was read at a commit is kept (a commit never changes).

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { findGit, folderRepo, gitProcessesStarted, closeBatchReaders } from '../api/_repo.js'
import stateHandler from '../api/state.js'

const GIT = findGit()
const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_'))), GIT_TERMINAL_PROMPT: '0' }
// Windows (a virus scanner, the search indexer) now and then holds a freshly written git object for a moment and
// git says "Permission denied": the same command a moment later works. Only the test's own setup retries.
const NL = String.fromCharCode(10)
const git = (cwd, ...args) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return execFileSync(GIT, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    } catch (error) {
      if (attempt >= 6 || !/Permission denied/.test(String(error.stderr))) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
    }
  }
}

// About 300 files, laid out the way a team repo is. Written with `git fast-import` in one go (adding 300 files
// one at a time takes half a minute on Windows); the reader only ever reads commits, so no files are checked out.
function importCommit(work, files, message, first) {
  const chunks = []
  const add = (text) => chunks.push(Buffer.from(text))
  add(`commit refs/heads/main
committer T <t@example.com> ${Math.floor(Date.now() / 1000)} +0000
data ${Buffer.byteLength(message)}
${message}
`)
  if (!first) add(`from refs/heads/main^0
`)
  for (const [name, text] of Object.entries(files)) {
    add(`M 644 inline ${name}
data ${Buffer.byteLength(text)}
`)
    add(text)
    add(NL)
  }
  execFileSync(GIT, ['fast-import', '--quiet'], { cwd: work, env: gitEnv, input: Buffer.concat(chunks) })
}

function makeBigRepo() {
  const base = mkdtempSync(path.join(tmpdir(), 'cockpit-speed-'))
  const work = path.join(base, 'team')
  mkdirSync(work)
  git(work, 'init', '-q', '-b', 'main')
  const files = {}
  files['shared/about-me.md'] = '# About me' + NL + '<!-- fill: full-name -->' + NL
  for (let n = 0; n < 100; n += 1) files[`.claude/agents/agent-${n}.md`] = `---
name: agent-${n}
description: Does job ${n}.
model: sonnet
---

You are agent ${n}.
`
  for (let n = 0; n < 100; n += 1) files[`workflows/flow-${n}.yml`] = `name: Flow ${n}
owner: agent-${n % 100}
steps: [one]
trigger:
  schedule: "weekly mon 06:00"
  fire: true
output: inbox/{date}.md
`
  for (let n = 0; n < 60; n += 1) files[`tasks/2026-08-${String(1 + (n % 28)).padStart(2, '0')}-task-${n}.md`] = `---
status: todo
for: agent-${n}
---

# Task ${n}

Do it.
`
  for (let n = 0; n < 40; n += 1) files[`skills/skill-${n}/SKILL.md`] = `---
name: skill-${n}
description: Skill ${n}.
---
`
  importCommit(work, files, 'first', true)
  return {
    base, work, sha: () => git(work, 'rev-parse', 'refs/heads/main'),
    commit: (name, text) => { importCommit(work, { [name]: text }, 'more', false); return git(work, 'rev-parse', 'refs/heads/main') },
    done: async () => {
      // A stopped git program can hold the folder for a few seconds on Windows: try again, then let it go.
      for (let attempt = 0; attempt < 24; attempt += 1) {
        try { rmSync(base, { recursive: true, force: true }); return } catch { await new Promise((resolve) => setTimeout(resolve, 250)) }
      }
    }
  }
}

function fakeResponse() {
  return { statusCode: null, body: null, headers: {}, setHeader(key, value) { this.headers[key] = value }, status(code) { this.statusCode = code; return this }, json(payload) { this.body = payload; return this }, end() { return this } }
}
async function loadState(repo, query = {}) {
  const previous = { ...process.env }
  Object.assign(process.env, { PUBLIC_DASHBOARD: 'true', REPO_SOURCE: 'folder', REPO_FOLDER: repo.work })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('no network in this test') }
  try {
    const response = fakeResponse()
    const started = gitProcessesStarted()
    const at = performance.now()
    await stateHandler({ method: 'GET', headers: {}, query }, response)
    return { response, spawned: gitProcessesStarted() - started, ms: performance.now() - at }
  } finally {
    globalThis.fetch = originalFetch
    process.env = previous
  }
}

test('/api/state on about 300 files starts a handful of git programs, not one per file, and is quick', async () => {
  const repo = makeBigRepo()
  try {
    const first = await loadState(repo)
    assert.equal(first.response.statusCode, 200, JSON.stringify(first.response.body)?.slice(0, 200))
    assert.ok(first.response.body.agents.length >= 100, `only ${first.response.body.agents?.length} agents were read`)
    assert.ok(first.spawned <= 8, `the first load started ${first.spawned} git programs`)
    // The program count above is the real proof; time only catches a hang, because the whole suite runs this beside hundreds of other tests (7.7 s seen under that load, 0.8 s alone).
    assert.ok(first.ms < 20000, `the first load took ${Math.round(first.ms)} ms`)
    const again = await loadState(repo)
    if (process.env.BOARD_BENCH) console.log(`BENCH first ${Math.round(first.ms)} ms, ${first.spawned} git programs; repeat ${Math.round(again.ms)} ms, ${again.spawned} git programs`)
    assert.equal(again.response.statusCode, 200)
    assert.ok(again.spawned <= 1, `a second load at the same commit started ${again.spawned} git programs`)
    assert.ok(again.ms < 300, `the second load took ${Math.round(again.ms)} ms`)
    assert.deepEqual(JSON.stringify(again.response.body.agents), JSON.stringify(first.response.body.agents), 'the repeat showed something different')
  } finally {
    closeBatchReaders()
    await repo.done()
  }
})

test('a new commit is read fresh: the cache is by commit, never by name', async () => {
  const repo = makeBigRepo()
  try {
    const one = await loadState(repo)
    const before = one.response.body.agents.find((agent) => agent.slug === 'agent-3')
    assert.ok(before)
    const head = repo.commit('.claude/agents/agent-3.md', '---\nname: agent-3\ndescription: Changed on purpose.\nmodel: opus\n---\n\nYou are agent three, changed.\n')
    await new Promise((resolve) => setTimeout(resolve, 2200)) // the board looks at the branch again after a moment
    const two = await loadState(repo)
    const after = two.response.body.agents.find((agent) => agent.slug === 'agent-3')
    assert.notEqual(JSON.stringify(after), JSON.stringify(before), 'the change was not seen')
    assert.equal(two.response.body.commit ?? head, head)
  } finally {
    closeBatchReaders()
    await repo.done()
  }
})

test('the batch reader answers files, missing files, big files and blobs by id exactly as the one-at-a-time way did', async () => {
  const repo = makeBigRepo()
  try {
    const team = folderRepo(repo.work)
    const head = await team.head('main')
    assert.equal(await team.file(head, 'shared/about-me.md'), '# About me\n<!-- fill: full-name -->\n')
    assert.equal(await team.file(head, 'nope/missing.md'), null)
    assert.equal(await team.file(head, '.claude/agents'), null, 'a folder is not a file')
    assert.equal(await team.file(head, '../x'), null)
    const listed = await team.tree(head)
    const entry = listed.tree.find((one) => one.path === '.claude/agents/agent-7.md')
    assert.match(await team.blob(entry.sha), /You are agent 7\./)
    assert.equal(await team.blob('0'.repeat(40)), null, 'an id the listing never named')
    // Many at once, in any order, each gets its own answer.
    const paths = Array.from({ length: 40 }, (_, n) => `.claude/agents/agent-${(n * 7) % 100}.md`)
    const texts = await Promise.all(paths.map((one) => team.file(head, one)))
    texts.forEach((text, index) => assert.match(text, new RegExp(`You are agent ${(index * 7) % 100}\\.`)))
    assert.ok(gitProcessesStarted() > 0)
  } finally {
    closeBatchReaders()
    await repo.done()
  }
})

test('the batch process is one program, started with the same safe options, and stops when told to', async () => {
  const repo = makeBigRepo()
  try {
    const team = folderRepo(repo.work)
    const head = await team.head('main')
    const before = gitProcessesStarted()
    for (let n = 0; n < 50; n += 1) await team.file(head, `.claude/agents/agent-${n}.md`)
    assert.ok(gitProcessesStarted() - before <= 1, `${gitProcessesStarted() - before} programs for 50 files`)
    closeBatchReaders()
    const after = gitProcessesStarted()
    assert.equal(await team.file(head, '.claude/agents/agent-3.md') !== null, true)
    assert.equal(gitProcessesStarted() - after, 0, 'the file was in the cache, so no program was needed')
    assert.equal(await team.file(head, '.claude/agents/agent-99.md') !== null, true)
    assert.equal(gitProcessesStarted() - after, 1, 'a new file after a stop starts the reader once')
  } finally {
    closeBatchReaders()
    await repo.done()
  }
})
