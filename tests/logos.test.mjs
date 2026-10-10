// Tool tiles: a tile beside every tool the board names (look and feel, T7).
//
// Nuno's decision (2026-10-10): our own letter tiles everywhere - a soft wash of the brand's colour
// and its first letter, because a colour is not a logo - and a real mark ONLY for GitHub and Vercel,
// whose own rules let a site show that it uses them. Those two are Simple Icons 16.32.0 drawings
// (CC0), unmodified, in the one plain colour each allows. Anthropic and Google ask for approval
// first, Node.js forbids colour variations, Obsidian asks for commercial use, and Simple Icons'
// "Hermes" is another company: all of those stay letters. docs/logo-rules.md has each rule's page.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cssRules } from './helpers/css-rules.mjs'
import { loadPage, script } from './helpers/page-harness.mjs'
import { basePayload } from './helpers/page-payload.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const logosDir = `${root}/public/logos`
const page = loadPage({ payload: basePayload(), expose: ['BRANDS', 'brandOf', 'brandTileHtml', 'LOGO_CREDITS'] })
const { BRANDS, brandOf, brandTileHtml, LOGO_CREDITS } = page.exposed
const ALLOWED_MARKS = ['github', 'vercel']
// Brands whose own rules do not let this board show their mark (or that Simple Icons gets wrong).
const DENIED = ['anthropic', 'claude', 'claudecode', 'openai', 'chatgpt', 'slack', 'gmail', 'googlecalendar', 'googledrive', 'google', 'nodedotjs', 'node', 'obsidian', 'hermes', 'git', 'codex']

test('the marks are exactly GitHub and Vercel: every mark in the map has its file, and no file is outside the map', () => {
  const files = readdirSync(logosDir).filter((name) => name.endsWith('.svg')).map((name) => name.slice(0, -4)).sort()
  const marked = BRANDS.filter((brand) => brand.mark).map((brand) => brand.key).sort()
  assert.deepEqual(marked, ALLOWED_MARKS, 'a mark is in the map that Nuno did not approve')
  assert.deepEqual(files, ALLOWED_MARKS, 'public/logos/ holds a file that is not an approved mark')
  for (const name of readdirSync(logosDir)) assert.ok(name.endsWith('.svg'), `public/logos/${name} is not a logo file`)
})

