// The sign-in wall of the board on this computer (Student Edition, task T4): a one-time link that
// lasts 2 minutes becomes an HttpOnly, SameSite=Strict cookie tied to this run; every change must
// come from the board's own page.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { startLocalBoard } from '../local/server.mjs'
import { LINK_LIFETIME_MS, OPEN_PATH, cookieName, createLocalGate, applyLocalEnv } from '../local/gate.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const ENV_KEYS = ['VIEW_KEY', 'PUBLIC_FIRE', 'PUBLIC_DASHBOARD', 'EDIT_KEY', 'BOARD_PASSWORD', 'BOARD_USERNAME', 'REPO_SOURCE', 'REPO_FOLDER', 'PICTURE_STORE', 'PICTURE_FOLDER']

// The handlers read process.env, so a run that sets it must put it back.
async function withBoard(run, options = {}) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  const clock = { time: 1_000_000 }
  const board = await startLocalBoard({ port: 0, now: () => clock.time, ...options })
  const url = (path) => `http://127.0.0.1:${board.port}${path}`
  const tokenOf = (link) => new URL(link).searchParams.get('t')
  // Opens a link the way a browser does and returns the cookie it was given (or null).
  const open = async (link) => {
    const answer = await fetch(link, { redirect: 'manual' })
    const setCookie = answer.headers.get('set-cookie')
    return { answer, cookie: setCookie ? setCookie.split(';')[0] : null, setCookie }
  }
  try {
    await run({ board, url, clock, tokenOf, open })
  } finally {
    await new Promise((done) => { board.server.close(done); board.server.closeAllConnections() })
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
}

const echo = (request, response) => response.status(200).json({ headers: request.headers, method: request.method })

test('without the cookie every page and api call is refused and shows nothing of the board', async () => {
  await withBoard(async ({ url }) => {
    const index = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8')
    for (const [method, path] of [['GET', '/'], ['GET', '/app.js'], ['GET', '/api/state'], ['POST', '/api/fire'], ['GET', '/api/file?path=a.md'], ['GET', '/icon.svg']]) {
      const answer = await fetch(url(path), { method, headers: { Origin: `http://127.0.0.1:${new URL(url('/')).port}` }, body: method === 'POST' ? '{}' : undefined })
      assert.equal(answer.status, 401, `${method} ${path} gave ${answer.status}`)
      const text = await answer.text()
      assert.ok(!text.includes(index.slice(0, 200)) && !/viewKey|view-key/i.test(text), `${path} said too much`)
    }
  })
})

test('the link opens the board once: a cookie is set, a page moves the browser on to /, and the cookie then works', async () => {
  await withBoard(async ({ board, url, open }) => {
    const { answer, cookie, setCookie } = await open(board.openLink())
    assert.equal(answer.status, 200)
    assert.equal(answer.headers.get('location'), null, 'a redirect reaches the board before the new cookie counts (Chrome), and is refused')
    assert.match(answer.headers.get('content-type'), /^text\/html/)
    const body = await answer.text()
    assert.match(body, /<meta http-equiv="refresh" content="0;url=\/">/, 'the page must move the browser on to / by itself')
    assert.doesNotMatch(body, /<script|[?&]t=/, 'no inline script (the page rules block it) and no link in the page')
    assert.equal(answer.headers.get('cache-control'), 'no-store')
    assert.match(setCookie, new RegExp(`^${cookieName(board.port)}=`))
    const page = await fetch(url('/'), { headers: { Cookie: cookie } })
    assert.equal(page.status, 200)
    assert.match(await page.text(), /<html|<!doctype/i)
  })
})

