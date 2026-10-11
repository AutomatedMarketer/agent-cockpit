// The two graph libraries the Memory screen draws with: 3d-force-graph 1.80.0 for a computer and
// force-graph 1.51.4 (flat) for a phone, both MIT, both by the same author, approved by Nuno for this
// one use (decision D4, 2026-10-10).
//
// They are files in public/vendor/, copied byte for byte from npm, because the page's policy lets
// scripts come from this site only - no CDN. They are pinned here by their hash, so a different file
// can only arrive on purpose. Neither is on the first page: the page asks for one the first time
// someone opens Memory, then Graph (tests/graph-ui.test.mjs holds that behaviour). Each is a bundle of
// many small packages, and every one of their licences asks for its notice to be kept with the code,
// so THIRD-PARTY-LICENSES.txt carries them all.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, ROOT))
const VENDOR = 'public/vendor/'

const LIBRARIES = {
  '3d-force-graph-1.80.0.min.js': {
    sha256: 'd96e738edcca580edd524730c1c6b05ed2efce028c23ca95db1bf43033a72e42',
    bytes: 1313897,
    banner: '// Version 1.80.0 3d-force-graph - https://github.com/vasturiano/3d-force-graph',
    global: 'ForceGraph3D'
  },
  'force-graph-1.51.4.min.js': {
    sha256: '1008539bb9e171a0dc343453366451a1b3a6ded06028ef4f978608b658ba2d0a',
    bytes: 177599,
    banner: '// Version 1.51.4 force-graph - https://github.com/vasturiano/force-graph',
    global: 'ForceGraph'
  }
}

// Read from each library's own source map (dist/*.js.map, "sources") on 2026-10-10.
const BUNDLED = {
  '3d-force-graph-1.80.0.min.js': ['3d-force-graph', '@babel/runtime', '@tweenjs/tween.js', 'accessor-fn', 'd3-array', 'd3-binarytree', 'd3-dispatch',
    'd3-force-3d', 'd3-octree', 'd3-quadtree', 'd3-scale', 'd3-scale-chromatic', 'd3-selection', 'd3-timer', 'data-bind-mapper', 'float-tooltip',
    'internmap', 'kapsule', 'lodash-es', 'ngraph.events', 'ngraph.forcelayout', 'ngraph.graph', 'ngraph.merge', 'ngraph.random', 'polished', 'preact',
    'style-inject', 'three', 'three-forcegraph', 'three-render-objects', 'tinycolor2'],
  'force-graph-1.51.4.min.js': ['force-graph', '@tweenjs/tween.js', 'accessor-fn', 'bezier-js', 'canvas-color-tracker', 'd3-array', 'd3-binarytree',
    'd3-color', 'd3-dispatch', 'd3-drag', 'd3-ease', 'd3-force-3d', 'd3-interpolate', 'd3-octree', 'd3-quadtree', 'd3-scale', 'd3-scale-chromatic',
    'd3-selection', 'd3-timer', 'd3-transition', 'd3-zoom', 'float-tooltip', 'index-array-by', 'internmap', 'kapsule', 'lodash-es', 'preact',
    'style-inject', 'tinycolor2']
}
const PERMISSIVE = ['MIT', 'ISC', 'BSD-3-Clause']

test('each library is the exact file npm publishes, pinned by its hash', () => {
  for (const [name, expected] of Object.entries(LIBRARIES)) {
    const bytes = read(`${VENDOR}${name}`)
    assert.equal(bytes.length, expected.bytes, `${name} is not the size npm publishes`)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256, `${name} is not the file npm publishes`)
    const text = bytes.toString('utf8')
    assert.ok(text.startsWith(expected.banner), `${name} does not open with its own version line`)
    assert.ok(text.includes(`.${expected.global}=`), `${name} does not define ${expected.global} for the page to use`)
  }
})

