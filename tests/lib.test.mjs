import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  notInUse,
  notInUseBecause,
  ownWords,
  parseFrontmatter,
  daysSince,
  minutesSince,
  stateFor,
  fillMarkers,
  sortRunsNewestFirst,
  runsSince,
  heartbeatStatus
} from '../api/lib.js'

const NOW = Date.parse('2026-08-10T12:00:00Z')
const at = (iso, extra = {}) => ({ started_at: iso, status: 'ok', ...extra })

test('frontmatter yields the model alias and description', () => {
  const data = parseFrontmatter('---\nname: research\nmodel: sonnet\ndescription: Looks things up.\n---\n\n# Research\n')
  assert.equal(data.name, 'research')
  assert.equal(data.model, 'sonnet')
  assert.equal(data.description, 'Looks things up.')
})

test('frontmatter survives CRLF checkouts', () => {
  const data = parseFrontmatter('---\r\nname: sales\r\nmodel: opus\r\n---\r\n\r\nbody')
  assert.equal(data.model, 'opus')
})

test('a file with no frontmatter yields an empty object rather than throwing', () => {
  assert.deepEqual(parseFrontmatter('# Just a heading'), {})
  assert.deepEqual(parseFrontmatter(null), {})
})

test('an agent with no runs is never-run, not quiet', () => {
  assert.equal(stateFor([], NOW), 'never-run')
})

test('an agent that ran today is working', () => {
  assert.equal(stateFor([at('2026-08-10T06:00:00Z')], NOW), 'working')
})

test('an agent that last ran nine days ago has gone quiet', () => {
  assert.equal(stateFor([at('2026-08-01T06:00:00Z')], NOW), 'quiet')
})

test('a recent run that ended blocked needs a look', () => {
  assert.equal(stateFor([at('2026-08-10T06:00:00Z', { status: 'blocked' })], NOW), 'attention')
})

test('quietness wins over status, because an old failure is an old problem', () => {
  assert.equal(stateFor([at('2026-07-01T06:00:00Z', { status: 'failed' })], NOW), 'quiet')
})

test('an unparseable timestamp does not crash the page', () => {
  assert.equal(daysSince('not a date'), null)
  assert.equal(minutesSince('not a date'), null)
  assert.equal(stateFor([at('not a date')], NOW), 'working')
})

test('fill markers are reported by name, not just counted', () => {
  assert.deepEqual(fillMarkers('# Brain\n<!-- fill: primary-offer -->\n<!-- fill:  pricing  -->'), [
    'primary-offer',
    'pricing'
  ])
  assert.deepEqual(fillMarkers('nothing here'), [])
})

test('runs sort newest first by started_at', () => {
  const sorted = sortRunsNewestFirst([
    at('2026-08-01T06:00:00Z'),
    at('2026-08-09T06:00:00Z'),
    at('2026-08-05T06:00:00Z')
  ])
  assert.deepEqual(
    sorted.map((run) => run.started_at),
    ['2026-08-09T06:00:00Z', '2026-08-05T06:00:00Z', '2026-08-01T06:00:00Z']
  )
})

test('overnight keeps only the last 24 hours, and never future timestamps', () => {
  const kept = runsSince(
    [
      at('2026-08-10T06:00:00Z'), // 6 hours ago — in
      at('2026-08-09T13:00:00Z'), // 23 hours ago — in
      at('2026-08-09T11:00:00Z'), // 25 hours ago — out
      at('2026-08-11T06:00:00Z'), // the future — out
      at('not a date') // garbage — out
    ],
    24,
    NOW
  )
  assert.deepEqual(
    kept.map((run) => run.started_at),
    ['2026-08-10T06:00:00Z', '2026-08-09T13:00:00Z']
  )
})

test('a fresh heartbeat is live', () => {
  const { status, lastBeat } = heartbeatStatus({ runtime: 'hermes', at: '2026-08-10T11:45:00Z' }, NOW)
  assert.equal(status, 'live')
  assert.equal(lastBeat, '2026-08-10T11:45:00Z')
})

test('a heartbeat older than the staleness window is silent', () => {
  assert.equal(heartbeatStatus({ at: '2026-08-10T10:00:00Z' }, NOW).status, 'silent')
})

test('a missing or malformed heartbeat file says so rather than pretending', () => {
  assert.equal(heartbeatStatus(null, NOW).status, 'no-heartbeat')
  assert.equal(heartbeatStatus({}, NOW).status, 'no-heartbeat')
  assert.equal(heartbeatStatus({ at: 'not a date' }, NOW).status, 'no-heartbeat')
})

