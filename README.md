# agent-cockpit

The Agent OS interface: a phone-first dashboard for your AI agent team. It reads your team
repo and gives you five screens — what happened today, who is on the team, which jobs run
when, what your agents know, and which runtimes are alive.

You deploy it. You own it. Nothing here runs on anyone else's infrastructure.

## The five screens

| Screen | What it shows |
|---|---|
| **Today** | Setup progress (the five rungs), the Board — a four-column kanban of open tasks (`tasks/*.md`), what's up next (48 h), running now, and done (last 14 days) — what is due next, what has gone quiet, and one-tap job buttons |
| **Team** | Every agent: role, model, last run, and its state — working, needs a look, gone quiet, or never run. Tap one to see its recent runs and live session links |
| **Workflows** | The board. Each named job: its chain of steps, trigger, schedule, last result, next run |
| **Memory** | Your vault, browsable: folder tree, index files, search, source filter |
| **Connections** | Every runtime in `runtimes.yml` — Hermes, OpenClaw, anything with a URL — live or silent from its heartbeat, one tap to open it |

## Where every pixel gets its data

One GitHub tree call feeds everything. No database, no Anthropic API call, no run-history
endpoint to reverse-engineer.

| Source in your team repo | Feeds |
|---|---|
| `.claude/agents/*.md` | Team rail |
| `workflows/*.yml` | Workflow board, job buttons, due-next, setup |
| `runs/YYYY-MM/*.json` | Board (Running/Done columns), last-run columns, gone-quiet |
| `tasks/*.md` | Board (To do column) — frontmatter `status: todo\|doing\|done`, optional `for: <agent-slug>`; first heading (or filename) is the title. This page never writes a task file itself — "+ Add task" dispatches to the `task-intake` routine, whose session commits the card. A `done` task earns its Done card through its run log, never twice |
| `runs/heartbeat/*.json` | Live/silent lights on the Connections rail |
| `runtimes.yml` | Connections rail entries |
| `tiles.yml`, `shared/*.md`, `skills/` | Setup ladder |
| Every `*.md` in the repo | Memory browser |

The repo shape is defined by `agent-team-template` — workflows, schedules, and validation
here are a port of that template's own `scripts/lib/` contract, so a file that passes there
renders here.

**The one rule: this dashboard reads git and never writes it.** Dispatching work is the fire
endpoint's job (`api/fire.js`): tap a Run button → the endpoint POSTs the workflow's
registered trigger URL server-side → the agent runs in the cloud → you get a live session
link. Pause is a dispatch too — the payload instructs the *agent session* to edit the
workflow file and commit; the dashboard itself still never writes.

## The fire endpoint

`POST /api/fire` with `{ "workflow": "<slug>", "action": "run" | "pause" }` (action
defaults to `run`). It refuses anything that is not:

- authorised (see the two modes below),
- a kebab-case slug that is **registered in `FIRE_TRIGGERS`**, and
- a real workflow in the team repo with `trigger.fire: true`.

It answers `{ ok, sessionUrl }` when the trigger returns a session link, else
`{ ok, accepted: true }`. Trigger timeouts and non-2xx answers come back as a plain 502 —
never the trigger's URL or body.

### Filing a task from the dashboard

`POST /api/fire` with `{ "action": "task", "title": "…", "details": "…?", "for": "<agent>?" }`
is the third action, behind the "+ Add task" button at the top of the Board's To do column.
Same auth, same content-type rules; the constraints are:

- `title` — required, 3–200 characters after trimming, one plain line (no control characters),
- `details` — optional, up to 2000 characters,
- `for` — optional kebab-case slug that must be an agent in the team repo
  (`.claude/agents/<slug>.md`), else a plain 400.

The dispatch target is one dedicated routine, registered in `FIRE_TRIGGERS` under the
reserved slug **`task-intake`** — its trigger URL goes in the map exactly like any
workflow's:

| Slug | What it is |
|---|---|
| `task-intake` | Not a workflow file — a Claude routine you create once, whose prompt is: *"act on dispatch payloads: create task cards as instructed, commit, push."* The payload's instruction spells out the card contract (`tasks/YYYY-MM-DD-<slug-from-title>.md`, `status: todo`, `for:` when given, body = details or title, per the team repo's `tasks/README.md`). |

With no `task-intake` entry in `FIRE_TRIGGERS` the action answers 404 with the fix in the
message. On success it echoes `{ ok, accepted, title }` — the title is the only user text
that ever comes back, and the dashboard itself still never writes to the repo: the routine's
agent session commits the card, which appears on the Board about a minute later.

Two env vars make it live (with neither `FIRE_KEY` nor `PUBLIC_FIRE` set it answers `503` —
closed, never open):

| Name | Value |
|---|---|
| `FIRE_KEY` | A long random string, e.g. `openssl rand -hex 32`. Callers must send it in the `x-fire-key` header. |
| `FIRE_TRIGGERS` | One JSON object mapping workflow slug → its Claude routine trigger URL: `{"monday-brief":"https://…","task-intake":"https://…"}`. Trigger URLs are secret-adjacent — env var only, never the repo. |

