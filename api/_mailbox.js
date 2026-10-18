// The Mac mailbox (plan 2026-10-12-mac-mailbox): in FIRE_MODE=mailbox the board does not fire a cloud
// routine. It signs the order, keeps it in its private picture store, and the owner's own computer
// collects it through GET /api/mailbox, does it, and pushes the result to the team repo.
//
// Starts with "_" so Vercel does not turn it into an endpoint.
//
// THE CONTRACT. tests/fixtures/mailbox-parity.json is the shared contract, the same bytes in
// agent-team-template, whose runner checks every order by it. KEEP IN SYNC: every number, shape and
// list below is the fixture's, and tests/mailbox.test.mjs holds this file to it.
//
// Why a signature at all, when only the board writes the queue: anyone who can write the store
// (a leaked store key, someone browsing it in Vercel, a bug in another endpoint) could otherwise
// put an order there. The signature is made with a secret only Vercel and the Mac hold, over the
// exact text of the order, so an order nobody signed, an edited one and a replayed one are all
// refused on the Mac. It does not stop a fully taken-over board, which holds the secret too: the
// Mac's own allowlist, daily caps and changed-file check bound that.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  storeConnected,
  NOT_CONNECTED,
  PictureStoreError,
  MAILBOX_ORDERS_PER_DAY,
  usageDay
} from './_picture-store.js'

const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export const MAILBOX_CONTRACT = Object.freeze({
  version: 1,
  // The secret is used as its own UTF-8 bytes: never decoded from base64 or hex, so both sides read
  // one thing the same way however the owner made it.
  secretShape: /^[\x21-\x7e]{32,256}$/,
  sigShape: /^[A-Za-z0-9_-]{43}$/,
  kidShape: /^[a-z0-9-]{1,16}$/,
  envelopeKeys: ['kid', 'body', 'sig'],
  maxBodyBytes: 16384,
  bodyKeys: ['v', 'id', 'repo', 'runner', 'issuedAt', 'expiresAt', 'payload'],
  idShape: /^[0-9a-f]{32}$/,
  repoShape: /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/,
  runnerShape: /^[a-z0-9-]{1,32}$/,
  timeShape: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  life: Object.freeze({ minSeconds: 900, pollsCovered: 3, plusSeconds: 120, maxSeconds: 3600, futureSkewSeconds: 120 }),
  // The runner keeps each claim at least this long after its order was issued (life.maxSeconds +
  // life.futureSkewSeconds): until then the same signed order can still pass every other check.
  claims: Object.freeze({ keepSeconds: 3720 }),
  keyShape: /^[\x21-\x7e]{32,256}$/,
  pollSeconds: Object.freeze({ min: 60, max: 3600, default: 600 }),
  maxOrders: 20,
  actions: ['run', 'pause', 'task', 'arm', 'approve', 'move', 'skill', 'agent'],
  // Which worker does a run (T14, Codex as a second worker): the order's optional `worker` field. Only `run` has it;
  // left out, it means claude. The board writes it only for "codex", so an order for Claude is the bytes it always was.
  workers: Object.freeze({ values: Object.freeze(['claude', 'codex']), default: 'claude', actions: Object.freeze(['run']) }),
  source: 'agent-cockpit',
  status: Object.freeze({
    schema: 'agent-mailbox/v1',
    folder: '.agent-team/status/mailbox',
    maxFileBytes: 65536,
    maxFilesRead: 5,
    maxComputersShown: 3,
    maxOrders: 20,
    maxJobs: 40,
    commitShape: /^[0-9a-f]{12}$/,
    states: ['claimed', 'running', 'ok', 'refused', 'failed', 'unknown'],
    reasons: {
      refused: {
        expired: 'it expired before your Mac picked it up',
        'wrong-repo': 'it was meant for another team repo',
        'wrong-runner': 'it was meant for another computer',
        'not-allowed': 'that kind of order is not on its list',
        'job-not-allowed': 'that job is not on its list',
        'daily-limit': 'it has done all the orders it allows today',
        'not-valid': 'the order did not pass its checks',
        'card-not-found': 'that card is not in the team repo',
        'no-such-row': 'no row in proposals.yml matches it',
        'several-rows': 'more than one row in proposals.yml matches it',
        'no-workflow': 'that job has no workflow file',
        'not-ready': 'its daily check found a problem with its login or settings'
      },
      failed: {
        'change-refused': 'the change touched files it may not touch',
        'tool-refused': 'Claude tried a tool it may not use',
        'claude-failed': 'Claude stopped with an error',
        'timed-out': 'it ran past its time limit',
        'run-log-refused': 'its run log did not pass the check',
        'push-failed': 'the change could not be pushed'
      }
    },
    allowedKeys: {
      file: ['schema', 'takenAt', 'computer', 'runner', 'allows', 'orders'],
      allows: ['actions', 'jobs'],
      order: ['id', 'action', 'state', 'at', 'startedAt', 'finishedAt', 'commit', 'why', 'landed']
    },
    requiredKeys: {
      file: ['schema', 'takenAt', 'computer', 'runner', 'allows', 'orders'],
      allows: ['actions', 'jobs'],
      order: ['id', 'action', 'state', 'at', 'startedAt', 'finishedAt', 'commit', 'why', 'landed']
    },
    // Keys an order may have and need not: a status file from before them is as valid as ever.
    optionalKeys: {
      order: ['steps']
    },
    maxSteps: 100000,
    // The Codex worker's keys and words, kept apart from the older lists above (which stay the contract's word for
    // word): allows may also have `workers` (ready now) and `codexJobs`, both or neither.
    workers: Object.freeze({
      values: Object.freeze(['claude', 'codex']),
      allowsOptional: Object.freeze(['workers', 'codexJobs']),
      reasons: Object.freeze({
        refused: Object.freeze({ 'worker-not-allowed': 'that job is set to another worker on that computer',
          'codex-repo-refused': 'the team repo holds something Codex would read or follow (a .codex or .agents folder at its top, or a link)'
        }),
        failed: Object.freeze({ 'codex-failed': 'Codex stopped with an error' })
      })
    })
  })
})

