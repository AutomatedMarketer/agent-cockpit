// The one place a voice price lives (Phase 10, the spend meter). Starts with "_" so Vercel does not
// turn it into an endpoint.
//
// The meter is an ESTIMATE: OpenAI's own token counts for each reply, times these rates. The bill is
// at platform.openai.com. Every rate below was read off the vendor's own page on the date beside it,
// and a rate nobody has found a source for is null - which makes a total "incomplete", never $0
// (costOf in api/_voice.js). tests/voice-prices.test.mjs refuses a price written anywhere else,
// including the page: the page gets this table from GET /api/voice-meter.
//
// Units: US dollars per million tokens for OpenAI, per million UTF-8 bytes of text for Fish.

export const PRICES_CHECKED = '2026-10-09'

const OPENAI_PRICING = 'https://developers.openai.com/api/docs/pricing'

export const VOICE_PRICES = {
  // "Realtime and audio generation models", one Text row and one Audio row per model, each with
  // input, cached input and output.
  realtime: {
    'gpt-realtime-2.1-mini': {
      textIn: 0.6,
      cachedTextIn: 0.06,
      audioIn: 10,
      cachedAudioIn: 0.3,
      textOut: 2.4,
      audioOut: 20,
      source: OPENAI_PRICING,
      checked: '2026-10-09'
    },
    'gpt-realtime-2.1': {
      textIn: 4,
      cachedTextIn: 0.4,
      audioIn: 32,
      cachedAudioIn: 0.4,
      textOut: 24,
      audioOut: 64,
      source: OPENAI_PRICING,
      checked: '2026-10-09'
    }
  },
  // Captions: a separate model with its own rate card (realtime-costs: "billed from a different rate
  // card"). The model's page lists audio tokens only, so text in - a prompt, which the board never
  // sends - has no rate.
  transcription: {
    'gpt-4o-mini-transcribe': {
      textIn: null,
      audioIn: 1.25,
      textOut: 5,
      source: 'https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe',
      checked: '2026-10-09'
    }
  },
  fish: {
    's2.1-pro-free': {
      perMillionBytes: 0,
      source: 'https://fish.audio/blog/s2-1-pro-free-api/',
      checked: '2026-10-09',
      note: 'Free through 2026-11-30 under fair use; requests may be used to train Fish\'s model.'
    },
    's2.1-pro': {
      perMillionBytes: 15,
      source: 'https://openrouter.ai/fish-audio/s2.1-pro',
      checked: '2026-10-09',
      note: 'Fish\'s own price page (docs.fish.audio, pricing and rate limits) lists s2-pro and s1 at this rate and does not yet name s2.1-pro.'
    }
  }
}
