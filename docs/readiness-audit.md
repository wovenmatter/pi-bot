# Readiness audit — 2026-11-02

Reviewed with Claude Code CLI using claude-opus-5-5, high effort. Browser checks
used separate loopback-only instances, disposable databases, the faux model
provider and dummy credentials. No personal provider authentication was operated.

## Corrections

- Stabilize onboarding refreshes and clear interrupted login sessions.
- Serialize config writes across settings, Admin tools and profiles; reject stale
  raw-editor saves using a content revision. Preserve unsaved drafts until explicit
  reload. Profile patches preserve unrelated pending file changes.
- Make conversation subscriptions ownership-aware and start delivery after the
  snapshot reply; recover terminated watches through reconnect.
- Prevent sends into a conversation still loading, retain newly typed drafts,
  ignore stale bot/thread responses and link inherited thread replies correctly.
- Restore platform tools during startup recovery; close resources on startup
  failure; tolerate environment-disposal failure after a successful soft delete.
- Purge only the deleted bot's memory along with its other data. Clear removed
  profile assignments on deleted bots as well as active bots.
- Persist bot-to-bot round metadata with each user input so queued messages and
  restarts cannot reset the active turn's delegation guard.
- Handle child process spawn/pipe failures without crashing the server.
- Isolate unreadable stored credentials and allow explicit removal.
- Stack navigation above content on narrow screens; keep desktop layout and
  sidebar surface styling unchanged. Avoid repeated streaming announcements.

## Verification

- Full pnpm check: build, typecheck, Biome, 240 server tests and 54 web tests.
- Browser: chat rendering, streaming/stop, reconnect during a reply, thread
  creation/history/reload, bot creation/rename, teams/orchestrator, memory edits,
  deletion/restore/purge, profile creation/assignment, account notes, search
  selection, disposable Git identity/key generation, config validation/save/restart.
- Two-tab config conflict: stale save rejected, draft retained, explicit reload
  retrieves newer content.
- First-run onboarding settles with no additional idle WebSocket requests.
- All settings sections inspected at desktop and 390px widths; no horizontal
  page overflow. Green/Cognac/Dark switching and persistence checked.
- Sidebar background, border, shadow and transform unchanged on hover.
- Docker bridge file write/read and shell execution passed in a disposable,
  network-isolated container.

## Coverage limits

Real provider sign-ins, paid model requests and live third-party search/GitHub
operations need account-owner acceptance. Provider flows have fake-provider
regression coverage. macOS Keychain and multi-process external config editors
were not exercised. Config serialization covers this server's writers; a separate
process editing the file in the narrow read-to-rename window is not locked out.
