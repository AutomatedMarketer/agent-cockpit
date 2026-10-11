import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/* Four buttons on the board - Add task, New workflow, Arm, Approve - do not dispatch to the job
   they sit next to. They all dispatch to one dedicated routine, whose slug is fixed in fire.js and
   is NOT a workflow slug. Wiring "each workflow's slug" into FIRE_TRIGGERS, which is what the
   deploy instructions used to say, leaves all four returning 404 with nothing pointing at the
   cause. The endpoint's own error is clear; the reader only meets it after tapping a dead button.

   So: any slug fire.js requires but cannot derive from the user's workflows has to be named in the
   instructions somebody follows. Add a second one and this fails until the README says so. */
test('every fixed dispatch slug is named in the deploy instructions', async () => {
  const source = await readFile(join(root, 'api/fire.js'), 'utf8')
  const readme = await readFile(join(root, 'README.md'), 'utf8')

  /* Resolve what the code LOOKS UP, not how the constant was spelled. The first version of this
     matched /^const\s+\w*SLUG\w*\s*=\s*'...'/ and missed four undocumented slugs at once: a name
     without "SLUG" in it, a double-quoted value, an indented declaration, and a camelCase name.
     Every one of those would have shipped the same 404 this test exists to prevent. */
  const constants = new Map()
  for (const m of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"]([a-z0-9][a-z0-9-]*)['"]/g)) {
    constants.set(m[1], m[2])
  }
  // A slug is "fixed" when the code indexes the trigger map with something the user did not type.
  const fixed = new Set()
  // `?.` is allowed because this file uses optional chaining heavily; a lookup written
  // `triggers?.['x']` is the same lookup. Alias chains (`const m = triggers; m['x']`) are
  // still not followed - recorded in the lesson log rather than claimed away.
  for (const m of source.matchAll(/triggers\s*\??\.?\s*\[\s*([A-Za-z_$][\w$]*|['"][a-z0-9-]+['"])\s*\]/g)) {
    const key = m[1]
    if (/^['"]/.test(key)) fixed.add(key.slice(1, -1))
    else if (constants.has(key)) fixed.add(constants.get(key))
  }
  assert.ok(fixed.size > 0, 'no fixed dispatch slug found in api/fire.js - this test has gone hollow')

  for (const slug of fixed) {
    assert.ok(
      readme.includes(slug),
      `api/fire.js requires the "${slug}" routine, and README.md never names it. A reader wiring only their workflow slugs gets a 404 from every button that uses it.`
    )
  }
})

/* ---------- signing in (spec 2026-10-10, build task 13) ----------
   A student sets this up alone, often on Hobby, and is not technical. Every step the board's safety
   leans on has to be in the instructions they follow - the firewall rule above all: without it, the
   only limit on guessing a memorable password is one server's memory. */

const section = (readme, heading) => {
  const from = readme.indexOf(`\n## ${heading}\n`)
  assert.ok(from >= 0, `README.md has no "## ${heading}" section`)
  const to = readme.indexOf('\n## ', from + 1)
  return readme.slice(from, to < 0 ? undefined : to)
}

test('the README has a Signing in section with every step and every name a student needs', async () => {
  const readme = await readFile(join(root, 'README.md'), 'utf8')
  const signingIn = section(readme, 'Signing in')
  for (const name of ['BOARD_USERNAME', 'BOARD_PASSWORD', 'VIEW_KEY', 'Sensitive']) {
    assert.ok(signingIn.includes(name), `the Signing in section never names ${name}`)
  }
  assert.match(signingIn, /12 characters/, 'nothing says how long the password must be')
  assert.match(signingIn, /All Deployments/, 'the Vercel Authentication step is missing')
  assert.ok(signingIn.includes('https://vercel.com/changelog/protect-production-deployments-for-free-on-every-plan'),
    'the step does not link the source that says it is free')
  assert.match(signingIn, /\/api\/login/, 'the firewall rule does not name the path it limits')
  assert.match(signingIn, /Rate Limit/, 'the firewall rule does not say what kind of rule')
  assert.match(signingIn, /10 requests per 60 seconds/, 'the firewall rule has no numbers')
  assert.match(signingIn, /Publish/, 'a firewall rule that is saved and not published does nothing')
  assert.match(signingIn, /Use the spare key/, 'the spare key is not explained the way the screen says it')
  assert.match(signingIn, /Sign out everywhere/)
  assert.match(signingIn, /signs every device out/i, 'nothing says what changing a key does to signed-in devices')
  assert.match(signingIn, /node -e/, 'no way to make a random key without openssl (Windows)')
})

test('the Signing in steps come in the order they have to be done', async () => {
  const signingIn = section(await readFile(join(root, 'README.md'), 'utf8'), 'Signing in')
  const order = ['VIEW_KEY', 'BOARD_PASSWORD', 'Redeploy', 'All Deployments', '/api/login', 'save']
  let last = -1
  for (const step of order) {
    const at = signingIn.indexOf(step, last + 1)
    assert.ok(at > last, `"${step}" is not where it belongs in the steps`)
    last = at
  }
})

test('nothing still says closing the production gap costs $150 a month - it is free on every plan', async () => {
  // Audit finding #15: the claim was in api/lib.js and .env.example, and it talked students out of
  // the strongest free protection there is.
  const { readdirSync } = await import('node:fs')
  const files = ['README.md', '.env.example', ...readdirSync(join(root, 'api')).map((name) => `api/${name}`)]
  for (const file of files) {
    const text = await readFile(join(root, file), 'utf8')
    assert.doesNotMatch(text, /\$\s?150|150\s*(?:\/|a|per)\s*month/i, `${file} still says the protection costs $150 a month`)
  }
})

test('.env.example names the sign-in variables, with no values', async () => {
  const example = await readFile(join(root, '.env.example'), 'utf8')
  for (const name of ['VIEW_KEY', 'BOARD_USERNAME', 'BOARD_PASSWORD']) {
    const line = example.split(/\r?\n/).find((one) => one.startsWith(`${name}=`))
    assert.ok(line, `.env.example does not name ${name}`)
    assert.equal(line, `${name}=`, `.env.example gives ${name} a value; it must only name it`)
  }
})

test('the README is honest about how slow and how breakable "sign out everywhere" is, and gives the instant fix', async () => {
  // Review, 2026-10-10: the board reads the store for it at most every 10 minutes, and a store that
  // cannot be read stops it working on new copies of the board. A lost phone needs the fix that works.
  const signingIn = section(await readFile(join(root, 'README.md'), 'utf8'), 'Signing in')
  assert.match(signingIn, /within about 11 minutes/, 'the delay is not stated as it now is')
  assert.doesNotMatch(signingIn, /minute and a half/, 'the old delay is still promised')
  assert.match(signingIn, /picture store cannot be read/i, 'nothing says an unreadable store stops it')
  assert.match(signingIn, /lost or stolen\? Change `BOARD_PASSWORD`/i, 'the instant fix for a lost device is missing')
  assert.match(signingIn, /needs no picture store/i)
})

test('the README says what search by meaning sends where, how to switch it on, and what it costs', async () => {
  const readme = await readFile(join(root, 'README.md'), 'utf8')
  const where = readme.slice(readme.indexOf('### What goes where'))
  assert.match(where, /\| With `MEMORY_MEANING=on`: the text of each note the board can open \(its first 8,000 characters\), and the words of each search \| \*\*OpenAI\*\* \| [^|]*30 days[^|]*never trained on[^|]*\|/)
  assert.match(where, /\| The titles, folders and days of the notes a search found, and why each was found in the board's own words, when you ask by voice \| \*\*OpenAI\*\* \| [^|]*Never a heading, an opening or anything else a note says/)
  assert.match(readme, /\| `MEMORY_MEANING` \| /, 'MEMORY_MEANING is not in the settings table')
  assert.match(readme, /#### Search by meaning/)
  assert.match(readme, /Private Blob store/)
  assert.match(readme, /text-embedding-3-small/)
  assert.match(readme, /under 1 cent a month/)
  assert.match(readme, /never reads a note out/i)
})
