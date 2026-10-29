# Pi Bot

A self-hosted, single-user service for running several bots, built on
[Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable). MIT licensed.
`AGENTS.md` has the working agreement.

Each bot is one Pi Durable session. Its **main** channel is one long-lived
conversation. A **thread** forks off any message and inherits the context up to
that message. All bots share one process and one SQLite database (tables are
prefixed `pibot_<botId>_`, plus a registry). Credentials are shared by all bots.

## Layout

| Path                  | What                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| `packages/server`     | `@wovenmatter/pi-bot`: config, storage, bot manager, threads, credentials, WebSocket API, `pi-bot` CLI |
| `apps/web`            | Minimal React client: bot picker, main chat with streaming, threads, theme switcher                    |
| `config.example.toml` | Every config key, with its default                                                                     |

## Run

Requires Node ≥ 22.19 and pnpm 12.

```sh
pnpm install
pnpm build
mkdir -p ~/.config/pi-bot && cp config.example.toml ~/.config/pi-bot/config.toml   # required; edit [models]
node packages/server/dist/cli.js set-key openai   # stores the key encrypted; never echoed
pnpm start                        # http://127.0.0.1:4317  (WebSocket at /ws, health at /health)
```

Credentials:

```sh
node packages/server/dist/cli.js set-key <provider>   # API key from hidden input or stdin (openai, openrouter, exa, ...)
node packages/server/dist/cli.js login <provider>     # pi-ai OAuth login
node packages/server/dist/cli.js credentials          # list (provider and type only)
node packages/server/dist/cli.js logout <provider>
```

Development, with two terminals:

```sh
pnpm dev:server   # server with --watch on 127.0.0.1:4317
pnpm dev:web      # Vite on http://127.0.0.1:5173, proxies /ws and /health to PI_BOT_PORT (default 4317)
```

`pnpm check` runs build, typecheck, lint (Biome) and tests (Vitest). Tests use pi-ai's
faux provider, so no API keys are needed.

The server only binds to loopback or tailnet addresses (100.64.0.0/10,
fd7a:115c:a1e0::/48). It rejects public addresses.

## Compaction

The main channel and every thread run the same code (`packages/server/src/compaction/`) and the
same test suite (`test/compaction.test.ts`, parametrized over both). Pi Durable decides when to
compact (`[compaction]` thresholds, context overflow, or a manual `compact()`) and picks the
covered prefix, keeping tool calls with their results. Then, mirroring Woven Matter's
`default-agent` (`provider-compaction.mjs`, `native-context.mjs`, `native-compaction-registry.mjs`):

| Provider (pi-ai api)                      | Native API used                                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `openai` (`openai-responses`)             | `POST https://api.openai.com/v1/responses/compact`; the returned `output` is prepended to later `input`                                                                  |
| `xai` (`openai-responses`)                | `POST https://api.x.ai/v1/responses/compact`, same contract                                                                                                              |
| `openai-codex` (`openai-codex-responses`) | `POST https://chatgpt.com/backend-api/codex/responses` with a trailing `{"type":"compaction_trigger"}` input item (SSE, `OpenAI-Beta: responses=experimental`)           |
| `anthropic` (`anthropic-messages`)        | `POST /v1/messages?beta=true`, `anthropic-beta: compact-2026-09-04`, `compaction: {type: "summarize"}`; the signed `compaction` block leads later requests               |
| `claude-subscription` (Claude Agent SDK)  | SDK `/compact` over the replayed transcript; the `PostCompact` hook's `compact_summary` (with `compact_boundary`) becomes the window, sent as a `<summary>` user message |
| anything else (OpenRouter, faux)          | Pi Durable's built-in summarizer                                                                                                                                         |

The compaction request is built by capturing the exact payload pi-ai would send (same system
prompt, tools and auth), so the native window matches what later requests carry. The window lives
in a rewindable conversation doc (`pibot.native-context`, inherited by forks), and a
`pibot.native-compaction` head-marker entry moves the start of the model context. Nothing is
deleted. A model change re-projects the covered history from SQLite: natively when the new route
supports it, otherwise as a readable summary. An unsupported or failed native call is reported and
falls back to Pi Durable's summarizer (Woven fails closed instead). Requests stay prefix-stable
between compactions, so prompt caching is only reset by compaction itself.

`beforeCompact` first calls the memory-extraction hook (`src/memory.ts`), a no-op in milestone 2.
Tests use fake provider endpoints and placeholder credentials; no real model key was used.

## Claude via the Claude Agent SDK

The `claude-subscription` provider (`packages/server/src/claude/`) runs Claude through
`@anthropic-ai/claude-agent-sdk`, so a Claude Pro/Max subscription works as well as an API key.
It follows Woven Matter's `default-agent/src/claude-provider.mjs`, `claude-runtime.mjs` and
`claude-inventory.mjs`.

