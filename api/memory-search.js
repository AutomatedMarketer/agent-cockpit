// POST /api/memory-search { q }: the notes closest in meaning to the words of a search, from the index
// api/memory-index.js learned (api/_memory-meaning.js). The page asks it on Enter or after a short pause,
// never on every key; voice asks it through the same page code.
//
// The answer is paths and similarities only - never a vector, which is a blurred copy of a note. It
// spends a little of the owner's money (one OpenAI call per new search), so it is held to the write gate
// like every other spend, and off unless switched on. Every answer, refusals included, is kept by nobody.

import { writeGate } from './_gate.js'
import { readJsonBody } from './_lib.js'
import { pictureStore } from './_picture-store.js'
import { meaningConfig, searchByMeaning, cleanQuery, meaningFailure, MEANING_SAY, SEARCH_SAY } from './_memory-meaning.js'

export function makeHandler({ store, env, now = () => Date.now(), loadSdk } = {}) {
  return async function handler(request, response) {
    response.setHeader('Cache-Control', 'private, no-store')
    if (String(request?.method ?? 'GET').toUpperCase() !== 'POST') {
      response.setHeader('Allow', 'POST')
      response.status(405).json({ error: 'POST { "q": "<the words of a search>" }.' })
      return
    }
    const environment = env ?? process.env
    const pictures = store !== undefined ? store : pictureStore(environment, loadSdk)
    const denied = await writeGate(request, environment, 'application/json', { store: pictures })
    if (denied) {
      const { status, ...answer } = denied
      response.status(status).json(answer)
      return
    }
    const meaning = meaningConfig(environment)
    if (!meaning.on || !pictures) {
      response.status(200).json({ on: false, why: meaning.why ?? MEANING_SAY.noStore })
      return
    }
    const words = cleanQuery(readJsonBody(request)?.q)
    if (!words) {
      response.status(400).json({ on: true, error: SEARCH_SAY.badQuery })
      return
    }
    try {
      response.status(200).json(await searchByMeaning({ store: pictures, env: environment, words, now: now() }))
    } catch (error) {
      const { status, retryAfter, body } = meaningFailure(error)
      if (retryAfter) response.setHeader('Retry-After', String(retryAfter))
      response.status(status).json(body)
    }
  }
}

export default makeHandler()
