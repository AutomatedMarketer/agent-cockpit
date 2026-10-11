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

## The screens

| Screen | The question it answers |
|---|---|
| **Today** | What happened, what is next, what has gone quiet, how much of your plans is used — plus one-tap Run buttons |
| **Ledger** | What your week costs, what was proposed for it, and what nothing on the team can do |
| **Team** | Every agent: model, last run, and whether it is working, quiet or never run |
| **Workflows** | Every job, and whether it is **armed, declared, unapproved or off** |
| **Readiness** | Every scheduled job on one wall, one light each, **NO GO first**: your team's workflows, the jobs on your Mac, and Hermes's own |
| **Skills** | What this team can actually do, and which jobs use each skill |
| **Memory** | Your notes as a list or a **graph** - every note a dot, every reason two notes belong together a line - with search by name, and inside each page once the graph is read |
| **Connections** | What you proved works, what each of your computers has set up, and every runtime in `runtimes.yml` — alive or silent, from its own heartbeat |
| **Hermes** | Only if you run Hermes: whether it is up, its version, and each profile's model, skills and week — plus how to open it from your phone |

### Flight readiness

One card per scheduled job, grouped **NO GO**, then **SILENT**, then **GO**. The tab's number is NO GO
plus SILENT, and is blank when there are none. On a phone it is one column with the trouble first;
on a laptop it is a grid. Each card has a light that is a different *shape* as well as colour (a
dot, a hollow ring, a dot inside a ring), the status as a word, the job's name, one sentence about
why, when it runs, when it last reported, and a small grey line saying where it comes from. That
grey line is **not** the id `jobs.yml` uses; the table below turns one into the other.

| Word | What it means |
|---|---|
| **NO GO** | Something is wrong that will not fix itself: it is marked on but nothing fires it, it is installed but not switched on in the Mac's scheduler, a service was not running, or its last run failed and is recent enough to be the one that matters |
| **SILENT** | The board cannot vouch for it: it has never reported, it missed its last two scheduled times, the routine list is not fresh, or the Mac's reading is over 8 hours old |
| **GO** | It reported clean on its own schedule, or it is a service and it was running when the Mac checked |
| **RUNNING** | A service that was up. For the Mac programs that keep their own clock, that is all it proves, and the card says so: *whether its last report was written is checked on the Mac control center, not here* |
| **faded** | Dashed outline and one extra sentence: its last report is older than its newest scheduled time but covers the one before. Never colour alone |
| **Switched off** | Listed underneath, with the reason: not armed, owner switched off, started only by a button or a webhook, turned off in the Mac's scheduler or in Hermes, or hidden by you |

How late is decided by counting **scheduled times**, not minutes since the last run: a job is on time
if its last report covers its newest scheduled time (30 minutes of grace, and a report up to 5 minutes
early counts), faded if it covers only the one before, silent if it covers neither. So a weekday job
is not silent on a Saturday. The Workflows screen's *Gone quiet* uses the same count.

Times are in your own time zone. A team workflow's schedule (a routine runs in UTC) is converted for
you, and can move the day as well as the hour; a Mac job's schedule is on the Mac's own clock and
says *(Mac time)*.

The Mac and Hermes rows come from `.agent-team/status/jobs/`, which the collector on your always-on
Mac writes with everything else (names, schedules, times, exit codes - never arguments, prompts,
logs or error text). A Hermes job is shown as `Hermes job <id>` (its 12-character id), because
Hermes copies the start of a job's prompt into the name of a job nobody named. Name it yourself:
ask Claude *"call the Hermes job a1b2c3d4e5f6 'YouTube morning brief'"* and it writes `jobs.yml` in
your team repo. The same file renames or hides anything else on the wall. Each entry needs the job's
**id**, which is built from the card's grey line like this:

| The card's grey line | Its id in `jobs.yml` |
|---|---|
| `Mac Mini · com.donna.blog-watch` (a Mac LaunchAgent) | `launchd:com.donna.blog-watch` |
| `Mac Mini · Hermes · donna · f4f4c62f0a39` (a Hermes job) | `hermes:donna/f4f4c62f0a39` |
| `Team repo · daily-brief` (a workflow) | `workflow:daily-brief` |
| `Account routine · Morning intel` (a routine with no workflow file) | `routine:Morning intel` |

```yaml
jobs:
  - id: hermes:donna/f4f4c62f0a39
    name: Memory review
  - id: launchd:com.example.old-backup
    hide: true
```

**An entry the board cannot use is skipped without a word on the wall.** That is: an id not in one of
the four shapes above, or not matching the grey line letter for letter (a capital, a space instead of
the colon); the same id twice; a name the board will not print (one that looks like a key, an address
or a path); a comment after a value on the same line (`hide: true  # old job` is read as the words
"true  # old job", so the job is not hidden); and anything past the first 200 entries. If a rename or
a hide does not show after the next read, check that entry first. The board only reads the file, and
it cannot bring back a job the safety rule kept off (the wall says how many it did); rename that job
where it is made.

