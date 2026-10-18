// The board's own sentences were written for the website: "set OPENAI_API_KEY in Vercel and redeploy". On a
// student's computer there is no Vercel and nothing to redeploy: the key is pasted in Settings. This turns the
// sentences the board's API can say into local ones, on their way out of the local server only (the API files,
// and so the website, are not touched).
//
// Strict on purpose, in two ways:
//  - only the keys that carry a sentence meant for the person (error, why, note, say) are looked at;
//  - inside them, only the board's OWN exact wording is rewritten, clause by clause (every rule below is a
//    sentence or clause copied from an api/ file). A string that merely mentions Vercel - a task called
//    "Move the site to Vercel and redeploy", a note from the team's repo - matches no rule and is never touched.
// tests/local-wording.test.mjs reads every sentence in api/ and fails if one comes out still telling a student to
// use Vercel or redeploy, so a new website sentence needs its rule here.

import { READINESS_WORDS } from '../api/_readiness.js'

const TRIGGER = /Vercel|redeploy|hosting environment|env var\b|\bMac\b/i
export const SENTENCE_KEYS = Object.freeze(['error', 'why', 'note', 'say'])

const NOT_YET = 'This is not set up on this computer yet.'
const JOBS_NOT_YET = 'Starting jobs from the board is not set up on this computer yet.'
const PICTURES = 'the pictures folder'

