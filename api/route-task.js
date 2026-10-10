// /api/route-task: which agent should do a task the owner asked for by voice - Jev's suggestion.
//
// Jev is TypeSafe's decision model, on OpenRouter: given some state and a typed question it answers
// with a choice and how sure it is, and never writes prose. Nuno's decision (2026-10-10, D2): build it
// behind a switch and leave the switch off. Off, the board sends nothing anywhere and answers
// { for: null }: the task card goes without a "for" and the orchestrator routes it on its sweep,
// exactly as the Add task button does. On (JEV_ROUTING=on and OPENROUTER_API_KEY set), the order's
// title and details, and each agent's slug and description, go to OpenRouter. The README says so where
// the switch is documented. The owner sees the pick on the card and can change it, and /api/fire still
// checks the agent is real before the card is filed.
//
// The order is the contract: the write gate (a suggestion for a change is part of the change), then
// the switch, then a request this endpoint can check, then Jev. The key goes in one header to one
// address. Only a slug it was sent, at CONFIDENCE_FLOOR or surer, comes back; anything else - off, a
// timeout, an error, a refusal, words - is { for: null }, and nothing Jev says is ever passed on as
// words. Nothing here writes to the logs. Every answer, refusals included, is private, no-store.
//
// Endpoint, model and request shape: Nuno's own Jev client, my-ai-team donna/skills/jev-decisions/
// scripts/jev.mjs (checked against the Jev fact sheet of 2026-09-21). It is an alpha endpoint, so the
// live check confirms it before the switch is turned on.

import { readJsonBody, isValidSlug } from './_lib.js'
import { writeGate } from './_gate.js'
import { validateTask } from './fire.js'
import { VOICE_DETAILS_MAX } from './_voice.js'

export const JEV_URL = 'https://openrouter.ai/api/alpha/decisions'
export const JEV_MODEL = 'typesafe/jev-1.13'
// Nuno's floor for acting on a Jev answer (jev.mjs, CONFIDENCE_FLOOR).
const CONFIDENCE_FLOOR = 0.6
const MAX_AGENTS = 16
const MAX_DESCRIPTION = 200
// A card is on screen waiting for the owner; a suggestion that takes longer than this is no use.
const JEV_TIMEOUT_MS = 4000

const NOBODY = { for: null }
const switchedOn = (env) => /^(on|true|1)$/i.test(String(env.JEV_ROUTING ?? '').trim()) &&
  typeof env.OPENROUTER_API_KEY === 'string' && Boolean(env.OPENROUTER_API_KEY.trim())

// The request, checked and capped: the title by the rule a task card is held to, details by the
// voice cap, agents with real slugs only, each description one plain line.
function readAsk(body) {
  const checked = validateTask({ title: body?.title })
  if (checked.error) return { error: checked.error }
  const details = typeof body?.details === 'string' ? body.details.trim() : ''
  if (details.length > VOICE_DETAILS_MAX) return { error: `details must be at most ${VOICE_DETAILS_MAX} characters.` }
  const agents = (Array.isArray(body?.agents) ? body.agents : [])
    .filter((agent) => isValidSlug(agent?.slug))
    .slice(0, MAX_AGENTS)
    .map((agent) => ({
      slug: agent.slug,
      description: (typeof agent.description === 'string' ? agent.description : '').replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION) || agent.slug
    }))
  return { title: checked.task.title, details, agents }
}

async function askJev(ask, apiKey, timeoutMs) {
  const criteria = Object.fromEntries(ask.agents.map((agent) => [agent.slug, agent.description]))
  let upstream
  try {
    upstream = await fetch(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: JEV_MODEL,
        state: { task: ask.title, ...(ask.details ? { details: ask.details } : {}) },
        questions: {
          owner: { type: 'choice', instructions: 'Which agent on this team should do this task?', criteria }
        }
      }),
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch {
    return NOBODY
  }
  if (!upstream.ok) return NOBODY
  let answer
  try {
    answer = (await upstream.json())?.answers?.owner
  } catch {
    return NOBODY
  }
  const choice = answer?.choice
  const confidence = answer?.confidence
  if (typeof choice !== 'string' || !Object.hasOwn(criteria, choice)) return NOBODY
  if (typeof confidence !== 'number' || !(confidence >= CONFIDENCE_FLOOR) || confidence > 1) return NOBODY
  return { for: choice, confidence: Math.round(confidence * 100) / 100 }
}

// `env` and `timeoutMs` are injected by the tests.
export function makeHandler({ env, timeoutMs = JEV_TIMEOUT_MS } = {}) {
  return async function handler(request, response) {
    const environment = env ?? process.env
    response.setHeader('Cache-Control', 'private, no-store')
    if (String(request?.method ?? 'GET').toUpperCase() !== 'POST') {
      response.setHeader('Allow', 'POST')
      response.status(405).json({ error: 'POST { "title", "details"?, "agents": [{ "slug", "description" }] } as application/json.' })
      return
    }
    const denied = await writeGate(request, environment, 'application/json')
    if (denied) {
      const { status, ...answer } = denied
      response.status(status).json(answer)
      return
    }
    if (!switchedOn(environment)) {
      response.status(200).json(NOBODY)
      return
    }
    const ask = readAsk(readJsonBody(request))
    if (ask.error) {
      response.status(400).json({ error: ask.error })
      return
    }
    if (!ask.agents.length) {
      response.status(200).json(NOBODY)
      return
    }
    response.status(200).json(await askJev(ask, environment.OPENROUTER_API_KEY.trim(), timeoutMs))
  }
}

export default makeHandler()
