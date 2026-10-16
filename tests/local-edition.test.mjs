// The student edition's wiring: the local starter turns on the folder modes (team folder read with
// git, pictures kept in a folder) by default, and git is never handed the board's secrets.

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { askCode } from '../local/starter-auth.mjs'
import { gitEnvironment, findGit } from '../api/_repo.js'
import { applyLocalEnv } from '../local/gate.mjs'
import { applyStudentEnv, resolveTeamFolder, runStart, picturesDirFor, readRunning } from '../local/start.mjs'

const GIT = findGit()
const ENV_KEYS = ['VIEW_KEY', 'PUBLIC_FIRE', 'PUBLIC_DASHBOARD', 'EDIT_KEY', 'BOARD_PASSWORD', 'BOARD_USERNAME', 'REPO_SOURCE', 'REPO_FOLDER', 'PICTURE_STORE', 'PICTURE_FOLDER', 'GITHUB_OWNER', 'GITHUB_REPO']

const gitCleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')))
const git = (cwd, ...args) => execFileSync(GIT, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, env: { ...gitCleanEnv, GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8' }).trim()

// A real team folder: a clone of a bare "GitHub" folder (no network), with one agent committed and pushed.
function makeTeam() {
  const base = mkdtempSync(join(tmpdir(), 'edition-team-'))
  const work = join(base, 'team')
  const bare = join(base, 'github.git')
  mkdirSync(work)
  git(work, 'init', '-q', '-b', 'main')
  mkdirSync(join(work, '.claude', 'agents'), { recursive: true })
  writeFileSync(join(work, '.claude', 'agents', 'research.md'), '---\nname: research\ndescription: Finds things out.\nmodel: sonnet\n---\n\nYou are the research agent.\n')
  mkdirSync(join(work, 'shared'))
  writeFileSync(join(work, 'shared', 'about-me.md'), '# About me\n')
  git(work, 'add', '-A')
  git(work, 'commit', '-q', '-m', 'first')
  git(base, 'init', '-q', '--bare', '-b', 'main', bare)
  git(work, 'remote', 'add', 'origin', 'https://github.com/someone/my-agent-team.git')
  git(work, 'config', `url.${bare}.insteadOf`, 'https://github.com/someone/my-agent-team.git')
  git(work, 'push', '-q', 'origin', 'main')
  return { base, work, done: () => rmSync(base, { recursive: true, force: true }) }
}

async function withEdition(run) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  const home = mkdtempSync(join(tmpdir(), 'edition-home-'))
  const stateDir = join(home, 'state')
  const boardDir = join(home, 'Agent Board')
  mkdirSync(boardDir)
  const started = []
  const common = {
    platform: process.platform,
    env: { ...process.env },
    home,
    stateDir,
    basePort: 20000 + Math.floor(Math.random() * 8000),
    lingerMs: 20,
    openFile: async () => {},
    log: () => {}
  }
  const start = async (extra = {}) => {
    const result = await runStart({ ...common, ...extra })
    started.push(result)
    return result
  }
  try {
    await run({ start, home, stateDir, boardDir, common })
  } finally {
    for (const result of started) await result.close?.()
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    rmSync(home, { recursive: true, force: true })
  }
}

// ---- git is never handed the board's secrets ---------------------------------------------------------

test('git env: only what git needs to find the student\'s own sign-in; no keys, tokens, view key or board settings', () => {
  const source = {
    PATH: '/bin', Path: 'C:\\x', HOME: '/home/x', USERPROFILE: 'C:\\Users\\x', APPDATA: 'a', LOCALAPPDATA: 'l', SystemRoot: 'C:\\Windows', TEMP: 't', LANG: 'en_US.UTF-8', LC_ALL: 'C', SSH_AUTH_SOCK: '/s',
    VIEW_KEY: 'view-secret', PUBLIC_FIRE: 'true', OPENAI_API_KEY: 'sk-x', GITHUB_TOKEN: 'ghp_x', ANTHROPIC_API_KEY: 'a', MAILBOX_SECRET: 'm', FIRE_KEY: 'f', EDIT_KEY: 'e', BOARD_PASSWORD: 'p', N8N_API_KEY: 'n', HASS_TOKEN: 'h',
    REPO_FOLDER: '/team', PICTURE_FOLDER: '/pics', FISH_AUDIO_API_KEY: 'f', RANDOM_SECRET_THING: 'z', GIT_DIR: '/evil', git_ssh_command: 'evil'
  }
  const env = gitEnvironment(source)
  for (const name of ['VIEW_KEY', 'PUBLIC_FIRE', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'MAILBOX_SECRET', 'FIRE_KEY', 'EDIT_KEY', 'BOARD_PASSWORD', 'N8N_API_KEY', 'HASS_TOKEN', 'REPO_FOLDER', 'PICTURE_FOLDER', 'FISH_AUDIO_API_KEY', 'RANDOM_SECRET_THING', 'GIT_DIR', 'git_ssh_command']) {
    assert.equal(env[name], undefined, `${name} reached git`)
  }
  for (const name of ['PATH', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'SystemRoot', 'LANG', 'LC_ALL', 'SSH_AUTH_SOCK']) assert.ok(env[name] !== undefined, `${name} was dropped`)
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(env.GCM_INTERACTIVE, 'never')
})

test('git env: after the local board has set its per-run key, that key is not in what git would get', () => {
  const env = { ...process.env, SOMETHING_ELSE: 'x' }
  applyLocalEnv('per-run-view-key-0123456789', env)
  const forGit = gitEnvironment(env)
  assert.equal(JSON.stringify(forGit).includes('per-run-view-key-0123456789'), false)
  assert.equal(forGit.VIEW_KEY, undefined)
  assert.equal(forGit.PUBLIC_FIRE, undefined)
})

// ---- where the team folder comes from ---------------------------------------------------------------

test('team folder: board.json next to the starter names it', async () => {
  const team = makeTeam()
  const board = mkdtempSync(join(tmpdir(), 'edition-board-'))
  try {
    writeFileSync(join(board, 'board.json'), JSON.stringify({ teamFolder: team.work }))
    assert.equal(resolveTeamFolder({ boardDir: board, stateDir: join(board, 'state') }).folder, realpathSync(team.work))
  } finally {
    team.done()
    rmSync(board, { recursive: true, force: true })
  }
})

test('team folder: board.json in the state folder works too, and the one next to the starter wins', () => {
  const team = makeTeam()
  const other = makeTeam()
  const board = mkdtempSync(join(tmpdir(), 'edition-board-'))
  const state = mkdtempSync(join(tmpdir(), 'edition-state-'))
  try {
    writeFileSync(join(state, 'board.json'), JSON.stringify({ teamFolder: other.work }))
    assert.equal(resolveTeamFolder({ boardDir: board, stateDir: state }).folder, realpathSync(other.work))
    writeFileSync(join(board, 'board.json'), JSON.stringify({ teamFolder: team.work }))
    assert.equal(resolveTeamFolder({ boardDir: board, stateDir: state }).folder, realpathSync(team.work))
  } finally {
    team.done(); other.done()
    rmSync(board, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true })
  }
})

