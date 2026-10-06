// The picture store wrapper: the one file that talks to @vercel/blob.
//
// Every test injects the in-memory fake from helpers/fake-blob.mjs. The real SDK is never loaded
// here - which is also the claim one of these tests makes about a board with no store connected.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  storeConnected,
  pictureStore,
  storeFailure,
  emptySettings,
  SETTINGS_PATH,
  NOT_CONNECTED
} from '../api/_picture-store.js'
import { fakeBlob } from './helpers/fake-blob.mjs'

const STORE = { BLOB_STORE_ID: 'store_fake' }
const V1 = 'abcdefgh1234'
const V2 = 'zyxwvuts9876'
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([26, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(14)])

function connected() {
  const fake = fakeBlob()
  let loads = 0
  const store = pictureStore(STORE, async () => {
    loads += 1
    return fake.sdk
  })
  // The same Blob store as seen from another function instance: its saves do not wait for this
  // one's, so it is how a test makes "someone else saved at the same moment".
  const elsewhere = pictureStore(STORE, async () => fake.sdk)
  return { fake, store, elsewhere, loads: () => loads }
}

/* ---------- connected or not ---------- */

test('a store is connected by either of the variables Vercel sets, and nothing else', () => {
  assert.equal(storeConnected({}), false)
  assert.equal(storeConnected({ BLOB_STORE_ID: '' }), false)
  assert.equal(storeConnected({ VERCEL_OIDC_TOKEN: 'oidc' }), false, 'an OIDC token alone names no store')
  assert.equal(storeConnected({ BLOB_STORE_ID: 'store_x' }), true, 'connecting a store sets BLOB_STORE_ID')
  assert.equal(storeConnected({ BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x' }), true, 'creating one sets the token')
})

test('with no store connected, there is no store and the SDK is never loaded', async () => {
  let loads = 0
  const store = pictureStore({}, async () => {
    loads += 1
    return fakeBlob().sdk
  })
  assert.equal(store, null)
  assert.equal(loads, 0, 'a board without a store must not pay for the SDK on any request')
  assert.match(NOT_CONNECTED, /private/i, 'the not-connected sentence tells the student which kind of store to make')
})

test('with a store, the SDK is loaded on first use and only once', async () => {
  const { store, loads } = connected()
  assert.equal(loads(), 0, 'creating the wrapper loads nothing')
  await store.readSettings()
  await store.readSettings()
  await store.saveSettings((settings) => settings)
  assert.equal(loads(), 1)
})

/* ---------- settings ---------- */

test('an empty store reads as the defaults', async () => {
  const { fake, store } = connected()
  const { settings, etag } = await store.readSettings()
  assert.deepEqual(settings, emptySettings())
  assert.equal(etag, null)
  const [read] = fake.calls.get
  assert.equal(read.pathname, SETTINGS_PATH)
  assert.equal(read.options.access, 'private')
})

test('a read for showing the board may come from the cache; only a save goes to the origin', async () => {
  // From the security review: every read that skips the cache is a cache MISS, one of the 10,000
  // simple operations Hobby includes a month, and GET /api/brand needs no key on an open board.
  // So showing the board reads the cached copy (free), and only the read a save builds on - which
  // must see the latest file, or its ifMatch would fail every time - skips the cache.
  const fake = fakeBlob({ cdn: true })
  const store = pictureStore(STORE, async () => fake.sdk)
  await store.saveSettings((draft) => { draft.names.content = 'Penny' })
  await store.readSettings() // the cache now holds this copy, and keeps it
  await store.saveSettings((draft) => { draft.names.sales = 'Sam' })
  await store.saveSettings((draft) => { draft.names.email = 'Eve' })
  fake.expireCache()
  assert.deepEqual((await store.readSettings()).settings.names, { content: 'Penny', sales: 'Sam', email: 'Eve' },
    'a save built on the cached copy and lost a change')
  const forced = fake.calls.get.filter((read) => read.options.useCache === false).length
  assert.equal(forced, 3, 'one origin read per save, and none for showing the board')
})

test('a saved change is there on the next read', async () => {
  const { store } = connected()
  await store.saveSettings((settings) => {
    settings.names.content = 'Penny'
    settings.assistantName = 'Ada'
    return settings
  })
  const { settings, etag } = await store.readSettings()
  assert.equal(settings.names.content, 'Penny')
  assert.equal(settings.assistantName, 'Ada')
  assert.ok(etag)
})

test('two changes saved at the same moment both survive', async () => {
  // A reads, then - before A writes - B reads, changes and writes. A's write must not land on
  // top of B's: it is refused by ifMatch, A re-reads, and A's change is applied to B's result.
  const { fake, store, elsewhere } = connected()
  await store.saveSettings((settings) => settings) // the file exists, so both writers hit ifMatch
  let interrupted = false
  await store.saveSettings(async (settings) => {
    if (!interrupted) {
      interrupted = true
      await elsewhere.saveSettings((other) => {
        other.names.sales = 'Sam'
        return other
      })
    }
    settings.names.content = 'Penny'
    return settings
  })
  const { settings } = await store.readSettings()
  assert.deepEqual(settings.names, { sales: 'Sam', content: 'Penny' }, 'one of the two changes was lost')
  assert.ok(fake.calls.put.some((call) => call.options.ifMatch), 'an existing settings file is only replaced with ifMatch')
})

test('two first-ever saves at the same moment both survive', async () => {
  // Nothing in the store yet. The first save creates the file with allowOverwrite: false, so a
  // second creator racing it is refused rather than replacing it - and then retries as an update.
  const { store, elsewhere } = connected()
  let interrupted = false
  await store.saveSettings(async (settings) => {
    if (!interrupted) {
      interrupted = true
      await elsewhere.saveSettings((other) => {
        other.artStyle = 'Watercolour animals.'
        return other
      })
    }
    settings.names.content = 'Penny'
    return settings
  })
  const { settings } = await store.readSettings()
  assert.equal(settings.artStyle, 'Watercolour animals.')
  assert.equal(settings.names.content, 'Penny')
})

test('a save that keeps colliding gives up after three tries, with a sentence', async () => {
  const { fake, store, elsewhere } = connected()
  await store.saveSettings((settings) => settings)
  const before = fake.calls.put.length
  let counter = 0
  await assert.rejects(
    store.saveSettings(async (settings) => {
      counter += 1
      await elsewhere.saveSettings((other) => {
        other.names[`agent${counter}`] = 'Other'
        return other
      })
      settings.names.content = 'Penny'
      return settings
    }),
    (error) => {
      assert.equal(error.status, 409)
      assert.match(error.message, /try again/i)
      return true
    }
  )
  const mine = fake.calls.put.slice(before).filter((call, index) => index % 2 === 1)
  assert.equal(mine.length, 3, 'exactly three attempts of its own, not one more')
})

test('saves take turns, but one that hangs holds the others up for ten seconds at most', async (t) => {
  // Saves made together by one function instance wait for each other, so they never spend an
  // advanced operation colliding. A store call can hang for minutes, so the wait is bounded: after
  // ten seconds the next save goes ahead anyway (and ifMatch still keeps both changes safe).
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const fake = fakeBlob()
  let hang = true
  const sdk = { ...fake.sdk, put: (...args) => (hang ? new Promise(() => {}) : fake.sdk.put(...args)) }
  const store = pictureStore(STORE, async () => sdk)
  store.saveSettings((draft) => { draft.names.content = 'Stuck' })
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
  hang = false
  let second = false
  const done = store.saveSettings((draft) => { draft.names.sales = 'Sam' }).then(() => { second = true })
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
  assert.equal(second, false, 'a save did not wait its turn')
  t.mock.timers.tick(10_000)
  for (let i = 0; i < 20 && !second; i += 1) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(second, true, 'a save that hung held the next one up for good')
  await done
  assert.equal(fake.files.has(SETTINGS_PATH), true)
})

test('a refusal thrown by the change itself is passed through untouched, and nothing is written', async () => {
  // brand.js counts the daily cap inside the change; its "you have hit today's limit" must reach
  // the person as it was written, not be dressed up as a store failure.
  const { fake, store } = connected()
  const refusal = Object.assign(new Error('Daily limit reached.'), { status: 429 })
  await assert.rejects(store.saveSettings(() => { throw refusal }), (error) => error === refusal)
  assert.equal(fake.calls.put.length, 0)
})

test('a damaged settings file reads as the defaults, and the next save repairs it', async () => {
  const { fake, store } = connected()
  await fake.sdk.put(SETTINGS_PATH, '{ not json', { access: 'private', allowOverwrite: false })
  const { settings, etag } = await store.readSettings()
  assert.deepEqual(settings, emptySettings())
  assert.ok(etag, 'the etag is kept, so the repair is a conditional overwrite rather than a failed create')
  await store.saveSettings((draft) => {
    draft.names.content = 'Penny'
    return draft
  })
  assert.equal((await store.readSettings()).settings.names.content, 'Penny')
})

test('settings entries that could not have been written by the board are dropped on read', async () => {
  // settings.json is where every picture path comes from. A pointer with a traversal in it, or a
  // name under a key that is not a slug, is ignored - not followed.
  const { fake, store } = connected()
  const planted = {
    version: 1,
    assistantName: 'Ada',
    artStyle: 42,
    names: { content: 'Penny', '../x': 'Evil', sales: { not: 'a string' } },
    pictures: {
      'agent-content': { v: V1, type: 'image/webp', bytes: 100, at: '2026-10-06T10:00:00Z' },
      'agent-sales': { v: '../../etc', type: 'image/webp' },
      today: { v: V2, type: 'image/svg+xml' },
      'team.webp': { v: V2, type: 'image/png' }
    },
    usage: { day: '2026-10-06', writes: 3, generated: 'lots' }
  }
  await fake.sdk.put(SETTINGS_PATH, JSON.stringify(planted), { access: 'private' })
  const { settings } = await store.readSettings()
  assert.equal(settings.assistantName, 'Ada')
  assert.equal(settings.artStyle, '')
  assert.deepEqual(settings.names, { content: 'Penny' })
  assert.deepEqual(Object.keys(settings.pictures), ['agent-content'])
  assert.deepEqual(settings.usage, { day: '2026-10-06', writes: 3, generated: 0 })
})

/* ---------- pictures ---------- */

test('a picture goes in under its own version and comes back byte for byte', async () => {
  const { fake, store } = connected()
  const path = await store.putPicture('agent-content', V1, WEBP, 'image/webp')
  assert.equal(path, `agent-cockpit/art/agent-content/${V1}.webp`)
  const back = await store.getPicture('agent-content', V1, 'image/webp')
  assert.deepEqual(back, WEBP)
  const put = fake.calls.put.find((call) => call.pathname === path)
  assert.equal(put.options.contentType, 'image/webp')
  assert.equal(put.options.allowOverwrite, false, 'a version is written once and never replaced')
  assert.equal(put.options.addRandomSuffix, false, 'the path must be the one settings.json points at')
})

test('a version that already exists is never overwritten', async () => {
  const { store } = connected()
  await store.putPicture('today', V1, WEBP, 'image/webp')
  await assert.rejects(store.putPicture('today', V1, Buffer.from(WEBP).fill(0, 20), 'image/webp'), (error) => {
    assert.equal(typeof error.status, 'number')
    return true
  })
  assert.deepEqual(await store.getPicture('today', V1, 'image/webp'), WEBP)
})

test('a missing picture is null, and dropping one removes it', async () => {
  const { store } = connected()
  assert.equal(await store.getPicture('team', V1, 'image/png'), null)
  await store.putPicture('team', V1, WEBP, 'image/webp')
  await store.dropPicture('team', V1, 'image/webp')
  assert.equal(await store.getPicture('team', V1, 'image/webp'), null)
})

test('a stored picture larger than the board will serve is refused, not streamed', async () => {
  const { fake, store } = connected()
  await fake.sdk.put(`agent-cockpit/art/today/${V1}.webp`, Buffer.alloc(111 * 1024), { access: 'private' })
  await assert.rejects(store.getPicture('today', V1, 'image/webp'), (error) => {
    assert.equal(error.status, 502)
    return true
  })
})

test('a hostile slot, version or type never reaches the SDK', async () => {
  const { fake, store } = connected()
  const attempts = [
    ['agent-../x', V1, 'image/webp'],
    ['today/x', V1, 'image/webp'],
    ['today', '../../settings', 'image/webp'],
    ['today', 'short', 'image/webp'],
    ['today', 'ABCDEFGH1234', 'image/webp'],
    ['today', V1, 'image/svg+xml'],
    ['today', V1, 'text/html']
  ]
  for (const [slot, version, type] of attempts) {
    await assert.rejects(store.putPicture(slot, version, WEBP, type), (error) => error.status === 400)
    await assert.rejects(store.getPicture(slot, version, type), (error) => error.status === 400)
    await assert.rejects(store.dropPicture(slot, version, type), (error) => error.status === 400)
  }
  assert.equal(fake.calls.put.length + fake.calls.get.length + fake.calls.del.length, 0)
})

/* ---------- what the store is asked to do ---------- */

async function everything(store) {
  await store.readSettings()
  await store.saveSettings((settings) => {
    settings.names.content = 'Penny'
    return settings
  })
  await store.saveSettings((settings) => settings)
  await store.putPicture('agent-content', V1, WEBP, 'image/webp')
  await store.putPicture('today', V2, WEBP, 'image/jpeg')
  await store.getPicture('agent-content', V1, 'image/webp')
  await store.dropPicture('agent-content', V1, 'image/webp')
}

test('every path the board touches starts agent-cockpit/', async () => {
  // The store may be shared with something else of the owner's; this board keeps to its folder.
  const { fake, store } = connected()
  await everything(store)
  const touched = fake.touched()
  assert.ok(touched.length >= 7)
  for (const path of touched) assert.ok(path.startsWith('agent-cockpit/'), `${path} is outside agent-cockpit/`)
})

test('every write and read asks for private access', async () => {
  // A public blob has a URL anyone can open. The pictures and names are the owner's, so nothing
  // is ever written or read as public.
  const { fake, store } = connected()
  await everything(store)
  for (const call of [...fake.calls.put, ...fake.calls.get]) {
    assert.equal(call.options.access, 'private', `${call.pathname} was not private`)
  }
})

test('list() is never called', async () => {
  // list is an "advanced operation": 2,000 a month on Hobby, and going over locks the store for
  // 30 days. settings.json is the index, so nothing needs to list.
  const { fake, store } = connected()
  await everything(store)
  assert.equal(fake.calls.list.length, 0)
})

/* ---------- every failure is one plain sentence ---------- */

const ONE_SENTENCE = /^[A-Z][^.!?]*\.$/

test('each store failure becomes one plain sentence, never the SDK\'s own message', async () => {
  const { sdk } = fakeBlob()
  const failures = [
    new sdk.BlobAccessError(),
    new sdk.BlobStoreNotFoundError(),
    new sdk.BlobStoreSuspendedError(),
    new sdk.BlobServiceNotAvailable(),
    new sdk.BlobServiceRateLimited(),
    new sdk.BlobRequestAbortedError(),
    new sdk.BlobFileTooLargeError('the file length cannot be greater than 1'),
    new sdk.BlobUnknownError(),
    new sdk.BlobPreconditionFailedError(),
    new sdk.BlobError('No read-write token found. Either configure the `BLOB_READ_WRITE_TOKEN` environment variable.'),
    new sdk.BlobError('Failed to fetch blob: 500 Internal Server Error'),
    new TypeError('fetch failed'),
    'a thrown string'
  ]
  for (const failure of failures) {
    const { status, error } = storeFailure(failure, sdk)
    assert.ok(status >= 400 && status < 600, `${failure} gave status ${status}`)
    assert.match(error, ONE_SENTENCE, `${failure} gave "${error}"`)
    assert.ok(!/Vercel Blob|vercel\.com\/help|BLOB_READ_WRITE_TOKEN/.test(error), `"${error}" leaks the SDK's wording`)
  }
  assert.equal(storeFailure(new sdk.BlobServiceRateLimited(), sdk).status, 429)
  assert.equal(storeFailure(new sdk.BlobPreconditionFailedError(), sdk).status, 409)
})

test('a public store is named as the problem, with what to do instead', () => {
  // The single most likely setup mistake: Vercel asks Public or Private once, and it cannot be
  // changed afterwards. Whatever words the service uses for it, the student hears this one.
  const { sdk } = fakeBlob()
  for (const failure of [
    new sdk.BlobError('Cannot use private access on a public store'),
    new sdk.BlobError('This store is public; access "private" is not allowed')
  ]) {
    const { error } = storeFailure(failure, sdk)
    assert.match(error, ONE_SENTENCE)
    assert.match(error, /public/i)
    assert.match(error, /create a private one/i)
  }
})

test('a credential inside an SDK error never reaches the sentence', () => {
  const { sdk } = fakeBlob()
  const secret = 'vercel_blob_rw_ThisMustNeverLeaveTheServer'
  const { error } = storeFailure(new sdk.BlobError(`Invalid token ${secret}`), sdk)
  assert.ok(!error.includes(secret))
})

test('a store failure during a real operation arrives as that sentence', async () => {
  const { fake, store } = connected()
  fake.failNext.get = new fake.sdk.BlobStoreSuspendedError()
  await assert.rejects(store.readSettings(), (error) => {
    assert.match(error.message, ONE_SENTENCE)
    assert.match(error.message, /suspended/i)
    assert.ok(!/Vercel Blob/.test(error.message))
    return true
  })
})
