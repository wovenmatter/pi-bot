# AGENTS.md — Pi Bot

Pi Bot is a self-hosted, single-user TypeScript service that runs many bots in one Node
process on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable). This file is
the working agreement for every human or agent who changes this repository.

## Working agreement

1. **One task, one short-lived branch, one git worktree.** Create it with
   `git worktree add ../pi-bot-wt/<branch> -b <branch> main`. Never commit straight to `main`
   from a task. (The first scaffold commit on `main` was the only exception.)
2. **Merge only when green.** A branch merges to `main` only after `pnpm check` (build,
   type-check, lint and tests) passes in its worktree. There are no pull requests: merge it
   yourself (fast-forward or merge commit), run `pnpm check` on `main` again, then
   `git push origin main`. Remove the worktree and branch afterwards.
3. **Small commits, clear messages.** Imperative subject (`server: add bot registry`), with a
   body when the why is not obvious.
4. **Never force-push or delete `main`.**
5. **Never expose anything to the public internet.** Servers bind to loopback
   (`127.0.0.1`/`::1`) or the tailnet (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) only. The
   config loader rejects any other bind address; do not weaken that check.

## Secrets

- Never print, log, commit or test against real secrets. Tests must not need real API keys;
  use the pi-ai faux provider.
- Credentials live in the shared credential store: the macOS Keychain on a Mac (stubbed in
  milestone 1) and an AES-256-GCM encrypted SQLite table elsewhere, with its key file at mode
  `0600` outside the database.
- `config.toml`, data directories, `*.key` and SQLite files are git-ignored.

## Bot management

- Deleting a bot is a soft delete (`pibot_bots.deleted_at`). Never drop or delete a bot's tables,
  threads or data; purging is deferred and needs its own decision.
- Only the user deletes bots (WebSocket `bots.delete`). Agent or orchestrator tooling may create
  bots but must never get a delete tool.

## Layout

- `packages/server` — `@wovenmatter/pi-bot`: storage, bot registry, Pi Durable harnesses,
  credentials, config, WebSocket server and CLI.
- `apps/web` — `@wovenmatter/pi-bot-web`: minimal React client (Woven Matter Enterprise web
  stack, Woven Matter desktop themes).

## Conventions

- Strict TypeScript, ES modules, relative imports with explicit `.ts` extensions.
- Biome formats and lints (`pnpm format` fixes most issues).
- Use the real Pi Durable / pi-ai APIs from the pinned versions; read their `.d.ts` files rather
  than guessing. Record any deviation from the design in `README.md`.
