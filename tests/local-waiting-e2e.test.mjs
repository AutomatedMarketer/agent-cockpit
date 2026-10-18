// Through a started board with the runner on: the id /api/fire queues is the id /api/progress then knows (the two share one list),
// "waiting" is never handed to someone who is not signed in, and an id the board never queued is still 404.
import test from 'node:test'
import assert from 'node:assert/strict'
import { GH, HAS_RUNNER, NO_RUNNER, RUNNER_CODE, fakeClaude, makeWorld, plantRunnerProof, raw, settled, withStartedBoard } from './helpers/local-runner-world.mjs'

test('through the board: an order it queued is known to /api/progress (waiting or a file), signed-out is refused, another id is 404', { timeout: 120_000, skip: HAS_RUNNER ? false : NO_RUNNER }, async () => {
  const world = makeWorld()
  const claude = fakeClaude()
  try {
    await plantRunnerProof(world.runnerState)
    await withStartedBoard(world, { places: { workDir: world.work, codeDir: RUNNER_CODE }, overrides: claude.overrides, extraGitConfig: [`url.${world.bare}.insteadOf=${GH}`] }, false, async ({ started, api }) => {
      await settled(started)
      const port = started.port
      const fired = await api('/api/fire', 'POST', { action: 'run', workflow: 'morning-intel' })
      assert.equal(fired.status, 200, fired.text)
      const id = JSON.parse(fired.text).orderId
      assert.match(id, /^[0-9a-f]{32}$/)
      const known = await api(`/api/progress?order=${id}`)
      assert.equal(known.status, 200, 'an order the board queued is not a 404')
      const body = JSON.parse(known.text)
      assert.ok(body.state === 'waiting' || typeof body.phase === 'string', known.text)
      const signedOut = await raw(port, `/api/progress?order=${id}`, 'GET', { Origin: `http://127.0.0.1:${port}` })
      assert.equal(signedOut.status, 401)
      assert.equal(signedOut.text.includes('waiting'), false)
      assert.equal((await api(`/api/progress?order=${'b'.repeat(32)}`)).status, 404)
      await settled(started)
    })
  } finally { world.done() }
})
