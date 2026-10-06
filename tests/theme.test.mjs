// Light and dark, the colour tokens both are built from, and the typeface.
//
// The board was dark-only with its colours written straight into the rules, so a light theme was
// not a switch away - it was a hunt through every rule for a hex value. These hold the shape that
// makes a theme cheap and safe: every colour is a token, every token has a light value, the light
// values are the same wherever they are written, and every colour that carries words is readable on
// every surface it sits on. Readable is measured, with the WCAG contrast formula, not eyeballed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cssRules, sheetText } from './helpers/css-rules.mjs'
import { AGENT_PALETTE } from '../api/lib.js'

const pagePath = fileURLToPath(new URL('../public/index.html', import.meta.url))
const html = readFileSync(pagePath, 'utf8')
const script = html.match(/<script>([\s\S]*)<\/script>/)[1]

// The same comment-stripped text cssRules reads, so a rule's `at` can be looked up in it.
const sheet = sheetText()

const DARK = ':root'
const LIGHT_BY_OS = ':root:not([data-theme="dark"])'
const LIGHT_BY_CHOICE = ':root[data-theme="light"]'
const TOKEN_BLOCKS = new Set([DARK, LIGHT_BY_OS, LIGHT_BY_CHOICE])

const declarations = (rule) => Object.fromEntries(rule.body.split(';')
  .map((part) => part.trim()).filter(Boolean)
  .map((part) => [part.slice(0, part.indexOf(':')).trim(), part.slice(part.indexOf(':') + 1).trim()]))

const tokenBlocks = () => {
  const rules = cssRules()
  // The FIRST rule of the sheet, and unconditional: icons.test.mjs reads the first --bg in the file
  // as the dark background, so the dark block moving down the sheet would quietly repaint the icon.
  const dark = rules[0]
  assert.equal(dark.selector, DARK, 'the dark token block is no longer the first rule in the sheet')
  assert.equal(dark.inMedia, false, 'the dark token block is behind a condition')
  const byOs = rules.filter((rule) => rule.selector === LIGHT_BY_OS)
  const byChoice = rules.filter((rule) => rule.selector === LIGHT_BY_CHOICE)
  assert.equal(byOs.length, 1, `expected one ${LIGHT_BY_OS} block, found ${byOs.length}`)
  assert.equal(byChoice.length, 1, `expected one ${LIGHT_BY_CHOICE} block, found ${byChoice.length}`)
  return { dark, byOs: byOs[0], byChoice: byChoice[0] }
}

