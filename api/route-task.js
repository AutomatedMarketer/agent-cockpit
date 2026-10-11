// /api/route-task: who should do a task the owner asked for by voice, and on which model tier - Jev's
// picks, each with its odds.
//
// Jev is TypeSafe's decision model, on OpenRouter: given some state and typed questions it answers
// each with a choice and how sure it is, and never writes prose. Nuno's decisions: build it behind a
// switch (2026-10-10, D2), then switch it on for his board and have it pick the model too, with its
// odds on the card (2026-10-11). Off, the board sends nothing anywhere and answers "off" for both:
// the task card goes without a "for" and without a model, so the orchestrator routes it on its sweep
// and the agent works on its own model, exactly as the Add task button does. On (JEV_ROUTING=on and
// OPENROUTER_API_KEY set), the task's title and details, each agent's slug and description, and the
// board's own one-line note on each tier go to OpenRouter. The README says so where the switch is.
// The owner sees both picks on the card, can change either, and /api/fire checks them again.
//
// The order is the contract: the write gate (a suggestion for a change is part of the change), then
// the switch, then a request this endpoint can check, then Jev. The key goes in one header to one
// address. Only an agent or a tier it was sent, at CONFIDENCE_FLOOR or surer, comes back, with its odds
// as a whole number from 0 to 100; anything else is no pick, with one of our own reasons - "off",
// "no answer" (slower than JEV_TIMEOUT_MS, an error, a refusal, words), "unsure" (under the floor, or
// a choice it was not offered), "none to choose". Nothing Jev says is ever passed on. Nothing is logged.
// Every answer, refusals included, is private, no-store.
//
// Endpoint, model and request shape: Nuno's own Jev client, my-ai-team donna/skills/jev-decisions/
// scripts/jev.mjs (fact sheet of 2026-09-21): one call can carry several questions, and each choice
// answer has its choice and its confidence. It is an alpha endpoint: the live check confirms it.

import { readJsonBody, isValidSlug } from './_lib.js'
import { writeGate } from './_gate.js'
import { validateTask } from './fire.js'
import { VOICE_DETAILS_MAX, VOICE_MODEL_TIERS } from './_voice.js'

export const JEV_URL = 'https://openrouter.ai/api/alpha/decisions'
export const JEV_MODEL = 'typesafe/jev-1.13'
// Nuno's floor for acting on a Jev answer (jev.mjs, CONFIDENCE_FLOOR), as odds out of 100.
const ODDS_FLOOR = 60
const MAX_AGENTS = 16
const MAX_DESCRIPTION = 200
// A card is on screen waiting for the owner; Jev usually answers in well under half a second (Nuno's
// README: "about 200 milliseconds"), and past this the card goes as if Jev were off.
export const JEV_TIMEOUT_MS = 1500

// The board's own words for each tier - not the team's, and never Jev's.
const TIER_NOTES = {
  opus: 'The most capable tier: hard, long, many-sided or high-stakes work.',
  sonnet: 'The everyday tier: ordinary drafting, research, replies and summaries.',
  haiku: 'The quickest and cheapest tier: short, simple or mechanical work.'
}

const none = (why) => ({ pick: null, why })
const both = (why) => ({ agent: none(why), model: none(why) })
const switchedOn = (env) => /^(on|true|1)$/i.test(String(env.JEV_ROUTING ?? '').trim()) &&
  typeof env.OPENROUTER_API_KEY === 'string' && Boolean(env.OPENROUTER_API_KEY.trim())

// The request, checked and capped: the title by the rule a task card is held to (validateTask, which
// refuses hidden characters too), details by the voice cap, agents with real slugs only, each
// description one plain line, and tiers the board knows only.
function readAsk(body) {
  const checked = validateTask({ title: body?.title, details: body?.details })
  if (checked.error) return { error: checked.error }
  const details = checked.task.details ?? ''
  if (details.length > VOICE_DETAILS_MAX) return { error: `details must be at most ${VOICE_DETAILS_MAX} characters.` }
  const agents = (Array.isArray(body?.agents) ? body.agents : [])
    .filter((agent) => isValidSlug(agent?.slug))
    .slice(0, MAX_AGENTS)
    .map((agent) => ({
      slug: agent.slug,
      description: (typeof agent.description === 'string' ? agent.description : '').replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION) || agent.slug
    }))
  const models = (Array.isArray(body?.models) ? body.models : []).filter((tier) => VOICE_MODEL_TIERS.includes(tier))
  return { title: checked.task.title, details: details.trim(), agents, models }
}

// One choice, as the board will use it: an option it was offered, at the floor or surer.
function choiceFrom(answer, offered) {
  const choice = answer?.choice
  if (typeof choice !== 'string' || !offered.includes(choice)) return none('unsure')
  if (typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence)) return none('unsure')
  const odds = Math.min(100, Math.max(0, Math.round(answer.confidence * 100)))
  return odds >= ODDS_FLOOR ? { pick: choice, odds } : none('unsure')
}

async function askJev(ask, apiKey, timeoutMs) {
  const questions = {
    ...(ask.agents.length
      ? { owner: { type: 'choice', instructions: 'Which agent on this team should do this task?', criteria: Object.fromEntries(ask.agents.map((agent) => [agent.slug, agent.description])) } }
      : {}),
    ...(ask.models.length
      ? { model: { type: 'choice', instructions: 'Which model tier does this task need? Pick the least capable tier that will do it well.', criteria: Object.fromEntries(ask.models.map((tier) => [tier, TIER_NOTES[tier]])) } }
      : {})
  }
  let upstream
  try {
    upstream = await fetch(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: JEV_MODEL, state: { task: ask.title, ...(ask.details ? { details: ask.details } : {}) }, questions }),
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch {
    return both('no answer')
  }
  if (!upstream.ok) return both('no answer')
  let answers
  try {
    answers = (await upstream.json())?.answers
  } catch {
    return both('no answer')
  }
  if (!answers || typeof answers !== 'object') return both('no answer')
  return {
    agent: ask.agents.length ? choiceFrom(answers.owner, ask.agents.map((agent) => agent.slug)) : none('none to choose'),
    model: ask.models.length ? choiceFrom(answers.model, ask.models) : none('none to choose')
  }
}

// `env` and `timeoutMs` are injected by the tests.
export function makeHandler({ env, timeoutMs = JEV_TIMEOUT_MS } = {}) {
  return async function handler(request, response) {
    const environment = env ?? process.env
    response.setHeader('Cache-Control', 'private, no-store')
    if (String(request?.method ?? 'GET').toUpperCase() !== 'POST') {
      response.setHeader('Allow', 'POST')
      response.status(405).json({ error: 'POST { "title", "details"?, "agents": [{ "slug", "description" }], "models": [tier] } as application/json.' })
      return
    }
    const denied = await writeGate(request, environment, 'application/json')
    if (denied) {
      const { status, ...answer } = denied
      response.status(status).json(answer)
      return
    }
    if (!switchedOn(environment)) {
      response.status(200).json(both('off'))
      return
    }
    const ask = readAsk(readJsonBody(request))
    if (ask.error) {
      response.status(400).json({ error: ask.error })
      return
    }
    if (!ask.agents.length && !ask.models.length) {
      response.status(200).json(both('none to choose'))
      return
    }
    response.status(200).json(await askJev(ask, environment.OPENROUTER_API_KEY.trim(), timeoutMs))
  }
}

export default makeHandler()
