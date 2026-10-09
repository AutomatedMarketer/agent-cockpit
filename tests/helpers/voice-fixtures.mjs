// What the voice tests share: fake keys put together at runtime (so nothing that looks like a real
// key sits in the source), a fake SDP offer, a tiny MP3, and usage shaped the way OpenAI documents
// it (developers.openai.com/api/docs/guides/realtime-costs, read 2026-10-09).

export const OPENAI_KEY = ['sk', 'test', 'voiceKeyThatStaysOnTheServer'].join('-')
export const FISH_KEY = ['fish', 'test', 'keyThatStaysOnTheServer'].join('_')
export const FISH_VOICE = 'a'.repeat(16) + '0123456789abcdef'

// An offer as a browser writes one: v=0 first, CRLF line ends.
export const SDP_OFFER = [
  'v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0 1',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 0.0.0.0', 'a=mid:0', 'a=sendrecv', 'a=rtpmap:111 opus/48000/2',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0', 'a=mid:1', 'a=sctp-port:5000', ''
].join('\r\n')
export const SDP_ANSWER = SDP_OFFER.replace('a=sendrecv', 'a=sendrecv\r\na=ice-lite')

// Two MPEG-1 Layer III frame headers (128 kbps, 44.1 kHz), padded: the shape of an MP3 with no tag.
export const twoFrameMp3 = () => {
  const frame = Buffer.alloc(417)
  frame.set([0xff, 0xfb, 0x90, 0x64])
  return Buffer.concat([frame, frame])
}

// response.done -> response.usage, word for word the documented example.
export const REPLY_USAGE = {
  total_tokens: 253,
  input_tokens: 132,
  output_tokens: 121,
  input_token_details: {
    text_tokens: 119,
    audio_tokens: 13,
    image_tokens: 0,
    cached_tokens: 64,
    cached_tokens_details: { text_tokens: 64, audio_tokens: 0, image_tokens: 0 }
  },
  output_token_details: { text_tokens: 30, audio_tokens: 91 }
}

// conversation.item.input_audio_transcription.completed -> usage, the documented example.
export const TRANSCRIPTION_USAGE = {
  type: 'tokens',
  total_tokens: 26,
  input_tokens: 17,
  input_token_details: { text_tokens: 0, audio_tokens: 17 },
  output_tokens: 9
}