// [exact wording from api/, what a student reads instead]. Specific rules go first.
const ORDERS_OFF_HERE = "Orders by voice are off, because jobs are not switched on for this board yet. The Start Board window says why. Fix that, then double-click Start Board again."
const RULES = [
  // Orders by voice are off: on this computer the way back on is the Start Board window, not a website setting
  [/^Orders by voice are off, because this board sends its orders to your Mac and the Mac mailbox is not set up yet\. The README's "Orders on your own computer" steps switch it on\.$/g, ORDERS_OFF_HERE],
  [/^Orders by voice are off, because this board's Run buttons are not set up yet\. To switch them on, follow the README's "Orders by voice" steps: [^]*redeploy\.$/g, ORDERS_OFF_HERE],
  // OpenAI key: voice, pictures, meaning search
  [/set OPENAI_API_KEY in Vercel( \([^)]*\))? and redeploy/g, 'paste an OpenAI key in Settings$1'],
  [/set it in Vercel( \([^)]*\))? and redeploy/g, 'paste an OpenAI key in Settings$1'],
  [/Talking to the board needs OPENAI_API_KEY: paste an OpenAI key in Settings/g, 'Talking to the board needs an OpenAI key: paste one in Settings'],
  [/needs OPENAI_API_KEY: paste an OpenAI key in Settings/g, 'needs an OpenAI key: paste one in Settings'],
  [/needs OPENAI_API_KEY/g, 'needs an OpenAI key (paste one in Settings)'],
  [/OpenAI did not accept OPENAI_API_KEY for voice, so check the key \(and that its project can use the realtime models\) in Vercel and redeploy/g, 'OpenAI did not accept the key for voice, so check the key in Settings (and that its project can use the realtime models)'],
  [/OpenAI did not accept OPENAI_API_KEY, so check the key in Vercel and redeploy/g, 'OpenAI did not accept the key, so check the key in Settings'],
  [/OpenAI did not accept OPENAI_API_KEY, so meaning search is paused: check the key in Vercel and redeploy/g, 'OpenAI did not accept the key, so meaning search is paused: check the key in Settings'],
  // Fish
  [/set FISH_API_KEY and FISH_VOICE_ID in Vercel to use your own/g, 'paste a Fish key in Settings to use your own'],
  [/Fish did not accept FISH_API_KEY, so check the key in Vercel and redeploy/g, 'Fish did not accept the key, so check it in Settings'],
  // The team repo and the picture store are set up by Start Board on a student's computer
  [/Set GITHUB_OWNER and GITHUB_REPO in your hosting environment(?:, then redeploy)?\.?/g, 'The board could not find your team folder. Check board.json next to Start Board, then double-click Start Board again.'],
  [/No picture store is connected: in Vercel, create a Private Blob store for this project, then redeploy\./g, 'The board could not use its pictures folder. Look in the Start Board window for the reason.'],
  [/in Vercel, create a Private Blob store for this project, then redeploy\./g, `look in the Start Board window if ${PICTURES} is not working.`],
  [/delete (agent-cockpit\/[a-z-]+\.json) in the store \(Vercel, Storage\)/g, `delete $1 in ${PICTURES}`],
  [/so create a private one, connect it to this project and redeploy\./g, 'so use a private one.'],
  [/so connect the store to this project in Vercel's Storage tab and redeploy\./g, `so check ${PICTURES}.`],
  [/so connect a new private one and redeploy\./g, `so check ${PICTURES}.`],
  [/so check Storage in Vercel\./g, `so check ${PICTURES}.`],
  [/check the store in Vercel's Storage tab\./g, `check ${PICTURES}.`],
  [/keeps the picture store inside Vercel's free monthly allowance, which locks the store for 30 days if it is passed/g, `keeps ${PICTURES} from growing without end`],
  // Search by meaning
  [/To switch it on, set MEMORY_MEANING to on in Vercel and redeploy:/g, 'It is not available on this computer yet:'],
  [/set EDIT_KEY in Vercel and redeploy to switch it on/g, 'set an edit key to switch it on'],
  // Voice
  [/Set EDIT_KEY in Vercel and redeploy to turn it on\./g, 'Set an edit key to turn it on.'],
  [/, or remove it, then redeploy\./g, ', or remove it.'],
  [/ then FIRE_KEY and FIRE_TRIGGERS in Vercel, then redeploy\./g, ' then FIRE_KEY and FIRE_TRIGGERS.'],
  // The Mac: on a student's computer the orders are done on this computer, at once
  [/(\d+) orders are already waiting for your Mac, so nothing was sent: check that your Mac is on and awake, then try again\./g, '$1 orders are already waiting, so nothing was sent: wait for this computer to finish some, then try again.'],
  [/Codex is not ready on your Mac/g, 'Codex is not ready on this computer'],
  [/^Your Mac has not reported on an order yet\./g, 'This computer has not reported on an order yet.'],
  [/\bA Mac mailbox file\b/g, 'The orders status file'],
  // Sign-in and sign-out of the website
  [/set a longer one in Vercel and redeploy\./g, 'use a longer one.'],
  [/change VIEW_KEY \(or BOARD_PASSWORD\) in Vercel and redeploy\./g, 'close the board and open it again from Start Board.'],
  // Starting jobs (the website's fire key and routines)
  [/Fire is not configured\. Set FIRE_KEY and FIRE_TRIGGERS \([^)]*\) in the hosting environment, then redeploy\./g, JOBS_NOT_YET],
  [/Fire is not configured: FIRE_TRIGGERS is in the old format[\s\S]*?then redeploy\./g, JOBS_NOT_YET],
  [/Fire is not configured: in mailbox mode FIRE_KEY must be[\s\S]*?in the hosting environment, then redeploy\./g, JOBS_NOT_YET],
  [/(No "[^"]*" routine is registered, so the dashboard cannot [^.]*\.) Add its URL and token to the FIRE_TRIGGERS env var and redeploy\./g, `$1 ${NOT_YET}`],
  [/(No "[^"]*" routine is registered, so the dashboard cannot [^.]*\.) Create it with the prompt in the README's "Orders by voice", then add its URL and token to the FIRE_TRIGGERS env var and redeploy\./g, `$1 ${NOT_YET}`],
  [/(No trigger is registered for "[^"]*"\.) Add its routine's URL and token to the FIRE_TRIGGERS env var in the hosting environment and redeploy\./g, `$1 ${NOT_YET}`],
  [/This dashboard is not configured\. Set VIEW_KEY in your hosting environment and redeploy, or set PUBLIC_DASHBOARD=true if this repo is genuinely public\./g, 'This board is not set up on this computer yet. Close it and open it again from Start Board.'],
  [/Set EDIT_KEY in your hosting environment and redeploy to turn them on\./g, 'Set an edit key to turn them on.'],
  [/Fix it in the hosting environment, then redeploy\./g, NOT_YET],
  [/Set it in the hosting environment \([^)]*\), then redeploy\./g, NOT_YET],
  [/Set it in the hosting environment, then redeploy\./g, NOT_YET]
]

// Only a string a rule really changed is tidied. A student's own words (a task, a note in stack.yml or proposals.yml) that
// happen to say "Mac" or "Vercel" come back exactly as they were, spacing and all.
export function localizeSentence(text) {
  if (typeof text !== 'string' || !TRIGGER.test(text)) return text
  let out = text
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement)
  if (out === text) return text
  return out.replace(/\s+([.,;:])/g, '$1').replace(/\s{2,}/g, ' ').trim()
}

// The Readiness wall's lines (api/_readiness.js), built on the server for a Mac. Stricter than the sentences above, because
// this wall is full of the team's own words (job names, labels, a run's own summary):
//  - only named places in the answer are looked at (a card's sentence, schedule and quiet-reason text, a restart line, a
//    switched-off reason, the board's own two card labels) - never a job's name;
//  - inside a place, a line is rewritten only when it is, whole, one of the board's own sentences from api/_readiness.js
//    (matched with the job's name and the like left as they are); anything else comes back as it was.
// A new sentence in api/_readiness.js that says "Mac" needs its line in READINESS_LINES: tests/local-readiness-words.test.mjs
// goes through every one.
const READINESS_LINES = {
  listUnavailable: "This computer's list of {what} was not available at {time}: {why}.",
  listUnavailableNoWhy: "This computer's list of {what} was not available at {time}, and this computer did not say why.",
  notChecked: "Not checked since {date}. This computer's last reading is {hours} h old.",
  notLoaded: "{name} is installed but not switched on in this computer's scheduler, so it will not run.",
  notRunning: '{name} was not running when this computer checked at {time}.',
  running: '{name} was running when this computer checked at {time}.',
  failedExit: '{name} stopped with error code {code}. This computer does not say why; its log has the reason.',
  failedAfterRestart: '{name} stopped right after this computer restarted at {time}. Jobs like this need a person to check them after a restart.',
  restartedAt: 'This computer restarted at {stamp}',
  hermesRunning: 'Hermes was running when this computer checked at {time}.',
  hermesDown: 'Hermes was not running when this computer checked at {time}.',
  collectorSilent: 'The status collector has not written its readings since {date}, so nothing on this computer is being checked.',
  mailboxFine: 'This computer last reported on its orders at {time}, and none failed in the last day.',
  mailboxFailed: 'An order failed on this computer at {time}. Nothing it changed left this computer; send it again from the board.',
  mailboxLost: 'This computer lost track of an order at {time} and will not run it again by itself. Check the board, then send it again if it is not there.',
  mailboxSilent: 'This computer has not reported on an order since {date}, so the board cannot vouch for its orders.'
}
const MANAGED_OWNER_BEFORE = 'Whether its last report was written is checked on the Mac control center, not here.'
const MANAGED_OWNER_AFTER = 'Whether its last report was written is not checked here.'
const DISABLED_BEFORE = "Switched off: turned off on the Mac (its plist says Disabled), so the Mac's scheduler is told not to run it."
const DISABLED_AFTER = 'Switched off: turned off on this computer, so its scheduler is told not to run it.'
// The board fills these in the sentence before it leaves; {time}, {date}, {hours} and {stamp} stay for the page.
const FILLED_BY_BOARD = new Set(['name', 'code', 'what', 'why', 'summary'])

function lineRule(before, after) {
  const names = []
  const source = before.split(/(\{\w+\})/).map((part) => {
    const holder = /^\{(\w+)\}$/.exec(part)
    if (!holder) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (!FILLED_BY_BOARD.has(holder[1])) return part.replace(/[{}]/g, '\\$&')
    names.push(holder[1])
    return '([\\s\\S]*?)'
  }).join('')
  const pattern = new RegExp(`^${source}$`)
  return (text) => {
    const found = pattern.exec(text)
    return found ? after.replace(/\{(\w+)\}/g, (whole, name) => (names.includes(name) ? found[names.indexOf(name) + 1] : whole)) : null
  }
}
let lineRules = null
function readinessLine(text) {
  if (text === READINESS_WORDS.managedOwner) return `Its scheduler is running. ${MANAGED_OWNER_AFTER}`
  lineRules ??= Object.entries(READINESS_LINES).map(([key, after]) => lineRule(READINESS_WORDS[key], after))
  // A scheduler line is followed by a second sentence of the board's: split that off (it is at the very end), then the rest.
  const tail = ` Its scheduler is running. ${MANAGED_OWNER_BEFORE}`
  const body = text.endsWith(tail) ? text.slice(0, -tail.length) : text
  const [done] = lineRules.map((rule) => rule(body)).filter((one) => one !== null)
  if (done === undefined) return text.endsWith(tail) ? `${text.slice(0, -tail.length)} Its scheduler is running. ${MANAGED_OWNER_AFTER}` : text
  return text.endsWith(tail) ? `${done} Its scheduler is running. ${MANAGED_OWNER_AFTER}` : done
}
const readinessSchedule = (text) => (text.endsWith(' (Mac time)') ? `${text.slice(0, -' (Mac time)'.length)} (this computer's time)` : text)
const MAC_SIDE = new Set(['launchd', 'hermes', 'hermes-service', 'collector', 'mailbox', 'jobs-list'])

function readinessCard(card) {
  if (card === null || typeof card !== 'object') return card
  const out = { ...card }
  for (const key of ['sentence', 'silentSentence', 'lastReport']) {
    if (typeof card[key]?.text === 'string') out[key] = { ...card[key], text: readinessLine(card[key].text) }
  }
  if (typeof card.schedule?.text === 'string') out.schedule = { ...card.schedule, text: readinessSchedule(card.schedule.text) }
  // The board's own two labels; a job that is merely CALLED the same keeps its name (its source is not these).
  if (card.source === 'mailbox') {
    if (card.name === 'Mac mailbox') out.name = 'Orders from the board'
    if (typeof card.ref === 'string' && card.ref.endsWith(' · Mac mailbox')) out.ref = `${card.ref.slice(0, -' · Mac mailbox'.length)} · Orders from the board`
  }
  if (card.source === 'jobs-list' && card.name === 'Mac LaunchAgents') out.name = 'Scheduled jobs'
  // A card for a computer that gave no name is labelled "Mac" by the board.
  if (MAC_SIDE.has(card.source) && typeof out.ref === 'string' && out.ref.startsWith('Mac · ')) out.ref = `This computer · ${out.ref.slice('Mac · '.length)}`
  return out
}

export function localizeReadiness(readiness) {
  if (readiness === null || typeof readiness !== 'object' || Array.isArray(readiness)) return readiness
  const out = { ...readiness }
  if (Array.isArray(readiness.cards)) out.cards = readiness.cards.map(readinessCard)
  if (Array.isArray(readiness.restarts)) {
    out.restarts = readiness.restarts.map((line) => (line === null || typeof line !== 'object' ? line : {
      ...line,
      ...(line.where === 'Mac' ? { where: 'This computer' } : {}),
      ...(line.text === READINESS_WORDS.restartedAt ? { text: READINESS_LINES.restartedAt } : {})
    }))
  }
  if (Array.isArray(readiness.switchedOff)) {
    out.switchedOff = readiness.switchedOff.map((entry) => (entry?.reason === DISABLED_BEFORE ? { ...entry, reason: DISABLED_AFTER } : entry))
  }
  if (typeof readiness.jobs?.why === 'string') out.jobs = { ...readiness.jobs, why: localizeSentence(readiness.jobs.why) }
  return out
}

// A JSON answer with its sentences localized; every other value is returned as it was.
export function localizeResponse(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => localizeResponse(item, depth + 1))
  const out = {}
  for (const [key, inner] of Object.entries(value)) {
    out[key] = key === 'readiness' && depth === 0 ? localizeReadiness(inner)
      : SENTENCE_KEYS.includes(key) && typeof inner === 'string' ? localizeSentence(inner)
        : localizeResponse(inner, depth + 1)
  }
  return out
}
