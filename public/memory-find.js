'use strict'
/* ---------- Memory: finding a note (memory-find.js) ----------
   Loaded the first time Memory opens, or the first time the voice assistant is asked to find a note, so
   no visit pays for it before then. A plain script sharing the page's scope, like memory-graph.js.

   One search, for the box and for voice alike: the words of the question are ranked on this device
   (memoryRank, in app.js) and, when the board has search by meaning switched on, sent to the board,
   which ranks the notes by meaning (api/memory-search.js). The two lists become one. A day ("today",
   "last Tuesday", "on 3 October") and a folder ("in shared", "in my inbox") are read from the question
   here, in this device's own time zone, and narrow the list. */

/* --- words: the page's own ranking ---------------------------------------------------------------------
   The graph (api/graph.js) brings, for each team note, what search may use: its headings, description,
   tags and opening words (api/_team-graph.js). The box ranks pages by those as well as by name - the
   page's own arithmetic over what is already loaded, so typing never asks the board for anything. */

// How strongly a word counts by where it is found: a page's name says most about it.
const SEARCH_FIELDS = [
  { key: 'name', weight: 3, where: () => 'in its name' },
  { key: 'headings', weight: 2, where: (entry, terms) => `in a heading: ${(entry.headings ?? []).find((heading) => searchWords(heading).some((word) => terms.some((term) => word.startsWith(term)))) ?? ''}` },
  { key: 'description', weight: 1.5, where: () => 'in its description' },
  { key: 'tags', weight: 1.5, where: () => 'in its tags' },
  { key: 'opening', weight: 1, where: () => 'in its opening words' }
]

const MEMORY_HITS_MAX = 50

const MEMORY_SEARCH_SCOPE = 'The board searches those for every page, not every word inside them. Open a page to read all of it.'

const searchWords = (text) => String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)

// Pages that hold every word typed (a word typed may be the start of a word written), best first: each
// word counts by the field it is in, by how often (with diminishing returns), and by how rare it is
// across the pages. Equal pages keep their path order. [{ path, size, score, where }]
function memoryRank(entries, query) {
  const terms = [...new Set(searchWords(query))]
  if (!terms.length) return []
  const docs = entries.map((entry) => {
    const fields = {
      name: searchWords(String(entry.path ?? '').replace(/\.md$/i, '')),
      headings: searchWords((entry.headings ?? []).join(' ')),
      description: searchWords(entry.description),
      tags: searchWords((entry.tags ?? []).join(' ')),
      opening: searchWords(entry.opening)
    }
    return { entry, fields }
  })
  const holds = (doc, term) => SEARCH_FIELDS.some((field) => doc.fields[field.key].some((word) => word.startsWith(term)))
  const rarity = Object.fromEntries(terms.map((term) => {
    const holding = docs.filter((doc) => holds(doc, term)).length
    return [term, Math.log(1 + (docs.length - holding + 0.5) / (holding + 0.5))]
  }))
  const hits = []
  for (const doc of docs) {
    if (!terms.every((term) => holds(doc, term))) continue
    let score = 0
    let best = null
    for (const field of SEARCH_FIELDS) {
      let part = 0
      for (const term of terms) {
        const count = doc.fields[field.key].filter((word) => word.startsWith(term)).length
        part += rarity[term] * field.weight * (count / (count + 1.2))
      }
      if (part > 0 && (!best || part > best.part)) best = { field, part }
      score += part
    }
    hits.push({ path: doc.entry.path, size: doc.entry.size ?? null, score, where: best.field.where(doc.entry, terms) })
  }
  return hits.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/* --- reading the question ------------------------------------------------------------------------------ */

// Words that say how a question is asked, not what it is about.
const MEMORY_STOP_WORDS = new Set(('a an the what which who whom whose when where why how did do does i me my mine we our ours us ' +
  'you your it its is are was were be been being am to of in on at by for from with about into under inside something ' +
  'anything everything thing things note notes page pages file files save saved find found show open look looking please ' +
  'any some that this these those there here and or but so can could should would will have has had get got keep kept ' +
  'all much many as if then than too very just also tell say said know let lets like want').split(' '))
// "in my notes" names no folder.
const MEMORY_NOT_FOLDERS = new Set(['notes', 'note', 'memory', 'vault', 'repo', 'files', 'pages', 'stuff', 'head'])
const MEMORY_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const MEMORY_MONTH_WORDS = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec'
const MEMORY_WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MEMORY_DAY_MS = 86_400_000

const memoryWords = (text) => String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)

