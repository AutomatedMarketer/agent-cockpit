// The Fish mouth in the page: OpenAI answers in text, the page cuts it into pieces as it arrives and
// sends each to /api/speak, and the pieces are played in order through the AudioContext the tap
// started. Talking over it stops it at once. Run against the fake browser in
// tests/helpers/voice-browser.mjs, with /api/speak answered when each test says.

import test from 'node:test'
import assert from 'node:assert/strict'
import { flush } from './helpers/page-harness.mjs'
import { REPLY_USAGE } from './helpers/voice-fixtures.mjs'
import { connected, ticketFor } from './helpers/voice-browser.mjs'

const fish = () => connected({ answer: { ticket: ticketFor('fish'), mouth: 'fish' } })
const text = (browser, delta) => browser.emit({ type: 'response.output_text.delta', delta })
const pieces = (browser) => browser.speeches.filter((speech) => !speech.body.warm).map((speech) => speech.body.text)

test('each piece goes to /api/speak the moment it is cut - the first at once, never queued behind the rest', async () => {
  const browser = await fish()
  browser.emit({ type: 'response.created' })
  text(browser, 'Three jobs are due today,')
  assert.deepEqual(pieces(browser), [], 'a piece was cut before its pause was followed by a space')
  text(browser, ' and one')
  assert.deepEqual(pieces(browser), ['Three jobs are due today,'])
  assert.deepEqual(browser.speeches[0].body, { ticket: browser.ticket, text: 'Three jobs are due today,' })
  text(browser, ' has gone quiet. The brief runs at six.')
  browser.emit({ type: 'response.output_text.done' })
  assert.deepEqual(pieces(browser), ['Three jobs are due today,', 'and one has gone quiet.', 'The brief runs at six.'])
  assert.equal(browser.ui.spoken.at(-1), 'Three jobs are due today, and one has gone quiet. The brief runs at six.')
})

test('the pieces play in the order they were cut, back to back, whatever order Fish answers in', async () => {
  const browser = await fish()
  browser.emit({ type: 'response.created' })
  text(browser, 'Three jobs are due today, and one has gone quiet. ')
  const [first, second] = browser.speeches
  second.answer()
  await flush()
  assert.equal(browser.state.context.started.length, 0, 'the second piece played before the first')
  first.answer()
  await flush()
  const [one, two] = browser.state.context.started
  assert.equal(one.buffer.text, 'Three jobs are due today,')
  assert.equal(two.buffer.text, 'and one has gone quiet.')
  assert.equal(one.to, browser.state.context.destination)
  assert.equal(two.at, one.at + 1.5, 'the second piece does not start where the first ends')
  assert.equal(browser.lastState(), 'speaking')
})

test('talking over it stops what is playing, aborts what is coming, cancels the reply and drops anything late', async () => {
  const browser = await fish()
  browser.emit({ type: 'response.created' })
  text(browser, 'Three jobs are due today, and one has gone quiet. ')
  const [first, second] = browser.speeches
  first.answer()
  await flush()
  const playing = browser.state.context.started[0]
  browser.emit({ type: 'input_audio_buffer.speech_started' })
  assert.equal(playing.stopped, true, 'the voice kept playing over the person')
  assert.equal(second.signal.aborted, true, 'a piece still on its way was not aborted')
  assert.deepEqual(browser.state.channel.sent.map((event) => event.type), ['response.cancel'])
  assert.equal(browser.lastState(), 'listening')
  // A piece answered after all that is from the old turn, and is never played.
  second.answer()
  await flush()
  assert.equal(browser.state.context.started.length, 1, 'a piece from a turn the person talked over was played')
  // And text still arriving for the old reply is not cut and sent.
  text(browser, 'More from the old reply. ')
  assert.equal(pieces(browser).length, 2)
})

test('a piece Fish could not speak is skipped; the next one plays and the words stay on screen', async () => {
  const browser = await fish()
  browser.emit({ type: 'response.created' })
  text(browser, 'Three jobs are due today, and one has gone quiet. ')
  const [first, second] = browser.speeches
  first.answer(false)
  second.answer()
  await flush()
  assert.deepEqual(browser.state.context.started.map((node) => node.buffer.text), ['and one has gone quiet.'])
  assert.equal(browser.ui.spoken.at(-1), 'Three jobs are due today, and one has gone quiet. ')
  // Bytes that are not audio are skipped the same way.
  const broken = await fish()
  broken.emit({ type: 'response.created' })
  text(broken, 'Three jobs are due today, and so on. ')
  broken.speeches[0].broken()
  await flush()
  assert.equal(broken.state.context.started.length, 0)
})

