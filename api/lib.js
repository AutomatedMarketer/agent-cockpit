import { createHash, timingSafeEqual } from 'node:crypto'

// --- the read gate -----------------------------------------------------------------
// Vercel's own "Standard Protection" exempts production domains, and closing that gap on
// their side costs $150/month. This closes it in the app instead, for nothing: the two
// read endpoints serve a private repo, so they answer nobody without the key.
//
// Hash both sides to a fixed length first so timingSafeEqual never throws on a length
// mismatch - a plain length check would itself leak the key's length through timing.
export function keysMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false
  return timingSafeEqual(
    createHash('sha256').update(provided).digest(),
    createHash('sha256').update(expected).digest()
  )
}

// Returns null when the request may proceed, or {status, error} to send back.
// Closed is the default. A deployment with no VIEW_KEY refuses to serve rather than
// serving a private repo to the open web - the failure mode has to be silence, not
// exposure. PUBLIC_DASHBOARD=true is the deliberate, documented way out.
export function viewGate(request, env = process.env) {
  if (env.PUBLIC_DASHBOARD === 'true') return null
  const expected = env.VIEW_KEY
  if (!expected) {
    return {
      status: 503,
      error:
        'This dashboard is not configured. Set VIEW_KEY in your hosting environment and ' +
        'redeploy, or set PUBLIC_DASHBOARD=true if this repo is genuinely public.'
    }
  }
  const provided = request?.headers?.['x-view-key'] ?? request?.headers?.['X-View-Key']
  if (!keysMatch(typeof provided === 'string' ? provided : '', expected)) {
    return { status: 401, error: 'Missing or wrong view key. Send it in the x-view-key header.' }
  }
  return null
}

// Pure helpers, kept out of the handler so they can be tested without a network.

export const STALE_AFTER_DAYS = 7
export const HEARTBEAT_STALE_AFTER_MINUTES = 30
export const OVERNIGHT_HOURS = 24

// Flat `key: value` frontmatter is all an agent file uses.
export function parseFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source ?? '')
  if (!match) return {}
  const data = {}
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (pair) data[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, '')
  }
  return data
}

export function daysSince(iso, now = Date.now()) {
  if (!iso) return null
  const parsed = new Date(iso).getTime()
  if (Number.isNaN(parsed)) return null
  return Math.floor((now - parsed) / 86400000)
}

export function minutesSince(iso, now = Date.now()) {
  if (!iso) return null
  const parsed = new Date(iso).getTime()
  if (Number.isNaN(parsed)) return null
  return (now - parsed) / 60000
}

// An agent switched off on purpose and one nobody has got to yet both had no runs, so both read
// "Never run" on the Team screen and both counted against "N of 8 agents working". They are not
// the same thing: sales and customer-service usually never apply to someone who works for the
// business rather than owning it, and the course says so on day one.
//
// KEEP IN SYNC with agent-team-template's scripts/lib/knowledge.mjs, which makes the same
// judgement for check:arming and the matcher. Mirrored rather than imported because the two repos
// deploy separately; if this regex changes, change it there in the same breath.
//
// The signal is the knowledge file having been ANSWERED with a refusal - no fill markers left,
// AND a first-person negation. Both halves are needed: the shipped template quotes "I do not
// sell" inside its own guidance paragraph, so matching the phrase alone marks every fresh clone
// as not in use.
const NOT_IN_USE = /\b(?:i|we)\s+do\s+not\s+(?:sell|deal\s+with\s+customers|have\s+customers)\b/i

