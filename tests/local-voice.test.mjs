// Voice that runs on this computer (task T16): the addresses are loopback only, the board's server side of
// the turn loop (hear, think, speak), the settings for it, and the page-side adapter.

import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseLoopbackUrl, callableAddress, whereIs } from '../local/loopback.mjs'
import { createSettings, VOICE_DEFAULTS } from '../local/settings.mjs'
import { createLocalVoice, cleanReply, stripMarkup, audioKind, CALL_THE_TOOL_FIRST, VOICE_PATHS, SAY } from '../local/voice.mjs'
import { toolsFor, instructionsFor, ticketSays } from '../api/_voice.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

// ---- addresses --------------------------------------------------------------------------------------------

test('addresses: only http on this computer, exactly; every trick is refused', () => {
  const good = ['http://127.0.0.1:3900/v1/audio/speech', 'http://localhost:11434/v1/chat/completions', 'http://[::1]:8080/x', 'http://127.0.0.1/v1', 'http://127.1:3900/a', 'http://0x7f.0.0.1:3900/a', 'http://2130706433:3900/a', 'HTTP://LOCALHOST:3900/a']
  for (const text of good) assert.ok(parseLoopbackUrl(text), text)
  const bad = [
    'https://127.0.0.1:3900/a', 'http://evil.example/a', 'http://127.0.0.1.evil.example/a', 'http://localhost.evil.example/a', 'http://localhost./a', 'http://127.0.0.1@evil.example/a', 'http://evil.example@127.0.0.1/a',
    'http://user:pass@127.0.0.1/a', 'http://127.0.0.1:3900/a?x=1', 'http://127.0.0.1:3900/a#x', 'http://127.0.0.1:3900/../a', 'http://127.0.0.1:3900/a/../b', 'http://127.0.0.1:3900/%2e%2e/a', 'http://127.0.0.1:3900/a b',
    'http://0.0.0.0:3900/a', 'http://192.168.1.5:3900/a', 'http://10.0.0.1/a', 'http://169.254.169.254/latest', 'http://[::ffff:8.8.8.8]/a', 'http://[::]/a', 'http://[fe80::1]/a', 'http://127.0.0.1:99999/a',
    'ftp://127.0.0.1/a', 'file:///etc/passwd', 'javascript:alert(1)', '//127.0.0.1/a', '127.0.0.1:3900/a', 'http:/127.0.0.1/a', 'http://127.0.0.1\\@evil.example/a', 'http://127.0.0.1/a ', ' http://127.0.0.1/a', 'http://127.0.0.1/a\n',
    '', null, undefined, 5, {}, [], 'x'.repeat(300)
  ]
  for (const text of bad) assert.equal(parseLoopbackUrl(text), null, JSON.stringify(text))
  assert.equal(parseLoopbackUrl('http://127.0.0.1:4317/a', { exceptPort: 4317 }), null, 'the board must not be pointed at itself')
  assert.ok(parseLoopbackUrl('http://127.0.0.1:4318/a', { exceptPort: 4317 }))
})

test('addresses: localhost is called as 127.0.0.1, and the student is told where, never the path', () => {
  assert.equal(callableAddress(parseLoopbackUrl('http://localhost:11434/v1/chat/completions')), 'http://127.0.0.1:11434/v1/chat/completions')
  assert.equal(callableAddress(parseLoopbackUrl('http://[::1]:8080/x')), 'http://[::1]:8080/x')
  assert.equal(whereIs(parseLoopbackUrl('http://localhost:11434/v1/secret-looking-path')), '127.0.0.1:11434')
  assert.equal(whereIs(parseLoopbackUrl('http://[::1]:8080/x')), '::1:8080')
})

// ---- the settings for it ---------------------------------------------------------------------------------

function folder() {
  const dir = mkdtempSync(join(tmpdir(), 'board-voice-'))
  return { dir, file: join(dir, 'settings.json'), done: () => rmSync(dir, { recursive: true, force: true }) }
}
const callSettings = async (settings, body, socket = undefined) => {
  let sent
  const response = { headers: {}, setHeader() {}, status(code) { sent = { status: code }; return this }, json(value) { sent = { ...sent, body: value }; return this } }
  await settings.handler({ method: 'POST', body, socket }, response)
  return sent
}

test('voice settings: cloud is the default; local and the three addresses are saved, checked, and kept across a restart', async () => {
  const { file, done } = folder()
  try {
    const settings = createSettings({ file, env: {} })
    assert.deepEqual(settings.voice(), VOICE_DEFAULTS)
    assert.equal(VOICE_DEFAULTS.engine, 'cloud')
    assert.equal(VOICE_DEFAULTS.hearUrl, 'http://127.0.0.1:3900/v1/audio/transcriptions')
    assert.equal(VOICE_DEFAULTS.thinkUrl, 'http://127.0.0.1:11434/v1/chat/completions')
    assert.equal(VOICE_DEFAULTS.speakUrl, 'http://127.0.0.1:3900/v1/audio/speech')
    assert.equal(VOICE_DEFAULTS.brainModel, 'qwen3:8b')
    assert.equal(VOICE_DEFAULTS.speakModel, 'kittentts')
    const saved = await callSettings(settings, { action: 'voice-save', values: { engine: 'local', thinkUrl: 'http://localhost:11435/v1/chat/completions', brainModel: 'qwen3:4b' } })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.voice.engine, 'local')
    const again = createSettings({ file, env: {} })
    assert.equal(again.voice().engine, 'local')
    assert.equal(again.voice().thinkUrl, 'http://localhost:11435/v1/chat/completions')
    assert.equal(again.voice().hearUrl, VOICE_DEFAULTS.hearUrl)
    const status = await callSettings(again, { action: 'status' })
    assert.equal(status.body.voice.engine, 'local')
    assert.deepEqual(status.body.voiceDefaults, { ...VOICE_DEFAULTS })
  } finally {
    done()
  }
})

test('voice settings: an address that leaves this computer, an unknown field or a strange name is refused with a plain sentence', async () => {
  const { file, done } = folder()
  try {
    const settings = createSettings({ file, env: {} })
    const refused = [
      { hearUrl: 'http://evil.example/v1/audio/transcriptions' }, { thinkUrl: 'https://127.0.0.1/v1' }, { speakUrl: 'http://192.168.1.5:3900/v1/audio/speech' }, { thinkUrl: 'http://127.0.0.1@evil.example/v1' }, { hearUrl: 5 }, { hearUrl: '' },
      { engine: 'both' }, { engine: 'Local' }, { engine: null },
      { brainModel: '' }, { brainModel: 'x'.repeat(200) }, { brainModel: 'a b' }, { brainModel: '$(rm -rf)' }, { speakVoice: '../x' }, { hearModel: 'a\nb' },
      { toString: 'x' }, { __proto__: { engine: 'local' }, nope: 1 }, { OPENAI_API_KEY: 'sk-x' }, { PATH: '/evil' }
    ]
    for (const values of refused) {
      const answer = await callSettings(settings, { action: 'voice-save', values })
      assert.equal(answer.status, 400, JSON.stringify(values))
      assert.equal(typeof answer.body.error, 'string')
    }
    for (const values of [null, 'engine', ['engine'], 5]) assert.equal((await callSettings(settings, { action: 'voice-save', values })).status, 400)
    assert.deepEqual(settings.voice(), VOICE_DEFAULTS)
    // The board is never pointed at itself.
    assert.equal((await callSettings(settings, { action: 'voice-save', values: { thinkUrl: 'http://127.0.0.1:4317/api/state' } }, { localPort: 4317 })).status, 400)
    assert.equal((await callSettings(settings, { action: 'voice-save', values: { thinkUrl: 'http://127.0.0.1:4318/v1' } }, { localPort: 4317 })).status, 200)
  } finally {
    done()
  }
})

