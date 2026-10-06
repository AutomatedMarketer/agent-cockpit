// Personalise: the pure checks every write path runs before it touches the picture store.
//
// The board could not write anything until now. Each helper here is one of the reasons that is
// still safe: a slot that can only ever name one of our own files, bytes that must really be a
// picture, a name that is plain text, and a gate that a stranger's page cannot get through.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseSlot,
  slotKind,
  PICTURE_BUDGET,
  sniffImage,
  imageSize,
  cleanName,
  cleanStyle,
  cleanDescription,
  writeGate,
  isSameOriginRequest,
  isValidSlug,
  DEFAULT_ART_STYLE
} from '../api/lib.js'

/* ---------- slots: which picture a request is about ---------- */

test('the three kinds of slot are accepted as they are', () => {
  assert.equal(parseSlot('today'), 'today')
  assert.equal(parseSlot('team'), 'team')
  assert.equal(parseSlot('agent-content'), 'agent-content')
  assert.equal(parseSlot('agent-customer-service'), 'agent-customer-service')
  assert.equal(parseSlot('agent-a1'), 'agent-a1')
  assert.equal(parseSlot(`agent-${'a'.repeat(100)}`), `agent-${'a'.repeat(100)}`, 'a 100-character slug is a real slug')
})

test('a hostile or malformed slot is refused, never repaired', () => {
  // A slot becomes part of a store path. Anything that is not exactly one of our own names -
  // a traversal, an encoded traversal, an extension, a sub-path, a capital - is a refusal.
  const hostile = [
    'agent-../x', 'agent-', 'agent-A', 'agent-a--b', 'agent-a-', '-agent-a', '%2e%2e', '..',
    'team.webp', 'today/x', 'today\n', ' today', 'TODAY', 'agent-a/b', 'agent-a\\b', 'settings',
    'a'.repeat(200), `agent-${'a'.repeat(101)}`, `agent-${'a'.repeat(194)}`, ''
  ]
  for (const slot of hostile) assert.equal(parseSlot(slot), null, `${JSON.stringify(slot)} must be refused`)
  for (const slot of [undefined, null, 42, ['today'], { slot: 'today' }, true]) {
    assert.equal(parseSlot(slot), null, `${typeof slot} must be refused`)
  }
})

test('a banner and a portrait have different size budgets', () => {
  assert.equal(slotKind('today'), 'banner')
  assert.equal(slotKind('team'), 'banner')
  assert.equal(slotKind('agent-content'), 'portrait')
  assert.equal(slotKind('agent-../x'), null)
  assert.equal(slotKind(undefined), null)
  assert.deepEqual(PICTURE_BUDGET, { portrait: 45 * 1024, banner: 100 * 1024 })
})

test('slugs are judged by the one rule fire.js already uses', async () => {
  const fire = await import('../api/fire.js')
  assert.equal(fire.isValidSlug, isValidSlug, 'two slug rules would drift; one implementation')
})

/* ---------- bytes: is this really a picture ---------- */

const bytes = (...parts) =>
  Buffer.concat(parts.map((part) => (typeof part === 'string' ? Buffer.from(part, 'latin1') : Buffer.from(part))))
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const png = bytes(PNG_SIGNATURE, [0, 0, 0, 13], 'IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0], [0, 0, 0, 0])
const jpeg = bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 'JFIF', [0, 1, 1, 0, 0, 1, 0, 1, 0, 0])
const webp = (chunk = 'VP8 ') => bytes('RIFF', [26, 0, 0, 0], 'WEBP', chunk, [10, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])

test('webp, jpeg and png are recognised by their bytes', () => {
  assert.equal(sniffImage(webp('VP8 ')), 'image/webp')
  assert.equal(sniffImage(webp('VP8L')), 'image/webp')
  assert.equal(sniffImage(webp('VP8X')), 'image/webp')
  assert.equal(sniffImage(jpeg), 'image/jpeg')
  assert.equal(sniffImage(png), 'image/png')
  assert.equal(sniffImage(new Uint8Array(png)), 'image/png', 'a plain Uint8Array is bytes too')
})

