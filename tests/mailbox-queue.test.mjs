// The Mac mailbox, board side (plan 2026-10-12-mac-mailbox, task C2): reading the switch and its
// settings, signing an order, and keeping the queue the Mac collects from - one private file in the
// picture store, its own turns, read fresh, saved with ifMatch, at most 20 waiting and 8 a day,
// counted inside the file. And the picture store's daily budget, which the orders now share.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mailboxConfig,
  makeOrder,
  queueOrder,
  pendingOrders,
  parseQueue,
  verifyOrder,
  orderLifeSeconds,
  MAILBOX_CONTRACT
} from '../api/_mailbox.js'
import {
  MAILBOX_QUEUE_PATH,
  MAILBOX_ORDERS_PER_DAY,
  ADVANCED_OPS_PER_DAY,
  INDEX_SAVES_PER_DAY,
  dailyCaps,
  meterWritesPerDay,
  pictureStore,
  NOT_CONNECTED
} from '../api/_picture-store.js'
import { fakeBlob } from './helpers/fake-blob.mjs'

// Made-up values, put together at runtime so nothing here looks like a real secret to a scanner.
const SECRET = ['test', 'only', 'mailbox', 'signing', 'value', '0123456789'].join('-')
const KEY = ['test', 'only', 'mailbox', 'poll', 'value', 'abcdefghij'].join('-')
const ENV = {
  FIRE_MODE: 'mailbox',
  MAILBOX_SECRET: SECRET,
  MAILBOX_SECRET_ID: 'k1',
  MAILBOX_KEY: KEY,
  MAILBOX_POLL_SECONDS: '300',
  MAILBOX_RUNNER: 'mac-mini',
  GITHUB_OWNER: 'ExampleOwner',
  GITHUB_REPO: 'example-team',
  BLOB_STORE_ID: 'store_fake'
}
const NOW = new Date('2026-10-12T14:00:00.000Z')
const PAYLOAD = { source: 'agent-cockpit', action: 'task', title: 'Chase the invoice', instruction: 'File one card.' }

function connected(env = ENV) {
  const fake = fakeBlob()
  const store = pictureStore(env, async () => fake.sdk, { pause: async () => {} })
  return { fake, store, config: mailboxConfig(env) }
}
const queueFile = (fake) => JSON.parse(fake.files.get(MAILBOX_QUEUE_PATH).bytes.toString('utf8'))
const checkAs = (config, now = NOW) => ({ keys: { [config.kid]: config.secret }, repo: config.repo, runner: config.runner, now: now.getTime() })

/* ---------- the switch and its settings ---------- */

test('FIRE_MODE unset or cloud is the cloud: nothing about the mailbox is read', () => {
  for (const mode of [undefined, '', 'cloud', ' cloud ']) {
    const config = mailboxConfig({ ...ENV, FIRE_MODE: mode })
    assert.equal(config.mode, 'cloud', String(mode))
    assert.equal(config.ready, false)
    assert.equal(config.secret, undefined, 'the secret was read in cloud mode')
  }
})

test('FIRE_MODE=mailbox with every setting good is ready, with the pace clamped and the defaults filled in', () => {
  const config = mailboxConfig(ENV)
  assert.equal(config.mode, 'mailbox')
  assert.equal(config.ready, true, config.why)
  assert.equal(config.why, null)
  assert.equal(config.secret, SECRET)
  assert.equal(config.kid, 'k1')
  assert.equal(config.key, KEY)
  assert.equal(config.pollSeconds, 300)
  assert.equal(config.runner, 'mac-mini')
  assert.equal(config.repo, 'ExampleOwner/example-team')
  const defaults = mailboxConfig({ ...ENV, MAILBOX_SECRET_ID: undefined, MAILBOX_RUNNER: undefined, MAILBOX_POLL_SECONDS: undefined })
  assert.equal(defaults.kid, 'k1')
  assert.equal(defaults.runner, 'mac-mini')
  assert.equal(defaults.pollSeconds, MAILBOX_CONTRACT.pollSeconds.default)
  for (const [asked, pace] of [['30', 60], ['60', 60], ['599', 599], ['3600', 3600], ['99999', 3600], ['soon', 600], ['-5', 600], ['1.5', 600], [' 120 ', 120]]) {
    assert.equal(mailboxConfig({ ...ENV, MAILBOX_POLL_SECONDS: asked }).pollSeconds, pace, `MAILBOX_POLL_SECONDS=${asked}`)
  }
  // Pasted with a space or a line break around it: trimmed.
  const padded = mailboxConfig({ ...ENV, MAILBOX_SECRET: ` ${SECRET}\n`, MAILBOX_KEY: `${KEY} ` })
  assert.equal(padded.ready, true)
  assert.equal(padded.secret, SECRET)
  assert.equal(padded.key, KEY)
})