const C = MAILBOX_CONTRACT

// How long an order waits for the Mac: long enough for three of its polls and two minutes more, at
// least fifteen minutes, never more than an hour.
export function orderLifeSeconds(pollSeconds) {
  const { minSeconds, pollsCovered, plusSeconds, maxSeconds } = C.life
  return Math.min(maxSeconds, Math.max(minSeconds, pollsCovered * pollSeconds + plusSeconds))
}

// base64url, no padding: 43 characters.
export function signBody(secret, body) {
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(Buffer.from(body, 'utf8')).digest('base64url')
}

// One of the contract's times, and only written the one way Date.prototype.toISOString writes it:
// 2026-02-30 is not a day, and a time written another way is not one the board wrote.
function contractTime(value) {
  if (typeof value !== 'string' || !C.timeShape.test(value)) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null
}

const sameKeys = (object, keys) => {
  const own = Object.keys(object)
  return own.length === keys.length && keys.every((key) => Object.hasOwn(object, key))
}

// The checks, in the contract's order. Any failure is a verdict and nothing else: the order is
// given back only when every check passed. `keys` is { kid: secret }. The body is parsed only after
// its signature matches, so nothing anybody wrote into the store is read before it is proven ours.
// `claimsSince` is for a side that keeps claims (the runner): the moment its claim store was made, so
// an order issued before it - one a wiped or new claim folder has no claim for - is refused. The
// board keeps none and leaves it out.
export function verifyOrder(envelope, { keys, repo, runner, now, claimsSince = null }) {
  const refuse = (verdict) => ({ verdict })
  if (!plainObject(envelope) || !sameKeys(envelope, C.envelopeKeys)) return refuse('malformed')
  const { kid, body, sig } = envelope
  if (typeof kid !== 'string' || typeof body !== 'string' || typeof sig !== 'string') return refuse('malformed')
  if (Buffer.byteLength(body, 'utf8') > C.maxBodyBytes) return refuse('malformed')
  if (!C.kidShape.test(kid) || !plainObject(keys) || !Object.hasOwn(keys, kid) || typeof keys[kid] !== 'string') return refuse('unknown-key')
  if (!C.sigShape.test(sig)) return refuse('bad-signature')
  // Both are 43 ASCII characters by now, so the lengths match and the compare takes the same time
  // whatever the signature says.
  if (!timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(signBody(keys[kid], body), 'utf8'))) return refuse('bad-signature')

  let order
  try {
    order = JSON.parse(body)
  } catch {
    return refuse('malformed')
  }
  if (!plainObject(order) || !sameKeys(order, C.bodyKeys)) return refuse('malformed')
  const issuedMs = contractTime(order.issuedAt)
  const expiresMs = contractTime(order.expiresAt)
  if (issuedMs === null || expiresMs === null || !plainObject(order.payload)) return refuse('malformed')
  if (typeof order.repo !== 'string' || !C.repoShape.test(order.repo)) return refuse('malformed')
  if (typeof order.runner !== 'string' || !C.runnerShape.test(order.runner)) return refuse('malformed')
  if (order.v !== C.version) return refuse('bad-version')
  if (order.repo !== repo) return refuse('wrong-repo')
  if (order.runner !== runner) return refuse('wrong-runner')
  if (issuedMs > now + C.life.futureSkewSeconds * 1000) return refuse('issued-in-future')
  if (expiresMs <= now) return refuse('expired')
  const life = expiresMs - issuedMs
  if (life <= 0 || life > C.life.maxSeconds * 1000) return refuse('bad-life')
  if (typeof order.id !== 'string' || !C.idShape.test(order.id)) return refuse('bad-id')
  if (claimsSince !== null && !(Number.isFinite(claimsSince) && issuedMs >= claimsSince)) return refuse('before-claims')
  return { verdict: 'ok', order }
}