test('the cookie cannot be read by a script and is not sent from another site', async () => {
  await withBoard(async ({ board, open }) => {
    const { setCookie } = await open(board.openLink())
    assert.match(setCookie, /;\s*HttpOnly/i)
    assert.match(setCookie, /;\s*SameSite=Strict/i)
    assert.match(setCookie, /;\s*Path=\//i)
    assert.doesNotMatch(setCookie, /Domain=/i, 'a Domain would widen who receives it')
  })
})

test('a link works only once: the second use is refused and sets no cookie', async () => {
  await withBoard(async ({ board, url, open }) => {
    const link = board.openLink()
    const first = await open(link)
    assert.equal(first.answer.status, 200)
    const second = await open(link)
    assert.equal(second.answer.status, 403)
    assert.equal(second.cookie, null)
    assert.equal((await fetch(url('/'), { headers: { Cookie: first.cookie } })).status, 200, 'the first sign-in should still stand')
  })
})

test('a link is refused after 2 minutes, and still good just before', async () => {
  await withBoard(async ({ board, url, clock, open }) => {
    const late = board.openLink()
    const justInTime = board.openLink()
    clock.time += LINK_LIFETIME_MS - 1
    assert.equal((await open(justInTime)).answer.status, 200)
    clock.time += 2
    const refused = await open(late)
    assert.equal(refused.answer.status, 403)
    assert.equal(refused.cookie, null)
    assert.equal((await fetch(url('/'))).status, 401)
  })
  assert.equal(LINK_LIFETIME_MS, 120_000)
})

test('a wrong, missing, shortened or reshaped link token is refused', async () => {
  await withBoard(async ({ board, url, tokenOf }) => {
    const token = tokenOf(board.openLink())
    for (const query of ['', '?t=', '?t=nope', `?t=${token.slice(0, -1)}`, `?t=${token}x`, `?token=${token}`, `?t[]=${token}`, `?T=${token}`]) {
      const answer = await fetch(url(`${OPEN_PATH}${query}`), { redirect: 'manual' })
      assert.equal(answer.status, 403, `${query} gave ${answer.status}`)
      assert.equal(answer.headers.get('set-cookie'), null)
    }
    assert.equal((await fetch(url(`${OPEN_PATH}?t=${token}`), { method: 'POST', redirect: 'manual' })).status, 401, 'only a GET may use a link')
    assert.equal((await fetch(url(`${OPEN_PATH}?t=${token}`), { redirect: 'manual' })).status, 200, 'the right token was spent by a wrong method')
  })
})

test('a tampered, truncated or made-up cookie is refused', async () => {
  await withBoard(async ({ board, url, open }) => {
    const { cookie } = await open(board.openLink())
    const name = cookie.slice(0, cookie.indexOf('='))
    const value = cookie.slice(name.length + 1)
    const [nonce, mac] = value.split('.')
    const flipped = mac.slice(0, -1) + (mac.at(-1) === 'A' ? 'B' : 'A')
    for (const bad of [`${nonce}.${flipped}`, `${nonce}.`, `.${mac}`, nonce, `${nonce}x.${mac}`, 'abc.def', '', `${nonce}.${mac}.${mac}`]) {
      const answer = await fetch(url('/'), { headers: { Cookie: `${name}=${bad}` } })
      assert.equal(answer.status, 401, `"${bad}" was accepted`)
    }
    assert.equal((await fetch(url('/'), { headers: { Cookie: `other=1; ${cookie}; more=2` } })).status, 200, 'the right cookie among others should work')
  })
})

test('a cookie from one run is dead in the next run, even on the same port', async () => {
  let oldCookie
  await withBoard(async ({ board, open }) => {
    oldCookie = (await open(board.openLink())).cookie
  })
  await withBoard(async ({ url }) => {
    assert.equal((await fetch(url('/'), { headers: { Cookie: oldCookie } })).status, 401)
  })
})

test('two gates never accept each other\'s cookies or links', () => {
  let time = 0
  const one = createLocalGate({ now: () => time })
  const two = createLocalGate({ now: () => time })
  assert.notEqual(one.viewKey, two.viewKey)
  assert.notEqual(one.issueOpenToken(), two.issueOpenToken())
})

test('a change from another site is refused, even with the cookie', async () => {
  await withBoard(async ({ board, url, open }) => {
    const { cookie } = await open(board.openLink())
    const own = `http://127.0.0.1:${board.port}`
    const post = (headers) => fetch(url('/api/fire'), { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers }, body: '{}' })
    for (const headers of [{ Origin: 'https://evil.example' }, { Origin: 'null' }, { Origin: `${own}.evil.example` }, { Origin: `http://localhost:${board.port + 1}` }, { Origin: own, 'Sec-Fetch-Site': 'cross-site' }, { Origin: own, 'Sec-Fetch-Site': 'same-site' }, {}]) {
      const answer = await post(headers)
      assert.equal(answer.status, 403, `${JSON.stringify(headers)} gave ${answer.status}`)
    }
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      assert.equal((await fetch(url('/api/fire'), { method, headers: { Cookie: cookie, Origin: 'https://evil.example' } })).status, 403)
    }
    // The board's own page: its Origin (either spelling of this computer), as a browser stamps it.
    for (const origin of [own, `http://localhost:${board.port}`]) {
      const answer = await post({ Origin: origin, 'Sec-Fetch-Site': 'same-origin' })
      assert.notEqual(answer.status, 403, `${origin} was refused`)
      assert.notEqual(answer.status, 401)
    }
  })
})

test('a read from another site with the cookie is still answered only as the cookie allows (reads need no Origin)', async () => {
  await withBoard(async ({ board, url, open }) => {
    const { cookie } = await open(board.openLink())
    assert.equal((await fetch(url('/'), { headers: { Cookie: cookie, Origin: 'https://evil.example' } })).status, 200)
  })
})