test('a mailbox setting that is missing, short, a placeholder or the wrong shape is not configured, said plainly, and never echoed', () => {
  const cases = [
    [{ MAILBOX_SECRET: undefined }, /MAILBOX_SECRET/],
    [{ MAILBOX_SECRET: 'short-secret' }, /MAILBOX_SECRET/],
    [{ MAILBOX_SECRET: 'FILL-ME-IN' }, /MAILBOX_SECRET/],
    [{ MAILBOX_SECRET: 'your-mailbox-secret-goes-here-0123456789' }, /MAILBOX_SECRET/],
    [{ MAILBOX_SECRET: 'two words that are long enough for the length rule' }, /MAILBOX_SECRET/],
    // Long enough, no placeholder word, and two different characters: a filler, not a secret.
    [{ MAILBOX_SECRET: 'ab'.repeat(20) }, /MAILBOX_SECRET/],
    [{ MAILBOX_KEY: undefined }, /MAILBOX_KEY/],
    [{ MAILBOX_KEY: 'short-key' }, /MAILBOX_KEY/],
    [{ MAILBOX_KEY: 'REPLACE-ME-with-the-key-from-the-mac-000' }, /MAILBOX_KEY/],
    [{ MAILBOX_KEY: 'cd'.repeat(20) }, /MAILBOX_KEY/],
    [{ MAILBOX_KEY: SECRET }, /MAILBOX_KEY.*MAILBOX_SECRET|MAILBOX_SECRET.*MAILBOX_KEY/],
    [{ MAILBOX_SECRET_ID: 'K1' }, /MAILBOX_SECRET_ID/],
    [{ MAILBOX_RUNNER: 'Mac Mini' }, /MAILBOX_RUNNER/],
    [{ GITHUB_OWNER: undefined }, /GITHUB_OWNER/],
    [{ BLOB_STORE_ID: undefined }, /picture store/i]
  ]
  for (const [change, why] of cases) {
    const config = mailboxConfig({ ...ENV, ...change })
    assert.equal(config.mode, 'mailbox')
    assert.equal(config.ready, false, JSON.stringify(change))
    assert.match(config.why, why, JSON.stringify(change))
    for (const value of [SECRET, KEY, ...Object.values(change).filter((value) => typeof value === 'string' && value.length > 12)]) {
      assert.ok(!config.why.includes(value), `${JSON.stringify(change)}: a value was echoed`)
    }
  }
  assert.equal(mailboxConfig({ ...ENV, BLOB_STORE_ID: undefined }).why, NOT_CONNECTED)
})

test('a FIRE_MODE that is neither cloud nor mailbox is not configured: never quietly one or the other', () => {
  const config = mailboxConfig({ ...ENV, FIRE_MODE: 'mailbx' })
  assert.equal(config.mode, 'unknown')
  assert.equal(config.ready, false)
  assert.match(config.why, /FIRE_MODE must be cloud or mailbox/)
  assert.ok(!config.why.includes('mailbx'), 'the typed value was echoed')
})

/* ---------- one order, signed ---------- */

test('an order is signed so the Mac\'s checks pass it: a random id, issued now, and alive for the pace\'s life', () => {
  const config = mailboxConfig(ENV)
  const one = makeOrder(PAYLOAD, config, NOW)
  const two = makeOrder(PAYLOAD, config, NOW)
  assert.match(one.id, MAILBOX_CONTRACT.idShape)
  assert.notEqual(one.id, two.id, 'two orders shared an id: it is the nonce')
  const checked = verifyOrder(one.envelope, checkAs(config))
  assert.equal(checked.verdict, 'ok')
  assert.deepEqual(checked.order, {
    v: 1,
    id: one.id,
    repo: 'ExampleOwner/example-team',
    runner: 'mac-mini',
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + orderLifeSeconds(300) * 1000).toISOString(),
    payload: PAYLOAD
  })
  assert.equal(one.expiresAt, checked.order.expiresAt)
  assert.deepEqual(Object.keys(one.envelope), ['kid', 'body', 'sig'])
  assert.equal(one.envelope.kid, 'k1')
  // At the default pace an order lives 32 minutes; at the pace Nuno set, 17.
  assert.equal(orderLifeSeconds(600), 1920)
  assert.equal(orderLifeSeconds(300), 1020)
})