// This device's zone, or UTC when it cannot name one the clock knows.
function memoryZone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return zone || 'UTC'
  } catch (error) {
    return 'UTC'
  }
}

// The calendar day ('YYYY-MM-DD') a moment falls on in a zone.
function memoryDayIn(ms, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(ms)).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}
const memoryShiftDay = (day, by) => new Date(Date.parse(`${day}T00:00:00Z`) + by * MEMORY_DAY_MS).toISOString().slice(0, 10)
const memoryWeekday = (day) => new Date(`${day}T00:00:00Z`).getUTCDay()
function memoryCalendarDay(year, month, date) {
  const made = new Date(Date.UTC(year, month - 1, date))
  return made.getUTCFullYear() === year && made.getUTCMonth() === month - 1 && made.getUTCDate() === date ? made.toISOString().slice(0, 10) : null
}
// "Tuesday 6 October", with the year when it is not this one.
function memoryDayLabel(day, today) {
  const date = new Date(`${day}T00:00:00Z`)
  const name = `${MEMORY_WEEKDAYS[date.getUTCDay()][0].toUpperCase()}${MEMORY_WEEKDAYS[date.getUTCDay()].slice(1)}`
  const month = MEMORY_MONTHS[date.getUTCMonth()]
  const said = `${name} ${date.getUTCDate()} ${month[0].toUpperCase()}${month.slice(1)}`
  return day.slice(0, 4) === today.slice(0, 4) ? said : `${said} ${day.slice(0, 4)}`
}
const memoryMonthNumber = (word) => MEMORY_MONTHS.findIndex((month) => month.startsWith(word.slice(0, 3))) + 1

// Each way of naming a day: the words that say it, and the window it means. The first that fits wins.
const MEMORY_DAY_WAYS = [
  [/(?:\b(?:on|from)\s+)?\b(\d{4})-(\d{2})-(\d{2})\b/, (match) => memoryCalendarDay(Number(match[1]), Number(match[2]), Number(match[3]))],
  [new RegExp(`(?:\\b(?:on|from)\\s+)?(?:\\bthe\\s+)?\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MEMORY_MONTH_WORDS})\\b`), (match, today) => memoryNamedDay(today, memoryMonthNumber(match[2]), Number(match[1]))],
  [new RegExp(`(?:\\b(?:on|from)\\s+)?\\b(${MEMORY_MONTH_WORDS})\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\b`), (match, today) => memoryNamedDay(today, memoryMonthNumber(match[1]), Number(match[2]))]
]
// A day and month with no year: this year's, unless that is still to come.
function memoryNamedDay(today, month, date) {
  const year = Number(today.slice(0, 4))
  const day = memoryCalendarDay(year, month, date)
  if (!day) return null
  return day > today ? memoryCalendarDay(year - 1, month, date) : day
}

function memoryDayWindow(text, today) {
  for (const [pattern, dayOf] of MEMORY_DAY_WAYS) {
    const match = pattern.exec(text)
    const day = match ? dayOf(match, today) : null
    if (day) return { match: match[0], day: { from: day, to: day, label: memoryDayLabel(day, today) } }
  }
  const said = (pattern) => pattern.exec(text)?.[0] ?? null
  let words = said(/(?:\b(?:from|on)\s+)?\btoday\b/)
  if (words) return { match: words, day: { from: today, to: today, label: 'today' } }
  words = said(/(?:\b(?:from|on)\s+)?\byesterday\b/)
  if (words) {
    const day = memoryShiftDay(today, -1)
    return { match: words, day: { from: day, to: day, label: 'yesterday' } }
  }
  const monday = memoryShiftDay(today, -((memoryWeekday(today) + 6) % 7))
  words = said(/(?:\b(?:from|in|during)\s+)?\bthis\s+week\b/)
  if (words) return { match: words, day: { from: monday, to: today, label: 'this week' } }
  words = said(/(?:\b(?:from|in|during)\s+)?\blast\s+week\b/)
  if (words) return { match: words, day: { from: memoryShiftDay(monday, -7), to: memoryShiftDay(monday, -1), label: 'last week' } }
  const weekday = new RegExp(`(?:\\b(?:on|from)\\s+)?\\b(last\\s+|this\\s+past\\s+|this\\s+)?(${MEMORY_WEEKDAYS.join('|')})\\b`).exec(text)
  if (weekday) {
    const back = (memoryWeekday(today) - MEMORY_WEEKDAYS.indexOf(weekday[2]) + 7) % 7
    const before = /last|past/.test(weekday[1] ?? '') && back === 0 ? 7 : back
    const day = memoryShiftDay(today, -before)
    return { match: weekday[0], day: { from: day, to: day, label: memoryDayLabel(day, today) } }
  }
  return null
}

