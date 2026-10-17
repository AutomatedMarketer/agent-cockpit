// Jobs on this computer (task T8): the team's own mailbox runner inside the board's process, kicked on each order.
//
// The end-to-end test runs the whole path in ONE process with nothing faked but Claude: the starter (runStart), the
// sign-in wall, the real /api/fire in mailbox mode, the real picture folder, the real /api/mailbox answered in-process,
// the real runner from the template checkout next to this repo (its allowlist, claims, walls round Claude, commit and
// lease push), git against a bare "GitHub" folder, and the real /api/state reading the status file back through git.
// Claude is a stand-in that writes what the prompt asks for, like the runner's own tests do: no real Claude is ever
// started and no network is used.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { FAKE_CLAUDE, GH, NO_RUNNER, RUNNER_CODE, fakeClaude, makeWorld, plantRunnerProof, settled, withStartedBoard } from './helpers/local-runner-world.mjs'

const STATUS = '.agent-team/status/mailbox/this-computer.json'

test('end to end, one process: an order queued by /api/fire reaches a fake Claude, and its status shows on /api/state', { skip: NO_RUNNER, timeout: 120_000 }, async () => {
  const world = makeWorld()
  const claude = fakeClaude()
  try {
    await plantRunnerProof(world.runnerState)
    await withStartedBoard(world, { places: { workDir: world.work, codeDir: RUNNER_CODE }, overrides: claude.overrides, extraGitConfig: [`url.${world.bare}.insteadOf=${GH}`] }, async ({ started, api, lines }) => {
      assert.ok(started.jobs, `jobs did not come on: ${lines.join(' | ')}`)
      await settled(started) // the first tick, at start

      const fired = await api('/api/fire', 'POST', { action: 'run', workflow: 'morning-intel' })
      assert.equal(fired.status, 200, fired.text)
      const order = JSON.parse(fired.text)
      assert.equal(order.ok, true)
      assert.match(order.orderId, /^[0-9a-f]{32}$/)

      // The order was kicked to the runner, which started Claude once - the stand-in, with the runner's walls.
      assert.ok(await settled(started, () => claude.calls.length > 0), 'Claude was never started')
      await settled(started)
      assert.equal(claude.calls.length, 1)
      const call = claude.calls[0]
      assert.equal(call.file, FAKE_CLAUDE)
      assert.equal(realpathSync(call.options.cwd), realpathSync(world.work), 'Claude works in the runner\'s own copy, never the team folder')
      for (const wall of ['--restricted', '--strict-mcp-config', '--disable-slash-commands', '--setting-sources']) assert.ok(call.args.includes(wall), wall)
      assert.equal(call.args[call.args.indexOf('--disallowedTools') + 1], 'mcp__*', 'no connectors in an ordered run')
      assert.ok(!call.args[call.args.indexOf('--tools') + 1].split(',').includes('Bash'), 'no shell')
      for (const name of Object.keys(call.options.env)) assert.ok(!/KEY|SECRET|TOKEN|MAILBOX|VIEW|FIRE/i.test(name), `Claude was handed ${name}`)

      // The runner pushed the work and the status file to "GitHub".
      const pushed = JSON.parse(world.inOrigin(STATUS))
      const entry = pushed.orders.find((one) => one.id === order.orderId)
      assert.equal(entry?.state, 'ok', JSON.stringify(pushed))

      // And the board shows it, read back through git, at once.
      const state = await api('/api/state')
      assert.equal(state.status, 200, state.text.slice(0, 300))
      const board = JSON.parse(state.text)
      const computers = board.mailbox?.computers ?? []
      const mine = computers.find((computer) => computer.runner === 'this-computer')
      assert.ok(mine, `no mailbox status on the board: ${JSON.stringify(board.mailbox)}`)
      const shown = mine.orders.find((one) => one.id === order.orderId)
      assert.equal(shown?.state, 'ok')
      assert.match(shown.commit, /^[0-9a-f]{12}$/)

      // The mailbox secrets were made by the board itself, and appear nowhere a person or a page can see.
      const secrets = readFileSync(join(world.runnerState, 'runner.env'), 'utf8').match(/=([0-9a-f]{64})$/gm).map((text) => text.slice(1))
      assert.equal(secrets.length, 2)
      for (const secret of secrets) {
        assert.ok(!state.text.includes(secret) && !fired.text.includes(secret), 'a mailbox secret reached the page')
        assert.ok(lines.every((text) => !text.includes(secret)), 'a mailbox secret reached the window')
        assert.ok(!JSON.stringify(call).includes(secret), 'a mailbox secret reached Claude')
      }
    })
  } finally {
    world.done()
  }
})