test('each logo file is small, plain and inert: an svg with a title and a path, nothing that runs or fetches', () => {
  let total = 0
  for (const key of ALLOWED_MARKS) {
    const file = `${logosDir}/${key}.svg`
    const text = readFileSync(file, 'utf8')
    total += statSync(file).size
    assert.ok(statSync(file).size <= 3 * 1024, `${key}.svg is over 3 KB`)
    assert.match(text, /^<svg /, `${key}.svg does not start with <svg`)
    assert.match(text, /<title>[^<]+<\/title>/, `${key}.svg has no title`)
    for (const banned of [/<script/i, /\son\w+\s*=/i, /href/i, /style/i, /<image/i, /url\(/i, /<foreignObject/i]) {
      assert.doesNotMatch(text, banned, `${key}.svg contains ${banned}`)
    }
    // Only these elements: the drawing as Simple Icons ships it, stripped of nothing but attributes.
    for (const [, tag] of text.matchAll(/<([a-zA-Z]+)/g)) assert.ok(['svg', 'title', 'path'].includes(tag), `${key}.svg has a <${tag}>`)
  }
  assert.ok(total <= 30 * 1024)
})

test('no mark ships for a brand whose rules do not allow it, and none is in the map', () => {
  const files = readdirSync(logosDir).map((name) => name.replace(/\.svg$/, '').toLowerCase())
  for (const denied of DENIED) {
    assert.ok(!files.includes(denied), `public/logos/${denied}.svg ships against that brand's rules`)
    const brand = BRANDS.find((one) => one.key === denied)
    if (brand) assert.ok(!brand.mark, `${denied} is drawn as a mark`)
  }
})

test('Hermes is always our own tile: never a mark, never the colour of the unrelated company Simple Icons calls Hermes', () => {
  for (const name of ['Hermes', 'hermes', 'Hermes Agent']) {
    const brand = brandOf(name)
    assert.ok(brand, `${name} has no tile of its own`)
    assert.ok(!brand.mark)
    assert.notEqual(String(brand.hex ?? '').toLowerCase(), '#0091cd')
  }
})

test('names match the way the wall writes them, and anything unknown keeps a plain letter', () => {
  const key = (name) => brandOf(name)?.key ?? null
  assert.equal(key('claude.ai Gmail'), 'gmail')
  assert.equal(key('plugin:marketing:gmail'), 'gmail')
  assert.equal(key('plugin:marketing:notion'), 'notion')
  assert.equal(key('plugin:marketing:google calendar'), 'googlecalendar')
  assert.equal(key('claude.ai Google Drive'), 'googledrive')
  assert.equal(key('github'), 'github')
  assert.equal(key('GitHub CLI'), 'github')
  assert.equal(key('claude.ai Vercel'), 'vercel')
  assert.equal(key('plugin:vercel:vercel'), 'vercel')
  assert.equal(key('n8n-mcp'), 'n8n')
  assert.equal(key('Claude Code'), 'claude')
  assert.equal(key('Claude Max'), 'claude')
  assert.equal(key('Node.js'), 'nodejs')
  assert.equal(key('Fish Audio'), 'fishaudio')
  for (const unknown of ['team-tools', 'claude.ai Gohighleve MCP Server', 'context7', 'old-crm', '', null]) assert.equal(key(unknown), null, `${unknown} matched a brand`)
  // A name that only starts like a brand, without a space after it, is not that brand.
  assert.equal(key('github-mirror-ish'), null)
})

test('a tile is decoration: hidden from a screen reader, its letter the name\'s own, a mark only with a letter under it', () => {
  const plain = brandTileHtml('team-tools', 'found-tile')
  assert.equal(plain, '<span class="tile found-tile" aria-hidden="true">T</span>')
  const gmail = brandTileHtml('claude.ai Gmail', 'found-tile')
  assert.equal(gmail, '<span class="tile found-tile" aria-hidden="true" style="--tile:#EA4335">G</span>')
  const github = brandTileHtml('github', 'found-tile')
  assert.equal(github, '<span class="tile found-tile has-mark" aria-hidden="true" style="--tile:#181717"><span class="tile-letter">G</span><span class="tile-mark mark-github"></span></span>')
  const hostile = brandTileHtml('<img src=x onerror=alert(1)>', 'found-tile')
  assert.ok(!hostile.includes('<img'), 'a hostile name reached the tile as markup')
  for (const brand of BRANDS) {
    assert.ok(brand.hex === undefined || /^#[0-9A-F]{6}$/.test(brand.hex), `${brand.key} has a colour that is not a plain hex`)
    assert.ok(brand.tone === undefined || /^[a-z-]+$/.test(brand.tone), `${brand.key} has a tone that is not a token name`)
  }
})

/* The letter's colour is the brand's, pulled toward the ink by --tile-ink, on a tile washed 20% with
   the same colour - so every brand hex is measured, both themes, with the WCAG formula. */
const channel = (value) => {
  const unit = value / 255
  return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
}
const rgbOf = (hex) => {
  const number = parseInt(hex.slice(1), 16)
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255]
}
const luminance = ([red, green, blue]) => 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
const contrast = (one, two) => {
  const [light, dark] = [luminance(one), luminance(two)].sort((a, b) => b - a)
  return (light + 0.05) / (dark + 0.05)
}
const mix = (a, b, shareOfB) => a.map((value, index) => Math.round(value * (1 - shareOfB) + b[index] * shareOfB))
const declarations = (rule) => Object.fromEntries(rule.body.split(';').map((part) => part.trim()).filter(Boolean)
  .map((part) => [part.slice(0, part.indexOf(':')).trim(), part.slice(part.indexOf(':') + 1).trim()]))

test('every tile letter clears 4.5:1 on its own tile, for every brand colour, in both themes', () => {
  const rules = cssRules()
  const tile = Object.assign({}, ...rules.filter((rule) => !rule.inMedia && rule.selector === '.tile').map(declarations))
  assert.equal(tile.color, 'color-mix(in srgb, var(--tile), var(--ink) var(--tile-ink))', 'the tile letter is no longer the measured formula')
  assert.equal(tile.background, 'color-mix(in srgb, var(--tile) 20%, var(--panel))', 'the tile wash is no longer the measured formula')
  const dark = declarations(rules[0])
  const light = declarations(rules.find((rule) => rule.selector === ':root[data-theme="light"]'))
  const failures = []
  for (const [theme, tokens] of [['dark', dark], ['light', light]]) {
    const share = Number(/^(\d+)%$/.exec(tokens['--tile-ink'])[1]) / 100
    const ink = rgbOf(tokens['--ink'])
    const panel = rgbOf(tokens['--panel'])
    const colours = [...BRANDS.map((brand) => [brand.key, brand.hex ?? tokens[`--${brand.tone}`]]), ['unknown', tokens['--muted']]]
    for (const [name, hex] of colours) {
      assert.match(hex ?? '', /^#[0-9a-f]{6}$/i, `${name} has no colour in the ${theme} theme`)
      const brand = rgbOf(hex)
      const ratio = contrast(mix(brand, ink, share), mix(panel, brand, 0.2))
      if (ratio < 4.5) failures.push(`${theme}: ${name} ${ratio.toFixed(2)}:1`)
    }
  }
  assert.deepEqual(failures, [], `tile letters under 4.5:1:\n${failures.join('\n')}`)
})

test('a browser that cannot mask shows the letter, never an empty tile; the mark is the plain mark colour', () => {
  const rules = cssRules()
  const mark = Object.assign({}, ...rules.filter((rule) => !rule.inMedia && rule.selector === '.tile-mark').map(declarations))
  assert.equal(mark.display, 'none', 'the mark shows where masks may not work')
  const hiding = rules.filter((rule) => /\.tile-letter/.test(rule.selector) && /display:\s*none/.test(rule.body))
  assert.ok(hiding.length, 'the letter is never put away for the mark')
  for (const rule of hiding) assert.match(rule.condition, /@supports .*mask-image/, `${rule.selector} hides the letter without checking masks work`)
  const drawn = rules.filter((rule) => rule.selector === '.tile-mark' && /@supports/.test(rule.condition ?? ''))
  assert.ok(drawn.some((rule) => declarations(rule).background === 'var(--mark-mono)'), 'the mark is not drawn in the one plain colour its brand allows')
  for (const key of ALLOWED_MARKS) {
    assert.ok(rules.some((rule) => rule.selector === `.mark-${key}` && rule.body.includes(`url('/logos/${key}.svg')`)), `.mark-${key} does not point at its own file`)
  }
})

test('the credits line names the owners, Simple Icons, and Vercel\'s required sentence word for word', () => {
  assert.match(LOGO_CREDITS, /^Product names and logos belong to their owners\./)
  assert.match(LOGO_CREDITS, /no endorsement is implied/)
  assert.match(LOGO_CREDITS, /Logo drawings from Simple Icons \(CC0\)\./)
  assert.ok(LOGO_CREDITS.includes('Vercel, the Vercel design, Next.js and related marks, designs and logos are trademarks or registered trademarks of Vercel, Inc. or its affiliates in the US and other countries.'))
  assert.ok(script.includes('class="found-note logo-credits"'), 'the credits are not on the Connections wall')
  const readme = readFileSync(`${root}/README.md`, 'utf8')
  assert.ok(readme.includes('Vercel, the Vercel design, Next.js and related marks, designs and logos are trademarks or registered trademarks of Vercel, Inc. or its affiliates in the US and other countries.'), 'the README does not carry Vercel\'s attribution sentence')
  const rulesDoc = readFileSync(`${root}/docs/logo-rules.md`, 'utf8')
  for (const brand of ['GitHub', 'Vercel', 'Anthropic', 'Google', 'Node.js', 'Obsidian', 'Git']) assert.match(rulesDoc, new RegExp(`\\| \\*\\*${brand.replace('.', '\\.')}`), `docs/logo-rules.md has no row for ${brand}`)
})