/* ---------- the queue ---------- */

test('an order is one fresh read and one put to the queue\'s own private file, and nothing else in the store', async () => {
  const { fake, store, config } = connected()
  const sent = await queueOrder(store, config, PAYLOAD, NOW)
  assert.match(sent.id, MAILBOX_CONTRACT.idShape)
  assert.equal(MAILBOX_QUEUE_PATH, 'agent-cockpit/mailbox/queue.json')
  assert.equal(fake.calls.put.length, 1)
  assert.equal(fake.calls.get.length, 1)
  assert.equal(fake.calls.get[0].options.useCache, false, 'the queue was read through the cache before a save')
  const [put] = fake.calls.put
  assert.equal(put.pathname, MAILBOX_QUEUE_PATH)
  assert.equal(put.options.access, 'private')
  assert.equal(put.options.allowOverwrite, false)
  const file = queueFile(fake)
  assert.deepEqual(Object.keys(file), ['version', 'day', 'count', 'orders'])
  assert.equal(file.day, '2026-10-12')
  assert.equal(file.count, 1)
  assert.equal(file.orders.length, 1)
  assert.equal(verifyOrder(file.orders[0], checkAs(config)).order.id, sent.id)
  await queueOrder(store, config, PAYLOAD, NOW)
  assert.ok(fake.calls.put[1].options.ifMatch, 'a second order replaced the queue without checking it was the one it read')
  assert.equal(fake.calls.list.length, 0)
  assert.ok(fake.touched().every((path) => path.startsWith('agent-cockpit/')))
})

test('the Mac is shown the good, unexpired orders oldest first, the same envelopes byte for byte, from one fresh read', async () => {
  const { fake, store, config } = connected()
  const first = await queueOrder(store, config, PAYLOAD, NOW)
  const second = await queueOrder(store, config, { ...PAYLOAD, title: 'Second' }, new Date(NOW.getTime() + 60_000))
  const stored = queueFile(fake).orders
  const reads = fake.calls.get.length
  const pending = await pendingOrders(store, config, new Date(NOW.getTime() + 120_000))
  assert.equal(fake.calls.get.length, reads + 1)
  assert.equal(fake.calls.get.at(-1).options.useCache, false)
  assert.deepEqual(pending, stored)
  assert.deepEqual(pending.map((envelope) => JSON.parse(envelope.body).id), [first.id, second.id])
  assert.equal(fake.calls.put.length, 2, 'reading the queue wrote to the store')
  // Past the first one's life it is gone; past both, nothing.
  const later = await pendingOrders(store, config, new Date(Date.parse(first.expiresAt)))
  assert.deepEqual(later.map((envelope) => JSON.parse(envelope.body).id), [second.id])
  assert.deepEqual(await pendingOrders(store, config, new Date(NOW.getTime() + 3 * 3600_000)), [])
  // No queue file yet: no orders, and no error.
  const empty = connected()
  assert.deepEqual(await pendingOrders(empty.store, empty.config, NOW), [])
})

