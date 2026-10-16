# Board on this computer (Student Edition) - UNFINISHED

Status: **UNFINISHED. Do not hand this to students yet.**

What exists (task T1):

- `node local/server.mjs` starts the board at `http://127.0.0.1:4317/` (`--port <n>` to change).
- It runs the same `api/*.js` files the website runs on Vercel, unchanged, and serves `public/`.
- It sends the same security headers as the website, read from `vercel.json`.
- It listens on `127.0.0.1` only, refuses to start on any other address, and answers only the Host names above.
- It replaces any `X-Forwarded-For` / `X-Real-IP` / `X-Forwarded-Host` a caller sends with the real connection address.
- No new dependencies.

What is missing, so it is not safe to hand out:

- **T4, the sign-in wall** (one-time open link and a cookie). The Host check is already in: only
  `127.0.0.1:<port>` and `localhost:<port>` are answered, so a web page cannot reach the board through
  a name it controls. But another program on this same computer can still talk to the board until
  T4 lands. `createBoardServer({ gate })` is the place it plugs in (it runs after the Host check).
- **T2**, reading the team folder with git instead of GitHub. Today the handlers still read GitHub, so
  `GITHUB_OWNER`, `GITHUB_REPO` and a token must be in the environment.
- **T3**, pictures in a folder instead of Vercel Blob.
- **T5**, the double-click starters, port picking and `.vercelignore` (so `local/` is not deployed).

Files:

| File | Job |
|---|---|
| `server.mjs` | the server, the loopback-only rule, the command line |
| `vercel-shim.mjs` | gives plain Node requests and responses Vercel's `query`, `body`, `status()`, `json()` |
| `routes.mjs` | the list of `api/` files that are served; a test fails if it differs from the folder |
| `headers.mjs` | reads the security headers from `vercel.json` |
| `static.mjs` | serves `public/` with clean URLs and refuses paths that leave it |

Run its tests with `node --test tests/local-server.test.mjs`.
