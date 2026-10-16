// The picture store on a plain folder: the same three calls the picture store makes on Vercel Blob
// (get, put with ifMatch, del), kept on the student's own computer. Chosen only when the board is
// started with PICTURE_STORE=folder and PICTURE_FOLDER=<an absolute folder>; Vercel never has them.
//
// This file is the only one that touches the disk for the store, so it is built as if the names
// it is handed came from a stranger:
// - A name must match one of six exact shapes (the same files the store keeps on Blob). Anything
//   else - "..", a backslash, a drive letter, a leading slash, a NUL, an odd extension - is refused
//   before the disk is looked at.
// - No folder on the way to a file, and not the file, may be a link (a symlink or a junction):
//   a link planted inside the folder cannot lead a read or a write outside it.
// - Each file has the size cap and content type it has on Blob.
// - A save writes a temporary file beside the target and renames it over, so a crash never leaves
//   half a file, and files are made private to the user (0600, folders 0700).
//
// Saves take turns per folder inside this process; one board runs one process, so ifMatch (the
// file's SHA-256 as its etag) holds the way it does on Blob.
//
// What this does not stop, on purpose: someone who is already signed in as the same user on this
// computer can swap a folder for a link between the board's check and its read or write (a race
// of microseconds). That person can already open every file in the folder, so it gives them
// nothing; the checks are here so a stranger's planted link cannot lead the board anywhere.
//
// Who can open the folder: 0600 / 0700 mean something only on Mac and Linux. Windows has no such
// modes, so there the folder is refused unless it is inside the user's own profile
// (C:\Users\<you>), which Windows already keeps from other users.

import { createHash, randomBytes } from 'node:crypto'
import os from 'node:os'
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isValidSlug, parseSlot } from './_lib.js'

const ROOT = 'agent-cockpit'
const KB = 1024

// Per file: how big it may be. Equal to the caps in _picture-store.js (a test holds them equal),
// so a folder keeps nothing a Blob store would refuse.
export const FOLDER_CAPS = {
  settings: 64 * KB,
  meter: 512 * KB,
  index: 8 * 1024 * KB,
  queue: 512 * KB,
  picture: 110 * KB
}
const JSON_FILES = new Map([
  [`${ROOT}/settings.json`, FOLDER_CAPS.settings],
  [`${ROOT}/voice-meter.json`, FOLDER_CAPS.meter],
  [`${ROOT}/memory-index.json`, FOLDER_CAPS.index],
  [`${ROOT}/mailbox/queue.json`, FOLDER_CAPS.queue]
])
const PICTURE_TYPES = { webp: 'image/webp', jpeg: 'image/jpeg', png: 'image/png' }
const ART = /^agent-cockpit\/art\/([a-z0-9-]+)\/([a-z0-9]{8,32})\.(webp|jpeg|png)$/

// Named BlobError so the store's failure mapper turns it into its one plain sentence, never this text.
export class FolderStoreError extends Error {
  // `say`, when given, is a sentence the person may be shown as it is (a setting they can fix).
  constructor(message, say = null) {
    super(`Picture folder: ${message}`)
    this.name = 'BlobError'
    this.say = say
  }
}
export class FolderPreconditionFailedError extends FolderStoreError {
  constructor() { super('Precondition failed: ETag mismatch.') }
}

// What a name is allowed to be: { cap, type } or null. Pure, so it can be tested on its own.
export function allowedName(name) {
  if (typeof name !== 'string' || name.length > 200) return null
  if (JSON_FILES.has(name)) return { cap: JSON_FILES.get(name), type: 'application/json' }
  const art = ART.exec(name)
  if (!art) return null
  const [, slot, , extension] = art
  if (!parseSlot(slot)) return null
  if (slot.startsWith('agent-') && !isValidSlug(slot.slice('agent-'.length))) return null
  return { cap: FOLDER_CAPS.picture, type: PICTURE_TYPES[extension] }
}

// Windows only: is `folder` inside `home`? (Case does not matter there.) Elsewhere always true.
export function insideProfile(folder, home = os.homedir(), platform = process.platform) {
  if (platform !== 'win32') return true
  const fold = (value) => path.resolve(value).toLowerCase()
  const relative = path.relative(fold(home), fold(folder))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}
export const OUTSIDE_PROFILE =
  'On Windows the picture folder must be inside your own user folder (for example C:\\Users\\you\\AppData\\Local\\Agent Board), so other users of this computer cannot open it: change PICTURE_FOLDER, then start the board again.'

