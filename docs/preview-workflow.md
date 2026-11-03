# Workstation preview iteration

This is Trey's standing development workflow, confirmed November 3, 2026. Normal feature and
fix requests include updating the existing preview after validation. Do not ask Trey to repeat
this instruction each chat. Explicit task constraints override this default.

## Existing installation

| Item                       | Value                                                                   |
| -------------------------- | ----------------------------------------------------------------------- |
| Host / SSH from the Mac    | `workstation-home-1` / `ssh workstation` as `trey`                      |
| Runtime checkout           | `/home/trey/Projects/pi-bot` on `main`                                  |
| Task worktrees             | `/home/trey/Projects/pi-bot-wt/<branch>`                                |
| User service               | `pi-bot.service`                                                        |
| Unit file                  | `/home/trey/.config/systemd/user/pi-bot.service`                        |
| Service command            | Node runs `packages/server/dist/cli.js serve` from the runtime checkout |
| Backend                    | `http://127.0.0.1:4317`                                                 |
| Preview                    | https://workstation-home-1.tail906b96.ts.net:10443                      |
| Config                     | `/home/trey/.config/pi-bot/config.toml`                                 |
| Database                   | `/home/trey/.local/share/pi-bot/pi-bot.sqlite`                          |
| Existing backups directory | `/home/trey/.local/share/pi-bot/backups`                                |

These are observed installation details, not guarantees of current state. Verify the service,
checkout, and Tailnet route before deployment. Other ports on this host serve other apps;
do not replace their routes. Never enable Funnel or public binding.

## Work through a change

1. Read `AGENTS.md`, inspect git status and worktrees on the host you will edit, and check for
   concurrent work. Use existing authenticated SSH sessions. Do not print config or credentials.
2. Create one short-lived branch and worktree from current `main`, per the working agreement.
   Work can happen on the Mac or workstation; the deployed runtime lives on the workstation.
   Do not edit the runtime checkout as a feature worktree.
3. Implement and review the change. Run `pnpm install --frozen-lockfile` as needed and
   `pnpm check` in the Linux workstation task worktree. For UI changes, check the rendered behavior and relevant
   desktop/mobile layouts using a disposable instance with faux providers and separate data.
   Do not use the live user's accounts or conversations as automated test fixtures.
4. Serialize integration with other agents. Immediately before merging, recheck `main` and
   remote state. If another change landed, integrate it and rerun checks. Merge only green work,
   run `pnpm check` on resulting `main`, and push `origin main` using macagent131 SSH. No PRs.
5. Deploy that tested commit to the workstation checkout using a clean, fast-forward update
   when work was integrated elsewhere. Install locked dependencies if needed and run
   `pnpm check` there so the built assets match the deployed source. Never reset or clean away
   another agent's changes. If the target moved, reconcile and validate before restarting.
6. Before a deployment that changes persisted state or startup migrations, create a private
   SQLite backup using SQLite's backup API (not a raw copy of an active WAL database), verify
   its integrity, and preserve the config with mode `0600`. Keep backups out of git and logs.
   Preserve the credential key/store and Docker volumes; never seed, reset, purge, or replace
   user data to make a deployment pass.
7. Restart only `systemctl --user restart pi-bot`, check `systemctl --user is-active pi-bot`,
   then check `/health` through the existing preview URL. Check relevant deployed UI behavior
   without changing user data. A healthy endpoint alone does not prove a UI fix works.
8. Report the deployed commit, preview link, checks performed, and any remaining limitations.
   Remove only your own finished task worktree and branch. Sync other clean checkouts when
   appropriate, without interrupting another agent's work.

Documentation-only changes should be committed, checked, merged, and pushed as usual; they
need no service restart. Investigation-only requests do not imply implementation or deployment.
If SSH, validation, or deployment fails, report the exact blocker and distinguish code pushed
from code actually running. Do not silently substitute a Mac preview.

## Coordination and recovery

There is one shared preview. Parallel implementation is fine; merging, building in the runtime
checkout, and restarting it must have one owner at a time. Check active work and coordinate a
handoff before touching a checkout or service another agent is using. Never restart mid-build.
Recheck commit IDs rather than relying on an earlier chat's completion message.

Record the previous running revision before updating. If deployment fails, inspect the failure
without exposing secrets. Rebuild a known-good revision only when compatible with the current
schema; a code rollback does not undo migrations. Do not restore a database over newer user
activity without explicit direction.

## Build revision and deferred work

The sidebar shows `Build <short git revision>` for the web assets loaded by the browser.
Vite captures this at build time; uncommitted source is marked `-dirty`, and builds without
Git metadata show `unknown`. Commit before the final build so the deployed label identifies
the actual commit. Refresh an older browser tab to load the latest revision. This identifies
the frontend bundle, not an independently queried backend revision.

This is a rapid development preview, not production testing. Deploy validated changes promptly;
do not introduce deployment locks or a production release process. Deployment locks are deferred
until production testing. Linux is the current runtime and validation target; macOS support and
Mac-specific test issues are deferred until explicitly requested. Continue ordinary coordination
to avoid overwriting concurrent work, without adding a locking mechanism.