test('a picture\'s width and height are read from its header, for all three formats', () => {
  // From the security review: a 10 KB webp can declare 16383 x 16383 pixels - about a gigabyte
  // once decoded - and the board stored it for every viewer's browser to open. The size is in
  // the first few dozen bytes of each format, so it is read there, before anything is stored.
  const le16 = (value) => [value & 0xff, value >> 8]
  const le24 = (value) => [value & 0xff, (value >> 8) & 0xff, value >> 16]
  const be16 = (value) => [value >> 8, value & 0xff]
  const be32 = (value) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
  const riff = (chunk, data) => bytes('RIFF', [26, 0, 0, 0], 'WEBP', chunk, [10, 0, 0, 0], data)
  const vp8l = (width, height) => {
    const bits = (width - 1) | ((height - 1) << 14)
    return riff('VP8L', [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff])
  }
  assert.deepEqual(imageSize(riff('VP8 ', [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, ...le16(1600), ...le16(686)])), { width: 1600, height: 686 })
  assert.deepEqual(imageSize(vp8l(480, 480)), { width: 480, height: 480 })
  assert.deepEqual(imageSize(vp8l(16383, 16383)), { width: 16383, height: 16383 })
  assert.deepEqual(imageSize(riff('VP8X', [0x10, 0, 0, 0, ...le24(4999), ...le24(299)])), { width: 5000, height: 300 })
  assert.deepEqual(imageSize(bytes(PNG_SIGNATURE, [0, 0, 0, 13], 'IHDR', be32(100000), be32(1), [8, 6, 0, 0, 0])), { width: 100000, height: 1 })
  // A JPEG keeps its size in a start-of-frame marker, after any number of other segments.
  const segment = (marker, body) => [0xff, marker, ...be16(body.length + 2), ...body]
  const sof = (marker, width, height) => segment(marker, [8, ...be16(height), ...be16(width), 3, 1, 0x22, 0])
  const jfif = segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0])
  const exif = segment(0xe1, new Array(3000).fill(7))
  assert.deepEqual(imageSize(bytes([0xff, 0xd8], jfif, exif, sof(0xc0, 640, 480))), { width: 640, height: 480 })
  assert.deepEqual(imageSize(bytes([0xff, 0xd8], jfif, sof(0xc2, 3000, 2000))), { width: 3000, height: 2000 }, 'a progressive JPEG')
  assert.deepEqual(imageSize(bytes([0xff, 0xd8], jfif, [0xff, 0xff], sof(0xc1, 64, 32))), { width: 64, height: 32 }, 'fill bytes before a marker')
})

test('a header whose size cannot be read gives no size, and reading it never runs off the end', () => {
  const unreadable = [
    bytes('RIFF', [26, 0, 0, 0], 'WEBP', 'VP8 ', [10, 0, 0, 0], [0x10, 0x02, 0x00, 0x00, 0x00, 0x00, 1, 0, 1, 0]), // no start code
    bytes('RIFF', [26, 0, 0, 0], 'WEBP', 'VP8 ', [10, 0, 0, 0], [0x10, 0x02]), // cut short
    bytes('RIFF', [26, 0, 0, 0], 'WEBP', 'VP8L', [10, 0, 0, 0], [0x00, 1, 2, 3, 4]), // no VP8L signature
    bytes('RIFF', [26, 0, 0, 0], 'WEBP', 'VP8X', [10, 0, 0, 0], [0, 0, 0]), // cut short
    bytes(PNG_SIGNATURE, [0, 0, 0, 13], 'IHDR', [0, 0, 1]), // cut short
    bytes(PNG_SIGNATURE, [0, 0, 0, 13], 'IHDR', [0, 0, 0, 0, 0, 0, 0, 5]), // zero wide
    bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 'JFIF'), // a segment longer than the file
    bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0, 0]), // a segment length under 2
    bytes([0xff, 0xd8, 0xff, 0xda, 0x00, 0x04, 0, 0, 0xff, 0xc0]), // the picture data begins before any size
    bytes([0xff, 0xd8, 0x00, 0x00, 0xff, 0xc0]), // not a marker where one must be
    bytes([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 8, 0, 1]), // a frame header cut short
    bytes([0xff, 0xd8, ...new Array(5000).fill(0xff)]), // nothing but fill
    Buffer.from('<svg/>'),
    Buffer.alloc(0)
  ]
  for (const data of unreadable) assert.equal(imageSize(data), null, data.subarray(0, 24).toString('hex'))
  assert.equal(imageSize('not bytes'), null)
})

test('anything that is not one of those three is refused, whatever it calls itself', () => {
  // SVG and HTML can carry script; GIF is not on the list; a WAVE file shares webp's RIFF
  // opening four bytes, and a cut-off PNG shares a real one's. The check reads past all of it.
  const refused = {
    gif: bytes('GIF89a', [1, 0, 1, 0, 0x80, 0, 0]),
    svg: bytes('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'),
    'svg with xml prolog': bytes('<?xml version="1.0"?><svg></svg>'),
    html: bytes('<!doctype html><html><script>alert(1)</script></html>'),
    'RIFF WAVE audio': bytes('RIFF', [36, 0, 0, 0], 'WAVEfmt ', [16, 0, 0, 0, 1, 0, 1, 0]),
    'RIFF WEBP with no image chunk': webp('JUNK'),
    'png signature only': bytes(PNG_SIGNATURE),
    'png first four bytes': bytes(PNG_SIGNATURE.slice(0, 4)),
    'png with no header chunk': bytes(PNG_SIGNATURE, [0, 0, 0, 13], 'tEXt', [0, 0, 0, 0]),
    'jpeg first two bytes': bytes([0xff, 0xd8]),
    empty: bytes([])
  }
  for (const [name, sample] of Object.entries(refused)) {
    assert.equal(sniffImage(sample), null, `${name} must be refused`)
  }
  for (const notBytes of [undefined, null, 'RIFF\u001a\u0000\u0000\u0000WEBPVP8 ', 42, {}]) {
    assert.equal(sniffImage(notBytes), null, 'only real bytes are sniffed')
  }
})

