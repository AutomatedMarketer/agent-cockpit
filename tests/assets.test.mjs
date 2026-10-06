// The pictures and the typeface the v2 look is drawn with — they are on disk, they are what their
// names say they are, and they stay small enough for a phone on a train.
//
// These are the first binary files in a repo whose .gitattributes says `* text=auto eol=lf`. A
// file git decides is text gets its line endings rewritten on the way in, and a picture with its
// bytes rewritten is not a picture any more - it is a broken image icon in the one place on the
// board meant to look finished. So every check here reads the bytes rather than trusting a name:
// a PNG renamed to .webp, a truncated download, or a file mangled by eol conversion all fail here
// rather than on somebody's phone.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const pub = (...parts) => path.join(root, 'public', ...parts)
const KB = 1024

// The two wide pictures behind the Today and Team headers, and one portrait per template agent.
const BANNERS = ['today-harbour.webp', 'team-workshop.webp']
const PORTRAITS = [
  'content', 'customer-service', 'editor', 'email', 'orchestrator', 'research', 'sales', 'security'
].map((slug) => `agent-${slug}.webp`)

// Budgets, not targets. The banner is on the first screen anybody sees, and every portrait on Team
// loads together - one careless 2 MB export would cost more than the whole rest of the page.
const BANNER_BUDGET = 100 * KB
const PORTRAIT_BUDGET = 45 * KB
const ART_TOTAL_BUDGET = 450 * KB
const FONT_BUDGET = 64 * KB

// A WebP is a RIFF container: "RIFF", a little-endian length of everything after those eight
// bytes, then "WEBP". The length is what makes this a real check - a file that was truncated, or
// had bytes added or removed by line-ending conversion, still starts with the magic but no longer
// adds up.
function webpProblem(buf) {
  if (buf.length < 12) return 'is too short to be a WebP'
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') {
    return `starts with ${JSON.stringify(buf.toString('latin1', 0, 12))}, not a RIFF/WEBP header`
  }
  const declared = buf.readUInt32LE(4) + 8
  if (declared !== buf.length) return `says it is ${declared} bytes but is ${buf.length}`
  return null
}

test('every art file is a real webp under its budget', () => {
  const onDisk = readdirSync(pub('art')).sort()
  // Only WebP ships. The mock-up folder these came from also holds the full-size PNG masters, at
  // well over a megabyte each, and they are not for a phone.
  for (const name of onDisk) {
    assert.ok(name.endsWith('.webp'), `public/art/${name} is not a .webp - only the compressed pictures ship`)
  }
  for (const name of [...BANNERS, ...PORTRAITS]) {
    assert.ok(onDisk.includes(name), `public/art/${name} is missing`)
  }

  let total = 0
  for (const name of onDisk) {
    const buf = readFileSync(pub('art', name))
    const problem = webpProblem(buf)
    assert.equal(problem, null, `public/art/${name} ${problem}`)
    const budget = BANNERS.includes(name) ? BANNER_BUDGET : PORTRAIT_BUDGET
    assert.ok(buf.length <= budget, `public/art/${name} is ${buf.length} bytes, over its ${budget / KB} KB budget`)
    total += buf.length
  }
  assert.ok(total <= ART_TOTAL_BUDGET, `the art adds up to ${total} bytes, over the ${ART_TOTAL_BUDGET / KB} KB budget`)
})

test('the font is a real woff2 under 64 KB with its licence beside it', () => {
  const fontPath = pub('fonts', 'inter-latin-var.woff2')
  assert.ok(existsSync(fontPath), 'public/fonts/inter-latin-var.woff2 is missing')
  const buf = readFileSync(fontPath)
  assert.equal(buf.toString('latin1', 0, 4), 'wOF2', 'the font does not start with the woff2 signature')
  // Bytes 8..12 of a woff2 header are the total file length, big-endian - the same truncation and
  // eol-corruption check the pictures get.
  assert.equal(buf.readUInt32BE(8), buf.length, 'the font header disagrees with the file size')
  assert.ok(buf.length <= FONT_BUDGET, `the font is ${buf.length} bytes, over the ${FONT_BUDGET / KB} KB budget`)

  // Inter is under the SIL Open Font License, which lets it be bundled on one condition: the
  // licence travels with it. Shipping the font without this file is the one way to use it wrongly.
  const licencePath = pub('fonts', 'OFL.txt')
  assert.ok(existsSync(licencePath), 'public/fonts/OFL.txt is missing - the font may only ship with its licence')
  assert.match(readFileSync(licencePath, 'utf8'), /SIL OPEN FONT LICENSE/)
})

test('git treats the pictures and the font as binary, so it never rewrites their bytes', (t) => {
  // Asks git itself rather than reading .gitattributes as text: what matters is what git will do
  // to these files on the next commit or checkout, and a line that is present but overridden, or
  // misspelt, would read fine and protect nothing.
  const files = [`public/art/${BANNERS[0]}`, 'public/fonts/inter-latin-var.woff2']
  const result = spawnSync('git', ['check-attr', 'binary', '--', ...files], { cwd: root, encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    t.skip('git is not available here, so there is nothing to ask')
    return
  }
  for (const file of files) {
    assert.match(result.stdout, new RegExp(`^${file.replace(/[.]/g, '\\.')}: binary: set$`, 'm'),
      `${file} is not marked binary, so eol=lf may rewrite its bytes`)
  }
})
