// The board's one dependency. It had none until the picture store, and Nuno's rule is that a
// dependency is asked for, not slipped in - so these tests pin the exact terms it was approved
// on: one package, one exact version, locked, and loaded by one file only when a store exists.
//
// Why 2.8.0 and not "^2.8.0": 2.8.1 was published the same morning this was built. A caret
// would take it - or any later release - on the next install with nobody reading it first. The
// lockfile is what makes the pin real: without it the install resolves the package's OWN
// dependencies fresh every time, which is where most supply-chain surprises actually arrive.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, sep } from 'node:path'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const readJson = (name) => JSON.parse(readFileSync(join(ROOT, name), 'utf8'))
const SDK = '@vercel/blob'
const VERSION = '2.8.0'
const WRAPPER = 'api/_picture-store.js'

test('the board has exactly one dependency, the picture store SDK, pinned to an exact version', () => {
  const pkg = readJson('package.json')
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [SDK],
    'the README promises one dependency; anything else here needs Nuno to say yes first')
  assert.equal(pkg.dependencies[SDK], VERSION,
    'a range (^, ~, *) would install whatever is newest the next time anybody runs npm install')
  assert.equal(pkg.devDependencies, undefined, 'the tests run on node:test alone')
})

test('the lockfile exists and holds the same exact version', () => {
  assert.ok(existsSync(join(ROOT, 'package-lock.json')),
    'without package-lock.json the SDK\'s own dependencies are re-resolved on every install')
  const lock = readJson('package-lock.json')
  assert.equal(lock.packages?.['']?.dependencies?.[SDK], VERSION)
  const locked = lock.packages?.[`node_modules/${SDK}`]
  assert.equal(locked?.version, VERSION)
  assert.match(locked?.integrity ?? '', /^sha512-/, 'a locked package with no integrity hash is not locked')
})

test('installed packages never reach git', () => {
  const ignored = readFileSync(join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/).map((line) => line.trim())
  assert.ok(ignored.includes('node_modules/') || ignored.includes('node_modules'),
    '.gitignore must keep node_modules/ out of the repo')
})

// Every source file the deployment ships or runs: the functions, the page, the scripts.
function sourceFiles(dir) {
  const found = []
  for (const name of readdirSync(join(ROOT, dir))) {
    const path = join(dir, name)
    if (statSync(join(ROOT, path)).isDirectory()) found.push(...sourceFiles(path))
    else if (/\.(?:m?js|html)$/.test(name)) found.push(path.split(sep).join('/'))
  }
  return found
}

test('only the picture-store wrapper mentions the SDK, and only as a lazy import()', () => {
  // A static import anywhere would load the SDK on every request to that function, picture
  // store or not - and a second file reaching for it would mean two places that must both get
  // "private store only" right. One file, loaded on demand, keeps the dependency a guest.
  const mentions = sourceFiles('api')
    .concat(sourceFiles('public'), sourceFiles('scripts'))
    .filter((path) => readFileSync(join(ROOT, path), 'utf8').includes(SDK))
  for (const path of mentions) {
    assert.equal(path, WRAPPER, `${path} mentions ${SDK}; only ${WRAPPER} may`)
  }
  if (!mentions.length) return
  const source = readFileSync(join(ROOT, WRAPPER), 'utf8')
  assert.doesNotMatch(source, /\bfrom\s*['"]@vercel\/blob['"]/, 'a static import loads the SDK on every request')
  assert.doesNotMatch(source, /^\s*import\s*['"]@vercel\/blob['"]/m, 'a bare static import still loads it')
  assert.doesNotMatch(source, /\brequire\s*\(\s*['"]@vercel\/blob['"]/, 'require() is a static load too')
  assert.match(source, /\bimport\(\s*['"]@vercel\/blob['"]\s*\)/, 'the wrapper must load the SDK with import()')
})