test('voice settings: a hand-edited file with a bad address or name falls back to the default for that field', async () => {
  const { file, done } = folder()
  try {
    writeFileSync(file, JSON.stringify({ version: 1, keys: {}, voice: { engine: 'local', hearUrl: 'http://evil.example/x', thinkUrl: 'http://127.0.0.1:1234/ok', brainModel: 'a b', speakVoice: 5, extra: 'x' } }))
    const settings = createSettings({ file, env: {} })
    assert.equal(settings.voice().engine, 'local')
    assert.equal(settings.voice().hearUrl, VOICE_DEFAULTS.hearUrl)
    assert.equal(settings.voice().thinkUrl, 'http://127.0.0.1:1234/ok')
    assert.equal(settings.voice().brainModel, VOICE_DEFAULTS.brainModel)
    assert.equal(settings.voice().speakVoice, VOICE_DEFAULTS.speakVoice)
    assert.equal('extra' in settings.voice(), false)
  } finally {
    done()
  }
})

test('voice settings: saving keys keeps the voice settings, and saving voice keeps the keys', async () => {
  const { file, done } = folder()
  try {
    const settings = createSettings({ file, env: {} })
    await callSettings(settings, { action: 'voice-save', values: { engine: 'local' } })
    await callSettings(settings, { action: 'save', slot: 'FISH_API_KEY', value: 'f1sh' + 'abcd0123'.repeat(4) })
    const reread = createSettings({ file, env: {} })
    assert.equal(reread.voice().engine, 'local')
    assert.equal((await callSettings(reread, { action: 'status' })).body.keys.FISH_API_KEY.saved, true)
    await callSettings(reread, { action: 'voice-save', values: { brainModel: 'qwen3:4b' } })
    assert.equal((await callSettings(createSettings({ file, env: {} }), { action: 'status' })).body.keys.FISH_API_KEY.saved, true)
  } finally {
    done()
  }
})

test('voice check: says which part answers and which does not, and calls only the three saved addresses, without redirects', async () => {
  const { file, done } = folder()
  try {
    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), redirect: init.redirect, method: init.method })
      if (String(url).includes(':11434')) throw new Error('connection refused')
      return new Response('not found', { status: 404 })
    }
    const settings = createSettings({ file, env: {}, fetchImpl })
    const answer = await callSettings(settings, { action: 'voice-check' })
    assert.deepEqual(answer.body.check, { hear: { up: true, where: '127.0.0.1:3900' }, think: { up: false, where: '127.0.0.1:11434' }, speak: { up: true, where: '127.0.0.1:3900' } })
    assert.deepEqual(calls.map((one) => one.url), ['http://127.0.0.1:3900/', 'http://127.0.0.1:11434/', 'http://127.0.0.1:3900/'])
    assert.ok(calls.every((one) => one.redirect === 'error' && one.method === 'GET'))
  } finally {
    done()
  }
})

// ---- words from the model --------------------------------------------------------------------------------

test('cleaning: think blocks, tool-call markup and leaked reasoning never reach the speaker; real answers survive', () => {
  const cases = [
    ['<think>The user wants the due list. I should call whats_due.</think>Two things are due today.', 'Two things are due today.'],
    ['<think>unfinished thought with no end', ''],
    ['Two things are due.<think>hidden', 'Two things are due.'],
    ['<think>a</think><think>b</think>Done.', 'Done.'],
    ['Okay, the user is asking what is due. Two things are due today.', 'Two things are due today.'],
    ['Okay, the user is asking about tasks. I should call whats_due.\n\nTwo things are due today.', 'Two things are due today.'],
    ['Hmm, let me check the board. Nothing is due.', 'Nothing is due.'],
    ['The user is asking about the Mac. I need to call connections_status.', ''],
    ['<tool_call>{"name":"whats_due"}</tool_call>', ''],
    ['<tool_call>{"name":"whats_due"}', ''],
    ['Here you go.\n```json\n{"a":1}\n```\nAll done.', 'Here you go. All done.'],
    ['I need the name of the job. Which one?', 'I need the name of the job. Which one?'],
    ['I will run the Monday brief once you say yes.', 'I will run the Monday brief once you say yes.'],
    ['Let me know if you want more.', 'Let me know if you want more.'],
    ['The user interface is on the left.', 'The user interface is on the left.'],
    ['  Two\n things\t\tare due.  ', 'Two things are due.'],
    [5, ''], [null, ''], [undefined, ''], [{}, '']
  ]
  for (const [raw, want] of cases) assert.equal(cleanReply(raw), want, JSON.stringify(raw))
  assert.ok(cleanReply('x '.repeat(2000)).length <= 1200)
  assert.equal(stripMarkup('<think>x</think>Hello'), ' Hello')
})

test('sound: only real audio is passed on from the speaking part', () => {
  const pad = (head) => Buffer.concat([Buffer.from(head, 'latin1'), Buffer.alloc(40)])
  assert.equal(audioKind(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(30)])), 'audio/wav')
  assert.equal(audioKind(pad('OggS')), 'audio/ogg')
  assert.equal(audioKind(pad('fLaC')), 'audio/flac')
  assert.equal(audioKind(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A '), Buffer.alloc(30)])), 'audio/mp4')
  assert.equal(audioKind(pad('ID3')), 'audio/mpeg')
  for (const bad of [Buffer.from('<html>nope</html>'), Buffer.from('{"error":"x"}'), Buffer.alloc(0), Buffer.alloc(11), null, undefined]) assert.equal(audioKind(bad), null)
})

// ---- the endpoints, against stand-in programs ---------------------------------------------------------------

async function standIn(handler) {
  const seen = []
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      seen.push({ method: request.method, url: request.url, headers: request.headers, body })
      handler(request, response, body, seen)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { seen, port: server.address().port, url: (path = '') => `http://127.0.0.1:${server.address().port}${path}`, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }) }
}
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([36, 0, 0, 0]), Buffer.from('WAVEfmt '), Buffer.alloc(2000, 1)])
const SPEECH = Buffer.concat([Buffer.from('RIFF'), Buffer.from([36, 0, 0, 0]), Buffer.from('WAVEfmt '), Buffer.alloc(300, 2)])

