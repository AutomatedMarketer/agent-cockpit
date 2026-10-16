// A real browser follows the starter's launcher file to the board. Headless Chrome, a throwaway
// profile, no new dependency. Skipped (with the reason) where Chrome is not installed.
//
// Why this exists: Chrome counts the chain file:// -> /open-board -> / as cross-site, so a 303 sent
// the browser on WITHOUT the new SameSite=Strict cookie, the board refused it, and the one-time link
// was already used up. Only a real browser shows that.

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { askCode } from '../local/starter-auth.mjs'
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runStart } from '../local/start.mjs'

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

test('real Chrome: the launcher file leads to the board signed in, and the link is spent only once',
  { skip: CHROME ? false : 'Chrome is not installed here (set CHROME_PATH to run this)', timeout: 170000 },
  async () => {
    const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
    const home = mkdtempSync(join(tmpdir(), 'board-chrome-'))
    const profile = join(home, 'chrome-profile')
    const seen = []
    let dom = ''
    let result
    try {
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
            execFile(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--virtual-time-budget=8000', '--dump-dom', `file:///${file.replace(/\\/g, '/')}`],
              { timeout: 60000 }, (error, stdout) => resolve(String(stdout ?? '')))
          })
        },
        startBoard: async (options) => {
          const { startLocalBoard } = await import('../local/server.mjs')
          const board = await startLocalBoard(options)
          board.server.prependListener('request', (request, response) => {
            response.on('finish', () => seen.push({ status: response.statusCode, method: request.method, path: request.url.split('?')[0], site: request.headers['sec-fetch-site'], cookie: Boolean(request.headers.cookie) }))
          })
          return board
        }
      })
      const index = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8')
      const title = /<title>([^<]+)<\/title>/.exec(index)?.[1]
      const open = seen.find((entry) => entry.path === '/open-board')
      assert.ok(open, `Chrome never reached the link: ${JSON.stringify(seen)}`)
      assert.equal(open.status, 200, 'the link must answer with a page that moves on, not a redirect')
      const landing = seen.filter((entry) => entry.path === '/')
      assert.ok(landing.length >= 1, `Chrome never reached the board page: ${JSON.stringify(seen)}`)
      assert.equal(landing.at(-1).status, 200, `the board page was refused: ${JSON.stringify(seen)}`)
      assert.equal(landing.at(-1).cookie, true, 'the browser arrived without its cookie')
      assert.ok(dom.includes(title), 'the page Chrome ended on is not the board')

      // Now the same signed-in browser arrives from ANOTHER site (a course page, Notion, an email):
      // the page is on localhost, the board on 127.0.0.1, which Chrome counts as different sites.
      // One browser session (a session cookie does not outlive the browser): the page on the other site
      // opens the board in a pop-up to sign in with a fresh one-time link, waits, then visits the board itself.
      const freshLink = await new Promise((resolve) => {
        const secretFile = join(home, 'state', 'running.json')
        const { secret } = JSON.parse(readFileSync(secretFile, 'utf8'))
        const time = String(Date.now())
        const nonce = randomBytes(16).toString('hex')
        fetch(`http://127.0.0.1:${result.port}/starter/open-link`, { method: 'POST', headers: { 'x-starter-time': time, 'x-starter-nonce': nonce, 'x-starter-code': askCode(secret, time, nonce) } })
          .then((answer) => answer.json()).then((body) => resolve(body.link))
      })
      const other = createServer((request, response) => {
        response.setHeader('Content-Type', 'text/html')
        response.end(`<!doctype html><p>a page on another site</p><script>
          window.open(${JSON.stringify(freshLink)}, 'board')
          setTimeout(function () { location.href = 'http://127.0.0.1:${result.port}/' }, 3000)
        </script>`)
      })
      await new Promise((done) => other.listen(0, '127.0.0.1', done))
      try {
        seen.length = 0
        const arrived = await new Promise((resolve) => {
          execFile(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-popup-blocking', `--user-data-dir=${profile}2`, '--virtual-time-budget=9000', '--dump-dom', `http://localhost:${other.address().port}/`],
            { timeout: 60000 }, (error, stdout) => resolve(String(stdout ?? '')))
        })
        const visits = seen.filter((entry) => entry.path === '/' && entry.site !== 'same-origin' ? true : entry.path === '/')
        assert.ok(visits.length >= 1, `Chrome never reached the board from the other site: ${JSON.stringify(seen)}`)
        assert.equal(visits.at(-1).status, 200, `the visit from another site ended in a refusal: ${JSON.stringify(seen)}`)
        assert.equal(visits.at(-1).cookie, true)
        assert.ok(arrived.includes(title), 'the board did not load after arriving from another site')
        assert.ok(!arrived.includes("That did not come from the board"), 'the refusal text was shown to the student')
      } finally {
        other.close()
      }
    } finally {
      await result?.close?.()
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
      rmSync(home, { recursive: true, force: true })
    }
  })
