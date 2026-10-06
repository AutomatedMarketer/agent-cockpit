// The stylesheet read as rules, shared by every test file that needs to ask what a rule DOES rather
// than whether some text appears in the page. It lived inside render.test.mjs until the theme tests
// needed it too; a second parser in a second file is how two readings of one sheet drift apart, so
// it moved here instead of being copied.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const stylesheet = () => readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8')

// The text between the tags with comments removed: what cssRules reads, and what a rule's `at`
// indexes into. It used to start AT the opening tag rather than after it, so the first rule in the
// sheet was read as "<style> :root" and no selector check could ever match the block that leads it.
export const sheetText = () => {
  const css = stylesheet()
  const start = css.indexOf('<style>')
  const end = css.indexOf('</style>', start)
  assert.ok(start > 0 && end > start, 'the stylesheet is no longer in a <style> block')
  // Comments OUT first. Without this the text between one rule's closing brace and the next
  // rule's opening one includes any comment sitting between them, so the selector read for
  // `.days7 .d7-day` was "/* Next 7 days - a list, so it reads... */ .days7 .d7-day", matched
  // nothing, and the check below could never fire. It reported clean against the very bug it was
  // written for, which is the same shape as the defect it is here to catch.
  return css.slice(start + '<style>'.length, end).replace(/\/\*[\s\S]*?\*\//g, '')
}

export const cssRules = () => {
  const sheet = sheetText()

  /* `inMedia` used to mean "@media saw it", tracked in a single variable, and review broke that
     two ways at once.

     Only `@media` counted as gating. Wrapping the form-field rules in `@supports not (display:
     grid)` - a condition no browser in use matches, so the rules apply NOWHERE - left them
     reading as unconditional and the suite green. Worse than the desktop-only case that fix was
     written for: that one worked on a laptop.

     And one variable cannot hold nesting. An inner `@media` closing reset it while the outer one
     was still open, so every rule after it read as unconditional though none of them applied on a
     phone. Neither shape is in this sheet today - and neither was the desktop-only wrap, which is
     the point of attacking the instrument rather than the stylesheet.

     So: a stack, and every conditional at-rule on it. `@layer` is deliberately not one - its
     contents do apply. */
  const CONDITIONAL_AT_RULE = /^@(media|supports|container)\b/

  const rules = []
  const conditions = []
  let depth = 0
  let index = 0
  let selectorStart = 0
  while (index < sheet.length) {
    const char = sheet[index]
    if (char === '{') {
      const head = sheet.slice(selectorStart, index).trim()
      depth += 1
      if (CONDITIONAL_AT_RULE.test(head)) {
        conditions.push(depth)
      } else if (head && !head.startsWith('@')) {
        const bodyEnd = sheet.indexOf('}', index)
        rules.push({
          selector: head.split('\n').map((line) => line.trim()).filter(Boolean).join(' '),
          body: sheet.slice(index + 1, bodyEnd),
          at: index,
          // "Behind a condition of some kind", not "the last @media is still open".
          inMedia: conditions.length > 0
        })
      }
      selectorStart = index + 1
    } else if (char === '}') {
      if (conditions.at(-1) === depth) conditions.pop()
      depth -= 1
      selectorStart = index + 1
    }
    index += 1
  }
  assert.ok(rules.length > 40, `only ${rules.length} rules parsed - the parser has stopped seeing the sheet`)
  return rules
}
