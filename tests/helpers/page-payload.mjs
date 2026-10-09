// The smallest /api/state answer every screen draws from: an empty repo, word for word the base
// payload render.test.mjs uses, so the voice tests boot the same board.
export const basePayload = () => ({
  repo: { owner: 'o', repo: 'r', branch: 'main', url: 'https://github.com/o/r' },
  agents: [],
  runs: [],
  totalRuns: 0,
  unparseableRuns: [],
  overnight: [],
  goneQuiet: [],
  board: { todo: [], upNext: [], running: [], done: [] },
  brain: [],
  workflows: [],
  runtimes: [],
  skills: [],
  stack: null,
  memory: { files: [], indexes: [], truncated: false },
  ledger: null,
  proposals: null,
  hero: null,
  owner: null,
  activity: { since: new Date(Date.now() - 15 * 86400_000).toISOString(), runs: [], complete: true },
  routines: { takenAt: null, usable: false, stale: false, why: 'No snapshot has been taken yet.', count: 0, known: false, orphans: [], problems: [] },
  setup: [],
  generatedAt: new Date().toISOString()
})

// What /api/brand answers, with personalising off or on, and voice as given.
export const brandAnswer = ({ enabled = false, voice, assistantName = '' } = {}) => ({
  enabled,
  canGenerate: false,
  why: enabled ? 'Making pictures from words is off.' : 'No picture store is connected.',
  assistantName,
  artStyle: '',
  defaultArtStyle: 'Painterly.',
  names: {},
  pictures: {},
  left: { writes: 20, generated: 10 },
  ...(voice === undefined ? {} : { voice })
})

export const VOICE_ON = { on: true, mouth: 'openai' }
