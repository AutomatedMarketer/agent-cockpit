# Board on this computer (Student Edition) - UNFINISHED

Status: **UNFINISHED. Do not hand this to students yet.**

What exists (task T1):

- `node local/server.mjs` starts the board at `http://127.0.0.1:4317/` (`--port <n>` to change).
- It runs the same `api/*.js` files the website runs on Vercel, unchanged, and serves `public/`.
- It sends the same security headers as the website, read from `vercel.json`.
- It listens on `127.0.0.1` only and refuses to start on any other address.
- No new dependencies.

What is missing, so it is not safe to hand out:

- **T4, the sign-in wall** (Host check, one-time link, cookie). Until it exists, anything running on this
  computer can talk to the board. `createBoardServer({ gate })` is the place it plugs in.
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
