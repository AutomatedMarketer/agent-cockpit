# Board on this computer (Student Edition) - not ready for students yet

Status: the server (T1), the team-folder reader (T2), the picture folder (T3), the sign-in wall (T4) and the start files (T5) are done. **Not handed to students until a real Mac and Windows double-click test (below) has been done.**

Starting it (T5): double-click **`Start Board.command`** (Mac) or **`Start Board.bat`** (Windows). Both
check for Node 20 or newer and say in plain words if it is missing, run Node by its full path from an
empty folder (a program with the same name left in the board's folder is never run), and then run
`local/start.mjs`, which:

- picks port 4317, or the next free one of 10 (a port Windows keeps for itself counts as busy);
- starts the board and keeps a private file (`running.json`: port and a per-run secret, no link) in the
  user's state folder (`%LOCALAPPDATA%\Agent Board\state`, `~/Library/Application Support/Agent Board/state`,
  `~/.local/state/agent-board`);
- opens the browser on the one-time link **without the link ever being on a command line**: it writes a tiny
  private HTML file in the state folder that forwards to the link, asks the operating system to open *that
  file* (absolute program path, no shell), and deletes it 15 seconds later. The link is never printed or logged;
  it stays in the browser's history, where it is already dead;
- on a **second double-click** while the board runs, asks the running board (`POST /starter/open-link` with the
  per-run secret, refused for anything a browser sends) for a fresh link, opens it, and exits. No second server.

What exists (T1 and T4):

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

The cookie and the page's key (T9):

- A browser sends the sign-in cookie to **every** server on 127.0.0.1, whatever its port, so another local
  web server the student opens could receive it (and replay it). That is why the cookie opens only the page
  shell. Calls to `/api` also need a per-run key, `x-board-token`, which the page keeps in **localStorage**
  (kept there, not in sessionStorage or memory, because storage belongs to the origin *including the port*,
  so another port cannot read it; and because it must survive a new tab, a reload and a link from another page).
  It reaches the page once, in the **body** of the page the one-time link opens (a `<meta>` tag that a small
  script copies to storage) - never in an address, because a browser writes every address into its history,
  favicon and usage databases, and an address anyone can type must not be able to set it. A `#bt=` in an
  address is ignored and removed. The page holding the key is `no-store`. It is new for each run of the board.
- Still true: a web page running **in the same browser origin** (the board's own) can read it, as it could read
  anything on the page; the board loads no third-party script.
- The page knows it is the local board (`local/page/local-mode.js` is added in front of `app.js` by the local
  server only; the website's page is untouched): no username and password screen, no "set this in Vercel"
  words, no sign-out buttons. A board whose key is no good says "Open the board again: double-click Start Board".

What the board shows (student edition, started by Start Board):

- **Team data:** read with git from a clone of the team repo on this computer (`REPO_SOURCE=folder`,
  `REPO_FOLDER`). It shows what is committed and pushed on the branch. The clone is found from
  `board.json` next to Start Board (`{"teamFolder": "<full path>"}`), else `board.json` in the state
  folder, else the folder above the board if the board sits inside the team folder. Without one the
  board does not start and says what to do. Git gets only a short list of environment variables
  (home, PATH, system folders), never the board's keys or its per-run key.
- **Pictures:** kept in `<state folder>/pictures` (`PICTURE_STORE=folder`, `PICTURE_FOLDER`), no Vercel.
- To show real data a person needs: Node 20+, git, a clone of their team repo with a GitHub `origin`
  that has been pushed (a folder with no remote is read at its own branch and says "jobs are off"),
  and the folder named in `board.json` (or the board inside it).

Only a double-click proves (not checkable from node, to be tried on a real Mac and a real Windows PC):

- the `.command` file opens in Terminal from Finder with no Gatekeeper block after a `git clone`, and keeps its run bit;
- the `.bat` runs from Explorer with no SmartScreen warning, and keeps CRLF after a clone;
- the browser really opens the launcher file and follows it to the link (Chrome, Edge, Safari, Firefox), and the
  cookie is kept on `http://127.0.0.1:<port>`;
- closing the window stops the board and a new double-click starts it again;
- Windows file permissions: the state folder is private because the user profile is; `0600` has no effect there.

Files:

| File | Job |
|---|---|
| `start.mjs` | what the start files run: port, state file, launcher file, second-click link |
| `check-node.cjs` | says in plain words if Node is too old (plain old-style script so it runs on old Node) |
| `gate.mjs` | the sign-in wall: one-time link, cookie, Origin check, the per-run key the handlers see |
| `server.mjs` | the server, the loopback-only rule, the command line |
| `vercel-shim.mjs` | gives plain Node requests and responses Vercel's `query`, `body`, `status()`, `json()` |
| `routes.mjs` | the list of `api/` files that are served; a test fails if it differs from the folder |
| `headers.mjs` | reads the security headers from `vercel.json` |
| `static.mjs` | serves `public/` with clean URLs and refuses paths that leave it |

Run its tests with `node --test tests/local-server.test.mjs`.
