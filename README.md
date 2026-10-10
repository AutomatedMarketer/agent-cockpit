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
| **Connections** | What you proved works, what each of your computers has set up, and every runtime in `runtimes.yml` — alive or silent, from its own heartbeat |
| **Hermes** | Only if you run Hermes: whether it is up, its version, and each profile's model, skills and week — plus how to open it from your phone |

### Hermes

If a computer of yours runs Hermes, a **Hermes** card sits at the top of Connections and a
**Hermes** page appears in the sidebar. Without Hermes you never see either. The card reads
`.agent-team/status/hermes/`, which `/snapshot` (or the collector on your always-on computer)
writes.

| Word on the card | What it means |
|---|---|
| **Running** | At the last check, Hermes's gateway or one of its schedulers had stamped its own file within five minutes |
| **Down at last check** | Neither had. Open Hermes and ask it for a health check (the Hermes page has the words to paste) |
| **Not checked for 9 h** | The reading is over 8 hours old, so the board will not say up or down. Run `/snapshot`, or check the collector |
| **update available** | Hermes's own update check says a newer version is out |

The Hermes page has three cards to copy from, for a Mac and for Windows: opening Hermes's own
dashboard from your phone over Tailscale, a health-check question for Hermes, and the checks to
run when Hermes is missing from the board. Its **Open Hermes** button opens the `url` of the
Hermes entry in `runtimes.yml`; give that entry `stale_after_minutes: 200`, because its heartbeat
is written every three hours.

### The Connections wall

Between your proved connections and your machines, **Found on your computers** shows what each
computer reported in its last `/snapshot`: its installed tools and their versions, the servers
Claude Code can reach (your own, plugin servers and claude.ai connectors), and Codex's servers and
plugins. It reads `.agent-team/status/connections/`, one file per computer, newest first, three at
most.

| Word on the wall | What it means |
|---|---|
| **Connected** | The server answered the live check |
| **Needs sign-in** | Grey on purpose: the server wants you to log in. Some you leave signed out, and that is fine |
| **Failed** | Amber: the server did not answer. Type `/mcp` in Claude Code to see why |
| **Waiting for approval**, **Not checked**, **Seen before** | Claude Code is waiting for your yes; the live check did not run; a claude.ai connector used before and not checked this time |
| **Found** / **Turned off** | A Codex server or plugin that is set up, or set up and switched off |
| **Proved** | Only when `connections/register.yml` has the same name (or slug) with a date and a proof. Same means the whole name, ignoring capitals and spaces at the ends: `Gmail` matches the connector `claude.ai Gmail`, but a plugin server needs its full `plugin:<plugin>:<server>` name. Found is never proved |
| **Checked more than 8 hours ago** | The list is old. Run `/snapshot` on that computer, or check its collector |

Servers set up for one project folder are counted, never named. A name that looks like a key, an
address or a path is never shown; the wall says how many it left out.

### Writing an entry in `runtimes.yml`

| Field | What the board does with it |
|---|---|
| `url` | Becomes the **Open** link. Only a plain `http://` or `https://` address with no username or password in it is kept. Anything else (`javascript:`, `data:`, `file:`, a made-up string) is dropped: the runtime still shows, just without a link |
| `heartbeat` | The file the runtime writes on a schedule. Fresh means **Live**, older means **Silent** |
| `stale_after_minutes` | Optional. How old that heartbeat may get before the runtime shows **Silent**. A whole number from **5** to **1440**. Leave it out and it is **30**. `200`, `"200"` and `200 # every 3 hours` all work. Anything else - words, a decimal, a number out of range - is not understood: 30 is used, and the runtime's row says *stale_after_minutes not understood, using 30 min* |

A runtime whose schedule runs every few hours needs this, or it will look silent between runs.

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
| **From Claude Code** | Claude's figure comes from Claude Code's own status line on that computer, data Anthropic documents, saved by a small script there. The official source |
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

