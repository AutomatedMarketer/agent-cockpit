// The board on this computer: a small Node server that runs the SAME api/*.js files the website
// runs on Vercel, and serves public/. No dependencies.
//
// STATUS: the server (T1) and the sign-in wall (T4) are done. Still to come: T2 (git instead of
// GitHub), T3 (pictures in a folder), T5 (double-click starters). Until T2 and T3 land the handlers
// still need GitHub and Blob settings, so this is not ready to hand to students.
//
// How it is protected: it listens on 127.0.0.1 only; it answers only Host 127.0.0.1:<port> or
// localhost:<port>; and startLocalBoard() adds the sign-in wall (local/gate.mjs): a one-time,
// two-minute link swapped for an HttpOnly, SameSite=Strict cookie tied to this run, and an Origin
// check on every change. createBoardServer() alone has no wall (tests use it that way): always
// start the board for a person through startLocalBoard() or the command line.
//
// Seams for the next tasks, arguments of createBoardServer, so nothing here changes then:
//   gate(request, response) -> false once it has answered, anything else to carry on
//                              (runs after the Host check, which cannot be switched off)
//   loadHandler(name)       -> the handler for /api/<name>                              (tests)
//   handlerTimeoutMs        -> how long a handler may take before a 504                 (default 60 s)
// T2 (repo source) and T3 (picture folder) need no seam here: they work through settings the
// handlers already read from the environment.

import { createServer } from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { loadVercelConfig } from './headers.mjs'
import { routeNameFor } from './routes.mjs'
import { BodyError, cleanForwardingHeaders, shimRequest, shimResponse } from './vercel-shim.mjs'
import { serveStatic } from './static.mjs'
import { HOP_SCRIPT, KEY_HANDOFF_SCRIPT, LOCAL_MODE_SCRIPT, OPEN_PATH, applyLocalEnv, createLocalGate } from './gate.mjs'
import { readFileSync } from 'node:fs'
import { SETTINGS_PATH, createSettings } from './settings.mjs'
import { createLocalVoice } from './voice.mjs'
import { localizeResponse } from './localize.mjs'

export const LOOPBACK = '127.0.0.1'
export const DEFAULT_PORT = 4317
export const HANDLER_TIMEOUT_MS = 60_000 // a Vercel function has a limit too
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'page')
const SETTINGS_SCRIPT = '/local-settings.js'
const VOICE_SCRIPT = '/local-voice.js'
const VOICE_CONFIG_SCRIPT = '/local-voice-config.js'
const PAGE_SCRIPTS = new Map([
  [HOP_SCRIPT, readFileSync(join(PAGE_DIR, 'hop.js'))],
  [LOCAL_MODE_SCRIPT, readFileSync(join(PAGE_DIR, 'local-mode.js'))],
  [KEY_HANDOFF_SCRIPT, readFileSync(join(PAGE_DIR, 'key-handoff.js'))],
  [SETTINGS_SCRIPT, readFileSync(join(PAGE_DIR, 'settings-ui.js'))],
  [VOICE_SCRIPT, readFileSync(join(PAGE_DIR, 'voice-local.js'))]
])
const APP_TAG = '<script src="/app.js"></script>'

// The only address this server may listen on. Anything else - 0.0.0.0, a LAN address, "localhost"
// (which can mean ::1 or a name someone else controls), an empty string (which means all) - throws.
export function assertLoopback(host) {
  if (host !== LOOPBACK) {
    throw new Error(`The board only listens on ${LOOPBACK}, never on "${host}": nothing else on the network may reach it.`)
  }
}