test('the folder holds the two libraries and their notices, and nothing else', () => {
  const files = readdirSync(fileURLToPath(new URL(VENDOR, ROOT))).sort()
  assert.deepEqual(files, ['3d-force-graph-1.80.0.min.js', 'THIRD-PARTY-LICENSES.txt', 'force-graph-1.51.4.min.js'])
})

test('the notices name every package in each bundle, each with its own licence text', () => {
  const notices = read(`${VENDOR}THIRD-PARTY-LICENSES.txt`).toString('utf8')
  const sections = new Map()
  const blocks = notices.split(/^={20,}$/m)
  // Each notice is a rule, a header line, a rule, then the text.
  for (let index = 1; index + 1 < blocks.length; index += 2) {
    const header = blocks[index].trim()
    const match = /^(\S+) (\d+\.\d+\.\d+\S*) - (\S+)/.exec(header)
    assert.ok(match, `a notice header does not read "name version - licence": ${header}`)
    sections.set(match[1], { version: match[2], licence: match[3], text: blocks[index + 1].trim() })
  }
  for (const [file, names] of Object.entries(BUNDLED)) {
    const listed = new RegExp(`^In ${file.replace(/[.]/g, '\\.')}: (.+)\\.$`, 'm').exec(notices)
    assert.ok(listed, `the notices do not list what is in ${file}`)
    assert.deepEqual(listed[1].split(', ').sort(), [...names].sort(), `the notices list the wrong packages for ${file}`)
    for (const name of names) {
      const section = sections.get(name)
      assert.ok(section, `${name} is in ${file} and has no notice`)
      assert.ok(PERMISSIVE.includes(section.licence), `${name} is under ${section.licence}, which nobody approved`)
      assert.match(section.text, /copyright/i, `${name}'s notice has no copyright line`)
      assert.ok(section.text.length > 300, `${name}'s notice is not a whole licence text`)
    }
  }
  assert.equal(sections.get('3d-force-graph').version, '1.80.0')
  assert.equal(sections.get('force-graph').version, '1.51.4')
  for (const [name, { sha256 }] of Object.entries(LIBRARIES)) {
    assert.ok(notices.includes(name) && notices.includes(sha256), `the notices do not say which file ${name} is`)
  }
})

test('neither library is on the board\'s first page: the markup never names the vendor folder', () => {
  const html = read('public/index.html').toString('utf8')
  assert.ok(!html.includes('/vendor/'), 'index.html loads a graph library with the board')
  assert.ok(!/<link[^>]+(preload|prefetch)[^>]+vendor/i.test(html))
  // Nor the graph's own drawing code, which comes with them.
  assert.ok(!html.includes('memory-graph.js'), 'index.html loads the graph view with the board')
})

test('the flat library never builds code from text; the 3D one only in the layout engine the board never picks', () => {
  // The policy has no 'unsafe-eval', so a library that built code from text would fail in the browser.
  // The flat one has none. The 3D one has six, all in the ngraph layout engine, which runs only when a
  // page asks for forceEngine('ngraph'); the board asks for 'd3' (tests/graph-ui.test.mjs).
  const flat = read(`${VENDOR}force-graph-1.51.4.min.js`).toString('utf8')
  assert.equal(flat.split('new Function').length - 1, 0)
  assert.equal(flat.split('eval(').length - 1, 0)
  const deep = read(`${VENDOR}3d-force-graph-1.80.0.min.js`).toString('utf8')
  assert.equal(deep.split('new Function').length - 1, 6)
  assert.equal((deep.match(/\beval\(/g) ?? []).length, 0)
})

test('git keeps the vendored files as bytes: never a line ending rewritten under the pinned hash', () => {
  const attributes = read('.gitattributes').toString('utf8').split(/\r?\n/).map((line) => line.trim())
  assert.ok(attributes.includes('public/vendor/*.js -text -diff'), '.gitattributes does not keep public/vendor/*.js as bytes')
})
