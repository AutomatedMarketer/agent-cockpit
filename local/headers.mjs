import { readFileSync } from 'node:fs'

// The security headers the website sends come from vercel.json. The local board reads the same
// file, so there is one list and the two can never drift apart. Only the shape this board uses
// is understood (cleanUrls on, headers for every path); anything else throws, so a rule added
// to vercel.json later cannot be silently ignored here.
export function loadVercelConfig(vercelJsonPath) {
  const config = JSON.parse(readFileSync(vercelJsonPath, 'utf8'))
  if (config.cleanUrls !== true) throw new Error('vercel.json: the local board only understands cleanUrls: true')
  for (const key of ['redirects', 'rewrites', 'routes']) {
    if (config[key]) throw new Error(`vercel.json has "${key}", which the local board does not apply yet`)
  }
  const headers = []
  for (const rule of config.headers ?? []) {
    if (rule.source !== '/(.*)') {
      throw new Error(`vercel.json header rule for "${rule.source}" is not applied by the local board; only "/(.*)" is understood`)
    }
    for (const { key, value } of rule.headers) headers.push([key, value])
  }
  return { headers }
}
