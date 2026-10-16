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
// - Every GIT_* variable of the board's own environment is dropped (GIT_DIR, GIT_SSH_COMMAND and the
//   like would redirect git), and git never asks anything on a terminal.
// - Each call has a time limit and an output limit, and at most MAX_AT_ONCE run together.

import { execFile } from 'node:child_process'
import path from 'node:path'

export const FETCH_EVERY_MS = 30_000
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
export const FOLDER_UNREADABLE =
  'The board could not read the team folder with git, so check that the folder is a clone of your team repo and that git is installed.'

// The environment git runs in: the board's own, minus every GIT_* variable, plus the two that keep
// it quiet. (HOME / USERPROFILE stay, so git finds the student's own sign-in for a fetch.)
export function gitEnvironment(source = process.env) {
  const env = {}
  for (const [name, value] of Object.entries(source)) {
    if (!name.toUpperCase().startsWith('GIT_') && value !== undefined) env[name] = value
  }
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GCM_INTERACTIVE = 'never'
  return env
}

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
    return await new Promise((resolve, reject) => {
      execFile(
        'git',
        // Fixed, safe-by-default options ahead of every command: no fsmonitor program from the repo's
        // own config, no ext:: remotes, no background gc or maintenance racing the student's work.
        ['-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args],
        { cwd, env: gitEnvironment(), encoding: 'buffer', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer, windowsHide: true },
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

const MISSING = /bad file|does not exist|exists on disk, but not in|not a valid object name|bad object|invalid object name|unknown revision|not a tree object/i
const stderrText = (error) => (error?.stderr ? Buffer.from(error.stderr).toString('utf8') : '')
const isMissing = (error) => error?.code === 128 && MISSING.test(stderrText(error))
// A file bigger than the output limit is not shown, like one that is not there - it must not take the whole board down with it.
const isTooBig = (error) => error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'

// One folder's reader. `run` and `now` are injectable for the tests.
export function folderRepo(folder, { run = runGit, now = Date.now } = {}) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('The repo folder must be an absolute path.')
  const git = (args, options) => run(args, { cwd: folder, ...options })
  let lastFetch = { at: -Infinity, promise: null }
  const trees = new Map() // commit -> Set of blob ids it lists
  let remote = null // true / false once known

  async function hasOrigin() {
    if (remote !== null) return remote
    try {
      const { stdout } = await git(['remote'], { maxBuffer: 64 * 1024 })
      remote = stdout.toString('utf8').split(/\r?\n/).includes('origin')
    } catch {
      return false // not remembered: asked again next time
    }
    return remote
  }

  // At most one fetch per FETCH_EVERY_MS, shared by everyone asking meanwhile. A failed fetch
  // (offline, signed out) is not an error: the board keeps showing what it last fetched.
  function refresh(branch) {
    const t = now()
    if (lastFetch.promise && t - lastFetch.at < FETCH_EVERY_MS) return lastFetch.promise
    const promise = git(
      ['fetch', '--no-tags', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      { timeoutMs: FETCH_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
    ).then(() => true, () => false)
    lastFetch = { at: t, promise }
    return promise
  }

  async function revParse(refName) {
    try {
      const { stdout } = await git(['rev-parse', '--verify', '--quiet', `${refName}^{commit}`], { maxBuffer: 4096 })
      const id = stdout.toString('utf8').trim()
      return COMMIT_ID.test(id) ? id : null
    } catch {
      return null
    }
  }

  // The commit at the head of the branch, or null when it cannot be said.
  async function head(branch) {
    if (!isBranchName(branch)) return null
    if (await hasOrigin()) {
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
      if (entries.length >= MAX_TREE_ENTRIES) {
        truncated = true
        break
      }
      entries.push({ path: found[5], type: 'blob', mode: found[1], sha: found[3], size: found[4] === '-' ? null : Number(found[4]) })
      shas.add(found[3])
    }
    trees.set(commit, shas)
    while (trees.size > KEEP_TREES) trees.delete(trees.keys().next().value)
    return { sha: commit, tree: entries, truncated }
  }

  // One committed file's text, or null when the commit has no such file.
  async function file(ref, repoPath) {
    if (!isRepoPath(repoPath)) return null
    const commit = await commitOf(ref)
    if (!commit) return null
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
    try {
      const { stdout } = await git(['config', '--get', 'remote.origin.url'], { maxBuffer: 4096 })
      return githubNames(stdout.toString('utf8'))
    } catch {
      return null
    }
  }

  return { head, tree, file, blob, hasOrigin, origin }
}

// One reader per folder for the life of the process, so the 30-second fetch limit and the list of
// known blobs are shared by every request.
const readers = new Map()
export function repoReader(folder) {
  if (!readers.has(folder)) readers.set(folder, folderRepo(folder))
  return readers.get(folder)
}