**Refresh.** While the Readiness screen is showing and the browser tab is in front, the board checks
every 60 seconds whether your repo has a new commit. That check is **one call to GitHub**; if nothing
changed, the page only re-checks how old each light has become. A full read is about sixty calls and
nothing is cached, so reading everything every minute on two devices would pass GitHub's 5,000 calls
an hour. The **Refresh** button is the same check, pressed. A check that fails slows the watch down
(2 minutes, then 4, then 8, never more than 15) and the line above the lights says so; if GitHub says
it is rate limiting, the board passes on how long to wait and the page waits at least that long. A
check that works puts it back to a minute. The Mac's own data still arrives every three hours with
the collector, and the line above the lights says when.

Not checked here: Windows Task Scheduler, n8n, Trigger.dev and Codex automations.

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

**Tiles and logos.** Every tool the board names has a small tile beside it: on the wall, in your
connections and runtimes, in Subscriptions, on the plan cards and in Voice spend.

| Tile | When |
|---|---|
| **Our own letter tile** | Every tool, by default: a soft wash of the tool's colour and its first letter. A colour is not a logo |
| **The real logo** | Only **GitHub** and **Vercel**, whose own rules let a site show that it uses them. Drawn from Simple Icons (CC0), unchanged, in plain white on dark or plain black on light |
| **A plain grey letter** | A name the board does not know |

Claude, Google, Node.js and Obsidian ask for approval before their logos are used, so they stay
letters. The rule for each brand, with the page it came from, is in
[`docs/logo-rules.md`](docs/logo-rules.md). To use your own logo files on your own board, add them to
`public/logos/` and to `BRANDS` in `public/app.js`.

> Product names and logos belong to their owners. They appear only to name the tools your own
> computer reports, and no endorsement is implied. Logo drawings from Simple Icons (CC0). Vercel, the Vercel design, Next.js and related marks, designs and logos are trademarks or registered trademarks of Vercel, Inc. or its affiliates in the US and other countries.

### Writing an entry in `runtimes.yml`

| Field | What the board does with it |
|---|---|
| `url` | Becomes the **Open** link. Only a plain `http://` or `https://` address with no username or password in it is kept. Anything else (`javascript:`, `data:`, `file:`, a made-up string) is dropped: the runtime still shows, just without a link |
| `heartbeat` | The file the runtime writes on a schedule. Fresh means **Live**, older means **Silent** |
| `stale_after_minutes` | Optional. How old that heartbeat may get before the runtime shows **Silent**. A whole number from **5** to **1440**. Leave it out and it is **30**. `200`, `"200"` and `200 # every 3 hours` all work. Anything else - words, a decimal, a number out of range - is not understood: 30 is used, and the runtime's row says *stale_after_minutes not understood, using 30 min* |

A runtime whose schedule runs every few hours needs this, or it will look silent between runs.

---

### The memory graph

**Memory → Graph** draws your notes as a picture: every note a dot, and every reason two notes belong
together a line. The board never draws a line it cannot name the reason for, so a repo whose notes do
not point at each other is a field of lonely dots - and that is worth seeing.

| Line | What draws it |
|---|---|
| **Link** | A wikilink or an embed: `[[Note]]`, `![[Note]]`, `[[folder/Note#heading\|alias]]`, found the way Obsidian finds them |
| **Mention** | A markdown link to a note, `[text](path.md)`, or a repo path written out in a note, such as `shared/about-me.md` - the way most team notes point at each other |
| **Agent** | A note in `agents/<name>/`, or a task card written `for: <name>`, and that agent's own file in `.claude/agents/` |
| **Same day** | Notes dated the same day - a date at the start of the file name, a folder named by a date, or `date:` / `created:` in the frontmatter - hang off one day dot |
| **Same tag** | Notes that share a `tags`, `project` or `people` value hang off one tag dot |

- **A lonely dot** (amber) is a note nothing links to and that links to nothing: a missing link. A note
  joined to others only by its day, a tag or its agent is still lonely. **Lonely only** shows just those.
- **Pick a dot** (tap, click, or the list under the graph) to see its name, where it lives, every line
  with its reason, and **Open** for a team note the board can open.
- **The legend** under the graph says what every dot, line and colour means. **Every dot, as a list**
  under it holds every dot and its lines, searchable - the way in for a keyboard or a screen reader.
- **3D or flat.** On a computer with a mouse or trackpad, WebGL, and no "reduce motion" setting, it is 3D
  and turns slowly until you take hold of it. On a phone, a slow device, or with reduce motion on, it is
  flat and still. **3D | Flat** switches, and this device remembers your choice.
