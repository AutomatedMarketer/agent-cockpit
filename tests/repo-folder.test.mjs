// Reading the team repo from a git folder (Student Edition): real git, real temporary repos.
// What the board may see is what is committed on the pushed branch - nothing else - and nothing a
// request or the environment says can turn into an option for git.

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  repoFolder,
  folderRepo,
  isBranchName,
  isRepoPath,
  githubNames,
  gitEnvironment,
  runGit,
  gitCallsRunning,
  FETCH_EVERY_MS,
  REMOTE_RECHECK_MS,
  FOLDER_UNREADABLE,
  FOLDER_NOTES,
  findGit,
  isInside
} from '../api/_repo.js'
import stateHandler, { headCommit, rawFile, repoTree, config, namedFromOrigin, folderNote } from '../api/state.js'
import fileHandler from '../api/file.js'
import graphHandler from '../api/graph.js'
import fireHandler from '../api/fire.js'
import { readMacStatus } from '../api/_orders.js'
import { noteByFingerprint } from '../api/_memory-meaning.js'
import { shapeMailbox, MAILBOX_FOLDER } from '../api/state.js'

/* ---------- a repo to read ---------- */

const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_'))), GIT_TERMINAL_PROMPT: '0' }
// The test's own git is found the way the board finds it, so a program planted in a repo folder cannot answer for it either.
const GIT = findGit()
const git = (cwd, ...args) =>
  execFileSync(GIT, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const FILES = {
  '.claude/agents/research.md': '---\nname: research\ndescription: Finds things out.\nmodel: sonnet\n---\n\nYou are the research agent.\n',
  'workflows/monday-brief.yml':
    'name: Monday Brief\nowner: research\nsteps: [write-brief]\ntrigger:\n  schedule: "weekly mon 06:00"\n  fire: true\noutput: inbox/{date}/monday-brief.md\n',
  'tasks/2026-08-18-call-supplier.md': '---\nstatus: todo\nfor: research\n---\n\n# Call the supplier\n\nAsk about lead time.\n',
  'shared/about-me.md': '# About me\n<!-- fill: full-name -->\n',
  'notes/with space.md': 'spaced\n',
  'skills/write-brief/SKILL.md': '---\nname: write-brief\ndescription: Writes the brief.\n---\n'
}

// A work folder cloned from a bare "GitHub" folder, both made fresh. `files` are committed and pushed.
// The address the folder's origin is given, so the board treats it as GitHub; insteadOf sends the
// actual traffic to a bare folder beside it, so no test touches the network.
const GITHUB_URL = 'https://github.com/someone/my-agent-team.git'

function makeRepo(files = FILES, { remote = true, origin = GITHUB_URL } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'cockpit-repo-'))
  const work = path.join(base, 'team')
  const bare = path.join(base, 'github.git')
  mkdirSync(work)
  git(work, 'init', '-q', '-b', 'main')
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(work, name)), { recursive: true })
    writeFileSync(path.join(work, name), text)
  }
  git(work, 'add', '-A')
  git(work, 'commit', '-q', '-m', 'first')
  if (remote) {
    git(base, 'init', '-q', '--bare', '-b', 'main', bare)
    git(work, 'remote', 'add', 'origin', origin)
    git(work, 'config', `url.${bare}.insteadOf`, origin)
    git(work, 'push', '-q', 'origin', 'main')
  }
  return {
    base, work, bare,
    sha: () => git(work, 'rev-parse', 'HEAD'),
    commit: (name, text, message = 'change') => {
      mkdirSync(path.dirname(path.join(work, name)), { recursive: true })
      writeFileSync(path.join(work, name), text)
      git(work, 'add', '-A')
      git(work, 'commit', '-q', '-m', message)
      return git(work, 'rev-parse', 'HEAD')
    },
    push: () => git(work, 'push', '-q', 'origin', 'main'),
    done: () => rmSync(base, { recursive: true, force: true })
  }
}

// A reader whose clock the test moves, and that records every git call it makes.
function reader(repo) {
  const clock = { t: 1_000_000 }
  const calls = []
  const spy = async (args, options) => {
    calls.push(args)
    return runGit(args, options)
  }
  return { repo: folderRepo(repo.work, { run: spy, now: () => clock.t }), clock, calls }
}
const fetches = (calls) => calls.filter((args) => args[0] === 'fetch').length

/* ---------- reading what is committed and pushed ---------- */

test('the head, the tree and a file are what the remote has: sizes, ids, spaces in names and missing files', async () => {
  const repo = makeRepo()
  try {
    const { repo: team } = reader(repo)
    const head = await team.head('main')
    assert.equal(head, repo.sha())
    const { tree } = await team.tree(head)
    const byPath = Object.fromEntries(tree.map((node) => [node.path, node]))
    assert.deepEqual(Object.keys(byPath).sort(), Object.keys(FILES).sort())
    assert.equal(byPath['shared/about-me.md'].size, Buffer.byteLength(FILES['shared/about-me.md']))
    assert.equal(byPath['shared/about-me.md'].type, 'blob')
    assert.match(byPath['shared/about-me.md'].sha, /^[0-9a-f]{40}$/)
    assert.equal(await team.file(head, 'notes/with space.md'), 'spaced\n')
    assert.equal(await team.file('main', 'workflows/monday-brief.yml'), FILES['workflows/monday-brief.yml'], 'a branch name works as a ref')
    assert.equal(await team.file(head, 'nothing/here.md'), null)
    assert.equal(await team.file(head, 'workflows'), null, 'a folder is not a file')
  } finally {
    repo.done()
  }
})

