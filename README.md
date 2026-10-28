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
