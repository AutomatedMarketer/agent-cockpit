// The board's first page costs a phone at most 272 KB - the budget every lazy file on this board exists
// to keep (memory-graph.js, memory-find.js and the graph libraries load only when asked for).
//
// Counted the way the browser measurement (Today at 390 px, every response but /api/*) counts it: what
// the page asks for before anybody opens anything - the page itself, its scripts, what it preloads, its
// fonts - with text as Vercel sends it (compressed; gzip at level 9 here) and pictures and fonts as they
// are. On 2026-10-11 that was 254.6 KB: index.html 31.6, app.js 119.5, the Today picture 56.4, Inter 47.1.
// On 2026-10-15 Nuno raised it to 270: the board had grown to 260.3 KB (app.js 125.1) with the restart line
// and the clock-true greeting.
// On 2026-10-18 to 271 for the Codex worker (T14): the run buttons, the voice order and the status words cost the page
// 0.5 KB, and the board had 0.04 KB to spare.
// On 2026-10-18 to 272 for the local board's own words ("this computer", the plain tool names): about 1 KB.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const PUBLIC = new URL('../public/', import.meta.url)
const BUDGET_KB = 272
const TEXT = /\.(html|js|css|svg|json)$/

const html = readFileSync(new URL('index.html', PUBLIC), 'utf8')
const sizeOf = (path) => {
  const bytes = readFileSync(new URL(path.replace(/^\//, ''), PUBLIC))
  return TEXT.test(path) ? gzipSync(bytes, { level: 9 }).length : bytes.length
}

// What index.html makes the browser fetch before anything is opened.
function firstPaintFiles() {
  const found = new Set(['/index.html'])
  for (const match of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) found.add(match[1])
  for (const match of html.matchAll(/<link[^>]*\srel="(?:preload|stylesheet)"[^>]*\shref="([^"]+)"/g)) found.add(match[1])
  for (const match of html.matchAll(/url\(['"]?(\/fonts\/[^'")]+)['"]?\)/g)) found.add(match[1])
  return [...found].filter((path) => path.startsWith('/'))
}

test(`the first page is at most ${BUDGET_KB} KB, compressed text and pictures as they are`, () => {
  const files = firstPaintFiles()
  for (const expected of ['/index.html', '/app.js', '/art/today-harbour.webp', '/fonts/inter-latin-var.woff2']) {
    assert.ok(files.includes(expected), `${expected} was not counted: the sweep is checking less than the page loads`)
  }
  for (const lazy of ['/memory-graph.js', '/memory-find.js']) assert.ok(!files.includes(lazy), `${lazy} is on the first page`)
  assert.ok(!files.some((path) => path.startsWith('/vendor/')), 'a graph library is on the first page')
  const sizes = Object.fromEntries(files.map((path) => [path, sizeOf(path)]))
  const total = Object.values(sizes).reduce((sum, size) => sum + size, 0)
  const said = Object.entries(sizes).map(([path, size]) => `${path} ${(size / 1024).toFixed(1)}`).join(', ')
  assert.ok(total <= BUDGET_KB * 1024, `the first page is ${(total / 1024).toFixed(1)} KB, over ${BUDGET_KB}: ${said}`)
})