/* ---------- the switched-off judgement must not drift from the template -----------------------

   Two of the eight agents - sales and customer-service - are the ones somebody with a job switches
   off, and this board decides which by reading their knowledge file. `notInUse` here and the copy
   in agent-team-template's scripts/lib/knowledge.mjs are the same rule written twice, mirrored by
   hand because there is no import path between a student's repo and a deployed web app. Same shape
   as the arming mirror, which drifted and needed a shared fixture to catch it. This one had no
   fixture, and it was wrong in both copies at once.

   It got the answer backwards for the person it most often describes: a business owner who had
   answered every question. Both knowledge files open with a paragraph telling somebody in a job
   what to write, and it QUOTES the sentence. Nothing tells an owner to delete that paragraph. So
   this screen told a working business their sales and customer-service agents were Not in use.

   tests/fixtures/knowledge-parity.json is the shared contract: the same bytes in both repos, run
   by both sides. Change one implementation only and that side fails here. */

const knowledgeFixtureUrl = new URL('./fixtures/knowledge-parity.json', import.meta.url)
const knowledgeFixture = JSON.parse(readFileSync(knowledgeFixtureUrl, 'utf8'))

for (const testCase of knowledgeFixture.cases) {
  test(`switched-off parity: ${testCase.label}`, () => {
    const body = (knowledgeFixture.guidance[testCase.guidance] ?? '') + testCase.body
    assert.equal(notInUse(body), testCase.notInUse)
  })
}

test('the two repos hold the same switched-off contract, byte for byte', (t) => {
  const sibling = fileURLToPath(
    new URL('../../agent-team-template/tests/fixtures/knowledge-parity.json', import.meta.url)
  )
  if (!existsSync(sibling)) {
    t.skip('agent-team-template is not checked out beside this repo')
    return
  }
  assert.equal(
    readFileSync(sibling, 'utf8'),
    readFileSync(knowledgeFixtureUrl, 'utf8'),
    'the shared contract has been edited on one side only - that is the drift, one level up'
  )
})

test('stripping the quoted example is what the rule depends on', () => {
  const guidance = knowledgeFixture.guidance.sales
  assert.notEqual(ownWords(guidance), guidance, 'the quoted example is no longer being stripped')
  assert.equal(ownWords('plain prose with no example'), 'plain prose with no example')
})

/* The sentence behind a switched-off agent, so the board can print it. Display only - notInUse is
   the judgement mirrored in agent-team-template and held to knowledge-parity.json; this is not. */

test('the refusal sentence is pulled out of the file the board already read', () => {
  const guidance = knowledgeFixture.guidance.sales
  const written = guidance + '## What I sell\nI do not sell - I work for this business and the selling is Ray\'s job.\n\nIf that changes, this is where it gets written down.\n'
  assert.equal(
    notInUseBecause(written),
    'I do not sell - I work for this business and the selling is Ray\'s job.',
    'the refusal sentence was lost, or dragged the paragraph after it along'
  )
})

test('an agent that is in use has no reason to give', () => {
  const answered = knowledgeFixture.guidance.sales + '## What I sell\nCommercial landscape design.\n'
  assert.equal(notInUseBecause(answered), null)
})

test('the guidance example is never mistaken for the owner\'s reason', () => {
  // The shipped paragraph quotes the sentence, placeholder and all. It is not an answer.
  assert.equal(notInUseBecause(knowledgeFixture.guidance.sales), null)
})

test('a refusal spread over two lines comes back as one sentence', () => {
  const wrapped = '# FAQ\n\n## Who do you answer\nI do not deal with customers -\nenquiries go to Ray.\n'
  assert.equal(notInUseBecause(wrapped), 'I do not deal with customers - enquiries go to Ray.')
})

test('nothing at all gives nothing back', () => {
  for (const body of ['', null, undefined, '# FAQ\n\nnothing here\n']) {
    assert.equal(notInUseBecause(body), null)
  }
})