async function readUpTo(at, limit) {
  const handle = await open(at, 'r')
  try {
    const buffer = Buffer.alloc(limit)
    const { bytesRead } = await handle.read(buffer, 0, limit, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

const etagOf = (bytes) => `"sha256-${createHash('sha256').update(bytes).digest('hex')}"`

// Every folder from the root down to the file's own must be a real folder, and the file a real file.
async function checkNoLinks(rootReal, parts, { wantFile }) {
  let at = rootReal
  for (let index = 0; index < parts.length; index += 1) {
    at = path.join(at, parts[index])
    let info
    try {
      info = await lstat(at)
    } catch (error) {
      if (error?.code === 'ENOENT') return { exists: false, info: null, at }
      throw error
    }
    const last = index === parts.length - 1
    if (info.isSymbolicLink()) throw new FolderStoreError('a link inside the folder was refused.')
    if (last && wantFile) {
      if (!info.isFile()) throw new FolderStoreError('that is not a plain file.')
      if (info.nlink > 1) throw new FolderStoreError('a file with a second name was refused.')
      return { exists: true, info, at }
    }
    if (!info.isDirectory()) throw new FolderStoreError('that is not a plain folder.')
  }
  return { exists: true, info: null, at }
}

const chains = new Map()
function inTurn(key, work) {
  const before = chains.get(key) ?? Promise.resolve()
  const mine = before.then(work, work)
  chains.set(key, mine.then(() => {}, () => {}))
  return mine
}

// `folder` must be an absolute path; the board checks that first (folderConfigured).
export function folderSdk(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) {
    throw new FolderStoreError('the folder must be an absolute path.', 'PICTURE_FOLDER must be the full path of a folder on this computer, for example C:\\Users\\you\\AppData\\Local\\Agent Board\\pictures: set it, then start the board again.')
  }
  let rootReal = null
  async function root() {
    if (rootReal) return rootReal
    if (!insideProfile(folder)) throw new FolderStoreError('outside the user profile', OUTSIDE_PROFILE)
    await mkdir(folder, { recursive: true, mode: 0o700 })
    rootReal = await realpath(folder)
    // A link on the way must not carry the folder out of the profile either.
    if (!insideProfile(rootReal, await realpath(os.homedir()))) throw new FolderStoreError('outside the user profile', OUTSIDE_PROFILE)
    return rootReal
  }

  async function locate(name) {
    const rule = allowedName(name)
    if (!rule) throw new FolderStoreError('that name is not one the board keeps.')
    const base = await root()
    const parts = name.split('/')
    const found = await checkNoLinks(base, parts, { wantFile: true })
    // `at` is always the file's full path, whether or not it exists yet.
    return { rule, base, parts, exists: found.exists, info: found.info, at: path.join(base, ...parts) }
  }

  // The etag of a file already on disk. One bigger than the board ever writes is not read at all.
  async function etagFor(at, info, rule) {
    return info.size <= rule.cap ? etagOf(await readFile(at)) : `"big-${info.size}-${Math.trunc(info.mtimeMs)}"`
  }

  return {
    isFolder: true,
    BlobError: FolderStoreError,
    BlobPreconditionFailedError: FolderPreconditionFailedError,

    async get(name) {
      const { rule, exists, info, at } = await locate(name)
      if (!exists) return null
      // A file too big to be one of the board's is not hashed, and only its first cap + 1 bytes are
      // read: enough for the caller's size cap to refuse it. The file is closed again before this
      // returns, so a stream nobody finishes reading cannot hold a Windows file open.
      const etag = await etagFor(at, info, rule)
      const bytes = await readUpTo(at, rule.cap + 1)
      return {
        statusCode: 200,
        stream: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(bytes)); controller.close() } }),
        headers: new Headers({ etag }),
        blob: { pathname: name, contentType: rule.type, etag, size: info.size }
      }
    },

    async put(name, body, options = {}) {
      const rule = allowedName(name)
      if (!rule) throw new FolderStoreError('that name is not one the board keeps.')
      if (options.contentType !== rule.type) throw new FolderStoreError('that content type does not belong to that file.')
      const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body)
      if (bytes.length > rule.cap) throw new FolderStoreError('that file is bigger than the board keeps.')
      return inTurn(folder, async () => {
        const { base, parts, exists, info, at } = await locate(name)
        if (options.ifMatch !== undefined) {
          const current = exists ? await etagFor(at, info, rule) : null
          if (current !== options.ifMatch) throw new FolderPreconditionFailedError()
        } else if (exists && !options.allowOverwrite) {
          throw new FolderStoreError('this file already exists.')
        }
        const directory = path.join(base, ...parts.slice(0, -1))
        await mkdir(directory, { recursive: true, mode: 0o700 })
        // A folder could have been swapped for a link since the first look: look again before writing.
        await checkNoLinks(base, parts.slice(0, -1), { wantFile: false })
        const temporary = path.join(directory, `.${parts.at(-1)}.${randomBytes(6).toString('hex')}.tmp`)
        try {
          await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
          await rename(temporary, at)
        } catch (error) {
          await rm(temporary, { force: true }).catch(() => {})
          throw error
        }
        return { pathname: name, url: `folder:${name}`, contentType: rule.type, etag: etagOf(bytes) }
      })
    },

    async del(names) {
      for (const name of [names].flat()) {
        await inTurn(folder, async () => {
          const { exists, at } = await locate(name)
          if (exists) await rm(at, { force: true })
        })
      }
    }
  }
}

// What the board uses: the same, except that a folder setting that cannot be used gives a store whose
// every call fails with the sentence about it, rather than an error thrown before any call is made.
export function folderSdkSafe(folder) {
  try {
    return folderSdk(folder)
  } catch (error) {
    const fail = async () => { throw error }
    return { isFolder: true, BlobError: FolderStoreError, BlobPreconditionFailedError: FolderPreconditionFailedError, get: fail, put: fail, del: fail }
  }
}
