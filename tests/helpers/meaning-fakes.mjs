// What the meaning-search endpoint tests share: a fake GitHub (the head commit, the tree with each
// file's fingerprint, a note read by its fingerprint), a fake OpenAI whose vectors come from the words
// of each text (texts sharing words are close), and the board's environment. Both fakes stand in for
// globalThis.fetch and record every call; nothing reaches the network, and no real key is used.

import { createHash } from 'node:crypto'
import { MEANING } from '../../api/_memory-index.js'
import { forgetMeaning } from '../../api/_memory-meaning.js'
import { STORE_ENV, connectedStore } from './personalise-harness.mjs'

export const OPENAI_KEY = 'sk-test-meaningKeyThatMustNeverLeave'
export const ENV = { ...STORE_ENV, OPENAI_API_KEY: OPENAI_KEY, MEMORY_MEANING: 'on' }
export const HEAD = 'c'.repeat(40)
export const NEWER = 'd'.repeat(40)
export const GITHUB_ENV = { GITHUB_OWNER: 'someone', GITHUB_REPO: 'my-agent-team', GITHUB_TOKEN: 'ghp_fakeTokenForTests' }

export const shaOf = (text) => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0${text}`).digest('hex')

// A vector from the words of a text: each word adds to one axis. Unit length, as OpenAI's are.
export function wordsVector(text) {
  const values = new Float32Array(MEANING.dimensions)
  for (const word of String(text).toLowerCase().split(/[^a-z0-9]+/).filter((one) => one.length > 2)) {
    const axis = createHash('md5').update(word).digest().readUInt16LE(0) % MEANING.dimensions
    values[axis] += 1
  }
  const length = Math.hypot(...values) || 1
  return values.map((value) => value / length)
}
const base64Of = (values) => Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString('base64')

// `files`: path -> text. `sizes` overrides a size the tree reports. `openai(body, n)` may answer in its
// own way (a refusal); otherwise every text gets its words vector.
export function stubFetch({ files = {}, head = HEAD, sizes = {}, openai = null, githubDown = false } = {}) {
  const calls = { head: [], tree: [], blob: [], openai: [], other: [] }
  const bySha = new Map(Object.entries(files).map(([path, text]) => [shaOf(text), text]))
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url)
    if (target.startsWith('https://api.openai.com/')) {
      const body = JSON.parse(init.body)
      calls.openai.push({ url: target, init, body })
      if (openai) {
        const answer = await openai(body, calls.openai.length)
        if (answer) return answer
      }
      return Response.json({
        data: body.input.map((text, index) => ({ index, embedding: base64Of(wordsVector(text)) })),
        usage: { total_tokens: body.input.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0) }
      })
    }
    if (githubDown) return new Response('down', { status: 503 })
    if (target.includes('/commits/')) {
      calls.head.push(target)
      return head === null ? new Response('Not Found', { status: 404 }) : new Response(head, { status: 200 })
    }
    if (target.includes('/git/trees/')) {
      calls.tree.push(target)
      return Response.json({
        tree: [
          ...Object.entries(files).map(([path, text]) => ({ type: 'blob', path, sha: shaOf(text), size: sizes[path] ?? Buffer.byteLength(text) })),
          { type: 'tree', path: 'shared', sha: 'e'.repeat(40) }
        ]
      })
    }
    const blob = /\/git\/blobs\/([0-9a-f]{40})$/.exec(target)
    if (blob) {
      calls.blob.push({ sha: blob[1], accept: init.headers?.Accept, auth: init.headers?.Authorization })
      const text = bySha.get(blob[1])
      return text === undefined ? new Response('Not Found', { status: 404 }) : new Response(text, { status: 200 })
    }
    calls.other.push(target)
    return new Response('Not Found', { status: 404 })
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

// One test's world: GitHub's settings in process.env (the board reads them there), a connected
// in-memory store, this instance's meaning state forgotten, and everything put back afterwards.
export function meaningWorld(t, { env = ENV, store: withStore = true } = {}) {
  forgetMeaning()
  const previous = { ...process.env }
  Object.assign(process.env, GITHUB_ENV)
  const connected = connectedStore(env)
  t.after(() => {
    process.env = previous
    forgetMeaning()
  })
  return { env, store: withStore ? connected.store : null, fake: connected.fake }
}

export const blobCalls = (fake) => fake.calls.get.length + fake.calls.put.length + fake.calls.del.length + fake.calls.list.length + fake.calls.head.length

// Notes as GitHub would hold them, named n/000.md ... with some words in each.
export const manyNotes = (count, words = (at) => `note number ${at} about topic${at % 7}`) =>
  Object.fromEntries(Array.from({ length: count }, (_, at) => [`n/${String(at).padStart(3, '0')}.md`, `# Note ${at}\n${words(at)}\n`]))
