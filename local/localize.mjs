// The board's own sentences were written for the website: "set OPENAI_API_KEY in Vercel and redeploy". On a
// student's computer there is no Vercel and nothing to redeploy: the key is pasted in Settings. This turns the
// sentences the board's API can say into local ones, on their way out of the local server only (the API files,
// and so the website, are not touched).
//
// Only the keys that carry a sentence meant for the person - error, why, note, say - are looked at, and only
// a string that really holds one of the website's words is changed, so nothing from the team's own repo (a
// task called "Move the site to Vercel") is ever rewritten.

const TRIGGER = /Vercel|redeploy|hosting environment|env var\b/i
export const SENTENCE_KEYS = Object.freeze(['error', 'why', 'note', 'say'])

// Word for word where the sentence is one the student is likely to meet; the plainest words that are still
// true for the rest. Order matters: the specific ones go first.
const RULES = [
  // OpenAI key: voice, pictures, meaning search
  [/set OPENAI_API_KEY in Vercel( \([^)]*\))? and redeploy/g, 'paste an OpenAI key in Settings$1'],
  [/set it in Vercel( \([^)]*\))? and redeploy/g, 'paste an OpenAI key in Settings$1'],
  [/Talking to the board needs OPENAI_API_KEY: paste an OpenAI key in Settings/g, 'Talking to the board needs an OpenAI key: paste one in Settings'],
  [/needs OPENAI_API_KEY: paste an OpenAI key in Settings/g, 'needs an OpenAI key: paste one in Settings'],
  [/needs OPENAI_API_KEY/g, 'needs an OpenAI key (paste one in Settings)'],
  [/OpenAI did not accept OPENAI_API_KEY for voice, so check the key \(and that its project can use the realtime models\) in Vercel and redeploy/g, 'OpenAI did not accept the key for voice, so check the key in Settings (and that its project can use the realtime models)'],
  [/OpenAI did not accept OPENAI_API_KEY, so (?:check|meaning search is paused: check) the key in Vercel and redeploy/g, (match) => (match.includes('paused') ? 'OpenAI did not accept the key, so meaning search is paused: check the key in Settings' : 'OpenAI did not accept the key, so check the key in Settings')],
  // Fish
  [/set FISH_API_KEY and FISH_VOICE_ID in Vercel to use your own/g, 'paste a Fish key in Settings to use your own'],
  [/Fish did not accept FISH_API_KEY, so check the key in Vercel and redeploy/g, 'Fish did not accept the key, so check it in Settings'],
  // The team repo and the picture store are set up by Start Board on a student's computer
  [/Set GITHUB_OWNER and GITHUB_REPO in your hosting environment(?:, then redeploy)?\.?/g, 'The board could not find your team folder. Check board.json next to Start Board, then double-click Start Board again.'],
  [/No picture store is connected: in Vercel, create a Private Blob store for this project, then redeploy\./g, 'The board could not use its pictures folder. Look in the Start Board window for the reason.'],
  // Anything that is the website's own business (sign-in keys, routines, the fire key)
  [/(?:Set|Add|Fix)[^.]*?(?:in|to) (?:your |the )?hosting environment[^.]*?(?:then |and )?redeploy\.?/g, 'This is not set up on this computer yet.'],
  [/[^.]*FIRE_TRIGGERS[^.]*redeploy\.?/g, 'Routines are not set up on this computer yet.'],
  // Whatever is left of the website's words
  [/in (?:your |the )?hosting environment/gi, "in the board's settings"],
  [/in Vercel(?:'s Storage tab)?/gi, "in the board's settings"],
  [/Vercel's/g, "the host's"],
  [/,? ?(?:and |then )?redeploy( it)?\b/gi, ''],
  [/\benv var\b/gi, 'setting']
]

export function localizeSentence(text) {
  if (typeof text !== 'string' || !TRIGGER.test(text)) return text
  let out = text
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement)
  // The guarantee: none of the website's words are left. Anything the rules above did not reach is said plainly.
  if (TRIGGER.test(out)) out = 'This part of the board is not set up on this computer yet. Look in Settings, or ask for help.'
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