// The refusal has to be found in the owner's OWN WORDS, not in the instructions that show them
// what to write. Both knowledge files open with a paragraph quoting the sentence as an example,
// wrapped in markdown emphasis and quotation marks:
//
//     *"I do not sell - I work for this business and the selling is <name>'s job"*
//
// The fill-marker guard alone separates a FRESH file from an answered one, and the case that bites
// is an ANSWERED one. A business owner who answered every question and left the instructions in
// place - nothing tells them to delete it - satisfied both halves, and this screen told them their
// sales and customer-service agents were "Not in use". Exactly backwards, on two of eight agents.
//
// Strip that example and what is left is what the owner wrote. What identifies it is not its
// punctuation but the `<name>` still sitting inside it: an unfilled placeholder, the same family
// of thing as a `<!-- fill: -->` marker, which this function already refuses to judge around.
//
// Two earlier attempts inferred intent from SHAPE and each broke in the opposite direction.
// Splitting at the first `## ` heading meant demoted or indented headings brought the false
// positive back, and a refusal above the first heading was missed. Stripping any `*"..."*` span
// meant somebody who copied the guidance's punctuation and changed the words - which is what
// "something like" invites - had their real refusal thrown away. The placeholder is content, and
// it is only ever true of text nobody has answered yet.
//
// KEEP IN SYNC with agent-team-template's scripts/lib/knowledge.mjs, same as the regex above.
// tests/fixtures/knowledge-parity.json is the shared contract: the same bytes in both repos, run
// by both sides, so changing one implementation alone fails that side's suite.
const QUOTED_EXAMPLE = /\*"[\s\S]*?"\*/g
const UNFILLED_NAME = /<name>/i

export function ownWords(knowledgeBody) {
  return String(knowledgeBody ?? '').replace(QUOTED_EXAMPLE, (span) =>
    UNFILLED_NAME.test(span) ? ' ' : span
  )
}

export function notInUse(knowledgeBody) {
  if (typeof knowledgeBody !== 'string' || !knowledgeBody) return false
  if (fillMarkers(knowledgeBody).length) return false
  return NOT_IN_USE.test(ownWords(knowledgeBody))
}