test('the handlers get the per-run view key, and a key the caller sends never counts', async () => {
  await withBoard(async ({ board, url, open }) => {
    const { cookie } = await open(board.openLink())
    const wrong = await fetch(url('/api/state'), { headers: { 'x-view-key': process.env.VIEW_KEY } })
    assert.equal(wrong.status, 401, 'knowing the key is not the same as being signed in')
    assert.equal(process.env.PUBLIC_FIRE, 'true')
    assert.equal(process.env.PUBLIC_DASHBOARD, undefined)
    assert.ok(process.env.VIEW_KEY.length >= 40)
    assert.equal(typeof cookie, 'string')
  })
})

test('the gate gives handlers the view key and replaces one the caller sent', async () => {
  const handlerSees = []
  await withBoard(async ({ board, url, open }) => {
    const { cookie } = await open(board.openLink())
    await fetch(url('/api/state'), { headers: { Cookie: cookie, 'x-view-key': 'caller-chose-this' } })
    assert.equal(handlerSees.length, 1)
    assert.equal(handlerSees[0]['x-view-key'], process.env.VIEW_KEY)
    assert.notEqual(handlerSees[0]['x-view-key'], 'caller-chose-this')
  }, { loadHandler: async () => (request, response) => { handlerSees.push({ ...request.headers }); echo(request, response) } })
})

test('the board\'s real handlers accept the signed-in browser (view gate and fire gate pass)', async () => {
  const realFetch = globalThis.fetch
  await withBoard(async ({ board, url, open }) => {
    const { cookie } = await open(board.openLink())
    globalThis.fetch = (input, init) => {
      const target = String(input?.url ?? input)
      if (target.startsWith(`http://127.0.0.1:${board.port}/`)) return realFetch(input, init)
      throw new Error('blocked in test')
    }
    try {
      const state = await fetch(url('/api/state'), { headers: { Cookie: cookie } })
      assert.notEqual(state.status, 401, 'the board refused its own signed-in page')
      assert.notEqual(state.status, 503, 'the view gate says the board is not configured')
      const fire = await fetch(url('/api/fire'), { method: 'POST', headers: { Cookie: cookie, Origin: `http://127.0.0.1:${board.port}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'nothing' }) })
      assert.notEqual(fire.status, 401)
      assert.notEqual(fire.status, 403, 'the same-origin check refused the own page')
      // 503 here is only 'no routines set up in this test': the gates in front of it passed.
      assert.match(await fire.text(), /FIRE_TRIGGERS|mailbox|configured/i)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

test('an ambient VIEW_KEY or PUBLIC_DASHBOARD on this computer does not decide who gets in', async () => {
  const saved = { VIEW_KEY: process.env.VIEW_KEY, PUBLIC_DASHBOARD: process.env.PUBLIC_DASHBOARD }
  process.env.VIEW_KEY = 'ambient-key-from-the-system'
  process.env.PUBLIC_DASHBOARD = 'true'
  try {
    await withBoard(async ({ url }) => {
      assert.notEqual(process.env.VIEW_KEY, 'ambient-key-from-the-system')
      assert.equal(process.env.PUBLIC_DASHBOARD, undefined)
      assert.equal((await fetch(url('/api/state'), { headers: { 'x-view-key': 'ambient-key-from-the-system' } })).status, 401)
    })
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
})

test('applyLocalEnv sets the run\'s settings and clears the ones that would change who may write', () => {
  const env = { VIEW_KEY: 'old', PUBLIC_DASHBOARD: 'true', EDIT_KEY: 'x', BOARD_PASSWORD: 'p', BOARD_USERNAME: 'u' }
  applyLocalEnv('new-key', env)
  assert.deepEqual(env, { VIEW_KEY: 'new-key', PUBLIC_FIRE: 'true' })
})

test('the link is printed once by the command line and appears nowhere else, even after use and reuse', async () => {
  const child = spawn(process.execPath, [join(ROOT, 'local', 'server.mjs'), '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (data) => { output += data })
  child.stderr.on('data', (data) => { output += data })
  try {
    const link = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no link printed: ${output}`)), 20000)
      const look = setInterval(() => {
        const found = /http:\/\/127\.0\.0\.1:\d+\/open-board\?t=[\w-]+/.exec(output)
        if (found) { clearTimeout(timer); clearInterval(look); resolve(found[0]) }
      }, 50)
      child.on('exit', () => reject(new Error(`exited early: ${output}`)))
    })
    const token = new URL(link).searchParams.get('t')
    assert.equal((await fetch(link, { redirect: 'manual' })).status, 200)
    assert.equal((await fetch(link, { redirect: 'manual' })).status, 403)
    await fetch(`${link}&extra=1`, { redirect: 'manual' })
    await new Promise((done) => setTimeout(done, 300))
    assert.equal(output.split(token).length - 1, 1, `the token appeared ${output.split(token).length - 1} times:\n${output}`)
    assert.doesNotMatch(output, /UNFINISHED/)
  } finally {
    child.kill()
  }
})

