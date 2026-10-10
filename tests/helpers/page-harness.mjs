// Runs the page's one inline script against a small stand-in DOM, for the voice tests. The same idea
// as the harness inside render.test.mjs, kept apart because the voice code needs a little more of a
// DOM: elements that remember their attributes, classes, children and listeners, a localStorage that
// keeps what is written, and a way to hand the page's own variables a value before a test runs.
//
// Nothing here acts: an attribute set is recorded, a listener added is kept for the test to call,
// and nothing fires on its own. A test reads what the page did and calls what it wants to happen.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

export const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8')
export const script = html.match(/<script>([\s\S]*)<\/script>/)[1]

function element(id = '', tag = 'div') {
  const classes = new Set()
  const node = {
    id,
    tagName: tag.toUpperCase(),
    innerHTML: '',
    textContent: '',
    hidden: false,
    disabled: false,
    dataset: {},
    // Custom properties set the way the page sets them (the orb's --voice-level), read back by name.
    style: { setProperty(name, value) { this[name] = String(value) } },
    attributes: {},
    children: [],
    listeners: {},
    removed: false,
    focused: 0,
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, on) => ((on ?? !classes.has(name)) ? classes.add(name) : classes.delete(name)),
      contains: (name) => classes.has(name)
    },
    setAttribute(name, value) { this.attributes[name] = String(value) },
    getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null },
    removeAttribute(name) { delete this.attributes[name] },
    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler) },
    appendChild(child) { this.children.push(child); return child },
    remove() { this.removed = true },
    focus() { this.focused += 1 },
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    insertAdjacentHTML() {},
    scrollIntoView() {}
  }
  return node
}

function memoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: (key) => { store.delete(key) }
  }
}

export const flush = async (times = 6) => {
  for (let turn = 0; turn < times; turn += 1) await new Promise((resolve) => setImmediate(resolve))
}

// `fetch(url, init)` answers the page's requests; left out, /api/state gets `payload` and everything
// else an empty object. `given` is handed to `after`, a line of code run inside the page's own scope
// once the script has loaded - the way a test sets a page variable the person would have set.
export function loadPage({ payload = {}, fetch, storage = {}, expose = [], after = '', given = {}, hash = '', media = {}, prompt } = {}) {
  for (const name of expose) assert.match(name, /^[A-Za-z_$][\w$]*$/, `${name} is not a name`)
  const nodes = new Map()
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, element(id))
    return nodes.get(id)
  }
  const documentListeners = []
  const windowListeners = []
  const created = []
  const document = {
    getElementById: (id) => node(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(type, handler, options) { documentListeners.push({ type, handler, options }) },
    createElement(tag) {
      const made = element('', tag)
      created.push(made)
      return made
    },
    body: node('body'),
    documentElement: node('html'),
    visibilityState: 'visible'
  }
  const requests = []
  const answer = fetch ?? (async (url) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).startsWith('/api/state') ? payload : {})
  }))
  const recordingFetch = async (url, init = {}) => {
    requests.push({ url: String(url), init })
    return answer(String(url), init)
  }
  const local = memoryStorage(storage)
  const context = {
    document,
    window: {
      addEventListener(type, handler) { windowListeners.push({ type, handler }) },
      matchMedia: (query) => ({ matches: Boolean(media[query]), addEventListener() {} }),
      location: { hash },
      scrollTo() {},
      requestAnimationFrame: (fn) => fn(),
      prompt
    },
    location: { hash, search: '' },
    localStorage: local,
    sessionStorage: memoryStorage(),
    fetch: recordingFetch,
    console,
    setTimeout,
    clearTimeout
  }
  const run = new Function(
    ...Object.keys(context),
    `${script}
     ; const given = arguments[arguments.length - 1]
     ; ${after}
     ; return { ${expose.join(', ')} };`
  )
  const exposed = run(...Object.values(context), given)
  return { nodes, node, document, documentListeners, windowListeners, created, requests, storage: local, exposed }
}

// Every class a piece of markup uses.
export const classesIn = (markup) => {
  const found = new Set()
  for (const match of markup.matchAll(/class="([^"]+)"/g)) for (const name of match[1].split(/\s+/)) if (name) found.add(name)
  return found
}
