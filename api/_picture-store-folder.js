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

import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
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
  constructor(message) {
    super(`Picture folder: ${message}`)
    this.name = 'BlobError'
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
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new FolderStoreError('the folder must be an absolute path.')
  let rootReal = null
  async function root() {
    if (rootReal) return rootReal
    await mkdir(folder, { recursive: true, mode: 0o700 })
    rootReal = await realpath(folder)
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

  return {
    BlobError: FolderStoreError,
    BlobPreconditionFailedError: FolderPreconditionFailedError,

    async get(name) {
      const { rule, exists, info, at } = await locate(name)
      if (!exists) return null
      let etag
      if (info.size <= rule.cap) {
        etag = etagOf(await readFile(at))
      } else {
        // Too big to be one of the board's files: not hashed, and the caller's size cap refuses it.
        etag = `"big-${info.size}-${Math.trunc(info.mtimeMs)}"`
      }
      return {
        statusCode: 200,
        stream: Readable.toWeb(createReadStream(at)),
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
        const { base, parts, exists, at } = await locate(name)
        if (options.ifMatch !== undefined) {
          const current = exists ? etagOf(await readFile(at)) : null
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
