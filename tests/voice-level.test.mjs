// The orb's glow while a reply plays: it follows how loud the reply really is, read by an
// AnalyserNode from the sound already playing - the call's own track for OpenAI's voice, Fish's
// pieces on their way to the speakers. Nothing is fetched or sent for it, and a device that asks for
// less motion gets no meter at all. Run against the fake browser in tests/helpers/voice-browser.mjs.

import test from 'node:test'
import assert from 'node:assert/strict'
import { flush, loadPage } from './helpers/page-harness.mjs'
import { connected, ticketFor } from './helpers/voice-browser.mjs'
import { cssRules } from './helpers/css-rules.mjs'
import { basePayload, brandAnswer, VOICE_ON } from './helpers/page-payload.mjs'

const FISH = { answer: { ticket: ticketFor('fish'), mouth: 'fish' } }
const settle = (browser) => {
  for (let frame = 0; frame < 200 && browser.frames.size; frame += 1) browser.frame()
}

test('with OpenAI\'s voice the glow follows the call\'s own sound - read where it plays, never played twice', async () => {
  const browser = await connected({ motion: true })
  const remote = { id: 'the call' }
  browser.state.pc.ontrack({ track: { kind: 'audio' }, streams: [remote] })
  const [analyser] = browser.state.context.analysers
  const [source] = browser.state.context.sources
  assert.equal(source?.stream, remote, 'the meter does not read the call\'s sound')
  assert.equal(source.to, analyser)
  assert.equal(analyser.to, null, 'the call\'s sound would play twice: from the <audio> element and through the meter')
  assert.equal(browser.frames.size, 0, 'it measures before anything is said')

  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'output_audio_buffer.started' })
  browser.state.loudness = 16
  browser.frame()
  assert.equal(browser.ui.levels.at(-1), 0.5)
  // Twice as loud as full glow: it rises at once, and no further than full.
  browser.state.loudness = 64
  browser.frame()
  assert.equal(browser.ui.levels.at(-1), 1, 'the glow did not rise with the voice at once, or went past full')
  browser.state.loudness = 0
  browser.frame()
  const falling = browser.ui.levels.at(-1)
  assert.ok(falling > 0.5 && falling < 1, `the glow dropped to ${falling} at once, rather than falling slowly`)

  // The sound ends: the glow settles to still, and nothing more is measured.
  browser.emit({ type: 'output_audio_buffer.stopped' })
  settle(browser)
  assert.equal(browser.ui.levels.at(-1), 0)
  assert.equal(browser.frames.size, 0, 'it kept measuring after the sound had stopped')
  // Nothing was fetched for it: the one request is the call itself.
  assert.equal(browser.state.calls.length, 1)
  assert.equal(browser.speeches.length, 0)
})

test('with Fish, its pieces play through the meter on their way to the speakers', async () => {
  const browser = await connected({ motion: true, ...FISH })
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'response.output_text.delta', delta: 'Three jobs are due today, and one ' })
  browser.speeches[0].answer()
  await flush()
  const [analyser] = browser.state.context.analysers
  const [piece] = browser.state.context.started
  assert.equal(piece.to, analyser, 'a piece goes round the meter')
  assert.equal(analyser.to, browser.state.context.destination, 'Fish would be silent')
  browser.state.loudness = 16
  browser.frame()
  assert.equal(browser.ui.levels.at(-1), 0.5)
  assert.equal(browser.speeches.length, 1, 'the meter asked Fish for something')
})

test('a device that asks for less motion gets no meter: nothing measured, nothing moved, Fish straight to the speakers', async () => {
  for (const [what, options] of [['OpenAI', {}], ['Fish', FISH]]) {
    const browser = await connected(options)
    browser.state.pc.ontrack({ track: { kind: 'audio' }, streams: [{ id: 'the call' }] })
    browser.emit({ type: 'response.created' })
    browser.emit({ type: 'output_audio_buffer.started' })
    if (what === 'Fish') {
      browser.emit({ type: 'response.output_text.delta', delta: 'Three jobs are due today, and one ' })
      browser.speeches[0].answer()
      await flush()
      assert.equal(browser.state.context.started[0].to, browser.state.context.destination)
    }
    assert.equal(browser.state.context.analysers.length + browser.state.context.sources.length, 0, `${what}: a meter was made`)
    assert.equal(browser.frames.size, 0, `${what}: a frame was asked for`)
    assert.deepEqual(browser.ui.levels, [], `${what}: the glow was moved`)
  }
})

test('hanging up mid-reply stops the meter: no frame left waiting, the glow still, the sound let go', async () => {
  const browser = await connected({ motion: true })
  browser.state.pc.ontrack({ track: { kind: 'audio' }, streams: [{ id: 'the call' }] })
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'output_audio_buffer.started' })
  browser.state.loudness = 16
  browser.frame()
  browser.call.stop('stopped')
  assert.equal(browser.frames.size, 0, 'a frame was left waiting after the call ended')
  assert.equal(browser.ui.levels.at(-1), 0)
  assert.equal(browser.state.context.sources[0].disconnected, true)
})

test('in speakers mode the interrupt stills the glow too', async () => {
  const browser = await connected({ motion: true, finePointer: true })
  browser.state.pc.ontrack({ track: { kind: 'audio' }, streams: [{ id: 'the call' }] })
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'output_audio_buffer.started' })
  browser.state.loudness = 32
  browser.frame()
  assert.equal(browser.call.interrupt(), true)
  settle(browser)
  assert.equal(browser.ui.levels.at(-1), 0)
  assert.equal(browser.frames.size, 0)
})

test('the page asks the device whether it wants less motion', async () => {
  const motion = async (media) => {
    const brand = brandAnswer({ voice: VOICE_ON })
    const loaded = loadPage({
      fetch: async (url) => ({ ok: true, status: 200, json: async () => (url.startsWith('/api/brand') ? brand : url.startsWith('/api/state') ? basePayload() : {}) }),
      expose: ['voiceDeps'],
      media
    })
    await flush()
    return loaded.exposed.voiceDeps().reducedMotion()
  }
  assert.equal(await motion({ '(prefers-reduced-motion: reduce)': true }), true)
  assert.equal(await motion({}), false)
})

test('only the no-preference motion rule reads the level, and the speaking orb keeps its fill without it', () => {
  const rules = cssRules()
  const reading = rules.filter((rule) => /var\(--voice-level/.test(rule.body))
  assert.ok(reading.length >= 1, 'nothing in the stylesheet reads the level')
  for (const rule of reading) {
    assert.match(rule.condition ?? '', /prefers-reduced-motion: no-preference/, `${rule.selector} moves for someone who asked for less motion`)
    assert.match(rule.selector, /data-state="speaking"/, `${rule.selector} glows when nothing is being said`)
  }
  assert.ok(rules.some((rule) => !rule.inMedia && rule.selector === '.voice-orb[data-state="speaking"]' && /background/.test(rule.body)))
})
