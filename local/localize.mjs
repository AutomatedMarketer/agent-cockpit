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

const TRIGGER = /Vercel|redeploy|hosting environment|env var\b|\bMac\b/i
export const SENTENCE_KEYS = Object.freeze(['error', 'why', 'note', 'say'])

const NOT_YET = 'This is not set up on this computer yet.'
const JOBS_NOT_YET = 'Starting jobs from the board is not set up on this computer yet.'
const PICTURES = 'the pictures folder'

// [exact wording from api/, what a student reads instead]. Specific rules go first.
const RULES = [
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
  [/Orders by voice are off, because this board sends its orders to your Mac and the Mac mailbox is not set up yet\. The README's "Orders on your own computer" steps switch it on\./g, 'Orders by voice are off, because starting jobs from the board is not set up on this computer yet.'],
  [/(\d+) orders are already waiting for your Mac, so nothing was sent: check that your Mac is on and awake, then try again\./g, '$1 orders are already waiting, so nothing was sent: wait for this computer to finish some, then try again.'],
  [/Codex is not ready on your Mac/g, 'Codex is not ready on this computer'],
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

export function localizeSentence(text) {
  if (typeof text !== 'string' || !TRIGGER.test(text)) return text
  let out = text
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement)
  return out.replace(/\s+([.,;:])/g, '$1').replace(/\s{2,}/g, ' ').trim()
}

// A JSON answer with its sentences localized; every other value is returned as it was.
export function localizeResponse(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => localizeResponse(item, depth + 1))
  const out = {}
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SENTENCE_KEYS.includes(key) && typeof inner === 'string' ? localizeSentence(inner) : localizeResponse(inner, depth + 1)
  }
  return out
}