- **What it costs.** Nothing with the board: the graph is read only when you open Memory, and its own
  drawing code (`/memory-graph.js`, about 10 KB) and a drawing library load only the first time you open **Graph** - the 3D library (about 345 KB) on a computer, the flat one (about 57 KB) on a phone. Reading the graph is one GitHub call per note, up to 400 notes (a note over
  64 KB is counted, not read); opening Memory again within a minute asks nothing, and after that one call
  checks whether anything changed.

**Your team repo** is always there. **Other Obsidian vaults** - your Second Brain, say - come from the
status collector on the computer that has them, in `.agent-team/status/vaults/`. A vault is read only if
that computer's own `allowed-vaults.yml` allows it **and** `vaults.yml` in your team repo names it; the
team repo can narrow what a computer allows, never widen it. The template's `.agent-team/status/README.md`
("How to choose which vaults") has the exact steps. Each vault is shared at one of two levels:

| Level | What reaches GitHub and this board | Never |
|---|---|---|
| **shape** (the default) | The vault's name, how many notes and lines, and anonymous dots joined by lines | Titles, folders, tags, dates, what a note says, where the vault is |
| **titles** (you choose it, per vault) | The same, plus each note's title, top folder and day, and day and tag dots - each held to a safety rule; a title that fails it stays an anonymous dot | What a note says, where the vault is |

A vault file older than seven days is shown as not updated since its time, never as the current graph.

**Search inside pages.** Once the graph has been read, the search box on **Memory → List** looks in each
team page's name, headings, description, tags and opening words, best match first, and each hit says where
it found the words. Only a page the board can open gives search its words; any other (an agent's file in
`.claude/`, a name with accents or brackets) is found by its name alone. It does not read every word of
every page; until the graph is there, it searches names, and says so.

## The look

The board opens **dark**, and there is a **light theme** too. The switch is in the top bar. It
remembers your choice **on that device only**. If you have never touched it, the board follows your
phone's or computer's own light/dark setting.

| Part | What to know |
|---|---|
| **Typeface** | Inter, served from this site (`public/fonts/`, with its OFL licence in `public/fonts/OFL.txt`). It is not loaded from Google, because the page's security header only allows its own files |
| **Pictures** | Every screen opens with its own picture: Today's harbour, Team's workshop, and a calm night scene for Ledger, Workflows, Readiness, Skills, Memory, Connections and Hermes. The sidebar and the sign-in page have one each, and there are eight agent portraits. All original art made for this board |
| **Your own agents** | An agent you add later gets a coloured tile with its initial until it has a picture |
| **Phone, tablet, laptop** | One column on a phone and a tablet. The grids (number cards, plan cards, team cards, the task board, the week) start at 1024 px wide |
| **Loading** | Before your repo has been read, Today shows grey blocks shaped like the screen that is coming, and a screen reader hears "Loading your board" |
| **Empty screens** | A screen with nothing on it yet is centred, with its own icon and the one thing to run |