/* ---------- words: names, the art style, a picture description ---------- */

test('a name is trimmed and its whitespace collapsed to single spaces', () => {
  assert.equal(cleanName('  Penny  '), 'Penny')
  assert.equal(cleanName('Penny\t the\n  Pen'), 'Penny the Pen')
  assert.equal(cleanName('Zoë 🦊'), 'Zoë 🦊')
  assert.equal(cleanName(`${'a'.repeat(20)}      ${'a'.repeat(19)}`), `${'a'.repeat(20)} ${'a'.repeat(19)}`,
    'the length limit applies after collapsing, so stray spaces do not cost characters')
})

test('a name that looks like markup is kept as text, for the page to escape', () => {
  // Refusing "<" would refuse nothing an attacker needs and some names a person wants. The
  // defence is that the page always escapes a name; this function never decides what is safe HTML.
  assert.equal(cleanName('<b>Bob</b>'), '<b>Bob</b>')
  assert.equal(cleanName('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>')
})

test('a name runs 1 to 40 characters', () => {
  assert.equal(cleanName('a'.repeat(40)), 'a'.repeat(40))
  assert.equal(cleanName('a'.repeat(41)), null)
  assert.equal(cleanName(''), null)
  assert.equal(cleanName('   '), null)
  for (const value of [undefined, null, 42, ['Penny'], {}]) assert.equal(cleanName(value), null)
})

test('a name cannot carry control characters or flip the text direction around it', () => {
  // U+202E turns "Penny\u202eexe.gpj" into what reads as "Pennyjpg.exe" - and it keeps
  // reversing whatever the page prints after the name. Refused outright, like a control character.
  for (const hostile of [
    'Pen\u202eny', 'Pen\u202dny', 'Pen\u202any', '\u2066Penny\u2069', 'Pen\u2067ny',
    'Pen\u0000ny', 'Pen\u0007ny', 'Pen\u007fny', 'Pen\u0085ny', 'Pen\u009bny'
  ]) {
    assert.equal(cleanName(hostile), null, `${JSON.stringify(hostile)} must be refused`)
  }
})

test('the art style runs up to 600 characters, one paragraph', () => {
  assert.equal(cleanStyle('Watercolour animals,\n\nsoft light.'), 'Watercolour animals, soft light.')
  assert.equal(cleanStyle('a'.repeat(600)), 'a'.repeat(600))
  assert.equal(cleanStyle('a'.repeat(601)), null)
  assert.equal(cleanStyle(''), null)
  assert.equal(cleanStyle('Water\u202ecolour'), null)
  assert.equal(cleanStyle(undefined), null)
})

test('the built-in art style is one paragraph the style field itself would take, and asks for no words in the picture', () => {
  // It is offered to the owner as the style to go back to, so it must be a style they could have
  // typed: cleanStyle hands it back unchanged only if it is one paragraph of at most 600 characters.
  assert.equal(cleanStyle(DEFAULT_ART_STYLE), DEFAULT_ART_STYLE, 'the default is not a style the board would accept from its owner')
  assert.ok(!/\n/.test(DEFAULT_ART_STYLE), 'the default runs over more than one line')
  // Image models letter badly, and a word baked into a picture can neither be renamed nor read out.
  assert.match(DEFAULT_ART_STYLE, /\bNo text\b/, 'the default no longer asks for a picture without words')
  assert.match(DEFAULT_ART_STYLE, /\blogos\b/, 'the default no longer rules out logos')
  // One style makes both kinds of picture, so it says what each should look like - a portrait in
  // the manner of the eight robots that ship, a banner in the manner of the two scenes.
  assert.match(DEFAULT_ART_STYLE, /\bPortraits:[^.]*\brobot\b/, 'the default does not describe the robots a new portrait has to sit beside')
  assert.match(DEFAULT_ART_STYLE, /\bScenes:/, 'the default does not say what a banner should look like')
})

test('a picture description runs 3 to 400 characters', () => {
  assert.equal(cleanDescription('a fox'), 'a fox')
  assert.equal(cleanDescription('abc'), 'abc')
  assert.equal(cleanDescription('ab'), null)
  assert.equal(cleanDescription('a'.repeat(400)), 'a'.repeat(400))
  assert.equal(cleanDescription('a'.repeat(401)), null)
  assert.equal(cleanDescription('a fox\u0000'), null)
  assert.equal(cleanDescription({}), null)
})

/* ---------- the write gate ---------- */

const VIEW = 'a-long-enough-view-key'
const EDIT = 'a-different-edit-key'
const ours = (extra = {}) => ({
  headers: { 'x-view-key': VIEW, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...extra }
})

test('our own page, with the view key, may write', () => {
  assert.equal(writeGate(ours(), { VIEW_KEY: VIEW }), null)
  assert.equal(writeGate(ours({ 'content-type': 'application/json; charset=utf-8' }), { VIEW_KEY: VIEW }), null)
  assert.equal(writeGate(ours({ 'content-type': 'application/octet-stream' }), { VIEW_KEY: VIEW }, 'application/octet-stream'), null)
})

test('no view key is a 401 before anything else is looked at', () => {
  // Cross-site AND the wrong type AND no key: the answer is still the key, so a stranger
  // learns nothing about which of the later checks they would also have failed.
  const denied = writeGate(
    { headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' } },
    { VIEW_KEY: VIEW, EDIT_KEY: EDIT }
  )
  assert.equal(denied?.status, 401)
  assert.match(denied.error, /view key/i)
  assert.equal(writeGate(ours({ 'x-view-key': 'wrong' }), { VIEW_KEY: VIEW })?.status, 401)
  assert.equal(writeGate(ours(), {})?.status, 503, 'an unconfigured board is closed for writes as well as reads')
})

test('a request from another site is a 403, even with the view key', () => {
  assert.equal(writeGate(ours({ 'sec-fetch-site': 'cross-site' }), { VIEW_KEY: VIEW })?.status, 403)
  assert.equal(writeGate(ours({ 'sec-fetch-site': 'same-site' }), { VIEW_KEY: VIEW })?.status, 403)
  const fromElsewhere = { headers: { 'x-view-key': VIEW, origin: 'https://evil.example', host: 'board.example', 'content-type': 'application/json' } }
  assert.equal(writeGate(fromElsewhere, { VIEW_KEY: VIEW })?.status, 403)
})

test('with EDIT_KEY set, a missing or wrong edit key is a 401 that asks for it', () => {
  for (const provided of [undefined, 'wrong', EDIT.toUpperCase(), '']) {
    const request = ours(provided === undefined ? {} : { 'x-edit-key': provided })
    const denied = writeGate(request, { VIEW_KEY: VIEW, EDIT_KEY: EDIT })
    assert.equal(denied?.status, 401, `edit key ${JSON.stringify(provided)} must not pass`)
    assert.equal(denied.needs, 'edit-key', 'the page asks for the edit key only when this says so')
    assert.ok(!denied.error.includes(EDIT), 'the edit key is never echoed')
  }
  assert.equal(writeGate(ours({ 'x-edit-key': EDIT }), { VIEW_KEY: VIEW, EDIT_KEY: EDIT }), null)
})

test('a board open to everyone refuses writes until EDIT_KEY is set', () => {
  // PUBLIC_DASHBOARD=true means anyone with the URL is past the view gate. Without a second
  // key, anyone with the URL could change the pictures and spend the owner's OpenAI money.
  const denied = writeGate(ours({ 'x-view-key': undefined }), { PUBLIC_DASHBOARD: 'true' })
  assert.equal(denied?.status, 403)
  assert.match(denied.error, /EDIT_KEY/)
  assert.equal(
    writeGate(ours({ 'x-edit-key': EDIT }), { PUBLIC_DASHBOARD: 'true', EDIT_KEY: EDIT }),
    null,
    'with EDIT_KEY set, the key holder can write'
  )
  assert.equal(writeGate(ours(), { PUBLIC_DASHBOARD: 'true', EDIT_KEY: EDIT })?.status, 401)
})

test('only the exact body type the endpoint reads gets through', () => {
  // text/plain, urlencoded and multipart are the shapes another site's page can POST without
  // the browser asking us first. JSON and octet-stream make the browser ask - and we never say yes.
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '', 'application/jsonx', 'image/webp']) {
    assert.equal(writeGate(ours({ 'content-type': type }), { VIEW_KEY: VIEW })?.status, 415, `${JSON.stringify(type)} must be refused`)
  }
  assert.equal(
    writeGate(ours({ 'content-type': 'application/json' }), { VIEW_KEY: VIEW }, 'application/octet-stream')?.status,
    415,
    'an upload endpoint does not take JSON'
  )
  assert.equal(writeGate(ours({ 'content-type': undefined }), { VIEW_KEY: VIEW })?.status, 415)
})

test('the same-origin check lives in lib.js and fire.js uses that one', async () => {
  const fire = await import('../api/fire.js')
  assert.equal(fire.isSameOriginRequest, isSameOriginRequest, 'one implementation of "is this our own page"')
})