### How the browser authenticates (two modes)

The page never ships `FIRE_KEY` in its source. Pick one:

1. **Prompt-once (default).** The first tap gets a 401, the page prompts you for the fire
   key once, and keeps it in `sessionStorage` for that tab only. Wrong key → the stored
   value is dropped and you are asked again next tap.
2. **`PUBLIC_FIRE=true`.** Skips the key for same-origin browser calls. The endpoint
   enforces this with the `Sec-Fetch-Site` / `Origin` headers — but that is best-effort,
   since non-browser clients can forge headers. Use it **only** on deployments already
   locked behind Vercel's own authentication (private, team-only access). Anything but the
   exact string `true` still requires the key.

Neither mode rate-limits. Every accepted dispatch starts a real cloud session against your
plan's daily routine cap, and every rejected one still costs a GitHub read — so keep the
deployment private, keep the key long, and don't hand the URL around. If you need throttling,
put the deployment behind Vercel's WAF / rate-limit rules; the endpoint deliberately stays
simple.

## Deploy it

### 1. Fork this repo

Press **Fork** at the top of the GitHub page.

### 2. Connect it to Vercel

Go to `vercel.com/new`, pick your fork, press **Deploy**. There is no build step and no
`npm install` — it is a static page and three small functions.

The first deploy will show an error telling you it cannot read your repo. That is expected.
Step 3 fixes it.

### 3. Tell it which repo to read

In Vercel: **Settings → Environment Variables**. Add these:

| Name | Value |
|---|---|
| `GITHUB_OWNER` | Your GitHub username |
| `GITHUB_REPO` | Your team repo's name |
| `GITHUB_BRANCH` | Leave it out unless your branch is not `main` |
| `GITHUB_TOKEN` | **Only if your team repo is private** — see below |
| `FIRE_KEY` | **Only if you want the Run/Pause buttons** — see "The fire endpoint" |
| `FIRE_TRIGGERS` | Same — the slug → trigger URL map, as one JSON object |

(`.env.example` in this repo lists all of them with placeholder values.)

Then **Deployments → the latest one → Redeploy**.

### 4. If your team repo is private

Most people's are, because the business brain is in there.

Make a token at `github.com/settings/personal-access-tokens/new`:

- **Repository access:** only your team repo
- **Permissions:** Contents → **Read-only**. Nothing else.

Paste it into `GITHUB_TOKEN` in Vercel and redeploy.

That token lives on the server and is never sent to the browser. Do not commit it, do not
paste it into a chat, and do not give it write access — this page only ever reads.

### 5. Put it on your phone

Open the deployed URL on your phone and add it to your home screen. The whole layout is
built to be used one-handed — the navigation lives under your thumb.

On a desktop-width window the same nav becomes a left sidebar, the Workflows screen gains a
7-day Schedule strip with a legend, and every agent keeps one stable identity color across
Team, Workflows, Board, and Schedule.

## Talk to your team

The header (and the bottom of the desktop sidebar) carries a **Talk to your team** link: it
opens [claude.ai/code](https://claude.ai/code) in a new tab, where you start a Claude session
on your team repo — your orchestrator, your rules. It is a plain link, nothing more: no API
call, no key, no state.

## No API key needed

There is no chat box on this page, on purpose. A chat box would need an Anthropic API key,
which is billed per token and would quietly break the promise that this costs nothing beyond
your Claude plan.

Everything you see here is free to run: a static page, three functions, and GitHub's read API.

## Runs anywhere

It is a static page plus three serverless functions using nothing but `fetch`. Zero npm
dependencies. It works on Vercel out of the box; Cloudflare Pages and Netlify both work with
their own function conventions.

## Checking it locally

```bash
npm test
```

The suite covers frontmatter and YAML parsing, workflow validation (matching the template's
rules word for word), next-run computation for every schedule form, task parsing and the
Board's four columns, gone-quiet and heartbeat
staleness logic, the file endpoint's path safety, an end-to-end pass over a stubbed
GitHub for every screen's data, and the fire endpoint end to end — auth (401/503, both
modes), slug and action validation, repo + `trigger.fire` checks, run, pause, and task
dispatch (title/details/`for` validation, the `task-intake` 404, the title-only success
echo), 502 on trigger failure, and a no-secret-ever-leaks assertion on every path. No
network, no keys, no install.

## What the states mean

| State | Meaning | Threshold |
|---|---|---|
| **Working** | Ran recently, last run was fine | — |
| **Needs a look** | Last run failed or was blocked, or the workflow file has problems | — |
| **Gone quiet** | An agent silent for more than 7 days, or a scheduled workflow that missed two whole intervals | `STALE_AFTER_DAYS` in `api/lib.js` |
| **Never run** | Defined, but no run log yet | — |
| **Live / Silent** | Runtime heartbeat fresh / stale | `HEARTBEAT_STALE_AFTER_MINUTES` (30) in `api/lib.js` |

An agent that silently stopped is worse than no agent — that is why "gone quiet" gets its
own list on the home screen.
