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
  // Lookups go through triggerFor(triggers, KEY) since FIRE_TRIGGERS holds a routine's URL and token
  // per slug (2026-10-12) - own entries only - so that spelling is a lookup too.
  const lookups = [
    ...source.matchAll(/triggers\s*\??\.?\s*\[\s*([A-Za-z_$][\w$]*|['"][a-z0-9-]+['"])\s*\]/g),
    ...source.matchAll(/triggerFor\(\s*triggers\s*,\s*([A-Za-z_$][\w$]*|['"][a-z0-9-]+['"])\s*\)/g)
  ]
  for (const m of lookups) {
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

/* ---------- firing a routine (2026-10-12) ----------
   The board fires each routine through the Claude Code routines API: its own URL and its own bearer
   token, so FIRE_TRIGGERS changed shape. And the API hands the board's request to the run as
   untrusted text, which the routine acts on only if its own saved prompt says to - so the README has
   to carry the task-intake prompt word for word, and it has to cover every action fire.js sends
   there. Read against code.claude.com/docs/en/routines and the routines-fire API reference. */

const subsection = (readme, heading) => {
  const from = readme.indexOf(`\n### ${heading}\n`)
  assert.ok(from >= 0, `README.md has no "### ${heading}" section`)
  const ends = ['\n### ', '\n## '].map((mark) => readme.indexOf(mark, from + 1)).filter((at) => at > 0)
  return readme.slice(from, ends.length ? Math.min(...ends) : undefined)
}
const ROUTINE_URL_SHAPE = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/trig_[^/]+\/fire$/

const assertNewShape = (value, where) => {
  const parsed = JSON.parse(value)
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), `${where}: not a JSON object`)
  assert.ok(Object.hasOwn(parsed, 'task-intake'), `${where}: no task-intake entry`)
  for (const [slug, entry] of Object.entries(parsed)) {
    assert.match(entry?.url ?? '', ROUTINE_URL_SHAPE, `${where}: ${slug} has no routine URL`)
    assert.match(entry?.token ?? '', /^sk-ant-oat01-/, `${where}: ${slug} has no routine token`)
  }
}

test('the README and .env.example show FIRE_TRIGGERS as fire.js reads it: each routine\'s URL and token', async () => {
  const readme = await readFile(join(root, 'README.md'), 'utf8')
  const orders = subsection(readme, 'Orders by voice')
  const example = /`(\{"task-intake":\{"url":[^`]+\}\})`/.exec(orders)
  assert.ok(example, 'Orders by voice has no FIRE_TRIGGERS example in the new shape')
  assertNewShape(example[1], 'README example')
  // The old shape, a plain link per slug, is gone from every instruction a reader follows.
  assert.doesNotMatch(readme, /\{"task-intake":\s*"/, 'the README still shows the old FIRE_TRIGGERS shape')
  const row = readme.split('\n').find((line) => line.startsWith('| `FIRE_TRIGGERS` |'))
  assert.ok(row && row.includes('"url"') && row.includes('"token"'), 'the settings row does not say each routine needs its URL and token')
  const env = await readFile(join(root, '.env.example'), 'utf8')
  const line = env.split('\n').find((text) => text.startsWith('FIRE_TRIGGERS='))
  assertNewShape(line.slice('FIRE_TRIGGERS='.length), '.env.example')
})

test('the README has the steps to make a routine and its API trigger, in the web app\'s own words', async () => {
  const orders = subsection(await readFile(join(root, 'README.md'), 'utf8'), 'Orders by voice')
  for (const words of ['claude.ai/code/routines', '**New routine**', '**API**', '**Create**', '**Generate token**', 'shown once', '**Regenerate**', '**Connectors**', 'default branch']) {
    assert.ok(orders.includes(words), `Orders by voice does not say "${words}"`)
  }
})

test('the README carries the task-intake prompt word for word, and it covers every action fire.js sends that routine', async () => {
  const source = await readFile(join(root, 'api/fire.js'), 'utf8')
  const orders = subsection(await readFile(join(root, 'README.md'), 'utf8'), 'Orders by voice')
  const block = /```text\n([\s\S]+?)\n```/.exec(orders)
  assert.ok(block, 'Orders by voice has no copyable prompt block')
  const prompt = block[1]
  const words = prompt.split(/\s+/).filter(Boolean).length
  assert.ok(words <= 250, `the prompt is ${words} words: keep it under 250`)
  // Every action but "run" goes to task-intake (a run fires the job's own routine). Read from the
  // code, so a new action fails here until the prompt names it.
  const actions = JSON.parse(/const ACTIONS = (\[[^\]]+\])/.exec(source)[1].replaceAll("'", '"'))
  assert.ok(actions.length >= 8, 'ACTIONS was not read from fire.js')
  for (const action of actions.filter((name) => name !== 'run')) {
    assert.match(prompt, new RegExp(`(^|[^a-z-])${action}([^a-z-]|$)`, 'm'), `the prompt does not name the "${action}" action`)
    // ...and says what it is for, on a line of its own: "- task: file one task card".
    assert.match(prompt, new RegExp(`^- [^:\\n]*\\b${action}\\b[^:\\n]*:`, 'm'), `the prompt has no line saying what "${action}" does`)
  }
  for (const needed of ['routine-fire-payload', 'agent-cockpit', '"instruction"', 'ONLY', 'Drafts only', 'Never send', 'publish', 'delete', 'spend', 'data', 'commit and push']) {
    assert.ok(prompt.includes(needed), `the prompt does not say "${needed}"`)
  }
})

test('When it breaks has a line for a refused token, the hourly limit, and the old FIRE_TRIGGERS shape', async () => {
  const breaks = section(await readFile(join(root, 'README.md'), 'utf8'), 'When it breaks')
  for (const words of ['was refused', 'hourly limit', 'old format']) {
    assert.ok(breaks.includes(words), `When it breaks has no line for "${words}"`)
  }
})

/* ---------- what Pause can and cannot stop (review, 2026-10-12) ----------
   Pause goes to task-intake, which edits the job's workflow file. A routine with its own schedule at
   claude.ai/code/routines keeps firing whatever that file says, so the README must say so where a
   reader sets Pause up and where they look when it did not work. */

test('the README says Pause edits only the workflow file, and a routine\'s own schedule is switched off at claude.ai', async () => {
  const readme = await readFile(join(root, 'README.md'), 'utf8')
  const orders = subsection(readme, 'Orders by voice')
  const prompt = /```text\n([\s\S]+?)\n```/.exec(orders)[1]
  assert.ok(prompt.includes('- pause: switch off its schedule in its workflow file; never run the job'), 'the prompt\'s pause line does not say never to run the job')
  for (const [where, text] of [['Orders by voice', orders], ['When it breaks', section(readme, 'When it breaks')]]) {
    assert.ok(text.includes('workflows/<slug>.yml'), `${where} does not say Pause edits workflows/<slug>.yml`)
    const at = text.indexOf('Pause cannot stop')
    assert.ok(at >= 0, `${where} does not say what Pause cannot stop`)
    // Said in the same breath: where that routine's own schedule is switched off.
    assert.ok(text.slice(Math.max(0, at - 200), at + 120).includes('claude.ai/code/routines'), `${where} does not say where to switch the routine off`)
  }
})
