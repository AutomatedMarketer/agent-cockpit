// A real browser follows the starter's launcher file to the board, and later arrives from another
// site. Headless Chrome, a throwaway profile, no new dependency. Skipped (with the reason) where
// Chrome is not installed.
//
// Why this exists: Chrome counts the chain file:// -> /open-board -> / as cross-site, so a 303 sent
// the browser on WITHOUT the new SameSite=Strict cookie, the board refused it, and the one-time link
// was already used up. Only a real browser shows that - and shows whether a #fragment survives the
// hop that a visit from another site goes through, and what the page does in local mode.
//
// One browser session does it all (a session cookie does not outlive the browser): the board page the
// link lands on leaves for "another site" after a moment (a small script this test adds to a COPY of
// public/), and that site sends the browser straight back to the board at /#readiness.

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runStart } from '../local/start.mjs'
import { basePayload } from './helpers/page-payload.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

function findChrome(env = process.env, platform = process.platform) {
  const candidates = [
    env.CHROME_PATH,
    platform === 'win32' && env.ProgramFiles && join(env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    platform === 'win32' && env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    platform === 'win32' && env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    platform === 'darwin' && '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    platform === 'linux' && '/usr/bin/google-chrome',
    platform === 'linux' && '/usr/bin/chromium'
  ]
  return candidates.find((path) => path && existsSync(path)) ?? null
}
const CHROME = findChrome()

const ENV_KEYS = ['VIEW_KEY', 'PUBLIC_FIRE', 'PUBLIC_DASHBOARD', 'EDIT_KEY', 'BOARD_PASSWORD', 'BOARD_USERNAME', 'REPO_SOURCE', 'REPO_FOLDER', 'PICTURE_STORE', 'PICTURE_FOLDER']

// Runs the whole journey once and hands back what the board saw and what Chrome ended on. Shared by the
// tests below so Chrome starts once.
let journey = null
async function runJourney() {
  if (journey) return journey
  // Chrome's virtual clock sometimes runs a page's timer before its network has caught up; a journey
  // that did not get all the way round is simply run again (fresh board, fresh link, fresh profile).
  let last
  for (let attempt = 0; attempt < 3; attempt += 1) {
    last = await runJourneyOnce()
    if (last.seen.some((entry) => entry.path === '/report')) break
  }
  journey = last
  return journey
}

async function runJourneyOnce() {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  const home = mkdtempSync(join(tmpdir(), 'board-chrome-'))
  const profile = join(home, 'chrome-profile')
  const boardRoot = join(home, 'board')
  const seen = []
  let dom = ''
  let result
  let boardPort
  const other = createServer((request, response) => {
    seen.push({ path: 'OTHER-SITE ' + request.url, status: 200 })
    response.setHeader('Content-Type', 'text/html')
    response.end(`<!doctype html><p>a page on another site</p><meta http-equiv="refresh" content="0;url=http://127.0.0.1:${boardPort}/#readiness">`)
  })
  await new Promise((done) => other.listen(0, '127.0.0.1', done))
  try {
    // A COPY of the page folder that, once, sends the browser away to the other site and back.
    cpSync(join(ROOT, 'public'), join(boardRoot, 'public'), { recursive: true })
    writeFileSync(join(boardRoot, 'vercel.json'), readFileSync(join(ROOT, 'vercel.json')))
    // On the first visit it leaves for the other site; on the return visit (it has a #fragment) it reports what
    // the page shows - Chrome's own dump of the page is not reliable across several navigations.
    writeFileSync(join(boardRoot, 'public', 'leave.js'), [
      "if (location.hash === '') setTimeout(function () { location.href = 'http://localhost:" + other.address().port + "/' }, 1200)",
      "else setTimeout(function () { fetch('/report?hash=' + encodeURIComponent(location.hash) + '&active=' + encodeURIComponent((document.getElementById('readiness') || {}).className || '') + '&title=' + encodeURIComponent(document.title)) }, 2500)",
      ''
    ].join(String.fromCharCode(10)))
    const index = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8')
    assert.ok(index.includes('<script src="/app.js"></script>'))
    writeFileSync(join(boardRoot, 'public', 'index.html'), index.replace('<script src="/app.js"></script>', '<script src="/app.js"></script><script src="/leave.js"></script>'))

    result = await runStart({
      platform: process.platform,
      env: { ...process.env },
      home,
      stateDir: join(home, 'state'),
      basePort: 20000 + Math.floor(Math.random() * 8000),
      lingerMs: 20,
      log: () => {},
      // The "browser" is real Chrome, given the launcher FILE exactly as the operating system would.
      openFile: async (file) => {
        dom = await new Promise((resolve) => {
          execFile(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--virtual-time-budget=20000', '--dump-dom', `file:///${file.replace(/\\/g, '/')}`],
            { timeout: 90000 }, (error, stdout) => resolve(String(stdout ?? '')))
        })
      },
      startBoard: async (options) => {
        const { startLocalBoard } = await import('../local/server.mjs')
        // The team's data is not what this test is about: /api/state answers a plain, valid board so the page can draw.
        const stateStub = (request, response) => response.status(200).json(basePayload())
        const loadHandler = async (name) => (name === 'state' ? stateStub : (await import(`../api/${name}.js`)).default)
        const board = await startLocalBoard({ ...options, root: boardRoot, loadHandler })
        boardPort = board.port
        board.server.prependListener('request', (request, response) => {
          response.on('finish', () => seen.push({ status: response.statusCode, method: request.method, path: request.url.split('?')[0], query: request.url.includes('?') ? request.url.split('?')[1] : '', site: request.headers['sec-fetch-site'], cookie: Boolean(request.headers.cookie), token: Boolean(request.headers['x-board-token']) }))
        })
        return board
      }
    })
    return { seen, dom, title: /<title>([^<]+)<\/title>/.exec(readFileSync(join(ROOT, 'public', 'index.html'), 'utf8'))?.[1] }
  } finally {
    other.close()
    await result?.close?.()
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    rmSync(home, { recursive: true, force: true })
  }
}

const skip = CHROME ? false : 'Chrome is not installed here (set CHROME_PATH to run this)'

test('real Chrome: the launcher file leads to the board signed in, and the link is spent only once', { skip, timeout: 170000 }, async () => {
  const { seen, dom, title } = await runJourney()
  const open = seen.find((entry) => entry.path === '/open-board')
  assert.ok(open, `Chrome never reached the link: ${JSON.stringify(seen)}`)
  assert.equal(open.status, 200, 'the link must answer with a page that moves on, not a redirect')
  assert.equal(seen.filter((entry) => entry.path === '/open-board').length, 1, 'the one-time link was used more than once')
  const firstLanding = seen.find((entry) => entry.path === '/' && entry.site === 'same-origin')
  assert.ok(firstLanding, `Chrome never reached the board page: ${JSON.stringify(seen)}`)
  assert.equal(firstLanding.status, 200)
  assert.equal(firstLanding.cookie, true, 'the browser arrived without its cookie')
  assert.ok(title)
})

test('real Chrome: arriving from another site shows the board (not the refusal), and keeps the #fragment', { skip, timeout: 170000 }, async () => {
  const { seen, dom, title } = await runJourney()
  const hop = seen.findIndex((entry) => entry.path === '/' && entry.site === 'cross-site')
  assert.ok(hop >= 0, `Chrome never arrived from the other site: ${JSON.stringify(seen)}`)
  assert.equal(seen[hop].status, 200, 'the visit from another site was refused')
  assert.ok(seen.slice(hop).some((entry) => entry.path === '/hop.js' && entry.status === 200), 'the hop page\'s script never ran')
  const after = seen.slice(hop + 1).filter((entry) => entry.path === '/' && entry.site === 'same-origin')
  assert.ok(after.length >= 1, `the hop never came back to the board: ${JSON.stringify(seen)}`)
  assert.equal(after.at(-1).status, 200)
  assert.equal(after.at(-1).cookie, true)
  const report = seen.find((entry) => entry.path === '/report')
  assert.ok(report, `the board page never reported (it did not load after arriving): ${JSON.stringify(seen)}`)
  const said = new URLSearchParams(report.query)
  assert.equal(said.get('hash'), '#readiness', 'the #fragment was lost on the way')
  assert.match(said.get('active'), /\bactive\b/, `the Readiness screen is not the one shown: ${report.query}`)
  assert.ok(said.get('title').length > 0)
  assert.ok(!dom.includes('That did not come from the board'), 'the refusal text was shown to the student')
})