/* ---------- the reason behind a switched-off agent ---------------------------------------------

   This took four rounds and every round made the same mistake: fix the markdown construct that was
   just found, then claim "markdown is handled". A sentence walker cannot see markdown, and there
   is always another construct.

   The costs are not symmetrical, and that is what settled the design. Returning NOTHING is safe -
   the card still says the agent is switched off, which is the half that matters. Returning the
   wrong sentence puts words in somebody's mouth, on the one field whose whole premise is quoting
   them accurately. Twice this returned an EXAMPLE out of the file - once from a fenced block, once
   from an indented one - presented as the owner's own words.

   So the extractor is deliberately conservative, and this is a table rather than a handful of
   cases: every shape it claims to handle is written down, and the two it must REFUSE are written
   down beside them. */

const REFUSAL = 'I do not sell - Ray handles it.'

const QUOTABLE = {
  'plain prose': REFUSAL,
  'under an atx heading': '## What I sell\n' + REFUSAL,
  'under a setext heading, dashes': 'Title\n-----\n' + REFUSAL,
  'under a setext heading, equals': 'Section\n======\n' + REFUSAL,
  'in a blockquote': '> ' + REFUSAL,
  'in a nested blockquote': '> > ' + REFUSAL,
  'as a bullet': '- ' + REFUSAL,
  'as a star bullet': '* ' + REFUSAL,
  'as a numbered item': '1. ' + REFUSAL,
  'as a numbered item with a bracket': '2) ' + REFUSAL,
  'as an indented bullet': '   - ' + REFUSAL,
  'in a quote with no space after the marker': '>' + REFUSAL,
  // Every marker row above is one line. The ordinary way to write a WRAPPED quote repeats the `>`
  // down the left, and closing a block on each of those lines split one sentence into orphaned
  // fragments - this came back as "I do not sell - Ray", cut mid-clause and shown as the whole
  // quote. A list marker starts a new item; a quote marker continues the same quote.
  'in a quote wrapped over two lines': '> I do not sell - Ray\n> handles it.',
  'in a quote wrapped over three lines': '> I do not sell -\n> Ray handles\n> it.',
  'as a bullet with an indented continuation': '- I do not sell - Ray\n  handles it.',
  // A LEAD-IN above the answer. These are the shapes that showed the real mistake: five rounds
  // were spent moving a block boundary around, and a block boundary is not a sentence boundary.
  // Close on every marked line and a wrapped quote gets cut in half; stop closing and an unrelated
  // lead-in glues itself on. The last one has no markdown in it at all and was wrong from round 1.
  'under a lead-in inside a quote': '> Notes\n> ' + REFUSAL,
  'under a bare lead-in': 'Notes\n' + REFUSAL,
  'under a lead-in ending in a colon': 'Quick answer:\n' + REFUSAL,
  'in the middle of a wrapped paragraph': 'We bid a lot of work. I do not sell - Ray\nhandles it. I assemble the packs.',
  // A finished refusal with more prose under it in the same block. Without this row, nothing
  // noticed when the forward-reach stopped checking whether the sentence had actually ended - the
  // mutation ran through the rest of the block and every test still passed, because in every other
  // fixture the refusal happened to be the last line.
  'with another sentence on the line below it': REFUSAL + '\nRay also picks which jobs we bid.',
  // A label SHARING the refusal's line. Sentence-splitting cannot see these, because a colon and a
  // dash are not sentence ends - so the two-line rows above passed while the same sentence written
  // on one line glued the label on. The quote starts where the refusal starts.
  'after a label and a colon on the same line': 'Quick answer: ' + REFUSAL,
  'after a label and a dash on the same line': 'Quick answer - ' + REFUSAL,
  'after an aside opening with a plus': '+1 on this: ' + REFUSAL,
  'after a few words of prose on the same line': 'As I said, ' + REFUSAL,
  // A lead-in whose punctuation touches the refusal with NO space. An earlier rule walked back
  // over any mark touching it, so "(Quick answer)I do not sell..." was shown as
  // ")I do not sell - Ray handles it." - an orphaned bracket opening a quote, with nothing on
  // screen it could have belonged to. Only a wrapper that actually closes comes along now.
  'after a label and a colon with no space': 'Quick answer:' + REFUSAL,
  'after a label and a dash with no space': 'Quick answer-' + REFUSAL,
  'after a bracketed label with no space': '(Quick answer)' + REFUSAL,
  'after an opening mark that never closes': '*' + REFUSAL,
  'as a nested bullet under a lead-in': '- Reasons\n  - ' + REFUSAL,
  'as a bullet under a lead-in inside a quote': '> Notes\n> - ' + REFUSAL,
  'below a fenced example': '```\nexample: I do not sell.\n```\n\n' + REFUSAL,
  'below an indented example': '    example: I do not sell.\n\n' + REFUSAL,
  'in the middle of a paragraph': 'We bid a lot of work. ' + REFUSAL + ' I assemble the packs.',
  'with no full stop at the end': 'I do not sell - Ray handles it'
}

