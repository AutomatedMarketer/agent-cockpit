// The picture store: the only file in the board that talks to Vercel Blob (spec 5c).
//
// Starts with "_" so Vercel does not turn it into an endpoint. Everything personalised - the
// pictures, the agents' display names, the art style, the assistant's name - lives in the
// owner's own PRIVATE Blob store, never in the business repo. The GitHub token stays read-only;
// this store is the board's only write power.
//
// Rules this file keeps, each for a reason:
// - The SDK is loaded with import(), on first use, and only when a store is connected. A board
//   without a store never pays for it, and a missing store can never crash a request that does
//   not need one. Tests pass their own loader, so no test ever loads the real SDK.
// - Every path starts agent-cockpit/, so the board keeps to its own folder in a store the owner
//   may use for other things.
// - access: 'private' on every call. A public blob has a URL anyone can open.
// - list() is never called. It is an "advanced operation" (2,000 a month on Hobby, and going over
//   locks the store for 30 days), and settings.json is already the index of what exists.
// - A picture is written once under its own version and never overwritten, so nobody is ever
//   shown a stale one from a cache. Only settings.json is replaced, and only with ifMatch, so two
//   changes made at the same moment cannot silently erase each other.
// - Every failure leaves here as one plain sentence. The SDK's own messages are for developers,
//   and some of them could carry a credential.

import { isValidSlug, parseSlot } from './lib.js'

const ROOT = 'agent-cockpit'
export const SETTINGS_PATH = `${ROOT}/settings.json`

// Versions are made by the server, never typed by a person, so the shape can be strict.
const VERSION_SHAPE = /^[a-z0-9]{8,32}$/
const TYPE_EXTENSION = { 'image/webp': 'webp', 'image/jpeg': 'jpeg', 'image/png': 'png' }

const SETTINGS_MAX_BYTES = 64 * 1024
// A banner's budget is 100 KB; a little headroom, and nothing like room for something else.
const PICTURE_MAX_BYTES = 110 * 1024
const SAVE_TRIES = 3
const YEAR_SECONDS = 365 * 24 * 60 * 60

export const NOT_CONNECTED =
  'No picture store is connected: in Vercel, create a Private Blob store for this project, then redeploy.'

export function storeConnected(env = process.env) {
  return Boolean(env.BLOB_STORE_ID || env.BLOB_READ_WRITE_TOKEN)
}

export const isPictureVersion = (value) => typeof value === 'string' && VERSION_SHAPE.test(value)
export const pictureExtension = (type) => TYPE_EXTENSION[type] ?? null

// Thrown by every method below. `status` is what the endpoint should answer with, and
// `message` is the sentence to show the person.
export class PictureStoreError extends Error {
  constructor(status, sentence) {
    super(sentence)
    this.status = status
  }
}

// --- the settings file ---------------------------------------------------------------

export function emptySettings() {
  return {
    version: 1,
    assistantName: '',
    artStyle: '',
    names: {},
    pictures: {},
    usage: { day: '', writes: 0, generated: 0 }
  }
}

const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const count = (value) => (Number.isInteger(value) && value >= 0 ? value : 0)

// settings.json is where every picture path comes from, so it is read as if a stranger wrote it:
// anything the board itself could not have written is dropped rather than followed.
function normaliseSettings(raw) {
  const settings = emptySettings()
  if (!plainObject(raw)) return settings
  if (typeof raw.assistantName === 'string') settings.assistantName = raw.assistantName
  if (typeof raw.artStyle === 'string') settings.artStyle = raw.artStyle
  for (const [slug, name] of Object.entries(plainObject(raw.names) ? raw.names : {})) {
    if (isValidSlug(slug) && typeof name === 'string' && name) settings.names[slug] = name
  }
  for (const [slot, picture] of Object.entries(plainObject(raw.pictures) ? raw.pictures : {})) {
    if (!parseSlot(slot) || !plainObject(picture)) continue
    if (!isPictureVersion(picture.v) || !pictureExtension(picture.type)) continue
    settings.pictures[slot] = {
      v: picture.v,
      type: picture.type,
      bytes: count(picture.bytes),
      at: typeof picture.at === 'string' ? picture.at : ''
    }
  }
  if (plainObject(raw.usage)) {
    settings.usage = {
      day: typeof raw.usage.day === 'string' ? raw.usage.day : '',
      writes: count(raw.usage.writes),
      generated: count(raw.usage.generated)
    }
  }
  return settings
}

function picturePath(slot, version, type) {
  const extension = pictureExtension(type)
  if (!parseSlot(slot) || !isPictureVersion(version) || !extension) {
    throw new PictureStoreError(400, 'That is not a picture this board keeps.')
  }
  return `${ROOT}/art/${slot}/${version}.${extension}`
}

// Reads a response body up to a limit, and stops reading the moment it is passed - a body is
// never buffered whole just to find out it was too big.
async function readCapped(stream, limit) {
  const reader = stream.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
  }
  return Buffer.concat(chunks)
}

// --- failures as sentences -------------------------------------------------------------

