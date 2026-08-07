// Pure helpers, kept out of the handler so they can be tested without a network.

export const STALE_AFTER_DAYS = 7

// Flat `key: value` frontmatter is all an agent file uses.
export function parseFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source ?? '')
  if (!match) return {}
  const data = {}
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (pair) data[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, '')
  }
  return data
}

export function daysSince(iso, now = Date.now()) {
  if (!iso) return null
  const parsed = new Date(iso).getTime()
  if (Number.isNaN(parsed)) return null
  return Math.floor((now - parsed) / 86400000)
}

// runs must be newest first.
export function stateFor(runs, now = Date.now()) {
  if (!runs.length) return 'never-run'
  const age = daysSince(runs[0].started_at, now)
  if (age !== null && age > STALE_AFTER_DAYS) return 'stale'
  if (runs[0].status === 'failed' || runs[0].status === 'blocked') return 'attention'
  return 'working'
}

export function fillMarkers(source) {
  return [...String(source ?? '').matchAll(/<!--\s*fill:\s*([a-z0-9-]+)\s*-->/g)].map(
    (match) => match[1]
  )
}

export function sortRunsNewestFirst(runs) {
  return [...runs].sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))
}