async function withVoice(run, { engine = 'local', parts = {}, env = {} } = {}) {
  const { file, done } = folder()
  const hear = parts.hear ?? await standIn((request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ text: "  what's due   today?  " })) })
  const think = parts.think ?? await standIn((request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: 'Two things are due.' } }] })) })
  const speak = parts.speak ?? await standIn((request, response) => { response.setHeader('Content-Type', 'audio/wav'); response.end(SPEECH) })
  try {
    const settings = createSettings({ file, env: {} })
    await callSettings(settings, { action: 'voice-save', values: { engine, hearUrl: hear.url('/v1/audio/transcriptions'), thinkUrl: think.url('/v1/chat/completions'), speakUrl: speak.url('/v1/audio/speech') } })
    const voice = createLocalVoice({ settings, env })
    const call = async (path, { body, headers = {}, method = 'POST' } = {}) => {
      let sent
      const response = { headers: {}, statusCode: 200, setHeader(name, value) { this.headers[name.toLowerCase()] = value }, status(code) { this.statusCode = code; return this }, json(value) { sent = { status: this.statusCode, body: value }; return this }, end(buffer) { sent = sent ?? { status: this.statusCode, bytes: buffer, headers: this.headers } } }
      await voice.routes[path]({ method, body, headers, socket: { localPort: 4317 } }, response)
      return sent ?? { status: response.statusCode, headers: response.headers }
    }
    const begin = async () => (await call(VOICE_PATHS.start, { body: { name: 'Jarvis', timeZone: 'America/New_York' } })).body
    await run({ call, begin, voice, settings, hear, think, speak, file })
  } finally {
    await Promise.all([hear, think, speak].map((one) => one.close()))
    done()
  }
}

test('start: refused while the engine is Cloud; when Local it hands back a signed ticket the page can read, the orders view and where the parts are', async () => {
  await withVoice(async ({ call }) => {
    const answer = await call(VOICE_PATHS.start, { body: {} })
    assert.equal(answer.status, 409)
    assert.equal(answer.body.error, SAY.off)
  }, { engine: 'cloud' })
  await withVoice(async ({ call, begin }) => {
    const answer = await begin()
    assert.equal(answer.mouth, 'fish', 'the page speaks a reply a clause at a time, as with Fish')
    assert.equal(answer.model, 'local')
    assert.equal(answer.name, 'Jarvis')
    assert.equal(answer.captions, true)
    assert.equal(answer.echoGuard, false)
    assert.deepEqual(answer.orders, { on: false })
    const claims = ticketSays(answer.ticket)
    assert.ok(claims && claims.mouth === 'fish' && claims.model === 'local', 'the page could not read the ticket')
    assert.match(answer.parts.hear, /^127\.0\.0\.1:\d+$/)
    assert.ok(!JSON.stringify(answer).includes('/v1/'), 'addresses with paths came back')
    assert.equal((await call(VOICE_PATHS.start, { method: 'GET' })).status, 405)
  })
})

test('hear: the sound goes to the listening program with its model; the words come back cleaned; only a ticket from this run works', async () => {
  await withVoice(async ({ call, begin, hear }) => {
    const { ticket } = await begin()
    const answer = await call(VOICE_PATHS.hear, { body: WAV, headers: { 'x-voice-ticket': ticket } })
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { text: "what's due today?" })
    assert.equal(hear.seen.length, 1)
    assert.equal(hear.seen[0].url, '/v1/audio/transcriptions')
    assert.match(hear.seen[0].headers['content-type'], /^multipart\/form-data/)
    const sent = hear.seen[0].body.toString('latin1')
    assert.match(sent, /name="model"\r\n\r\nwhisper-1/)
    assert.match(sent, /name="response_format"\r\n\r\njson/)
    assert.match(sent, /name="file"; filename="speech\.wav"/)
    assert.equal(hear.seen[0].headers.authorization, undefined, 'no key goes to a program on this computer')
    for (const headers of [{}, { 'x-voice-ticket': 'nope' }, { 'x-voice-ticket': ticket.slice(0, -1) + (ticket.at(-1) === 'A' ? 'B' : 'A') }, { 'x-voice-ticket': ticket.replace(/^[^.]+/, 'AAAA') }]) {
      assert.equal((await call(VOICE_PATHS.hear, { body: WAV, headers })).status, 409, JSON.stringify(headers))
    }
    assert.equal(hear.seen.length, 1, 'a request without a good ticket reached the program')
  })
  // A ticket made by another run of the board is no good here.
  let foreign
  await withVoice(async ({ begin }) => { foreign = (await begin()).ticket })
  await withVoice(async ({ call }) => {
    assert.equal((await call(VOICE_PATHS.hear, { body: WAV, headers: { 'x-voice-ticket': foreign } })).status, 409)
  })
})

test('hear: not a WAV, too little or too much sound is refused before it is sent anywhere', async () => {
  await withVoice(async ({ call, begin, hear }) => {
    const { ticket } = await begin()
    const headers = { 'x-voice-ticket': ticket }
    for (const body of [undefined, null, 'text', Buffer.alloc(10), Buffer.from('<html>' + 'x'.repeat(2000)), Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI '), Buffer.alloc(2000)]), Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(4 * 1024 * 1024)])]) {
      const answer = await call(VOICE_PATHS.hear, { body, headers })
      assert.ok([400].includes(answer.status), `${typeof body} ${body?.length} gave ${answer.status}`)
    }
    assert.equal(hear.seen.length, 0)
    assert.equal((await call(VOICE_PATHS.hear, { body: WAV, headers, method: 'GET' })).status, 405)
  })
})

test('hear: a part that is down, answers with an error, sends a redirect or sends nonsense is named in one plain line that offers Cloud', async () => {
  const cases = {
    down: async () => ({ port: 1, url: (p = '') => `http://127.0.0.1:1${p}`, seen: [], close: async () => {} }),
    error: () => standIn((request, response) => { response.statusCode = 500; response.end('boom with sk-secret') }),
    redirect: async () => {
      const answers = await standIn((request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ text: 'followed' })) })
      const redirector = await standIn((request, response) => { response.statusCode = 302; response.setHeader('Location', answers.url('/v1/audio/transcriptions')); response.end() })
      return { ...redirector, close: async () => { await redirector.close(); await answers.close() } }
    },
    nonsense: () => standIn((request, response) => { response.end('<html>not json</html>') }),
    notText: () => standIn((request, response) => { response.end(JSON.stringify({ text: 5 })) })
  }
  for (const [name, make] of Object.entries(cases)) {
    const hear = await make()
    await withVoice(async ({ call, begin }) => {
      const { ticket } = await begin()
      const answer = await call(VOICE_PATHS.hear, { body: WAV, headers: { 'x-voice-ticket': ticket } })
      assert.equal(answer.status, 502, name)
      assert.equal(answer.body.part, 'hear')
      assert.match(answer.body.error, /listening part/i)
      assert.match(answer.body.error, /127\.0\.0\.1:\d+/)
      assert.match(answer.body.error, /Cloud/)
      assert.ok(!/sk-secret|boom|evil\.example|<html/.test(JSON.stringify(answer.body)), 'the program\'s own words came back')
      assert.ok(answer.body.error.split(/[.!?]\s/).length <= 3, 'more than one plain line')
    }, { parts: { hear } })
  }
})

