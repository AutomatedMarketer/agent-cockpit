// The buttons. Tap → agent runs in the cloud → returns a live session URL.
//
// This is the one endpoint that DISPATCHES. It still never writes to the repo: "run" fires
// the workflow's registered trigger URL, and "pause" fires the same trigger with an
// instruction for the agent session to make the edit itself. The dashboard reads git and
// dispatches through fire triggers — nothing more (spec B.2).
//
// Secrets discipline, same as everywhere else in this cockpit:
// - FIRE_KEY authorises the caller; compared constant-time; never echoed.
// - FIRE_TRIGGERS maps workflow slug → trigger URL. Trigger URLs are secret-adjacent
//   (anyone holding one can start a session), so they live in an env var, never the repo,
//   and never appear in a response or error.
// - GITHUB_TOKEN stays on the server, as in api/state.js and api/file.js.

import { createHash, timingSafeEqual } from 'node:crypto'
import { parseSimpleYaml } from './yaml-lite.js'

const GITHUB = 'https://api.github.com'
const ACTIONS = ['run', 'pause']
const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_SLUG_LENGTH = 100
const TRIGGER_TIMEOUT_MS = 15_000

// --- pure helpers, exported so the suite can hit them without a network ------------------

// Kebab-case only, checked before the slug touches the trigger map or a GitHub URL.
export function isValidSlug(slug) {
  return typeof slug === 'string' && slug.length <= MAX_SLUG_LENGTH && SLUG_SHAPE.test(slug)
}

// Hash both sides to a fixed length first so timingSafeEqual never throws on length
// mismatch — a plain length check would itself leak the key's length through timing.
export function keysMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false
  return timingSafeEqual(
    createHash('sha256').update(provided).digest(),
    createHash('sha256').update(expected).digest()
  )
}

// FIRE_TRIGGERS must be a JSON object of slug → https URL. Anything else reads as
// "not configured" — never as "open".
export function parseTriggers(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed
}

// The payload each action sends to the trigger URL. Pause is a dispatch too: the AGENT
// edits the workflow file and commits — the dashboard itself never writes to the repo.
export function dispatchPayload(slug, action) {
  if (action === 'pause') {
    return {
      source: 'agent-cockpit',
      action: 'pause',
      workflow: slug,
      instruction:
        `Pause the workflow "${slug}": edit workflows/${slug}.yml in the team repo to ` +
        'disable its schedule (comment it out or set the trigger off), commit the change, ' +
        'and write a run log noting the pause. The dashboard only dispatches — you, the ' +
        'agent session, make the edit.'
    }
  }
  return { source: 'agent-cockpit', action: 'run', workflow: slug }
}

// Accept a session link under the names triggers actually use — https only, and only on
// hosts we would tell someone to click. The trigger response is third-party input; a
// compromised trigger must not get to plant an arbitrary "watch live" link on this page.
const SESSION_URL_HOSTS = ['claude.ai']

