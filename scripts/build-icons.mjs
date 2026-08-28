// Draws the home-screen icons, with no dependencies.
//
// Run it: node scripts/build-icons.mjs
//
// The course tells every attendee to bookmark this dashboard on their phone before they
// leave the room - it is one of only two things the run of show says out loud on Day 1, and
// a physical checkpoint on Day 3. Until this script existed the page shipped no icon at all,
// so "Add to Home Screen" gave them a blank tile or a generic globe. The one artifact the
// course insists they keep was the one thing that looked like nothing.
//
// iOS ignores SVG for home-screen icons and wants a real PNG, so these are written by hand:
// raw scanlines, deflated with node's own zlib, wrapped in the four PNG chunks. Nothing to
// install, which is the same promise the rest of this repo makes.

import { deflateSync } from 'node:zlib'
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const OUT = path.join(process.cwd(), 'public')

// Straight from the stylesheet at the top of public/index.html. If those change, change these.
const BG = [0x0d, 0x0f, 0x13]
const ACCENT = [0x6e, 0xa8, 0xff]

const SS = 4 // supersample factor, so the circles come out smooth without a graphics library

// The mark is the nav's own glyph - a ring around a dot. It reads at 16px in a browser tab
// and still looks deliberate at 512. Kept inside the middle 80% so Android's maskable crop
// cannot clip it.
function paint(size) {
  const n = size * SS
  const cx = (n - 1) / 2
  const cy = (n - 1) / 2

  const ringOuter = n * 0.34
  const ringInner = n * 0.245
  const dot = n * 0.135

  // One RGB triple per pixel, background first.
  const px = Buffer.alloc(n * n * 3)
  for (let i = 0; i < n * n; i += 1) {
    px[i * 3] = BG[0]
    px[i * 3 + 1] = BG[1]
    px[i * 3 + 2] = BG[2]
  }

  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const d = Math.hypot(x - cx, y - cy)
      const inRing = d <= ringOuter && d >= ringInner
      const inDot = d <= dot
      if (inRing || inDot) {
        const i = (y * n + x) * 3
        px[i] = ACCENT[0]
        px[i + 1] = ACCENT[1]
        px[i + 2] = ACCENT[2]
      }
    }
  }

  // Box-downsample the supersampled buffer to the requested size.
  const out = Buffer.alloc(size * size * 3)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0, g = 0, b = 0
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const i = ((y * SS + sy) * n + (x * SS + sx)) * 3
          r += px[i]; g += px[i + 1]; b += px[i + 2]
        }
      }
      const count = SS * SS
      const o = (y * size + x) * 3
      out[o] = Math.round(r / count)
      out[o + 1] = Math.round(g / count)
      out[o + 2] = Math.round(b / count)
    }
  }
  return out
}

// --- the smallest correct PNG writer that will do the job ---------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function png(size, rgb) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour RGB
  // 10, 11, 12 stay zero: deflate, adaptive filtering, no interlace

  // Each scanline is prefixed with its filter byte. 0 = none, which deflate handles well
  // for flat colour like this.
  const stride = size * 3
  const raw = Buffer.alloc(size * (stride + 1))
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// --- what gets written ---------------------------------------------------------------

const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Agent OS">
  <rect width="512" height="512" fill="${hex(BG)}"/>
  <circle cx="256" cy="256" r="148" fill="none" stroke="${hex(ACCENT)}" stroke-width="48"/>
  <circle cx="256" cy="256" r="69" fill="${hex(ACCENT)}"/>
</svg>
`

const MANIFEST = {
  name: 'Agent OS',
  short_name: 'Agent OS',
  description: 'Your agent team: what ran, what is waiting, and what needs you.',
  start_url: '/',
  display: 'standalone',
  background_color: hex(BG),
  theme_color: hex(BG),
  icons: [
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ]
}

await mkdir(OUT, { recursive: true })

const written = []
async function emit(name, buf) {
  await writeFile(path.join(OUT, name), buf)
  written.push(`${name}  ${buf.length.toLocaleString()} bytes`)
}

await emit('icon.svg', Buffer.from(SVG, 'utf8'))
await emit('manifest.webmanifest', Buffer.from(JSON.stringify(MANIFEST, null, 2) + '\n', 'utf8'))

// 180 is what iOS asks for by name; 192 and 512 are what Android's manifest wants. The
// maskable copy is the same drawing - the mark already sits inside the safe zone.
for (const [name, size] of [
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['icon-maskable-512.png', 512]
]) {
  await emit(name, png(size, paint(size)))
}

// favicon.ico is the one browsers request without being asked. Serving the 192 as a plain
// PNG under that name works everywhere that matters and avoids inventing an ICO writer.
await emit('favicon.ico', png(32, paint(32)))

for (const line of written) console.log(`wrote public/${line}`)
console.log(`\n${written.length} files. Re-run this after changing --bg or --accent in index.html.`)
