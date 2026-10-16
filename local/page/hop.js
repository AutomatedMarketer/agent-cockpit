// Served to the "arriving from another page" hop (local/gate.mjs). Goes to the same page again from the
// board's own origin, where the cookie is sent - and keeps the #fragment the visitor asked for (a server
// never sees one, so this page's own address is the only place it is).
//
// It cannot just replace the address with itself: an address that differs from this one only by its
// fragment is a jump inside this page, not a new load. So the fragment is put in this tab's
// sessionStorage for the next page (local-mode.js reads it back) and the load goes to the address
// without it. Nothing secret is stored: a screen name like #readiness.
try { if (location.hash) sessionStorage.setItem('board-hash', location.hash) } catch (error) { /* the fragment is lost; the page still opens */ }
location.replace(location.pathname + location.search)
