# Board on this computer (Student Edition) - not ready for students yet

Status: the server (T1), the team-folder reader (T2), the picture folder (T3), the sign-in wall (T4), the start files (T5) and jobs on this computer (T8, on the `student-runner` branch) are done. **Not handed to students until a real Mac and Windows double-click test (below) has been done.**

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

The Settings box (T10) - local board only:

- A **Settings** button on the board opens a box where a student pastes an **OpenAI key** (for voice), and
  optionally a Fish Audio or OpenRouter key. No Vercel, no environment variables. The website never shows the
  box (it keeps its environment variables; nothing in `public/` or `api/` knows about it).
- The key goes to `settings.json` in the locked state folder (current user only; `0600` on Mac and Linux),
  into the handlers' environment at once, and back into it at every start. A saved key wins over one the
  computer already had.
- The page is **never** sent the key: it learns "saved" and the last four characters, and a Remove button.
  The key is not logged, not in any error message (one fixed sentence per failure), not in `/api/state`.
- Only values shaped like the key are accepted (OpenAI: `sk-` and 20-200 letters, digits, `-`, `_`); a space,
  new line or control character is refused with a plain sentence that does not repeat what was pasted.
- **Test this key** makes one call to the service's models address (`GET /v1/models`), no redirects, 10 seconds
  at most, and says "This key works.", "OpenAI refused this key..." or "...no credit left...". Fish keys are
  saved but cannot be tested here.
- The address is `POST /api/local-settings` and needs the cookie, the page's key, the board's own Origin and a
  JSON body under 2000 characters. Not checked on Windows by a test: the file mode (Windows has no modes; the
  state folder is locked to the user with icacls instead).

Local voice (T16) - Voice engine: Cloud / Local in the Settings box:

