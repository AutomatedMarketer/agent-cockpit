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

import { createHmac, timingSafeEqual } from 'node:crypto'

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
  keyShape: /^[\x21-\x7e]{32,256}$/,
  pollSeconds: Object.freeze({ min: 60, max: 3600, default: 600 }),
  maxOrders: 20,
  actions: ['run', 'pause', 'task', 'arm', 'approve', 'move', 'skill', 'agent'],
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
    }
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
export function verifyOrder(envelope, { keys, repo, runner, now }) {
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
  return { verdict: 'ok', order }
}
