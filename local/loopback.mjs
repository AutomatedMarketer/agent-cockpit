// The local voice parts (speech to text, the brain, speech out) are programs on THIS computer. The
// board is told where they are by the student, and calls them from its own server - so an address it
// will call must be one that cannot leave this computer. Anything else is refused: no other host, no
// https redirect hop, no login in the address, no query. (Without this the Settings box could be made
// to reach other machines from the student's own network.)

export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

// The URL object, or null. `text` must be a plain address of the form http://HOST[:PORT]/path with HOST
// one of the loopback names exactly. WHATWG parsing has already turned 127.1 or 0x7f.1 into 127.0.0.1,
// so the host is compared after that; "localhost." and "127.0.0.1.evil.example" are other names.
export function parseLoopbackUrl(text, { exceptPort = null } = {}) {
  if (typeof text !== 'string' || text.length < 8 || text.length > 200) return null
  if (/[\s\u0000-\u001f\u007f-\u009f\\@]/.test(text)) return null
  let url
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol !== 'http:') return null
  if (!LOOPBACK_HOSTS.has(url.hostname)) return null
  if (url.username || url.password || url.search || url.hash) return null
  // The path as it was WRITTEN, not as parsing tidied it: "/../" and "%2e%2e" are dot segments the parser would
  // quietly remove, and the written form is what a person (or a forged request) put there.
  const written = text.replace(/^http:\/\/[^/]*/i, '')
  if (written !== '' && (!/^\/[A-Za-z0-9._~/-]*$/.test(written) || written.split('/').some((part) => part === '..' || part === '.'))) return null
  if (exceptPort !== null && String(url.port || '80') === String(exceptPort)) return null
  return url
}

// The address to actually call: "localhost" is not looked up (a hosts file or a resolver could send it
// elsewhere), it is the loopback address itself.
export function callableAddress(url) {
  const copy = new URL(url.href)
  if (copy.hostname === 'localhost') copy.hostname = '127.0.0.1'
  return copy.href
}

// "127.0.0.1:3900" - what is said to the student when a part does not answer. Never the path.
export const whereIs = (url) => `${url.hostname === 'localhost' ? '127.0.0.1' : url.hostname.replace(/^\[|\]$/g, '')}:${url.port || '80'}`