test('files you changed but have not committed, staged, untracked, or committed but not pushed are never seen', async () => {
  const repo = makeRepo()
  try {
    const { repo: team, clock } = reader(repo)
    const pushed = await team.head('main')
    writeFileSync(path.join(repo.work, 'shared/about-me.md'), 'EDITED, NOT COMMITTED')
    writeFileSync(path.join(repo.work, 'untracked.md'), 'untracked')
    writeFileSync(path.join(repo.work, 'staged.md'), 'staged only')
    git(repo.work, 'add', 'staged.md')
    assert.equal(await team.file(pushed, 'shared/about-me.md'), FILES['shared/about-me.md'])
    assert.equal(await team.file('main', 'shared/about-me.md'), FILES['shared/about-me.md'])
    for (const hidden of ['untracked.md', 'staged.md']) {
      assert.equal(await team.file(pushed, hidden), null, hidden)
      assert.ok(!(await team.tree(pushed)).tree.some((node) => node.path === hidden), hidden)
    }
    // Committed in the folder but not pushed: the branch the board reads has not moved.
    repo.commit('local-only.md', 'not pushed')
    clock.t += FETCH_EVERY_MS + 1
    assert.equal(await team.head('main'), pushed)
    assert.equal(await team.file('main', 'local-only.md'), null)
    // Someone else (another clone) pushes: the board sees it after the next allowed fetch, not before.
    const other = path.join(repo.base, 'other')
    git(repo.base, 'clone', '-q', repo.bare, other)
    writeFileSync(path.join(other, 'from-other.md'), 'pushed by another computer')
    git(other, 'add', '-A')
    git(other, 'commit', '-q', '-m', 'other')
    git(other, 'push', '-q', 'origin', 'main')
    assert.equal(await team.head('main'), pushed, 'within the throttle, no new fetch yet')
    clock.t += FETCH_EVERY_MS + 1
    const moved = await team.head('main')
    assert.equal(moved, git(other, 'rev-parse', 'HEAD'))
    assert.equal(await team.file('main', 'from-other.md'), 'pushed by another computer')
    assert.equal(await team.file('main', 'local-only.md'), null, 'the unpushed commit is still not shown')
  } finally {
    repo.done()
  }
})

test('a blob is read by id only if the last tree named it', async () => {
  const repo = makeRepo()
  try {
    const { repo: team } = reader(repo)
    const head = await team.head('main')
    assert.equal(await team.blob('0'.repeat(40)), null, 'before any tree, nothing is known')
    const { tree } = await team.tree(head)
    const note = tree.find((node) => node.path === 'shared/about-me.md')
    assert.equal(await team.blob(note.sha), FILES['shared/about-me.md'])
    // A staged file is in git's object store but in no pushed tree.
    writeFileSync(path.join(repo.work, 'secret.md'), 'staged secret')
    git(repo.work, 'add', 'secret.md')
    const stagedId = git(repo.work, 'rev-parse', ':secret.md')
    assert.equal(await team.blob(stagedId), null)
    assert.equal(await team.blob(note.sha.toUpperCase()), null)
    for (const bad of ['', 'main', '-h', '--help', `${note.sha}\n--x`, `${note.sha}:path`, 'HEAD:secret.md', 42, null]) {
      assert.equal(await team.blob(bad), null, String(bad))
    }
  } finally {
    repo.done()
  }
})

test('one fetch every thirty seconds however often the board asks, and a failed fetch keeps the last answer', async () => {
  const repo = makeRepo()
  try {
    const { repo: team, clock, calls } = reader(repo)
    const first = await team.head('main')
    await Promise.all(Array.from({ length: 8 }, () => team.head('main')))
    for (let n = 0; n < 5; n += 1) await team.head('main')
    assert.equal(fetches(calls), 1)
    clock.t += FETCH_EVERY_MS - 1
    await team.head('main')
    assert.equal(fetches(calls), 1, 'still inside the thirty seconds')
    clock.t += 2
    await team.head('main')
    assert.equal(fetches(calls), 2)
    // The remote goes away (offline, signed out): the board keeps what it last fetched.
    rmSync(repo.bare, { recursive: true, force: true })
    clock.t += FETCH_EVERY_MS + 1
    assert.equal(await team.head('main'), first)
    assert.equal(fetches(calls), 3, 'it did try')
  } finally {
    repo.done()
  }
})

test('with no origin at all the folder is read at its own branch, and a folder with an origin never is', async () => {
  const lonely = makeRepo(FILES, { remote: false })
  const normal = makeRepo()
  try {
    const { repo: team, calls } = reader(lonely)
    assert.equal(await team.hasOrigin(), false)
    assert.equal(await team.head('main'), lonely.sha())
    assert.equal(fetches(calls), 0, 'nothing to fetch from')
    assert.equal(await team.head('no-such-branch'), null)
    const { repo: other } = reader(normal)
    assert.equal(await other.hasOrigin(), true)
    assert.equal(await other.head('no-such-branch'), null)
    normal.commit('x.md', 'unpushed')
    assert.notEqual(await other.head('main'), normal.sha(), 'a folder with a remote is read at the remote')
  } finally {
    lonely.done()
    normal.done()
  }
})

test('a folder that is not a git repo, or not there, reads as nothing and the tree says so in a sentence', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'cockpit-notrepo-'))
  try {
    const team = folderRepo(base)
    assert.equal(await team.head('main'), null)
    await assert.rejects(team.tree('main'), (error) => error.ours === true && error.message === FOLDER_UNREADABLE)
    assert.equal(await team.file('main', 'a.md'), null)
    const gone = folderRepo(path.join(base, 'nope'))
    assert.equal(await gone.head('main'), null)
    await assert.rejects(gone.tree('main'), (error) => error.message === FOLDER_UNREADABLE)
    assert.throws(() => folderRepo('relative/path'))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a file over the output limit is left out like a missing one, not an error for the whole board', async () => {
  const repo = makeRepo({ ...FILES, 'big.md': 'x'.repeat(2000) })
  try {
    const spy = (args, options) => runGit(args, { ...options, maxBuffer: 1000 })
    const team = folderRepo(repo.work, { run: spy })
    const head = await team.head('main')
    assert.equal(await team.file(head, 'big.md'), null)
    assert.equal(await team.file(head, 'shared/about-me.md'), FILES['shared/about-me.md'])
  } finally {
    repo.done()
  }
})