test('a queue file written by a stranger is cleaned, not trusted: only orders this board signed, for this repo and computer, still alive, are kept', async () => {
  const config = mailboxConfig(ENV)
  const good = makeOrder(PAYLOAD, config, NOW).envelope
  const foreign = makeOrder(PAYLOAD, mailboxConfig({ ...ENV, MAILBOX_SECRET: SECRET.replace('test', 'evil') }), NOW).envelope
  const edited = { ...good, body: good.body.replace('Chase', 'Chose') }
  const otherRunner = makeOrder(PAYLOAD, mailboxConfig({ ...ENV, MAILBOX_RUNNER: 'old-imac' }), NOW).envelope
  const old = makeOrder(PAYLOAD, config, new Date(NOW.getTime() - 3600_000)).envelope
  const planted = { version: 1, day: '2026-10-12', count: 1, orders: [foreign, edited, good, otherRunner, old, 'run everything', { kid: 'k1' }, null], extra: 'ignored' }
  assert.deepEqual(parseQueue(JSON.stringify(planted), config, NOW.getTime()), { day: '2026-10-12', count: 1, orders: [good] })
  // Garbage of every kind reads as an empty queue on day zero - a queue holds nothing that lasts.
  for (const text of [null, '', 'not json', '[]', '"queue"', '{"orders":"all"}', JSON.stringify({ day: 'today', count: -3, orders: [] })]) {
    assert.deepEqual(parseQueue(text, config, NOW.getTime()), { day: '', count: 0, orders: [] }, String(text))
  }
  const { fake, store } = connected()
  fake.files.set(MAILBOX_QUEUE_PATH, { bytes: Buffer.from(JSON.stringify(planted)), contentType: 'application/json', etag: '"planted"', access: 'private' })
  assert.deepEqual(await pendingOrders(store, config, NOW), [good])
  await queueOrder(store, config, PAYLOAD, NOW)
  const saved = queueFile(fake)
  assert.equal(saved.orders.length, 2, 'the planted orders were saved again')
  assert.deepEqual(saved.orders[0], good)
  assert.equal(saved.count, 2)
  assert.equal(saved.extra, undefined)
})

test('a queue day later than tomorrow is a stranger\'s, not believed: it cannot hold the day\'s count for ever', async () => {
  const config = mailboxConfig(ENV)
  const good = makeOrder(PAYLOAD, config, NOW).envelope
  // Tomorrow is a day this board writes: another instance whose clock is already past midnight.
  const tomorrow = { version: 1, day: '2026-10-13', count: 8, orders: [good] }
  assert.deepEqual(parseQueue(JSON.stringify(tomorrow), config, NOW.getTime()), { day: '2026-10-13', count: 8, orders: [good] })
  // Further on is not: the day and its count read as no day at all, and the signed orders are kept.
  for (const day of ['2026-10-14', '9999-12-31']) {
    assert.deepEqual(parseQueue(JSON.stringify({ version: 1, day, count: 8, orders: [good] }), config, NOW.getTime()), { day: '', count: 0, orders: [good] }, day)
  }
  const { fake, store } = connected()
  fake.files.set(MAILBOX_QUEUE_PATH, { bytes: Buffer.from(JSON.stringify({ version: 1, day: '9999-12-31', count: 8, orders: [good] })), contentType: 'application/json', etag: '"planted"', access: 'private' })
  const sent = await queueOrder(store, config, PAYLOAD, NOW)
  assert.match(sent.id, MAILBOX_CONTRACT.idShape)
  assert.equal(queueFile(fake).day, '2026-10-12')
  assert.equal(queueFile(fake).count, 1)
  assert.deepEqual(queueFile(fake).orders[0], good)
})

test('the ninth order of a UTC day is refused with a sentence and nothing is saved; the next day starts again', async () => {
  assert.equal(MAILBOX_ORDERS_PER_DAY, 8)
  const { fake, store, config } = connected()
  for (let n = 0; n < 8; n += 1) await queueOrder(store, config, PAYLOAD, new Date(NOW.getTime() + n * 1000))
  const puts = fake.calls.put.length
  await assert.rejects(queueOrder(store, config, PAYLOAD, new Date(NOW.getTime() + 9000)), (error) => {
    assert.equal(error.status, 429)
    assert.match(error.message, /all 8 orders it allows today/)
    assert.match(error.message, /midnight UTC/)
    return true
  })
  assert.equal(fake.calls.put.length, puts, 'a refused order was saved')
  assert.equal(queueFile(fake).count, 8)
  const tomorrow = await queueOrder(store, config, PAYLOAD, new Date('2026-10-13T00:00:05.000Z'))
  assert.match(tomorrow.id, MAILBOX_CONTRACT.idShape)
  assert.equal(queueFile(fake).day, '2026-10-13')
  assert.equal(queueFile(fake).count, 1)
  // A request whose clock still says yesterday is held to the file's count, never handed a fresh one.
  const behind = await queueOrder(store, config, PAYLOAD, new Date('2026-10-12T23:59:59.000Z'))
  assert.match(behind.id, MAILBOX_CONTRACT.idShape)
  assert.equal(queueFile(fake).day, '2026-10-13')
  assert.equal(queueFile(fake).count, 2)
})

