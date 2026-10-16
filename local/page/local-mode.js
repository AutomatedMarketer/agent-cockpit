// Added to the board's page by the local server, in front of app.js, and only there: the website's
// page never gets this file. Plain old-style script; it runs before the page does.
(function () {
  // Where the "arriving from another page" hop (hop.js) left the #fragment the visitor asked for.
  try {
    var kept = sessionStorage.getItem('board-hash')
    if (kept) {
      sessionStorage.removeItem('board-hash')
      if (!location.hash && /^#[\w.-]{1,60}$/.test(kept)) history.replaceState(null, '', location.pathname + location.search + kept)
    }
  } catch (error) { /* no storage: the page opens on its first screen */ }
})()