test('the light theme sets every token the dark one does, the same values in both places', () => {
  const { dark, byOs, byChoice } = tokenBlocks()

  // Following the phone only works inside the light media query - unconditionally it would make
  // everyone light - and a stored choice only works OUTSIDE it, or choosing light on a dark phone
  // would do nothing.
  assert.equal(byOs.inMedia, true, 'the follow-the-phone light block is not behind a media query, so it applies to everyone')
  const opener = sheet.lastIndexOf('@media', byOs.at)
  // `at` is the rule's opening brace, so what lies between is the query, its brace and the selector.
  assert.match(sheet.slice(opener, byOs.at), /^@media \(prefers-color-scheme: light\)\s*\{\s*:root:not\(\[data-theme="dark"\]\)\s*$/,
    'the follow-the-phone light block sits inside some other media query, not prefers-color-scheme: light')
  assert.equal(byChoice.inMedia, false, 'the chosen-light block is behind a condition, so choosing light does nothing on a dark phone')

  // A media query adds no specificity, so whatever overrides the dark block has to come after it.
  assert.ok(dark.at < byOs.at && byOs.at < byChoice.at,
    'the token blocks are out of order - dark, then light by the phone, then light by choice')

  const darkTokens = declarations(dark)
  const osTokens = declarations(byOs)
  const choiceTokens = declarations(byChoice)
  assert.ok(Object.keys(darkTokens).length >= 15, 'the dark block holds almost no tokens - the parse is reading the wrong rule')
  assert.deepEqual(osTokens, choiceTokens,
    'the light values written for "the phone is light" and "I chose light" have drifted apart')
  assert.deepEqual(Object.keys(choiceTokens).sort(), Object.keys(darkTokens).sort(),
    'the light theme does not set exactly the tokens the dark one does - a missing one stays dark on a light page')
})

// --- contrast, measured -------------------------------------------------------------------------

const channel = (value) => {
  const unit = value / 255
  return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
}
const rgbOf = (hex) => {
  assert.match(hex, /^#[0-9a-f]{6}$/i, `${hex} is not a six-digit hex colour, so its contrast cannot be measured`)
  const number = parseInt(hex.slice(1), 16)
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255]
}
const luminance = ([red, green, blue]) => 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
const contrast = (one, two) => {
  const [light, dark] = [luminance(one), luminance(two)].sort((a, b) => b - a)
  return (light + 0.05) / (dark + 0.05)
}

// What carries words, and what words are drawn on. --panel-2 is under every button and the
// highlighted day; --chip is under every chip, including the warning ones.
const TEXT = ['ink', 'muted', 'link', 'ok', 'warn', 'bad', 'accent']
const SURFACES = ['bg', 'panel', 'panel-2', 'chip']
const READABLE = 4.5

test('every colour that carries words clears 4.5:1 on every surface it sits on, in both themes', () => {
  const { dark, byChoice } = tokenBlocks()
  const failures = []
  for (const [theme, rule] of [['dark', dark], ['light', byChoice]]) {
    const tokens = declarations(rule)
    const colour = (name) => rgbOf(tokens[`--${name}`] ?? assert.fail(`--${name} is not set in the ${theme} theme`))
    const pairs = [...TEXT.flatMap((text) => SURFACES.map((surface) => [text, surface])), ['accent', 'accent-soft']]
    for (const [text, surface] of pairs) {
      const ratio = contrast(colour(text), colour(surface))
      if (ratio < READABLE) failures.push(`${theme}: --${text} on --${surface} is ${ratio.toFixed(2)}:1`)
    }
  }
  assert.deepEqual(failures, [], `text below 4.5:1:\n${failures.join('\n')}`)
})

/* The owner chip is the one colour that comes from data, not a token: each agent's palette hue. On
   the dark chip those hues are bright and read fine. On a light chip, amber and teal are close to
   invisible. The palette is pinned by colors.test.mjs - changing it would repaint every team - so
   the chip mixes the hue toward the ink by an amount the theme decides, and this measures every
   hue in the palette at that amount. */

test('the owner chip stays readable in both themes for every hue in the agent palette', () => {
  const owner = cssRules().filter((rule) => !rule.inMedia && rule.selector === '.chip.owner')
  assert.equal(owner.length, 1, 'there is no unconditional .chip.owner rule')
  const rule = declarations(owner[0])
  assert.equal(rule.color, 'color-mix(in srgb, var(--agent), var(--ink) var(--agent-ink))',
    'the owner chip colour is not the agent hue mixed toward the ink by --agent-ink - this measurement no longer describes it')

  const { dark, byChoice } = tokenBlocks()
  const failures = []
  for (const [theme, block] of [['dark', dark], ['light', byChoice]]) {
    const tokens = declarations(block)
    const share = Number(/^(\d+(?:\.\d+)?)%$/.exec(tokens['--agent-ink'] ?? '')?.[1])
    assert.ok(Number.isFinite(share), `--agent-ink in the ${theme} theme is not a percentage`)
    const ink = rgbOf(tokens['--ink'])
    const chip = rgbOf(tokens['--chip'])
    for (const { name, hex } of AGENT_PALETTE) {
      // color-mix in srgb interpolates the encoded channels, weight share% toward the ink.
      const mixed = rgbOf(hex).map((value, index) => Math.round(value * (1 - share / 100) + ink[index] * (share / 100)))
      const ratio = contrast(mixed, chip)
      if (ratio < READABLE) failures.push(`${theme}: the ${name} owner chip is ${ratio.toFixed(2)}:1`)
    }
  }
  assert.deepEqual(failures, [], `owner chips below 4.5:1:\n${failures.join('\n')}`)
})

// --- nothing hard-coded -------------------------------------------------------------------------

const NAMED = /(^|[\s,(:])(white|black|red|green|blue|gray|grey|silver|yellow|orange|purple|pink|navy|teal)(?=$|[\s,);])/i
const LITERAL = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i

test('no colour is written anywhere but the token blocks', () => {
  // A colour typed into a rule is a colour the light theme cannot reach: it stays the dark value on
  // a white page. The nav background was one, and two fallbacks hid an old green and an old amber
  // behind var() - both invisible in dark, both wrong in light.
  const offenders = cssRules()
    .filter((rule) => !TOKEN_BLOCKS.has(rule.selector))
    .filter((rule) => LITERAL.test(rule.body) || NAMED.test(rule.body))
    .map((rule) => `${rule.selector} { ${rule.body.trim()} }`)
  assert.deepEqual(offenders, [], `colours written outside the token blocks:\n${offenders.join('\n')}`)
})

test('links are the link colour, never the red accent', () => {
  // The accent is red now. A red link reads as an error before it reads as a link.
  const links = cssRules().filter((rule) => !rule.inMedia && rule.selector === 'a')
  assert.equal(links.length, 1, 'there is no unconditional rule for links')
  assert.equal(declarations(links[0]).color, 'var(--link)', 'links are not drawn in --link')
})

// --- the phone's own chrome ---------------------------------------------------------------------

test('the phone status bar matches the page background in both themes', () => {
  const { dark, byChoice } = tokenBlocks()
  const darkBg = declarations(dark)['--bg']
  const lightBg = declarations(byChoice)['--bg']

  const metas = [...html.matchAll(/<meta name="theme-color"([^>]*)>/g)].map((found) => found[1])
  const contentFor = (scheme) => {
    const meta = metas.find((attributes) => attributes.includes(`media="(prefers-color-scheme: ${scheme})"`))
    assert.ok(meta, `there is no theme-color meta for a ${scheme} phone`)
    return /content="([^"]+)"/.exec(meta)?.[1]
  }
  assert.equal(metas.length, 2, 'expected exactly two theme-color metas, one per scheme')
  assert.equal(contentFor('dark'), darkBg, 'a dark phone gets a status bar that is not the page background')
  assert.equal(contentFor('light'), lightBg, 'a light phone gets a status bar that is not the page background')

  // The script repaints both metas when someone picks a theme, from its own copy of the two colours.
  const constant = /const THEME_BG = \{ dark: '([^']+)', light: '([^']+)' \}/.exec(script)
  assert.ok(constant, 'THEME_BG is gone from the script')
  assert.deepEqual([constant[1], constant[2]], [darkBg, lightBg],
    'THEME_BG disagrees with --bg, so choosing a theme paints the status bar the wrong colour')
})