test('the warm-up goes out when the person starts talking, at most once a turn and once every 20 seconds', async () => {
  const browser = await fish()
  const warms = () => browser.speeches.filter((speech) => speech.body.warm === true)
  browser.emit({ type: 'input_audio_buffer.speech_started' })
  assert.deepEqual(warms().map((speech) => speech.body), [{ ticket: browser.ticket, warm: true }])
  browser.clock.now += 5_000
  browser.emit({ type: 'input_audio_buffer.speech_started' })
  assert.equal(warms().length, 1, 'a second warm-up inside 20 seconds')
  browser.clock.now += 21_000
  browser.emit({ type: 'input_audio_buffer.speech_started' })
  assert.equal(warms().length, 2)
})

test('the characters sent to Fish are counted, as UTF-8 bytes, into the conversation\'s outbox entry', async () => {
  const browser = await fish()
  browser.emit({ type: 'response.created' })
  text(browser, 'Olá, three jobs are due. ')
  browser.emit({ type: 'response.output_text.done' })
  browser.emit({ type: 'response.done', response: { usage: REPLY_USAGE } })
  const sent = pieces(browser).join('')
  assert.equal(browser.state.saved.at(-1).counts.fishBytes, new TextEncoder().encode(sent).length)
  assert.equal(browser.state.saved.at(-1).mouth, 'fish')
  assert.equal(browser.state.saved.at(-1).fishModel, 's2.1-pro-free')
})

test('when the last piece has played and the reply is done, it is listening again', async () => {
  const browser = await fish()
  browser.emit({ type: 'response.created' })
  text(browser, 'Three jobs are due today.')
  browser.emit({ type: 'response.output_text.done' })
  browser.emit({ type: 'response.done', response: { usage: REPLY_USAGE } })
  browser.speeches[0].answer()
  await flush()
  assert.equal(browser.lastState(), 'speaking')
  browser.state.context.started[0].onended()
  assert.equal(browser.lastState(), 'listening')
})

test('ending the call stops Fish too: nothing keeps playing, nothing keeps coming', async () => {
  const browser = await fish()
  browser.emit({ type: 'response.created' })
  text(browser, 'Three jobs are due today, and one has gone quiet. ')
  browser.speeches[0].answer()
  await flush()
  browser.call.stop('stopped')
  assert.equal(browser.state.context.started[0].stopped, true)
  assert.equal(browser.speeches[1].signal.aborted, true)
})

test('with OpenAI\'s voice, /api/speak is never called - not to speak, not to warm up', async () => {
  const browser = await connected()
  browser.emit({ type: 'input_audio_buffer.speech_started' })
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'response.output_audio_transcript.delta', delta: 'Three jobs are due today, and one has gone quiet. ' })
  browser.emit({ type: 'response.output_text.delta', delta: 'Three jobs are due today, and one has gone quiet. ' })
  browser.emit({ type: 'response.done', response: { usage: REPLY_USAGE } })
  assert.deepEqual(browser.speeches, [])
})

test('a piece that had already arrived when the person talked over it is dropped too, never played late', async () => {
  const browser = await fish()
  browser.emit({ type: 'response.created' })
  text(browser, 'Three jobs are due today, and one has gone quiet. ')
  const [first, second] = browser.speeches
  second.answer() // here already, waiting for the first to play
  await flush()
  browser.emit({ type: 'input_audio_buffer.speech_started' })
  first.answer()
  await flush()
  assert.deepEqual(browser.state.context.started, [], 'a piece from the turn the person talked over was played')
})

test('a piece still being decoded when the person talks over it is dropped too', async () => {
  const browser = await connected({ answer: { ticket: ticketFor('fish'), mouth: 'fish' }, holdDecode: true })
  browser.emit({ type: 'response.created' })
  text(browser, 'Three jobs are due today, and so on. ')
  browser.speeches[0].answer()
  await flush()
  assert.equal(browser.state.decodes.length, 1, 'the piece is not being decoded')
  browser.emit({ type: 'input_audio_buffer.speech_started' })
  browser.state.decodes[0]()
  await flush()
  assert.deepEqual(browser.state.context.started, [], 'a piece decoded after the person talked over it was played')
})
