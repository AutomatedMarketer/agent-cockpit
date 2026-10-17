// Reading the team repo from a git folder on this computer (Student Edition), instead of from GitHub.
//
// On when REPO_SOURCE=folder and REPO_FOLDER=<an absolute path to a clone of the team repo>. Vercel
// never has them, so the website keeps reading GitHub exactly as before (every caller asks
// repoFolder() first and takes its old path when it says no).
//
// What the board reads is "what the team has pushed", the same meaning as the website:
// - Only commits. Files are read with git's object commands (ls-tree, cat-file) from a commit id, so a
//   file you have edited but not committed, a staged change, and an untracked file are never seen.
// - The commit is the tip of origin/<branch> after a fetch (at most one per 30 seconds). A folder with
//   no `origin` remote at all is read at its own <branch> and says so; one with a remote is never
//   read past what the remote has.
// - A blob is read by id only if the last tree listing named it, so an id of something never
//   committed (a staged file's, an old stash's) is refused.
//
// Safety of running git, since a name reaches it from the environment and from a request:
// - execFile, never a shell, with a fixed list of options first. Every name is checked before it is
//   put in the list: a branch against a strict pattern, a commit against 40 hex digits, a path
//   against "plain repo path". Nothing that starts with "-" can reach git as an option.
// - Git gets a short allowlist of the environment (home, PATH, system folders - see gitEnvironment),
//   never the board's keys or per-run key, and no GIT_* variable (GIT_DIR, GIT_SSH_COMMAND and the
//   like would redirect git); git never asks anything on a terminal.
// - Each call has a time limit and an output limit, and at most MAX_AT_ONCE run together.

import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const FETCH_EVERY_MS = 30_000
export const REMOTE_RECHECK_MS = 60_000
const FETCH_TIMEOUT_MS = 20_000
const READ_TIMEOUT_MS = 10_000
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_TREE_BYTES = 64 * 1024 * 1024
const MAX_TREE_ENTRIES = 100_000
const MAX_AT_ONCE = 6
const KEEP_TREES = 3

export const COMMIT_ID = /^[0-9a-f]{40}$/

