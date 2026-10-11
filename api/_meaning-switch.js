// Whether memory search by meaning is on, and if not, why - in one sentence the page can show. Its own
// small file so /api/brand can say it without loading the search itself (api/_memory-meaning.js).
// Starts with "_" so Vercel does not turn it into an endpoint.

import { storeConnected } from './_picture-store.js'

export const MEANING_SAY = {
  off: 'Search by meaning is off on this board. To switch it on, set MEMORY_MEANING to on in Vercel and redeploy: ' +
    'the text of each note the board can open then goes to OpenAI, once, so it can be found by meaning.',
  noKey: 'Search by meaning needs OPENAI_API_KEY: set it in Vercel (the same key the voice assistant uses) and redeploy.',
  noStore: 'Search by meaning needs the picture store, so the board can keep what it learned: in Vercel, create a ' +
    'Private Blob store for this project, then redeploy.',
  openBoard: 'Search by meaning is off because this board is open to everyone: set EDIT_KEY in Vercel and redeploy to switch it on.',
  storeDown: 'The picture store could not be read, so search by meaning is paused: try again in a minute.',
  github: 'Something went wrong reading your team repo, so search by meaning is paused: try again in a minute.'
}

// On only when switched on, with a key and a store to keep what it learns - and never on a board open to
// everyone without an edit key, where nobody may spend the owner's money (the write gate says the same).
export function meaningConfig(env = process.env) {
  if (String(env.MEMORY_MEANING ?? '').trim().toLowerCase() !== 'on') return { on: false, why: MEANING_SAY.off }
  if (env.PUBLIC_DASHBOARD === 'true' && !env.EDIT_KEY) return { on: false, why: MEANING_SAY.openBoard }
  if (!env.OPENAI_API_KEY) return { on: false, why: MEANING_SAY.noKey }
  if (!storeConnected(env)) return { on: false, why: MEANING_SAY.noStore }
  return { on: true }
}