**The built-in art** is what every copy of this board starts with. To change the pictures and names
on *your* board without touching code, see [Make it yours](#make-it-yours) below. To add a portrait
to the built-in art itself, do both of these:

1. Put a 480x480 `.webp` named `agent-<name>.webp` in `public/art/`
2. Add its name to the `PORTRAITS` list in `public/app.js`

The list is what decides. A file in `public/art/` that is not in the list is never shown.

**Kept light on purpose.** The tests refuse anything over these sizes, so a careless export cannot
slow the board down on a phone:

| File | Limit |
|---|---|
| A banner (Today, Team) | 100 KB |
| Any other screen's banner, and the sign-in picture | 90 KB |
| The sidebar's square picture | 40 KB |
| An agent portrait | 45 KB |
| All the pictures together | 1,100 KB |
| The typeface | 64 KB |

Only Today's banner loads straight away. Every other picture loads when you scroll to it or open
its screen, so the total is only ever paid by someone who opens every screen.

**Movement.** Screens fade in when you open them, cards you can press lift a little under a mouse,
buttons give when pressed, folds fade open, the voice orb breathes and ripples, and the banner
pictures drift very slowly. If your phone or computer is set to **reduce motion**, none of it
happens: every moving rule sits in one block at the end of the stylesheet that such a device never
applies, and each state still differs by its shape and its words. Nothing moves on the Readiness
cards themselves, because that screen redraws every minute.

**The design numbers** (spacing, type sizes and weights, corner radius, depth, how long each
movement takes) are tokens at the top of the stylesheet in `public/index.html`, beside the colours.
Change one there and the whole board follows. The colours stay navy and red in both themes.

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
- **Daily caps:** at most 10 pictures from words and 19 changes of any kind a day (names, uploads,
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
- Memory search by meaning saves what it learned at most **2 times a day** (its own file, counted inside it)
- The rule is `2 × WRITE_DAILY_CAP + GENERATE_DAILY_CAP + 2 ≤ 55`. Ask for more and the board uses less:
  changes first, up to 26 a day, and pictures from words get whatever is left
- The defaults, 19 changes and 10 pictures from words, are 48 a day; with meaning search's 2, 50. The
  voice meter uses the 5 left over
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

Anyone who can sign in (or holds the view key) can personalise the board - the store holds only pictures and names, and the
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
| **What it can do** | Read the board to you: who is working, what is due and gone quiet, the task board, plan limits and voice spend, your connections and Hermes. Open a screen. And, once the board's Run buttons are set up, send a task card to your team, run a job, and tell you "is it done?" - each only after you say yes on a card ([Orders by voice](#orders-by-voice)) |
| **Saying yes** | Only you can: a tap on the card's **Yes**, or - for a job run or a short task - your own plain spoken yes after the card appears. Its own words, or anything it read, can never say yes for you |
| **Its name** | The assistant's name from **Make it yours**, or "your assistant" |
| **Its voice** | OpenAI's own voice by default. Fish, for a voice you choose, is an optional upgrade (below) |
| **While you talk** | The panel above the button shows your words as it hears them, what it is looking up (*Checking what's due…*), what it is saying, and what this conversation has cost so far. The orb glows with its voice as it speaks, unless your device asks for less motion |
| **It hangs up** | After 2 minutes with nobody talking (`VOICE_IDLE_MINUTES`), when you tap **Stop**, when you press Esc while it is not answering (in speakers mode, Esc during a reply interrupts it instead; see below), or when you leave the tab |

### Switch it on

Set `OPENAI_API_KEY` in Vercel - the same key **Make it** uses - and redeploy. The button appears. On
a board open to everyone (`PUBLIC_DASHBOARD=true`) voice also needs `EDIT_KEY`, or anyone with the
address could spend your OpenAI money. Voice does **not** need the picture store.

The first tap asks your browser for the microphone. If you said no by mistake: on an iPhone,
**Settings → Safari → Microphone**; in Chrome, tap the icon left of the address.

### Orders by voice

Ask it to *"have the team draft this week's newsletter"* or *"run morning intel"*. It puts a card in
the panel that says exactly what will be sent - **Send to the team?** with the task's words, or **Run
Morning intel?** - and waits. Nothing goes anywhere until you say yes. Ask *"is it done?"* later: it
checks the board again and says running, finished, not filed yet, or that nothing has reported yet.

**Saying yes:**

- A tap on **Yes** always works (or Enter or Space on it). **No**, or Esc, closes the card and nothing
  is sent. So does a minute going by
- You can also just say *"yes"*. It counts only after the card appears, within 60 seconds,
  as a plain yes - *"yes"*, *"yeah, do it"*, *"go ahead"*, with nothing else in it - and only if
  the microphone was on for all of it, no reply was playing during it, and a moment of quiet came
  before it. Then it cannot be the assistant's own voice. Anything else - *"yes, but…"*, a yes over
  its voice - leaves the card up and asks for a tap. A plain *"no"* closes it
- A spoken yes approves
  only a job run, or a task card with a title of 80 characters or less and no details:
  those you heard in full. Anything else needs a tap, and the card says so:
  *"This one has details, so tap Yes to send it."*
- Yes waits a moment after a card appears or changes (when Jev picks who does it, say), so a tap meant
  for the card that was there cannot send the one that replaced it
- A spoken yes works only when sending needs no key typed in: the fire key is already in this tab
  (the first tap on a Run button asks for it), or the board uses `PUBLIC_FIRE`. The card says *"Or say
  yes"* only then
- The assistant can never say yes for you, and neither can anything it reads:
  never a tool, a page or an email
- `VOICE_SPOKEN_YES=off` makes it a tap only. A spoken yes needs a transcript of what you say, so with
  it on, the call asks for one even with captions off: about $0.002 a minute of your talking

A yes sends the order the way the board's own buttons do, through `/api/fire`: a task card lands in
`tasks/` about a minute later, made by your `task-intake` routine, and a run starts that job's
routine. The board still never writes to your repo.

**Switch them on.** Orders are off until the board's Run buttons are set up, and until then the
assistant says so, plainly:

1. In Claude Code on the web, create a routine called `task-intake` whose prompt acts on dispatch
   payloads: do what the payload's `instruction` asks, in your team repo, then commit and push. Copy
   its trigger URL
2. For each job you want to run by voice: it needs a routine of its own (copy that trigger URL too)
   and `fire: true` in its workflow file's trigger block
3. In Vercel, set `FIRE_KEY` - a long passphrase you make up - and `FIRE_TRIGGERS`, a JSON object of
   slug and trigger URL: `{"task-intake":"https://…","morning-intel":"https://…"}`. Production and
   Preview, marked sensitive
4. Redeploy. The Run, Add task, Arm and Approve buttons start working too

**Who does a task, and on which model:** your orchestrator decides on its next sweep, on the agent's
own model, as with the **Add task** button - unless you say otherwise. Name them as you ask (*"have
research draft it on opus"*) and the card says *"you chose"*. Or pick on the card: **Who does it** and
**Model** (the tiers your agents' own `model:` lines use - opus, sonnet or haiku).

**Jev** (TypeSafe's decision model, on OpenRouter) can pick both for you, with its odds: the card
says *"Agent: research · 82%"* and *"Model: sonnet · 74%"*, and you can still change either. A name
you said wins; Jev is asked only about the rest. Jev must answer within 1.5 seconds and be at least 60%
sure; otherwise the orchestrator decides, on the agent's own model, and the card says why (*"Jev was
not sure"*, *"Jev did not answer in time"*). Switch it on with `JEV_ROUTING=on` and
`OPENROUTER_API_KEY`. It is off by default because, when it is on, each task's
title and details, each agent's slug and description, and the board's own one-line note on each model tier
go to OpenRouter, a new vendor that offers zero data retention only on enterprise accounts. It costs
about $0.00002 a decision ($0.042 per million tokens it reads; its answers are free).

**How far the model goes, today:** the task card is written with `model: <tier>` in its frontmatter,
beside `for:`. Your team's daily task sweep (the `work-the-tasks` skill) does not read that field yet,
so the model is a recommendation until it does: the sweep still works each card as the agent it
routes to. Making it count is one line in your team repo's `work-the-tasks` skill, saying to use the
card's model when it names one - the board never edits your repo.

### Speakers or headphones

On a computer the board starts in **speakers mode**: while the assistant talks, the microphone rests,
so it cannot hear its own voice coming back out of the speakers and answer itself. To interrupt it,
tap the orb, press Esc or press Space; it stops and listens at once. Exactly what each one does:

| You press | While a reply is playing | In the 1.5 seconds after a reply ends | Any other time |
|---|---|---|---|
| **Esc**, or tap the orb | Interrupts it: it stops and listens at once | Nothing happens, so a late "stop" never hangs up | Ends the call |
| **Space** | Interrupts it | Nothing happens | Nothing happens |
| **Stop** | Ends the call | Ends the call | Ends the call |

In headphones mode, and on a phone, there is no rest to interrupt: you talk over it, and Esc ends the
call.

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
| The words of an order you say yes to | **Your `task-intake` routine** (a task) or **that job's routine** (a run), through the board's own `/api/fire` | So your team does it. The trigger URLs stay in Vercel; none reaches your browser |
| With `JEV_ROUTING=on`: a task's title and details, your agents' slugs and descriptions, and the board's note on each model tier | **OpenRouter** (Jev) | So it can pick who does the task and on which model. Off by default |

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
| `VIEW_KEY` | The **spare key**: long and random. Signs in when the password is lost, and scripts send it as the `x-view-key` header. See [Signing in](#signing-in) | **Yes**, unless… |
| `BOARD_USERNAME` | The username you sign in with, e.g. your email. Capitals and spaces do not matter | Recommended |
| `BOARD_PASSWORD` | The password you sign in with: **12 characters or more**. Tick **Sensitive** | Recommended |
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
| `VOICE_REPLY_TOKENS` | How long one spoken reply may run, 300 to 800. Its sound counts at about 20 a second, so the default `700` is about 30 seconds of speech; `800` is the most, about 40. With Fish it is always 300, which is already longer than that | No |
| `VOICE_ECHO_GUARD` | On a computer, a turn of one or two words in the first 1.5 seconds of a reply is treated as the assistant's own voice coming back through the speakers: it is ignored and the reply resumes (once per question). So to stop it right at the start, use **Stop** or Esc rather than saying "stop". The guard reads a transcript of what it hears, so on a computer that is on with it, captions or not: about $0.002 a minute of your talking (gpt-4o-mini-transcribe: 600 audio tokens a minute at $1.25 a million, plus the words at $5 a million). Phones never use the guard. Phones do not pay it unless captions are on. `off` to switch it off. On unless set | No |
| `VOICE_SPOKEN_YES` | `off` to make a tap on the card's **Yes** the only way to send a voice order. On unless set: your own plain spoken yes counts too, under the rules in [Orders by voice](#orders-by-voice) | No |
| `JEV_ROUTING` | `on` to let Jev pick which agent does a task you order by voice, and on which model tier, with its odds on the card. **Sends the task's title and details, and your agents' slugs and descriptions, to OpenRouter**, about $0.00002 a decision. Needs `OPENROUTER_API_KEY`. Off unless set | No |
| `OPENROUTER_API_KEY` | Your OpenRouter key, for Jev. Mark it sensitive. Does nothing unless `JEV_ROUTING=on` | For Jev |
| `VOICE_VAD_THRESHOLD` | How loud a sound must be to count as you talking, `0.1` to `0.95`. Default `0.6` - a little above OpenAI's example, because a computer on speakers heard its own voice as you talking. Raise it if it keeps cutting itself off; lower it if it misses you | No |
| `FISH_API_KEY` | Your Fish Audio key, for a voice you choose. Mark it sensitive | For Fish |
| `FISH_VOICE_ID` | The 32 letters and numbers in the voice's address on fish.audio | For Fish |
| `FISH_MODEL` | Leave unset for Fish's free `s2.1-pro-free`. Only `s2.1-pro`, exactly, uses the paid model | No |
| `EDIT_KEY` | A password for changing names and pictures, sent as `x-edit-key`. **Required if `PUBLIC_DASHBOARD=true`** - for changes, and for voice | If public |
| `WRITE_DAILY_CAP` | Changes a day (names, uploads, resets). Default `19`, at most `26`. Held under [the store's free limit](#the-picture-stores-free-limit-and-why-the-caps-are-where-they-are) | No |
| `GENERATE_DAILY_CAP` | Pictures from words a day. Default `10`. Gets whatever the changes leave of the same limit | No |
| `VERCEL_BLOB_RETRIES` | How often the Blob library retries a failed write. Its own default is `10`; set `2`, because a retry can count against the store's free limit | Recommended |

**Redeploy after changing any of these.** Vercel does not apply env vars to a running deployment.

> **`PUBLIC_FIRE` is a convenience, not a security boundary.** It drops the fire key, and nothing
> else: fire always checks who is asking first, exactly like the rest of the board. So with
> `PUBLIC_FIRE=true`, anyone who can open your board - anyone signed in, or holding the view key -
> can start your jobs, spending runs on your Claude account, without a second key. The check that a
> request came from your own page uses headers a browser sets. A browser cannot lie about them;
> anything that is not a browser can **forge them freely**. The buttons still cannot make anything
> *send*, and the dashboard still cannot write to your repo, but the runs are real and they are
> yours. On a board with `PUBLIC_DASHBOARD=true` it does nothing: the fire key is then required.
> Leave it unset and use `FIRE_KEY` unless you have a reason not to.

**4. Lock it and sign in.** Follow [Signing in](#signing-in) below: about five minutes, once.

---

## Signing in

The board is locked. Nobody sees it until they sign in, and each phone or computer signs in **once**,
then stays signed in for 30 days after you last used it. Your phone or browser saves the password for
you, like any website's.

### Set it up (about five minutes, once)

1. **Make a spare key.** In Vercel: your project, **Settings → Environment Variables**, add `VIEW_KEY`
   with a long random value, and tick **Sensitive**. Make the value with `openssl rand -hex 20`, or,
   on a computer without openssl (Windows):

   ```bash
   node -e "console.log(require('crypto').randomBytes(20).toString('hex'))"
   ```

   Keep it in your password manager, named "spare key". Never copy an example value.
2. **Choose a username and password.** Add `BOARD_USERNAME` (your email is fine) and `BOARD_PASSWORD`:
   **12 characters or more** - three or four unrelated words is easy to remember and hard to guess.
   Tick **Sensitive** on the password. A password under 12 characters is never used, and the sign-in
   screen says so.
3. **Redeploy.** Vercel does not apply new variables to a running board.
4. **Turn on Vercel Authentication for every address.** Your project, **Settings → Deployment
   Protection → Vercel Authentication → All Deployments**, then **Save**. It is free on every plan,
   Hobby included ([Vercel's changelog](https://vercel.com/changelog/protect-production-deployments-for-free-on-every-plan)).
   Strangers then never reach the board at all; you log in to Vercel once on each device. The
   default, "Standard Protection", leaves your main address open, which is the one you bookmark.
5. **Add one firewall rule**, so nobody can try password after password. Your project, **Firewall →
   New Rule**: if **Request Path** equals `/api/login`, then **Rate Limit**,
   **10 requests per 60 seconds**, keyed by **IP**. **Save**, then **Publish** - a rule that is not
   published does nothing.
   Free on Hobby (one rule per project).
6. **Open the board on your phone**, type the username and password once, and let the phone save them.

### The spare key

- It is your `VIEW_KEY`. On the sign-in screen, tap **Use the spare key instead** and paste it.
- Use it when you have forgotten the password, or before you have set one.
- Scripts still send it in the `x-view-key` header.
- A phone that kept the old key from before there was a sign-in moves over by itself the first time
  it opens the board. Nobody types anything.

### Forgot the password, or think someone saw it

- Sign in with the spare key, then change `BOARD_PASSWORD` in Vercel and redeploy.
- Changing `BOARD_PASSWORD` or `VIEW_KEY` **signs every device out**, at once. Change `VIEW_KEY` if
  the spare key itself got out.

### Signing out

- **Sign out**, under the screens: this phone or computer only.
- **Sign out everywhere**: every device, this one included. It is kept in the picture store, so it
  needs one ([Make it yours](#make-it-yours)) and uses one of the day's changes. **It is not
  instant:** the board checks the store for it at most every 10 minutes, to keep inside the store's
  free reads, so other devices are out within about 11 minutes. A screen left open on the Readiness
  wall keeps being told only whether anything has changed until then, never what.
- **If the picture store cannot be read** (it is suspended, or the free allowance ran out), sign out
  everywhere stops working on any copy of the board that Vercel starts after that: it cannot learn
  about the press. The board stays open to signed-in devices rather than locking you out.
- **A phone or laptop lost or stolen? Change `BOARD_PASSWORD` in Vercel and redeploy.** That signs
  every device out the moment the new deployment is live, and needs no picture store. Change
  `VIEW_KEY` too if the spare key was saved on it.

### What stops someone guessing

| Layer | What it does |
|---|---|
| Vercel Authentication (step 4) | Strangers never reach the board, so they cannot guess at all |
| The firewall rule (step 5) | More than 10 tries a minute from one place are refused before the board sees them |
| The board itself | Each wrong try takes about half a second, and 5 wrong tries from one place - one after another, or all sent at the same moment - pause signing in there for 15 minutes. Every wrong try gets the same sentence, so nothing says whether the username or the password was wrong |

The cookie that keeps a device signed in cannot be read by anything running on the page, is never
sent to another website, and is refused once 30 days pass without the board being opened.

---

## Did it work?

- The page loads and the **Today** screen shows your repo name at the top
- All the screens open from the nav
- **Workflows** shows a state chip on every job
- The footer says when it read your repo

**If it says "not configured"** — `VIEW_KEY` is unset and `PUBLIC_DASHBOARD` is not `true`. Set one.

**If it says "Set GITHUB_OWNER and GITHUB_REPO"** — those two are missing, or you did not redeploy
after adding them.

Locally:

```bash
npm test
```

2033 tests, nothing to install to run them. They cover the data logic, the fire endpoint's auth, and —
since a regex over the page source proves nothing about what a person sees — a harness that renders
every screen and asserts on the actual output. The board has **one dependency, `@vercel/blob`**,
used only when you connect a picture store. Besides that it serves two libraries in `public/vendor/` -
3d-force-graph 1.80.0 and force-graph 1.51.4, both MIT, copied unchanged from npm and pinned by their
hash - loaded only when someone opens **Graph** on Memory. Every notice they carry is in
`public/vendor/THIRD-PARTY-LICENSES.txt`.

---

## When it breaks

| What you saw | What to do |
|---|---|
| `This dashboard is not configured` | Set `VIEW_KEY`, or `PUBLIC_DASHBOARD=true` if the repo is public. Redeploy |
| `BOARD_PASSWORD is shorter than 12 characters` | Set a longer one in Vercel and redeploy. Until then, use the spare key |
| `Too many wrong tries from here` | Wait 15 minutes, then try again, or use the spare key from another network |
| **Reload to sign in** | Your Vercel login on this device ran out. Tap **Reload** and sign in to Vercel again |
| The username and password never work | Check both are set in Vercel and that you **redeployed**. The spare key always works |
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
| A Run button, Add task or a voice order answers "Fire is not configured…" | `FIRE_KEY` or `FIRE_TRIGGERS` is not set. Follow [Orders by voice](#orders-by-voice), steps 1 to 4 |
| A Run button answers "…does not have trigger.fire: true" | Add `fire: true` to that job's trigger block, commit and push |
| "Orders by voice are off…" | The board's Run buttons are not set up yet. Follow [Orders by voice](#orders-by-voice) |
| "Didn't catch a clear yes - tap Yes." | Your yes was not plain, came during or just after its voice, or the fire key is not in this tab yet. Tap **Yes** |
| Add task, or a voice order, answers "…no characters that cannot be seen" | The words carry characters nobody can see - often pasted from somewhere else. They are refused, never quietly removed: type or say them again |
| "Not sent: …" in the voice panel | The board refused the order, and the rest of the line says why. The assistant is told not to say it was sent |
| Add task, New workflow, Arm or Approve answer "No \"task-intake\" routine is registered" | Those four dispatch to one dedicated routine rather than to a job, so `task-intake` needs its own entry in `FIRE_TRIGGERS`. It is not a workflow slug and wiring every workflow does not supply it |
| The board looks empty but the repo is fine | Check the branch. `GITHUB_BRANCH` defaults to `main` |
| **Memory → Graph** says GitHub's rate limit was reached | Reading the graph is one GitHub call per note. Wait the seconds it gives - the board asks nothing before then - and make sure `GITHUB_TOKEN` is set: without one GitHub allows 60 calls an hour |
| The graph is flat on a computer | 3D needs WebGL, a mouse or trackpad, and no "reduce motion" setting. Press **3D** to choose it anyway; the device remembers |
| A vault you named is not on the graph | It must be allowed in `allowed-vaults.yml` on its own computer **and** named in `vaults.yml`, and that computer's collector must have run since. At **shape** it is there with no titles, which is the point |
| The graph is mostly amber dots | Those notes do not point at each other. A `[[link]]`, a markdown link, or a repo path written out (`shared/about-me.md`) draws a line |
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
| "That answer was cut short. Ask me to go on." | The reply reached its length limit, about 30 seconds of speech. Say "go on". To allow longer replies, raise `VOICE_REPLY_TOKENS` (at most `800`) and redeploy |
| With Fish on, some sentences are not spoken | Fish did not answer in time for that piece, so it was skipped; its words are still in the panel. If none are spoken, check `FISH_API_KEY` and `FISH_VOICE_ID` |

---

## What it will never do

- **Write to your repo.** Every button is a *dispatch*: an agent session makes the change and
  commits it. A broken board cannot corrupt your team. Its only write power is over its own picture
  store - names and pictures, nothing else
- **Send anything you did not ask it to.** It has no email and no publishing. What does leave is yours
  to switch on, with `OPENAI_API_KEY`: **Make it** sends the description you typed to OpenAI, and
  **talking to the board** sends your voice, and the board's answers to its questions, to OpenAI -
  plus, with Fish on, the words of each answer to Fish, whose free model may train on them, and with
  `JEV_ROUTING=on`, the words of a task you order to OpenRouter. See [What goes where](#what-goes-where)
- **Start work on its own.** Nothing is sent without your tap on **Yes**, or your own spoken yes,
  after you saw its card. Its own words, or anything it read, can never say yes for you
- **Put a key on the page.** The OpenAI and Fish keys stay on the server. A voice call is started by
  the board's own function, which adds the key; not even a short-lived key reaches your browser
- **Keep a key or password where the page can read it.** Signing in leaves a cookie that no script
  on the page can read and the browser never sends to another site. The board keeps nothing else on
  your device: your phone or browser's own password manager is what remembers the password
- **Cap your voice spending for you.** It meters it, as an estimate. The hard spend limit on your OpenAI
  project is what stops it
- **Show you somebody else's data.** It reads one repo, the one you named
- **Show what your other vaults' notes say.** A vault on another computer reaches the board as dots and
  lines, with titles only where you chose titles - never a note's words, never where the vault lives
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

The Readiness wall is the same once more. `tests/fixtures/jobs-parity.json` is the collector's
contract for `.agent-team/status/jobs/`, byte for byte, and `tests/jobs.test.mjs` holds the board to
it (a test compares the two copies whenever both repos are checked out side by side). The board
re-checks every name - a launchd label, a Hermes id of exactly 12 lowercase letters and numbers, the
standard `Hermes job <id>` name, the names in `jobs.yml` - and builds its answer from the keys it
knows. The light for each job is decided on the server (`api/_readiness.js`, with every row of its
rules table under test) and the sentences are built there too, with no model call; the page only
fills in times in the reader's own clock. `/api/state?since=<commit>` answers `{ "unchanged": true }`
with one call to GitHub when the branch has not moved, and otherwise the whole board built from the
new commit. Every answer from `/api/state`, including that one and the refusals, is
`Cache-Control: private, no-store`.

The memory graph is the same once more. `tests/fixtures/vaults-parity.json` is the collector's
contract for `.agent-team/status/vaults/`, byte for byte, and `tests/vaults.test.mjs` holds the board to
it: every vault name, title, folder, day and hub label is checked again, a vault whose lines break the
contract's rules is left out whole and counted, and a vault at **shape** never yields a title, whatever its
file says. The team repo's own graph is built by `api/_team-graph.js`, whose links and markdown mentions
pass every case of the contract's resolution table, so a vault and the team repo draw the same lines from
the same text. `/api/graph` serves both, read from one commit, behind the same gate and
`Cache-Control: private, no-store`; it is never part of `/api/state`, so the Readiness wall's
60-second check stays one call. The libraries are told to use the d3 layout engine - the other one builds
code from text, which the page's policy refuses - and their hover labels are always elements, never text
they would put in the page as markup.

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