// "owner" and "repo" from a GitHub address in either form git uses, or null for anything else.
export function githubNames(url) {
  if (typeof url !== 'string') return null
  const found = /^(?:https:\/\/(?:[^/@\s]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(url.trim())
  return found ? { owner: found[1], repo: found[2] } : null
}

export function repoFolder(env = process.env) {
  return env.REPO_SOURCE === 'folder' && typeof env.REPO_FOLDER === 'string' && path.isAbsolute(env.REPO_FOLDER)
    ? env.REPO_FOLDER
    : null
}

// A branch name git would accept AND that cannot be an option, a range, a revision expression or a
// path trick: letters, digits, dot, dash, underscore and slash, starting with a letter or digit.
export function isBranchName(value) {
  return (
    typeof value === 'string' &&
    value.length <= 100 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
    !value.includes('..') &&
    !value.includes('//') &&
    !value.endsWith('/') &&
    !value.endsWith('.') &&
    !value.endsWith('.lock') &&
    value.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'))
  )
}

// A repo-relative file path: no control characters, no backslash, no empty or dot segments, not
// absolute. (Spaces and most punctuation are fine; the path is never given to git on its own, only
// after "<commit>:".)
export function isRepoPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) return false
  if (value.startsWith('/') || value.includes('\\')) return false
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return false
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

function ourFailure(sentence, status) {
  const error = new Error(sentence)
  error.ours = true
  if (status !== undefined) error.status = status
  return error
}
export const FOLDER_NOTES = {
  noRemote: 'Jobs are off: this folder is not on GitHub, so nothing the team pushes can reach it.',
  notGitHub: 'The board is not refreshing this folder: its origin is not a GitHub address, so it shows what was last fetched.',
  unknown: 'The board could not tell whether this folder is on GitHub, so it shows nothing until git answers.',
  truncated: 'This team folder has more files than the board lists, so only the first part of it is shown.'
}
export const FOLDER_UNREADABLE =
  'The board could not read the team folder with git, so check that the folder is a clone of your team repo and that git is installed.'

// The environment git runs in. A short list of what git and its helpers need to find the student's
// own sign-in (their home and profile folders, PATH, the system folders Windows needs, the language,
// an ssh agent), and nothing else: the board's own environment holds keys, tokens and the per-run
// view key, and none of that has any business in a child process that talks to a remote. Plus the
// three variables that keep git quiet. Names are compared without regard to case (Windows).
const GIT_NEEDS = new Set([
  'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR', 'USERNAME', 'USER', 'LOGNAME', 'USERDOMAIN', 'LANG', 'TZ',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'SSH_AUTH_SOCK'
])
export function gitEnvironment(source = process.env) {
  const env = {}
  for (const [name, value] of Object.entries(source)) {
    const upper = name.toUpperCase()
    if (value !== undefined && (GIT_NEEDS.has(upper) || upper.startsWith('LC_'))) env[name] = value
  }
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GCM_INTERACTIVE = 'never'
  return env
}

// How many git programs this process has started (the speed tests count them: reading a repo must cost a
// handful, not one per file).
let started = 0
export const gitProcessesStarted = () => started

let running = 0
const waiting = []
function slot() {
  if (running < MAX_AT_ONCE) {
    running += 1
    return Promise.resolve()
  }
  return new Promise((resolve) => waiting.push(resolve))
}
// How many git calls are running right now (for the test that the limit holds).
export const gitCallsRunning = () => running
function release() {
  const next = waiting.shift()
  if (next) next()
  else running -= 1
}

// The real runner: git with `args` in `cwd`. Resolves { stdout } (a Buffer) or rejects with the child
// process error (code, stderr, killed). Tests hand in their own.
export async function runGit(args, { cwd, timeoutMs = READ_TIMEOUT_MS, maxBuffer = MAX_FILE_BYTES } = {}) {
  await slot()
  try {
    const program = gitProgram()
    // A program inside the team folder would be run with the student's rights by whoever put it
    // there: refused, whatever the PATH says.
    if (cwd && isInside(cwd, program)) throw ourFailure(FOLDER_UNREADABLE)
    started += 1
    return await new Promise((resolve, reject) => {
      execFile(
        program,
        [...fixedGitOptions(), ...(cwd ? ['-C', cwd] : []), ...args],
        // The process starts in git's own folder, never in the team folder: on Windows a program of
        // the same name in the working folder can be found before the real one. The repo is named with -C.
        { cwd: path.dirname(program), env: gitEnvironment(), encoding: 'buffer', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            error.stderr = stderr
            reject(error)
          } else resolve({ stdout })
        }
      )
    })
  } finally {
    release()
  }
}

