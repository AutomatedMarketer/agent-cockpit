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
| **Today** | What happened, what is next, what has gone quiet, how much of your plans is used — plus one-tap Run buttons |
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

**Plan limits**, directly under the three numbers, show how much of your Claude and Codex plans is
used: a ring per limit (the 5-hour one, the weekly one, a one-model weekly one when your plan has
it), the time each one resets in your own time zone, and which computer the reading came from.

| What you see | What it means |
|---|---|
| **unofficial** | Claude's figure comes from an address Anthropic does not document. It can change without notice; if it stops answering, the card says *unavailable* rather than guessing |
| **from Codex's own log** | Codex's figure is the last limit Codex itself recorded on that computer |
| **estimate** | Replies and sessions over 7 days, counted from Claude Code's logs. A count, never a percentage |
| **Reset since this reading** | That limit has reset since the reading was taken, so its old percentage is not shown |
| **Reset time unknown** | The reading came with no reset time, which Claude does for a limit that has not started yet. The percentage is still a real reading |
| **older than 8 hours** | The reading is stale. Run `/snapshot`, or check the collector on that computer |
| **Reading from 5 hr ago, collected 1 min ago** | The file is new but the figures in it are older: a saved copy, or the last limit Codex logged. The age and the stale warning go by when the figures were read |

The board never reaches your accounts. The readings come from files a collector on your always-on
computer commits to `.agent-team/status/usage/` (one file per computer). The board reads up to five
of them, re-checks every name and number itself, and shows the freshest real reading. No file means
*"No usage reading yet"*, never a zero.

**Subscriptions**, in the Usage section at the bottom of Today, list what you pay, from
`subscriptions:` in your `stack.yml` (`/onboard` asks, or add them by hand):

```yaml
subscriptions:
  - name: Claude Max
    service: claude
    price: 200
    currency: USD
    per: month
```

| Rule | Why |
|---|---|
| One total per currency, **never converted** | There is no exchange rate the board could honestly use |
| A yearly price is shown a month, and says so | So every line is in the same unit as the total |
| A line with no price is listed and **left out of the total** | Counting it as nothing would say it is free |
| A line that disagrees with the plan the usage reading found is pointed out | `Claude Pro` written down while the reading says `Max 20x` is worth a look |

---

## Make it yours

Rename your agents, put in your own pictures, and choose the art style new pictures are made in -
all from the board itself, on a phone or a laptop, and it shows at once.

| Where | What you can change |
|---|---|
| **Each Team card** (tap it open, then **Personalise**) | The name on the card, **Choose a picture**, **Describe it** then **Make it**, and **Back to the default** |
| **The Today and Team banners** (the small **Personalise** button) | The banner picture: choose one, make one, or go back to the default |
| **Make it yours** (in the Team banner) | Your assistant's name, and the art style every picture made from words follows. The default style is shown, with **Back to the default** |

**Your assistant's name is kept, but nothing uses it yet.** It is saved now so the voice assistant
can answer to it when that arrives; until then it changes nothing on the board.

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
- **Daily caps:** at most 10 pictures from words and 20 changes of any kind a day (names, uploads,
  resets). The counts start again at **midnight UTC**. You can lower them with `GENERATE_DAILY_CAP`
  and `WRITE_DAILY_CAP` (`0` switches that kind of change off). You can only raise them a little:
  they are held under the picture store's monthly limit, below
- **Making a picture holds one of today's changes** for the upload that keeps it, so two **Make it**
  at once with one change left cannot both pay OpenAI. The held change shows as used. If the picture
  is never kept (the tab closed), the change is free again after 10 minutes
- **What leaves the board:** only the description you typed and your art style, sent to OpenAI

### The picture store's free limit, and why the caps are where they are

The picture store is Vercel Blob. On Vercel's free **Hobby** plan it includes, each month
([Vercel Blob pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing), checked 6 October 2026):

| | Hobby includes | What uses it on this board |
|---|---|---|
| **Advanced operations** | **2,000** a month | Every write: a name, the style, a picture. Browsing the store in Vercel's dashboard counts too |
| **Simple operations** | **10,000** a month | A read the cache could not answer |

**Go over either one and Vercel locks the store for 30 days.** Vercel's words: you "will not be able to
access Vercel Blob" until 30 days have passed. Personalising then switches off and the board shows its
built-in pictures and slugs. Nothing else breaks.

So the board keeps to a budget of **55 writes a day** at most - 1,705 in the longest month - and leaves
the rest of the 2,000 for retries and for you looking at the store in Vercel:

- A change costs at most **2 writes** (an upload is the picture plus the settings file). A picture
  from words costs **1** (the write that counts it); storing it is then a change
- The rule is `2 × WRITE_DAILY_CAP + GENERATE_DAILY_CAP ≤ 55`. Ask for more and the board uses less:
  changes first, up to 27 a day, and pictures from words get whatever is left
- The defaults, 20 changes and 10 pictures from words, are 50 a day
- The Blob library retries a failed write up to 10 times on its own, and a retry can count. Set
  `VERCEL_BLOB_RETRIES=2` in Vercel to keep that small