```sh
claude setup-token                                            # prints a long-lived OAuth token
node packages/server/dist/cli.js set-key claude-subscription  # paste it (stored encrypted)
# then use e.g. orchestrator = "claude-subscription/claude-sonnet-4-5" in config.toml
```

An `sk-ant-oat…` token is passed to Claude Code as `CLAUDE_CODE_OAUTH_TOKEN`; any other key is
passed as `ANTHROPIC_API_KEY`. Each turn runs Claude Code with:

- a private `CLAUDE_CONFIG_DIR` under `<dataDir>/claude-agent` (mode 0700);
- a filtered environment (inherited `ANTHROPIC_*`/`CLAUDE_*` variables removed; telemetry,
  error reporting, nonessential traffic and retries off);
- no built-in tools, skills, settings sources or session persistence;
- `maxTurns: 1`.

Pi Bot's tools are listed to Claude through a list-only MCP server (`inventory.ts`). Calls come
back as tool calls that Pi Bot executes, and are never run inside Claude Code. Earlier turns are
replayed as `shouldQuery: false` frames.

Limits:

- The SDK is proprietary (Anthropic Commercial Terms). It is pinned to `0.3.312`. Subscription
  use is subject to Anthropic's consumer terms.
- Every turn starts a Claude Code process and replays the whole transcript. There is no SDK session
  resume, no admission gate that captures raw HTTP responses, and no account fencing; Woven has
  all three.
- Sampling options other than reasoning effort are ignored. The context window and costs come from
  pi-ai's Anthropic catalog.
- Tested only against a fake `query()`. No real Claude token or Claude Code process was used.

## Thread titles

Threads have no visible names: the web client shows each thread as a reply link under the
message it forked from, and nothing renames a thread (`thread.fork` takes no title). A title
is still generated as metadata for thread listing and search (`threads.list` with `query`),
the way Woven Matter titles conversations (`CodexConversationTitleGenerator.swift`):

- On the first user message of an untitled thread, the server sends Woven's title prompt
  (verbatim) plus that message to `[models.titles]` (default `openai-codex/gpt-6-luna`,
  `reasoning = "high"`), in the background, at most one request per thread.
- The reply goes through Woven's sanitizer (JSON `title`, else the first line; quotes and
  trailing periods trimmed; 50 characters max) and is stored compare-and-set: only while the
  thread is still untitled. The main channel is never titled.
- A failed request is logged and leaves the thread untitled.

## Deleting bots

Only the user deletes bots, through the WebSocket `bots.delete` request. Deletion is a **soft
delete**: the registry row in `pibot_bots` gets a `deleted_at` stamp and nothing else changes. The
bot's prefixed Pi Durable tables, its thread rows and all its data stay in the database (no
`DROP`, no `DELETE`). A deleted bot is hidden from `bots.list`, is not loaded or recovered at
startup, and can't be opened or messaged (`bot <id> was deleted`). Its in-memory harness is closed
and its runtime environment (container) released; volumes and data on disk are kept. Purging is
deferred. Stale thread registry rows are logged at startup, not pruned.

### Restoring deleted bots

Deleted bots are recoverable, but only from one dedicated place: **Settings → Bots → Deleted bots** in the
web app (the Settings link at the bottom of the sidebar, `#/settings/bots`). They never appear in the
sidebar or the main bot list. The section lists each deleted bot with its deletion date and a
**Restore** button. Restoring clears `deleted_at`; the bot then loads like any other, with all of
its conversations, threads and history, reappears in the bot list and can be messaged again. Its
runtime environment is re-acquired lazily on the next run, as on a normal load. Bot names are not
unique, so a restore never collides with an existing bot.

Over WebSocket this is `bots.listDeleted` (`{id, name, createdAt, deletedAt}` for each deleted
bot, newest deletion first) and `bots.restore {botId}`, which returns `{restored: true, bot}`, or
`{restored: false}` when the bot is unknown or not deleted. Delete, list-deleted and restore are
user-only paths: bot tools may create bots but never delete or restore them.

## Settings

The web app's Settings page (`#/settings`, tabs at `#/settings/<section>`) has:

