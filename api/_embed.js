// The one OpenAI call meaning search makes: texts in, one vector each out. Starts with "_" so Vercel does
// not turn it into an endpoint. Used by api/memory-index.js (a note's text, to learn it) and
// api/memory-search.js (the words of a search).
//
// Like api/generate.js: the key goes to OpenAI in one header and nowhere else, nothing OpenAI sends back
// is passed on as text - every failure is one of the sentences below - and nothing here writes a log.
// What OpenAI keeps: /v1/embeddings data is not used for training, and sits in its abuse-monitoring logs
// for up to 30 days (OpenAI's "Your data" guide, read 2026-10-11). The README says so.

import { MEANING } from './_memory-index.js'

const ENDPOINT = 'https://api.openai.com/v1/embeddings'

// OpenAI's limits per request (API reference, embeddings create, read 2026-10-11): 2,048 texts and
// 300,000 tokens. Tokens are counted here at 3 characters each - OpenAI's rule of thumb is 4 - so an
// estimate stays under the real count. A call that hangs is cut off after 20 seconds.
export const EMBED = { texts: 2048, tokens: 300_000, charsPerToken: 3, timeoutMs: 20_000 }

export const estimateTokens = (text) => Math.ceil(String(text ?? '').length / EMBED.charsPerToken)

// How long OpenAI's rate limit may ask the board to wait, in seconds.
const WAIT = { least: 1, most: 3600, unsaid: 20 }

export const EMBED_SAY = {
  key: 'OpenAI did not accept OPENAI_API_KEY, so meaning search is paused: check the key in Vercel and redeploy.',
  spent: 'OpenAI says this key has reached its spend limit or run out of credit, so meaning search is paused: check your OpenAI account.',
  busy: (seconds) => `OpenAI asked the board to slow down, so meaning search carries on in ${seconds} seconds.`,
  slow: 'OpenAI took too long to answer, so try again.',
  failed: 'OpenAI could not be reached just now, so meaning search is paused: try again in a minute.',
  odd: 'OpenAI sent back something the board did not expect, so try again.'
}

// A refusal as the board says it. `tokens` is what was already paid for before it, so a step that fails
// half way still counts its spend; `retryAfter` is OpenAI's wait, in seconds, when it gave one.
export class EmbedError extends Error {
  constructor(status, sentence, { retryAfter, tokens = 0 } = {}) {
    super(sentence)
    this.name = 'EmbedError'
    this.status = status
    this.tokens = tokens
    if (retryAfter !== undefined) this.retryAfter = retryAfter
  }
}

// Texts in groups OpenAI accepts, in the order given.
export function batchesOf(texts) {
  const batches = []
  let current = []
  let tokens = 0
  for (const text of texts) {
    const cost = estimateTokens(text)
    if (current.length && (current.length >= EMBED.texts || tokens + cost > EMBED.tokens)) {
      batches.push(current)
      current = []
      tokens = 0
    }
    current.push(text)
    tokens += cost
  }
  if (current.length) batches.push(current)
  return batches
}

const timedOut = (error) => error?.name === 'TimeoutError' || error?.name === 'AbortError'

function waitOf(response) {
  const seconds = Number(response.headers.get('retry-after'))
  const fromMs = Number(response.headers.get('retry-after-ms')) / 1000
  const said = Number.isFinite(seconds) && seconds > 0 ? seconds : Number.isFinite(fromMs) && fromMs > 0 ? fromMs : WAIT.unsaid
  return Math.min(WAIT.most, Math.max(WAIT.least, Math.ceil(said)))
}

// OpenAI's error answer is read only to tell its spend limit from its rate limit, never repeated.
async function refusalOf(response, tokens) {
  if (response.status === 401 || response.status === 403) return new EmbedError(502, EMBED_SAY.key, { tokens })
  if (response.status === 429) {
    let detail = {}
    try {
      detail = (await response.json())?.error ?? {}
    } catch {
      detail = {}
    }
    if (detail?.code === 'insufficient_quota' || detail?.type === 'insufficient_quota') return new EmbedError(429, EMBED_SAY.spent, { tokens })
    const wait = waitOf(response)
    return new EmbedError(429, EMBED_SAY.busy(wait), { retryAfter: wait, tokens })
  }
  return new EmbedError(502, EMBED_SAY.failed, { tokens })
}

// One vector out of OpenAI's base64 (little-endian 32-bit numbers), or null when it is not one.
function vectorOf(embedding) {
  let values = null
  if (typeof embedding === 'string') {
    const bytes = Buffer.from(embedding, 'base64')
    if (bytes.length !== MEANING.dimensions * 4) return null
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length)
    values = Float32Array.from({ length: MEANING.dimensions }, (_, at) => view.getFloat32(at * 4, true))
  } else if (Array.isArray(embedding) && embedding.length === MEANING.dimensions) {
    values = Float32Array.from(embedding)
  }
  return values && values.every(Number.isFinite) ? values : null
}

function vectorsOf(answer, count) {
  const data = answer?.data
  if (!Array.isArray(data) || data.length !== count) return null
  const vectors = new Array(count)
  for (const item of data) {
    const at = item?.index
    if (!Number.isInteger(at) || at < 0 || at >= count || vectors[at]) return null
    const vector = vectorOf(item.embedding)
    if (!vector) return null
    vectors[at] = vector
  }
  return vectors
}

// { vectors, tokens }: one vector a text, in the order given, and the tokens OpenAI counted. Throws an
// EmbedError, carrying the tokens already spent, when any batch fails; nothing is kept from a call that
// did not finish.
export async function embedTexts(texts, { apiKey, fetchImpl = globalThis.fetch, timeoutMs = EMBED.timeoutMs } = {}) {
  const vectors = []
  let tokens = 0
  for (const batch of batchesOf(texts)) {
    let response
    try {
      response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MEANING.model, input: batch, dimensions: MEANING.dimensions, encoding_format: 'base64' }),
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (error) {
      // The error's own message is not looked at: it can carry whatever the request carried.
      throw timedOut(error) ? new EmbedError(504, EMBED_SAY.slow, { tokens }) : new EmbedError(502, EMBED_SAY.failed, { tokens })
    }
    if (!response.ok) throw await refusalOf(response, tokens)
    let answer
    try {
      answer = await response.json()
    } catch (error) {
      throw timedOut(error) ? new EmbedError(504, EMBED_SAY.slow, { tokens }) : new EmbedError(502, EMBED_SAY.odd, { tokens })
    }
    const counted = answer?.usage?.total_tokens
    tokens += Number.isSafeInteger(counted) && counted >= 0 ? counted : batch.reduce((sum, text) => sum + estimateTokens(text), 0)
    const got = vectorsOf(answer, batch.length)
    if (!got) throw new EmbedError(502, EMBED_SAY.odd, { tokens })
    vectors.push(...got)
  }
  return { vectors, tokens }
}