// DNS rebinding: a web page can make its own name point at 127.0.0.1, and the browser then sends
// that name as Host. Only the two spellings a person types are answered, with this server's port.
export function hostIsAllowed(hostHeader, port) {
  if (typeof hostHeader !== 'string') return false
  const host = hostHeader.toLowerCase()
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`
}

function sendError(response, status, message) {
  if (response.headersSent || response.writableEnded) return
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify({ error: message }))
}

const logLine = (request, what) => console.error(`[board] ${request.method} ${String(request.url).split('?')[0]} ${what}`)

export function createBoardServer({
  root = ROOT,
  gate = () => true,
  handlerTimeoutMs = HANDLER_TIMEOUT_MS,
  localRoutes = {}, // address -> handler, for the few things only the local board has (the Settings box)
  dynamicScripts = {}, // address -> () => text, small scripts whose content depends on the board's settings
  localize = null, // (json) => json: the website's sentences in a student's words (startLocalBoard sets it)
  localPage = false, // true: the page gets local-mode.js in front of app.js (startLocalBoard sets it)
  wrapHandler = null, // (name, handler) => handler: jobs on this computer kick the runner after /api/fire (local/runner.mjs)
  loadHandler = async (name) => (await import(pathToFileURL(join(root, 'api', `${name}.js`)).href)).default
} = {}) {
  const { headers: securityHeaders } = loadVercelConfig(join(root, 'vercel.json'))
  const publicRoot = join(root, 'public')
  let server

  async function respond(request, response) {
    // Vercel puts these on every response, files and functions alike. A handler may override one.
    for (const [key, value] of securityHeaders) response.setHeader(key, value)
    shimResponse(response)
    response.on('error', (failure) => logLine(request, `response error: ${failure?.message ?? failure}`))

    // Before anything else, for pages and api alike, and with nothing in the answer to learn from.
    if (!hostIsAllowed(request.headers.host, server.address()?.port)) {
      response.statusCode = 421
      response.end()
      return
    }
    cleanForwardingHeaders(request)
    if ((await gate(request, response)) === false) return

    // Cut by hand: new URL('//x', base) reads "x" as a web address and loses the path.
    const pathname = String(request.url).split(/[?#]/)[0]
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      const name = routeNameFor(pathname)
      const own = Object.hasOwn(localRoutes, pathname) ? localRoutes[pathname] : null
      if (!name && !own) return sendError(response, 404, 'No such endpoint.')
      try {
        await shimRequest(request)
      } catch (failure) {
        if (failure instanceof BodyError) {
          // The rest of the body is never kept. It is thrown away for a moment so the sender can
          // still read this answer (hanging up at once resets the connection and loses it), then
          // the connection ends if the sender is still going.
          request.resume()
          setTimeout(() => request.destroy(), 1500).unref()
          return sendError(response, failure.status, failure.message)
        }
        throw failure
      }
      const loaded = own ?? (await loadHandler(name))
      const handler = wrapHandler && !own ? wrapHandler(name, loaded) : loaded
      if (localize) {
        const sendJson = response.json
        response.json = (value) => sendJson.call(response, localize(value))
      }
      // After a 504 the handler is NOT stopped - JavaScript cannot stop it - so it may still finish
      // its work (a write, a call that costs money) with nobody listening. request.signal tells
      // it the time is up; no handler reads it yet, and one that does should stop what it is doing.
      const timeUp = new AbortController()
      Object.defineProperty(request, 'signal', { value: timeUp.signal, configurable: true })
      const timer = setTimeout(() => {
        timeUp.abort()
        logLine(request, `took longer than ${handlerTimeoutMs} ms`)
        sendError(response, 504, 'The board took too long to answer.')
      }, handlerTimeoutMs)
      response.once('close', () => clearTimeout(timer))
      return handler(request, response)
    }

    // The board's own small scripts for a run on this computer (not in public/, so never on the website).
    const dynamic = Object.hasOwn(dynamicScripts, pathname) ? dynamicScripts[pathname] : null
    const own = dynamic ? Buffer.from(dynamic(), 'utf8') : PAGE_SCRIPTS.get(pathname)
    if (own && (request.method === 'GET' || request.method === 'HEAD')) {
      response.statusCode = 200
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8')
      response.setHeader('Cache-Control', 'no-store')
      response.end(request.method === 'HEAD' ? undefined : own)
      return
    }

    const served = await serveStatic(publicRoot, request.method, pathname)
    for (const [key, value] of Object.entries(served.headers)) response.setHeader(key, value)
    response.statusCode = served.status
    let body = served.body
    // Whatever address the page was reached by (/, /index, /INDEX on a computer that ignores case...):
    // it is the page that counts, not the address.
    if (localPage && served.status === 200 && served.isPage && Buffer.isBuffer(body)) {
      const html = body.toString('utf8')
      if (!html.includes(APP_TAG)) throw new Error('public/index.html no longer loads /app.js in the expected way, so the local page script cannot be added')
      body = Buffer.from(html.replace(APP_TAG, `<script src="${LOCAL_MODE_SCRIPT}"></script><script src="${VOICE_CONFIG_SCRIPT}"></script>${APP_TAG}<script src="${SETTINGS_SCRIPT}"></script><script src="${VOICE_SCRIPT}"></script>`), 'utf8')
    }
    response.end(request.method === 'HEAD' ? undefined : body)
  }

  server = createServer((request, response) => {
    respond(request, response).catch((failure) => {
      // The reason goes to this window, never to the page: it could name a path or a setting.
      logLine(request, `failed: ${failure?.message ?? failure}`)
      if (!response.headersSent) sendError(response, 500, 'The board hit an error. Look at the window it is running in.')
      else response.destroy()
    })
  })
  return server
}

export async function startBoardServer({ port = DEFAULT_PORT, host = LOOPBACK, build = createBoardServer, ...options } = {}) {
  assertLoopback(host)
  // A browser leaves the port out of Host on port 80, which the Host check cannot tell apart.
  if (port === 80) throw new Error('The board will not use port 80. Pick another with --port, for example --port 4317.')
  const server = build(options)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const address = server.address()
      // Belt and braces: listen() was told 127.0.0.1, but what counts is where it actually is.
      if (address.address !== LOOPBACK) {
        server.close()
        reject(new Error(`The board came up on ${address.address}, not ${LOOPBACK}, and was shut down.`))
        return
      }
      resolve({ server, port: address.port, host: address.address })
    })
  })
}

// The board as a person gets it: the server plus the sign-in wall. Returns openLink(), which makes
// a NEW one-time link each time it is called - print it once and do not log it anywhere else.
// `wrapHandler` (local/start.mjs): jobs on this computer kick the runner after /api/fire queues an order
// (local/runner.mjs), and /api/state is read in full once after this computer's numbers were refreshed
// (local/collector.mjs).
export async function startLocalBoard({ now, settingsFile, settingsOptions = {}, voiceOptions = {}, localRoutes = {}, wrapHandler = null, ...options } = {}) {
  const login = createLocalGate({ now })
  applyLocalEnv(login.viewKey)
  // The Settings box's keys: read back into the handlers' environment now, saved there when pasted.
  const routes = { ...localRoutes }
  const scripts = { [VOICE_CONFIG_SCRIPT]: () => 'window.__BOARD_LOCAL_VOICE__ = { engine: "cloud" }' }
  if (settingsFile) {
    const settings = createSettings({ file: settingsFile, ...settingsOptions })
    routes[SETTINGS_PATH] = settings.handler
    // Voice that runs on this computer: the four endpoints, and the one line that tells the page which engine it is.
    const voice = createLocalVoice({ settings, ...voiceOptions })
    Object.assign(routes, voice.routes)
    scripts[VOICE_CONFIG_SCRIPT] = voice.configScript
  }
  const board = await startBoardServer({ ...options, gate: login.gate, localPage: true, localRoutes: routes, dynamicScripts: scripts, localize: localizeResponse, wrapHandler })
  const openLink = () => `http://${board.host}:${board.port}${OPEN_PATH}?t=${login.issueOpenToken()}`
  return { ...board, openLink, starterSecret: login.starterSecret, apiToken: login.apiToken }
}

function readArgs(argv) {
  const args = { port: DEFAULT_PORT, host: LOOPBACK }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--port') args.port = Number(argv[++index])
    else if (argv[index] === '--host') args.host = argv[++index]
    else throw new Error(`Unknown option "${argv[index]}". Use --port <number>.`)
  }
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) throw new Error('--port must be a whole number from 0 to 65535.')
  return args
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // One request going wrong must not end the board for everyone using it: say so here and carry on.
  process.on('uncaughtException', (failure) => console.error(`[board] unexpected error, still running: ${failure?.message ?? failure}`))
  process.on('unhandledRejection', (failure) => console.error(`[board] unexpected error, still running: ${failure?.message ?? failure}`))
  try {
    const board = await startLocalBoard(readArgs(process.argv.slice(2)))
    console.log(`Board running on this computer only (port ${board.port}). Open it with this link, once, within 2 minutes:`)
    console.log(board.openLink())
    console.log('Press Ctrl+C to stop. Stopping and starting again makes a new link; old links and sign-ins stop working.')
  } catch (failure) {
    console.error(failure.message)
    process.exit(1)
  }
}
