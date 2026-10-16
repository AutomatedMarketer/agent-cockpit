// The board on this computer: a small Node server that runs the SAME api/*.js files the website
// runs on Vercel, and serves public/. No dependencies.
//
// STATUS: UNFINISHED (task T1 of the Student Edition plan). There is no login wall yet - that is
// T4 (Host check, one-time link, cookie). Until it lands, the only protection is that the server
// listens on 127.0.0.1 and refuses to start anywhere else. Do not give this to students yet.
//
// Seams for the next tasks, both arguments of createBoardServer, so nothing here changes then:
//   gate(request, response) -> false once it has answered, anything else to carry on   (T4)
//   loadHandler(name)       -> the handler for /api/<name>                              (tests)
// T2 (repo source) and T3 (picture folder) need no seam here: they work through settings the
// handlers already read from the environment.

import { createServer } from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { loadVercelConfig } from './headers.mjs'
import { routeNameFor } from './routes.mjs'
import { BodyError, shimRequest, shimResponse } from './vercel-shim.mjs'
import { serveStatic } from './static.mjs'

export const LOOPBACK = '127.0.0.1'
export const DEFAULT_PORT = 4317
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// The only address this server may listen on. Anything else - 0.0.0.0, a LAN address, "localhost"
// (which can mean ::1 or a name someone else controls), an empty string (which means all) - throws.
export function assertLoopback(host) {
  if (host !== LOOPBACK) {
    throw new Error(`The board only listens on ${LOOPBACK}, never on "${host}": nothing else on the network may reach it.`)
  }
}

function sendError(response, status, message) {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify({ error: message }))
}

export function createBoardServer({
  root = ROOT,
  gate = () => true,
  loadHandler = async (name) => (await import(pathToFileURL(join(root, 'api', `${name}.js`)).href)).default
} = {}) {
  const { headers: securityHeaders } = loadVercelConfig(join(root, 'vercel.json'))
  const publicRoot = join(root, 'public')

  async function respond(request, response) {
    // Vercel puts these on every response, files and functions alike. A handler may override one.
    for (const [key, value] of securityHeaders) response.setHeader(key, value)
    shimResponse(response)
    if ((await gate(request, response)) === false) return

    // Cut by hand: new URL('//x', base) reads "x" as a web address and loses the path.
    const pathname = String(request.url).split(/[?#]/)[0]
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      const name = routeNameFor(pathname)
      if (!name) return sendError(response, 404, 'No such endpoint.')
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
      const handler = await loadHandler(name)
      return handler(request, response)
    }

    const served = await serveStatic(publicRoot, request.method, pathname)
    for (const [key, value] of Object.entries(served.headers)) response.setHeader(key, value)
    response.statusCode = served.status
    response.end(request.method === 'HEAD' ? undefined : served.body)
  }

  return createServer((request, response) => {
    respond(request, response).catch((failure) => {
      // The reason goes to this window, never to the page: it could name a path or a setting.
      console.error(`[board] ${request.method} ${String(request.url).split('?')[0]} failed: ${failure?.message ?? failure}`)
      if (!response.headersSent) sendError(response, 500, 'The board hit an error. Look at the window it is running in.')
      else response.destroy()
    })
  })
}

export async function startBoardServer({ port = DEFAULT_PORT, host = LOOPBACK, ...options } = {}) {
  assertLoopback(host)
  const server = createBoardServer(options)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const address = server.address()
      if (address.address !== LOOPBACK) {
        server.close()
        reject(new Error(`The board came up on ${address.address}, not ${LOOPBACK}, and was shut down.`))
        return
      }
      resolve({ server, port: address.port, host: address.address })
    })
  })
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
  try {
    const { port, host } = await startBoardServer(readArgs(process.argv.slice(2)))
    console.log(`Board running at http://${host}:${port}/  (this computer only)`)
    console.log('UNFINISHED: there is no sign-in wall yet. Do not hand this to students. Press Ctrl+C to stop.')
  } catch (failure) {
    console.error(failure.message)
    process.exit(1)
  }
}