- **The budget does not cover changes from many devices at the same moment.** Vercel may run several
  copies of the board at once, and two copies saving together collide: the loser tries once more after
  a short random pause, and every attempt counts as a write. A burst costs at most
  `2 × changes saved + (copies running − 1) × changes saved` writes; in a test of 200 uploads at once
  over 10 copies, 20 were saved for 80 writes. One person using one screen never collides. Fixing
  this fully would need a counter outside the picture store
- **Showing the board reads the cached copy, which is free.** Each running copy of the board also
  remembers what it last read for 30 seconds, so a burst of page loads costs one read. A change made
  on one screen can take up to about a minute and a half to show on another (the screen that made it
  shows it at once). The copy is refreshed at most about once a minute while someone is looking, and
  each refresh is one simple operation. An open board (`PUBLIC_DASHBOARD=true`) that strangers load
  nonstop, all month, could still use the 10,000 that way - keep a board closed with `VIEW_KEY` if
  that worries you
- **A new store has no settings file until your first change creates it.** Looking at the board never
  writes anything, so nobody can spend the store's writes just by visiting

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
| `WRITE_DAILY_CAP` | Changes a day (names, uploads, resets). Default `20`, at most `27`. Held under [the store's free limit](#the-picture-stores-free-limit-and-why-the-caps-are-where-they-are) | No |
| `GENERATE_DAILY_CAP` | Pictures from words a day. Default `10`. Gets whatever the changes leave of the same limit | No |
| `VERCEL_BLOB_RETRIES` | How often the Blob library retries a failed write. Its own default is `10`; set `2`, because a retry can count against the store's free limit | Recommended |

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

938 tests, nothing to install to run them. They cover the data logic, the fire endpoint's auth, and —
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
| Plan limits says **No usage reading yet** | No file in `.agent-team/status/usage/`. Run `/snapshot` in Claude Code, or set up the collector on your always-on computer |
| Plan limits says a reading is **older than 8 hours** | The collector has missed at least two runs. Check it on the computer the card names, or run `/snapshot` |
| A card says its limits were **unavailable** | The collector could not get a reading it trusted. The **Why?** under it gives the collector's reason |
| Plan limits says a usage file **could not be used** | It is damaged, dated in the future, over 64 KB, written by a collector this board does not know, or GitHub would not return it. Run the collector again |
| Plan limits says more usage files **were not read** | The board reads the first five files in `.agent-team/status/usage/`, one per computer. Delete the files of computers you no longer use |
| A subscription is **left out of the total** | It needs a `price` like `20` or `19.99`, a three-letter `currency` like `USD`, and `per: month` or `per: year` |
| A job says **DECLARED** | Its file claims a schedule and no routine backs it. Run `/arm` |
| A job says **UNAPPROVED** | Something is firing that your files say is off. It is spending runs nobody approved |
| **No hero number yet** | Your `tiles.yml` names a metric nothing computes, or your ledger has no hours in it. The sentence says which |
| Run buttons do nothing | `FIRE_TRIGGERS` is unset, or that job has no `fire: true` in its trigger block |
| Add task, New workflow, Arm or Approve answer "No \"task-intake\" routine is registered" | Those four dispatch to one dedicated routine rather than to a job, so `task-intake` needs its own entry in `FIRE_TRIGGERS`. It is not a workflow slug and wiring every workflow does not supply it |
| The board looks empty but the repo is fine | Check the branch. `GITHUB_BRANCH` defaults to `main` |
| **Make it yours** says personalising is off, after you made a store | You did not redeploy. A new deployment is the only one that sees the store |
| "This picture store is public…" | The store was made **Public**, and that cannot be changed. Create a new **Private** store, connect it to this project, disconnect the public one, redeploy |
| "The board's settings file in the picture store is damaged or too big…" | The file holding the names, the style and which pictures are in use cannot be read, so the board left it alone rather than write over it. To start again from the defaults: Vercel → **Storage** → your store → delete `agent-cockpit/settings.json`. The pictures stay in the store but are no longer shown; put them back from the board |
| "This board keeps names for up to 64 agents…" (or pictures) | Clear a name you no longer use (save it empty), or put an unused agent's picture back to the default, then try again |
| **Make it** is greyed out: "No changes are left today…" | A made picture is kept by an upload, which is a change, and today's are used up. It comes back at midnight UTC. Nothing was sent to OpenAI |
| "…all the changes it allows today" or "…all the pictures from words it allows today" | The daily cap is reached, and it starts again at midnight UTC. Raising it is not the fix: the caps keep the picture store under [Vercel's free limit](#the-picture-stores-free-limit-and-why-the-caps-are-where-they-are), and going over that locks the store for 30 days |
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

The usage readings work the same way. `tests/fixtures/usage-parity.json` is the shared contract
with the collector in the team repo — the same bytes in both repos — and `tests/usage.test.mjs`
holds the board to it. The board does not trust the collector's own safety check: it builds its
answer only from the fields it knows, and a test plants fake tokens, emails and paths in every field
of a usage file to prove none of them reaches the page.

---

Built by [Nuno Tavares](https://github.com/AutomatedMarketer) for the V-C Ink Level 2 bootcamp.
