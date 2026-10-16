// Makes a plain Node request/response look like the ones Vercel hands to api/*.js, for exactly
// the parts those files use: request.method / headers / url / query / body, and response.status()
// / json() / send() / setHeader() / end(). Nothing here is board-specific.

export const BODY_LIMIT_BYTES = 4.5 * 1024 * 1024 // Vercel's own cap on a function's request body

export class BodyError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// ?a=1&a=2 -> { a: ['1', '2'] }; ?a=1 -> { a: '1' }. Null-prototype so "__proto__" is just a key.
export function parseQuery(searchParams) {
  const query = Object.create(null)
  for (const [key, value] of searchParams) {
    if (key in query) query[key] = [].concat(query[key], value)
    else query[key] = value
  }
  return query
}

// Read with events, not for-await: leaving a for-await early destroys the request, which resets
// the connection and the sender never sees the 413.
function readBody(request, limit) {
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) return Promise.reject(new BodyError(413, 'Request body too large.'))
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    const onData = (chunk) => {
      size += chunk.length
      if (size > limit) {
        request.off('data', onData)
        reject(new BodyError(413, 'Request body too large.'))
        return
      }
      chunks.push(chunk)
    }
    request.on('data', onData)
    request.once('end', () => resolve(Buffer.concat(chunks)))
    request.once('error', reject)
  })
}

// Vercel's body rules: application/json -> object (bad JSON is a 400 before the handler runs),
// octet-stream -> Buffer, text/* -> string, urlencoded -> object, anything else / no body -> undefined.
export function parseBody(bytes, contentType = '') {
  if (!bytes.length) return undefined
  const type = String(contentType).split(';')[0].trim().toLowerCase()
  if (type === 'application/json') {
    try {
      return JSON.parse(bytes.toString('utf8'))
    } catch {
      throw new BodyError(400, 'Invalid JSON.')
    }
  }
  if (type === 'application/octet-stream') return bytes
  if (type.startsWith('text/')) return bytes.toString('utf8')
  if (type === 'application/x-www-form-urlencoded') return parseQuery(new URLSearchParams(bytes.toString('utf8')))
  return undefined
}

// On Vercel these three are set by the platform and overwrite whatever a caller sends. Here the
// caller is the connection itself: take what it sent away and say who actually connected, or a
// rotating X-Forwarded-For would dodge login.js's guess limit and x-forwarded-host would
// override the same-site check in _lib.js. Called first thing for every request, so the gate and
// the handlers alike see the cleaned headers.
export function cleanForwardingHeaders(request) {
  const peer = request.socket?.remoteAddress ?? 'unknown'
  delete request.headers['x-forwarded-host']
  request.headers['x-real-ip'] = peer
  request.headers['x-forwarded-for'] = peer
}

// Adds query and body to the request. Throws BodyError (status 400 / 413) for the server to send.
export async function shimRequest(request, { limit = BODY_LIMIT_BYTES } = {}) {
  const url = new URL(request.url, 'http://board.invalid')
  request.query = parseQuery(url.searchParams)
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    request.body = parseBody(await readBody(request, limit), request.headers['content-type'])
  }
  return request
}

// Adds status(), json() and send() to the response. status() chains, like Vercel's.
export function shimResponse(response) {
  response.status = (code) => {
    response.statusCode = code
    return response
  }
  // A second answer to the same request is ignored, as it is on Vercel, instead of throwing.
  response.json = (value) => {
    if (response.writableEnded) return response
    if (!response.hasHeader('content-type')) response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.end(JSON.stringify(value))
    return response
  }
  response.send = (value) => {
    if (response.writableEnded) return response
    if (value === undefined || value === null) return response.end()
    if (typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)) return response.json(value)
    if (typeof value === 'string' && !response.hasHeader('content-type')) response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(value)
    return response
  }
  return response
}
