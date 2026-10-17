// Wording on a student's computer: no sentence the board can say tells them to set something "in Vercel" or to
// "redeploy". The website's sentences stay exactly as they are; the local server turns them into local ones.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { request as httpRequest } from 'node:http'
import { localizeSentence, localizeResponse, SENTENCE_KEYS } from '../local/localize.mjs'
import { startLocalBoard, startBoardServer } from '../local/server.mjs'
import { NO_VOICE_KEY } from '../api/_voice.js'
import brandHandler from '../api/brand.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const WEBSITE_WORDS = /Vercel|redeploy|hosting environment|env var\b/i
const FISH_SENTENCE = 'Fish did not accept FISH_API_KEY, so check the key in Vercel and redeploy.'
const OPENAI_SENTENCE = 'OpenAI did not accept OPENAI_API_KEY, so check the key in Vercel and redeploy.'

// ---- every sentence the API can say ---------------------------------------------------------------------------

// Every quoted piece of text in the API's source that holds one of the website's words (a sentence split over
// several lines is several pieces; each piece alone is enough to catch a leftover word).
function pieces(source) {
  const found = []
  let current = null
  let previousEnd = -1
  const flush = () => {
    // a package name such as '@vercel/blob' is code, not a sentence
    if (current !== null && WEBSITE_WORDS.test(current) && !current.startsWith('@')) found.push(current)
    current = null
  }
  for (const match of source.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
    const text = (match[1] ?? match[2] ?? match[3]).replace(/\\(.)/g, '$1').replace(/\$\{[^}]*\}/g, 'X')
    // 'a long sentence ' + newline + 'written over two lines' is one sentence
    const joined = current !== null && /^\s*\+\s*$/.test(source.slice(previousEnd, match.index))
    if (joined) current += text
    else { flush(); current = text }
    previousEnd = match.index + match[0].length
  }
  flush()
  return found
}

test('every sentence in the API that mentions Vercel, redeploying or the hosting environment comes out without those words', () => {
  let count = 0
  const left = []
  for (const name of readdirSync(join(ROOT, 'api')).filter((file) => file.endsWith('.js'))) {
    for (const text of pieces(readFileSync(join(ROOT, 'api', name), 'utf8'))) {
      count += 1
      const local = localizeSentence(text)
      if (WEBSITE_WORDS.test(local) || local.length <= 10) left.push(`api/${name}: ${text}`)
    }
  }
  assert.deepEqual(left, [], "sentences still telling a student to use Vercel or redeploy")
  assert.ok(count > 25, `only ${count} sentences were found: the scan is looking at less than the API says`)
})

test('the sentences a student is likely to meet are put in plain local words', () => {
  const cases = [
    [NO_VOICE_KEY, /paste one in Settings/],
    ['Making pictures from words is off: set OPENAI_API_KEY in Vercel (the same key the voice assistant uses) and redeploy. Choosing your own picture still works.', /paste an OpenAI key in Settings \(the same key the voice assistant uses\)\. Choosing your own picture still works\./],
    ['Search by meaning needs OPENAI_API_KEY: set it in Vercel (the same key the voice assistant uses) and redeploy.', /needs an OpenAI key: paste one in Settings/],
    ['OpenAI did not accept OPENAI_API_KEY for voice, so check the key (and that its project can use the realtime models) in Vercel and redeploy.', /check the key in Settings \(and that its project can use the realtime models\)/],
    ['OpenAI did not accept OPENAI_API_KEY, so check the key in Vercel and redeploy.', /^OpenAI did not accept the key, so check the key in Settings\.$/],
    ['Fish did not accept FISH_API_KEY, so check the key in Vercel and redeploy.', /check it in Settings/],
    ['Fish is not set up on this board, so its replies are spoken with OpenAI\'s voice: set FISH_API_KEY and FISH_VOICE_ID in Vercel to use your own.', /paste a Fish key in Settings/],
    ['Set GITHUB_OWNER and GITHUB_REPO in your hosting environment.', /board\.json/],
    ['No picture store is connected: in Vercel, create a Private Blob store for this project, then redeploy.', /pictures folder/]
  ]
  for (const [text, want] of cases) {
    const local = localizeSentence(text)
    assert.match(local, want, `"${text}" -> "${local}"`)
    assert.doesNotMatch(local, WEBSITE_WORDS)
  }
})