// A folder named in the question: "in/under/from/inside (my/the/our) X (folder)". Matched to a top folder
// without regard to case or a plural. "... X folder" and "in my X" name a folder even when there is no
// such folder - that is said, never dropped; a plain "in the X" names one only when X is a folder.
function memoryPlace(text, folders) {
  const base = (word) => word.toLowerCase().replace(/(?:es|s)$/, '')
  const find = (word) => folders.find((folder) => folder.toLowerCase() === word || base(folder) === base(word)) ?? null
  const ways = [
    [/\b(?:in|under|from|inside)\s+(?:my\s+|the\s+|our\s+)?([\p{L}\p{N}][\p{L}\p{N}_-]*)\s+folder\b/u, true],
    [/\b(?:in|under|from|inside)\s+my\s+([\p{L}\p{N}][\p{L}\p{N}_-]*)/u, true],
    [/\b(?:in|under|from|inside)\s+(?:the\s+|our\s+)?([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu, false]
  ]
  for (const [pattern, names] of ways) {
    const matches = pattern.global ? [...text.matchAll(pattern)] : [pattern.exec(text)].filter(Boolean)
    for (const match of matches) {
      const folder = find(match[1])
      if (folder) return { match: match[0], place: folder, missing: null }
      if (names && !MEMORY_NOT_FOLDERS.has(match[1])) return { match: match[0], place: null, missing: match[1] }
    }
  }
  return null
}

// { day: { from, to, label } | null, place, placeMissing, words, meaningText } for a question, read in
// `timeZone` at `now`. `words` are the topic words left once the day, the folder and the words that only
// say how it was asked are taken out. `meaningText` is what is sent to be matched by meaning: the
// question without its day and folder - or '' when it is only a day or a folder, or names a folder there
// is not.
function memoryQueryParts(question, { now = Date.now(), timeZone, folders = [] } = {}) {
  let text = ` ${String(question ?? '').toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ')} `
  const today = memoryDayIn(now, memoryZone(timeZone))
  const dated = memoryDayWindow(text, today)
  if (dated) text = text.replace(dated.match, ' ')
  const placed = memoryPlace(text, Array.isArray(folders) ? folders : [])
  if (placed) text = text.replace(placed.match, ' ')
  text = text.replace(/\s+/g, ' ').trim()
  const words = [...new Set(memoryWords(text).filter((word) => !MEMORY_STOP_WORDS.has(word)))]
  const day = dated?.day ?? null
  const place = placed?.place ?? null
  const placeMissing = placed?.missing ?? null
  const letters = text.replace(/[^\p{L}\p{N}]/gu, '').length
  const topicLetters = words.join('').length
  const meaningText = placeMissing ? '' : topicLetters >= 3 || (!day && !place && letters >= 3) ? text : ''
  return { day, place, placeMissing, words, meaningText }
}

/* --- names that sound alike ---------------------------------------------------------------------------- */

// A word as it sounds: its first letter, then its consonants, with the letters that sound alike made one
// (ch and ck come out as k: c is k, and h is dropped).
function memorySoundKey(word) {
  const plain = String(word ?? '').toLowerCase().replace(/[^a-z]/g, '')
  if (!plain) return ''
  const rest = plain.slice(1)
    .replace(/ph/g, 'f').replace(/[cq]/g, 'k').replace(/z/g, 's').replace(/x/g, 'ks')
    .replace(/[aeiouyhw]/g, '')
    .replace(/(.)\1+/g, '$1')
  return plain[0] + rest
}

// Known words (4+ letters) that sound like `word`: the same first letter and the same consonants, or one
// consonant different. Exact sounds first, at most 2. None for a word the board knows (a known word, or
// the start of one) or one under 4 letters.
function memoryStandIns(word, vocabulary) {
  const said = String(word ?? '').toLowerCase()
  if (said.length < 4) return []
  const known = [...new Set((vocabulary ?? []).map((one) => String(one).toLowerCase()).filter((one) => one.length >= 4))]
  if (known.some((one) => one.startsWith(said))) return []
  const key = memorySoundKey(said)
  const oneOff = (other) => other.length === key.length && key.length >= 3 &&
    [...other].filter((letter, at) => letter !== key[at]).length === 1 && other[0] === key[0]
  const same = known.filter((one) => memorySoundKey(one) === key)
  const near = known.filter((one) => !same.includes(one) && oneOff(memorySoundKey(one)))
  return [...same, ...near].slice(0, 2)
}

// The topic words heard as known names: [{ word, as }], at most 2 a word and 4 a question.
function memoryHeardAs(words, vocabulary) {
  const heard = []
  for (const word of words) {
    for (const as of memoryStandIns(word, vocabulary)) {
      if (heard.length >= 4) return heard
      heard.push({ word, as })
    }
  }
  return heard
}

/* --- one search: words, meaning, a day and a folder ---------------------------------------------------- */

// Rank fusion: each list gives its notes a rank, and a note scores 1/(60 + rank) from each list it is in -
// the usual constant, checked on Nuno's own questions in the tuning run. A name heard wrong counts 0.8.
const MEMORY_FUSION = 60
const MEMORY_HEARD_WEIGHT = 0.8
// The board is asked by meaning on Enter, or after this pause in the typing - never on every key.
const MEMORY_MEANING_PAUSE_MS = 600
// How many questions' answers this device keeps for the visit.
const MEMORY_MEANING_KEPT = 50
// A visit to Memory learns at most this many steps (200 notes each) before it stops for that visit.
const MEMORY_LEARN_STEPS = 20

const MEMORY_SAY = {
  meaning: 'close in meaning to what you asked',
  asking: 'Searching by meaning too…',
  matched: 'Also searched by meaning.',
  learning: 'Search by meaning is still learning your notes, so these are word matches for now.',
  unreachable: 'Search by meaning could not be reached, so these are word matches only.',
  editKey: 'Search by meaning needs this board\'s edit key, because it spends a little of the owner\'s OpenAI credit. Word search still works.',
  noMore: 'Search by meaning stopped for this visit: open Memory again to carry on.'
}

// The seams a test hands its stand-ins through: the clock, this device's zone, the pause, and the board.
const memoryFindDeps = {
  now: () => Date.now(),
  zone: () => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    } catch (error) {
      return 'UTC'
    }
  },
  wait: (fn, ms) => setTimeout(fn, ms),
  stop: (id) => clearTimeout(id),
  // A meaning call spends a little of the owner's money, so it goes as a write: the edit key when this
  // device holds one, never a prompt for it (storeWrite would ask).
  post: (path, body) => fetch(path, { method: 'POST', headers: writeHeaders('application/json'), body: JSON.stringify(body), redirect: 'manual' })
}

