// The board's page as a browser gets it: the markup (public/index.html) and its one script
// (public/app.js). The script used to sit inside the page; it moved to its own file so the content
// security policy can refuse every inline script (audit finding #4, 2026-10-10).
import { readFileSync } from 'node:fs'

export const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8')
export const script = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')
// Both, for a test that asks whether the page says something anywhere.
export const pageSource = `${html}\n${script}`