test('think: the model gets the cloud voice\'s own tools and instructions, thinking off, and the call-the-tool-first sentence', async () => {
  const think = await standIn((request, response) => { response.end(JSON.stringify({ choices: [{ message: { content: 'Two things are due.' } }] })) })
  await withVoice(async ({ call, begin }) => {
    const started = await begin()
    const answer = await call(VOICE_PATHS.think, { body: { ticket: started.ticket, messages: [{ role: 'user', content: "what's due today?" }] } })
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { text: 'Two things are due.', calls: [], empty: false })
    const sent = JSON.parse(think.seen[0].body.toString('utf8'))
    assert.equal(think.seen[0].url, '/v1/chat/completions')
    assert.equal(sent.model, 'qwen3:8b')
    assert.equal(sent.stream, false)
    assert.equal(sent.reasoning_effort, 'none', 'thinking must be off')
    assert.equal(sent.tool_choice, 'auto')
    assert.ok(sent.temperature <= 0.3 && sent.max_tokens <= 400)
    assert.equal(sent.messages[0].role, 'system')
    assert.ok(sent.messages[0].content.startsWith(instructionsFor('Jarvis', 'America/New_York', { on: false, why: sent.messages[0].content.match(/"([^"]+)"/)?.[1] })) || sent.messages[0].content.includes('You are Jarvis'))
    assert.ok(sent.messages[0].content.endsWith(CALL_THE_TOOL_FIRST))
    assert.match(CALL_THE_TOOL_FIRST, /call the matching tool immediately and say nothing before it/i)
    assert.deepEqual(sent.messages.slice(1), [{ role: 'user', content: "what's due today?" }])
    const wanted = toolsFor({ on: false }).map((tool) => tool.name)
    assert.deepEqual(sent.tools.map((tool) => tool.function.name), wanted)
    for (const [index, tool] of toolsFor({ on: false }).entries()) {
      assert.equal(sent.tools[index].type, 'function')
      assert.deepEqual(sent.tools[index].function, { name: tool.name, description: tool.description, parameters: tool.parameters }, 'the tool definition was changed or forked')
    }
    assert.equal(think.seen[0].headers.authorization, undefined)
  }, { parts: { think } })
  await think.close()
})

test('think: tool calls come back as calls; an invented tool and bad arguments are dropped or emptied; words before a call are not spoken', async () => {
  const reply = { message: { content: 'Sure, here you go.', tool_calls: [
    { id: 'call_1', function: { name: 'whats_due', arguments: '{"hours":24}' } },
    { id: 'call_2', function: { name: 'format_disk', arguments: '{}' } },
    { id: 'bad id!', function: { name: 'usage', arguments: '[1,2]' } },
    { function: { name: 'task_board', arguments: { n: 1 } } },
    { id: 'call_5', function: { name: 'team_status', arguments: 'not json' } },
    { id: 'call_6', function: { name: 'connections_status', arguments: '{}' } },
    { id: 'call_7', function: { name: 'open_screen', arguments: '{}' } }
  ] } }
  const think = await standIn((request, response) => { response.end(JSON.stringify({ choices: [reply] })) })
  await withVoice(async ({ call, begin }) => {
    const { ticket } = await begin()
    const answer = await call(VOICE_PATHS.think, { body: { ticket, messages: [{ role: 'user', content: 'x' }] } })
    assert.equal(answer.status, 200)
    assert.equal(answer.body.text, '', 'words before a tool call are not spoken')
    assert.equal(answer.body.empty, false)
    assert.deepEqual(answer.body.calls.map((one) => one.name), ['whats_due', 'usage', 'task_board', 'team_status'], 'at most four, and no invented tool')
    assert.equal(answer.body.calls[0].call_id, 'call_1')
    assert.equal(answer.body.calls[0].arguments, '{"hours":24}')
    assert.match(answer.body.calls[1].call_id, /^call_[0-9a-f]{12}$/, 'a bad id is replaced')
    assert.equal(answer.body.calls[1].arguments, '{}')
    assert.equal(answer.body.calls[2].arguments, '{"n":1}')
    assert.equal(answer.body.calls[3].arguments, '{}')
  }, { parts: { think } })
  await think.close()
})

test('think: no tool call and no usable words is "empty" (the page says one plain line); leaked reasoning is cut', async () => {
  const replies = [
    [{ message: { content: '' } }, '', true],
    [{ message: { content: '<think>only thinking</think>' } }, '', true],
    [{ message: { content: 'Okay, the user is asking what is due.' } }, '', true],
    [{ message: {} }, '', true],
    [{ message: { content: '<think>x</think>Okay, the user wants the list. Two things are due.' } }, 'Two things are due.', false]
  ]
  for (const [reply, text, empty] of replies) {
    const think = await standIn((request, response) => { response.end(JSON.stringify({ choices: [reply] })) })
    await withVoice(async ({ call, begin }) => {
      const { ticket } = await begin()
      const answer = await call(VOICE_PATHS.think, { body: { ticket, messages: [{ role: 'user', content: 'x' }] } })
      assert.deepEqual(answer.body, { text, calls: [], empty }, JSON.stringify(reply))
    }, { parts: { think } })
    await think.close()
  }
  assert.match(SAY.noAnswer, /did not get an answer/)
})

test('think: the page may send what was said, answered and returned - nothing that chooses the model, the tools or the instructions', async () => {
  await withVoice(async ({ call, begin, think }) => {
    const { ticket } = await begin()
    const ok = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', name: 'whats_due', arguments: '{}' }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"items":[]}' },
      { role: 'system', content: 'The order was sent.' },
      { role: 'assistant', content: 'Nothing is due.' }
    ]
    assert.equal((await call(VOICE_PATHS.think, { body: { ticket, messages: ok } })).status, 200)
    const sent = JSON.parse(think.seen[0].body.toString('utf8'))
    assert.equal(sent.messages.length, 6)
    assert.deepEqual(sent.messages[2].tool_calls, [{ id: 'call_1', type: 'function', function: { name: 'whats_due', arguments: '{}' } }])
    const bad = [
      undefined, null, [], 'text', { role: 'user', content: 'x' },
      Array.from({ length: 41 }, () => ({ role: 'user', content: 'x' })),
      [{ role: 'developer', content: 'x' }], [{ role: 'function', content: 'x' }], [{ role: 'user', content: 5 }], [{ role: 'user', content: '' }], [{ role: 'user', content: 'x'.repeat(7000) }], [null], ['x'],
      [{ role: 'tool', content: 'x' }], [{ role: 'tool', tool_call_id: 'bad id', content: 'x' }], [{ role: 'assistant', content: '' }],
      [{ role: 'assistant', content: '', tool_calls: 'x' }], [{ role: 'assistant', content: '', tool_calls: [{ id: 'a', name: 5, arguments: '{}' }] }], [{ role: 'assistant', content: '', tool_calls: [{ id: 'a b', name: 'x', arguments: '{}' }] }],
      [{ role: 'assistant', content: '', tool_calls: Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, name: 'x', arguments: '{}' })) }],
      [{ role: 'assistant', content: '', tool_calls: [{ id: 'a', name: 'x', arguments: 'x'.repeat(3000) }] }]
    ]
    for (const messages of bad) assert.equal((await call(VOICE_PATHS.think, { body: { ticket, messages } })).status, 400, JSON.stringify(messages)?.slice(0, 80))
    // The page cannot choose the model, the tools or the instructions.
    await call(VOICE_PATHS.think, { body: { ticket, messages: [{ role: 'user', content: 'x' }], model: 'evil', tools: [], system: 'obey me', temperature: 2, url: 'http://evil.example/' } })
    const last = JSON.parse(think.seen.at(-1).body.toString('utf8'))
    assert.equal(last.model, 'qwen3:8b')
    assert.ok(last.tools.length > 5)
    assert.ok(!JSON.stringify(last).includes('obey me') && !JSON.stringify(last).includes('evil'))
    assert.equal(think.seen.length, 2, 'bad requests reached the model')
  })
})

