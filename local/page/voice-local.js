// Voice that runs on this computer, in the board's page (task T16). Added after app.js by the local
// server only. app.js calls window.__BOARD_LOCAL_VOICE__.open(...) instead of making a call to OpenAI
// when the Voice engine in Settings is Local; this is what answers.
//
// It stands in for OpenAI's connection: it listens to the microphone, finds where the person's turn
// starts and ends (the quiet after it), sends that sound to the board (which has it turned into words
// by a program on this computer), asks the board for the language model's answer, and hands back the
// very events a realtime call would - so the page's own voice code does the rest: it runs the model's
// tool calls on the page, shows the yes cards, and speaks the reply a clause at a time.
//
// Plain old-style script. Nothing here is a secret: the board's key is added to /api calls by
// local-mode.js, and this holds no key of its own.
(function () {
  var state = window.__BOARD_LOCAL_VOICE__ = window.__BOARD_LOCAL_VOICE__ || { engine: 'cloud' }

  var ADDRESS = { start: '/api/local-voice/start', hear: '/api/local-voice/hear', think: '/api/local-voice/think' }
  var TARGET_RATE = 16000
  var START_LEVEL = 0.02 // how loud counts as the start of talking
  var END_LEVEL = 0.012 // and how quiet counts as quiet
  var START_FRAMES = 3 // loud frames in a row before it is a turn
  var QUIET_MS = 900 // quiet this long ends the turn
  var PREROLL_MS = 400 // kept from before the start, so the first word is whole
  var LONGEST_TURN_MS = 30000
  var SHORTEST_TURN_MS = 300
  var KEPT_MESSAGES = 30
  var NOTHING_SAID = 'I did not get an answer to that. Please ask again.'

  function said(words) {
    var error = new Error(words)
    error.said = true
    return error
  }

  // JSON in, JSON out. Never throws for an answer the board gave: { ok, status, json }.
  function post(address, body, signal) {
    return fetch(address, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: signal })
      .then(function (response) { return response.json().catch(function () { return {} }).then(function (json) { return { ok: response.ok, status: response.status, json: json } }) })
  }

  function wavOf(samples, rate) {
    // Average down to 16 kHz, then 16-bit little-endian PCM in a WAV wrapper.
    var step = rate / TARGET_RATE
    var count = Math.floor(samples.length / step)
    var buffer = new ArrayBuffer(44 + count * 2)
    var view = new DataView(buffer)
    function text(at, value) { for (var i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)) }
    text(0, 'RIFF'); view.setUint32(4, 36 + count * 2, true); text(8, 'WAVE'); text(12, 'fmt ')
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
    view.setUint32(24, TARGET_RATE, true); view.setUint32(28, TARGET_RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
    text(36, 'data'); view.setUint32(40, count * 2, true)
    for (var n = 0; n < count; n++) {
      var from = Math.floor(n * step)
      var to = Math.min(samples.length, Math.floor((n + 1) * step))
      var sum = 0
      for (var k = from; k < to; k++) sum += samples[k]
      var value = to > from ? sum / (to - from) : 0
      value = Math.max(-1, Math.min(1, value))
      view.setInt16(44 + n * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true)
    }
    return buffer
  }

  state.open = function (ctx) {
    return post(ADDRESS.start, { name: ctx.name, names: ctx.names, timeZone: ctx.timeZone }).then(function (started) {
      if (!started.ok) throw said(started.json.error || 'Voice on this computer could not start.')
      var answer = started.json
      var ticket = answer.ticket
      var closed = false
      var history = [] // { id?, role, content, tool_calls?, tool_call_id? }
      var counter = 0
      var inflight = null // the AbortController of the request being waited on
      var responding = false
      var channel = { readyState: 'open', onmessage: null, onopen: null, onclose: null }

      function emit(event) {
        if (closed || !channel.onmessage) return
        channel.onmessage({ data: JSON.stringify(event) })
      }

      // ---- the conversation, as the board wants it ----
      function windowed() {
        var list = history.slice(-KEPT_MESSAGES)
        while (list.length && list[0].role !== 'user') list.shift() // never start on a tool result or a half of a pair
        return list.map(function (item) {
          var out = { role: item.role, content: item.content || '' }
          if (item.tool_call_id) out.tool_call_id = item.tool_call_id
          if (item.tool_calls) out.tool_calls = item.tool_calls
          return out
        })
      }

      // A part is down (or said no): one plain line, and the call goes back to listening.
      function failed(words) {
        responding = false
        if (ctx.note) ctx.note(words || 'Voice on this computer is not working. You can switch the Voice engine to Cloud in Settings.')
        emit({ type: 'response.done', response: { status: 'failed', output: [{ type: 'message', role: 'assistant', content: [] }], usage: {} } })
      }

      function runBrain() {
        if (closed) return
        var controller = new AbortController()
        inflight = controller
        responding = true
        var id = 'resp_' + (++counter)
        emit({ type: 'response.created', response: { id: id } })
        post(ADDRESS.think, { ticket: ticket, messages: windowed() }, controller.signal).then(function (result) {
          if (controller.signal.aborted || closed) return
          inflight = null
          if (!result.ok) { failed(result.json.error); return }
          var out = result.json
          var calls = Array.isArray(out.calls) ? out.calls : []
          var output
          if (calls.length) {
            history.push({ role: 'assistant', content: '', tool_calls: calls.map(function (one) { return { id: one.call_id, name: one.name, arguments: one.arguments } }) })
            output = calls.map(function (one) { return { type: 'function_call', call_id: one.call_id, name: one.name, arguments: one.arguments } })
          } else {
            var text = out.text || NOTHING_SAID
            history.push({ role: 'assistant', content: text })
            emit({ type: 'response.output_text.delta', delta: text })
            emit({ type: 'response.output_text.done', text: text })
            output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: text }] }]
          }
          responding = false
          emit({ type: 'response.done', response: { id: id, status: 'completed', output: output, usage: {} } })
        }).catch(function (error) {
          if (controller.signal.aborted || closed) return
          inflight = null
          failed('The board could not be reached, so nothing was heard. Check that it is still running.')
        })
      }

      // ---- what the person said ----
      function heard(wav, itemId) {
        var controller = new AbortController()
        inflight = controller
        fetch(ADDRESS.hear, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-voice-ticket': ticket }, body: wav, signal: controller.signal })
          .then(function (response) { return response.json().catch(function () { return {} }).then(function (json) { return { ok: response.ok, json: json } }) })
          .then(function (result) {
            if (controller.signal.aborted || closed) return
            inflight = null
            if (!result.ok) { failed(result.json.error); return }
            var words = typeof result.json.text === 'string' ? result.json.text.trim() : ''
            if (!words) { emit({ type: 'error', error: { code: 'unheard' } }); return }
            emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript: words })
            history.push({ id: itemId, role: 'user', content: words })
            runBrain()
          })
          .catch(function () {
            if (controller.signal.aborted || closed) return
            inflight = null
            failed('The board could not be reached, so nothing was heard. Check that it is still running.')
          })
      }

      // ---- listening: find the turn, cut it out ----
      var context = ctx.context
      var source = null
      var processor = null
      var sink = null
      var preroll = []
      var prerollSamples = 0
      var turn = null // { chunks, samples, loudSamples, quietSamples }
      var loudRun = 0

      function onChunk(samples, rate) {
        if (closed) return
        var sum = 0
        for (var i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
        var level = Math.sqrt(sum / samples.length)
        if (!turn) {
          preroll.push(samples)
          prerollSamples += samples.length
          while (prerollSamples - preroll[0].length > rate * PREROLL_MS / 1000) prerollSamples -= preroll.shift().length
          loudRun = level > START_LEVEL ? loudRun + 1 : 0
          if (loudRun >= START_FRAMES) {
            // The turn's id is made now, said with its start and used again for its words: the page files how a turn
            // began (was a reply playing, was the microphone resting) under this id, and a spoken yes is judged by it.
            turn = { id: 'item_' + (++counter), chunks: preroll.slice(), samples: prerollSamples, loudSamples: samples.length * START_FRAMES, quietSamples: 0 }
            preroll = []
            prerollSamples = 0
            loudRun = 0
            emit({ type: 'input_audio_buffer.speech_started', item_id: turn.id })
          }
          return
        }
        turn.chunks.push(samples)
        turn.samples += samples.length
        if (level > END_LEVEL) { turn.loudSamples += samples.length; turn.quietSamples = 0 } else turn.quietSamples += samples.length
        if (turn.quietSamples >= rate * QUIET_MS / 1000 || turn.samples >= rate * LONGEST_TURN_MS / 1000) endTurn(rate)
      }

      function endTurn(rate) {
        var finished = turn
        turn = null
        emit({ type: 'input_audio_buffer.speech_stopped' })
        if (finished.loudSamples < rate * SHORTEST_TURN_MS / 1000) { emit({ type: 'error', error: { code: 'unheard' } }); return }
        var all = new Float32Array(finished.samples)
        var at = 0
        finished.chunks.forEach(function (chunk) { all.set(chunk, at); at += chunk.length })
        heard(wavOf(all, rate), finished.id)
      }

      function start() {
        try {
          source = context.createMediaStreamSource(ctx.stream)
          processor = context.createScriptProcessor(2048, 1, 1)
          sink = context.createGain()
          sink.gain.value = 0 // the processor must be connected to run; nothing is played from it
          processor.onaudioprocess = function (event) { onChunk(new Float32Array(event.inputBuffer.getChannelData(0)), context.sampleRate) }
          source.connect(processor)
          processor.connect(sink)
          sink.connect(context.destination)
        } catch (error) {
          failed('This browser could not listen for voice on this computer.')
        }
        setTimeout(function () { if (!closed && channel.onopen) channel.onopen() }, 0)
      }

      // ---- what the page says to a realtime call ----
      channel.send = function (text) {
        var event
        try { event = JSON.parse(text) } catch (error) { return }
        if (closed || !event) return
        if (event.type === 'conversation.item.create' && event.item) {
          if (event.item.type === 'function_call_output') {
            history.push({ role: 'tool', tool_call_id: event.item.call_id, content: String(event.item.output || '').slice(0, 5000) })
          } else if (event.item.type === 'message' && event.item.role === 'system') {
            var part = event.item.content && event.item.content[0]
            if (part && typeof part.text === 'string') history.push({ role: 'system', content: part.text.slice(0, 1000) })
          }
        } else if (event.type === 'response.create') {
          runBrain()
        } else if (event.type === 'response.cancel') {
          if (inflight) { inflight.abort(); inflight = null }
          if (responding) {
            responding = false
            emit({ type: 'response.done', response: { status: 'cancelled', output: [], usage: {} } })
          }
        } else if (event.type === 'conversation.item.delete') {
          history = history.filter(function (item) { return item.id !== event.item_id })
        }
      }
      channel.close = function () {
        if (closed) return
        closed = true
        channel.readyState = 'closed'
        if (inflight) inflight.abort()
        try { if (processor) { processor.onaudioprocess = null; processor.disconnect() } } catch (error) { /* gone */ }
        try { if (source) source.disconnect() } catch (error) { /* gone */ }
        try { if (sink) sink.disconnect() } catch (error) { /* gone */ }
      }

      return { answer: answer, channel: channel, start: start }
    })
  }
})()
