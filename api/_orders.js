// Orders by voice (Phase 11): what the assistant may propose on this board. Starts with "_" so
// Vercel does not turn it into an endpoint.
//
// An order is never sent by the assistant. It proposes one - a task card for the team, or one run of a
// job - the page shows a card, and only the owner's yes sends it: a tap on the card, or their own
// spoken yes under the rules in api/_voice.js. It then goes through /api/fire, exactly as the board's
// Add task and Run buttons do, so it needs what they need: FIRE_TRIGGERS, and the fire key (or
// PUBLIC_FIRE). With either missing, orders are off and the assistant says ORDERS_OFF.
//
// What this tells the page and the session is which kinds of order exist and the slugs of the jobs
// that have a trigger link. Never a link, or any part of one: a trigger link starts a session by
// itself, so it stays in the env var, as fire.js keeps it. Pure: it reads the env it is handed.

import { parseTriggers, TASK_INTAKE_SLUG } from './fire.js'
import { isValidSlug } from './_lib.js'
import { ORDERS_OFF } from './_voice.js'

// The jobs the assistant is offered by name. A list it can be shown in one tool, sorted so the
// session is the same every call.
export const MAX_ORDER_JOBS = 40

const switchedOff = (value) => /^(off|false|0)$/i.test(typeof value === 'string' ? value.trim() : '')
const switchedOn = (value) => /^(on|true|1)$/i.test(typeof value === 'string' ? value.trim() : '')

const off = () => ({ on: false, why: ORDERS_OFF, tasks: false, jobs: [], key: null, spokenYes: false, jev: false })

export function ordersConfig(env = {}) {
  const triggers = parseTriggers(env.FIRE_TRIGGERS)
  // The same two rules fire.js applies, in the same words: PUBLIC_FIRE waives the fire key, except on
  // a board open to everyone, where there is no first key and so the fire key is required.
  const publicFire = env.PUBLIC_FIRE === 'true' && env.PUBLIC_DASHBOARD !== 'true'
  if (!triggers || (!env.FIRE_KEY && !publicFire)) return off()
  const linked = (slug) => typeof triggers[slug] === 'string' && /^https:\/\//.test(triggers[slug])
  const tasks = linked(TASK_INTAKE_SLUG)
  const jobs = Object.keys(triggers)
    .filter((slug) => slug !== TASK_INTAKE_SLUG && isValidSlug(slug) && linked(slug))
    .sort()
    .slice(0, MAX_ORDER_JOBS)
  if (!tasks && !jobs.length) return off()
  return {
    on: true,
    tasks,
    jobs,
    // How the page sends: with the fire key it asks for once and keeps in the tab, or with none.
    key: publicFire ? 'public' : 'fire-key',
    // The owner's spoken yes, as well as a tap. On unless VOICE_SPOKEN_YES says off.
    spokenYes: !switchedOff(env.VOICE_SPOKEN_YES),
    // Jev, on OpenRouter, suggests which agent gets a task. Off unless switched on AND keyed: the
    // order's words go to OpenRouter when it is on, which the README says where the switch is.
    jev: tasks && switchedOn(env.JEV_ROUTING) && Boolean(typeof env.OPENROUTER_API_KEY === 'string' && env.OPENROUTER_API_KEY.trim())
  }
}

// What the page is told when a call starts: the same, minus the sentence the assistant already has.
export function ordersView(config) {
  if (!config?.on) return { on: false }
  const { on, tasks, jobs, key, spokenYes, jev } = config
  return { on, tasks, jobs: [...jobs], key, spokenYes, jev }
}