// The owner's own sentence for WHY this agent is off, so the board can show it.
//
// There are three deliberately-off states on this board and the other two both show the reason: a
// workflow with `armed: false` prints its `reason:`, and a parked ledger row prints its
// `parked_because:`. This one read the file, took a boolean out of it, and threw the sentence away
// - so the two agents somebody has switched off looked exactly like two agents nobody had got to,
// separated only by a small grey label.
//
// DISPLAY ONLY. `notInUse` above is the judgement that is mirrored in agent-team-template and held
// to tests/fixtures/knowledge-parity.json; this is not part of that contract and the template has
// no need of it.
// What is left of a knowledge file once everything that is not the owner's prose is taken out.
// A sentence walker cannot see markdown, so anything structural it walks through gets glued onto
// the answer - and anything EXAMPLE-shaped it finds gets returned as though the owner wrote it.
//
// The first version of this stripped `#` headings only, and the commit said "markdown headings are
// stripped", which was false as a general claim. Three things got through, and one of them was not
// cosmetic:
//
//   FENCED CODE returned somebody else's sentence. A file with an example in a fence and the real
//   answer below it handed back the EXAMPLE, backticks and all, presented as the owner's own words.
//   Fabricated attribution is worse than no reason at all.
//
//   SETEXT HEADINGS (`Title` over `-----`) have no `#`, so they survived and glued on exactly the
//   way ATX headings had. Writing `---` under a line with no blank line between is a common
//   markdown slip that silently makes that line a heading.
//
//   BLOCK MARKERS - a `>` quote or a `-` bullet - came back stuck to the front of the sentence.
// Everything in a knowledge file that is plainly the owner's own prose, split into blocks.
//
// This was three rounds of stripping one markdown construct at a time, and each round claimed to
// have solved "markdown" while only handling what had just been found. The costs are not
// symmetrical, and that is what decides the design: returning NOTHING is safe - the card still
// says the agent is switched off, which is the half that matters - while returning the wrong
// sentence puts words in somebody's mouth on the one field whose whole premise is quoting them
// accurately. So this is deliberately conservative. When a line is not obviously the owner
// talking, it is dropped, and if that leaves nothing quotable the answer is null.
//
// What gets dropped, and why:
//   FENCED and INDENTED CODE. Both are examples. The fenced kind returned "``` example: I do not
//   sell." as the owner's words; the indented kind did the same thing one syntax over, and a
//   non-technical writer is likelier to indent a pasted example than to type three backticks.
//   HEADINGS, both ATX and setext. They have no full stop, so a sentence walker runs straight
//   through them and glues the file's structure onto the answer.
//   BLOCK MARKERS, repeatedly - `>`, bullets, numbers, and nests of them. One pass left the outer
//   level of `> >` attached.
//
// And the reason blocks exist at all: a line that STARTS a new list item or quote begins a new
// block, so a lead-in like "- Reasons" cannot run into the item beneath it. Wrapped lines inside
// one block still join, because a refusal written across two lines is one sentence.
function proseBlocks(knowledgeBody) {
  // A `>` is a quote marker with or without a space after it. A `*`, `+`, `-` or number is only a
  // list marker when whitespace follows: `*I do not sell*` is somebody emphasising their own
  // sentence, and an earlier version of this stripped that leading `*` and displayed
  // "I do not sell* - Ray handles it." as a direct quote. Editing the owner's real words is the
  // same failure as inventing them.
  const MARKERS = /^[ \t]{0,3}(?:>[ \t]*|(?:[*+-]|\d+[.)])[ \t]+)+/
  const blocks = []
  let current = []
  let inFence = false
  const close = () => {
    if (current.length) blocks.push(current)
    current = []
  }

  for (const line of ownWords(knowledgeBody).split(/\r?\n/)) {
    if (/^[ \t]{0,3}(?:```|~~~)/.test(line)) {
      inFence = !inFence
      close()
      continue
    }
    if (inFence) continue
    if (/^[ \t]{4,}\S/.test(line)) {
      close()
      continue
    }
    if (/^[ \t]{0,3}#{1,6}[ \t]/.test(line)) {
      close()
      continue
    }
    // A setext underline turns the WHOLE run of lines above it into a heading, not just the last
    // one. Popping a single line meant a refusal wrapped over two lines and followed by a divider
    // came back as "I do not sell - Ray" - a fragment cut mid-clause, shown as a complete quote.
    // Silently truncating somebody is a wrong sentence, which is the thing this is built to refuse.
    if (/^[ \t]{0,3}[=-]{2,}[ \t]*$/.test(line)) {
      current = []
      continue
    }
    if (!line.trim()) {
      close()
      continue
    }
    // A LIST marker starts a new block, so a lead-in cannot run into the item beneath it. A quote
    // marker does not: `>` repeated down the left is how a wrapped quote is written, one quote
    // continuing, and closing on each of those lines split a single sentence into orphaned
    // fragments - "> I do not sell - Ray" / "> handles it." came back as "I do not sell - Ray",
    // cut mid-clause and shown as the whole quote.
    //
    // A bullet inside a quote (`> - ...`) still starts a new block, because that is a new item.
    const marker = line.match(MARKERS)
    if (marker && /[*+\-\d]/.test(marker[0])) close()
    const text = line.replace(MARKERS, '').trim()
    if (text) current.push(text)
  }
  close()
  return blocks
}

// Start where the refusal starts, and join FORWARD only.
//
// Five rounds of this were spent moving a block boundary around, and the mistake underneath all of
// them was treating a block boundary as a sentence boundary. They are not the same thing, which is
// why the same bug kept coming back wearing different markdown: close on every marked line and a
// genuinely wrapped quote gets cut in half; stop closing and an unrelated lead-in glues itself on.
// Both are wrong, and no rule about markers can separate them, because the difference is not
// structural. It is that one line CONTINUES the sentence and the other PRECEDES it.
//
//   Quick answer:                      <- glued on, and there is no markdown here at all
//   I do not sell - Ray handles it.
//
//   I do not deal with customers -     <- must join, and looks identical to a walker
//   enquiries go to Ray.
//
// So this finds the line the refusal BEGINS on, takes the sentence from there, and only reaches
// forward for more when that sentence has not ended. Nothing before it can be dragged in, because
// nothing before it is ever looked at.
// Where does the sentence end? This is the whole difficulty of quoting somebody accurately, and
// getting it wrong put words in an owner's mouth six separate times across ten rounds of review.
//
// A full stop is not always the end of a sentence. It is also an abbreviation, a decimal point, and
// part of every email address and filename ever written. "sell. Ray handles it" and "sell - Dr. Ray
// handles it" are the same five characters.
//
// Five versions of this tried to tell them apart from what sits around the stop, and each one was
// beaten by an ordinary sentence somebody might actually write:
//
//   handles it.He is at ray@example.com    a missing space after a stop - the commonest typo there
//                                          is - put a stranger's email inside the quote
//   Ray handles it.</p>                    the closing tag came along
//   I do not sell, e.g. tickets            cut at the abbreviation: "I do not sell, e.g."
//   I do not sell - Dr. Ray handles it     cut at the title: "I do not sell - Dr."
//                                          and the same for Mr., Mrs., St. and ext.
//   I do not sell items etc. Ray handles   cut at the abbreviation again: "I do not sell items etc."
//     the overflow                         and the same for approx., vs., misc., dept., admin.
//
// The last of those is what settled it. A capital letter after the stop does not mean a new sentence
// - "etc. Ray" and "it. Ray" are identical in every respect a rule can see. Length does not separate
// them either: "etc" and "Ray" are the same size. What is left is a list of every abbreviation in
// English, which is wrong the first time somebody writes "Ste." or "qty.".
//
// So the rule is now the only one that needs no list and no judgement: THE END OF THE TEXT IS THE
// ONLY END WE TRUST. A stop with nothing after it but closing marks is the end of a sentence,
// because there is no next sentence for it to belong to. A stop anywhere else means we do not know
// where the sentence ends, so there is no quote.
//
// What that costs, and it is a real cost: a paragraph with more than one sentence in it gets no
// quote. "I do not sell. Ray handles all of that." shows nothing, and that is an ordinary way to
// write. The agent still reads as switched off; the student opens the file to see why, which is
// where they were before this existed. That trade is made deliberately and in one direction only:
// the alternative was an open-ended list of abbreviations, each one found the same way - by somebody
// noticing a wrong quote on screen. A quote nobody wrote is worse than no quote.
//
// Returns the text to show, or null when it cannot be sure.
function upToSentenceEnd(text) {
  const stops = [...String(text).matchAll(/[.!?]/g)]
  if (!stops.length) return text // nothing to be unsure about
  const closing = text.slice(stops[0].index + 1).match(/^[)\]"'*_`]*/)[0]
  return stops[0].index + 1 + closing.length === text.length ? text : null
}

