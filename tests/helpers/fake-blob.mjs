// An in-memory stand-in for @vercel/blob, so no test ever loads the real SDK or touches a network.
//
// It honours the two rules the picture store leans on, the way the real service does:
// - put() onto an existing pathname throws unless allowOverwrite is true;
// - put() with ifMatch throws BlobPreconditionFailedError unless the stored etag matches.
// Every call is recorded, so a test can say which paths were touched, with what access, and
// that list() was never called at all.

export class BlobError extends Error {
  constructor(message) {
    super(`Vercel Blob: ${message}`)
  }
}

// The real SDK's classes and messages (2.8.0, dist/chunk-YYMLUMXS.js), so the wrapper's
// error-to-sentence mapping is tested against the shapes it will actually meet.
export class BlobAccessError extends BlobError { constructor() { super('Access denied, please provide a valid token for this resource.') } }
export class BlobStoreNotFoundError extends BlobError { constructor() { super('This store does not exist.') } }
export class BlobStoreSuspendedError extends BlobError { constructor() { super('This store has been suspended.') } }
export class BlobServiceNotAvailable extends BlobError { constructor() { super('The blob service is currently not available. Please try again.') } }
export class BlobServiceRateLimited extends BlobError { constructor() { super('Too many requests please lower the number of concurrent requests.') } }
export class BlobRequestAbortedError extends BlobError { constructor() { super('The request was aborted.') } }
export class BlobFileTooLargeError extends BlobError { constructor(message) { super(`File is too large, ${message}.`) } }
export class BlobNotFoundError extends BlobError { constructor() { super('The requested blob does not exist') } }
export class BlobUnknownError extends BlobError { constructor() { super('Unknown error, please visit https://vercel.com/help.') } }
export class BlobPreconditionFailedError extends BlobError { constructor() { super('Precondition failed: ETag mismatch.') } }

export function fakeBlob() {
  const files = new Map()
  const calls = { put: [], get: [], del: [], list: [], head: [] }
  let serial = 0
  // Set by a test to make the next call of that kind throw this error instead.
  const failNext = {}

  const takeFailure = (kind) => {
    const failure = failNext[kind]
    delete failNext[kind]
    if (failure) throw failure
  }

  const sdk = {
    BlobError,
    BlobAccessError,
    BlobStoreNotFoundError,
    BlobStoreSuspendedError,
    BlobServiceNotAvailable,
    BlobServiceRateLimited,
    BlobRequestAbortedError,
    BlobFileTooLargeError,
    BlobNotFoundError,
    BlobUnknownError,
    BlobPreconditionFailedError,

    async put(pathname, body, options = {}) {
      calls.put.push({ pathname, options: { ...options } })
      takeFailure('put')
      if (options.ifMatch && options.allowOverwrite === false) {
        throw new BlobError('ifMatch and allowOverwrite: false are contradictory.')
      }
      const existing = files.get(pathname)
      if (options.ifMatch !== undefined && existing?.etag !== options.ifMatch) {
        throw new BlobPreconditionFailedError()
      }
      if (existing && !options.allowOverwrite && options.ifMatch === undefined) {
        throw new BlobError('This blob already exists, use `allowOverwrite: true` if you want to overwrite it.')
      }
      serial += 1
      const etag = `"etag-${serial}"`
      const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body)
      files.set(pathname, { bytes, contentType: options.contentType ?? 'application/octet-stream', etag, access: options.access })
      return { pathname, url: `https://fake.${options.access}.blob.example/${pathname}`, contentType: options.contentType, etag }
    },

    async get(pathname, options = {}) {
      calls.get.push({ pathname, options: { ...options } })
      takeFailure('get')
      const file = files.get(pathname)
      if (!file) return null
      // Two chunks, so a reader that only looks at the first one is caught.
      const half = Math.ceil(file.bytes.length / 2)
      const parts = [file.bytes.subarray(0, half), file.bytes.subarray(half)].filter((part) => part.length)
      const stream = new ReadableStream({
        start(controller) {
          for (const part of parts) controller.enqueue(new Uint8Array(part))
          controller.close()
        }
      })
      return {
        statusCode: 200,
        stream,
        headers: new Headers({ etag: file.etag }),
        blob: { pathname, contentType: file.contentType, etag: file.etag, size: file.bytes.length }
      }
    },

    async del(pathname, options = {}) {
      calls.del.push({ pathname, options: { ...options } })
      takeFailure('del')
      for (const one of [pathname].flat()) files.delete(one)
    },

    async list() {
      calls.list.push([...arguments])
      throw new Error('list() must never be called: it is an advanced operation, and settings.json is the index')
    },

    async head(pathname) {
      calls.head.push(pathname)
      throw new Error('head() is not used by the picture store')
    }
  }

  // Everything any call touched, for "every path starts agent-cockpit/".
  const touched = () => [...calls.put, ...calls.get, ...calls.del].flatMap((call) => [call.pathname].flat())

  return { sdk, files, calls, failNext, touched }
}
