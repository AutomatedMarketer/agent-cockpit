// The home-screen icons — they exist, they are real PNGs, and the page actually asks for them.
//
// The course tells every attendee to bookmark this dashboard on their phone before leaving
// the room, and makes it a physical checkpoint on Day 3. The page shipped with no icon of any
// kind until 2026-08-28, so the one artifact the course insists they keep was the one that
// looked like nothing. These assertions are what stop that coming back: an icon file deleted,
// or a <link> dropped during an edit, fails here rather than on somebody's phone.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const pub = (name) => path.join(root, 'public', name)
const html = readFileSync(pub('index.html'), 'utf8')

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// name -> the square size its IHDR must declare
const PNGS = {
  'favicon.ico': 32,
  'apple-touch-icon.png': 180,
  'icon-192.png': 192,
  'icon-512.png': 512,
  'icon-maskable-512.png': 512
}

test('every icon file the page references exists', () => {
  for (const name of [...Object.keys(PNGS), 'icon.svg', 'manifest.webmanifest']) {
    assert.ok(existsSync(pub(name)), `public/${name} is missing — run: node scripts/build-icons.mjs`)
  }
})

test('the PNGs are real PNGs, at the sizes their names promise', () => {
  for (const [name, size] of Object.entries(PNGS)) {
    const buf = readFileSync(pub(name))
    assert.ok(
      buf.subarray(0, 8).equals(PNG_SIGNATURE),
      `public/${name} does not start with the PNG signature`
    )
    // IHDR width and height live at bytes 16..24, straight after the signature and length+type.
    assert.equal(buf.readUInt32BE(16), size, `public/${name} width should be ${size}`)
    assert.equal(buf.readUInt32BE(20), size, `public/${name} height should be ${size}`)
  }
})

test('the page declares an icon, an apple-touch-icon and a manifest', () => {
  // A file nothing links to is a file no phone ever asks for.
  assert.match(html, /<link rel="icon" href="\/icon\.svg"/, 'no SVG icon link')
  assert.match(html, /<link rel="icon" href="\/favicon\.ico"/, 'no favicon link')
  assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png"/, 'iOS gets a blank tile without this')
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/, 'no web manifest link')
})

test('the manifest names every icon it lists, and each one is on disk', () => {
  const manifest = JSON.parse(readFileSync(pub('manifest.webmanifest'), 'utf8'))
  assert.ok(manifest.name, 'the manifest needs a name — it is what shows under the home-screen tile')
  assert.ok(manifest.icons.length > 0, 'the manifest lists no icons')
  for (const icon of manifest.icons) {
    const name = icon.src.replace(/^\//, '')
    assert.ok(existsSync(pub(name)), `manifest lists ${icon.src}, which does not exist`)
  }
  assert.ok(
    manifest.icons.some((i) => i.purpose === 'maskable'),
    'Android crops a non-maskable icon into a circle and can clip the mark'
  )
})

test('the icons use the stylesheet\'s own background and accent', () => {
  // If someone re-themes the dashboard, the icon should not quietly stay the old colour.
  const bg = html.match(/--bg:\s*(#[0-9a-f]{6})/i)?.[1]?.toLowerCase()
  const accent = html.match(/--accent:\s*(#[0-9a-f]{6})/i)?.[1]?.toLowerCase()
  const svg = readFileSync(pub('icon.svg'), 'utf8').toLowerCase()
  assert.ok(bg && accent, 'could not read --bg / --accent out of index.html')
  assert.ok(svg.includes(bg), `icon.svg does not use --bg ${bg} — re-run scripts/build-icons.mjs`)
  assert.ok(svg.includes(accent), `icon.svg does not use --accent ${accent} — re-run scripts/build-icons.mjs`)

  const manifest = JSON.parse(readFileSync(pub('manifest.webmanifest'), 'utf8'))
  assert.equal(manifest.background_color.toLowerCase(), bg)
  assert.equal(manifest.theme_color.toLowerCase(), bg)
})

test('the unlock form carries a username field so a password manager can save the key', () => {
  // Without it, managers decline to save and the key gets hand-typed on every device —
  // and the course asks people to open this on their phone.
  assert.match(html, /autocomplete="username"/, 'no username field on the unlock form')
  assert.match(html, /autocomplete="current-password"/, 'the key field lost its autocomplete hint')
})