export function notInUseBecause(knowledgeBody) {
  if (!notInUse(knowledgeBody)) return null

  for (const block of proseBlocks(knowledgeBody)) {
    const start = block.findIndex((line) => NOT_IN_USE.test(line))
    if (start === -1) continue

    // Where the quote STARTS is not in doubt: NOT_IN_USE matches at "I" or "We", which is the start
    // of the clause, so the clause is the quote. That handles a label sharing the line - "Quick
    // answer: I do not sell - Ray handles it." - and a whole earlier sentence sharing it, without
    // guessing what a colon or a dash means. Nothing before the match is ever looked at.
    //
    // Where it ENDS is the hard half, and there is no splitting on full stops here any more. See
    // the gate at the bottom for why.
    //
    // A mark touching that clause comes along ONLY if it is a wrapper that actually closes later
    // in the sentence. Without this, "*I do not sell*" loses its opening mark and is shown as
    // "I do not sell*". With "any punctuation touching it", the tail of a lead-in written without
    // a space comes along instead, and "(Quick answer)I do not sell..." was displayed as
    // ")I do not sell - Ray handles it." - an orphaned bracket opening a quote, with nothing it
    // could have belonged to anywhere on screen.
    //
    // The set is the marks that genuinely wrap text. A dash is not one of them, whatever it looks
    // like: markdown emphasis is `*` and `_`, and a dash is the commonest separator there is -
    // the shipped refusal itself reads "I do not sell - I work for this business".
    // A mark only comes along if it opens something, and each one is judged on its own rather than
    // the whole run at once. It must not be glued to a word - in "Note*I do not sell", that
    // asterisk belongs to "Note". And there must still be one of it left later to close it,
    // counted rather than merely looked for: "***I do not sell**" is three marks where only two
    // close, and blind walking took all three. Judging them one at a time matters: in
    // "word*'I do not sell'", the asterisk is glued and the quote mark is not, and disqualifying
    // the run together threw away a mark that genuinely closes.
    const WRAPPERS = new Set(['*', '_', '`', '"', "'"])
    const line = block[start]
    const found = NOT_IN_USE.exec(line)
    const opens = found ? found.index : 0
    const rest = line.slice(opens)
    const carried = []
    let from = opens
    for (let i = opens - 1; i >= 0; i -= 1) {
      const mark = line[i]
      if (!WRAPPERS.has(mark)) break
      if (i > 0 && /\w/.test(line[i - 1])) break
      const closes = rest.split(mark).length - 1
      if (carried.filter((seen) => seen === mark).length >= closes) break
      carried.push(mark)
      from = i
    }
    // Everything from the refusal to the end of the paragraph, and then upToSentenceEnd decides
    // whether that is quotable. There is no reaching forward line by line any more: a line break is
    // not a sentence end either, so deciding where to stop reading was the same unanswerable
    // question in smaller print. The paragraph ends where proseBlocks says it does, and that
    // boundary is structural - a blank line, a heading, a fence - not a guess about punctuation.
    const quote = [line.slice(from), ...block.slice(start + 1)]
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!quote) return null
    return upToSentenceEnd(quote)
  }
  return null
}