test('cookies and tokens of any length or shape are refused cleanly, never an error', async () => {
  await withBoard(async ({ board, url, tokenOf }) => {
    const name = cookieName(board.port)
    for (const value of ['x'.repeat(6000), '.'.repeat(500), 'a.b.c.d', '%00.%00', 'é.é', '='.repeat(100)]) {
      const answer = await fetch(url('/'), { headers: { Cookie: `${name}=${value}` } })
      assert.equal(answer.status, 401, `a ${value.length}-character cookie gave ${answer.status}`)
    }
    for (const token of ['x'.repeat(5000), 'é', '%00', '../..']) {
      const answer = await fetch(url(`${OPEN_PATH}?t=${encodeURIComponent(token)}`), { redirect: 'manual' })
      assert.equal(answer.status, 403)
    }
    assert.ok(tokenOf)
  })
})

test('a page on another local port cannot trigger reads: same-site and cross-site requests are refused, even GETs', async () => {
  await withBoard(async ({ board, url, open }) => {
    const { cookie } = await open(board.openLink())
    for (const site of ['same-site', 'cross-site', 'Cross-Site']) {
      for (const path of ['/', '/api/state', '/app.js']) {
        const answer = await fetch(url(path), { headers: { Cookie: cookie, 'Sec-Fetch-Site': site } })
        assert.equal(answer.status, 403, `${path} with ${site} gave ${answer.status}`)
      }
    }
    for (const site of ['same-origin', 'none']) {
      assert.equal((await fetch(url('/'), { headers: { Cookie: cookie, 'Sec-Fetch-Site': site } })).status, 200, `${site} was refused`)
    }
  })
})

test('the one-time link may be opened from anywhere (a file the starter wrote counts as another site)', async () => {
  await withBoard(async ({ board, open }) => {
    const link = board.openLink()
    const answer = await fetch(link, { redirect: 'manual', headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' } })
    assert.equal(answer.status, 200)
    assert.ok(open)
  })
})

test('one junk cookie of the same name cannot sign the student out: any valid value is enough', async () => {
  await withBoard(async ({ board, url, open }) => {
    const { cookie } = await open(board.openLink())
    const name = cookie.slice(0, cookie.indexOf('='))
    assert.equal((await fetch(url('/'), { headers: { Cookie: `${name}=junk; ${cookie}` } })).status, 200)
    assert.equal((await fetch(url('/'), { headers: { Cookie: `${cookie}; ${name}=junk` } })).status, 200)
    assert.equal((await fetch(url('/'), { headers: { Cookie: `${name}=junk; ${name}=more.junk` } })).status, 401)
  })
})

test('the cookie name carries the port, so two boards on one computer do not knock each other out', async () => {
  await withBoard(async ({ board: first, url: firstUrl, open: openFirst }) => {
    await withBoard(async ({ board: second, url: secondUrl, open: openSecond }) => {
      assert.notEqual(first.port, second.port)
      const one = (await openFirst(first.openLink())).cookie
      const two = (await openSecond(second.openLink())).cookie
      assert.notEqual(one.split('=')[0], two.split('=')[0])
      assert.equal(one.split('=')[0], cookieName(first.port))
      // A browser keeps both on 127.0.0.1 and sends both everywhere.
      const both = `${one}; ${two}`
      assert.equal((await fetch(firstUrl('/'), { headers: { Cookie: both } })).status, 200)
      assert.equal((await fetch(secondUrl('/'), { headers: { Cookie: both } })).status, 200)
    })
  })
})

test('a refusal says "the board\'s own page" in both places it can be given', async () => {
  await withBoard(async ({ board, url, open }) => {
    const { cookie } = await open(board.openLink())
    const fromSite = await fetch(url('/api/state'), { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' } })
    assert.equal((await fromSite.json()).error, "That did not come from the board's own page.")
    const changed = await fetch(url('/api/fire'), { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' })
    assert.equal((await changed.json()).error, "That did not come from the board's own page.")
  })
})

test('the manifest link asks for the cookie, so the signed-in board can load it (and the first page stays small)', async () => {
  const index = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8')
  assert.match(index, /<link rel="manifest" href="\/manifest\.webmanifest" crossorigin="use-credentials"/)
  await withBoard(async ({ board, url, open }) => {
    assert.equal((await fetch(url('/manifest.webmanifest'))).status, 401, 'without the cookie it is refused, like everything else')
    const { cookie } = await open(board.openLink())
    assert.equal((await fetch(url('/manifest.webmanifest'), { headers: { Cookie: cookie } })).status, 200)
  })
})