test('team folder: a board that sits inside the team folder uses its parent', () => {
  const team = makeTeam()
  try {
    const inside = join(team.work, 'Agent Board')
    mkdirSync(inside)
    assert.equal(resolveTeamFolder({ boardDir: inside, stateDir: join(inside, 'state') }).folder, realpathSync(team.work))
  } finally {
    team.done()
  }
})

test('team folder: nothing found, or a bad answer, is a plain sentence that says what to do', () => {
  const board = mkdtempSync(join(tmpdir(), 'edition-board-'))
  try {
    const none = resolveTeamFolder({ boardDir: board, stateDir: join(board, 'state') })
    assert.equal(none.folder, null)
    assert.match(none.why, /board\.json/)
    assert.match(none.why, /teamFolder/)
    for (const [text, expected] of [
      ['{"teamFolder":"relative/path"}', /full path/i],
      [`{"teamFolder":${JSON.stringify(join(board, 'missing'))}}`, /does not exist|not a folder/i],
      [`{"teamFolder":${JSON.stringify(board)}}`, /git/i],
      ['{"teamFolder":5}', /full path/i],
      ['not json', /board\.json/],
      ['[]', /teamFolder/]
    ]) {
      writeFileSync(join(board, 'board.json'), text)
      const answer = resolveTeamFolder({ boardDir: board, stateDir: join(board, 'state') })
      assert.equal(answer.folder, null, text)
      assert.match(answer.why, expected, text)
    }
  } finally {
    rmSync(board, { recursive: true, force: true })
  }
})

// ---- the settings the board is started with --------------------------------------------------------

test('settings: the folder modes are on by default, pointing at the team folder and a pictures folder in the profile', () => {
  const env = { REPO_SOURCE: 'github', PICTURE_STORE: 'blob', BLOB_READ_WRITE_TOKEN: 'x' }
  applyStudentEnv(env, { teamFolder: '/team', pictureFolder: '/p' })
  assert.equal(env.REPO_SOURCE, 'folder')
  assert.equal(env.REPO_FOLDER, '/team')
  assert.equal(env.PICTURE_STORE, 'folder')
  assert.equal(env.PICTURE_FOLDER, '/p')
  assert.equal(picturesDirFor('/x/state').replace(/\\/g, '/'), '/x/state/pictures')
})

// ---- the real thing: real git, real handlers, a signed-in browser ---------------------------------