// runs must be newest first. States match the Team screen: working / attention / quiet /
// never-run / not-in-use. "Quiet" is the one that matters — an agent that silently stopped is
// worse than no agent, because you were counting on it.
export function stateFor(runs, now = Date.now(), isNotInUse = false) {
  if (isNotInUse) return 'not-in-use'
  if (!runs.length) return 'never-run'
  const age = daysSince(runs[0].started_at, now)
  if (age !== null && age > STALE_AFTER_DAYS) return 'quiet'
  if (runs[0].status === 'failed' || runs[0].status === 'blocked') return 'attention'
  return 'working'
}

export function fillMarkers(source) {
  return [...String(source ?? '').matchAll(/<!--\s*fill:\s*([a-z0-9-]+)\s*-->/g)].map(
    (match) => match[1]
  )
}

export function sortRunsNewestFirst(runs) {
  return [...runs].sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))
}

// "What ran overnight" — everything inside the last day, so the morning glance always has
// yesterday evening and last night in it whatever timezone the reader woke up in.
export function runsSince(runs, hours = OVERNIGHT_HOURS, now = Date.now()) {
  return runs.filter((run) => {
    const started = new Date(run.started_at).getTime()
    return !Number.isNaN(started) && now - started <= hours * 3600000 && started <= now
  })
}

// --- agent identity colors ----------------------------------------------------------------
//
// KEEP IN SYNC: these two functions (AGENT_PALETTE, agentColorIndex) and scheduleWeekView
// below are mirrored verbatim inside public/index.html's inline script, because the page
// ships with no module loading. Change them here, change them there.
//
// Eight distinct dark-theme-friendly hues. Agent color is IDENTITY only — status colors
// (ok/warn/bad) stay separate and are never applied to the same element as an agent color.
export const AGENT_PALETTE = [
  { name: 'blue', hex: '#60a5fa' },
  { name: 'violet', hex: '#a78bfa' },
  { name: 'teal', hex: '#2dd4bf' },
  { name: 'amber', hex: '#facc15' },
  { name: 'rose', hex: '#fb7185' },
  { name: 'green', hex: '#34d399' },
  { name: 'cyan', hex: '#22d3ee' },
  { name: 'orange', hex: '#fb923c' }
]

// Deterministic slug → palette index. Hash: FNV-1a 32-bit over the slug's UTF-16 code
// units (offset basis 0x811c9dc5, prime 0x01000193, Math.imul for 32-bit wrap), then
// unsigned mod 8. Pure arithmetic on the string — the same slug maps to the same color
// forever, on every device, with no stored state.
export function agentColorIndex(slug) {
  const text = String(slug ?? '')
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % AGENT_PALETTE.length
}