test('a sentence without the website\'s words is left alone, and so is everything that is not a sentence for the person', () => {
  assert.equal(localizeSentence('Two things are due today.'), 'Two things are due today.')
  assert.equal(localizeSentence(5), 5)
  const payload = {
    error: FISH_SENTENCE,
    tasks: [{ title: 'Move the site to Vercel and redeploy', note: 'redeploy on Friday', detail: 'in your hosting environment' }],
    nested: { why: OPENAI_SENTENCE, content: 'the README says redeploy' },
    // The team's own words, under the very keys the board's sentences use: never rewritten.
    team: { error: 'Vercel build failed: redeploy', why: 'Vercel is cheaper', note: 'Move the site to Vercel and redeploy', say: 'ask Priya whether we still need Vercel; if not, redeploy the site elsewhere' },
    voice: { on: false, why: NO_VOICE_KEY, note: '' },
    count: 3
  }
  const out = localizeResponse(payload)
  assert.doesNotMatch(out.error, WEBSITE_WORDS)
  assert.doesNotMatch(out.nested.why, WEBSITE_WORDS)
  assert.doesNotMatch(out.voice.why, WEBSITE_WORDS)
  assert.equal(out.tasks[0].title, 'Move the site to Vercel and redeploy', 'the team\'s own words were rewritten')
  assert.equal(out.tasks[0].detail, 'in your hosting environment')
  assert.equal(out.nested.content, 'the README says redeploy')
  assert.equal(out.count, 3)
  assert.deepEqual(out.team, payload.team, 'the team\'s words under error/why/note/say were rewritten')
  assert.equal(payload.error, FISH_SENTENCE, 'the original was changed instead of copied')
  assert.deepEqual([...SENTENCE_KEYS], ['error', 'why', 'note', 'say'])
})

// ---- through the real local board; and the website unchanged ------------------------------------------------

function raw(port, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

const TEAM_TASK = 'Move the site to Vercel and redeploy'
const WEBSITE_SENTENCE = FISH_SENTENCE

async function withBoard(run, { local }) {
  const saved = Object.fromEntries(['VIEW_KEY', 'PUBLIC_FIRE', 'PUBLIC_DASHBOARD', 'EDIT_KEY', 'BOARD_PASSWORD', 'BOARD_USERNAME', 'OPENAI_API_KEY'].map((key) => [key, process.env[key]]))
  delete process.env.OPENAI_API_KEY
  if (!local) process.env.PUBLIC_DASHBOARD = 'true'
  const dir = mkdtempSync(join(tmpdir(), 'board-wording-'))
  const handlers = {
    brand: brandHandler,
    state: (request, response) => response.status(200).json({ error: WEBSITE_SENTENCE, tasks: [{ title: TEAM_TASK, note: 'redeploy on Friday' }] })
  }
  const loadHandler = async (name) => handlers[name]
  const board = local
    ? await startLocalBoard({ port: 0, settingsFile: join(dir, 'settings.json'), loadHandler })
    : await startBoardServer({ port: 0, loadHandler })
  try {
    await run(board)
  } finally {
    await new Promise((resolve) => { board.server.close(resolve); board.server.closeAllConnections?.() })
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the local board says "paste an OpenAI key in Settings"; the team\'s own words are left as they were', async () => {
  await withBoard(async (board) => {
    const link = new URL(board.openLink())
    const opened = await raw(board.port, link.pathname + link.search, 'GET', { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' })
    const auth = { Cookie: String(opened.headers['set-cookie']).split(';')[0], 'x-board-token': /name="board-token" content="([\w-]+)"/.exec(opened.text)[1] }
    const brand = JSON.parse((await raw(board.port, '/api/brand', 'GET', auth)).text)
    assert.match(brand.voice.why, /Settings/)
    assert.doesNotMatch(JSON.stringify(brand), WEBSITE_WORDS)
    const state = JSON.parse((await raw(board.port, '/api/state', 'GET', auth)).text)
    assert.doesNotMatch(state.error, WEBSITE_WORDS)
    assert.equal(state.tasks[0].title, TEAM_TASK, 'a task title from the team\'s repo was rewritten')
  }, { local: true })
})

test('the website is unchanged: the same handlers, served by the plain server, still say Vercel', async () => {
  await withBoard(async (board) => {
    const brand = (await raw(board.port, '/api/brand', 'GET', {})).text
    assert.match(brand, /Vercel/)
    delete process.env.PUBLIC_DASHBOARD
    assert.match((await raw(board.port, '/api/brand', 'GET', {})).text, /hosting environment and redeploy/, 'the website refusal wording changed')
    process.env.PUBLIC_DASHBOARD = 'true'
    assert.match((await raw(board.port, '/api/state', 'GET', {})).text, /Fish did not accept FISH_API_KEY, so check the key in Vercel and redeploy\./)
  }, { local: false })
})