const MUST_REFUSE = {
  'only inside a fenced block': '```\nI do not sell.\n```',
  'only inside a tilde fence': '~~~\nI do not sell.\n~~~',
  'only inside an indented block': '    I do not sell.',
  'only inside a heading': '## I do not sell',
  // A setext heading is its title line plus the underline beneath it, and the underline claims the
  // WHOLE run of lines above it, not just the last one. Dropping one line returned
  // "I do not sell - Ray" for the wrapped case below - a fragment cut mid-clause, shown as though
  // it were the whole quote. A truncated quote is a wrong quote.
  'only inside a setext heading': 'I do not sell - Ray handles it.\n-----',
  'only inside a setext heading written over two lines': 'I do not sell - Ray\nhandles it.\n-----',

  // Everything above splits sentences on a full stop, and a full stop is not always the end of a
  // sentence. Each row below produced a WRONG quote before the ambiguity gate existed - not a
  // missing one, a wrong one, which is the failure this whole function is built to avoid. The first
  // is a plain typo and put a stranger's email address on screen inside the quote.
  'followed by more prose with no space after the stop':
    'I do not sell - Ray handles it.He is at ray@example.com or call the office.',
  'wrapped in inline HTML': '<p>I do not sell - Ray handles it.</p>',
  'carrying an abbreviation': 'I do not sell, e.g. tickets or merchandise, Ray does that.',
  'carrying an email address': 'I do not sell - write to ray@example.com instead.',

  // These four are the same failure again, and they slipped past a first version of the gate that
  // ran AFTER the sentence-splitting instead of replacing it. "e.g." was caught only because it
  // happens to carry a SECOND full stop; a one-stop abbreviation leaves a fragment that looks
  // exactly like a finished sentence, so "I do not sell - Dr." was displayed as the whole reason.
  // These are commoner in ordinary business writing than "e.g." is.
  'carrying a title': 'I do not sell - Dr. Ray handles enquiries.',
  'carrying another title': 'I do not sell - Mrs. Ray handles enquiries.',
  'carrying a street abbreviation': 'I do not sell - visit the shop on Main St. for that.',
  'carrying a phone extension': 'I do not sell - call Ray on ext. 204 for that.',
  'carrying a time of day': 'I do not sell after 5 p.m. - Ray covers evenings.',
  // And the same thing with a line break where the space was. Mid-read, this looks as finished as
  // a real sentence does - which is why the check has to know whether it is seeing all the text.
  'carrying a title split across two lines': 'I do not sell - Dr.\nRay handles enquiries.',
  // A single letter before a stop is an initial or a lettered item, not the end of a sentence. This
  // one is the reason the length check exists; without this row the rule was decorative - dropping
  // it broke no test, which is not the same as it being safe to drop.
  'carrying a lettered clause': 'I do not sell - see clause b. Ray signs those.'
}

// Marks the owner put ON the refusal itself, which must survive byte for byte. A `*` or `-` with
// no space after it is emphasis or punctuation, not a list marker, and an earlier version stripped
// it anyway - turning "*I do not sell* - Ray handles it." into "I do not sell* - Ray handles it."
// and showing that as a direct quote. Editing somebody's real words is the same failure as
// inventing them, so anything touching the refusal with no space between comes along with it.
//
// Note what this is NOT: it is not "return the whole line". A label sharing the line is a lead-in
// and is left behind, which is why "+1 on this: ..." sits in QUOTABLE rather than here. The quote
// starts where the refusal starts; these rows are about it not starting one character late.
const VERBATIM = {
  'italicised by the owner': '*I do not sell* - Ray handles it.',
  'bolded by the owner': '**I do not sell** - Ray handles it.',
  'in quotation marks': '"I do not sell" - Ray handles it.',
  'in single quotes': "'I do not sell' - Ray handles it."
}

// The other half of that rule: a mark only comes along if it OPENS something. Both of these were
// found by review, and both had the mark carried in when it should not have been.
test('an abbreviation at the very end of the text is kept, because nothing follows it', () => {
  // The mirror of the rows above. There, the stop was mid-paragraph and could not be trusted. Here
  // there is no next sentence for it to belong to, so there is nothing to be unsure about and the
  // owner's words come back whole. Refusing this too would be caution with nothing behind it.
  assert.equal(
    notInUseBecause('# FAQ\n\nI do not sell - ask at Main St.\n'),
    'I do not sell - ask at Main St.'
  )
})