// Matched by the SDK's own classes where it has one. A public store has no class of its own, so
// it is recognised by the word in the service's message - and that sentence is the one that
// matters most, because Vercel asks Public or Private once and it cannot be changed afterwards.
export function storeFailure(error, sdk = {}) {
  const is = (name) => typeof sdk[name] === 'function' && error instanceof sdk[name]
  const text = error instanceof Error ? error.message : ''
  if (/\bpublic\b/i.test(text)) {
    return {
      status: 503,
      error: 'This picture store is public and the board only uses private ones, so create a private one, connect it to this project and redeploy.'
    }
  }
  if (is('BlobAccessError') || /no read-write token|oidc/i.test(text)) {
    return {
      status: 503,
      error: 'The picture store did not accept this board\'s credentials, so connect the store to this project in Vercel\'s Storage tab and redeploy.'
    }
  }
  if (is('BlobStoreNotFoundError')) {
    return { status: 503, error: 'The picture store this board points at no longer exists, so connect a new private one and redeploy.' }
  }
  if (is('BlobStoreSuspendedError')) {
    return { status: 503, error: 'The picture store is suspended, usually because this month\'s free allowance ran out, so check Storage in Vercel.' }
  }
  if (is('BlobServiceRateLimited')) {
    return { status: 429, error: 'The picture store is busy right now, so wait a minute and try again.' }
  }
  if (is('BlobServiceNotAvailable') || is('BlobRequestAbortedError')) {
    return { status: 503, error: 'The picture store is not answering right now, so try again in a minute.' }
  }
  if (is('BlobFileTooLargeError')) {
    return { status: 413, error: 'That picture is too big for the store.' }
  }
  if (is('BlobPreconditionFailedError')) {
    return { status: 409, error: 'These settings were changed somewhere else at the same moment, so try again.' }
  }
  return {
    status: 502,
    error: 'The picture store did not accept that, so try again, and if it keeps failing check the store in Vercel\'s Storage tab.'
  }
}

// --- the store ---------------------------------------------------------------------------

const loadRealSdk = () => import('@vercel/blob')

// Returns null when no store is connected - callers answer with NOT_CONNECTED. `loadSdk` is
// injectable so the tests hand in an in-memory fake; in production it is the lazy import above.
export function pictureStore(env = process.env, loadSdk = loadRealSdk) {
  if (!storeConnected(env)) return null

  let loading = null
  const sdk = () => (loading ??= Promise.resolve(loadSdk()))

  // Runs one SDK call and turns anything it throws into a sentence.
  async function attempt(call) {
    const blob = await sdk()
    try {
      return await call(blob)
    } catch (error) {
      if (error instanceof PictureStoreError) throw error
      const { status, error: sentence } = storeFailure(error, blob)
      throw new PictureStoreError(status, sentence)
    }
  }

  async function readSettings() {
    const found = await attempt((blob) => blob.get(SETTINGS_PATH, { access: 'private', useCache: false }))
    if (!found || found.statusCode !== 200 || !found.stream) return { settings: emptySettings(), etag: null }
    const etag = found.blob?.etag || null
    const text = await readCapped(found.stream, SETTINGS_MAX_BYTES)
    // A damaged or oversized file reads as the defaults, but keeps its etag: the next save then
    // replaces it with ifMatch instead of failing to create a file that is already there.
    let parsed = null
    try {
      parsed = text ? JSON.parse(text.toString('utf8')) : null
    } catch {
      parsed = null
    }
    return { settings: normaliseSettings(parsed), etag }
  }

  // `mutate` gets a copy of the current settings and returns the new ones (or changes the copy
  // in place). It is run again on every retry against the latest file, so a change made by
  // someone else in between is built on, never thrown away. Anything `mutate` throws - a daily
  // cap, a refusal - passes straight through and nothing is written.
  async function saveSettings(mutate) {
    for (let tries = 1; tries <= SAVE_TRIES; tries += 1) {
      const { settings, etag } = await readSettings()
      const draft = structuredClone(settings)
      const next = normaliseSettings((await mutate(draft)) ?? draft)
      // First save creates the file and must not replace one that appeared meanwhile; every save
      // after that replaces it only if it is still the version this one read.
      const guard = etag ? { allowOverwrite: true, ifMatch: etag } : { allowOverwrite: false }
      const blob = await sdk()
      try {
        await blob.put(SETTINGS_PATH, JSON.stringify(next), {
          access: 'private',
          contentType: 'application/json',
          addRandomSuffix: false,
          cacheControlMaxAge: 60,
          ...guard
        })
        return next
      } catch (error) {
        const lostRace = etag
          ? typeof blob.BlobPreconditionFailedError === 'function' && error instanceof blob.BlobPreconditionFailedError
          : (await readSettings()).etag !== null
        if (lostRace) continue
        const { status, error: sentence } = storeFailure(error, blob)
        throw new PictureStoreError(status, sentence)
      }
    }
    throw new PictureStoreError(409, 'These settings were changed somewhere else at the same moment, so try again.')
  }

  async function putPicture(slot, version, bytes, type) {
    const path = picturePath(slot, version, type)
    await attempt((blob) =>
      blob.put(path, bytes, {
        access: 'private',
        contentType: type,
        addRandomSuffix: false,
        allowOverwrite: false,
        cacheControlMaxAge: YEAR_SECONDS
      })
    )
    return path
  }

  // Null when there is no such picture. Versions never change, so the cache is fine here.
  async function getPicture(slot, version, type) {
    const path = picturePath(slot, version, type)
    const found = await attempt((blob) => blob.get(path, { access: 'private' }))
    if (!found || found.statusCode !== 200 || !found.stream) return null
    const bytes = await readCapped(found.stream, PICTURE_MAX_BYTES)
    if (!bytes) throw new PictureStoreError(502, 'That stored picture is larger than the board will show.')
    return bytes
  }

  async function dropPicture(slot, version, type) {
    const path = picturePath(slot, version, type)
    await attempt((blob) => blob.del(path))
  }

  return { readSettings, saveSettings, putPicture, getPicture, dropPicture }
}
