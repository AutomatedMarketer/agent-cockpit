// A real browser follows the starter's launcher file to the board. Headless Chrome, a throwaway
// profile, no new dependency. Skipped (with the reason) where Chrome is not installed.
//
// Why this exists: Chrome counts the chain file:// -> /open-board -> / as cross-site, so a 303 sent
// the browser on WITHOUT the new SameSite=Strict cookie, the board refused it, and the one-time link
// was already used up. Only a real browser shows that.

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
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
  { skip: CHROME ? false : 'Chrome is not installed here (set CHROME_PATH to run this)', timeout: 90000 },
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
    } finally {
      await result?.close?.()
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
      rmSync(home, { recursive: true, force: true })
    }
  })
