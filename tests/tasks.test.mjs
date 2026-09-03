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
    for: 'research',
    doneAt: null
  })
})

/* ---------- done_at, and the seven days it measures ------------------------------------------

   A card said WHETHER it was finished and never WHEN, so "finished tasks for seven days" had
   nothing to count from. The filename's date is the day the card was WRITTEN: a card raised in
   March and finished in June would have read as three months stale the moment it was done. */

test('parseTasks reads done_at, and leaves it null when the card does not carry one', () => {
  const [dated] = parseTasks([
    taskFile('tasks/2026-03-01-old-ask.md', 'status: done\ndone_at: 2026-08-19', '# Old ask')
  ])
  assert.equal(dated.doneAt, '2026-08-19')

  const [undated] = parseTasks([taskFile('tasks/2026-03-01-old-ask.md', 'status: done', '# Old ask')])
  assert.equal(undated.doneAt, null, 'an undated done card must not be given a date it never had')
})

test('a date that is not a date is refused rather than carried through', () => {
  const [task] = parseTasks([
    taskFile('tasks/a.md', 'status: done\ndone_at: last Tuesday', '# A')
  ])
  assert.equal(task.doneAt, null, 'the board accepted "last Tuesday" as a date')
})

test('done tasks reach the Done column for seven days, and undated ones never do', () => {
  const tasks = parseTasks([
    taskFile('tasks/a.md', `status: done\ndone_at: ${iso(-2 * DAY).slice(0, 10)}`, '# Two days ago'),
    taskFile('tasks/b.md', `status: done\ndone_at: ${iso(-30 * DAY).slice(0, 10)}`, '# Thirty days ago'),
    taskFile('tasks/c.md', 'status: done', '# Undated'),
    taskFile('tasks/d.md', 'status: todo', '# Still to do')
  ])
  const board = shapeBoard([], [], tasks, NOW)

  const titles = board.done.map((card) => card.title ?? card.name)
  assert.ok(titles.includes('Two days ago'), 'a task finished two days ago is not in Done')
  assert.ok(!titles.includes('Thirty days ago'), 'a task finished a month ago is still in Done')
  assert.ok(!titles.includes('Undated'), 'an undated done task was placed in the seven days')
  assert.ok(!titles.includes('Still to do'), 'an open task was placed in Done')

  // Every finished task, dated or not, is reachable - that is what the link under the column
  // shows. Hidden after seven days is not the same as gone.
  const finished = board.finishedTasks.map((card) => card.title)
  assert.deepEqual(finished.sort(), ['Thirty days ago', 'Two days ago', 'Undated'])
})

test('a done task in the column is marked as a task, so it is not read as a run', () => {
  const tasks = parseTasks([taskFile('tasks/a.md', `status: done\ndone_at: ${iso(-DAY).slice(0, 10)}`, '# Chase Acme')])
  const [card] = shapeBoard([], [], tasks, NOW).done
  assert.equal(card.kind, 'task', 'a finished task is indistinguishable from a finished run')
  assert.equal(card.title, 'Chase Acme')
})

test('an open task still carries its slug and status, which the buttons act on', () => {
  const tasks = parseTasks([taskFile('tasks/2026-08-18-a.md', 'status: doing\nfor: sales', '# A')])
  const [card] = shapeBoard([], [], tasks, NOW).todo
  assert.equal(card.slug, '2026-08-18-a')
  assert.equal(card.doing, true)
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

// --- the Add-task form's text split (mirrored in public/index.html) -----------------------
import { splitTaskText } from '../api/lib.js'

test('splitTaskText: one short line is a title with no details', () => {
  assert.deepEqual(splitTaskText('  Research podcast sponsors  '), { title: 'Research podcast sponsors' })
  assert.equal(splitTaskText(''), null)
  assert.equal(splitTaskText('   \n  '), null)
  assert.equal(splitTaskText(undefined), null)
})

test('splitTaskText: extra lines become details, with the full text preserved', () => {
  const split = splitTaskText('Chase the invoice\nJuly is still unpaid.\nBe polite.')
  assert.equal(split.title, 'Chase the invoice')
  assert.equal(split.details, 'Chase the invoice\nJuly is still unpaid.\nBe polite.')
})

test('splitTaskText: a first line over 200 chars is clipped for the title, kept in details', () => {
  const long = 'w'.repeat(250)
  const split = splitTaskText(long)
  assert.equal(split.title.length, 200)
  assert.equal(split.details, long)
})
