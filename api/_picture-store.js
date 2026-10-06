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

import { isValidSlug, parseSlot, readCapped } from './lib.js'

const ROOT = 'agent-cockpit'
export const SETTINGS_PATH = `${ROOT}/settings.json`

// Versions are made by the server, never typed by a person, so the shape can be strict.
const VERSION_SHAPE = /^[a-z0-9]{8,32}$/
const TYPE_EXTENSION = { 'image/webp': 'webp', 'image/jpeg': 'jpeg', 'image/png': 'png' }

const SETTINGS_MAX_BYTES = 64 * 1024
// How many agents the board keeps a name and a portrait for. A bound on entries rather than a
// check against the team: refusing a name for an agent that is not in the team would mean
// reading the team repo on every rename, so renaming would fail whenever GitHub does - and a
// name for an agent since removed is harmless. At their longest (100-character slugs, 40-unit
// names that JSON writes as escapes), 64 names and 66 pictures are still under half of
// SETTINGS_MAX_BYTES, so the file can never outgrow what a read takes in.
const MAX_NAMED_AGENTS = 64
const MAX_PICTURES = MAX_NAMED_AGENTS + 2 // and the Today and Team banners
// A banner's budget is 100 KB; a little headroom, and nothing like room for something else.
const PICTURE_MAX_BYTES = 110 * 1024
const SAVE_TRIES = 3
const YEAR_SECONDS = 365 * 24 * 60 * 60

// A settings file the board cannot read is never read as the defaults: the next save would then
// write the defaults over it, and every name, the style and every picture pointer would be gone.
const SETTINGS_DAMAGED =
  'The board\'s settings file in the picture store is damaged or too big, so nothing was changed: to ' +
  'start again from the defaults, delete agent-cockpit/settings.json in the store (Vercel, Storage).'
const TOO_MANY_NAMES =
  `This board keeps names for up to ${MAX_NAMED_AGENTS} agents, so clear a name you no longer use, then try again.`
const TOO_MANY_PICTURES =
  `This board keeps pictures for up to ${MAX_NAMED_AGENTS} agents and the two banners, so put one ` +
  'you no longer use back to its default, then try again.'
const TOO_BIG =
  'That change would make the board\'s settings too big to save, so shorten the art style or clear some names, then try again.'

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

// --- failures as sentences -------------------------------------------------------------

// Matched by the SDK's own classes where it has one. A public store has no class of its own, so
// it is recognised by its words - and that sentence matters most, because Vercel asks Public or
// Private once and it cannot be changed afterwards. It also tells the owner to make a new store,
// the wrong fix for anything else, so it is kept narrow: an error the SDK raised (a BlobError)
// that says "public store" or "store is public". The service's exact wording for a private call
// on a public store could not be checked against SDK 2.8.0 (no class or code for it), so this is
// the narrowest match that still catches either way of putting it.
const PUBLIC_STORE = /\bpublic store\b|\bstore is public\b/i

