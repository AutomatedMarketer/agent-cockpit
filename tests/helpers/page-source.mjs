// The board's page as a browser gets it: the markup (public/index.html) and its script (public/app.js).
// The script used to sit inside the page; it moved to its own file so the content security policy can
// refuse every inline script (audit finding #4, 2026-10-10).
//
// Memory's graph view is a second file, public/memory-graph.js, that the page loads only when Graph is
// first opened, and Memory's search a third, public/memory-find.js, loaded when Memory first opens (or
// voice is first asked to find a note). `script` is the page as it is once both have happened - the files
// one after the other, sharing one scope, as plain scripts of one page do - so every test sees all of the
// page's code. `app` is /app.js alone: the page before anybody opens Memory.
import { readFileSync } from 'node:fs'

export const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8')
export const app = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')
export const graphView = readFileSync(new URL('../../public/memory-graph.js', import.meta.url), 'utf8')
export const findView = readFileSync(new URL('../../public/memory-find.js', import.meta.url), 'utf8')
export const script = `${app}\n${graphView}\n${findView}`
// Both, for a test that asks whether the page says something anywhere.
export const pageSource = `${html}\n${script}`