// --- the switch and its settings -----------------------------------------------------------------
//
// FIRE_MODE=cloud (or unset) is the cloud routines, as before; FIRE_MODE=mailbox is this file. Any
// other value is neither: fire reads as not configured rather than quietly picking one.
//
// The settings a mailbox board needs, every one checked here and none ever echoed in a sentence:
//   MAILBOX_SECRET        the signing secret, made on the Mac (openssl rand), 32+ printable characters
//   MAILBOX_SECRET_ID     which key signed it, default k1 (k2 during a rotation)
//   MAILBOX_KEY           the Mac's own key for GET /api/mailbox, 32+ printable characters, and never
//                         the secret: whoever holds the poll key must not be able to sign
//   MAILBOX_POLL_SECONDS  how often the Mac asks, clamped 60 to 3,600, default 600
//   MAILBOX_RUNNER        the computer the orders are for, default mac-mini
// and GITHUB_OWNER / GITHUB_REPO (the repo every order names) and a connected picture store.
// A value someone left as a placeholder - FILL-ME-IN, "your-...", "replace this" - is not a value, and
// nor is a long run of a handful of characters (TODO-TODO-..., ****...): a made-up key has more.
const PLACEHOLDER = /fill[-_ ]?(me|in)|your[-_ ]|replace|change[-_ ]?(me|it)|insert|placeholder|example|xxxxxx|[<>]/i
const FEWEST_CHARACTERS = 8
const notAValue = (text) => PLACEHOLDER.test(text) || new Set(text).size < FEWEST_CHARACTERS
const MODE_UNKNOWN = 'Fire is not configured: FIRE_MODE must be cloud or mailbox. Fix it in the hosting environment, then redeploy.'
const notSet = (name, what) =>
  `The Mac mailbox is not configured: ${name} must be ${what}. Set it in the hosting environment (the README's "Orders on your own computer" says how), then redeploy.`

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '')

// The fire key a mailbox board needs: 24 characters or more once the spaces round it are gone, and not a
// placeholder - the same test the secret and the key get. Mailbox mode only: a cloud board's passphrase
// is the owner's, and a word in it like "example" must not switch their Run buttons off (FIRE_TRIGGERS
// still guards a cloud board).
export const MAILBOX_FIRE_KEY_MIN = 24
export const mailboxFireKeyOk = (value) => {
  const text = trimmed(value)
  return text.length >= MAILBOX_FIRE_KEY_MIN && !notAValue(text)
}
const secretValue = (value, shape) => {
  const text = trimmed(value)
  return shape.test(text) && !notAValue(text) ? text : null
}

export function mailboxConfig(env = process.env) {
  const mode = trimmed(env.FIRE_MODE) || 'cloud'
  if (mode === 'cloud') return { mode: 'cloud', ready: false, why: null }
  if (mode !== 'mailbox') return { mode: 'unknown', ready: false, why: MODE_UNKNOWN }
  const refuse = (why) => ({ mode: 'mailbox', ready: false, why })
  const secret = secretValue(env.MAILBOX_SECRET, C.secretShape)
  if (!secret) return refuse(notSet('MAILBOX_SECRET', 'the signing secret made on your Mac: 32 characters or more, no spaces'))
  const kid = trimmed(env.MAILBOX_SECRET_ID) || 'k1'
  if (!C.kidShape.test(kid)) return refuse(notSet('MAILBOX_SECRET_ID', 'a short key name in lowercase, like k1'))
  const key = secretValue(env.MAILBOX_KEY, C.keyShape)
  if (!key) return refuse(notSet('MAILBOX_KEY', 'your Mac\'s own key: 32 characters or more, no spaces'))
  if (key === secret) return refuse(notSet('MAILBOX_KEY', 'a different value from MAILBOX_SECRET, so the key that collects orders cannot sign one'))
  const runner = trimmed(env.MAILBOX_RUNNER) || 'mac-mini'
  if (!C.runnerShape.test(runner)) return refuse(notSet('MAILBOX_RUNNER', 'the computer\'s name in lowercase with dashes, like mac-mini'))
  const repo = `${trimmed(env.GITHUB_OWNER)}/${trimmed(env.GITHUB_REPO)}`
  if (!C.repoShape.test(repo)) return refuse(notSet('GITHUB_OWNER and GITHUB_REPO', 'your team repo\'s owner and name'))
  if (!storeConnected(env)) return refuse(NOT_CONNECTED)
  const asked = trimmed(env.MAILBOX_POLL_SECONDS)
  const { min, max, default: fallback } = C.pollSeconds
  const pollSeconds = /^\d+$/.test(asked) ? Math.min(max, Math.max(min, Number(asked))) : fallback
  return { mode: 'mailbox', ready: true, why: null, secret, kid, key, pollSeconds, runner, repo }
}