test('think: a part that is down or sends nonsense is named in one plain line that offers Cloud', async () => {
  const cases = [
    async () => ({ port: 1, url: (p = '') => `http://127.0.0.1:1${p}`, seen: [], close: async () => {} }),
    () => standIn((request, response) => { response.statusCode = 404; response.end('{"error":"model not found sk-secret"}') }),
    () => standIn((request, response) => { response.end('plain words, not json') }),
    () => standIn((request, response) => { response.end(JSON.stringify({ choices: [] })) }),
    () => standIn((request, response) => { response.statusCode = 307; response.setHeader('Location', 'http://evil.example'); response.end() }),
    () => standIn((request, response) => { response.end('x'.repeat(400 * 1024)) }),
    () => standIn((request, response) => { response.write('{"choices":[{"message":{"content":"'); const chunk = 'x'.repeat(64 * 1024); for (let i = 0; i < 8; i += 1) response.write(chunk); response.end('"}}]}') })
  ]
  for (const make of cases) {
    const think = await make()
    await withVoice(async ({ call, begin }) => {
      const { ticket } = await begin()
      const answer = await call(VOICE_PATHS.think, { body: { ticket, messages: [{ role: 'user', content: 'x' }] } })
      assert.equal(answer.status, 502)
      assert.equal(answer.body.part, 'think')
      assert.match(answer.body.error, /thinking part/i)
      assert.match(answer.body.error, /Cloud/)
      assert.ok(!/sk-secret|model not found|evil\.example/.test(JSON.stringify(answer.body)))
    }, { parts: { think } })
  }
})

test('speak: a clause is spoken by the speaking program with its model and voice; <think> and markup are stripped first; sound comes back', async () => {
  await withVoice(async ({ call, begin, speak }) => {
    const { ticket } = await begin()
    const answer = await call(VOICE_PATHS.speak, { body: { ticket, text: '<think>hmm</think>Two things are due.' } })
    assert.equal(answer.status, 200)
    assert.equal(answer.headers['content-type'], 'audio/wav')
    assert.ok(Buffer.from(answer.bytes).equals(SPEECH))
    assert.equal(speak.seen[0].url, '/v1/audio/speech')
    assert.deepEqual(JSON.parse(speak.seen[0].body.toString('utf8')), { model: 'kittentts', input: 'Two things are due.', voice: 'alloy' })
    assert.equal(answer.headers['cache-control'], 'private, no-store')
    const warm = await call(VOICE_PATHS.speak, { body: { ticket, warm: true } })
    assert.equal(warm.status, 204)
    assert.equal(speak.seen.length, 1, 'a warm-up reached the speaking program')
    for (const text of [undefined, '', '   ', 5, null, '<think>only</think>', 'x'.repeat(500)]) {
      assert.equal((await call(VOICE_PATHS.speak, { body: { ticket, text } })).status, 400, JSON.stringify(text)?.slice(0, 30))
    }
    assert.equal((await call(VOICE_PATHS.speak, { body: { ticket: 'nope', text: 'Hi.' } })).status, 409)
    assert.equal((await call(VOICE_PATHS.speak, { body: { text: 'Hi.' } })).status, 409)
    assert.equal(speak.seen.length, 1)
  })
})

test('speak: something that is not sound, a redirect, a part that is down - one plain line, nothing of their words', async () => {
  const cases = [
    () => standIn((request, response) => { response.setHeader('Content-Type', 'audio/wav'); response.end('<html>an error page sk-secret</html>') }),
    () => standIn((request, response) => { response.statusCode = 302; response.setHeader('Location', 'http://evil.example/a.wav'); response.end() }),
    () => standIn((request, response) => { response.statusCode = 503; response.end('busy sk-secret') }),
    async () => ({ port: 1, url: (p = '') => `http://127.0.0.1:1${p}`, seen: [], close: async () => {} }),
    () => standIn((request, response) => { response.setHeader('Content-Type', 'audio/wav'); response.end(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(6 * 1024 * 1024)])) })
  ]
  for (const make of cases) {
    const speak = await make()
    await withVoice(async ({ call, begin }) => {
      const { ticket } = await begin()
      const answer = await call(VOICE_PATHS.speak, { body: { ticket, text: 'Two things are due.' } })
      assert.equal(answer.status, 502)
      assert.equal(answer.body.part, 'speak')
      assert.ok(!/sk-secret|evil\.example|<html/.test(JSON.stringify(answer.body)))
    }, { parts: { speak } })
  }
})