// The absolute path of the git program, found once from PATH. Only absolute PATH entries count (an
// empty or relative one means "the current folder"), and only a real file named git (git.exe on
// Windows: a .cmd or .bat cannot be started without a shell, and none is).
let foundGit = null
export function findGit(env = process.env, platform = process.platform) {
  const names = platform === 'win32' ? ['git.exe'] : ['git']
  for (const raw of String(env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1')
    if (!dir || !path.isAbsolute(dir)) continue
    for (const name of names) {
      const candidate = path.join(dir, name)
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        // not here
      }
    }
  }
  return null
}
function gitProgram() {
  foundGit ??= findGit()
  if (!foundGit) throw ourFailure(FOLDER_UNREADABLE)
  return foundGit
}
// Compared by where each really is (links and 8.3 short names resolved), not by how it is spelled.
const real = (value) => {
  try {
    return realpathSync.native(path.resolve(value))
  } catch {
    return path.resolve(value)
  }
}
export function isInside(folder, target) {
  const relative = path.relative(real(folder), real(target))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

// Options ahead of every command, none of them from the repo's own config: no fsmonitor program, no
// ext:: remotes, no hooks (an empty folder instead), the stock upload-pack program, no submodule
// fetching, no background gc or maintenance racing the student's work.
let noHooks = null
export function fixedGitOptions() {
  noHooks ??= mkdtempSync(path.join(os.tmpdir(), 'cockpit-no-hooks-'))
  return [
    '-c', 'core.fsmonitor=false',
    '-c', 'protocol.ext.allow=never',
    '-c', `core.hooksPath=${noHooks}`,
    '-c', 'fetch.recurseSubmodules=false',
    '-c', 'gc.auto=0',
    '-c', 'maintenance.auto=false'
  ]
}

const MISSING = /bad file|does not exist|exists on disk, but not in|not a valid object name|bad object|invalid object name|unknown revision|not a tree object/i
const stderrText = (error) => (error?.stderr ? Buffer.from(error.stderr).toString('utf8') : '')
const isMissing = (error) => error?.code === 128 && MISSING.test(stderrText(error))
// A file bigger than the output limit is not shown, like one that is not there - it must not take the whole board down with it.
const isTooBig = (error) => error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'

// ---- reading many files with ONE git program ------------------------------------------------------------
// `git cat-file --batch` is told an object on each line of its input and answers with the object's size
// and bytes. One such program serves every file of a repo, one request at a time, instead of one program per
// file (a repo of 300 files took 15 seconds to load that way; starting git costs most of 50 ms here).
//
// Every rule of the one-at-a-time way holds: git by its full path started from git's own folder, never from the
// team folder; the cleaned environment; the same fixed options; a name is checked before it is written (a commit
// id, and a path with no control character, so nothing but one object can be asked for); a time limit on each
// answer; a size limit on what is kept; and the program stops by itself when it has had nothing to do for a while.
const BATCH_IDLE_MS = 5_000
const batchReaders = new Map()
export function closeBatchReaders() {
  for (const reader of [...batchReaders.values()]) reader.close()
  batchReaders.clear()
}

function makeBatchReader(folder) {
  let child = null
  let buffer = Buffer.alloc(0)
  let part = { kind: 'header' } // or { kind: 'body', type, size, left, chunks, keep }
  const jobs = []
  let current = null
  let jobTimer = null
  let idleTimer = null

  function reset() {
    buffer = Buffer.alloc(0)
    part = { kind: 'header' }
  }
  function fail(error) {
    clearTimeout(jobTimer)
    const dead = current ? [current, ...jobs.splice(0)] : jobs.splice(0)
    current = null
    for (const job of dead) job.reject(error)
  }
  function stop() {
    clearTimeout(idleTimer)
    clearTimeout(jobTimer)
    const gone = child
    child = null
    reset()
    if (gone) {
      gone.removeAllListeners()
      gone.stdout?.removeAllListeners()
      try { gone.kill('SIGKILL') } catch { /* already gone */ }
    }
  }
  function settle(answer) {
    clearTimeout(jobTimer)
    const job = current
    current = null
    job?.resolve(answer)
    pump()
  }

  function onData(chunk) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
    for (;;) {
      if (!current) return
      if (part.kind === 'header') {
        const end = buffer.indexOf(10)
        if (end < 0) {
          if (buffer.length > 4096) { stop(); fail(ourFailure(FOLDER_UNREADABLE)) }
          return
        }
        const line = buffer.subarray(0, end).toString('latin1')
        buffer = buffer.subarray(end + 1)
        const found = /^[0-9a-f]{40} (\w+) (\d+)$/.exec(line)
        if (found) {
          const size = Number(found[2])
          part = { kind: 'body', type: found[1], size, left: size + 1, chunks: [], keep: found[1] === 'blob' && size <= MAX_FILE_BYTES }
        } else if (/ (missing|ambiguous)$/.test(line)) {
          settle({ missing: true })
        } else {
          stop()
          fail(ourFailure(FOLDER_UNREADABLE))
          return
        }
      } else {
        if (!buffer.length) return
        const take = Math.min(part.left, buffer.length)
        if (part.keep) part.chunks.push(buffer.subarray(0, take))
        buffer = buffer.subarray(take)
        part.left -= take
        if (part.left > 0) return
        const done = part
        part = { kind: 'header' }
        if (done.type !== 'blob') settle({ missing: true })
        else if (!done.keep) settle({ tooBig: true })
        else settle({ bytes: Buffer.concat(done.chunks).subarray(0, done.size) })
      }
    }
  }

  function start() {
    const program = gitProgram()
    if (isInside(folder, program)) throw ourFailure(FOLDER_UNREADABLE)
    started += 1
    // Named by its .git folder, not entered with -C: a program that is "in" the team folder stops the student
    // from moving or deleting it for as long as the program lives. (A .git that is a file - a work tree, a
    // submodule - cannot be named this way, so that one is entered.)
    let where = ['-C', folder]
    try {
      if (statSync(path.join(folder, '.git')).isDirectory()) where = ['--git-dir', path.join(folder, '.git')]
    } catch { /* entered with -C */ }
    child = spawn(program, [...fixedGitOptions(), ...where, 'cat-file', '--batch'], {
      cwd: path.dirname(program), env: gitEnvironment(), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true
    })
    const mine = child
    reset()
    mine.stdout.on('data', onData)
    mine.stdin.on('error', () => {})
    mine.on('error', () => { if (child === mine) { stop(); fail(ourFailure(FOLDER_UNREADABLE)) } })
    mine.on('close', () => { if (child === mine) { stop(); fail(ourFailure(FOLDER_UNREADABLE)) } })
  }

  function pump() {
    if (current) return
    clearTimeout(idleTimer)
    if (!jobs.length) {
      idleTimer = setTimeout(stop, BATCH_IDLE_MS)
      idleTimer.unref?.()
      return
    }
    try {
      if (!child) start()
    } catch (error) {
      jobs.splice(0).forEach((job) => job.reject(error))
      return
    }
    current = jobs.shift()
    reset()
    jobTimer = setTimeout(() => { stop(); fail(ourFailure(FOLDER_UNREADABLE)) }, READ_TIMEOUT_MS)
    jobTimer.unref?.()
    child.stdin.write(current.query + String.fromCharCode(10))
  }

  return {
    // query: "<40 hex>" or "<40 hex>:<path>". Resolves { bytes } | { missing: true } | { tooBig: true }.
    read(query) {
      if (typeof query !== 'string' || !/^[0-9a-f]{40}(:[^\u0000-\u001f\u007f]{1,500})?$/.test(query)) return Promise.resolve({ missing: true })
      return new Promise((resolve, reject) => {
        jobs.push({ query, resolve, reject })
        pump()
      })
    },
    close() { stop(); fail(ourFailure(FOLDER_UNREADABLE)) }
  }
}

