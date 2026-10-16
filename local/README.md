# Board on this computer (Student Edition) - not ready for students yet

Status: the server (T1) and the sign-in wall (T4) are done. **T2, T3 and T5 are not, so do not hand this to students yet.**

What exists (task T1):

- `node local/server.mjs` starts the board at `http://127.0.0.1:4317/` (`--port <n>` to change; not port 80).
- **Sign-in wall (T4):** it prints one link. The link works once, for 2 minutes, and is swapped for a cookie
  (HttpOnly, SameSite=Strict, valid only for this run: stop and start and everything old stops working).
  Every change must carry the board's own Origin. Without the cookie every page and api call is a 401.
  The website's own sign-in (`api/login.js`) is not touched. Start it for a person with `startLocalBoard()`
  or the command line, never `createBoardServer()` alone (that has no wall; the tests use it that way).
- It runs the same `api/*.js` files the website runs on Vercel, unchanged, and serves `public/`.
- It sends the same security headers as the website, read from `vercel.json`.
- It listens on `127.0.0.1` only, refuses to start on any other address, and answers only `127.0.0.1:<port>` and `localhost:<port>` as Host.
- It replaces any `X-Forwarded-For` / `X-Real-IP` / `X-Forwarded-Host` a caller sends with the real connection address.
- No new dependencies.

Known limits:

- **Cookies are shared across ports on 127.0.0.1.** A browser sends the board's cookie to any other web
  server the student opens at `127.0.0.1:<other port>`, and such a server can also plant a cookie. Done
  here: the port is in the cookie name (two boards do not sign each other out), any valid value counts
  (a planted junk one cannot sign the student out), and a request that says it comes from another site
  or port is refused. Not done: that other server still *receives* the cookie. Planned fix (T9): the
  page's api calls carry a header token kept in the board page's own storage, not a cookie, and the
  cookie opens only the page shell.

What is missing:

- **T2**, reading the team folder with git instead of GitHub. Today the handlers still read GitHub, so
  `GITHUB_OWNER`, `GITHUB_REPO` and a token must be in the environment.
- **T3**, pictures in a folder instead of Vercel Blob.
- **T5**, the double-click starters, port picking and `.vercelignore` (so `local/` is not deployed).

Files:

| File | Job |
|---|---|
| `gate.mjs` | the sign-in wall: one-time link, cookie, Origin check, the per-run key the handlers see |
| `server.mjs` | the server, the loopback-only rule, the command line |
| `vercel-shim.mjs` | gives plain Node requests and responses Vercel's `query`, `body`, `status()`, `json()` |
| `routes.mjs` | the list of `api/` files that are served; a test fails if it differs from the folder |
| `headers.mjs` | reads the security headers from `vercel.json` |
| `static.mjs` | serves `public/` with clean URLs and refuses paths that leave it |

Run its tests with `node --test tests/local-server.test.mjs`.