// --- schedule → week-strip expansion ------------------------------------------------------
//
// Expands one parsed schedule string (the six forms from api/workflows.js) into what the
// Schedule strip draws. Days are Monday-first: 0 = Mon … 6 = Sun.
//   daily HH:MM     → { type: 'days', days: [0..6], time }
//   weekdays HH:MM  → { type: 'days', days: [0..4], time }
//   weekly ddd HH:MM→ { type: 'days', days: [thatDay], time }
//   monthly D HH:MM → { type: 'monthly', day: D, time }   (footnote row, not a column)
//   hourly          → { type: 'interval', label: 'hourly' }
//   every N minutes|hours → { type: 'interval', label: 'every Nm' | 'every Nh' }
// Anything unrecognised → null.
const WEEK_MON_FIRST = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

export function scheduleWeekView(schedule) {
  if (typeof schedule !== 'string') return null
  const trimmed = schedule.trim()
  let match
  if (trimmed === 'hourly') return { type: 'interval', label: 'hourly' }
  if ((match = /^every (\d+) (minutes|hours)$/.exec(trimmed))) {
    return { type: 'interval', label: `every ${match[1]}${match[2] === 'hours' ? 'h' : 'm'}` }
  }
  if ((match = /^daily (\d{2}:\d{2})$/.exec(trimmed))) {
    return { type: 'days', days: [0, 1, 2, 3, 4, 5, 6], time: match[1] }
  }
  if ((match = /^weekdays (\d{2}:\d{2})$/.exec(trimmed))) {
    return { type: 'days', days: [0, 1, 2, 3, 4], time: match[1] }
  }
  if ((match = /^weekly (sun|mon|tue|wed|thu|fri|sat) (\d{2}:\d{2})$/.exec(trimmed))) {
    return { type: 'days', days: [WEEK_MON_FIRST.indexOf(match[1])], time: match[2] }
  }
  if ((match = /^monthly (\d{1,2}) (\d{2}:\d{2})$/.exec(trimmed))) {
    return { type: 'monthly', day: Number(match[1]), time: match[2] }
  }
  return null
}

// --- task text → { title, details } -------------------------------------------------------
//
// KEEP IN SYNC: mirrored verbatim inside public/index.html's inline script (same rule as
// the palette helpers above). The Add-task form is one textarea: the first line becomes
// the card's title (clipped to the endpoint's 200-char cap), and when there is more than
// the title — extra lines, or a clipped first line — the full text rides as details.
// --- the week calendar -------------------------------------------------------------------
// Mirrored verbatim in public/index.html. Monday-first, local time: the calendar answers
// "did today's job run", and a UTC week would answer it for the wrong day either side of
// midnight.

export function weekDates(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
  return Array.from({ length: 7 }, (unused, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    return date
  })
}

export const dateKey = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

// Which local days a workflow actually ran on, from the run logs. Runs match a workflow by
// its slug - the same field the Workflows board matches on - so a run log missing
// `workflow` counts for nothing rather than for everything.
export function ranOnDays(runs, slug) {
  const days = new Set()
  if (!slug) return days
  for (const run of runs ?? []) {
    if (run.workflow !== slug) continue
    const at = Date.parse(run.started_at)
    if (!Number.isFinite(at)) continue
    days.add(dateKey(new Date(at)))
  }
  return days
}

export function splitTaskText(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return null
  const title = trimmed.split(/\r?\n/)[0].trim().slice(0, 200).trim()
  return trimmed === title ? { title } : { title, details: trimmed.slice(0, 2000) }
}

// A heartbeat file is `{ "runtime": "hermes", "at": "…" }`, written by the runtime's own
// cron. Fresh means the light is on. Stale or absent means it is not, and the rail says so
// rather than pretending everything is fine.
export function heartbeatStatus(beat, now = Date.now()) {
  if (!beat || typeof beat !== 'object' || !beat.at) {
    return { status: 'no-heartbeat', lastBeat: null }
  }
  const age = minutesSince(beat.at, now)
  if (age === null) return { status: 'no-heartbeat', lastBeat: null }
  return {
    status: age <= HEARTBEAT_STALE_AFTER_MINUTES ? 'live' : 'silent',
    lastBeat: beat.at
  }
}