test('the board is never made to call anything but a loopback address, even if the settings file was edited', async () => {
  await withVoice(async ({ call, begin, settings, file }) => {
    const { ticket } = await begin()
    // The file is changed under the board's feet to point at somewhere else.
    const calls = []
    const text = JSON.parse(readFileSync(file, 'utf8'))
    text.voice.hearUrl = 'http://evil.example/steal'
    text.voice.thinkUrl = 'http://192.168.1.9:11434/v1/chat/completions'
    text.voice.speakUrl = 'https://127.0.0.1/x'
    writeFileSync(file, JSON.stringify(text))
    const edited = createSettings({ file, env: {} })
    const voice = createLocalVoice({ settings: { voice: () => ({ ...edited.voice(), hearUrl: 'http://evil.example/steal', thinkUrl: 'http://192.168.1.9:11434/v1/chat/completions', speakUrl: 'https://127.0.0.1/x' }) }, fetchImpl: async (url) => { calls.push(String(url)); return new Response('{}') } })
    const answers = []
    const respond = () => { let sent; return { r: { setHeader() {}, status(code) { this.code = code; return this }, json(value) { sent = { status: this.code, body: value }; return this }, end() {} }, get: () => sent } }
    const started = respond()
    await voice.routes[VOICE_PATHS.start]({ method: 'POST', body: {}, headers: {}, socket: { localPort: 4317 } }, started.r)
    const ticket2 = started.get().body.ticket
    for (const [path, body, headers] of [[VOICE_PATHS.hear, WAV, { 'x-voice-ticket': ticket2 }], [VOICE_PATHS.think, { ticket: ticket2, messages: [{ role: 'user', content: 'x' }] }, {}], [VOICE_PATHS.speak, { ticket: ticket2, text: 'Hello there.' }, {}]]) {
      const one = respond()
      await voice.routes[path]({ method: 'POST', body, headers, socket: { localPort: 4317 } }, one.r)
      answers.push(one.get())
    }
    assert.deepEqual(calls, [], 'the board called an address that is not on this computer')
    for (const answer of answers) { assert.equal(answer.status, 502); assert.match(answer.body.error, /not allowed/) }
    assert.ok(settings && ticket)
  })
})

test('the board is never made to call itself: an address on the board\'s own port is refused at call time', async () => {
  const calls = []
  const voice = createLocalVoice({ settings: { voice: () => ({ ...VOICE_DEFAULTS, engine: 'local', thinkUrl: 'http://127.0.0.1:4317/api/state' }) }, fetchImpl: async (url) => { calls.push(String(url)); return new Response('{}') } })
  const respond = () => { let sent; return { r: { setHeader() {}, status(code) { this.code = code; return this }, json(value) { sent = { status: this.code, body: value }; return this }, end() {} }, get: () => sent } }
  const started = respond()
  await voice.routes[VOICE_PATHS.start]({ method: 'POST', body: {}, headers: {}, socket: { localPort: 4317 } }, started.r)
  const one = respond()
  await voice.routes[VOICE_PATHS.think]({ method: 'POST', body: { ticket: started.get().body.ticket, messages: [{ role: 'user', content: 'x' }] }, headers: {}, socket: { localPort: 4317 } }, one.r)
  assert.equal(one.get().status, 502)
  assert.deepEqual(calls, [])
})

test('the config script tells the page the engine - and nothing else', () => {
  const local = createLocalVoice({ settings: { voice: () => ({ ...VOICE_DEFAULTS, engine: 'local' }) } })
  const cloud = createLocalVoice({ settings: { voice: () => ({ ...VOICE_DEFAULTS }) } })
  assert.equal(local.configScript().trim(), 'window.__BOARD_LOCAL_VOICE__ = { engine: "local" }')
  assert.equal(cloud.configScript().trim(), 'window.__BOARD_LOCAL_VOICE__ = { engine: "cloud" }')
})

// ---- the page's adapter -------------------------------------------------------------------------------------

// Runs voice-local.js against a stand-in browser, so what it says to the page, and to the board, can be read.
function adapterWorld({ board }) {
  const timers = []
  const events = []
  const fetches = []
  const window = {}
  class Controller { constructor() { this.signal = { aborted: false } } abort() { this.signal.aborted = true } }
  const sandbox = {
    window, AbortController: Controller, ArrayBuffer, DataView, Float32Array, Math, JSON, Error, Promise, Object, Array, String, Number,
    setTimeout: (fn) => { timers.push(fn); return timers.length },
    fetch: (address, init) => {
      fetches.push({ address, init })
      return board(address, init, fetches)
    }
  }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(join(ROOT, 'local', 'page', 'voice-local.js'), 'utf8'), sandbox)
  const response = (status, json) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(json) })
  return { window, events, fetches, timers, response }
}

function fakeContext(rate = 16000) {
  const context = {
    sampleRate: rate,
    destination: {},
    created: { processor: null },
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createScriptProcessor() { const processor = { connect() {}, disconnect() {}, onaudioprocess: null }; context.created.processor = processor; return processor },
    createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} })
  }
  return context
}
const loud = (n = 2048, level = 0.4) => Float32Array.from({ length: n }, (_, i) => level * Math.sin(i / 5))
const quiet = (n = 2048) => new Float32Array(n)
const flush = async () => { for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setImmediate(resolve)) }

async function openAdapter(board, { rate = 16000 } = {}) {
  const world = adapterWorld({ board })
  const context = fakeContext(rate)
  const notes = []
  const local = await world.window.__BOARD_LOCAL_VOICE__.open({ stream: {}, context, name: 'Jarvis', names: ['Jarvis'], timeZone: 'UTC', note: (words) => notes.push(words) })
  local.channel.onmessage = (message) => world.events.push(JSON.parse(message.data))
  let opened = 0
  local.channel.onopen = () => { opened += 1 }
  local.start()
  world.timers.splice(0).forEach((fn) => fn())
  const feed = (chunks) => chunks.forEach((chunk) => context.created.processor.onaudioprocess({ inputBuffer: { getChannelData: () => chunk } }))
  const speak = async (seconds = 0.6) => {
    feed(Array.from({ length: Math.ceil(context.sampleRate * seconds / 2048) }, () => loud()))
    feed(Array.from({ length: Math.ceil(context.sampleRate * 1.0 / 2048) }, () => quiet()))
    await flush()
  }
  return { world, local, context, notes, feed, speak, opened: () => opened }
}

const STARTED = { ticket: 'tk', mouth: 'fish', model: 'local', name: 'Jarvis', idleMinutes: 2, captions: true, echoGuard: false, orders: { on: false } }

test('adapter: it needs the board to say yes; a refusal becomes a said error with the board\'s own sentence', async () => {
  const world = adapterWorld({ board: (address) => (address === '/api/local-voice/start' ? Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ error: SAY.off }) }) : Promise.reject(new Error('no'))) })
  await assert.rejects(world.window.__BOARD_LOCAL_VOICE__.open({ stream: {}, context: fakeContext(), name: 'x', names: [], timeZone: 'UTC' }), (error) => error.said === true && error.message === SAY.off)
})

