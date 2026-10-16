// Served to the page a one-time link opens (local/gate.mjs). That page carries the board's key for the
// page in a <meta> tag - in the BODY, never in an address, because a browser writes every address it
// visits into its history and its other databases. This copies the key to this origin's own storage and
// goes on to the board. (A script file, because the page's rules allow no inline script.)
try {
  var meta = document.querySelector('meta[name="board-token"]')
  var key = meta && meta.getAttribute('content')
  if (key && /^[\w-]{20,128}$/.test(key)) localStorage.setItem('board-api-token', key)
} catch (error) { /* no storage: the board will say it needs opening again */ }
location.replace('/')
