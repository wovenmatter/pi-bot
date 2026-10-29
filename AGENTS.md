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

- Settings never send a stored secret back: keys show at most the last 4 characters, the GitHub
  SSH key only its public half and fingerprint. Credential slots live in `settings/catalog.ts`;
  sign-ins must be real provider flows that work from a remote browser (URL/device code plus
  pasted redirect or code). Config writes go through `SettingsService` (validate, atomic write,
  keep mode/comments) and need a restart.

## Bot management

- Deleting a bot is a soft delete (`pibot_bots.deleted_at`). Never drop or delete a bot's tables,
  threads or data; purging is deferred and needs its own decision.
- Only the user deletes or restores bots (WebSocket `bots.delete`, `bots.listDeleted`,
  `bots.restore`). Bot tools may create bots but must never get a delete or restore tool.
- Exactly one Admin Bot (`kind = 'admin'`, auto-created): only it gets account/config tools; it is
  never on a team and can't be deleted or renamed. Teams are one level (`manager`, `manager_id`);
  rules live in `BotManager` (`BotRuleError`).

## Model profiles

- Profiles (`[profiles.<id>]` in config.toml: name, main, pool `{use_for, background}`, guidance)
  are owned by `ProfileStore` (`profiles.ts`); `[models] default_profile` names the default.
  Bots store only a profile id (`pibot_bots.profile`, null = default). There is no per-bot model
  and no global orchestrator/background role; `[models.titles]` stays global.
- The main model drives the channel and all threads. Delegation is the `run_subagent` tool
  (`subagent.ts`): a pool model, a task and an optional reasoning level, run in a task-owned child
  conversation with no `run_subagent` of its own. Failures are returned as tool errors; never add
  a fallback engine. Background work uses the `background` pool entry, else the main model.
- Account notes (`pibot_notes`) are guidance for Admin Bot (plans, keys, comfort spend), never
  caps and never secrets. Profile tools are Admin Bot only and follow confirm-unless-asked.
- Tests use faux providers; never real keys.
- Deleted bots are listed and restored only in the web app's Settings → Bots section,
  never in the sidebar or main bot list. Restore clears `deleted_at`; the bot reloads normally.

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