- **Account & sign-ins** — keys and subscription sign-ins, stored in the credential store
  (Keychain on macOS, otherwise encrypted SQLite with a 0600 key file). Keys are write-only: the
  UI shows at most the last four characters, and no response ever carries a stored secret.
  Credential changes apply immediately (models read the store per request).
  - OpenAI: **ChatGPT subscription** sign-in (OAuth — device code, or open the link in any
    browser and paste back the `localhost:1455` redirect URL it ends on) and an **API key**.
  - Claude: **subscription token** from `claude setup-token` (`sk-ant-oat…`, used by the Claude
    Agent SDK path; there is no in-app Claude OAuth) and an **Anthropic API key**.
  - Grok / xAI: **SuperGrok or X Premium** sign-in (real device-code OAuth; some tiers are
    refused by xAI with a 403) or an **API key**. Both share one credential slot.
  - **OpenRouter** and **OpenCode Go** API keys.
    Variables from the environment show as "From …" and can't be removed here.
- **Models** — models from each signed-in provider and the bots (`orchestrator` key) / background
  / titles roles plus title reasoning, validated and written to `config.toml`.
- **Search** — Exa (default), Brave and Firecrawl keys, and `[search] provider`.
- **GitHub** — an SSH key for git over SSH (generate an ed25519 key server-side, or paste an
  unencrypted OpenSSH private key; only the public key and SHA256 fingerprint are shown back) and
  the git identity (`[git] user_name`, `user_email`). The key is stored only; it is not yet
  injected into any bot environment.
- **Bots** — deleted bots and Restore.
- **Config** — bot-to-bot limits and the extraction schedule / time zone as fields, plus the raw
  `config.toml` with validation against the startup schema (errors shown inline).

Every `config.toml` write is validated first, written atomically and keeps the file's mode and
comments (field edits change single lines in place). **Config changes need a restart**; the page
says so after each save. There is **no app-level auth**: anyone who can reach the server's
loopback/tailnet port can change settings, so never bind it anywhere public.

### Signing in (headless)

Every sign-in works from a browser on any other device: the server never opens a browser and
nothing has to reach a localhost callback on the workstation. The flows are Woven Matter's.

| Provider                         | What you see and do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ChatGPT (`openai-codex`)         | Settings → Accounts → ChatGPT → **Sign in** shows a code and a link to `auth.openai.com/codex/device`. Open it anywhere, enter the code, approve; Pi Bot polls and finishes on its own (15 min limit). Same as Woven (`default-agent/src/sign-in-interaction.mjs` picks `device_code`). If your account has device-code sign-in turned off, use **Browser, then paste the redirect URL**: approve in the browser, and when it lands on a `localhost:1455` page that won't load, paste that whole URL back. |
| Claude (`claude-oauth`, Pro/Max) | **Sign in** shows a claude.ai link. Open it anywhere, approve, and claude.ai shows a code (`code#state`); paste it back. Pi Bot stores the tokens, refreshes them itself and hands the access token to Claude Code as `CLAUDE_CODE_OAUTH_TOKEN`. Fallbacks: paste a `claude setup-token` token (same slot) or an Anthropic API key.                                                                                                                                                                        |
| xAI (Grok)                       | **Sign in** shows a code and an auth.x.ai link; approve there and Pi Bot finishes. API key fallback in the same slot.                                                                                                                                                                                                                                                                                                                                                                                      |

Refreshes run inside the credential store's per-slot lock, so the one server process has one
serialized refresher per provider (xAI and Anthropic rotate refresh tokens).

### Restart and apply

Config saves go to config.toml at once; **Restart and apply** (shown after a save, and always on
the Config tab) applies them. Pi Bot re-reads config.toml first (an invalid file is refused and
nothing stops), lets running turns finish for up to 15 s, closes, and starts again: in the same
process and on the same port by default (works under `pnpm dev`'s `node --watch`, a terminal, or
a service), or, with `PIBOT_RESTART_EXIT_CODE=75`, by exiting with that status for a supervisor
(systemd: `Restart=always` or `RestartForceExitStatus=75`). Turns still running at close resume via
Pi Durable. The page reconnects every 500 ms and says when Pi Bot is back.

## Per-bot environment

With `[environment] backend = "docker"` every bot gets its own Docker container, and all of its
tools run there (also for Claude via the Agent SDK: Claude Code runs on the server with no
built-in tools, and Pi Bot's tool calls execute in the container).

- **Image** (`packages/server/docker`): Ubuntu 24.04 LTS with git, Node 24, Python 3, build tools,
  ripgrep, and Playwright with Chromium. Built on first use as `pi-bot-env:<hash>`; a changed
  Dockerfile gives a new tag for new containers (existing containers keep their image).
- **Container** `pi-bot-<bot id>`: non-root user `bot` with passwordless sudo, its own named volume
  `pi-bot-<bot id>-workspace` at `/workspace`, full internet, no resource limits. Nothing from the
  host is mounted and there is no Docker socket. Started with `--restart unless-stopped`.
- **Lifecycle**: created on first tool use; stopped (volume kept) on soft delete; started on
  restore. At startup the server makes sure every active bot's container exists and runs (retrying
  while Docker starts) and stops containers of deleted bots. Containers and volumes are never
  removed.
