# claude-dbot

A Discord bot that lets server members talk to Claude using **Claude subscriptions** (no API billing).
Anyone can register their own subscription token; token owners can share their sub with specific
people or the whole server. When someone asks a question, the bot automatically routes to a usable
subscription — their own first, then donated ones — and fails over when one hits a rate limit.

Built on [discord.js](https://discord.js.org) and the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) (Claude Code as a library).

## Features

- **`/ask`** or **@mention the bot** — ask Claude; mentions include recent channel history as context,
  and @mentioning **as a reply** pulls in the replied-to message ±5 surrounding messages, so
  "why is he wrong?" knows exactly which message "he" and "wrong" refer to.
  `/ask` options: `model` (Haiku/Sonnet/Opus/Fable; host default via `DBOT_DEFAULT_MODEL`), `project`,
  and `sub` — whose subscription pays: `auto` (yours first, donated fallback), `mine` (only your own),
  or `donated` (spare your own quota)
- **`/setup`** — guided onboarding in your DMs: one message walks you through token → sharing →
  model cap with buttons and dropdowns, ending in a summary
- **`/register`** — the quick path: paste your token from `claude setup-token` into a private modal
  (stored AES-256-GCM encrypted)
- **`/share` / `/unshare`** — let a specific person, or everyone, use your subscription through the bot.
  Optional `public_only` flag restricts a share to channels visible to @everyone, so donors can
  watch how their sub gets used (threads inherit their parent channel's visibility)
- **`/status`** — your token state, cooldowns, window utilization, who shares with you
- **`/policy`** — cap which models *others* may run on your shared sub (e.g. "up to Sonnet";
  your own asks are never capped). The router skips your sub when someone requests a bigger model
- **`/usage`** — donor report: runs, tokens, API-equivalent cost of what this bot consumed from
  your sub, broken down by user and model, plus the live rate-limit-window utilization %
- **`/project`** — point a channel at a repo checkout (from `projects.json`) so Claude can read the
  code, or `/project set none` for general-chat mode (no codebase assumed — good for offtopic channels;
  channels with no setting and no global default are general-chat too)
- **`/reset`** — clear a channel's Claude conversation memory
- **`/remember` / `/forget`** — teach the bot facts about yourself (preferred name, what you work
  on; max 10 notes, self-reported only) that flavor its answers to you everywhere
- **`persona.md`** — the bot's voice, verbosity, and addressing style live in a host-editable
  file (copy `persona.example.md`), re-read on every question so edits apply instantly
- **Always-on skills** — any `bot-plugin/skills/<name>/SKILL.md` is inlined into the system
  prompt of every answer (guaranteed to apply, unlike opt-in Claude Code skills), whatever the
  project, hot-reloaded per question. Unlicensed third-party skills (e.g. cursor/plugins'
  `unslop`) aren't vendored — run `npm run fetch-skills` once per host to download them
- **Bot-to-bot discussions** — allowlist other bots via `DBOT_PEER_BOTS` (comma-separated user IDs,
  set on both sides) and they can @mention each other into a conversation; a per-channel chain cap
  (`DBOT_MAX_BOT_CHAIN`, default 4) stops runaway loops until a human speaks again. Note: a peer
  bot has no token of its own, so its questions ride subs shared with *everyone*
- Per-channel resumable sessions, automatic rate-limit failover with reset-time cooldowns,
  answers chunked to Discord's 2000-char limit with code fences preserved
- Claude runs **read-only** (Read/Grep/Glob/WebSearch/WebFetch only — no bash, no file edits)

## Setup (host)

1. **Create the Discord app** at <https://discord.com/developers/applications>:
   - *New Application* → name it → copy the **Application ID** (General Information)
   - *Bot* tab → **Reset Token** → copy the bot token
   - *Bot* tab → enable **Message Content Intent** (required for @mention invocation)
2. **Configure**: `cp .env.example .env` and fill in `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`,
   `ADMIN_DISCORD_ID`. For instant slash-command updates during development, also set
   `DEV_GUILD_ID` to your server's ID.
3. **Projects** (optional): `cp projects.example.json projects.json` and point entries at local
   repo checkouts. A `CLAUDE.md` in each repo gives Claude standing project context.
4. **Install & register commands**:
   ```sh
   npm install
   npm run register-commands
   ```
5. **Run**: `npm start` (or `npm run dev` for auto-reload). The startup log prints the invite URL —
   open it to add the bot to your server.

Requires Node.js ≥ 22 (uses the built-in `node:sqlite`). No API key anywhere: authentication is
per-user OAuth tokens routed at runtime.

## Setup (each user)

Type **/setup** in the server — the bot DMs you a wizard that walks through everything
(you'll need to run `claude setup-token` in a terminal at the token step).
Prefer doing it by hand? `/register` to paste a token, `/share` to donate, `/policy` to cap models.

## Running a personal instance ("my local Claude in Discord")

Want a bot that answers with **your** local checkouts, CLAUDE.md memory, and docs? Clone this
repo on your own machine and run your own instance alongside the server's shared one:

1. Create your **own** Discord application (same portal steps as above — apps are free) and
   invite your bot to the shared server. Name it after yourself.
2. Point `projects.json` at your local checkouts. Set `DBOT_SETTING_SOURCES=user,project,local`
   in `.env` to also load your global `~/.claude` memory into answers.
3. `/setup` on your own bot with your own token. Share with nobody (default) — then only you
   can invoke it, and only your machine's context is exposed.

Your bot is online while your machine is; the shared instance covers everyone the rest of the
time. Nobody else can spend your sub through your instance unless you `/share`.

## Trust model — read this

- Tokens are encrypted at rest, but **whoever administers the host machine can technically
  recover them**. Registering a token means trusting the host like you'd trust them with your login.
- A shared token spends the owner's real subscription quota (5-hour and weekly windows).
  The bot cools a token down when its limit is hit and routes around it, but donors should
  expect their own Claude usage to be affected.
- Claude's input is whatever server members type, so the bot runs Claude with read-only tools
  and no credentials beyond the routed token. Keep it that way unless you understand the
  prompt-injection implications.

## Ops notes

- All state lives in `./data` (SQLite DB + encryption key). Back up / migrate by copying that
  directory alongside the repo. `data/secret.key` decrypts the tokens — treat it like a secret.
- To run as a service: any process manager works (`systemd` unit running `npm start` in this
  directory is enough). The bot only makes outbound connections; no ports to open.