test('the theme switch is a real switch that a thumb can hit', () => {
  const button = /<button([^>]*\bid="theme-switch"[^>]*)>/.exec(html)?.[1]
  assert.ok(button, 'there is no #theme-switch button')
  for (const attribute of ['type="button"', 'role="switch"', 'aria-checked="', 'aria-label="']) {
    assert.ok(button.includes(attribute), `the theme switch is missing ${attribute}`)
  }
  // Unconditional only: a size set inside a media query does not exist on the other side of it.
  const sizes = cssRules()
    .filter((rule) => !rule.inMedia && rule.selector.split(',').map((one) => one.trim()).includes('.theme-switch'))
    .flatMap((rule) => Object.entries(declarations(rule)))
    .filter(([name]) => name === 'min-height' || name === 'height')
    .map(([, value]) => Number(/^([\d.]+)rem$/.exec(value)?.[1]))
  assert.ok(sizes.some((rem) => rem >= 2.75), 'the theme switch is shorter than 2.75rem (44px), so it is a fiddly target on a phone')
})

// --- the typeface ---------------------------------------------------------------------------------

test('the typeface is the self-hosted Inter, swapped in, and first in the body stack', () => {
  const face = /@font-face\s*\{([^}]*)\}/.exec(sheet)?.[1]
  assert.ok(face, 'there is no @font-face in the stylesheet')
  const declared = declarations({ body: face })
  assert.match(declared['font-family'], /^["']?Inter["']?$/, 'the font face is not named Inter')
  const source = /url\(["']?([^"')]+)["']?\)\s*format\(["']woff2["']\)/.exec(declared.src)?.[1]
  // The CSP allows fonts from this origin only. A CDN address would be blocked and fall back silently.
  assert.match(source ?? '', /^\/fonts\/[\w.-]+\.woff2$/, 'the font is not loaded from this site as woff2')
  assert.ok(existsSync(fileURLToPath(new URL(`../public${source}`, import.meta.url))), `${source} is not in public/`)
  // swap: the words show at once in the fallback font. block would hide them for up to 3 seconds.
  assert.equal(declared['font-display'], 'swap', 'the font does not swap, so text can be invisible while it loads')
  assert.equal(declared['font-weight'], '100 900', 'the variable font does not declare its whole weight range')

  const body = cssRules().filter((rule) => !rule.inMedia && rule.selector === 'body')
  const family = body.map(declarations).map((rule) => rule['font-family'] ?? rule.font).filter(Boolean).at(-1)
  assert.ok(family, 'the body sets no font')
  const first = family.split(',')[0].trim().split(/\s+/).at(-1).replace(/["']/g, '')
  assert.equal(first, 'Inter', 'Inter is not the first family the body asks for')
})

// --- storage ----------------------------------------------------------------------------------------

test('every use of localStorage goes through the two guarded helpers', () => {
  // A private window, or a browser told to block site data, throws on the first touch of
  // localStorage. One bare call on the way to the first render is a blank page.
  const helpers = /\/\/ storage-guard:start([\s\S]*?)\/\/ storage-guard:end/.exec(script)
  assert.ok(helpers, 'the guarded storage helpers are gone')
  assert.match(helpers[1], /try \{/, 'the storage helpers do not catch')
  // Comments out before looking, line comments first: one of them mentions tasks/*.md, and a block
  // comment stripper run first would start there and swallow real code up to the next close.
  const code = script.replace(helpers[0], '')
    .split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  const bare = code.split('\n').filter((line) => /\blocalStorage\b/.test(line))
  assert.deepEqual(bare, [], `localStorage is used outside the guarded helpers:\n${bare.join('\n')}`)
})