// The checks the board holds its own queue to: its own key, repo and computer.
const ownChecks = (config, nowMs) => ({ keys: { [config.kid]: config.secret }, repo: config.repo, runner: config.runner, now: nowMs })

// --- one order ------------------------------------------------------------------------------------

// `payload` is exactly what fire.js would send the cloud routine, so both modes send the same request.
export function makeOrder(payload, config, now = new Date(), random = randomBytes) {
  const id = random(16).toString('hex')
  const issuedAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + orderLifeSeconds(config.pollSeconds) * 1000).toISOString()
  const body = JSON.stringify({ v: C.version, id, repo: config.repo, runner: config.runner, issuedAt, expiresAt, payload })
  return { id, expiresAt, envelope: { kid: config.kid, body, sig: signBody(config.secret, body) } }
}

// --- the queue ------------------------------------------------------------------------------------
//
// { version: 1, day, count, orders: [envelope, ...] }, in the picture store (api/_picture-store.js).
// Orders leave it only by expiring: the Mac writes nothing to the store, and remembers what it took
// in its own claim folders. `count` is the day's orders, so the eight a day cost no extra write.
//
// Read as if a stranger wrote it: only orders this board signed - its key, its repo, its computer -
// that are still alive are kept, and anything else in the file is dropped, never served or saved.

const QUEUE_DAY = /^\d{4}-\d{2}-\d{2}$/
const ONE_DAY_MS = 86_400_000
const ORDERS_SPENT =
  `Your board has sent all ${MAILBOX_ORDERS_PER_DAY} orders it allows today, so nothing was sent: try again ` +
  'tomorrow (the count starts again at midnight UTC). The limit keeps the picture store inside Vercel\'s ' +
  'free monthly allowance, which locks the store for 30 days if it is passed.'
const QUEUE_FULL =
  `${C.maxOrders} orders are already waiting for your Mac, so nothing was sent: check that your Mac is on ` +
  'and awake, then try again.'

export function parseQueue(text, config, nowMs) {
  const empty = { day: '', count: 0, orders: [] }
  let parsed
  try {
    parsed = typeof text === 'string' && text ? JSON.parse(text) : null
  } catch {
    return empty
  }
  if (!plainObject(parsed) || !Array.isArray(parsed.orders)) return empty
  // The latest day this board writes is tomorrow: another instance whose clock is already past midnight.
  // A day further on is a stranger's - believed, it would hold the day's count for ever, since the day
  // only moves forward - so it reads as no day at all.
  const latest = usageDay(new Date(nowMs + ONE_DAY_MS))
  const day = typeof parsed.day === 'string' && QUEUE_DAY.test(parsed.day) && parsed.day <= latest ? parsed.day : ''
  const count = day && Number.isInteger(parsed.count) && parsed.count >= 0 ? parsed.count : 0
  const checks = ownChecks(config, nowMs)
  const orders = parsed.orders
    .filter((envelope) => verifyOrder(envelope, checks).verdict === 'ok')
    .slice(-C.maxOrders)
  return { day, count, orders }
}

// One order into the queue: { id, expiresAt }. Throws a PictureStoreError (with its status and a
// sentence) when the day's orders are used or the queue is full, and nothing is saved.
export async function queueOrder(store, config, payload, now = new Date()) {
  let made = null
  await store.saveMailbox((text) => {
    const queue = parseQueue(text, config, now.getTime())
    const day = usageDay(now)
    // The day only moves forward: a request whose clock still says yesterday is held to the file's count.
    const sameDay = queue.day >= day
    const used = sameDay ? queue.count : 0
    if (used >= MAILBOX_ORDERS_PER_DAY) throw new PictureStoreError(429, ORDERS_SPENT)
    if (queue.orders.length >= C.maxOrders) throw new PictureStoreError(429, QUEUE_FULL)
    made = makeOrder(payload, config, now)
    return JSON.stringify({ version: 1, day: sameDay ? queue.day : day, count: used + 1, orders: [...queue.orders, made.envelope] })
  })
  return { id: made.id, expiresAt: made.expiresAt }
}

// What the Mac is shown: the queue's good, unexpired orders, oldest first, as they were stored.
export async function pendingOrders(store, config, now = new Date()) {
  const { text } = await store.readMailbox()
  return parseQueue(text, config, now.getTime()).orders
}