**Your assistant's name** is the name the voice assistant answers to - see
[Talk to your board](#talk-to-your-board). With none, it is "your assistant".

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

## Talk to your board

Tap the round button at the bottom right - on any screen, on your phone or a laptop - and ask. *"What
is due today?"*, *"How's the team?"*, *"Open connections"*, *"How much Claude have I used?"* It answers
out loud from what the board already shows, and you can talk over it to stop it.

| | |
|---|---|
| **What it can do** | Read the board to you: who is working, what is due and gone quiet, the task board, plan limits and voice spend, your connections and Hermes. Open a screen |
| **What it cannot do yet** | Run a job, add a task or change anything. Ask and it says to use the Run button. When it can (Phase 11, not built yet), you will confirm each one yourself, on a card - never its own words, or anything it read. If a spoken yes is ever allowed, it will count only while no reply is playing and the microphone was open, so the assistant's own voice can never say yes for you |
| **Its name** | The assistant's name from **Make it yours**, or "your assistant" |
| **Its voice** | OpenAI's own voice by default. Fish, for a voice you choose, is an optional upgrade (below) |
| **While you talk** | The panel above the button shows your words as it hears them, what it is looking up (*Checking what's due…*), what it is saying, and what this conversation has cost so far. The orb glows with its voice as it speaks, unless your device asks for less motion |
| **It hangs up** | After 2 minutes with nobody talking (`VOICE_IDLE_MINUTES`), when you tap **Stop** or press Esc, or when you leave the tab |

### Switch it on

Set `OPENAI_API_KEY` in Vercel - the same key **Make it** uses - and redeploy. The button appears. On
a board open to everyone (`PUBLIC_DASHBOARD=true`) voice also needs `EDIT_KEY`, or anyone with the
address could spend your OpenAI money. Voice does **not** need the picture store.

The first tap asks your browser for the microphone. If you said no by mistake: on an iPhone,
**Settings → Safari → Microphone**; in Chrome, tap the icon left of the address.

### Speakers or headphones

On a computer the board starts in **speakers mode**: while the assistant talks, the microphone rests,
so it cannot hear its own voice coming back out of the speakers and answer itself. To interrupt it,
tap the orb, press Esc or press Space; it stops and listens at once. **Stop** still ends the call.

Why: on some computers the browser cannot cancel the echo. Sound routed through a virtual or mixing
setup - Elgato Wave Link is one - goes out to the speakers by a path the browser's echo canceller
never sees, so the assistant hears itself and replies to it.

On headphones, press **I'm on headphones** in the panel: then you simply talk over it to interrupt.
The board remembers that on this device. Phones always work that way.

### Set a hard spend limit on your OpenAI project - do this first

**The board does not cap voice.** There is no daily limit; there is a meter (below). What stops the
spending is a **hard spend limit** on the OpenAI project that holds `OPENAI_API_KEY`:

1. platform.openai.com → your project → **Settings** → **Limits**
2. **Spend** → **Edit spend limit** → a monthly amount you are happy to lose
3. Turn on **hard-limit enforcement** → **Save**
4. Add an alert a little below it too, so you hear first

**An alert alone does not stop anything** - it only emails you. With the hard limit on, OpenAI
refuses new requests once it is reached, and the board says *"OpenAI's spending limit for this key is
reached, so voice is off until next month or until you raise it."* OpenAI's own docs say the limit is
**not instantaneous**, so spending can go slightly over it, and they do not say what happens to a call
already running when it trips. If your dashboard has no hard-limit switch, keep voice off until you
have another way to cap that key.

### What it costs, and the meter

You pay OpenAI for each conversation by how much sound goes in and out (OpenAI counts it in tokens) -
and every reply re-reads the whole conversation so far, so a long talk costs more per minute than a
short one. Hang up when you
are done (it does after 2 minutes of nobody talking anyway).

The **Voice spend** card on Today, under Plan limits and Subscriptions, shows this month's total, how
many conversations, and the last one. It is an **estimate**, and says so: OpenAI's own token counts
for each reply, times the prices the board keeps in one table (`api/_voice-prices.js`, each price
with the page and date it was read from). **Your bill is at platform.openai.com.**

- A price the board has no source for is never counted as $0: the card says **Incomplete** and names it
- Each conversation is counted on your device as it happens, and recorded by the board once, when it
  ends - or the next time the board opens, if the tab closed first. Nothing is lost if a tab dies
- The board records voice in the picture store's own file, using **only the writes the picture caps
  leave over** (5 a day at the defaults). When those are used, conversations wait on the device and
  ride along with the next one, and the card says how many are waiting. Your pictures and names are
  never short of writes because of voice
- **No picture store:** voice still works, and the meter shows this device's total only
- Conversations still on your device are in the total too. If a report reaches the board but its answer
  is lost on the way back, that conversation can be counted twice until the next report clears it
- The meter is a meter, not a guard: anyone holding your keys could send it made-up counts. The hard
  spend limit is the guard

### Fish, for a voice you choose (optional)

Fish Audio can speak the answers in a voice you pick from its library.

1. A Fish account → **API key** → set it as `FISH_API_KEY` in Vercel (**Production** and **Preview**,
   marked sensitive)
2. Pick a voice on fish.audio → the 32 letters and numbers in its address → `FISH_VOICE_ID`
3. Redeploy. **Make it yours** says *"Speaking with your Fish voice."*

**What to know first:**

- The board uses Fish's **free model, `s2.1-pro-free`**, unless you set `FISH_MODEL=s2.1-pro` exactly.
  Fish bills a request that does not name the free model as the paid one, so the board names it on
  every request
- The free model is free **until 30 November 2026**, under fair use, and **Fish may use what you send
  it to train its model**
- Free-plan voices are for **personal use only**. Using one for a business needs a paid Fish plan
- With Fish, OpenAI answers in text and Fish speaks it, a sentence at a time, so the first words can
  take a moment longer

### What goes where

| What | Goes to | Why |
|---|---|---|
| Your voice, and what the assistant says back | **OpenAI**, straight from your browser | It hears you and answers. The call is started by the board's server, which adds the key - **no key ever reaches your browser** |
| The board's answers to its questions (who is working, what is due, your plan limits) | **OpenAI** | So it can read them to you |
| Your device's time zone, and the names on the board (the assistant's, yours, your agents') | **OpenAI** | So every time is said in your own time, never UTC, and the names are heard right |
| The words of each answer, with Fish on | **Fish** | So it can speak them. Its free model may train on them |
| Each conversation's token counts | **The board's picture store** | The meter |

Everything else stays where it was. The page's security policy did not change: the call itself is
browser-to-OpenAI audio, and the page only ever talks to its own site.

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
| `OPENAI_API_KEY` | Your OpenAI key, for **Make it** and for [talking to the board](#talk-to-your-board). **Set a hard spend limit on its project first** | For pictures from words and voice |
| `OPENAI_IMAGE_MODEL` | The image model. Leave unset for `gpt-image-1-mini` | No |
| `OPENAI_REALTIME_MODEL` | The voice model: `gpt-realtime-2.1-mini` (the default) or `gpt-realtime-2.1`. Anything else turns voice off and says why | No |
| `OPENAI_VOICE` | OpenAI's voice: `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`, `marin` (the default) or `cedar` | No |
| `VOICE_IDLE_MINUTES` | Minutes with nobody talking before a call hangs up, 1 to 10. Default `2` | No |
| `VOICE_CAPTIONS` | `off` to stop showing what it heard you say. On a computer it is still transcribed, and paid for, while `VOICE_ECHO_GUARD` is on, because the guard reads it. On unless set | No |
| `VOICE_LANGUAGE` | The language you speak, as a two-letter code (`pt`, `fr`), for the transcript of what you say (the captions, and the echo guard's): OpenAI says giving it makes the transcript more accurate and quicker. `auto` lets it guess. `en` unless set | No |
| `VOICE_ECHO_GUARD` | On a computer, a turn of one or two words in the first 1.5 seconds of a reply is treated as the assistant's own voice coming back through the speakers: it is ignored and the reply resumes (once per question). So to stop it right at the start, use **Stop** or Esc rather than saying "stop". The guard reads a transcript of what it hears, so on a computer that is on with it, captions or not: about $0.002 a minute of your talking (gpt-4o-mini-transcribe: 600 audio tokens a minute at $1.25 a million, plus the words at $5 a million). Phones never use the guard. Phones do not pay it unless captions are on. `off` to switch it off. On unless set | No |
| `VOICE_VAD_THRESHOLD` | How loud a sound must be to count as you talking, `0.1` to `0.95`. Default `0.6` - a little above OpenAI's example, because a computer on speakers heard its own voice as you talking. Raise it if it keeps cutting itself off; lower it if it misses you | No |
| `FISH_API_KEY` | Your Fish Audio key, for a voice you choose. Mark it sensitive | For Fish |
| `FISH_VOICE_ID` | The 32 letters and numbers in the voice's address on fish.audio | For Fish |
| `FISH_MODEL` | Leave unset for Fish's free `s2.1-pro-free`. Only `s2.1-pro`, exactly, uses the paid model | No |
| `EDIT_KEY` | A password for changing names and pictures, sent as `x-edit-key`. **Required if `PUBLIC_DASHBOARD=true`** - for changes, and for voice | If public |
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

1322 tests, nothing to install to run them. They cover the data logic, the fire endpoint's auth, and —
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
| You run Hermes and there is no Hermes card | No file in `.agent-team/status/hermes/` that found Hermes. Run `/snapshot` on the computer that runs it; the Hermes page's **Hermes is not on my board** card has the full checks |
| Connections says **Nothing found yet** | No file in `.agent-team/status/connections/`. Run `/snapshot` in Claude Code on each computer you use |
| The wall says a connections file **could not be used** | It is damaged, dated in the future, over 64 KB, written by a collector this board does not know, or GitHub would not return it. Run `/snapshot` again |
| A server you know you have is missing from the wall | Its name did not read as a plain name (the wall counts those), it belongs to one project folder (counted, not named), or the list stopped at its cap |
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
| There is no round button at the bottom right | Voice is off: `OPENAI_API_KEY` is not set, the board is open to everyone with no `EDIT_KEY`, or `OPENAI_REALTIME_MODEL` or `OPENAI_VOICE` names something the board does not know. With a picture store, **Make it yours** says which. Redeploy after fixing |
| The button is grey: "This browser cannot use a microphone…" | This browser gives the page no microphone or no WebRTC. Use Safari on an iPhone, or Chrome |
| "The microphone is blocked for this board…" | You said no to the microphone. iPhone: **Settings → Safari → Microphone**. Chrome: the icon left of the address. Then tap again |
| "OpenAI's spending limit for this key is reached…" | Your hard spend limit did its job. Raise it on platform.openai.com, or wait for next month |
| "OpenAI did not accept OPENAI_API_KEY for voice…" | The key is wrong, or its project cannot use the realtime models. Check both in OpenAI, then in Vercel, and redeploy |
| It stops talking as if you had interrupted, when you had not, or answers words nobody said | Its own voice reached the microphone. Turn the volume down or use headphones, or raise `VOICE_VAD_THRESHOLD` (say `0.7`) and redeploy |
| Voice spend says **Incomplete** | A price the board has no source for yet. The total is lower than the truth; your bill at platform.openai.com is the real number |
| Voice spend says conversations are **not recorded yet** | The board used today's spare store writes. They are kept on this device and recorded with your next conversation |
| "The voice meter's file in the picture store is damaged…" | Vercel → **Storage** → your store → delete `agent-cockpit/voice-meter.json`. The meter starts again; nothing else is touched |
| With Fish on, some sentences are not spoken | Fish did not answer in time for that piece, so it was skipped; its words are still in the panel. If none are spoken, check `FISH_API_KEY` and `FISH_VOICE_ID` |

---

## What it will never do

- **Write to your repo.** Every button is a *dispatch*: an agent session makes the change and
  commits it. A broken board cannot corrupt your team. Its only write power is over its own picture
  store - names and pictures, nothing else
- **Send anything you did not ask it to.** It has no email and no publishing. What does leave is yours
  to switch on, with `OPENAI_API_KEY`: **Make it** sends the description you typed to OpenAI, and
  **talking to the board** sends your voice, and the board's answers to its questions, to OpenAI -
  plus, with Fish on, the words of each answer to Fish, whose free model may train on them. See
  [What goes where](#what-goes-where)
- **Put a key on the page.** The OpenAI and Fish keys stay on the server. A voice call is started by
  the board's own function, which adds the key; not even a short-lived key reaches your browser
- **Cap your voice spending for you.** It meters it, as an estimate. The hard spend limit on your OpenAI
  project is what stops it
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

The Connections wall is the same again. `tests/fixtures/connections-parity.json` is its contract,
byte for byte the collector's, and `tests/found.test.mjs` checks that the board turns the contract's
sample into exactly the shape the contract says, keeps every name it says to keep and drops every
name it says to refuse. A server's address, command and settings are never read, even when somebody
writes them into the file, and **Proved** comes only from `connections/register.yml`, never from
what a computer found.

The Hermes card too: `tests/fixtures/hermes-parity.json` is shared byte for byte, and
`tests/hermes.test.mjs` runs every one of its worked examples. The board decides **Running** or
**Down** itself, from the times in the file: Hermes's gateway or one of its schedulers stamped its own
file within five minutes of the check. A yes/no flag in the file is never read, and nothing Hermes
keeps beside the fields read - its command line, its addresses, chat titles, memory - can reach the
page.

Voice is OpenAI's "unified" call: the page makes a WebRTC offer and sends it to `/api/voice-session`
on its own site; that function adds the key and the whole session (model, instructions, the six
read-only tools, when it decides you stopped talking) and passes the offer to OpenAI; OpenAI's answer
comes back the same way, and from then on the sound and the events go straight between the browser
and OpenAI. So the page's Content-Security-Policy is exactly what it was: `connect-src 'self'`, and the
call's sound is WebRTC, which that does not govern. Every voice answer from the board is
`Cache-Control: private, no-store`. A signed ticket ties the later Fish requests and meter reports to
a session the board opened. The helpers the page runs live in `api/_voice.js` too, word for word, and
`tests/voice-client.test.mjs` holds the two copies together.

To see how long a reply takes to start, open the board on `localhost`, or set
`agent-cockpit-voice-debug` to `on` in the browser's local storage: after each turn the console logs
"voice: first sound N ms after the person stopped talking". Only that number and which voice spoke -
never anything said.

---

Built by [Nuno Tavares](https://github.com/AutomatedMarketer) for the V-C Ink Level 2 bootcamp.
