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
    const program = gitProgram()
    // A program inside the team folder would be run with the student's rights by whoever put it
    // there: refused, whatever the PATH says.
    if (cwd && isInside(cwd, program)) throw ourFailure(FOLDER_UNREADABLE)
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

// One folder's reader. `run` and `now` are injectable for the tests.
export function folderRepo(folder, { run = runGit, now = Date.now, maxEntries = MAX_TREE_ENTRIES } = {}) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('The repo folder must be an absolute path.')
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

  return { head, tree, file, blob, hasOrigin, origin, describe }
}

// One reader per folder for the life of the process, so the 30-second fetch limit and the list of
// known blobs are shared by every request.
const readers = new Map()
export function repoReader(folder) {
  if (!readers.has(folder)) readers.set(folder, folderRepo(folder))
  return readers.get(folder)
}