test('a link stored in the repo is not listed as a file, and a submodule folder is not read', async () => {
  const repo = makeRepo()
  try {
    const target = execFileSync(GIT, ['hash-object', '-w', '--stdin'], { cwd: repo.work, env: gitEnv, input: '/etc/passwd', encoding: 'utf8' }).trim()
    git(repo.work, 'update-index', '--add', '--cacheinfo', `120000,${target},evil-link.md`)
    git(repo.work, 'update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},vendor/sub`)
    git(repo.work, 'commit', '-q', '-m', 'link')
    repo.push()
    const { repo: team } = reader(repo)
    const head = await team.head('main')
    const { tree } = await team.tree(head)
    assert.ok(!tree.some((node) => node.path === 'evil-link.md'), 'a link was listed as a file')
    assert.ok(!tree.some((node) => node.path.startsWith('vendor/')), 'a submodule was listed')
    assert.ok(tree.some((node) => node.path === 'shared/about-me.md'))
  } finally {
    repo.done()
  }
})

/* ---------- nothing a request says becomes an option ---------- */

test('branch names and paths that could be options, ranges or tricks never reach git', async () => {
  const repo = makeRepo()
  try {
    const { repo: team, calls } = reader(repo)
    const head = await team.head('main')
    const before = calls.length
    const badBranches = [
      '--upload-pack=touch PWNED', '-x', '--output=PWNED', 'a..b', 'main;touch PWNED', 'main && x', 'a b', '', '.hidden', 'x/.y',
      'main^{tree}', 'main@{1}', 'HEAD~1', 'main:file', 'a//b', 'a/', 'a.lock', 'x/y.lock/z', '/abs', 'é', 'a\nb', 'a\0b', '$(x)', '`x`', 'a*', 'a?', 'a[0]',
      'a'.repeat(101), 42, null, undefined, {}, ['main']
    ]
    for (const bad of badBranches) {
      assert.equal(isBranchName(bad), false, JSON.stringify(bad))
      assert.equal(await team.head(bad), null, JSON.stringify(bad))
    }
    const badPaths = ['', '/etc/passwd', '../x', 'a/../b', './a', 'a/./b', 'a//b', 'a\\b', 'a\0b', 'a\nb', 'a\rb', 'a\u001fb', 'a/', '/', 'x'.repeat(501), 42, null, undefined, {}]
    for (const bad of badPaths) {
      assert.equal(isRepoPath(bad), false, JSON.stringify(bad))
      assert.equal(await team.file(head, bad), null, JSON.stringify(bad))
    }
    assert.equal(calls.length, before, 'a refused name never started git at all')
    await assert.rejects(team.tree('--output=PWNED'), (error) => error.message === FOLDER_UNREADABLE)
    for (const good of ['main', 'release/2026-10', 'feature_1.2', 'A-b.c']) assert.equal(isBranchName(good), true, good)
    assert.ok(!existsSync(path.join(repo.work, 'PWNED')) && !existsSync('PWNED') && !existsSync(path.join(repo.base, 'PWNED')))
  } finally {
    repo.done()
  }
})

test('a ref that is not a whole lower-case commit id is a branch name, never a revision expression', async () => {
  const repo = makeRepo()
  try {
    const { repo: team, calls } = reader(repo)
    const head = await team.head('main')
    const before = calls.length
    for (const notCommit of [head.toUpperCase(), head.slice(0, 39), `${head}0`, `${head}^`, `${head}~1`, `${head}:shared/about-me.md`, 'HEAD', 'main~1']) {
      assert.equal(await team.file(notCommit, 'shared/about-me.md'), null, notCommit)
    }
    // Every git call those made had a fixed shape: rev-parse of a refs/remotes name, never the text.
    for (const args of calls.slice(before)) {
      assert.equal(args[0], 'rev-parse')
      assert.match(args.at(-1), /^refs\/remotes\/origin\/[A-Za-z0-9._/-]+\^\{commit\}$/)
    }
  } finally {
    repo.done()
  }
})

test('a request-controlled name cannot make git run a program, even from a repo whose own config asks for one', async () => {
  const repo = makeRepo()
  try {
    const marker = path.join(repo.base, 'RAN')
    // The repo's own config names programs git would run for a fetch or status check.
    git(repo.work, 'config', 'core.fsmonitor', `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')"`)
    git(repo.work, 'config', 'core.sshCommand', 'false')
    const { repo: team } = reader(repo)
    const head = await team.head('main')
    await team.tree(head)
    await team.file(head, 'shared/about-me.md')
    assert.ok(!existsSync(marker), 'fsmonitor from the repo config ran')
  } finally {
    repo.done()
  }
})

test('git runs without any of the board\'s GIT_ variables, and asks nothing on a terminal', async () => {
  const env = gitEnvironment({ PATH: '/bin', HOME: '/home/x', GIT_DIR: '/evil', git_work_tree: '/evil', GIT_SSH_COMMAND: 'evil', GIT_CONFIG_COUNT: '1', GITHUB_TOKEN: 'keep-me-not-a-git-var', GIT_TERMINAL_PROMPT: '1' })
  assert.deepEqual(Object.keys(env).sort(), ['GCM_INTERACTIVE', 'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT', 'GITHUB_TOKEN', 'HOME', 'PATH'].sort())
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(env.GCM_INTERACTIVE, 'never')
  // And for real: a poisoned process environment does not redirect the read.
  const repo = makeRepo()
  const decoy = makeRepo({ 'decoy.md': 'decoy' })
  const saved = { ...process.env }
  try {
    process.env.GIT_DIR = path.join(decoy.work, '.git')
    process.env.GIT_WORK_TREE = decoy.work
    const { repo: team } = reader(repo)
    const head = await team.head('main')
    assert.equal(head, repo.sha())
    assert.equal(await team.file(head, 'shared/about-me.md'), FILES['shared/about-me.md'])
    assert.equal(await team.file(head, 'decoy.md'), null)
  } finally {
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE']) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
    repo.done()
    decoy.done()
  }
})

test('a git call that hangs is killed at its time limit, and only six run at once', async () => {
  const sleeper = ['-c', 'alias.slow=!node -e "setTimeout(() => {}, 4000)"', 'slow']
  const started = Date.now()
  await assert.rejects(runGit(sleeper, { cwd: tmpdir(), timeoutMs: 250 }), (error) => error.killed === true || error.signal === 'SIGKILL' || error.code === 'ETIMEDOUT')
  assert.ok(Date.now() - started < 3500, 'the timeout did not stop the call')
  // The queue: twenty slow calls, never more than six running together.
  let most = 0
  const watch = setInterval(() => { most = Math.max(most, gitCallsRunning()) }, 10)
  try {
    await Promise.allSettled(Array.from({ length: 18 }, () => runGit(['-c', 'alias.slow=!node -e "setTimeout(() => {}, 300)"', 'slow'], { cwd: tmpdir(), timeoutMs: 5000 })))
  } finally {
    clearInterval(watch)
  }
  assert.ok(most >= 2, 'the sampler saw no overlap at all')
  assert.ok(most <= 6, `${most} git calls ran at once`)
  assert.equal(gitCallsRunning(), 0, 'a slot was never given back')
})

test('the time limits and output limits the reader asks for', async () => {
  const repo = makeRepo()
  try {
    const seen = []
    const team = folderRepo(repo.work, { run: (args, options) => (seen.push({ args, options }), runGit(args, options)) })
    const head = await team.head('main')
    await team.tree(head)
    await team.file(head, 'shared/about-me.md')
    for (const { args, options } of seen) {
      assert.ok(options.cwd === repo.work)
      const limit = args[0] === 'fetch' ? 20_000 : 10_000
      assert.ok((options.timeoutMs ?? 10_000) <= limit, `${args[0]} may wait too long`)
      assert.ok((options.maxBuffer ?? 8 * 1024 * 1024) <= 64 * 1024 * 1024, `${args[0]} has no output limit`)
    }
    assert.ok(seen.some(({ args }) => args[0] === 'fetch' && args.includes('--no-tags') && args.at(-1) === '+refs/heads/main:refs/remotes/origin/main'))
  } finally {
    repo.done()
  }
})

test('the git folder switch is on only for REPO_SOURCE=folder with an absolute REPO_FOLDER; names are read from origin', () => {
  const absolute = path.resolve('team')
  assert.equal(repoFolder({ REPO_SOURCE: 'folder', REPO_FOLDER: absolute }), absolute)
  assert.equal(repoFolder({ REPO_FOLDER: absolute }), null)
  assert.equal(repoFolder({ REPO_SOURCE: 'folder' }), null)
  assert.equal(repoFolder({ REPO_SOURCE: 'github', REPO_FOLDER: absolute }), null)
  assert.equal(repoFolder({ REPO_SOURCE: 'folder', REPO_FOLDER: 'team' }), null)
  assert.equal(repoFolder({}), null)
  assert.deepEqual(githubNames('https://github.com/someone/my-agent-team.git'), { owner: 'someone', repo: 'my-agent-team' })
  assert.deepEqual(githubNames('https://tok@github.com/someone/my-agent-team'), { owner: 'someone', repo: 'my-agent-team' })
  assert.deepEqual(githubNames('git@github.com:someone/my.agent-team.git\n'), { owner: 'someone', repo: 'my.agent-team' })
  assert.equal(githubNames('https://evil.example/someone/x.git'), null)
  assert.equal(githubNames('https://github.com.evil.example/a/b'), null)
  assert.equal(githubNames('https://github.com/a/b/c'), null)
  assert.equal(githubNames(undefined), null)
})

/* ---------- the git program, hooks and the remote ---------- */

test('git is found from PATH by absolute path; a git planted in the team folder is never run, even with the Windows safety switch off', async () => {
  const repo = makeRepo()
  const saved = process.env.NoDefaultCurrentDirectoryInExePath
  try {
    // The reviewer's attack: a program called git in the team folder itself.
    if (process.platform === 'win32') {
      copyFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'), path.join(repo.work, 'git.exe'))
      writeFileSync(path.join(repo.work, 'git.cmd'), '@echo planted> "%~dp0PLANTED"\r\n')
      writeFileSync(path.join(repo.work, 'git.bat'), '@echo planted> "%~dp0PLANTED"\r\n')
    } else {
      writeFileSync(path.join(repo.work, 'git'), '#!/bin/sh\necho planted > "$(dirname "$0")/PLANTED"\n', { mode: 0o755 })
    }
    delete process.env.NoDefaultCurrentDirectoryInExePath
    const { repo: team } = reader(repo)
    const head = await team.head('main')
    assert.equal(head, repo.sha(), 'the real git did not answer')
    assert.equal((await team.tree(head)).tree.length, Object.keys(FILES).length)
    assert.equal(await team.file(head, 'shared/about-me.md'), FILES['shared/about-me.md'])
    assert.ok(!existsSync(path.join(repo.work, 'PLANTED')), 'a planted program ran')
  } finally {
    if (saved !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = saved
    repo.done()
  }
})

test('findGit takes only absolute PATH entries, and a git program inside the team folder is refused', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'cockpit-findgit-'))
  try {
    const bin = path.join(base, 'bin')
    mkdirSync(bin)
    const name = process.platform === 'win32' ? 'git.exe' : 'git'
    writeFileSync(path.join(bin, name), 'x')
    const platform = process.platform
    const pathOf = (...entries) => entries.join(path.delimiter)
    assert.equal(findGit({ PATH: pathOf('', '.', 'bin', bin) }, platform), path.join(bin, name), 'empty, "." and relative entries are skipped')
    assert.equal(findGit({ PATH: pathOf('', '.', 'bin') }, platform), null)
    assert.equal(findGit({ Path: bin }, platform), path.join(bin, name), 'the Windows spelling of PATH')
    assert.equal(findGit({ PATH: `"${bin}"` }, platform), path.join(bin, name), 'quoted entry')
    assert.equal(findGit({}, platform), null)
    const scripts = path.join(base, 'scripts')
    mkdirSync(scripts)
    writeFileSync(path.join(scripts, 'git.cmd'), 'x')
    writeFileSync(path.join(scripts, 'git.bat'), 'x')
    assert.equal(findGit({ PATH: scripts }, 'win32'), null, 'only git.exe counts on Windows, never .cmd or .bat')
    assert.equal(isInside(base, path.join(bin, name)), true)
    assert.equal(isInside(bin, path.join(base, 'elsewhere', name)), false)
    assert.equal(isInside(bin, path.join(bin, '..', 'bin2', name)), false)
    // The real program lives outside any team folder; one that lived inside would be refused.
    const real = findGit()
    assert.ok(real && path.isAbsolute(real))
    await assert.rejects(runGit(['--version'], { cwd: path.dirname(real) }), (error) => error.ours === true && error.message === FOLDER_UNREADABLE)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a git program reached through a junction or link into the team folder is refused too', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'cockpit-junction-'))
  try {
    const team = path.join(base, 'team')
    mkdirSync(path.join(team, 'bin'), { recursive: true })
    const name = process.platform === 'win32' ? 'git.exe' : 'git'
    writeFileSync(path.join(team, 'bin', name), 'x')
    const via = path.join(base, 'innocent')
    symlinkSync(path.join(team, 'bin'), via, 'junction')
    const found = findGit({ PATH: via }, process.platform)
    assert.equal(found, path.join(via, name), 'the junction entry was found by its own spelling')
    assert.equal(isInside(team, found), true, 'the spelling hid that it lives in the team folder')
    assert.equal(isInside(path.join(base, 'innocent'), path.join(team, 'bin', name)), true, 'and the other way round')
    assert.equal(isInside(team, path.join(base, 'elsewhere', name)), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a fetch runs none of the repo\'s hooks and none of its remote program settings', async () => {
  const repo = makeRepo()
  try {
    const hookMarker = path.join(repo.base, 'HOOK-RAN').replaceAll('\\', '/')
    const packMarker = path.join(repo.base, 'UPLOADPACK-RAN').replaceAll('\\', '/')
    const hooks = path.join(repo.work, '.git', 'hooks')
    mkdirSync(hooks, { recursive: true })
    for (const hook of ['reference-transaction', 'post-checkout', 'post-merge', 'post-commit']) {
      writeFileSync(path.join(hooks, hook), `#!/bin/sh\necho ran > "${hookMarker}"\n`, { mode: 0o755 })
    }
    // The program git would run to talk to the remote, set in the repo's own config.
    git(repo.work, 'config', 'remote.origin.uploadpack', `node -e "require('fs').writeFileSync('${packMarker}', 'x')" #`)
    const { repo: team, clock } = reader(repo)
    const first = await team.head('main')
    // Another clone pushes, so the next fetch has a ref to update (and a hook to run).
    const other = path.join(repo.base, 'other')
    git(repo.base, 'clone', '-q', repo.bare, other)
    writeFileSync(path.join(other, 'n.md'), 'n')
    git(other, 'add', '-A')
    git(other, 'commit', '-q', '-m', 'n')
    git(other, 'push', '-q', 'origin', 'main')
    clock.t += FETCH_EVERY_MS + 1
    const second = await team.head('main')
    assert.notEqual(second, first, 'the fetch did not happen, so this test proved nothing')
    assert.ok(!existsSync(hookMarker), 'a hook from the repo ran')
    assert.ok(!existsSync(packMarker), 'the repo\'s upload-pack setting ran')
  } finally {
    repo.done()
  }
})

test('only a GitHub address is fetched from; any other origin is shown as it was last fetched', async () => {
  const repo = makeRepo()
  try {
    git(repo.work, 'config', '--unset', `url.${repo.bare}.insteadOf`)
    git(repo.work, 'remote', 'set-url', 'origin', repo.bare)
    const { repo: team, clock, calls } = reader(repo)
    const before = await team.head('main')
    const other = path.join(repo.base, 'other')
    git(repo.base, 'clone', '-q', repo.bare, other)
    writeFileSync(path.join(other, 'n.md'), 'n')
    git(other, 'add', '-A')
    git(other, 'commit', '-q', '-m', 'n')
    git(other, 'push', '-q', 'origin', 'main')
    clock.t += FETCH_EVERY_MS + 1
    assert.equal(await team.head('main'), before)
    assert.equal(fetches(calls), 0)
    const said = await team.describe()
    assert.deepEqual({ ...said, note: undefined }, { hasOrigin: true, github: false, note: undefined })
    assert.equal(said.note, FOLDER_NOTES.notGitHub)
    for (const hostile of ['ext::sh -c "echo x"', '--upload-pack=x', 'file:///etc', 'https://github.com.evil.example/a/b']) {
      git(repo.work, 'config', 'remote.origin.url', hostile)
      clock.t += REMOTE_RECHECK_MS + FETCH_EVERY_MS + 1
      await team.head('main')
    }
    assert.equal(fetches(calls), 0, 'a fetch started for an address that is not GitHub')
  } finally {
    repo.done()
  }
})

test('when git will not say whether there is a remote, the board has no answer - it never falls back to the local branch', async () => {
  const repo = makeRepo()
  try {
    const clock = { t: 5_000_000 }
    const calls = []
    let failRemote = true
    const run = async (args, options) => {
      calls.push(args)
      if (args[0] === 'config' && failRemote) throw new Error('git went away')
      return runGit(args, options)
    }
    const team = folderRepo(repo.work, { run, now: () => clock.t })
    repo.commit('unpushed.md', 'local only')
    assert.equal(await team.hasOrigin(), null)
    assert.equal(await team.head('main'), null, 'a failed `git remote` was taken for "no remote"')
    assert.ok(!calls.some((args) => args[0] === 'rev-parse' && /refs\/heads\//.test(args.at(-1))), 'the local branch was read')
    assert.equal((await team.describe()).note, FOLDER_NOTES.unknown)
    // It is asked again, not remembered as an answer.
    failRemote = false
    const pushed = await team.head('main')
    assert.notEqual(pushed, repo.sha(), 'the unpushed commit was shown')
    // An answer is kept for a minute, then asked again.
    const asked = () => calls.filter((args) => args[0] === 'config').length
    const now = asked()
    await team.hasOrigin()
    assert.equal(asked(), now, 'asked again within the minute')
    clock.t += REMOTE_RECHECK_MS + 1
    await team.hasOrigin()
    assert.equal(asked(), now + 1)
  } finally {
    repo.done()
  }
})

test('a folder with no remote says so, and a remote added later is noticed within the minute', async () => {
  const lonely = makeRepo(FILES, { remote: false })
  try {
    const { repo: team, clock } = reader(lonely)
    const said = await team.describe()
    assert.equal(said.hasOrigin, false)
    assert.equal(said.note, 'Jobs are off: this folder is not on GitHub, so nothing the team pushes can reach it.')
    const bare = path.join(lonely.base, 'github.git')
    git(lonely.base, 'init', '-q', '--bare', '-b', 'main', bare)
    git(lonely.work, 'remote', 'add', 'origin', GITHUB_URL)
    git(lonely.work, 'config', `url.${bare}.insteadOf`, GITHUB_URL)
    git(lonely.work, 'push', '-q', 'origin', 'main')
    assert.equal((await team.describe()).hasOrigin, false, 'still the cached answer')
    clock.t += REMOTE_RECHECK_MS + 1
    const later = await team.describe()
    assert.equal(later.hasOrigin, true)
    assert.equal(later.note, null)
  } finally {
    lonely.done()
  }
})

test('the board page is told the note, only in folder mode, and a cut-off file list is told too', async () => {
  const lonely = makeRepo(FILES, { remote: false })
  try {
    const folder = await withEnv(folderEnv(lonely), () => call(stateHandler, {}))
    assert.equal(folder.result.statusCode, 200)
    assert.equal(folder.result.body.repo.note, FOLDER_NOTES.noRemote)
    const github = await withEnv({ GITHUB_OWNER: 'someone', GITHUB_REPO: 'my-agent-team' }, () => call(stateHandler, {}), { githubFiles: FILES, head: lonely.sha() })
    assert.ok(!('note' in github.result.body.repo), 'the website answer grew a key')
    assert.equal((await withEnv({}, () => folderNote({ truncated: true }))).result, null, 'no note on the website, whatever the tree says')
    assert.equal((await withEnv(folderEnv(lonely), () => folderNote({ truncated: true }))).result, `${FOLDER_NOTES.noRemote} ${FOLDER_NOTES.truncated}`)
    assert.equal((await withEnv(folderEnv(lonely), () => folderNote({ truncated: false }))).result, FOLDER_NOTES.noRemote)
  } finally {
    lonely.done()
  }
})

test('a tree longer than the cap is cut and says so', async () => {
  const repo = makeRepo()
  try {
    const team = folderRepo(repo.work, { maxEntries: 2 })
    const head = await team.head('main')
    const listed = await team.tree(head)
    assert.equal(listed.tree.length, 2)
    assert.equal(listed.truncated, true)
    assert.equal((await folderRepo(repo.work).tree(head)).truncated, false)
  } finally {
    repo.done()
  }
})

/* ---------- the endpoints, on a folder ---------- */

function fakeResponse() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(key, value) { this.headers[key] = value },
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
    end() { return this }
  }
}

// Runs `work` with these env values and a fetch that records (and, in folder mode, forbids) GitHub.
async function withEnv(env, work, { githubFiles = null, head = null } = {}) {
  const previous = { ...process.env }
  const originalFetch = globalThis.fetch
  const github = []
  for (const name of ['GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_BRANCH', 'GITHUB_TOKEN', 'REPO_SOURCE', 'REPO_FOLDER', 'VIEW_KEY', 'FIRE_KEY', 'FIRE_TRIGGERS', 'PUBLIC_FIRE', 'PUBLIC_DASHBOARD']) delete process.env[name]
  Object.assign(process.env, { PUBLIC_DASHBOARD: 'true' }, env)
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url)
    if (!target.startsWith('https://api.github.com')) return new Response('{}', { status: 200 })
    github.push({ url: target, init })
    if (!githubFiles) throw new Error('GitHub must not be called in folder mode')
    if (target.includes('/commits/')) return head ? new Response(head, { status: 200 }) : new Response('Not Found', { status: 404 })
    if (target.includes('/git/trees/')) {
      // GitHub lists a tree in git's own (sorted) order.
      const tree = Object.entries(githubFiles).sort(([one], [two]) => (one < two ? -1 : 1)).map(([filePath, text]) => ({ path: filePath, type: 'blob', size: Buffer.byteLength(text), sha: 'a'.repeat(40) }))
      return new Response(JSON.stringify({ tree }), { status: 200 })
    }
    const match = /\/contents\/(.+?)\?ref=/.exec(target)
    const body = match ? githubFiles[decodeURI(match[1])] : undefined
    return body === undefined ? new Response('Not Found', { status: 404 }) : new Response(body, { status: 200 })
  }
  try {
    return { result: await work(), github }
  } finally {
    globalThis.fetch = originalFetch
    process.env = previous
  }
}

const folderEnv = (repo) => ({ REPO_SOURCE: 'folder', REPO_FOLDER: repo.work })
async function call(handler, request) {
  const response = fakeResponse()
  await handler(request, response)
  return response
}

// The timestamps the board stamps on a reading; everything else must be identical in both modes.
const stable = (board) => JSON.parse(JSON.stringify(board, (key, value) => (['generatedAt', 'now', 'takenAt', 'since', 'checkedAt'].includes(key) ? undefined : value)))

test('the board built from a folder is the board built from GitHub for the same commit', async () => {
  const repo = makeRepo()
  try {
    const head = repo.sha()
    const viaGitHub = await withEnv({ GITHUB_OWNER: 'someone', GITHUB_REPO: 'my-agent-team' }, () => call(stateHandler, {}), { githubFiles: FILES, head })
    const viaFolder = await withEnv({ ...folderEnv(repo), GITHUB_OWNER: 'someone', GITHUB_REPO: 'my-agent-team' }, () => call(stateHandler, {}))
    assert.equal(viaGitHub.result.statusCode, 200)
    assert.equal(viaFolder.result.statusCode, 200, JSON.stringify(viaFolder.result.body).slice(0, 300))
    assert.equal(viaFolder.github.length, 0, 'folder mode called GitHub')
    assert.equal(viaFolder.result.body.commit, head)
    const lines = (value) => JSON.stringify(value, null, 1).split('\n')
    const one = lines(stable(viaFolder.result.body))
    const two = lines(stable(viaGitHub.result.body))
    const at = one.findIndex((line, index) => line !== two[index])
    assert.equal(at, -1, `first difference at line ${at}: folder ${one[at]} / github ${two[at]}`)
    assert.ok(viaFolder.result.body.agents.some((agent) => agent.slug === 'research'))
  } finally {
    repo.done()
  }
})

test('a folder board needs no GITHUB_OWNER / GITHUB_REPO and takes the names from origin', async () => {
  const repo = makeRepo(FILES, { origin: 'https://github.com/someone/my-agent-team.git' })
  try {
    const { result, github } = await withEnv(folderEnv(repo), () => call(stateHandler, {}))
    assert.equal(result.statusCode, 200, JSON.stringify(result.body).slice(0, 300))
    assert.deepEqual(github, [])
    assert.equal(result.body.repo.owner, 'someone')
    assert.equal(result.body.repo.repo, 'my-agent-team')
    assert.equal(result.body.repo.url, 'https://github.com/someone/my-agent-team')
    const named = await withEnv(folderEnv(repo), () => namedFromOrigin(config()))
    assert.equal(named.result.owner, 'someone')
    const keepsTheirs = await withEnv({ ...folderEnv(repo), GITHUB_OWNER: 'me', GITHUB_REPO: 'mine' }, () => namedFromOrigin(config()))
    assert.equal(keepsTheirs.result.owner, 'me', 'settings the owner made are not overwritten')
  } finally {
    repo.done()
  }
})

test('?since=<head> is answered "unchanged" from the folder, and a change shows after the next allowed fetch', async () => {
  const repo = makeRepo()
  try {
    const head = repo.sha()
    const { result } = await withEnv(folderEnv(repo), () => call(stateHandler, { query: { since: head } }))
    assert.deepEqual(result.body, { unchanged: true, commit: head })
  } finally {
    repo.done()
  }
})

test('/api/file serves a committed file from the folder, never an uncommitted one, and refuses odd paths', async () => {
  const repo = makeRepo()
  try {
    writeFileSync(path.join(repo.work, 'shared/about-me.md'), 'EDITED, NOT COMMITTED')
    writeFileSync(path.join(repo.work, 'draft.md'), 'untracked')
    const { result: ok, github } = await withEnv(folderEnv(repo), () => call(fileHandler, { method: 'GET', headers: {}, query: { path: 'shared/about-me.md' } }))
    assert.equal(ok.statusCode, 200)
    assert.equal(ok.body.content, FILES['shared/about-me.md'])
    assert.deepEqual(github, [])
    const { result: untracked } = await withEnv(folderEnv(repo), () => call(fileHandler, { method: 'GET', headers: {}, query: { path: 'draft.md' } }))
    assert.equal(untracked.statusCode, 404)
    for (const odd of ['../team/shared/about-me.md', '.git/config.json', '/etc/passwd.md', 'a\\b.md', 'shared/about-me.md\0.md', '--output=x.md']) {
      const { result } = await withEnv(folderEnv(repo), () => call(fileHandler, { method: 'GET', headers: {}, query: { path: odd } }))
      assert.equal(result.statusCode, 400, odd)
    }
    assert.ok(!existsSync(path.join(repo.base, 'x.md')))
  } finally {
    repo.done()
  }
})

test('/api/graph answers from the folder', async () => {
  const repo = makeRepo({ ...FILES, 'shared/note-one.md': '# One\nsee [[note-two]]\n', 'shared/note-two.md': '# Two\n' })
  try {
    const { result, github } = await withEnv(folderEnv(repo), () => call(graphHandler, { method: 'GET', headers: {}, query: {} }))
    assert.equal(result.statusCode, 200, JSON.stringify(result.body).slice(0, 300))
    assert.equal(result.body.commit, repo.sha())
    assert.deepEqual(github, [])
  } finally {
    repo.done()
  }
})

test('firing a workflow checks it in the folder, not on GitHub', async () => {
  const repo = makeRepo()
  try {
    const trigger = { 'monday-brief': { url: 'https://api.anthropic.com/v1/claude_code/routines/trig_01Test/fire', token: ['sk', 'ant', 'oat01', 'fakeTokenForTheTest'].join('-') } }
    const env = { ...folderEnv(repo), VIEW_KEY: 'vk_fakeViewKeyForTheFolderSuite', FIRE_KEY: 'fk_correctHorseBatteryStaple', FIRE_TRIGGERS: JSON.stringify(trigger) }
    const headers = { 'x-view-key': env.VIEW_KEY, 'x-fire-key': env.FIRE_KEY }
    const { result, github } = await withEnv(env, () => call(fireHandler, { method: 'POST', headers, body: { workflow: 'monday-brief' } }))
    assert.equal(result.statusCode, 200, JSON.stringify(result.body))
    assert.deepEqual(github, [])
    const ghost = await withEnv(env, () => call(fireHandler, { method: 'POST', headers, body: { workflow: 'no-fire' } }))
    assert.notEqual(ghost.result.statusCode, 200)
    assert.deepEqual(ghost.github, [])
  } finally {
    repo.done()
  }
})

test('firing a task card move, and a task for a named agent, check the folder too', async () => {
  const repo = makeRepo()
  try {
    const trigger = { 'task-intake': { url: 'https://api.anthropic.com/v1/claude_code/routines/trig_01Task/fire', token: ['sk', 'ant', 'oat01', 'fakeTokenForTheTaskTest'].join('-') } }
    const env = { ...folderEnv(repo), VIEW_KEY: 'vk_fakeViewKeyForTheFolderSuite', FIRE_KEY: 'fk_correctHorseBatteryStaple', FIRE_TRIGGERS: JSON.stringify(trigger) }
    const headers = { 'x-view-key': env.VIEW_KEY, 'x-fire-key': env.FIRE_KEY }
    const fire = (body) => withEnv(env, () => call(fireHandler, { method: 'POST', headers, body }))
    const moved = await fire({ action: 'move', task: '2026-08-18-call-supplier', status: 'doing' })
    assert.equal(moved.result.statusCode, 200, JSON.stringify(moved.result.body))
    const missingCard = await fire({ action: 'move', task: '2026-01-01-no-such-card', status: 'doing' })
    assert.equal(missingCard.result.statusCode, 400)
    assert.match(missingCard.result.body.error, /not in the team repo/)
    const named = await fire({ action: 'task', title: 'Chase the invoice', for: 'research' })
    assert.equal(named.result.statusCode, 200, JSON.stringify(named.result.body))
    const ghost = await fire({ action: 'task', title: 'Chase the invoice', for: 'no-such-agent' })
    assert.equal(ghost.result.statusCode, 400)
    for (const one of [moved, missingCard, named, ghost]) assert.deepEqual(one.github, [], 'GitHub was called')
  } finally {
    repo.done()
  }
})

test('the Mac status lookup reads the committed status file from the folder, and anything wrong reads as none', async () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/mailbox-parity.json', import.meta.url), 'utf8'))
  const sample = fixture.status.sample
  const file = `${MAILBOX_FOLDER}/mac-mini.json`
  const repo = makeRepo({ ...FILES, [file]: JSON.stringify(sample) })
  const broken = makeRepo({ ...FILES, [file]: 'not json' })
  try {
    const at = Date.parse(sample.takenAt) + 60_000
    const read = await withEnv(folderEnv(repo), () => readMacStatus(process.env, 'mac-mini', at))
    assert.deepEqual(read.result, shapeMailbox([[file, JSON.stringify(sample)]], at, 1).computers[0])
    assert.deepEqual(read.github, [])
    const none = await withEnv(folderEnv(repo), () => readMacStatus(process.env, 'other-computer', at))
    assert.equal(none.result, null)
    assert.equal((await withEnv(folderEnv(repo), () => readMacStatus(process.env, '../jobs/x', at))).result, null)
    assert.equal((await withEnv(folderEnv(broken), () => readMacStatus(process.env, 'mac-mini', at))).result, null)
    // An uncommitted change to the file is not what the board reads.
    writeFileSync(path.join(repo.work, file), 'not json')
    assert.deepEqual((await withEnv(folderEnv(repo), () => readMacStatus(process.env, 'mac-mini', at))).result, read.result)
  } finally {
    repo.done()
    broken.done()
  }
})

