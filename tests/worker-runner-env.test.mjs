// The local board's runner and the Codex worker (T14): a Codex job is refused (codex-key-in-environment)
// whenever an OpenAI key or address is in the runner's environment. The board holds one - the voice's
// OPENAI_API_KEY - so the runner's environment is an allow-list, and this holds it to that for every name
// the runner's own check looks for.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runnerEnvironment } from '../local/runner.mjs'
import { RUNNER_CODE } from './helpers/local-runner-world.mjs'

const KEYS = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_ACCESS_TOKEN', 'OPENAI_ORG_ID', 'OPENAI_PROJECT', 'OPENAI_API_BASE']
const board = (extra = {}) => ({ PATH: '/usr/bin', HOME: '/home/student', TEMP: '/tmp', VOICE_PROVIDER: 'openai', ...Object.fromEntries(KEYS.map((name) => [name, `fake-${name.toLowerCase()}-value`])), ...extra })

test('no OpenAI key or address of the board\'s reaches the runner, in any case of letters, on any platform', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const env = runnerEnvironment(board({ openai_api_key: 'lower', Codex_Api_Key: 'mixed' }), platform)
    for (const name of Object.keys(env)) assert.ok(!/openai|codex/i.test(name), `${name} reached the runner on ${platform}`)
    assert.ok(!JSON.stringify(env).includes('fake-'), `a key's value reached the runner on ${platform}`)
    assert.equal(env.PATH, '/usr/bin', 'what the runner needs was lost')
  }
})

test('the runner\'s own Codex check finds nothing wrong in the environment it is given from a board that has the voice key', async (t) => {
  const file = join(RUNNER_CODE, 'scripts', 'lib', 'mailbox', 'codex.mjs')
  if (!existsSync(file)) return t.skip(`the Codex runner code is not at ${RUNNER_CODE}; set AGENT_TEAM_TEMPLATE`)
  const { unsafeCodexEnv } = await import(pathToFileURL(file).href)
  assert.deepEqual(unsafeCodexEnv(board()), ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_ACCESS_TOKEN'], 'the board\'s own environment would stop every Codex job')
  assert.deepEqual(unsafeCodexEnv(runnerEnvironment(board(), 'darwin')), [])
  assert.deepEqual(unsafeCodexEnv(runnerEnvironment(board(), 'win32')), [])
})
