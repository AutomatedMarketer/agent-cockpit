// The picture store on a folder (Student Edition): the same behaviour as the Blob store, and a
// folder that cannot be talked into touching anything outside itself.

import test from 'node:test'
import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  pictureStore,
  storeConnected,
  folderConfigured,
  SETTINGS_MAX_BYTES,
  PICTURE_MAX_BYTES,
  METER_MAX_BYTES,
  MEMORY_INDEX_MAX_BYTES,
  MAILBOX_QUEUE_MAX_BYTES
} from '../api/_picture-store.js'
import { folderSdk, allowedName, insideProfile, FOLDER_CAPS } from '../api/_picture-store-folder.js'
import os from 'node:os'
import { fakeBlob } from './helpers/fake-blob.mjs'

const V1 = 'abcdefgh1234'
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([26, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(14)])

async function scratch() {
  const base = await mkdtemp(path.join(tmpdir(), 'cockpit-folder-'))
  const root = path.join(base, 'pictures')
  const outside = path.join(base, 'outside')
  await mkdir(outside)
  return { base, root, outside, done: () => rm(base, { recursive: true, force: true }) }
}

// A store on a fresh folder, handed in as a loader the way the Blob tests hand in the fake.
async function onFolder() {
  const area = await scratch()
  const sdk = folderSdk(area.root)
  return { ...area, sdk, store: pictureStore({ BLOB_STORE_ID: 'x' }, async () => sdk) }
}

const BACKENDS = {
  blob: async () => {
    const fake = fakeBlob()
    return { store: pictureStore({ BLOB_STORE_ID: 'x' }, async () => fake.sdk), done: async () => {} }
  },
  folder: async () => {
    const area = await onFolder()
    return { store: area.store, done: area.done }
  }
}

/* ---------- the store behaves the same on both ---------- */

for (const [name, make] of Object.entries(BACKENDS)) {
  test(`[${name}] settings: empty at first, saved, read back, and two saves at once both survive`, async () => {
    const { store, done } = await make()
    try {
      assert.equal((await store.readSettings({ fresh: true })).etag, null)
      await Promise.all([
        store.saveSettings((settings) => ((settings.names.content = 'Penny'), settings)),
        store.saveSettings((settings) => ((settings.names.sales = 'Sam'), settings))
      ])
      const { settings, etag } = await store.readSettings({ fresh: true })
      assert.deepEqual(settings.names, { content: 'Penny', sales: 'Sam' })
      assert.ok(etag)
    } finally {
      await done()
    }
  })

  test(`[${name}] a picture comes back byte for byte, is never overwritten, and can be dropped`, async () => {
    const { store, done } = await make()
    try {
      assert.equal(await store.getPicture('team', V1, 'image/png'), null)
      const saved = await store.putPicture('agent-content', V1, WEBP, 'image/webp')
      assert.equal(saved, `agent-cockpit/art/agent-content/${V1}.webp`)
      assert.deepEqual(await store.getPicture('agent-content', V1, 'image/webp'), WEBP)
      await assert.rejects(store.putPicture('agent-content', V1, Buffer.alloc(30), 'image/webp'))
      assert.deepEqual(await store.getPicture('agent-content', V1, 'image/webp'), WEBP)
      await store.dropPicture('agent-content', V1, 'image/webp')
      assert.equal(await store.getPicture('agent-content', V1, 'image/webp'), null)
      await store.dropPicture('agent-content', V1, 'image/webp') // already gone: no error
    } finally {
      await done()
    }
  })

  test(`[${name}] the index, the mailbox queue and the meter are saved and read back, replaced only with the version read`, async () => {
    const { store, done } = await make()
    try {
      assert.deepEqual(await store.readIndex(), { text: null, etag: null })
      await store.saveIndex(() => '{"v":1}')
      const read = await store.readIndex()
      assert.equal(read.text, '{"v":1}')
      await store.saveIndex((stored) => (assert.equal(stored, '{"v":1}'), '{"v":2}'))
      assert.equal((await store.readIndex()).text, '{"v":2}')

      assert.deepEqual(await store.readMailbox(), { text: null, etag: null })
      await store.saveMailbox(() => '{"orders":[]}')
      assert.equal((await store.readMailbox()).text, '{"orders":[]}')

      await store.saveMeter((meter) => meter)
      assert.ok((await store.readMeter({ fresh: true })).etag)
    } finally {
      await done()
    }
  })

  test(`[${name}] a stored picture bigger than the board will serve is refused, not streamed`, async () => {
    const area = name === 'folder' ? await scratch() : null
    try {
      if (name === 'folder') {
        const planted = path.join(area.root, 'agent-cockpit', 'art', 'today')
        await mkdir(planted, { recursive: true })
        await writeFile(path.join(planted, `${V1}.webp`), Buffer.alloc(111 * 1024))
        const store = pictureStore({ BLOB_STORE_ID: 'x' }, async () => folderSdk(area.root))
        await assert.rejects(store.getPicture('today', V1, 'image/webp'), (error) => error.status === 502)
      } else {
        const fake = fakeBlob()
        await fake.sdk.put(`agent-cockpit/art/today/${V1}.webp`, Buffer.alloc(111 * 1024), { access: 'private' })
        const store = pictureStore({ BLOB_STORE_ID: 'x' }, async () => fake.sdk)
        await assert.rejects(store.getPicture('today', V1, 'image/webp'), (error) => error.status === 502)
      }
    } finally {
      await area?.done()
    }
  })
}