test('the sentence after the refusal is left behind, not dragged in', () => {
  // The reason this is not solved by "refuse whenever anything follows": a refusal in the middle of
  // a paragraph is an ordinary way to write, and the pinned rows above cover it. What makes the cut
  // safe here is the word "it" - lowercase, more than one letter, followed by a capital.
  assert.equal(
    notInUseBecause('# FAQ\n\nI do not sell - Ray handles it. He is at ray@example.com.\n'),
    'I do not sell - Ray handles it.'
  )
})

test('a mark glued to the word before it belongs to that word, not to the refusal', () => {
  // The asterisk is part of "Note", not emphasis around the refusal. Carrying it printed an
  // unrelated word's punctuation as the first character of somebody's quote.
  assert.equal(
    notInUseBecause('# FAQ\n\nNote*I do not sell - Ray handles it, per note*.\n'),
    'I do not sell - Ray handles it, per note*.'
  )
})

test('only as many opening marks come along as there are marks to close them', () => {
  // Three asterisks, two of which close. Taking all three handed back an unbalanced quote.
  assert.equal(
    notInUseBecause('# FAQ\n\n***I do not sell** - Ray handles it.\n'),
    '**I do not sell** - Ray handles it.'
  )
})

for (const [shape, body] of Object.entries(QUOTABLE)) {
  test(`the reason is quoted cleanly when written ${shape}`, () => {
    const expected = shape === 'with no full stop at the end' ? 'I do not sell - Ray handles it' : REFUSAL
    assert.equal(notInUseBecause('# FAQ\n\n' + body + '\n'), expected)
  })
}

for (const [shape, body] of Object.entries(MUST_REFUSE)) {
  test(`nothing is quoted when the refusal is ${shape}`, () => {
    assert.equal(
      notInUseBecause('# FAQ\n\n' + body + '\n'),
      null,
      'an example was handed back as the owner\'s own words - saying nothing is the safe answer'
    )
  })
}

for (const [shape, body] of Object.entries(VERBATIM)) {
  test(`a refusal ${shape} is quoted exactly as written`, () => {
    assert.equal(
      notInUseBecause('# FAQ\n\n' + body + '\n'),
      body,
      'the owner\'s own words were edited before being shown as a direct quote'
    )
  })
}

/* A KNOWN LIMIT, written down rather than left to be rediscovered.

   If the line break falls inside the phrase itself - "I do not" on one line, "sell" on the next,
   with a `>` between them - the agent is not detected as switched off AT ALL. That is notInUse's
   doing, not this extractor's: notInUse reads the raw file, where the gap between "not" and "sell"
   contains a quote marker as well as a newline, and its pattern allows only whitespace there.

   It fails SAFE. The agent reads as "never run" rather than "not in use", which is wrong but is
   the honest kind of wrong - nothing is fabricated and nobody is quoted.

   Fixing it means changing notInUse, which is the judgement mirrored in agent-team-template and
   pinned by tests/fixtures/knowledge-parity.json, so it would have to change on both sides at
   once. Not worth that for a line break in the middle of a four-word phrase - but it should be a
   decision on the record rather than a surprise. */

test('a refusal broken mid-phrase by a quote marker is missed, and misses safely', () => {
  const body = '# FAQ\n\n> I do not\n> sell - Ray handles it.\n'
  assert.equal(notInUse(body), false, 'if this ever starts detecting, the note above is out of date')
  assert.equal(notInUseBecause(body), null, 'nothing may be quoted when nothing was detected')
})

/* A SECOND SHAPE THAT IS NOT DETECTED, same story as the one above and recorded the same way. */

test('a refusal opening with underscore emphasis is missed, and misses safely', () => {
  // `_I do not sell_` - an underscore is a WORD character, so there is no word boundary between it
  // and the "I" the pattern needs to anchor on. An asterisk is not a word character, which is why
  // *I do not sell* is detected and this is not. Nothing in the shipped guidance writes it this
  // way, and the fix would be a two-repo contract change.
  const body = '# FAQ\n\n_I do not sell_ - Ray handles it.\n'
  assert.equal(notInUse(body), false, 'if this starts detecting, the note above is out of date')
  assert.equal(notInUseBecause(body), null)
})