export function sessionUrlFrom(result) {
  for (const key of ['sessionUrl', 'session_url', 'url']) {
    const value = result?.[key]
    if (typeof value !== 'string' || !/^https:\/\//.test(value)) continue
    let host
    try {
      host = new URL(value).hostname
    } catch {
      continue
    }
    if (SESSION_URL_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
      return value
    }
  }
  return null
}

// PUBLIC_FIRE promises "same-origin only", so enforce it: browsers stamp cross-site calls
// with Sec-Fetch-Site and Origin, and we refuse anything that does not look like our own
// page. Best-effort by nature (non-browser clients forge headers freely) — which is why the
// README still says to keep PUBLIC_FIRE deployments behind Vercel's own access control.
export function isSameOriginRequest(headers = {}) {
  const fetchSite = String(headers['sec-fetch-site'] ?? '').toLowerCase()
  if (fetchSite) return fetchSite === 'same-origin'
  const origin = headers.origin
  const host = headers['x-forwarded-host'] ?? headers.host
  if (typeof origin === 'string' && origin) {
    // Origin with nothing to compare against fails closed, not open.
    if (typeof host !== 'string' || !host) return false
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  }
  // No Sec-Fetch-Site and no Origin: not a cross-site browser call (browsers always send
  // Origin on cross-origin POSTs). Curl-style clients land here — same as key mode allows.
  return true
}

// --- GitHub read (same shape as api/file.js — read-only, token stays server-side) --------

function githubHeaders() {
  const base = { Accept: 'application/vnd.github.raw', 'User-Agent': 'agent-cockpit' }
  if (process.env.GITHUB_TOKEN) base.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  return base
}

async function fetchWorkflowSource({ owner, repo, branch }, slug) {
  for (const extension of ['yml', 'yaml']) {
    const response = await fetch(
      `${GITHUB}/repos/${owner}/${repo}/contents/workflows/${slug}.${extension}?ref=${branch}`,
      { headers: githubHeaders() }
    )
    if (response.ok) return response.text()
  }
  return null
}

// --- the handler --------------------------------------------------------------------------

function readBody(request) {
  const body = request?.body
  // The declared type's essence (parameters stripped) must be JSON whenever one is declared.
  // text/plain and application/x-www-form-urlencoded are the CORS-simple shapes a cross-site
  // page can send without a preflight — and the platform parses urlencoded into an object,
  // so the check has to run before the object branch, not just the string one.
  const contentType = String(request?.headers?.['content-type'] ?? '')
  const essence = contentType.split(';')[0].trim().toLowerCase()
  if (essence && essence !== 'application/json') return null
  if (body && typeof body === 'object') return body
  if (typeof body === 'string' && body.trim()) {
    if (!essence) return null // a bare string body with no declared type is not trusted
    try {
      return JSON.parse(body)
    } catch {
      return null
    }
  }
  return {}
}

export default async function handler(request, response) {
  if (String(request?.method ?? 'GET').toUpperCase() !== 'POST') {
    response.setHeader('Allow', 'POST')
    response.status(405).json({ error: 'POST only. Send { "workflow": "<slug>", "action": "run" | "pause" }.' })
    return
  }

  // Auth first, before the request body gets a single glance.
  const publicFire = process.env.PUBLIC_FIRE === 'true'
  const fireKey = process.env.FIRE_KEY
  const triggers = parseTriggers(process.env.FIRE_TRIGGERS)

  if (!triggers || (!fireKey && !publicFire)) {
    // Unconfigured is closed, never open — and the message says how to fix it without
    // saying which half is missing in a way that would confirm anything to a stranger.
    response.status(503).json({
      error:
        'Fire is not configured. Set FIRE_KEY and FIRE_TRIGGERS (a JSON object of ' +
        'workflow slug → trigger URL) in the hosting environment, then redeploy.'
    })
    return
  }

  if (publicFire) {
    if (!isSameOriginRequest(request.headers)) {
      response.status(403).json({ error: 'PUBLIC_FIRE only accepts same-origin requests.' })
      return
    }
  } else if (!keysMatch(request.headers?.['x-fire-key'], fireKey)) {
    response.status(401).json({ error: 'Missing or wrong fire key. Send it in the x-fire-key header.' })
    return
  }

  const body = readBody(request)
  if (body === null) {
    response.status(400).json({ error: 'The request body must be JSON, sent as Content-Type: application/json.' })
    return
  }

  const action = body.action ?? 'run'
  if (!ACTIONS.includes(action)) {
    response.status(400).json({ error: 'action must be "run" or "pause".' })
    return
  }

  const slug = body.workflow
  if (!isValidSlug(slug)) {
    response.status(400).json({ error: 'workflow must be a kebab-case slug, like "monday-brief".' })
    return
  }

  const triggerUrl = triggers[slug]
  if (typeof triggerUrl !== 'string' || !/^https:\/\//.test(triggerUrl)) {
    response.status(404).json({
      error:
        `No trigger is registered for "${slug}". Add its trigger URL to the FIRE_TRIGGERS ` +
        'env var in the hosting environment and redeploy.'
    })
    return
  }

  // The slug must also be a real workflow in the team repo with fire: true — the trigger
  // map alone is not the source of truth, the repo is.
  const owner = process.env.GITHUB_OWNER
  const repo = process.env.GITHUB_REPO
  const branch = process.env.GITHUB_BRANCH || 'main'
  if (!owner || !repo) {
    response.status(500).json({ error: 'Set GITHUB_OWNER and GITHUB_REPO in your hosting environment.' })
    return
  }

  let source
  try {
    source = await fetchWorkflowSource({ owner, repo, branch }, slug)
  } catch {
    response.status(502).json({ error: 'Could not read the team repo to check this workflow.' })
    return
  }
  if (source === null) {
    response.status(404).json({
      error: `"${slug}" is not a workflow in the team repo — expected workflows/${slug}.yml.`
    })
    return
  }

  const workflow = parseSimpleYaml(source)
  if (workflow?.trigger?.fire !== true) {
    response.status(403).json({
      error:
        `Workflow "${slug}" does not have trigger.fire: true, so the dashboard will not ` +
        'dispatch it. Add fire: true to its trigger block first.'
    })
    return
  }

  // Dispatch, server-side. Errors come back as plain words — never the trigger URL,
  // never anything the trigger said (its body is not ours to relay).
  let upstream
  try {
    upstream = await fetch(triggerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dispatchPayload(slug, action)),
      signal: AbortSignal.timeout(TRIGGER_TIMEOUT_MS)
    })
  } catch {
    response.status(502).json({ error: `The trigger for "${slug}" did not respond in time.` })
    return
  }

  if (!upstream.ok) {
    response.status(502).json({
      error: `The trigger for "${slug}" rejected the dispatch (status ${upstream.status}).`
    })
    return
  }

  let result = {}
  try {
    result = await upstream.json()
  } catch {
    // A 2xx with a non-JSON body still counts as accepted.
  }

  const sessionUrl = sessionUrlFrom(result)
  response.status(200).json(
    sessionUrl
      ? { ok: true, workflow: slug, action, sessionUrl }
      : { ok: true, workflow: slug, action, accepted: true }
  )
}
