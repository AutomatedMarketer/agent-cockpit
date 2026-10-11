/* ---------- Memory: finding a note (memory-find.js) ----------
   Loaded the first time Memory opens, or the first time the voice assistant is asked to find a note, so
   no visit pays for it before then. A plain script sharing the page's scope, like memory-graph.js.

   One search, for the box and for voice alike: the words of the question are ranked on this device
   (memoryRank, in app.js) and, when the board has search by meaning switched on, sent to the board,
   which ranks the notes by meaning (api/memory-search.js). The two lists become one. A day ("today",
   "last Tuesday", "on 3 October") and a folder ("in shared", "in my inbox") are read from the question
   here, in this device's own time zone, and narrow the list. */

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