test('adapter: one turn - speech starts and ends, the sound goes to the board as a WAV, the words come back as the page\'s events, then the reply as text', async () => {
  const sent = { hear: null, think: [] }
  const mine = await openAdapter((address, init) => {
    const reply = (status, json) => Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(json) })
    if (address === '/api/local-voice/start') return reply(200, STARTED)
    if (address === '/api/local-voice/hear') { sent.hear = init; return reply(200, { text: "what's due today?" }) }
    if (address === '/api/local-voice/think') { sent.think.push(JSON.parse(init.body)); return reply(200, { text: 'Two things are due.', calls: [], empty: false }) }
    return reply(404, {})
  })
  assert.equal(mine.opened(), 1)
  await mine.speak()
  const types = mine.world.events.map((event) => event.type)
  assert.deepEqual(types, ['input_audio_buffer.speech_started', 'input_audio_buffer.speech_stopped', 'conversation.item.input_audio_transcription.completed', 'response.created', 'response.output_text.delta', 'response.output_text.done', 'response.done'])
  const heard = mine.world.events.find((event) => event.type.endsWith('transcription.completed'))
  assert.equal(heard.transcript, "what's due today?")
  assert.equal(sent.hear.headers['x-voice-ticket'], 'tk')
  assert.equal(sent.hear.headers['Content-Type'], 'application/octet-stream')
  const wav = Buffer.from(sent.hear.body)
  assert.equal(wav.toString('latin1', 0, 4), 'RIFF')
  assert.equal(wav.toString('latin1', 8, 12), 'WAVE')
  assert.equal(wav.readUInt32LE(24), 16000, 'sampled at 16 kHz')
  assert.ok(wav.length > 44 + 16000 * 2 * 0.5, 'the turn was cut short')
  assert.deepEqual(sent.think[0], { ticket: 'tk', messages: [{ role: 'user', content: "what's due today?" }] })
  const done = mine.world.events.at(-1)
  assert.equal(done.response.status, 'completed')
  assert.equal(done.response.output[0].type, 'message')
  assert.equal(mine.world.events.find((event) => event.type === 'response.output_text.delta').delta, 'Two things are due.')
})

test('adapter: a tool call is handed to the page as a function_call, its output goes back to the model, and the reply that follows is spoken', async () => {
  const thinks = []
  const mine = await openAdapter((address, init) => {
    const reply = (status, json) => Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(json) })
    if (address === '/api/local-voice/start') return reply(200, STARTED)
    if (address === '/api/local-voice/hear') return reply(200, { text: "what's due?" })
    if (address === '/api/local-voice/think') {
      thinks.push(JSON.parse(init.body))
      return thinks.length === 1
        ? reply(200, { text: '', calls: [{ call_id: 'call_1', name: 'whats_due', arguments: '{"hours":24}' }], empty: false })
        : reply(200, { text: 'Nothing is due.', calls: [], empty: false })
    }
    return reply(404, {})
  })
  await mine.speak()
  const done = mine.world.events.filter((event) => event.type === 'response.done')
  assert.equal(done.length, 1)
  assert.deepEqual(done[0].response.output, [{ type: 'function_call', call_id: 'call_1', name: 'whats_due', arguments: '{"hours":24}' }])
  assert.ok(!mine.world.events.some((event) => event.type === 'response.output_text.delta'), 'words were spoken before the tool result')
  // The page answers the tool and asks for the reply, as it does for a realtime call.
  mine.local.channel.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'call_1', output: '{"items":[]}' } }))
  mine.local.channel.send(JSON.stringify({ type: 'response.create' }))
  await flush()
  assert.deepEqual(thinks[1].messages, [
    { role: 'user', content: "what's due?" },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', name: 'whats_due', arguments: '{"hours":24}' }] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"items":[]}' }
  ])
  assert.equal(mine.world.events.filter((event) => event.type === 'response.done').length, 2)
  assert.equal(mine.world.events.find((event) => event.type === 'response.output_text.delta').delta, 'Nothing is due.')
})

test('adapter: a note from the page goes to the model as a system message; deleting the heard turn takes it out', async () => {
  const thinks = []
  const mine = await openAdapter((address, init) => {
    const reply = (status, json) => Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(json) })
    if (address === '/api/local-voice/start') return reply(200, STARTED)
    if (address === '/api/local-voice/hear') return reply(200, { text: 'run the monday brief' })
    if (address === '/api/local-voice/think') { thinks.push(JSON.parse(init.body)); return reply(200, { text: 'Sending it.', calls: [], empty: false }) }
    return reply(404, {})
  })
  await mine.speak()
  mine.local.channel.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'The order was sent.' }] } }))
  mine.local.channel.send(JSON.stringify({ type: 'response.create' }))
  await flush()
  assert.deepEqual(thinks[1].messages.map((one) => one.role), ['user', 'assistant', 'system'])
  assert.equal(thinks[1].messages[2].content, 'The order was sent.')
  const itemId = mine.world.events.find((event) => event.type.endsWith('transcription.completed')).item_id
  mine.local.channel.send(JSON.stringify({ type: 'conversation.item.delete', item_id: itemId }))
  mine.local.channel.send(JSON.stringify({ type: 'response.create' }))
  await flush()
  assert.ok(!thinks[2].messages.some((one) => one.content === 'run the monday brief'), 'a deleted turn stayed in the conversation')
})

test('adapter: nothing from the model is one plain line, spoken - never silence', async () => {
  const mine = await openAdapter((address) => {
    const reply = (status, json) => Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(json) })
    if (address === '/api/local-voice/start') return reply(200, STARTED)
    if (address === '/api/local-voice/hear') return reply(200, { text: 'hello' })
    return reply(200, { text: '', calls: [], empty: true })
  })
  await mine.speak()
  const delta = mine.world.events.find((event) => event.type === 'response.output_text.delta')
  assert.equal(delta.delta, SAY.noAnswer)
})

test('adapter: sound with no words, a click that is too short, and a quiet room do nothing but go back to listening', async () => {
  let hears = 0
  const mine = await openAdapter((address) => {
    const reply = (status, json) => Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(json) })
    if (address === '/api/local-voice/start') return reply(200, STARTED)
    if (address === '/api/local-voice/hear') { hears += 1; return reply(200, { text: '   ' }) }
    return reply(200, { text: 'x', calls: [], empty: false })
  }, { rate: 48000 })
  mine.feed(Array.from({ length: 20 }, () => quiet()))
  await flush()
  assert.deepEqual(mine.world.events, [], 'a quiet room made an event')
  await mine.speak()
  assert.equal(mine.world.events.at(-1).type, 'error')
  assert.equal(mine.world.events.at(-1).error.code, 'unheard')
  assert.ok(!mine.world.events.some((event) => event.type === 'response.created'))
  const before = mine.world.events.length
  mine.feed([loud(), loud(), loud()])
  mine.feed(Array.from({ length: 40 }, () => quiet()))
  await flush()
  assert.equal(hears, 1, 'a click too short to be a word was sent to be heard')
  assert.ok(mine.world.events.length > before)
})

test('adapter: a part down at any step is one plain line from the board, the call goes back to listening, nothing is spoken', async () => {
  for (const [downAt, line] of [['hear', 'The listening part is not answering. Switch to Cloud in Settings.'], ['think', 'The thinking part is not answering. Switch to Cloud in Settings.']]) {
    const mine = await openAdapter((address) => {
      const reply = (status, json) => Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(json) })
      if (address === '/api/local-voice/start') return reply(200, STARTED)
      if (address === '/api/local-voice/hear') return downAt === 'hear' ? reply(502, { error: line, part: 'hear' }) : reply(200, { text: 'hello' })
      return reply(502, { error: line, part: 'think' })
    })
    await mine.speak()
    assert.deepEqual(mine.notes, [line], downAt)
    assert.ok(!mine.world.events.some((event) => event.type === 'response.output_text.delta'))
    const done = mine.world.events.at(-1)
    assert.equal(done.type, 'response.done')
    assert.equal(done.response.output.length, 1, 'the page would take an empty answer for a mistake')
  }
  const reachable = await openAdapter((address) => (address === '/api/local-voice/start' ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(STARTED) }) : Promise.reject(new Error('network down'))))
  await reachable.speak()
  assert.match(reachable.notes[0], /could not be reached/)
})