// What this visit knows about meaning: off and why (once the board says so), each question's answer,
// the learning steps, and the list voice found.
const memoryMeaning = {
  on: null,
  why: '',
  answers: new Map(),
  timer: null,
  learning: { running: false, commit: null, said: '', retryAt: 0 },
  voice: null,
  last: null
}

const memoryTopOf = (path) => (path.includes('/') ? path.slice(0, path.indexOf('/')) : '(root)')
const memoryListed = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`)

function memoryMeaningOff(why) {
  memoryMeaning.on = false
  memoryMeaning.why = why
}

// The page's own knowledge for a search: the pages, what search may use of each, each team note's title
// and day, the top folders, and the names it knows (for a name heard wrong).
function memoryFindContext() {
  const files = Array.isArray(data?.memory?.files) ? data.memory.files : []
  const index = memorySearchIndex() ?? new Map()
  const notes = new Map((graphState.data?.team?.notes ?? []).filter((note) => note && typeof note.path === 'string').map((note) => [note.path, note]))
  const folders = [...new Set(files.map((file) => memoryTopOf(file.path)).filter((top) => top !== '(root)'))].sort()
  const vocabulary = new Set(folders.map((folder) => folder.toLowerCase()))
  for (const note of notes.values()) for (const word of searchWords(note.title)) vocabulary.add(word)
  for (const entry of index.values()) {
    for (const heading of entry.headings ?? []) for (const word of searchWords(heading)) vocabulary.add(word)
    for (const tag of entry.tags ?? []) for (const word of searchWords(tag)) vocabulary.add(word)
  }
  for (const agent of Array.isArray(data?.agents) ? data.agents : []) for (const word of searchWords(agent?.slug)) vocabulary.add(word)
  return { files, index, notes, folders, vocabulary: [...vocabulary].filter((word) => word.length >= 4) }
}

const memoryTitleOf = (path, notes) => (typeof notes.get(path)?.title === 'string' ? notes.get(path).title : path.split('/').at(-1).replace(/\.md$/i, ''))

// The one search, for the box and for voice: { question, parts, hits, said, meaning }. Each hit is
// { path, title, folder, day, why, size, opening, score }, best first. `meaning` says where the meaning
// part stands: 'not asked', 'off', 'asking', 'waiting', 'learning', 'error', or 'done'.
function memoryFind(question, { now = memoryFindDeps.now(), timeZone = memoryFindDeps.zone() } = {}) {
  const context = memoryFindContext()
  const parts = memoryQueryParts(question, { now, timeZone, folders: context.folders })
  const result = { question, parts, hits: [], said: null, meaning: 'not asked', meaningSaid: '' }
  if (parts.placeMissing) {
    result.said = `There is no folder called ${parts.placeMissing}. Your folders are ${memoryListed(context.folders)}.`
    return result
  }
  const sizes = new Map(context.files.map((file) => [file.path, file.size]))
  const known = (path) => sizes.has(path) || context.notes.has(path)
  const dayOf = (path) => (typeof context.notes.get(path)?.day === 'string' ? context.notes.get(path).day : null)
  const inWindow = (path) => !parts.day || (dayOf(path) !== null && dayOf(path) >= parts.day.from && dayOf(path) <= parts.day.to)
  const inPlace = (path) => !parts.place || memoryTopOf(path) === parts.place
  const scored = new Map()
  const add = (path, rank, weight, why) => {
    if (!known(path)) return
    const hit = scored.get(path) ?? { path, score: 0, why: [] }
    hit.score += weight / (MEMORY_FUSION + rank + 1)
    if (!hit.why.includes(why)) hit.why.push(why)
    scored.set(path, hit)
  }
  const entries = context.files.map((file) => ({ ...(context.index.get(file.path) ?? {}), path: file.path, size: file.size }))
  if (parts.words.length) {
    memoryRank(entries, parts.words.join(' ')).forEach((hit, rank) => add(hit.path, rank, 1, hit.where))
    for (const { word, as } of memoryHeardAs(parts.words, context.vocabulary)) {
      memoryRank(entries, parts.words.map((one) => (one === word ? as : one)).join(' '))
        .forEach((hit, rank) => add(hit.path, rank, MEMORY_HEARD_WEIGHT, `heard as ${as}`))
    }
  }
  if (parts.meaningText) {
    const answer = memoryMeaning.answers.get(parts.meaningText)
    if (memoryMeaning.on === false) {
      result.meaning = 'off'
      result.meaningSaid = memoryMeaning.why
    } else if (!answer) {
      result.meaning = 'waiting'
    } else if (answer.pending) {
      result.meaning = 'asking'
      result.meaningSaid = MEMORY_SAY.asking
    } else if (answer.error) {
      result.meaning = 'error'
      result.meaningSaid = answer.error
    } else if (answer.learning) {
      result.meaning = 'learning'
      result.meaningSaid = MEMORY_SAY.learning
    } else {
      result.meaning = 'done'
      result.meaningSaid = MEMORY_SAY.matched
      ;(answer.hits ?? []).forEach((path, rank) => add(path, rank, 1, MEMORY_SAY.meaning))
    }
  }
  let found = [...scored.values()]
  // Only a day or a folder: every note of that day, or in that folder, newest first.
  if (!parts.words.length && !parts.meaningText && (parts.day || parts.place)) {
    found = [...new Set([...sizes.keys(), ...context.notes.keys()])].map((path) => ({ path, score: 0, why: [] }))
  }
  found = found.filter((hit) => inWindow(hit.path) && inPlace(hit.path))
  const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const newestFirst = (a, b) => String(dayOf(b.path) ?? '').localeCompare(String(dayOf(a.path) ?? '')) || byPath(a, b)
  found.sort(found.every((hit) => hit.score === 0) ? newestFirst : (a, b) => b.score - a.score || byPath(a, b))
  if (!found.length && parts.day) {
    const dated = [...context.notes.values()].filter((note) => typeof note.day === 'string' && inPlace(note.path))
      .sort((a, b) => b.day.localeCompare(a.day) || (a.path < b.path ? -1 : 1))
    const today = memoryQueryParts('today', { now, timeZone }).day.from
    const newest = dated[0]
    result.said = `No note is dated ${parts.day.label}.${newest ? ` The newest is ${memoryTitleOf(newest.path, context.notes)}, from ${newest.day === today ? 'today' : memoryDayLabel(newest.day, today)}.` : ''}`
  }
  result.hits = found.map((hit) => {
    const why = [...hit.why]
    if (parts.day) why.push(`dated ${parts.day.label}`)
    else if (!why.length && parts.place) why.push(`in ${parts.place}/`)
    return {
      path: hit.path,
      title: memoryTitleOf(hit.path, context.notes),
      folder: memoryTopOf(hit.path),
      day: dayOf(hit.path),
      why: why.join('; '),
      size: sizes.get(hit.path) ?? null,
      opening: typeof context.index.get(hit.path)?.opening === 'string' ? context.index.get(hit.path).opening : '',
      score: hit.score
    }
  })
  return result
}

/* --- asking the board ----------------------------------------------------------------------------------- */

// The board's answer for one question's meaning words, asked once a visit. Paths the page does not list
// are dropped: the answer is data, and only a note this page could open is ever shown.
function memoryAskMeaning(text) {
  const kept = memoryMeaning.answers.get(text)
  if (kept) return kept.promise
  const entry = { pending: true }
  entry.promise = (async () => {
    try {
      const response = await memoryFindDeps.post('/api/memory-search', { q: text })
      const answer = await answerOf(response)
      if (response.status === 401 && answer.needs === 'edit-key') {
        memoryMeaningOff(MEMORY_SAY.editKey)
      } else if (answer.on === false) {
        memoryMeaningOff(typeof answer.why === 'string' ? answer.why : '')
      } else if (response.ok && answer.ready === false) {
        entry.learning = true
        memoryFindLearn()
      } else if (response.ok && Array.isArray(answer.hits)) {
        memoryMeaning.on = true
        entry.hits = answer.hits.filter((hit) => Array.isArray(hit) && typeof hit[0] === 'string' && typeof hit[1] === 'number').map((hit) => hit[0])
      } else {
        entry.error = typeof answer.error === 'string' && answer.error ? answer.error : MEMORY_SAY.unreachable
      }
    } catch (error) {
      entry.error = MEMORY_SAY.unreachable
    }
    entry.pending = false
    if (location.hash.slice(1) === 'memory') memoryDrawTree()
    return entry
  })()
  memoryMeaning.answers.set(text, entry)
  while (memoryMeaning.answers.size > MEMORY_MEANING_KEPT) memoryMeaning.answers.delete(memoryMeaning.answers.keys().next().value)
  return entry.promise
}

// The box changed (or Enter): the voice list ends, and the board is asked by meaning after a pause - or
// at once on Enter - when the question has words to ask about and meaning is not off.
function memoryFindTyped(atOnce = false) {
  if (!atOnce) memoryMeaning.voice = null
  memoryFindDeps.stop(memoryMeaning.timer)
  memoryMeaning.timer = null
  if (memoryMeaning.on === false) return
  const { meaningText } = memoryQueryParts(memoryQuery, { now: memoryFindDeps.now(), timeZone: memoryFindDeps.zone(), folders: memoryFindContext().folders })
  if (!meaningText) return
  if (atOnce) memoryAskMeaning(meaningText)
  else memoryMeaning.timer = memoryFindDeps.wait(() => memoryAskMeaning(meaningText), MEMORY_MEANING_PAUSE_MS)
}

/* --- learning the notes while Memory is open ------------------------------------------------------------- */

function memoryFindShowStatus() {
  const line = el('memory-meaning')
  if (!line) return
  line.textContent = memoryMeaning.learning.said
  line.hidden = !memoryMeaning.learning.said
}

// Steps of /api/memory-index while Memory is open and the board holds a commit the index has not learned.
// Each step learns at most 200 notes; the line says how far. Closing Memory pauses it; a refusal stops
// it until its wait is over; off stops it for the visit.
async function memoryFindLearn() {
  const learning = memoryMeaning.learning
  if (learning.running || memoryMeaning.on === false || location.hash.slice(1) !== 'memory') return
  if (memoryFindDeps.now() < learning.retryAt) return
  const boardCommit = data?.commit ?? null
  if (boardCommit && learning.commit === boardCommit) return
  learning.running = true
  try {
    for (let step = 1; step <= MEMORY_LEARN_STEPS; step += 1) {
      const response = await memoryFindDeps.post('/api/memory-index', {})
      const answer = await answerOf(response)
      if (response.status === 401 && answer.needs === 'edit-key') {
        memoryMeaningOff(MEMORY_SAY.editKey)
        learning.said = ''
        break
      }
      if (answer.on === false) {
        memoryMeaningOff(typeof answer.why === 'string' ? answer.why : '')
        learning.said = ''
        break
      }
      if (!response.ok) {
        learning.said = typeof answer.error === 'string' && answer.error ? answer.error : MEMORY_SAY.unreachable
        if (Number.isInteger(answer.retryAfter) && answer.retryAfter > 0) learning.retryAt = memoryFindDeps.now() + answer.retryAfter * 1000
        break
      }
      memoryMeaning.on = true
      const indexed = Number.isInteger(answer.indexed) ? answer.indexed : 0
      const left = Number.isInteger(answer.left) ? answer.left : 0
      if (left === 0) {
        learning.commit = typeof answer.commit === 'string' ? answer.commit : boardCommit
        learning.said = ''
        break
      }
      learning.said = step === MEMORY_LEARN_STEPS ? MEMORY_SAY.noMore : `Learning your notes by meaning: ${indexed} of ${indexed + left}…`
      memoryFindShowStatus()
      if (location.hash.slice(1) !== 'memory') break
    }
  } catch (error) {
    learning.said = MEMORY_SAY.unreachable
  } finally {
    learning.running = false
    memoryFindShowStatus()
  }
}

/* --- on the screen ------------------------------------------------------------------------------------- */

// What voice found, shown as the box's own list: the question in the box, the same hits in the same
// order, numbered, so "open number two" opens what the list calls 2. The list stays exactly what voice
// was told until the person types: a meaning answer that arrives later does not move it under them.
function memoryShowFound(question, found = null) {
  memoryQuery = String(question ?? '').trim().toLowerCase()
  memoryMeaning.voice = { question: String(question ?? '').trim(), found: found ?? memoryFind(question) }
  const box = el('memory-search')
  if (box) box.value = memoryMeaning.voice.question
  memoryDrawTree()
}

// The list, built from elements: a title or a heading is somebody's own words.
function memoryFindNode() {
  const voice = memoryMeaning.voice && memoryMeaning.voice.question.toLowerCase() === memoryQuery ? memoryMeaning.voice : null
  const result = voice?.found ?? memoryFind(memoryQuery)
  const inFolder = result.hits.filter((hit) => !memorySource || memoryTopOf(hit.path) === memorySource)
  const shown = inFolder.slice(0, MEMORY_HITS_MAX)
  memoryMeaning.last = { ...result, hits: shown }
  const meaningLine = result.meaningSaid && result.meaning !== 'done'
    ? [readinessNode('p', { cls: 'mem-hits-meaning small muted', text: result.meaningSaid })]
    : []
  if (!shown.length) {
    if (result.said) return emptyStateNode('memory', readinessNode('b', { text: result.said }), ...meaningLine)
    const elsewhere = memorySource ? result.hits.length : 0
    const asked = result.meaning === 'done' ? ', or close to it in meaning' : ''
    const [said, why] = memorySource && elsewhere
      ? [`No page in ${memorySource}/ has "${memoryQuery}".`, `${elsewhere} elsewhere in your vault ${elsewhere === 1 ? 'does' : 'do'} - tap all above to see ${elsewhere === 1 ? 'it' : 'them'}.`]
      : memorySource
        ? [`No page has "${memoryQuery}", in ${memorySource}/ or anywhere else, in its name, headings, description, tags or opening words${asked}.`, MEMORY_SEARCH_SCOPE]
        : [`No page has "${memoryQuery}" in its name, headings, description, tags or opening words${asked}.`, MEMORY_SEARCH_SCOPE]
    return emptyStateNode('memory', readinessNode('b', { text: said }), readinessNode('span', { cls: 'small', text: ` ${why}` }), ...meaningLine)
  }
  const rows = shown.map((hit, at) => {
    const row = readinessNode('button', { cls: 'file mem-hit', attrs: { type: 'button' } },
      ...(voice ? [readinessNode('span', { cls: 'mem-hit-n', text: `${at + 1}.` })] : []),
      readinessNode('span', { cls: 'mem-hit-words' },
        readinessNode('span', { cls: 'mem-hit-path', text: hit.path }),
        readinessNode('span', { cls: 'mem-hit-where small muted', text: hit.why })),
      readinessNode('span', { cls: 'mem-hit-size small muted', text: hit.size ? `${Math.round(hit.size / 1024)} kb` : '' }))
    // The board's click handler opens any .file with a data-path in the viewer.
    row.dataset.path = hit.path
    return row
  })
  const count = shown.length < inFolder.length
    ? `The best ${shown.length} of ${inFolder.length} pages that match, best first.`
    : `${plural(inFolder.length, 'page')} ${inFolder.length === 1 ? 'matches' : 'match'}${result.hits.some((hit) => hit.score > 0) ? ', best first' : ', newest first'}.`
  const heading = voice ? [readinessNode('p', { cls: 'mem-hits-voice small', text: `Found by voice: "${voice.question}"` })] : []
  return readinessNode('div', { cls: 'panel mem-hits' }, ...heading, readinessNode('p', { cls: 'mem-hits-count small muted', text: count }), ...meaningLine, ...rows)
}

/* --- voice: the same search, the same list ------------------------------------------------------------- */

// How long voice waits for the meaning part before it answers with the words alone, and says so.
const MEMORY_VOICE_WAIT_MS = 4000
// The most of a spoken question that is searched (the board's own limit for meaning, api/memory-search.js).
const MEMORY_VOICE_CHARS = 300

// search_memory: the graph (what word search uses, and each note's day), the meaning part for at most
// 4 s, then the one search - and Memory opened on that very list, numbered. What it returns is what
// the voice is told about (api/_voice.js, searchMemoryAnswer), in the list's order.
async function memoryFindForVoice(question) {
  const words = String(question ?? '').replace(/\s+/g, ' ').trim().slice(0, MEMORY_VOICE_CHARS)
  if (!graphState.data) await graphFetch()
  const parts = memoryQueryParts(words, { now: memoryFindDeps.now(), timeZone: memoryFindDeps.zone(), folders: memoryFindContext().folders })
  let late = false
  if (parts.meaningText && memoryMeaning.on !== false) {
    let timer = null
    late = await Promise.race([
      memoryAskMeaning(parts.meaningText).then(() => false),
      new Promise((resolve) => { timer = memoryFindDeps.wait(() => resolve(true), MEMORY_VOICE_WAIT_MS) })
    ])
    memoryFindDeps.stop(timer)
  }
  const result = memoryFind(words)
  const found = {
    ...result,
    hits: result.hits.slice(0, MEMORY_HITS_MAX),
    byMeaning: result.meaning === 'done' ? true : result.meaning === 'off' ? 'off' : false,
    late
  }
  memorySource = ''
  if (location.hash.slice(1) !== 'memory') location.hash = '#memory'
  memoryShowFound(words, found)
  return found
}

// open_note: number N (1 to 5) of the list voice found, opened in the viewer. False for any other number.
function memoryOpenFound(n) {
  const hits = memoryMeaning.voice?.found?.hits ?? []
  if (!Number.isInteger(n) || n < 1 || n > Math.min(5, hits.length)) return false
  openFile(hits[n - 1].path)
  return true
}