- **Cloud** (OpenAI's realtime voice) stays the default. **Local** is a turn-based loop that runs on this computer:
  the page listens until you stop talking, the board sends that sound to a **speech-to-text** program, asks a
  **language model** (with the same tools and instructions as the cloud voice - `toolsFor` and `instructionsFor`
  are reused, not copied), and speaks the reply clause by clause through a **text-to-speech** program. The model's
  tool calls run in the page exactly as they do for the cloud voice, so the yes-cards, data-only results and
  spoken-yes rules are unchanged. `local/page/voice-local.js` stands in for OpenAI's connection by handing the
  page the same events a realtime call would.
- The three programs are OpenAI-shaped web addresses (defaults: speech to text `http://127.0.0.1:3900/v1/audio/transcriptions`,
  model `whisper-1`; language model `http://127.0.0.1:11434/v1/chat/completions`, model `qwen3:8b`; text to speech
  `http://127.0.0.1:3900/v1/audio/speech`, model `kittentts`, voice `alloy`). They are called from the board's server,
  never the browser, and **only** at `http://127.0.0.1`, `http://localhost` or `http://[::1]` - no other host, no https,
  no login in the address, no redirects, and never the board's own port. Checked when saved and again at every call.
- What the spike found is built in (`docs/superpowers/specs/2026-10-16-local-brain-spike.md`): thinking is off
  (`reasoning_effort: none`) and the model is told "call the matching tool immediately and say nothing before it";
  without that sentence it says "let me check" and then makes things up. `<think>` blocks, printed tool-call markup and
  a leaked "Okay, the user is asking..." are cut before anything is spoken, and words that come before a tool call are
  not spoken at all. If the model gives no tool call and no words, it says one plain line instead of staying silent.
- If a part is down, the student gets one plain line naming it ("The thinking part ... is not answering at 127.0.0.1:11434.
  Start it, or switch the Voice engine back to Cloud in Settings.") and the call goes back to listening.
- Local voice costs nothing and sends nothing to OpenAI, so it keeps no cost record (no entry in the cloud voice meter).

Trying it for real on the Mac (Voice Studio running on 127.0.0.1:3900; Ollama with `qwen3:8b` on 127.0.0.1:11434):

1. Get this branch (`student-edition`) onto the Mac and put a `board.json` next to `Start Board.command` naming the team folder
   (`{"teamFolder": "/Users/you/path/to/team"}`), then double-click `Start Board.command`.
2. In the board (Chrome): **Settings**, **Voice engine**, choose **Local**, **Save voice settings**, then **Check the three parts**
   (it should say all three are answering), then **Reload the board**.
3. Tap the orb, allow the microphone, say "what is due today", and wait. The first answer is slow (the model loads: about 9 s on
   the Mini); later ones are about 1.5 to 5 s in the spike.
4. Things to watch, which only the real programs can show: Voice Studio taking the 16 kHz WAV and `whisper-1` model name; Ollama
   taking `reasoning_effort: none`; Voice Studio's voice name (`alloy` worked in the spike; change it in the box if not).

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

Jobs on this computer (T8) - the Run, task and card buttons:

- **What happens on Run.** `/api/fire` checks the order exactly as on the website and, in mailbox mode, signs it and
  keeps it in the board's queue (the picture folder). Right after it answers, the board gives the team's own mailbox
  runner one tick (`--once`), in this same program; a tick every 5 minutes settles anything left over, and the
  runner's own lock keeps it to one at a time. The board never writes the team repo: the runner does, in its own copy,
  and pushes; the board reads the result back with git like every other file.
- **The runner's board is `https://this-computer.invalid`**, a name no network can resolve. The fetch the runner is
  handed answers only `GET https://this-computer.invalid/api/mailbox`, by calling the real `api/mailbox.js` here
  (Authorization header only, no cookie, Origin or Sec-Fetch-Site); any other address, method or body is refused.
- **Every wall of the Mac runner comes along unchanged**: its allowlist and day limits, claims (never run twice), and
  Claude Code with `--restricted`, no shell, **no connectors** (`--disallowedTools mcp__*`, an empty MCP list), file
  tools only in its own work copy, a time limit, a self-test before any run.
- **Written on the first start, never over an existing file, never shown:** in `<state folder>/runner/`
  `runner.env` (`MAILBOX_KEY`, `MAILBOX_SECRET_k1`: 64 random hex digits each, 0600) and `allowed-orders.yml`
  (board `https://this-computer.invalid`, runner `this-computer`, computer `This computer`, the repo from the team
  folder's GitHub origin, both jobs, 40 orders and 6 runs a day). The board reads the same `runner.env` the runner
  reads and sets `FIRE_MODE=mailbox`, `MAILBOX_*`, `GITHUB_OWNER` / `GITHUB_REPO` for its handlers; a `FIRE_TRIGGERS`,
  `FIRE_KEY` or `MAILBOX_*` the computer already had is removed.
- **Where things are** (none overlaps another or the team folder; checked at start and by the runner every tick):

| | Windows | Mac |
|---|---|---|
| runner code (pinned) | `%USERPROFILE%\Agent Board\runner-code` (next to Start Board) | `~/Agent Board/runner-code` |
| runner state + secrets | `%LOCALAPPDATA%\Agent Board\state\runner` | `~/Library/Application Support/Agent Board/state/runner` |
| work copy | `%LOCALAPPDATA%\Agent Board\work` (cloned from the team folder's origin on the first start) | `~/Library/Application Support/Agent Board/work` |

  The runner's state is a folder of its own inside the board's state folder (not the state folder itself): the
  runner's Windows lock reads every file of its folder on every tick, and the board writes pictures all the time.
- **Install (for `/onboard`, T17):** clone the student's own team repo, at its current commit, to `runner-code` next to
  Start Board (`runner-code/` is in `.gitignore`). Start the board once (it writes the files above), close it, then run
  the runner's self-test with the same places, for example on Windows:
  `node runner-code\scripts\mailbox-runner.mjs --selftest --state-dir "%LOCALAPPDATA%\Agent Board\state\runner" --work-dir "%LOCALAPPDATA%\Agent Board\work" --env-file "%LOCALAPPDATA%\Agent Board\state\runner\runner.env"`.
  Until it passes, card orders work and Run orders are refused as "not ready".
- **Jobs stay off**, with one line in the Start window, when the team folder is not on GitHub, `runner-code` is missing
  (or is inside the team folder), or the runner's files cannot be written or read.
- git for the runner is found once on PATH by its full path (never one inside the team folder, the board, the runner
  code or its work copy), started from git's own folder with `-C`; the runner and every program it starts get only
  where-things-are variables (PATH, HOME, the Windows profile folders...), never a key, the per-run key or a board setting.

This computer's numbers (T8) - usage and connections:

- The collector from `runner-code` (never the team folder) runs with this board's own Node, from an empty folder, with
  `--out <state folder>/status` (outside every repo, nothing committed): every part at start, usage every 15 minutes,
  and every part on **Refresh now** in the Settings box (`POST /api/local-refresh`, behind the same wall as Settings).
- The team folder reader lays those files over the repo at the same paths (`REPO_STATUS_FOLDER`, folder mode only):
  only `.agent-team/status/{usage,connections,hermes,jobs,vaults}/<name>.json` and `runs/heartbeat/hermes.json`, plain
  files only (no link on the way), 512 KB each at most. Never a mailbox status file, an agent or anything else.
- After a refresh, the page's 60-second check is answered in full once, so new numbers show without a commit.

Known limits of jobs on this computer:

- The runner refuses orders issued in the first 2 minutes after its claim store is first made (its own rule against a
  clock that runs behind). On a brand-new install, the very first order sent within 2 minutes of the first start is
  refused ("did not pass its checks").
- The board's queue still allows 8 orders a day (`MAILBOX_ORDERS_PER_DAY`, set for the website's free picture store).
- Some mailbox answers still say "your Mac" (the website's words).
- Closing the Start window while a job runs stops Claude; the order shows "outcome unknown" and is settled by reading
  the team repo at the next start, never run again.

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
| `runner.mjs` | jobs on this computer: the runner's files, its in-process board, its git, the kick after `/api/fire` |
| `collector.mjs` | this computer's numbers: the collector on a schedule and Refresh now, and the full read after a refresh |

Run its tests with `node --test tests/local-server.test.mjs`; jobs and numbers with
`node --test tests/local-runner.test.mjs tests/local-runner-walls.test.mjs tests/local-collector.test.mjs` (the runner
tests use the template checkout next to this repo, or `AGENT_TEAM_TEMPLATE`, read only; they skip without it).