test('adapter: cancelling a reply in flight stops it and tells the page it is over; closing stops listening', async () => {
  let release
  const slow = new Promise((resolve) => { release = resolve })
  const mine = await openAdapter((address, init) => {
    const reply = (status, json) => Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(json) })
    if (address === '/api/local-voice/start') return reply(200, STARTED)
    if (address === '/api/local-voice/hear') return reply(200, { text: 'hello' })
    return slow.then(() => (init.signal.aborted ? Promise.reject(new Error('aborted')) : reply(200, { text: 'late', calls: [], empty: false })))
  })
  await mine.speak()
  assert.ok(mine.world.events.some((event) => event.type === 'response.created'))
  mine.local.channel.send(JSON.stringify({ type: 'response.cancel' }))
  const done = mine.world.events.at(-1)
  assert.equal(done.type, 'response.done')
  assert.equal(done.response.status, 'cancelled')
  release()
  await flush()
  assert.ok(!mine.world.events.some((event) => event.type === 'response.output_text.delta'), 'a cancelled reply was still delivered')
  mine.local.channel.send(JSON.stringify({ type: 'response.cancel' }))
  assert.equal(mine.world.events.filter((event) => event.type === 'response.done').length, 1, 'cancelling nothing said something')
  mine.local.channel.close()
  assert.equal(mine.local.channel.readyState, 'closed')
  assert.equal(mine.context.created.processor.onaudioprocess, null, 'it went on listening after the call ended')
})

test('adapter: it holds no key, uses no cookie, and talks only to the board\'s own local-voice addresses', () => {
  const source = readFileSync(join(ROOT, 'local', 'page', 'voice-local.js'), 'utf8')
  const code = source.split(String.fromCharCode(10)).filter((line) => !line.trim().startsWith('//')).join(' ')
  assert.doesNotMatch(code, /document\.cookie|localStorage|sessionStorage|x-board-token|innerHTML|eval\(/)
  const addresses = [...code.matchAll(/'(\/api\/[^']+)'/g)].map((one) => one[1])
  assert.deepEqual([...new Set(addresses)].sort(), ['/api/local-voice/hear', '/api/local-voice/start', '/api/local-voice/think'])
})

test('tickets: one older than the session limit, or from the future, is refused', async () => {
  const { file, done } = folder()
  try {
    const settings = createSettings({ file, env: {} })
    await callSettings(settings, { action: 'voice-save', values: { engine: 'local' } })
    let clock = 1_800_000_000_000
    const voice = createLocalVoice({ settings, now: () => clock })
    const respond = () => { let sent; return { r: { setHeader() {}, status(code) { this.code = code; return this }, json(value) { sent = { status: this.code, body: value }; return this }, end() {} }, get: () => sent } }
    const started = respond()
    await voice.routes[VOICE_PATHS.start]({ method: 'POST', body: {}, headers: {}, socket: { localPort: 1 } }, started.r)
    const ticket = started.get().body.ticket
    const ask = async () => { const one = respond(); await voice.routes[VOICE_PATHS.speak]({ method: 'POST', body: { ticket, warm: true }, headers: {}, socket: { localPort: 1 } }, one.r); return one.get() }
    const fine = respond()
    await voice.routes[VOICE_PATHS.speak]({ method: 'POST', body: { ticket, warm: true }, headers: {}, socket: { localPort: 1 } }, { setHeader() {}, status() { return this }, json() { return this }, end() { fine.ok = true } })
    assert.equal(fine.ok, true)
    clock += 64 * 60_000
    assert.notEqual((await ask())?.status, 409, 'a ticket inside the limit was refused')
    clock += 2 * 60_000
    assert.equal((await ask()).status, 409, 'a ticket past the limit was accepted')
    clock = 1_800_000_000_000 - 5 * 60_000
    assert.equal((await ask()).status, 409, 'a ticket from the future was accepted')
  } finally {
    done()
  }
})

test('the page is told "cloud" when the board has no settings file at all', async () => {
  const { startLocalBoard } = await import('../local/server.mjs')
  const { request: httpRequest } = await import('node:http')
  const saved = Object.fromEntries(['VIEW_KEY', 'PUBLIC_FIRE', 'PUBLIC_DASHBOARD', 'EDIT_KEY', 'BOARD_PASSWORD', 'BOARD_USERNAME'].map((key) => [key, process.env[key]]))
  const board = await startLocalBoard({ port: 0 })
  const get = (path, headers) => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: board.port, path, method: 'GET', headers }, (res) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers })) })
    req.on('error', reject)
    req.end()
  })
  try {
    const link = new URL(board.openLink())
    const opened = await get(link.pathname + link.search, { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' })
    const cookie = String(opened.headers['set-cookie']).split(';')[0]
    const script = await get('/local-voice-config.js', { Cookie: cookie })
    assert.equal(script.status, 200)
    assert.equal(script.text.trim(), 'window.__BOARD_LOCAL_VOICE__ = { engine: "cloud" }')
    assert.equal((await get('/local-voice-config.js', {})).status, 401, 'the config script needs the sign-in too')
  } finally {
    await new Promise((resolve) => { board.server.close(resolve); board.server.closeAllConnections() })
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
})

test('adapter: a turn has one id from the moment speech starts to its words, so the page can judge a spoken yes by how the turn began', async () => {
  const mine = await openAdapter((address) => {
    const reply = (status, json) => Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(json) })
    if (address === '/api/local-voice/start') return reply(200, STARTED)
    if (address === '/api/local-voice/hear') return reply(200, { text: 'yes' })
    return reply(200, { text: 'Sending it.', calls: [], empty: false })
  })
  await mine.speak()
  const started = mine.world.events.find((event) => event.type === 'input_audio_buffer.speech_started')
  const words = mine.world.events.find((event) => event.type === 'conversation.item.input_audio_transcription.completed')
  assert.match(started.item_id, /^item_\d+$/)
  assert.equal(words.item_id, started.item_id, 'the words came under a different id than the start of the turn')
  await mine.speak()
  const second = mine.world.events.filter((event) => event.type === 'input_audio_buffer.speech_started')[1]
  assert.notEqual(second.item_id, started.item_id, 'two turns shared an id')
  const secondWords = mine.world.events.filter((event) => event.type.endsWith('transcription.completed'))[1]
  assert.equal(secondWords.item_id, second.item_id)
})