export function storeFailure(error, sdk = {}) {
  const is = (name) => typeof sdk[name] === 'function' && error instanceof sdk[name]
  const text = error instanceof Error ? error.message : ''
  if (is('BlobError') && PUBLIC_STORE.test(text)) {
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

// The sentence and status for anything a personalise endpoint catches. A store failure already
// is a sentence; anything else is a bug, and its message is for a developer, never the page.
export function failureAnswer(error) {
  if (error instanceof PictureStoreError) return { status: error.status, error: error.message }
  return { status: 500, error: 'Something went wrong on the board\'s side, so try again in a minute.' }
}

// --- the daily caps, and the month's budget they come from ---------------------------------
// Vercel Blob on Hobby includes 2,000 advanced operations a month (every put, copy and list) and
// 10,000 simple ones (a read that misses the cache), and past either one "you will not be able to
// access Vercel Blob" until 30 days have passed (vercel.com/docs/vercel-blob/usage-and-pricing,
// checked 2026-10-06). del() is free. Every made picture also costs the owner OpenAI money. So
// changes and pictures from words are capped per day, counted inside settings.json - the file
// every change writes anyway, so counting costs no extra operation.
//
// THE BUDGET, in puts a day, at worst:
//   a change (upload, rename, style, assistant, reset)   2 puts - an upload is settings.json plus
//                                                          the picture; the others are 1, but the
//                                                          cap cannot know which is coming
//   a picture from words                                  1 put  - the save that counts it (storing
//                                                          the picture is then an upload)
//
//   2 x WRITE_DAILY_CAP + GENERATE_DAILY_CAP <= ADVANCED_OPS_PER_DAY = 55
//
// 55 a day is 1,705 in a 31-day month, which keeps 295 of the 2,000 for what no cap can see: a
// save that collides with one from another instance, the SDK retrying a failed put (up to
// VERCEL_BLOB_RETRIES times, 10 unless set), a slot pointed back after a failed upload, and the
// owner browsing the store in Vercel's dashboard, which Vercel counts too. The defaults, 20 and
// 10, are 50 a day. Asked for more, the caps are clamped (dailyCaps, below), never trusted: so
// raising a cap is never the advice, because past the budget it is the advice that locks the store.
//
// The day is the UTC day: the count starts again at midnight UTC. The server cannot know which
// timezone the owner lives in, Vercel's servers run in UTC anyway, and one fixed boundary is one
// the sentence below and the README can state plainly.

export const ADVANCED_OPS_PER_DAY = 55
const PUTS_PER_CHANGE = 2
const PUTS_PER_PICTURE_MADE = 1
const DEFAULT_CAPS = { writes: 20, generated: 10 }

const WHY_THE_LIMIT =
  'the limit keeps the picture store inside Vercel\'s free monthly allowance, which locks the ' +
  'store for 30 days if it is passed'

const CAP_SENTENCES = {
  writes:
    'This board has made all the changes it allows today, so try again tomorrow (the count ' +
    `starts again at midnight UTC): ${WHY_THE_LIMIT}.`,
  generated:
    'This board has made all the pictures from words it allows today, so try again tomorrow ' +
    '(the count starts again at midnight UTC).'
}

// A whole number, zero or more; anything else keeps the default rather than guessing. Zero is a
// real choice: it turns that kind of change off. Then clamped to the budget above: changes first,
// to as many as fit on their own (27), and pictures from words to whatever the changes leave -
// a made picture is no use without a change to store it with.
export function dailyCaps(env = process.env) {
  const read = (value, fallback) => (/^\d+$/.test(String(value ?? '').trim()) ? Number(value) : fallback)
  const writes = Math.min(
    read(env.WRITE_DAILY_CAP, DEFAULT_CAPS.writes),
    Math.floor(ADVANCED_OPS_PER_DAY / PUTS_PER_CHANGE)
  )
  const generated = Math.min(
    read(env.GENERATE_DAILY_CAP, DEFAULT_CAPS.generated),
    Math.floor((ADVANCED_OPS_PER_DAY - writes * PUTS_PER_CHANGE) / PUTS_PER_PICTURE_MADE)
  )
  return { writes, generated }
}

export const usageDay = (date) => date.toISOString().slice(0, 10)

// The day only moves forward. A request whose clock still says yesterday can reach the store
// after another has started today's count; its "day" is then behind the file's, and it is held to
// the file's count rather than handed a fresh one. (ISO dates compare as strings.)
export function allowanceLeft(settings, caps, day) {
  const used = settings.usage.day >= day ? settings.usage : { writes: 0, generated: 0 }
  return {
    writes: Math.max(0, caps.writes - used.writes),
    generated: Math.max(0, caps.generated - used.generated)
  }
}

// Called inside a saveSettings change, so the count and the change land in the same write - or,
// at the cap, the throw stops the write and nothing is saved at all.
export function spendAllowance(settings, kind, caps, day) {
  if (settings.usage.day < day) settings.usage = { day, writes: 0, generated: 0 }
  if (settings.usage[kind] >= caps[kind]) throw new PictureStoreError(429, CAP_SENTENCES[kind])
  settings.usage[kind] += 1
}

// Before a save, the same charge run on the CACHED copy (`charge` is the save's own counting, so
// the two can never disagree). Every save starts with a read that skips the cache - a simple
// operation, 10,000 a month on Hobby - so a change refused at the cap used to cost one anyway, and
// a thousand refused changes a thousand. The cached copy can only be behind the real one: counts
// only rise within a day and the day only moves forward. So when it says the day is spent, the day
// is spent, and the refusal costs a cache hit; when it says there is room, the save checks again
// against the latest file.
export async function refuseIfSpent(pictures, charge) {
  const { settings } = await pictures.readSettings()
  charge(settings)
}

// --- the store ---------------------------------------------------------------------------

const loadRealSdk = () => import('@vercel/blob')

// Saves made at the same moment by one function instance take turns. Each try of a save is a
// put, and every put is an advanced operation - the ones ifMatch refuses included - so saves
// that collide spend the month's 2,000 on nothing: one burst of 200 uploads cost 593 settings
// writes before this. In turn, each save reads the file the one before it wrote and never
// collides. Saves from other instances still can, and ifMatch keeps both changes safe there.
//
// A store call can hang for minutes, so a save waits for the one before it for TURN_WAIT_MS at
// most and then goes ahead anyway. Turns are kept per SDK loader: in production that is
// loadRealSdk, one per instance; each test store passes its own, and so is its own instance.
const TURN_WAIT_MS = 10_000
const turns = new WeakMap()

// What this instance last read for showing the board, kept SHOWN_MS - "no settings file yet"
// included. Before the first change there is no settings.json, and whether the CDN keeps a "not
// found" could not be checked (if it does not, every load of an open board would be a billed
// miss). A GET must never create the file, or anyone could spend the store's writes, so instead
// each instance asks at most once per SHOWN_MS. This instance's own saves replace the copy at once,
// so a change shows on its next page load; other instances can take SHOWN_MS longer, on top of the
// CDN's minute. Kept per SDK loader, like the turns above.
const SHOWN_MS = 30_000
const shown = new WeakMap()

function takeTurn(key, work) {
  const before = turns.get(key) ?? Promise.resolve()
  const mine = before.then(() => work())
  const giveUp = () => new Promise((resolve) => setTimeout(resolve, TURN_WAIT_MS).unref?.())
  turns.set(key, before.then(() => Promise.race([mine.then(() => {}, () => {}), giveUp()])))
  return mine
}

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

  // Showing the board reads the CDN's copy: a cache hit costs nothing, and a miss is one of the
  // 10,000 simple operations Hobby includes a month - and GET /api/brand needs no key on an open
  // board, so an uncached read there was a meter anyone could run. The copy can be up to a minute
  // old (settings.json is stored with cacheControlMaxAge: 60); the person who made a change is
  // answered from the save itself, so only other screens wait that minute. `fresh` skips the cache
  // and is for saveSettings alone: a save must build on the latest file, or its ifMatch fails.
  //
  // On top of that, a display read is answered from `shown` (above) while it is under SHOWN_MS old.
  async function readSettings({ fresh = false } = {}) {
    if (fresh) return readFromStore({ access: 'private', useCache: false })
    const kept = shown.get(loadSdk)
    if (kept && Date.now() - kept.at < SHOWN_MS) return { settings: structuredClone(kept.settings), etag: null }
    const read = await readFromStore({ access: 'private' })
    shown.set(loadSdk, { at: Date.now(), settings: structuredClone(read.settings) })
    return read
  }

  async function readFromStore(options) {
    const found = await attempt((blob) => blob.get(SETTINGS_PATH, options))
    if (!found || found.statusCode !== 200 || !found.stream) return { settings: emptySettings(), etag: null }
    const etag = found.blob?.etag || null
    const text = await readCapped(found.stream, SETTINGS_MAX_BYTES)
    let parsed = null
    try {
      parsed = text ? JSON.parse(text.toString('utf8')) : null
    } catch {
      parsed = null
    }
    // Too big, not JSON, or JSON the board never writes: an error, so no save is built on it.
    // (Entries inside a good file that the board could not have written are still dropped one by
    // one, by normaliseSettings.)
    if (!plainObject(parsed)) throw new PictureStoreError(502, SETTINGS_DAMAGED)
    return { settings: normaliseSettings(parsed), etag }
  }

  // What is about to be saved, held to what the board can read back. A count is only refused
  // when it grows, so a file that is somehow over one can still be cleared down.
  function refuseIfTooBig(next, current, text) {
    const grew = (key, limit) => Object.keys(next[key]).length > limit &&
      Object.keys(next[key]).length > Object.keys(current[key]).length
    if (grew('names', MAX_NAMED_AGENTS)) throw new PictureStoreError(413, TOO_MANY_NAMES)
    if (grew('pictures', MAX_PICTURES)) throw new PictureStoreError(413, TOO_MANY_PICTURES)
    if (Buffer.byteLength(text, 'utf8') > SETTINGS_MAX_BYTES) throw new PictureStoreError(413, TOO_BIG)
  }

  // `mutate` gets a copy of the current settings and returns the new ones (or changes the copy
  // in place). It is run again on every retry against the latest file, so a change made by
  // someone else in between is built on, never thrown away. Anything `mutate` throws - a daily
  // cap, a refusal - passes straight through and nothing is written. A save waits its turn behind
  // any other this instance is making (takeTurn, above), so `mutate` must not save itself.
  const saveSettings = (mutate) => takeTurn(loadSdk, () => saveNow(mutate))

  async function saveNow(mutate) {
    for (let tries = 1; tries <= SAVE_TRIES; tries += 1) {
      const { settings, etag } = await readSettings({ fresh: true })
      const draft = structuredClone(settings)
      const next = normaliseSettings((await mutate(draft)) ?? draft)
      const text = JSON.stringify(next)
      refuseIfTooBig(next, settings, text)
      // First save creates the file and must not replace one that appeared meanwhile; every save
      // after that replaces it only if it is still the version this one read.
      const guard = etag ? { allowOverwrite: true, ifMatch: etag } : { allowOverwrite: false }
      const blob = await sdk()
      try {
        await blob.put(SETTINGS_PATH, text, {
          access: 'private',
          contentType: 'application/json',
          addRandomSuffix: false,
          cacheControlMaxAge: 60,
          ...guard
        })
        shown.set(loadSdk, { at: Date.now(), settings: structuredClone(next) })
        return next
      } catch (error) {
        const lostRace = etag
          ? typeof blob.BlobPreconditionFailedError === 'function' && error instanceof blob.BlobPreconditionFailedError
          : (await readSettings({ fresh: true })).etag !== null
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