function batchReaderFor(folder) {
  if (!batchReaders.has(folder)) batchReaders.set(folder, makeBatchReader(folder))
  return batchReaders.get(folder)
}

// What was read at a commit is kept: a commit never changes, so a name at a commit is always the same bytes.
const CACHE_BYTES = 64 * 1024 * 1024
const CACHE_ENTRIES = 30_000
function makeContentCache() {
  const items = new Map()
  let bytes = 0
  const sizeOf = (value) => (value === null ? 0 : Buffer.byteLength(value))
  return {
    get: (key) => items.get(key),
    set(key, value) {
      if (items.has(key)) bytes -= sizeOf(items.get(key))
      items.set(key, value)
      bytes += sizeOf(value)
      while ((bytes > CACHE_BYTES || items.size > CACHE_ENTRIES) && items.size > 1) {
        const oldest = items.keys().next().value
        bytes -= sizeOf(items.get(oldest))
        items.delete(oldest)
      }
    }
  }
}
const REVPARSE_KEPT_MS = 2000

// One folder's reader. `run` and `now` are injectable for the tests.
export function folderRepo(folder, { run = runGit, now = Date.now, maxEntries = MAX_TREE_ENTRIES, batch } = {}) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('The repo folder must be an absolute path.')
  // Files are read through one long-lived git program - unless the tests handed in their own runner.
  const reader = batch === undefined ? (run === runGit ? batchReaderFor(folder) : null) : batch
  const contents = makeContentCache()
  const treeKept = new Map() // commit -> the listing
  let revKept = { ref: null, id: null, at: -Infinity }
  const git = (args, options) => run(args, { cwd: folder, ...options })
  let lastFetch = { at: -Infinity, promise: null }
  const trees = new Map() // commit -> Set of blob ids it lists
  let remote = { url: null, at: -Infinity } // url: the address, '' for none, null when not known

  // The origin's address as written in the repo's config: a string, '' for no origin at all, or null
  // when git would not say. (Exit status 1 is git's "no such setting"; anything else is no answer.)
  // An answer is kept for a minute (the owner may add a remote); "would not say" is never kept, and
  // is never taken for "no remote". Asked with `config`, not `remote`: the options git is started
  // with can make a remote appear in the list.
  async function originUrl() {
    const t = now()
    if (remote.url !== null && t - remote.at < REMOTE_RECHECK_MS) return remote.url
    try {
      const { stdout } = await git(['config', '--get', 'remote.origin.url'], { maxBuffer: 4096 })
      remote = { url: stdout.toString('utf8').trim(), at: t }
    } catch (error) {
      if (error?.code === 1) remote = { url: '', at: t }
      else remote = { url: null, at: -Infinity }
    }
    return remote.url
  }

  // true / false, or null when git would not say.
  async function hasOrigin() {
    const url = await originUrl()
    return url === null ? null : url !== ''
  }

  // At most one fetch per FETCH_EVERY_MS, shared by everyone asking meanwhile. A failed fetch
  // (offline, signed out) is not an error: the board keeps showing what it last fetched.
  function refresh(branch) {
    const t = now()
    if (lastFetch.promise && t - lastFetch.at < FETCH_EVERY_MS) return lastFetch.promise
    // Accepted, not coded around: a student's own .git/config could `include.path` a committed file
    // that sets core.sshCommand. That needs the student's own config to point there, so whoever can
    // do that can already run programs as them.
    // Only a GitHub address is fetched from: any other origin could be a program (an ext:: or a
    // local path) rather than a server. Its last fetched state is shown as it is.
    const promise = origin().then((names) =>
      names
        ? git(
            // The stock upload-pack program, whatever remote.origin.uploadpack in the repo's own config names
            // (this option wins over the config; a -c setting would only be a second value after it).
            ['fetch', '--no-tags', '--no-recurse-submodules', '--upload-pack=git-upload-pack', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
            { timeoutMs: FETCH_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
          ).then(() => true, () => false)
        : false
    )
    lastFetch = { at: t, promise }
    return promise
  }

  async function revParse(refName) {
    // The same answer for a moment, unless a fetch has been started since it was asked.
    if (revKept.ref === refName && now() - revKept.at < REVPARSE_KEPT_MS && lastFetch.at <= revKept.at) return revKept.id
    try {
      const { stdout } = await git(['rev-parse', '--verify', '--quiet', `${refName}^{commit}`], { maxBuffer: 4096 })
      const id = stdout.toString('utf8').trim()
      const found = COMMIT_ID.test(id) ? id : null
      if (found) revKept = { ref: refName, id: found, at: now() }
      return found
    } catch {
      return null
    }
  }

  // The commit at the head of the branch, or null when it cannot be said.
  async function head(branch) {
    if (!isBranchName(branch)) return null
    const has = await hasOrigin()
    // git would not say whether there is a remote: no answer, never the local branch (which can hold unpushed work).
    if (has === null) return null
    if (has) {
      await refresh(branch)
      return revParse(`refs/remotes/origin/${branch}`)
    }
    return revParse(`refs/heads/${branch}`)
  }

  // A ref the board holds is a whole commit id or a branch name; anything else is no ref at all.
  async function commitOf(ref) {
    if (typeof ref === 'string' && COMMIT_ID.test(ref)) return ref
    return head(ref)
  }

  // { tree: [{ path, type: 'blob', size, sha, mode }] }, the shape GitHub's tree call gives.
  async function tree(ref) {
    const commit = await commitOf(ref)
    if (!commit) throw ourFailure(FOLDER_UNREADABLE)
    if (treeKept.has(commit)) {
      const kept = treeKept.get(commit)
      trees.set(commit, kept.shas)
      return { sha: kept.sha, tree: kept.tree.slice(), truncated: kept.truncated }
    }
    let stdout
    try {
      ;({ stdout } = await git(['ls-tree', '-r', '-l', '-z', commit], { maxBuffer: MAX_TREE_BYTES }))
    } catch {
      throw ourFailure(FOLDER_UNREADABLE)
    }
    const entries = []
    const shas = new Set()
    let truncated = false
    for (const record of stdout.toString('utf8').split('\0')) {
      const found = /^(\d{6}) (\w+) ([0-9a-f]{40}) +(\d+|-)\t([\s\S]+)$/.exec(record)
      // Files only: not folders (-r lists inside them), not submodules, and not links, whose "file"
      // is the text of where they point.
      if (!found || found[2] !== 'blob' || found[1] === '120000') continue
      if (entries.length >= maxEntries) {
        truncated = true
        break
      }
      entries.push({ path: found[5], type: 'blob', mode: found[1], sha: found[3], size: found[4] === '-' ? null : Number(found[4]) })
      shas.add(found[3])
    }
    trees.set(commit, shas)
    while (trees.size > KEEP_TREES) trees.delete(trees.keys().next().value)
    treeKept.set(commit, { sha: commit, tree: entries, truncated, shas })
    while (treeKept.size > KEEP_TREES) treeKept.delete(treeKept.keys().next().value)
    return { sha: commit, tree: entries.slice(), truncated }
  }

  // One object through the long-lived program, kept by what it is called at that commit.
  async function readThrough(query, key) {
    const kept = contents.get(key)
    if (kept !== undefined) return kept
    let answer
    try {
      answer = await reader.read(query)
    } catch {
      throw ourFailure(FOLDER_UNREADABLE)
    }
    const text = answer.bytes ? answer.bytes.toString('utf8') : null // missing, a folder, too big: like a file that is not there
    contents.set(key, text)
    return text
  }

  // One committed file's text, or null when the commit has no such file.
  async function file(ref, repoPath) {
    if (!isRepoPath(repoPath)) return null
    const commit = await commitOf(ref)
    if (!commit) return null
    if (reader) return readThrough(`${commit}:${repoPath}`, `${commit}:${repoPath}`)
    try {
      const { stdout } = await git(['cat-file', 'blob', `${commit}:${repoPath}`])
      return stdout.toString('utf8')
    } catch (error) {
      if (isMissing(error) || isTooBig(error)) return null
      throw ourFailure(FOLDER_UNREADABLE)
    }
  }

  // The text of the blob the last tree listing named with this id; null for any other id.
  async function blob(sha) {
    if (typeof sha !== 'string' || !COMMIT_ID.test(sha)) return null
    if (![...trees.values()].some((shas) => shas.has(sha))) return null
    if (reader) return readThrough(sha, `blob:${sha}`)
    try {
      const { stdout } = await git(['cat-file', 'blob', sha])
      return stdout.toString('utf8')
    } catch (error) {
      if (isMissing(error) || isTooBig(error)) return null
      throw ourFailure(FOLDER_UNREADABLE)
    }
  }

  // Who the team repo is on GitHub, read from the `origin` address, or null.
  async function origin() {
    const url = await originUrl()
    return url ? githubNames(url) : null
  }

  // What the page should say about where this folder stands: note is null when nothing needs saying.
  async function describe() {
    const has = await hasOrigin()
    if (has === null) return { hasOrigin: null, github: false, note: FOLDER_NOTES.unknown }
    if (!has) return { hasOrigin: false, github: false, note: FOLDER_NOTES.noRemote }
    const names = await origin()
    return names ? { hasOrigin: true, github: true, note: null } : { hasOrigin: true, github: false, note: FOLDER_NOTES.notGitHub }
  }

  // Forget the last fetch, so the next read fetches at once instead of waiting out FETCH_EVERY_MS. Used
  // by the board on this computer after its own runner has pushed (local/runner.mjs).
  function forgetFetch() {
    lastFetch = { at: -Infinity, promise: null }
    revKept = { ref: null, id: null, at: -Infinity }
  }

  return { head, tree, file, blob, hasOrigin, origin, describe, forgetFetch }
}

// One reader per folder for the life of the process, so the 30-second fetch limit and the list of
// known blobs are shared by every request.
const readers = new Map()
export function repoReader(folder) {
  if (!readers.has(folder)) readers.set(folder, folderRepo(folder))
  return readers.get(folder)
}

// The board on this computer, after its own runner pushed: the next read of this folder fetches at once.
// Nothing on the website calls it (there is no folder there).
export function refreshNow(folder) {
  readers.get(folder)?.forgetFetch()
}
