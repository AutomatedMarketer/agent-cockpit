// What the four personalise endpoints' tests share: a connected in-memory store, requests that
// look like the board's own page made them, and a response that records everything sent.
//
// Every handler is built with makeHandler({ store, env, now }), so a test hands in the fake
// store, its own environment and its own clock - nothing here touches process.env, the real
// SDK or the network.

import { pictureStore } from '../../api/_picture-store.js'
import { fakeBlob } from './fake-blob.mjs'

export const VIEW_KEY = 'a-long-enough-view-key'
export const STORE_ENV = { VIEW_KEY, BLOB_STORE_ID: 'store_fake' }
export const NOON = () => new Date('2026-10-06T12:00:00Z')

// A minimal valid header for each format the board accepts - type AND pixel size, which is what
// imageSize reads - padded to `size` bytes. Every one is `side` pixels square (480 unless asked).
const pad = (head, size) => Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length))])
const le16 = (value) => Buffer.from([value & 0xff, (value >> 8) & 0xff])
const be16 = (value) => Buffer.from([(value >> 8) & 0xff, value & 0xff])
const be32 = (value) => Buffer.from([(value >>> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff])
export const webp = (size = 64, side = 480) =>
  pad(Buffer.concat([
    Buffer.from('RIFF'), Buffer.from([26, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.from([10, 0, 0, 0]),
    Buffer.from([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a]), le16(side), le16(side)
  ]), size)
export const png = (size = 64, side = 480) =>
  pad(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'),
    be32(side), be32(side), Buffer.from([8, 6, 0, 0, 0])
  ]), size)
export const jpeg = (size = 64, side = 480) =>
  pad(Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0]),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]), be16(side), be16(side), Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])
  ]), size)

export function connectedStore(env = STORE_ENV, fakeOptions = {}) {
  const fake = fakeBlob(fakeOptions)
  let loads = 0
  const store = pictureStore(env, async () => {
    loads += 1
    return fake.sdk
  })
  return { fake, store, loads: () => loads }
}

// Every store call of any kind, so "refused before any store call" is one assertion.
export const storeCalls = (fake) =>
  fake.calls.get.length + fake.calls.put.length + fake.calls.del.length + fake.calls.list.length + fake.calls.head.length

export function fakeResponse() {
  return {
    statusCode: null,
    body: null,
    sent: null,
    headers: {},
    setHeader(key, value) {
      this.headers[key] = value
      return this
    },
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return this
    },
    end(bytes) {
      this.sent = bytes ?? null
      return this
    }
  }
}

// The board's own page: the view key, and no Origin or Sec-Fetch-Site that says otherwise.
export const asTheBoard = (headers = {}) => ({ 'x-view-key': VIEW_KEY, ...headers })

export async function call(handler, request) {
  const response = fakeResponse()
  await handler({ method: 'GET', headers: {}, query: {}, ...request }, response)
  return response
}

// Everything a response carried, as text, for "this never appears anywhere in it".
export const everythingSent = (response) =>
  JSON.stringify(response.body) +
  JSON.stringify(response.headers) +
  (response.sent ? Buffer.from(response.sent).toString('latin1') : '')
