// The To do column — parseTasks and shapeBoard's task handling, tested without a network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTasks, shapeBoard } from '../api/state.js'

const NOW = Date.parse('2026-08-20T12:00:00Z')
const DAY = 86400_000
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString()

const taskFile = (path, frontmatter, body = '') =>
  [path, frontmatter ? `---\n${frontmatter}\n---\n\n${body}` : body]

test('parseTasks reads status, for, and the first heading as the title', () => {
  const [task] = parseTasks([
    taskFile('tasks/2026-08-18-write-brief.md', 'status: doing\nfor: research', '# Write the Monday brief\n\nNotes.')
  ])
  assert.deepEqual(task, {
    slug: '2026-08-18-write-brief',
    path: 'tasks/2026-08-18-write-brief.md',
    title: 'Write the Monday brief',
    status: 'doing',
    for: 'research'
  })
})

test('a task with no frontmatter is tolerated: status todo, filename as title', () => {
  const [task] = parseTasks([taskFile('tasks/fix-the-deploy.md', null, 'just a note, no heading')])
  assert.equal(task.status, 'todo')
  assert.equal(task.title, 'fix-the-deploy')
  assert.equal(task.for, null)
})

test('an unknown status reads as todo, never as done', () => {
  const [task] = parseTasks([taskFile('tasks/odd.md', 'status: someday', '# Odd one')])
  assert.equal(task.status, 'todo')
})

test('a heading inside the frontmatter block is not a title', () => {
  const [task] = parseTasks([['tasks/tricky.md', '---\nstatus: todo\n# a comment, not a title\n---\nno heading here']])
  assert.equal(task.title, 'tricky')
})

test('the todo column holds todo and doing tasks, oldest first, with doing flagged', () => {
  const tasks = parseTasks([
    taskFile('tasks/2026-08-19-second.md', 'status: todo', '# Second'),
    taskFile('tasks/2026-08-20-shipped.md', 'status: done', '# Already shipped'),
    taskFile('tasks/2026-08-17-first.md', 'status: doing\nfor: email', '# First')
  ])
  const { todo } = shapeBoard([], [], tasks, NOW)
  assert.deepEqual(todo, [
    { slug: '2026-08-17-first', title: 'First', for: 'email', doing: true },
    { slug: '2026-08-19-second', title: 'Second', for: null, doing: false }
  ])
})

test('a done task adds no Done card of its own — its run log is the record', () => {
  const tasks = parseTasks([
    taskFile('tasks/2026-08-20-brief.md', 'status: done\nfor: research', '# Monday brief'),
    taskFile('tasks/2026-08-20-orphan.md', 'status: done', '# Done with no run log')
  ])
  const runs = [
    { agent: 'research', workflow: 'monday-brief', status: 'ok', started_at: iso(-DAY), summary: 'Brief written.' }
  ]
  const { todo, done } = shapeBoard([], runs, tasks, NOW)
  assert.deepEqual(todo, [], 'done tasks never sit in the todo column')
  assert.deepEqual(done.map((card) => card.name), ['monday-brief'], 'only the run log cards Done — no double-carding')
})