test('start with a team folder: the board shows the real team, and nothing about the keys reaches git or the page', async () => {
  const team = makeTeam()
  const realFetch = globalThis.fetch
  try {
    await withEdition(async ({ start, stateDir, boardDir }) => {
      const result = await start({ teamFolder: team.work, boardDir })
      assert.equal(process.env.REPO_SOURCE, 'folder')
      assert.equal(process.env.PICTURE_STORE, 'folder')
      assert.equal(realpathSync(process.env.REPO_FOLDER), realpathSync(team.work))
      assert.ok(process.env.PICTURE_FOLDER.startsWith(stateDir), 'the pictures live in the user\'s own state folder')
      // The signed-in browser: open the link the way a browser does, keep the cookie.
      const link = await (async () => {
        const secret = readRunning(stateDir).secret
        const nonce = randomBytes(16).toString('hex')
        const time = String(Date.now())
        const answer = await realFetch(`http://127.0.0.1:${result.port}/starter/open-link`, { method: 'POST', headers: { 'x-starter-time': time, 'x-starter-nonce': nonce, 'x-starter-code': askCode(secret, time, nonce) } })
        return (await answer.json()).link
      })()
      const opened = await realFetch(link, { redirect: 'manual' })
      const cookie = opened.headers.get('set-cookie').split(';')[0]
      const boardToken = /<meta name="board-token" content="([\w-]+)">/.exec(await opened.text())[1]
      globalThis.fetch = (input, init) => {
        const target = String(input?.url ?? input)
        if (target.startsWith(`http://127.0.0.1:${result.port}/`)) return realFetch(input, init)
        throw new Error(`the board tried to reach ${target}`)
      }
      const state = await realFetch(`http://127.0.0.1:${result.port}/api/state`, { headers: { Cookie: cookie, 'x-board-token': boardToken } })
      assert.equal(state.status, 200, await state.clone().text())
      const body = await state.json()
      const text = JSON.stringify(body)
      assert.ok(/research/.test(text), 'the committed agent should be on the board')
      assert.ok(!text.includes(process.env.VIEW_KEY), 'the per-run key reached the page')
      // The pictures folder works: the brand answer names the store as connected.
      const brand = await realFetch(`http://127.0.0.1:${result.port}/api/brand`, { headers: { Cookie: cookie, 'x-board-token': boardToken } })
      assert.equal(brand.status, 200)
    })
  } finally {
    globalThis.fetch = realFetch
    team.done()
  }
})

test('start with no team folder: the board says so in plain words and does not start', async () => {
  await withEdition(async ({ start, boardDir }) => {
    await assert.rejects(start({ teamFolder: null, teamFolderWhy: 'Tell the board where your team folder is: board.json', boardDir }), /team folder/i)
  })
})

test('start: the pictures folder is created, private to the user, and inside the state folder', async () => {
  const team = makeTeam()
  try {
    await withEdition(async ({ start, stateDir, boardDir }) => {
      await start({ teamFolder: team.work, boardDir })
      assert.equal(existsSync(join(stateDir, 'pictures')), true)
    })
  } finally {
    team.done()
  }
})

test('team folder: a network path (two slashes or two backslashes) is refused, so nothing signs in to a server', () => {
  const board = mkdtempSync(join(tmpdir(), 'edition-board-'))
  try {
    for (const path of ['//server/share/team', String.fromCharCode(92, 92) + 'server' + String.fromCharCode(92) + 'share', String.fromCharCode(92, 92) + '?' + String.fromCharCode(92) + 'UNC' + String.fromCharCode(92) + 'server' + String.fromCharCode(92) + 'x', '//127.0.0.1/x']) {
      writeFileSync(join(board, 'board.json'), JSON.stringify({ teamFolder: path }))
      const answer = resolveTeamFolder({ boardDir: board, stateDir: join(board, 'state') })
      assert.equal(answer.folder, null, path)
      assert.match(answer.why, /network folder/, path)
    }
  } finally {
    rmSync(board, { recursive: true, force: true })
  }
})

test('team folder: a network path in any mix of slashes is refused before the disk is touched', () => {
  const board = mkdtempSync(join(tmpdir(), 'edition-board-'))
  const back = String.fromCharCode(92)
  try {
    for (const path of [`${back}/server/share`, `/${back}server/share`, `${back}${back}server`, '//server/x', `${back}/?/UNC/server/x`, `/${back}.${back}pipe`]) {
      writeFileSync(join(board, 'board.json'), JSON.stringify({ teamFolder: path }))
      const answer = resolveTeamFolder({ boardDir: board, stateDir: join(board, 'state') })
      assert.equal(answer.folder, null, path)
      assert.match(answer.why, /network folder/, path)
    }
  } finally {
    rmSync(board, { recursive: true, force: true })
  }
})
