# agent-cockpit

**The noticeboard for your AI agent team.** A web page at your own address that reads your team
repo and tells you what your agents did, what they are about to do, and — the part most dashboards
skip — **which of your jobs actually run at all.**

You deploy it. You own it. Nothing here runs on anybody else's infrastructure, and it never writes
to your repo. Its only write power is over its own picture store.

---

## Who this is for

Anyone using [agent-team-template](https://github.com/AutomatedMarketer/agent-team-template) who
would rather glance at a page than read files.

**Nothing depends on this working.** Your agents run whether or not the board is up. It is the
window, not the engine.

---

## The seven screens

| Screen | The question it answers |
|---|---|
| **Today** | What happened, what is next, what has gone quiet — plus one-tap Run buttons |
| **Ledger** | What your week costs, what was proposed for it, and what nothing on the team can do |
| **Team** | Every agent: model, last run, and whether it is working, quiet or never run |
| **Workflows** | Every job, and whether it is **armed, declared, unapproved or off** |
| **Skills** | What this team can actually do, and which jobs use each skill |
| **Memory** | Your vault, browsable and searchable **by page name** |
| **Connections** | Every runtime in `runtimes.yml` — alive or silent, from its own heartbeat |

---

## The look

The board opens **dark**, and there is a **light theme** too. The switch is in the top bar. It
remembers your choice **on that device only**. If you have never touched it, the board follows your
phone's or computer's own light/dark setting.

| Part | What to know |
|---|---|
| **Typeface** | Inter, served from this site (`public/fonts/`, with its OFL licence in `public/fonts/OFL.txt`). It is not loaded from Google, because the page's security header only allows its own files |
| **Pictures** | Today's harbour, Team's workshop and the eight agent portraits are original art made for this board |
| **Your own agents** | An agent you add later gets a coloured tile with its initial until it has a picture |

**The built-in art** is what every copy of this board starts with. To change the pictures and names
on *your* board without touching code, see [Make it yours](#make-it-yours) below. To add a portrait
to the built-in art itself, do both of these:

1. Put a 480x480 `.webp` named `agent-<name>.webp` in `public/art/`
2. Add its name to the `PORTRAITS` list in `public/index.html`

The list is what decides. A file in `public/art/` that is not in the list is never shown.

**Kept light on purpose.** The tests refuse anything over these sizes, so a careless export cannot
slow the board down on a phone:

| File | Limit |
|---|---|
| A banner (Today, Team) | 100 KB |
| An agent portrait | 45 KB |
| All the pictures together | 450 KB |
| The typeface | 64 KB |

Only Today's banner loads straight away. Every other picture loads when you scroll to it or open
its screen.

**The three numbers on Today**, and where each comes from:

| Number | Where it comes from |
|---|---|
| **Work done** | Runs counted from `runs/` in your repo, over the last 7 days |
| **Agents working** | How many agents are working now, from each agent's own runs |
| **Your number** | The figure you chose in `tiles.yml` (`/onboard` asks which) |

A number with nothing behind it shows a sentence saying why, never a zero.

---

## Make it yours

Rename your agents, put in your own pictures, and choose the art style new pictures are made in -
all from the board itself, on a phone or a laptop, and it shows at once.

| Where | What you can change |
|---|---|
| **Each Team card** (tap it open, then **Personalise**) | The name on the card, **Choose a picture**, **Describe it** then **Make it**, and **Back to the default** |
| **The Today and Team banners** (the small **Personalise** button) | The banner picture: choose one, make one, or go back to the default |
| **Make it yours** (in the Team banner) | Your assistant's name, and the art style every picture made from words follows. The default style is shown, with **Back to the default** |

**Names never break anything.** A name changes what you *see*. Jobs, task cards and routines still
find the agent by its slug (`research`, `content`), which stays on the card, smaller, under the name.

**Your photo is shrunk on your device first.** It is cut from the middle to the right shape (square
for a card, wide for a banner) and made small - 45 KB for a card, 100 KB for a banner - before it is
sent. On a phone, **Choose a picture** offers your camera and your photo library.

**Where it is kept.** In a picture store of the board's own, never in your team repo. That store is
the one thing the board can write to.

### Switch it on

Until you do, the board looks exactly as before, and **Make it yours** says how to switch it on.

1. In Vercel, open **this board's project** → **Storage** → **Create Storage** → **Blob** → **Continue**
2. Choose access **Private**. *You cannot change this later*, and the board only works with a private store
3. Give it a name → **Create**, with **Production** and **Preview** both ticked
4. If the store is not connected to this project yet: the store's **Projects** tab → **Connect to Project**
5. **Redeploy.** Vercel adds the store's settings (`BLOB_...`) for you, but only a new deployment sees them

The Personalise buttons appear once the redeploy is live.

### Pictures from words (optional)

**Make it** asks OpenAI's image model for a picture, in your art style. Set `OPENAI_API_KEY` - the same
key the voice assistant uses - and redeploy. Without it, everything else still works and the board says
why **Make it** is missing.

- **Cost:** about 1 to 2 cents a picture with the default model (`gpt-image-1-mini`, medium quality),
  per [OpenAI's price page](https://developers.openai.com/api/docs/guides/image-generation). It is
  charged to your OpenAI account
- **Daily caps:** at most 10 pictures from words and 25 changes of any kind a day (names, uploads,
  resets). The counts start again at **midnight UTC**. Raise or lower them with `GENERATE_DAILY_CAP`
  and `WRITE_DAILY_CAP`; `0` switches that kind of change off
- **What leaves the board:** only the description you typed and your art style, sent to OpenAI

### Who can change things

Anyone with the view key can personalise the board - the store holds only pictures and names, and the
caps limit what a key can spend. To let people **look but not change**, set `EDIT_KEY` as well: the
board asks for it the first time somebody changes something, and keeps it on that device.

**`EDIT_KEY` is required on an open board** (`PUBLIC_DASHBOARD=true`). Without it, changes are off
there, because anyone with the URL could otherwise spend your OpenAI money.

---

## The two things this board refuses to do

These are the reason anything else on it is worth believing.

**It never invents a next-run time.** A workflow file saying `schedule: "daily 06:30"` makes
nothing happen at 06:30 — a *routine* is the alarm clock. Only an **armed** job gets a next-run
time. A job with no routine says *"Nothing fires this. The schedule above is a wish"* instead.

**It never shows a number it cannot source.** If the hero metric cannot be computed from your
ledger, the board says so in a sentence. It does not show a zero, because a zero there is a claim
about your week in the largest type on the screen.

The same rule covers the schedule itself: **no web page can call the routines API**, so the board
reads a snapshot your repo commits and always prints when it was taken. No snapshot means *"which
of these actually ring is unknown"* — never *"nothing is scheduled"*, which is a different claim it
has no evidence for.

---

## Before you start

| You need | Why |
|---|---|
| **A team repo on GitHub** | This board reads it. Without one there is nothing to show |
| **A Vercel account** (free tier is fine) | Where the page runs |
| **Node.js 20 or newer** | Only if you want to run the tests locally |

---

## Install

**1. Fork this repo.** Your own copy, your own URL.

**2. Deploy it to Vercel.** Import the fork; the defaults are correct.

**3. Point it at your team repo.** In Vercel's *Settings → Environment Variables*:

| Variable | Value | Required |
|---|---|---|
| `GITHUB_OWNER` | Your GitHub username or org — e.g. `janedoe` | **Yes** |
| `GITHUB_REPO` | Your team repo's name — e.g. `my-agent-team` | **Yes** |
| `GITHUB_BRANCH` | Usually `main`. Leave unset and it defaults to `main` | No |
| `GITHUB_TOKEN` | A read-only token. **Required if your team repo is private** | If private |
| `VIEW_KEY` | A password for the board. Send it as the `x-view-key` header | **Yes**, unless… |
| `PUBLIC_DASHBOARD` | `true` to skip the key entirely — only if the repo is genuinely public | No |
| `FIRE_TRIGGERS` | JSON mapping job slug → its trigger URL. Needed for the Run buttons. **Include `task-intake`** — a routine, not a job — or Add task, New workflow, Arm and Approve all fail | For buttons |
| `FIRE_KEY` | A password for firing jobs, sent as `x-fire-key` | For buttons |
| `PUBLIC_FIRE` | `true` to drop `FIRE_KEY` for requests from your own page. **Read the warning below first** | No |
| `BLOB_...` | Set **by Vercel** when you connect a private Blob store. You never type these. See [Make it yours](#make-it-yours) | To personalise |
| `OPENAI_API_KEY` | Your OpenAI key, for **Make it** - the same one the voice assistant uses | For pictures from words |
| `OPENAI_IMAGE_MODEL` | The image model. Leave unset for `gpt-image-1-mini` | No |
| `EDIT_KEY` | A password for changing names and pictures, sent as `x-edit-key`. **Required if `PUBLIC_DASHBOARD=true`** | If public |
| `WRITE_DAILY_CAP` | Changes a day (names, uploads, resets). Default `25` | No |
| `GENERATE_DAILY_CAP` | Pictures from words a day. Default `10` | No |

**Redeploy after changing any of these.** Vercel does not apply env vars to a running deployment.

> **`PUBLIC_FIRE` is a convenience, not a security boundary.** It tells the fire endpoint to accept
> requests that look like they came from your own page, using headers a browser sets. A browser
> cannot lie about them; anything that is not a browser can **forge them freely**. So with
> `PUBLIC_FIRE=true`, anyone who knows your dashboard's URL can start your jobs - spending runs on
> your Claude account - without a key. The buttons still cannot make anything *send*, and the
> dashboard still cannot write to your repo, but the runs are real and they are yours. Leave it
> unset and use `FIRE_KEY` unless you have a reason not to.

**4. Open it.** If you set `VIEW_KEY`, the page asks for it once and remembers.

---

## Did it work?

- The page loads and the **Today** screen shows your repo name at the top
- All seven screens open from the nav
- **Workflows** shows a state chip on every job
- The footer says when it read your repo

**If it says "not configured"** — `VIEW_KEY` is unset and `PUBLIC_DASHBOARD` is not `true`. Set one.

**If it says "Set GITHUB_OWNER and GITHUB_REPO"** — those two are missing, or you did not redeploy
after adding them.

Locally:

```bash
npm test
```

831 tests, nothing to install to run them. They cover the data logic, the fire endpoint's auth, and —
since a regex over the page source proves nothing about what a person sees — a harness that renders
all seven screens and asserts on the actual output. The board has **one dependency, `@vercel/blob`**,
used only when you connect a picture store.

---

## When it breaks

| What you saw | What to do |
|---|---|
| `This dashboard is not configured` | Set `VIEW_KEY`, or `PUBLIC_DASHBOARD=true` if the repo is public. Redeploy |
| `Set GITHUB_OWNER and GITHUB_REPO` | Add both in Vercel settings, then **redeploy** |
| `404` from GitHub | The owner/repo names are wrong, or the repo is private and `GITHUB_TOKEN` is missing |
| Every job says **UNKNOWN** | No routines snapshot in your repo. Run `/routines` in Claude Code, commit, push |
| The snapshot banner says it is stale | Exactly what it means. Run `/routines` again and commit |
| A job says **DECLARED** | Its file claims a schedule and no routine backs it. Run `/arm` |
| A job says **UNAPPROVED** | Something is firing that your files say is off. It is spending runs nobody approved |
| **No hero number yet** | Your `tiles.yml` names a metric nothing computes, or your ledger has no hours in it. The sentence says which |
| Run buttons do nothing | `FIRE_TRIGGERS` is unset, or that job has no `fire: true` in its trigger block |
| Add task, New workflow, Arm or Approve answer "No \"task-intake\" routine is registered" | Those four dispatch to one dedicated routine rather than to a job, so `task-intake` needs its own entry in `FIRE_TRIGGERS`. It is not a workflow slug and wiring every workflow does not supply it |
| The board looks empty but the repo is fine | Check the branch. `GITHUB_BRANCH` defaults to `main` |
| **Make it yours** says personalising is off, after you made a store | You did not redeploy. A new deployment is the only one that sees the store |
| "This picture store is public…" | The store was made **Public**, and that cannot be changed. Create a new **Private** store, connect it to this project, disconnect the public one, redeploy |
| "…all the changes it allows today" or "…all the pictures it allows today" | The daily cap is reached. It starts again at midnight UTC, or raise `WRITE_DAILY_CAP` / `GENERATE_DAILY_CAP` and redeploy |
| "OpenAI would not make that picture…" | OpenAI's safety rules refused the description. Describe it differently. Nothing was stored |
| **Make it** is missing, with a sentence about `OPENAI_API_KEY` | Set `OPENAI_API_KEY` in Vercel and redeploy. Choosing your own picture works without it |
| An iPhone photo "could not be opened here" | It is a HEIC photo and this browser cannot read those. Save it as a JPEG first (or take a screenshot of it), then choose that |
| The board keeps asking for the edit key | The key typed is not the `EDIT_KEY` set in Vercel. A wrong key is never kept |

---

## What it will never do

- **Write to your repo.** Every button is a *dispatch*: an agent session makes the change and
  commits it. A broken board cannot corrupt your team. Its only write power is over its own picture
  store - names and pictures, nothing else
- **Send anything.** It has no email, no publishing, no outbound anything. The one exception is
  yours to switch on: with `OPENAI_API_KEY` set, **Make it** sends the description you typed to OpenAI
- **Show you somebody else's data.** It reads one repo, the one you named
- **Guess.** Where it does not know, it says it does not know

---

## Under the hood

One serverless function reads your repo through the GitHub API and returns a single JSON payload;
the page renders it. There is no database, no build step, and no framework.

The arming logic mirrors `scripts/lib/arm.mjs` in the team repo rather than importing it — there is
no import path between a student's repo and a deployed app. `tests/routines.test.mjs` pins the two
to the same answers, because mirroring means drift, and drift is what a test is for.

---

Built by [Nuno Tavares](https://github.com/AutomatedMarketer) for the V-C Ink Level 2 bootcamp.
