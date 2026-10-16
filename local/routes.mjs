// Which files in api/ the local board serves, and at what address. An explicit list on purpose:
// Vercel routes whatever sits in api/ (minus files starting with an underscore), so a new file
// goes live there on its own. Here a new file must be added to this list by a person - and
// tests/local-server.test.mjs fails until it is - so nothing is exposed on a student's computer
// by accident, and nothing that works on the website is silently missing locally.

export const API_ROUTES = Object.freeze([
  'art',
  'brand',
  'file',
  'fire',
  'generate',
  'graph',
  'login',
  'logout',
  'mailbox',
  'memory-index',
  'memory-search',
  'route-task',
  'speak',
  'state',
  'upload',
  'voice-meter',
  'voice-session'
])

// "/api/state" -> "state"; anything that is not exactly one listed name -> null.
export function routeNameFor(pathname) {
  const match = /^\/api\/([a-z0-9-]+)$/.exec(pathname)
  return match && API_ROUTES.includes(match[1]) ? match[1] : null
}