/* ---------- switching it on, and leaving the website alone ---------- */

test('the folder is on only when both settings are plain and the folder is an absolute path', () => {
  const absolute = path.resolve('some-folder')
  assert.equal(folderConfigured({ PICTURE_STORE: 'folder', PICTURE_FOLDER: absolute }), true)
  assert.equal(folderConfigured({ PICTURE_FOLDER: absolute }), false, 'a folder alone is not asking for it')
  assert.equal(folderConfigured({ PICTURE_STORE: 'folder' }), false)
  assert.equal(folderConfigured({ PICTURE_STORE: 'FOLDER', PICTURE_FOLDER: absolute }), false)
  assert.equal(folderConfigured({ PICTURE_STORE: 'folder', PICTURE_FOLDER: 'pictures' }), false, 'relative is refused')
  assert.equal(folderConfigured({ PICTURE_STORE: 'folder', PICTURE_FOLDER: '' }), false)
  assert.equal(storeConnected({ PICTURE_STORE: 'folder', PICTURE_FOLDER: absolute }), true)
  // Asked for but unusable still counts as connected, so the person hears about the folder, not about Vercel.
  assert.equal(storeConnected({ PICTURE_STORE: 'folder', PICTURE_FOLDER: 'pictures' }), true)
  assert.equal(storeConnected({ PICTURE_STORE: 'folder' }), true)
})

