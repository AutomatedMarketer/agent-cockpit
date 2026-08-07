# agent-cockpit

A dashboard for your AI agent team. It reads your team repo and shows you what your agents
did, what has gone quiet, and what was never set up.

You deploy it. You own it. Nothing here runs on anyone else's infrastructure.

## What it shows

| Section | What it tells you |
|---|---|
| **Agents** | Every agent, the model it runs on, when it last ran, how often this week |
| **Activity** | The last 50 runs, each one linking to its transcript and its output file |
| **Gaps** | What has gone stale, what has never run, and which parts of your business brain are still empty |

## Why it reads git and not an API

Routines does not publish a run-history endpoint. There is no list-my-runs call to make.

So every agent commits its run log back to your repo, and this page reads that. Which turns
out to be the better design anyway: your history lives in git, forever, and belongs to you.
Nothing here breaks when a platform changes, and you can grep it.

## Deploy it

### 1. Fork this repo

Press **Fork** at the top of the GitHub page.

### 2. Connect it to Vercel

Go to `vercel.com/new`, pick your fork, press **Deploy**. There is no build step and no
`npm install` — it is a static page and one small function.

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

Then **Deployments → the latest one → Redeploy**.

### 4. If your team repo is private

Most people's are, because the business brain is in there.

Make a token at `github.com/settings/personal-access-tokens/new`:

- **Repository access:** only your team repo
- **Permissions:** Contents → **Read-only**. Nothing else.

Paste it into `GITHUB_TOKEN` in Vercel and redeploy.

That token lives on the server and is never sent to the browser. Do not commit it, do not
paste it into a chat, and do not give it write access — this page only ever reads.

## No API key needed

There is no chat box on this page, on purpose. A chat box would need an Anthropic API key,
which is billed per token and would quietly break the promise that this costs nothing beyond
your Claude plan.

Everything you see here is free to run: a static page, one function, and GitHub's public
read API.

## Runs anywhere

It is a static page plus one serverless function using nothing but `fetch`. It works on
Vercel out of the box. Cloudflare Pages and Netlify both work with their own function
conventions — the function is 100 lines and has no dependencies.

## Checking it locally

```bash
npm test
```

Tests cover the parsing and staleness logic plus one end-to-end pass over a stubbed GitHub.
No network, no keys, no install.

## What "stale" means

An agent that has not run in more than **7 days**. That is a deliberate default: often
enough to notice a broken schedule, rarely enough that a weekly agent does not nag you.
Change `STALE_AFTER_DAYS` in `api/lib.js` if your team runs on a different rhythm.
