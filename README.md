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

| Provider (pi-ai api)                               | Native API used                                                                                                                                                |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openai` (`openai-responses`)                      | `POST https://api.openai.com/v1/responses/compact`; the returned `output` is prepended to later `input`                                                        |
| `xai` (`openai-responses`)                         | `POST https://api.x.ai/v1/responses/compact`, same contract                                                                                                    |
| `openai-codex` (`openai-codex-responses`)          | `POST https://chatgpt.com/backend-api/codex/responses` with a trailing `{"type":"compaction_trigger"}` input item (SSE, `OpenAI-Beta: responses=experimental`) |
| `anthropic` (`anthropic-messages`)                 | `POST /v1/messages?beta=true`, `anthropic-beta: compact-2026-09-04`, `compaction: {type: "summarize"}`; the signed `compaction` block leads later requests     |
| anything else (OpenRouter, faux, Claude Agent SDK) | Pi Durable's built-in summarizer                                                                                                                               |

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
- Per-bot Docker environment. The adapter is a stub.
- Scheduled extraction and bot-to-bot messaging. Both are configured and validated, but neither is run yet.
- Stop/abort in the UI.
