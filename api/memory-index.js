// POST /api/memory-index: one step of learning the team notes by meaning (api/_memory-meaning.js).
// The page calls it while Memory is open and the board has a commit the index has not learned yet;
// each step learns at most 200 changed notes, and says how many are left.
//
// It spends the owner's money (OpenAI) and the picture store's writes, so it is held to the write gate
// before anything else - a caller without the key costs no GitHub, OpenAI or store call - and it is off
// unless the owner switched it on. Every answer, refusals included, is kept by nobody.

import { writeGate } from './_gate.js'
import { pictureStore } from './_picture-store.js'
import { meaningConfig, learnStep, meaningIndexed, meaningFailure, MEANING_SAY } from './_memory-meaning.js'

export function makeHandler({ store, env, now = () => Date.now(), loadSdk } = {}) {
  return async function handler(request, response) {
    response.setHeader('Cache-Control', 'private, no-store')
    if (String(request?.method ?? 'GET').toUpperCase() !== 'POST') {
      response.setHeader('Allow', 'POST')
      response.status(405).json({ error: 'POST {} to learn the next notes by meaning.' })
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
    try {
      response.status(200).json(await learnStep({ store: pictures, env: environment, now: now() }))
    } catch (error) {
      const { status, retryAfter, body } = meaningFailure(error)
      if (retryAfter) response.setHeader('Retry-After', String(retryAfter))
      response.status(status).json({ ...body, indexed: meaningIndexed() })
    }
  }
}

export default makeHandler()
