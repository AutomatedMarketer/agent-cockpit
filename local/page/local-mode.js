// Added to the board's page by the local server, in front of app.js, and only there: the website's
// page never gets this file. Plain old-style script; it runs before the page does.
(function () {
  var TOKEN_KEY = 'board-api-token' // key-handoff.js stores it under this name

  // 1. The page knows it is the board on this computer (app.js reads this).
  window.__BOARD_LOCAL__ = true
  document.documentElement.setAttribute('data-board-mode', 'local')

  // 2. The key for calls to /api. It is handed over inside the page a one-time link opens, in its body
  //    (key-handoff.js stores it); it is NEVER in an address, because a browser writes every address into
  //    its history and other databases, and an address anyone can type must not be able to set it (a link
  //    with a made-up key would sign the student out). So a #bt= in the address is ignored and removed.
  //
  //    Kept in localStorage - not sessionStorage, not memory - on purpose:
  //    - it belongs to THIS origin, host AND port, so a web server the student opens on another
  //      port of 127.0.0.1 (which does receive the sign-in cookie, as cookies ignore ports) cannot
  //      read it, and without it the cookie opens no /api call;
  //    - it survives a new tab, a link from another page, and a reload, which memory and
  //      sessionStorage do not (sessionStorage is per tab, and a link opened in a new tab starts empty);
  //    - it is worth nothing after the board is stopped: the key is made fresh for each run.
  //    A script on this page could read it, as it could read anything on the page: the page holds no
  //    third-party script (the page's rules allow only its own files).
  try {
    if (/^#bt=/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search)
  } catch (error) { /* nothing to remove */ }

  // 3. Where the "arriving from another page" hop (hop.js) left the #fragment the visitor asked for.
  try {
    var kept = sessionStorage.getItem('board-hash')
    if (kept) {
      sessionStorage.removeItem('board-hash')
      if (!location.hash && /^#[\w.-]{1,60}$/.test(kept)) history.replaceState(null, '', location.pathname + location.search + kept)
    }
  } catch (error) { /* no storage: the page opens on its first screen */ }

  // 4. Every call this page makes to its own /api carries the key.
  var original = window.fetch.bind(window)
  window.fetch = function (input, init) {
    try {
      var target = new URL(typeof input === 'string' ? input : (input && input.url) || String(input), location.href)
      if (target.origin === location.origin && target.pathname.indexOf('/api/') === 0) {
        var token = localStorage.getItem(TOKEN_KEY)
        if (token) {
          var headers = new Headers((init && init.headers) || (input && input.headers) || undefined)
          headers.set('x-board-token', token)
          init = Object.assign({}, init, { headers: headers })
        }
      }
    } catch (error) { /* send it as it was; the board will say it needs opening again */ }
    return original(input, init)
  }

  // 5. There is no website sign-in here, so there is nothing to sign out of.
  var style = document.createElement('style')
  style.textContent = '#sign-out, #sign-out-everywhere { display: none !important }'
  document.head.appendChild(style)
})()
