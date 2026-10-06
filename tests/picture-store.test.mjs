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
  dailyCaps,
  ADVANCED_OPS_PER_DAY,
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
  const { settings } = await store.readSettings()
  assert.equal(settings.names.content, 'Penny')
  assert.equal(settings.assistantName, 'Ada')
  // The etag is what a save builds on, so it comes with the fresh read a save makes.
  assert.ok((await store.readSettings({ fresh: true })).etag)
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

test('a settings file that is damaged or too big is an error, never the defaults, and no save replaces it', async () => {
  // From the security review: a file over 64 KB used to read as the defaults, and the next save
  // then wrote those defaults over it - every name, the style and every picture pointer, gone
  // without a word. Now it is a sentence that says what is wrong and what to do, and the file is
  // left exactly as it is for the owner to deal with.
  const damaged = ['{ not json', 'null', '[]', '"a string"', JSON.stringify({ ...emptySettings(), artStyle: 'x'.repeat(64 * 1024) })]
  for (const text of damaged) {
    const { fake, store } = connected()
    await fake.sdk.put(SETTINGS_PATH, text, { access: 'private', allowOverwrite: false })
    const before = fake.files.get(SETTINGS_PATH).bytes
    const puts = fake.calls.put.length
    const label = text.slice(0, 20)
    await assert.rejects(store.readSettings(), (error) => {
      assert.equal(error.status, 502, label)
      assert.match(error.message, /settings/, label)
      assert.match(error.message, /delete/, `${label}: the sentence does not say what to do`)
      return true
    })
    await assert.rejects(store.saveSettings((draft) => { draft.names.content = 'Penny' }), /settings/)
    assert.equal(fake.calls.put.length, puts, `${label}: a save wrote over the file`)
    assert.deepEqual(fake.files.get(SETTINGS_PATH).bytes, before, `${label}: the file changed`)
  }
})

test('a save that would make settings.json too big to read back is refused, and nothing is written', async () => {
  const { fake, store } = connected()
  await store.saveSettings((draft) => { draft.names.content = 'Penny' })
  const puts = fake.calls.put.length
  await assert.rejects(store.saveSettings((draft) => { draft.artStyle = 'x'.repeat(70 * 1024) }), (error) => {
    assert.equal(error.status, 413)
    assert.match(error.message, /too big/)
    return true
  })
  assert.equal(fake.calls.put.length, puts)
  assert.equal((await store.readSettings()).settings.names.content, 'Penny')
})

test('the board keeps names for up to 64 agents, and pictures for those and the two banners', async () => {
  // A cap on entries, not a lookup of the team: a name can only be refused for an agent that is
  // not there by reading the team repo on every rename, which would make renaming fail whenever
  // GitHub does. 64 names and 66 pictures, at their longest, are still under half of 64 KB.
  const { fake, store } = connected()
  const slug = (i) => `${'a'.repeat(96)}${String(i).padStart(4, '0')}`
  await store.saveSettings((draft) => {
    for (let i = 0; i < 64; i += 1) draft.names[slug(i)] = '\u{1F600}'.repeat(20)
    for (let i = 0; i < 64; i += 1) draft.pictures[`agent-${slug(i)}`] = { v: 'abcdefgh1234', type: 'image/jpeg', bytes: 99999, at: '2026-10-06T12:00:00.000Z' }
    draft.pictures.today = { v: 'abcdefgh1234', type: 'image/webp', bytes: 1, at: '' }
    draft.pictures.team = { v: 'abcdefgh1234', type: 'image/webp', bytes: 1, at: '' }
  })
  assert.ok(fake.files.get(SETTINGS_PATH).bytes.length < 32 * 1024, 'the most the board keeps does not fit comfortably')
  await assert.rejects(store.saveSettings((draft) => { draft.names.another = 'One more' }), (error) => {
    assert.equal(error.status, 413)
    assert.match(error.message, /64/)
    return true
  })
  await assert.rejects(store.saveSettings((draft) => { draft.pictures['agent-another'] = { v: 'abcdefgh1234', type: 'image/webp', bytes: 1, at: '' } }), /64/)
  // Renaming an agent that already has a name, and clearing one, are never refused.
  await store.saveSettings((draft) => { draft.names[slug(0)] = 'Penny' })
  await store.saveSettings((draft) => { delete draft.names[slug(1)] })
  assert.equal(Object.keys((await store.readSettings()).settings.names).length, 63)
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

test('only a store that is public is called public, not every error with the word in it', () => {
  // The public-store sentence tells the owner to make a new store, which cannot be undone and is
  // the wrong fix for anything else. It used to fire for any message containing "public". The
  // words the service uses for a public store could not be checked against SDK 2.8.0 (it has no
  // class for it), so the match is the two phrases a public store would be described by, on an
  // error the SDK itself raised.
  const { sdk } = fakeBlob()
  for (const failure of [
    new TypeError('Cannot read properties of undefined (reading \'public\')'),
    new Error('The public key did not match'),
    new Error('This store is public'), // the right words, but not from the SDK
    new sdk.BlobError('Invalid public token'),
    new sdk.BlobError('Failed to fetch blob: 403 Forbidden (public)')
  ]) {
    const { error } = storeFailure(failure, sdk)
    assert.doesNotMatch(error, /create a private one/i, `${failure.message} was taken for a public store`)
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

/* ---------- the month's budget ---------- */

test('however the daily caps are set, a day\'s worst case stays inside the budget', () => {
  // Hobby includes 2,000 advanced operations a month and locks the store for 30 days past them
  // (vercel.com/docs/vercel-blob/usage-and-pricing). A change costs at most two puts and a picture
  // from words one, so 2 x changes + pictures must stay at or under 55 a day: 1,705 in a 31-day
  // month, with the rest kept for retries and the owner browsing the store in Vercel.
  assert.ok(ADVANCED_OPS_PER_DAY * 31 <= 1705, 'the daily budget leaves no margin under 2,000 a month')
  assert.deepEqual(dailyCaps({}), { writes: 20, generated: 10 }, 'the defaults moved')
  const asked = [undefined, '', 'lots', '-1', '0', '1', '2', '10', '20', '25', '27', '28', '50', '55', '56', '1000', '99999999']
  for (const writes of asked) {
    for (const generated of asked) {
      const caps = dailyCaps({ WRITE_DAILY_CAP: writes, GENERATE_DAILY_CAP: generated })
      const label = `WRITE_DAILY_CAP=${writes} GENERATE_DAILY_CAP=${generated}`
      const day = 2 * caps.writes + caps.generated
      assert.ok(day <= ADVANCED_OPS_PER_DAY, `${label} allows ${day} writes a day`)
      if (/^\d+$/.test(writes ?? '')) assert.ok(caps.writes <= Number(writes), `${label} raised the changes past what was asked`)
      if (/^\d+$/.test(generated ?? '')) assert.ok(caps.generated <= Number(generated), `${label} raised the pictures past what was asked`)
    }
  }
  assert.deepEqual(dailyCaps({ WRITE_DAILY_CAP: '7', GENERATE_DAILY_CAP: '3' }), { writes: 7, generated: 3 }, 'a cap inside the budget was changed')
  assert.deepEqual(dailyCaps({ WRITE_DAILY_CAP: '0', GENERATE_DAILY_CAP: '0' }), { writes: 0, generated: 0 }, '0 still switches a kind off')
})