test('website mode is untouched: without the folder settings, connection and loader are exactly as before', async () => {
  assert.equal(storeConnected({}), false)
  assert.equal(storeConnected({ PICTURE_FOLDER: path.resolve('x') }), false, 'the folder setting alone connects nothing')
  assert.equal(storeConnected({ BLOB_STORE_ID: 'store_x' }), true)
  assert.equal(storeConnected({ BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x' }), true)
  assert.equal(pictureStore({}, async () => assert.fail('no store, no load')), null)
  // A Blob board that happens to have a stray PICTURE_FOLDER still uses Blob.
  const fake = fakeBlob()
  let loads = 0
  const store = pictureStore({ BLOB_STORE_ID: 'x', PICTURE_FOLDER: path.resolve('stray') }, async () => {
    loads += 1
    return fake.sdk
  })
  await store.saveSettings((settings) => ((settings.assistantName = 'Ada'), settings))
  assert.equal(loads, 1)
  assert.ok(fake.files.has('agent-cockpit/settings.json'))
})

test('with PICTURE_STORE=folder the default loader keeps files in that folder and never needs the Blob SDK', async () => {
  const area = await scratch()
  try {
    const env = { PICTURE_STORE: 'folder', PICTURE_FOLDER: area.root }
    const store = pictureStore(env)
    await store.saveSettings((settings) => ((settings.assistantName = 'Ada'), settings))
    const onDisk = JSON.parse(await readFile(path.join(area.root, 'agent-cockpit', 'settings.json'), 'utf8'))
    assert.equal(onDisk.assistantName, 'Ada')
    // A second call (a second request) is the same store: it sees the first one's save.
    const again = pictureStore(env)
    assert.equal((await again.readSettings({ fresh: true })).settings.assistantName, 'Ada')
    await again.saveSettings((settings) => ((settings.names.sales = 'Sam'), settings))
    assert.equal((await store.readSettings({ fresh: true })).settings.names.sales, 'Sam')
  } finally {
    await area.done()
  }
})

test('when a folder and a Blob store are both named, the folder wins, and a test loader still wins over both', async () => {
  const area = await scratch()
  try {
    const store = pictureStore({ PICTURE_STORE: 'folder', PICTURE_FOLDER: area.root, BLOB_STORE_ID: 'x' })
    await store.saveSettings((settings) => settings)
    assert.ok((await stat(path.join(area.root, 'agent-cockpit', 'settings.json'))).isFile())
    const fake = fakeBlob()
    const injected = pictureStore({ PICTURE_STORE: 'folder', PICTURE_FOLDER: area.root }, async () => fake.sdk)
    await injected.saveSettings((settings) => ((settings.assistantName = 'Z'), settings))
    assert.ok(fake.files.has('agent-cockpit/settings.json'))
  } finally {
    await area.done()
  }
})

test('the folder holds exactly the caps the Blob store holds', () => {
  assert.equal(FOLDER_CAPS.settings, SETTINGS_MAX_BYTES)
  assert.equal(FOLDER_CAPS.picture, PICTURE_MAX_BYTES)
  assert.equal(FOLDER_CAPS.meter, METER_MAX_BYTES)
  assert.equal(FOLDER_CAPS.index, MEMORY_INDEX_MAX_BYTES)
  assert.equal(FOLDER_CAPS.queue, MAILBOX_QUEUE_MAX_BYTES)
})

/* ---------- who can open the folder, plain wording, big files ---------- */

test('on Windows the folder must be inside the user\'s own profile; elsewhere file modes do that job', () => {
  const home = 'C:\\Users\\Nuno'
  assert.equal(insideProfile('C:\\Users\\Nuno\\AppData\\Local\\Agent Board', home, 'win32'), true)
  assert.equal(insideProfile('c:\\users\\nuno\\appdata\\x', home, 'win32'), true, 'case does not matter')
  for (const outside of ['C:\\Users\\Nuno', 'C:\\Users\\Nuno\\..\\Other\\x', 'C:\\Users\\NunoElse\\x', 'C:\\ProgramData\\x', 'D:\\dev\\pictures', 'C:\\']) {
    assert.equal(insideProfile(outside, home, 'win32'), false, outside)
  }
  assert.equal(insideProfile('/var/pictures', '/home/x', 'linux'), true)
  assert.equal(insideProfile('/var/pictures', '/Users/x', 'darwin'), true)
})

test('on this computer a folder outside the profile is refused with a sentence, and nothing is made there', { skip: process.platform !== 'win32' }, async () => {
  const outside = path.join(path.parse(os.homedir()).root, `cockpit-outside-${process.pid}`)
  const store = pictureStore({ PICTURE_STORE: 'folder', PICTURE_FOLDER: outside })
  for (const work of [() => store.readSettings({ fresh: true }), () => store.saveSettings((settings) => settings), () => store.putPicture('today', V1, WEBP, 'image/webp')]) {
    await assert.rejects(work(), (error) => {
      assert.match(error.message, /inside your own user folder/)
      assert.doesNotMatch(error.message, /Vercel|Storage/)
      return true
    })
  }
  await assert.rejects(stat(outside), { code: 'ENOENT' }, 'the folder was made outside the profile')
})

test('a folder inside the profile that is a link out of it is refused too, and nothing is written outside', { skip: process.platform !== 'win32' }, async () => {
  const area = await scratch()
  const target = path.join(path.parse(os.homedir()).root, `cockpit-link-target-${process.pid}`)
  try {
    await mkdir(target)
    await symlink(target, area.root, 'junction')
    const store = pictureStore({ PICTURE_STORE: 'folder', PICTURE_FOLDER: area.root })
    await assert.rejects(store.saveSettings((settings) => settings), (error) => /inside your own user folder/.test(error.message))
    assert.deepEqual(await readdir(target), [], 'something was written through the link')
  } finally {
    await rm(target, { recursive: true, force: true })
    await area.done()
  }
})

test('a folder setting that cannot be used is a plain sentence about the folder, never about Vercel', async () => {
  for (const env of [{ PICTURE_STORE: 'folder' }, { PICTURE_STORE: 'folder', PICTURE_FOLDER: 'relative/path' }, { PICTURE_STORE: 'folder', PICTURE_FOLDER: '' }]) {
    const store = pictureStore(env)
    assert.ok(store, 'asked for, so there is a store to tell the person')
    await assert.rejects(store.readSettings({ fresh: true }), (error) => {
      assert.equal(error.status, 503)
      assert.match(error.message, /PICTURE_FOLDER/)
      assert.doesNotMatch(error.message, /Vercel|Storage|redeploy/i)
      return true
    })
  }
})

test('every other failure on a folder is one local sentence, and a clash is still a clash', async () => {
  const area = await scratch()
  try {
    const sdk = folderSdk(area.root)
    const store = pictureStore({ BLOB_STORE_ID: 'x' }, async () => sdk)
    // A disk problem: the settings file's place is taken by a folder, so reading it fails.
    await mkdir(path.join(area.root, 'agent-cockpit', 'settings.json'), { recursive: true })
    await assert.rejects(store.readSettings({ fresh: true }), (error) => {
      assert.equal(error.status, 502)
      assert.match(error.message, /picture folder on this computer/)
      assert.doesNotMatch(error.message, /Vercel|Storage|token|redeploy/i)
      assert.ok(!error.message.includes(area.base))
      return true
    })
  } finally {
    await area.done()
  }
})

test('replacing a file bigger than its cap is decided without reading it', async () => {
  const area = await scratch()
  try {
    const sdk = folderSdk(area.root)
    await mkdir(path.join(area.root, 'agent-cockpit'), { recursive: true })
    await writeFile(path.join(area.root, 'agent-cockpit', 'settings.json'), Buffer.alloc(SETTINGS_MAX_BYTES + 10, 0x20))
    const seen = await sdk.get('agent-cockpit/settings.json')
    assert.match(seen.blob.etag, /^"big-/)
    const options = { contentType: 'application/json', allowOverwrite: true }
    await assert.rejects(sdk.put('agent-cockpit/settings.json', '{}', { ...options, ifMatch: '"sha256-nope"' }), sdk.BlobPreconditionFailedError)
    // The stand-in etag is what an ifMatch compares, so a save built on the read goes through.
    await sdk.put('agent-cockpit/settings.json', '{}', { ...options, ifMatch: seen.blob.etag })
    assert.equal(await readFile(path.join(area.root, 'agent-cockpit', 'settings.json'), 'utf8'), '{}')
  } finally {
    await area.done()
  }
})

/* ---------- names: only the board's own six shapes ---------- */

test('only the board\'s own file names are allowed', () => {
  for (const good of [
    'agent-cockpit/settings.json',
    'agent-cockpit/voice-meter.json',
    'agent-cockpit/memory-index.json',
    'agent-cockpit/mailbox/queue.json',
    'agent-cockpit/art/today/abcdefgh1234.webp',
    'agent-cockpit/art/agent-content/abcdefgh1234.png',
    'agent-cockpit/art/agent-content/abcdefgh1234.jpeg'
  ]) assert.ok(allowedName(good), good)
  for (const bad of [
    '', 'settings.json', '/agent-cockpit/settings.json', 'agent-cockpit/../settings.json', '../agent-cockpit/settings.json',
    'agent-cockpit/art/today/../../../x.webp', 'agent-cockpit/art/../settings.json',
    'agent-cockpit\\settings.json', 'agent-cockpit/art\\today/abcdefgh1234.webp',
    'C:/agent-cockpit/settings.json', 'C:\\x', '\\\\server\\share\\x.webp',
    'agent-cockpit/settings.json\0.png', 'agent-cockpit/settings.json ', 'agent-cockpit/Settings.json',
    'agent-cockpit/art/today/abcdefgh1234.gif', 'agent-cockpit/art/today/abcdefgh1234.webp.exe',
    'agent-cockpit/art/today/abc.webp', 'agent-cockpit/art/today/ABCDEFGH1234.webp',
    'agent-cockpit/art/not-a-slot/abcdefgh1234.webp', 'agent-cockpit/art/agent-/abcdefgh1234.webp',
    'agent-cockpit/art/agent-../abcdefgh1234.webp', 'agent-cockpit/art/today/sub/abcdefgh1234.webp',
    'agent-cockpit/mailbox/other.json', 'agent-cockpit/mailbox/queue.json/x', 'agent-cockpit/', 'agent-cockpit',
    `agent-cockpit/art/${'a'.repeat(300)}/abcdefgh1234.webp`, 'agent-cockpit/art/CON/abcdefgh1234.webp',
    42, null, undefined, {}, ['agent-cockpit/settings.json']
  ]) assert.equal(allowedName(bad), null, JSON.stringify(bad))
})

test('a refused name is refused before anything is made on disk, by every call', async () => {
  const area = await scratch()
  try {
    const sdk = folderSdk(area.root)
    const evil = ['../outside/x.json', 'agent-cockpit/art/today/../../../outside/abcdefgh1234.webp', 'C:/x.json', '/etc/x']
    for (const name of evil) {
      await assert.rejects(sdk.get(name))
      await assert.rejects(sdk.put(name, 'x', { contentType: 'application/json', allowOverwrite: true }))
      await assert.rejects(sdk.del(name))
    }
    assert.deepEqual(await readdir(area.outside), [], 'nothing was written outside')
    await assert.rejects(stat(area.root), { code: 'ENOENT' }, 'the folder itself was not even made for a refused name')
  } finally {
    await area.done()
  }
})

test('the folder must be an absolute path', () => {
  assert.throws(() => folderSdk('pictures'))
  assert.throws(() => folderSdk(''))
  assert.throws(() => folderSdk(undefined))
})

/* ---------- caps and types ---------- */

test('a file over its cap, or with the wrong content type, is refused and nothing is written', async () => {
  const area = await scratch()
  try {
    const sdk = folderSdk(area.root)
    const picture = `agent-cockpit/art/today/${V1}.webp`
    await assert.rejects(sdk.put(picture, Buffer.alloc(PICTURE_MAX_BYTES + 1), { contentType: 'image/webp' }))
    await assert.rejects(sdk.put(picture, WEBP, { contentType: 'image/png' }), /content type/)
    await assert.rejects(sdk.put(picture, WEBP, { contentType: 'text/html' }))
    await assert.rejects(sdk.put(picture, WEBP, {}))
    const nothingWritten = async () => (await readdir(area.root).catch(() => [])).length === 0
    await assert.rejects(sdk.put('agent-cockpit/settings.json', 'x'.repeat(SETTINGS_MAX_BYTES + 1), { contentType: 'application/json' }))
    await assert.rejects(sdk.put('agent-cockpit/settings.json', '{}', { contentType: 'image/png' }))
    await assert.rejects(sdk.put('agent-cockpit/memory-index.json', Buffer.alloc(MEMORY_INDEX_MAX_BYTES + 1), { contentType: 'application/json' }))
    await assert.rejects(sdk.put('agent-cockpit/mailbox/queue.json', Buffer.alloc(MAILBOX_QUEUE_MAX_BYTES + 1), { contentType: 'application/json' }))
    await assert.rejects(sdk.put('agent-cockpit/voice-meter.json', Buffer.alloc(METER_MAX_BYTES + 1), { contentType: 'application/json' }))
    assert.ok(await nothingWritten(), 'a refused file left something on disk')
    // Exactly at the cap is fine.
    await sdk.put(picture, Buffer.alloc(PICTURE_MAX_BYTES), { contentType: 'image/webp' })
  } finally {
    await area.done()
  }
})

test('a file bigger than its cap that was planted on disk is never hashed or served whole: the reader\'s cap refuses it', async () => {
  const area = await scratch()
  try {
    const sdk = folderSdk(area.root)
    await mkdir(path.join(area.root, 'agent-cockpit'), { recursive: true })
    await writeFile(path.join(area.root, 'agent-cockpit', 'settings.json'), Buffer.alloc(SETTINGS_MAX_BYTES + 5, 0x20))
    const found = await sdk.get('agent-cockpit/settings.json')
    assert.match(found.blob.etag, /^"big-/)
    const store = pictureStore({ BLOB_STORE_ID: 'x' }, async () => sdk)
    await assert.rejects(store.readSettings({ fresh: true }), (error) => error.status === 409 || error.status === 502 || error.status === 413 || /damaged/.test(error.message))
  } finally {
    await area.done()
  }
})

/* ---------- links ---------- */

async function tryLink(make) {
  try {
    await make()
    return true
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) return false
    throw error
  }
}

test('a folder that is really a link to somewhere else is never followed - not to read, write or delete', async () => {
  const area = await scratch()
  try {
    const sdk = folderSdk(area.root)
    await sdk.put('agent-cockpit/settings.json', '{}', { contentType: 'application/json', allowOverwrite: true })
    await writeFile(path.join(area.outside, `${V1}.webp`), WEBP)
    // agent-cockpit/art -> the outside folder (a junction on Windows, a symlink elsewhere)
    await mkdir(path.join(area.root, 'agent-cockpit', 'art', 'today'), { recursive: true }).then(() => rm(path.join(area.root, 'agent-cockpit', 'art'), { recursive: true }))
    const made = await tryLink(() => symlink(area.outside, path.join(area.root, 'agent-cockpit', 'art'), 'junction'))
    if (!made) return
    const name = `agent-cockpit/art/today/${V1}.webp`
    await assert.rejects(sdk.get(name), /link/)
    await mkdir(path.join(area.outside, 'today'))
    await assert.rejects(sdk.get(name), /link/)
    await assert.rejects(sdk.put(name, WEBP, { contentType: 'image/webp' }), /link/)
    await assert.rejects(sdk.del(name), /link/)
    assert.deepEqual(await readdir(path.join(area.outside, 'today')), [], 'nothing written through the link')
    assert.equal((await readFile(path.join(area.outside, `${V1}.webp`))).length, WEBP.length)
  } finally {
    await area.done()
  }
})

test('the root folder itself may be a link the owner chose; links below it are what is refused', async () => {
  const area = await scratch()
  try {
    const real = path.join(area.base, 'real-root')
    await mkdir(real)
    const linkRoot = path.join(area.base, 'link-root')
    const made = await tryLink(() => symlink(real, linkRoot, 'junction'))
    if (!made) return
    const sdk = folderSdk(linkRoot)
    await sdk.put('agent-cockpit/settings.json', '{}', { contentType: 'application/json', allowOverwrite: true })
    assert.ok((await stat(path.join(real, 'agent-cockpit', 'settings.json'))).isFile())
  } finally {
    await area.done()
  }
})

test('a file that is a link to a file outside is refused, read or replaced', async () => {
  const area = await scratch()
  try {
    const sdk = folderSdk(area.root)
    const secret = path.join(area.outside, 'secret.json')
    await writeFile(secret, '{"secret":true}')
    await mkdir(path.join(area.root, 'agent-cockpit'), { recursive: true })
    const made = await tryLink(() => symlink(secret, path.join(area.root, 'agent-cockpit', 'settings.json'), 'file'))
    if (!made) return
    await assert.rejects(sdk.get('agent-cockpit/settings.json'), /link/)
    await assert.rejects(sdk.put('agent-cockpit/settings.json', '{}', { contentType: 'application/json', allowOverwrite: true }), /link/)
    await assert.rejects(sdk.del('agent-cockpit/settings.json'), /link/)
    assert.equal(await readFile(secret, 'utf8'), '{"secret":true}')
  } finally {
    await area.done()
  }
})

test('a file with a second name (a hard link to something outside) is refused', async () => {
  const area = await scratch()
  try {
    const sdk = folderSdk(area.root)
    const secret = path.join(area.outside, 'secret.json')
    await writeFile(secret, '{"secret":true}')
    await mkdir(path.join(area.root, 'agent-cockpit'), { recursive: true })
    const made = await tryLink(() => link(secret, path.join(area.root, 'agent-cockpit', 'settings.json')))
    if (!made) return
    await assert.rejects(sdk.get('agent-cockpit/settings.json'), /second name/)
  } finally {
    await area.done()
  }
})

test('through the store, a refusal is one plain sentence that names no folder', async () => {
  const area = await scratch()
  try {
    const sdk = folderSdk(area.root)
    await mkdir(path.join(area.root, 'agent-cockpit'), { recursive: true })
    const made = await tryLink(() => symlink(area.outside, path.join(area.root, 'agent-cockpit', 'art'), 'junction'))
    if (!made) return
    const store = pictureStore({ BLOB_STORE_ID: 'x' }, async () => sdk)
    await assert.rejects(store.getPicture('today', V1, 'image/webp'), (error) => {
      assert.equal(typeof error.status, 'number')
      assert.ok(!error.message.includes(area.base), 'the folder path leaked into the sentence')
      assert.ok(!/a link inside|Picture folder:/i.test(error.message), 'the internal reason leaked into the sentence')
      return true
    })
  } finally {
    await area.done()
  }
})

test('a folder where a file should be, or a file where a folder should be, is refused with no changes', async () => {
  const area = await scratch()
  try {
    const sdk = folderSdk(area.root)
    await mkdir(path.join(area.root, 'agent-cockpit', 'settings.json'), { recursive: true })
    await assert.rejects(sdk.get('agent-cockpit/settings.json'), /not a plain file/)
    await assert.rejects(sdk.put('agent-cockpit/settings.json', '{}', { contentType: 'application/json', allowOverwrite: true }), /not a plain file/)
    await assert.rejects(sdk.del('agent-cockpit/settings.json'), /not a plain file/)
    await rm(path.join(area.root, 'agent-cockpit'), { recursive: true })
    await writeFile(path.join(area.root, 'agent-cockpit'), 'i am a file')
    await assert.rejects(sdk.get('agent-cockpit/voice-meter.json'), /not a plain folder/)
    await assert.rejects(sdk.put('agent-cockpit/voice-meter.json', '{}', { contentType: 'application/json', allowOverwrite: true }), /not a plain folder/)
    assert.equal(await readFile(path.join(area.root, 'agent-cockpit'), 'utf8'), 'i am a file')
  } finally {
    await area.done()
  }
})

/* ---------- ifMatch, overwrite, tidiness ---------- */

test('put follows Blob\'s rules: no overwrite without allowOverwrite, ifMatch must match the file read', async () => {
  const area = await scratch()
  try {
    const sdk = folderSdk(area.root)
    const name = 'agent-cockpit/settings.json'
    const options = { contentType: 'application/json' }
    const first = await sdk.put(name, '{"a":1}', { ...options, allowOverwrite: false })
    await assert.rejects(sdk.put(name, '{"a":2}', { ...options, allowOverwrite: false }), /already exists/)
    await assert.rejects(sdk.put(name, '{"a":2}', options), /already exists/)
    await assert.rejects(sdk.put(name, '{"a":2}', { ...options, ifMatch: '"nope"' }), sdk.BlobPreconditionFailedError)
    await assert.rejects(sdk.put('agent-cockpit/voice-meter.json', '{}', { ...options, ifMatch: first.etag }), sdk.BlobPreconditionFailedError, 'ifMatch on a missing file fails')
    const read = await sdk.get(name)
    assert.equal(read.blob.etag, first.etag)
    const second = await sdk.put(name, '{"a":2}', { ...options, allowOverwrite: true, ifMatch: read.blob.etag })
    assert.notEqual(second.etag, first.etag)
    assert.equal(await readFile(path.join(area.root, name), 'utf8'), '{"a":2}')
  } finally {
    await area.done()
  }
})

test('saves leave no temporary files, and a leftover temporary file is never served as a file', async () => {
  const area = await scratch()
  try {
    const sdk = folderSdk(area.root)
    for (let n = 0; n < 5; n += 1) {
      await sdk.put('agent-cockpit/settings.json', `{"n":${n}}`, { contentType: 'application/json', allowOverwrite: true })
    }
    assert.deepEqual(await readdir(path.join(area.root, 'agent-cockpit')), ['settings.json'])
    await writeFile(path.join(area.root, 'agent-cockpit', '.settings.json.deadbeef.tmp'), 'half')
    assert.equal(allowedName('agent-cockpit/.settings.json.deadbeef.tmp'), null)
    assert.equal(await readFile(path.join(area.root, 'agent-cockpit', 'settings.json'), 'utf8'), '{"n":4}')
  } finally {
    await area.done()
  }
})

test('files are private to the user on systems that have file modes', { skip: process.platform === 'win32' }, async () => {
  const area = await scratch()
  try {
    const sdk = folderSdk(area.root)
    await sdk.put('agent-cockpit/mailbox/queue.json', '{}', { contentType: 'application/json', allowOverwrite: true })
    assert.equal((await stat(path.join(area.root, 'agent-cockpit', 'mailbox', 'queue.json'))).mode & 0o777, 0o600)
    assert.equal((await stat(path.join(area.root, 'agent-cockpit', 'mailbox'))).mode & 0o777, 0o700)
  } finally {
    await area.done()
  }
})

test('the list call does not exist: the folder, like Blob, is only ever asked for a name it was given', () => {
  const sdk = folderSdk(path.resolve('anywhere'))
  assert.equal(sdk.list, undefined)
  assert.equal(sdk.head, undefined)
})