test('20 orders waiting is the most: the next is refused, and says to check the Mac', async () => {
  const { fake, store, config } = connected()
  const waiting = Array.from({ length: 20 }, (_, n) => makeOrder(PAYLOAD, config, new Date(NOW.getTime() - n * 1000)).envelope)
  fake.files.set(MAILBOX_QUEUE_PATH, { bytes: Buffer.from(JSON.stringify({ version: 1, day: '2026-10-11', count: 8, orders: waiting })), contentType: 'application/json', etag: '"full"', access: 'private' })
  await assert.rejects(queueOrder(store, config, PAYLOAD, NOW), (error) => {
    assert.equal(error.status, 429)
    assert.match(error.message, /20 orders are already waiting for your Mac/)
    return true
  })
  assert.equal(fake.calls.put.length, 0)
  // More than 20 good orders in the file (only the board can sign one): the newest 20 are kept.
  const many = Array.from({ length: 25 }, (_, n) => makeOrder(PAYLOAD, config, new Date(NOW.getTime() - (25 - n) * 1000)).envelope)
  const kept = parseQueue(JSON.stringify({ version: 1, day: '2026-10-12', count: 0, orders: many }), config, NOW.getTime()).orders
  assert.deepEqual(kept, many.slice(5))
})

test('an order saved at the same moment as another, on another instance, is tried once more against the latest queue', async () => {
  const { fake, store, config } = connected()
  await queueOrder(store, config, PAYLOAD, NOW)
  fake.failNext.put = new fake.sdk.BlobPreconditionFailedError()
  const sent = await queueOrder(store, config, PAYLOAD, NOW)
  assert.equal(queueFile(fake).orders.length, 2)
  assert.equal(JSON.parse(queueFile(fake).orders[1].body).id, sent.id)
  assert.equal(fake.calls.put.length, 3)
})

test('no picture store: the queue says so in the store\'s own sentence', async () => {
  const config = mailboxConfig({ ...ENV, BLOB_STORE_ID: undefined })
  assert.equal(pictureStore({ ...ENV, BLOB_STORE_ID: undefined }), null)
  assert.equal(config.ready, false)
  assert.equal(config.why, NOT_CONNECTED)
})

/* ---------- the budget the orders share ---------- */

test('in mailbox mode the orders take 8 of the 55 writes a day: changes drop from 19 to 15, pictures and the meter keep theirs', () => {
  const mailbox = { FIRE_MODE: 'mailbox' }
  assert.deepEqual(dailyCaps(mailbox), { writes: 15, generated: 10 })
  assert.equal(meterWritesPerDay(mailbox), 5)
  assert.equal(2 * 15 + 10 + INDEX_SAVES_PER_DAY + MAILBOX_ORDERS_PER_DAY + meterWritesPerDay(mailbox), ADVANCED_OPS_PER_DAY)
  // The cloud board is unchanged.
  assert.deepEqual(dailyCaps({}), { writes: 19, generated: 10 })
  assert.deepEqual(dailyCaps({ FIRE_MODE: 'cloud' }), { writes: 19, generated: 10 })
  assert.equal(meterWritesPerDay({}), 5)
  const asked = [undefined, '', 'lots', '0', '1', '10', '15', '19', '22', '23', '26', '50', '99999999']
  for (const writes of asked) {
    for (const generated of asked) {
      const env = { FIRE_MODE: 'mailbox', WRITE_DAILY_CAP: writes, GENERATE_DAILY_CAP: generated }
      const caps = dailyCaps(env)
      const day = 2 * caps.writes + caps.generated + INDEX_SAVES_PER_DAY + MAILBOX_ORDERS_PER_DAY + meterWritesPerDay(env)
      assert.ok(day <= ADVANCED_OPS_PER_DAY, `WRITE_DAILY_CAP=${writes} GENERATE_DAILY_CAP=${generated}: ${day} writes a day in mailbox mode`)
    }
  }
  assert.equal(dailyCaps({ FIRE_MODE: 'mailbox', WRITE_DAILY_CAP: '99' }).writes, 22, 'changes may take at most what the index and the orders leave, halved')
})