test('a note is read by its fingerprint from the folder, only if the tree just listed it', async () => {
  const repo = makeRepo()
  try {
    const { result } = await withEnv(folderEnv(repo), async () => {
      const base = config()
      const head = await headCommit(base)
      const tree = await repoTree(base, head)
      const note = tree.tree.find((node) => node.path === 'shared/about-me.md')
      writeFileSync(path.join(repo.work, 'staged.md'), 'staged only')
      git(repo.work, 'add', 'staged.md')
      return {
        note: await noteByFingerprint(base, note.sha),
        staged: await noteByFingerprint(base, git(repo.work, 'rev-parse', ':staged.md')),
        unknown: await noteByFingerprint(base, 'f'.repeat(40))
      }
    })
    assert.equal(result.note, FILES['shared/about-me.md'])
    assert.equal(result.staged, null)
    assert.equal(result.unknown, null)
  } finally {
    repo.done()
  }
})

/* ---------- the website is untouched ---------- */

test('without REPO_SOURCE=folder, GitHub is read exactly as before - also with a stray REPO_FOLDER, and git is never started', async () => {
  const repo = makeRepo()
  try {
    const sha = repo.sha()
    for (const env of [{}, { REPO_FOLDER: repo.work }, { REPO_SOURCE: 'github', REPO_FOLDER: repo.work }]) {
      const { result, github } = await withEnv({ GITHUB_OWNER: 'someone', GITHUB_REPO: 'my-agent-team', GITHUB_BRANCH: 'main', GITHUB_TOKEN: 'ghp_notReal', ...env },
        async () => {
          const base = config()
          return { head: await headCommit(base), file: await rawFile(base, 'shared/about-me.md'), tree: await repoTree(base, sha) }
        }, { githubFiles: FILES, head: sha })
      assert.deepEqual(result.head, sha)
      assert.equal(result.file, FILES['shared/about-me.md'])
      assert.equal(result.tree.tree.length, Object.keys(FILES).length)
      assert.deepEqual(github.map((one) => one.url), [
        'https://api.github.com/repos/someone/my-agent-team/commits/main',
        'https://api.github.com/repos/someone/my-agent-team/contents/shared/about-me.md?ref=main',
        `https://api.github.com/repos/someone/my-agent-team/git/trees/${sha}?recursive=1`
      ])
      assert.equal(github[0].init.headers.Accept, 'application/vnd.github.sha')
      assert.equal(github[0].init.headers.Authorization, 'Bearer ghp_notReal')
      assert.equal(github[1].init.headers.Accept, 'application/vnd.github.raw')
    }
    const missing = await withEnv({ REPO_FOLDER: repo.work }, async () => {
      try { config(); return 'no error' } catch (error) { return error.message }
    })
    assert.match(missing.result, /Set GITHUB_OWNER and GITHUB_REPO/, 'without the folder switch, config still refuses as it did')
    const noFile = await withEnv({ REPO_FOLDER: repo.work }, () => call(fileHandler, { method: 'GET', headers: {}, query: { path: 'a.md' } }))
    assert.equal(noFile.result.statusCode, 500)
  } finally {
    repo.done()
  }
})
