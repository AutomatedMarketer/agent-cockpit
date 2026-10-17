// The page's own voice code, run with a stand-in for the local adapter: the rules that keep the board from
// hearing itself (speakers mode: the microphone rests while a reply plays and 300 ms after, phones unchanged,
// "I'm on headphones") are the cloud voice's, and they must apply to a local call the same way.

import test from 'node:test'
import assert from 'node:assert/strict'
import { loadPage, flush } from './helpers/page-harness.mjs'
import { basePayload, brandAnswer, VOICE_ON } from './helpers/page-payload.mjs'
import { fakeBrowser, ticketFor } from './helpers/voice-browser.mjs'

// The page with the local engine switched on, and an adapter that is only a channel the test drives.
async function localCall(options = {}) {
  const channel = { readyState: 'open', sent: [], closed: false, send(text) { this.sent.push(JSON.parse(text)) }, close() { this.closed = true } }
  const seen = { opened: null }
  const given = {}
  const loaded = loadPage({
    windowExtras: {
      __BOARD_LOCAL_VOICE__: {
        engine: 'local',
        open: async (ctx) => {
          seen.opened = ctx
          return { answer: { ticket: ticketFor('fish'), mouth: 'fish', name: 'Jarvis', idleMinutes: 2, captions: true, echoGuard: false, orders: { on: false } }, channel, start: () => channel.onopen?.() }
        }
      }
    },
    fetch: async (url) => ({ ok: true, status: 200, json: async () => (url.startsWith('/api/brand') ? brandAnswer({ voice: { on: false } }) : url.startsWith('/api/state') ? basePayload() : {}) }),
    expose: ['openVoice', 'fishMouth', 'voiceDeps'],
    after: 'given.current = () => voiceSession',
    given
  })
  await flush()
  const browser = fakeBrowser({ finePointer: true, ...options })
  browser.deps.fish = loaded.exposed.fishMouth({ speak: browser.speak, now: () => browser.clock.now })
  const call = loaded.exposed.openVoice(browser.deps, browser.ui)
  await flush()
  return { ...browser, call, channel, seen, emit: (event) => channel.onmessage({ data: JSON.stringify(event) }), loaded }
}
// true for a microphone track the page switched off (a track nobody touched has no `enabled` set at all)
const resting = (browser) => browser.tracks.map((track) => track.enabled === false)
const say = async (browser, words = 'Three jobs are due today.') => {
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'response.output_text.delta', delta: words })
  browser.emit({ type: 'response.output_text.done', text: words })
  browser.emit({ type: 'response.done', response: { output: [{ type: 'message' }], usage: {} } })
  browser.speeches[0].answer()
  await flush()
}
const endTail = (browser) => {
  const [id, timer] = [...browser.timers.entries()].find(([, one]) => one.ms === 300) ?? assert.fail('nothing waits out the tail')
  browser.timers.delete(id)
  timer.fn()
}

test('page: a local call is made with no OpenAI connection, the engine is Local, and the call costs nothing and keeps no cloud record', async () => {
  const browser = await localCall()
  assert.ok(browser.seen.opened, 'the local adapter was never asked')
  assert.equal(browser.state.pc, null, 'a connection to OpenAI was made')
  assert.equal(typeof browser.seen.opened.resting, 'function', 'the adapter was not told when the microphone rests')
  assert.equal(browser.seen.opened.name, 'your assistant')
  assert.match(browser.ui.costs.at(-1), /runs on this computer: no cost/)
  await say(browser)
  assert.deepEqual(browser.state.saved, [], 'a local conversation was filed in the cloud meter')
})

test('page: on a computer\'s speakers the microphone rests from the reply\'s first sound until 300 ms after its last', async () => {
  const browser = await localCall()
  assert.deepEqual(resting(browser), [false])
  assert.equal(browser.seen.opened.resting(), false)
  await say(browser)
  assert.deepEqual(resting(browser), [true], 'the reply went into the microphone')
  assert.equal(browser.seen.opened.resting(), true, 'the adapter was not told the microphone rests')
  browser.state.context.started[0].onended()
  assert.deepEqual(resting(browser), [true], 'the last of the reply could still echo')
  endTail(browser)
  assert.deepEqual(resting(browser), [false])
  assert.equal(browser.seen.opened.resting(), false)
})

test('page: on headphones the microphone does not rest, and the toggle changes it mid-call', async () => {
  const browser = await localCall({ headphones: true })
  await say(browser)
  assert.deepEqual(resting(browser), [false], 'the microphone rested on headphones')
  const speakers = await localCall()
  speakers.call.setSpeakersMode(false)
  await say(speakers)
  assert.deepEqual(resting(speakers), [false], 'switching to headphones mid-call did not take')
})

test('page: a phone (no mouse) keeps its microphone open, as before - its echo cancelling is built for it', async () => {
  const browser = await localCall({ finePointer: false })
  await say(browser)
  assert.deepEqual(resting(browser), [false])
  assert.equal(browser.seen.opened.resting(), false)
})

test('page: talking over a reply in speakers mode is the orb, and it stops the pieces and wakes the microphone', async () => {
  const browser = await localCall()
  browser.emit({ type: 'response.created' })
  browser.emit({ type: 'response.output_text.delta', delta: 'Three jobs are due today, and one has gone quiet. ' })
  browser.speeches[0].answer()
  await flush()
  assert.equal(browser.call.interrupt(), true)
  assert.equal(browser.state.context.started[0].stopped, true)
  assert.deepEqual(resting(browser), [false])
  assert.ok(browser.channel.sent.some((event) => event.type === 'response.cancel'), 'the adapter was not told to stop thinking')
})