- **Bridge**: the server runs `docker exec -i -u bot … node /opt/pibot-env/agent.mjs`, a small
  agent that serves Pi Durable's `NodeExecutionEnv` over JSON lines on stdio. `docker exec` does
  not pass the server's environment, so model and search credentials stay on the host.
- **Git**: the Settings → GitHub SSH key and identity are written to `~/.ssh/id_pibot_github`
  (0600, with `~/.ssh/config` and GitHub's pinned host keys) and `git config --global` in every
  container on start and whenever they change in Settings.

### Admin, bots and teams

- **Admin** is created on first start (exactly one; it can't be deleted, renamed or put on a
  team). It is the only bot with account/config tools: settings status, `config.toml` read/update,
  restart, its own model (`set_my_model`) and teams (`set_team`). It confirms config changes unless
  you asked for them, and never asks for secrets in chat (sign-ins and keys stay in Settings).
- **Onboarding**: on first run the web app asks you to sign in, then pick Admin's model
  (`onboarding.status`, `admin.setModel`). Change it later in Settings → Bots or by asking Admin.
  Admin's first conversation explains the platform and creates the bots/teams you want.
- **Bots** use the default `[models] orchestrator` model. Every bot has `list_bots`, `create_bot`
  and `message_bot` (delivers to the target's main conversation as a follow-up, rate limited by
  `[bot_to_bot] max_messages_per_hour_per_pair`). A bot created by a manager or team member joins
  that team.
- **Teams** are optional and one level: any non-Admin bot can be a manager (managers have no
  manager). Move bots, promote/demote and hand a team to a member in Settings → Bots, by asking
  Admin, or by telling a bot to start a team. Demoting or deleting a manager ungroups its team; a
  restored manager comes back without one. The sidebar pins Admin, then nests members under their
  manager.
- WebSocket: `bots.create {name, managerId?}`, `bots.setManager`, `bots.setTeam`,
  `bots.replaceManager`; the server pushes `{type: "bots.changed"}` when the list changes.

### Running as a service

On a Linux workstation, run the server as a systemd user service with lingering on, so it starts
at boot without a login (and Docker enabled at boot):

```ini
# ~/.config/systemd/user/pi-bot.service
[Unit]
Description=Pi Bot
After=network-online.target

[Service]
WorkingDirectory=%h/Projects/pi-bot
ExecStart=/usr/bin/node packages/server/dist/cli.js serve
Environment=PIBOT_RESTART_EXIT_CODE=75
Restart=always
RestartSec=1

[Install]
WantedBy=default.target
```

`systemctl --user enable --now pi-bot`, `loginctl enable-linger $USER`,
`sudo systemctl enable docker`. Restart and apply exits with 75 and systemd starts it again. For a
private preview on your tailnet only: `tailscale serve --bg --https=10443 http://127.0.0.1:4317`
(never `tailscale funnel`).

## Crash recovery

Pi Durable's store is the source of truth, as in Woven Matter. Every bot is opened at startup, and
before scheduling resumes the server reconciles it:

- **Interrupted runs.** Pi Durable keeps a run's task and the queued input in SQLite, and its open
  already reconciles an invocation that died mid-request. The server inspects the live work,
  reports it, and calls `resume()`, so an interrupted run finishes without a new message (Woven's
  `engine.mjs` `create`: inspect, then `resumeNative()`).
- **Unrecorded forks.** A fork is committed with its parent edge in one Pi Durable transaction;
  only the thread registry row comes after. An ownerless fork the registry lacks is registered as
  an untitled thread. Task-owned conversations (subagents) are never threads. Registered threads
  whose conversation is missing are reported and left alone.
- **Lost titles.** An untitled thread that already has its own first message gets its title
  generation restarted.

Each finding is logged as `bot <id> recovery: …`.

## Web client styling

The client uses the Woven Matter Enterprise web stack (React 19, Vite, lucide-react,
react-markdown with remark-gfm) on a smaller scale. `apps/web/src/styles.css` is a
subset of the Enterprise `apps/web/src/styles.css`, which mirrors the desktop app's
`DashboardColors.swift`, `DashboardStyle.swift` and `DashboardDesign.swift`. It has the
same three themes (Green, Cognac, Dark), set as CSS variables on
`html[data-theme]`. The selected theme is stored in localStorage under
`wovenmatter.dashboard.theme`, the same key the desktop app uses. Pi Bot's own rules
are at the end of the file.

## Not in milestone 1

- macOS Keychain backend. It is a stub, so encrypted SQLite is used everywhere.
- Scheduled extraction and bot-to-bot messaging. Both are configured and validated, but neither is run yet.
- Stop/abort in the UI.
