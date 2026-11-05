# Security

## Network: tailnet only, no app login

**Pi Bot has no app-level authentication.** Anyone who can reach its port can read every
conversation, change settings and accounts, and run tools. It relies on the network instead:

- The server binds only to loopback (`127.0.0.0/8`, `localhost`, `::1`) or Tailscale addresses
  (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`). Config validation and startup both refuse anything
  else.
- HTTP and WebSocket requests must carry a local `Host` (one of those addresses or a `*.ts.net`
  name). A browser `Origin`, when present, must be local too; non-browser clients without one
  are allowed.
- **Keep it tailnet-only. Never expose it publicly**: no `tailscale funnel`, no public reverse
  proxy, no port forwarding. To use it from other devices, keep it on loopback and use
  `tailscale serve --bg --https=10443 http://127.0.0.1:4317`, which only your tailnet can reach.

## Credentials

- Stored in an encrypted SQLite table in the shared database, AES-256-GCM, with a key file
  (default `<data_dir>/credentials.key`, mode 0600). The database is 0600 and the data dir 0700.
- `[credentials] backend = "auto"` uses the macOS Keychain on a Mac when `/usr/bin/security` and a
  default keychain work, else encrypted SQLite; Linux always uses encrypted SQLite.
  `backend = "keychain"` fails at startup off macOS or without `security`.
- Keychain layout: one generic password per provider (service `io.wovenmatter.pi-bot`, account =
  provider id, value = the credential JSON) plus an `_index` item listing provider ids and types.
  Items are per macOS user, so two instances under one user share them. Writes go through the
  `security` CLI (no native modules): the value is sent as hex on stdin to `security -i`, so it
  is not on any command line; values too long for one `security -i` line (over ~4000 characters
  of hex, e.g. large OAuth tokens) go on argv instead, where other local processes can briefly
  see them. Each write is read back to confirm it.
- The first time the Keychain store opens with no `_index` item, credentials already in encrypted
  SQLite are copied in (the SQLite rows stay). Later deletions are not copied back.
- Secrets are write-only: the UI shows at most the last four characters, no response carries a
  secret, `pi-bot credentials` lists provider and type only, and `config.toml` holds no secrets.
- Admin Bot never asks for secrets in chat; sign-ins and keys stay in Settings.
- See [providers-and-sign-in](providers-and-sign-in.md#claude-caveat) for the Claude token caveat.

## What enters a bot container

With Docker on ([environments](environments.md)):

- **Model and search credentials stay on the host**; `docker exec` doesn't pass the server's
  environment.
- **The GitHub SSH private key and git identity do enter every container**, so every bot can push
  wherever that key can. Use a key scoped to what bots should touch (for example, a deploy key or a
  dedicated account).
- Containers have full internet access, passwordless sudo for the `bot` user, and no resource
  limits. They get no host mounts and no Docker socket.

## Web tools

- `web_search` reads the search key from the credential store on each call and sends it only to
  that provider; keys never enter prompts, tool results or logs, and provider errors are reported
  without the response body.
- `fetch_url` runs on the host, so it refuses anything Pi Bot itself or the tailnet could be
  reached through: non-http(s) URLs and hosts that are, or resolve to, unspecified, loopback,
  private, link-local, CGNAT (`100.64.0.0/10`, the tailnet), multicast or reserved IPv4, or IPv6
  loopback, link-local, unique-local (`fc00::/7`, which holds the tailnet's `fd7a:115c:a1e0::/48`),
  multicast or NAT64 addresses (IPv4-mapped IPv6 is checked as IPv4). Redirects are followed by hand
  (at most 5) and every hop is checked again. Pages are capped (20 s, 2 MB read, 20,000 characters
  returned by default, at most 100,000).
- The check resolves the host before the request, and the request resolves it again, so a DNS
  server that answers differently the second time (DNS rebinding) could still slip through. With
  Docker on, a bot's container can reach the network anyway (see above).

## Data

Deleting a bot is a soft delete, and compaction never deletes history, so everything bots have
seen stays in `pi-bot.sqlite` until you permanently delete a deleted bot (which drops its tables
but not copies in backups or freed SQLite pages). Protect the data dir and its backups accordingly.


## Woven Matter integration

Woven-managed instances use their own config and data directory and explicitly select
`[credentials] backend = "encrypted-sqlite"`; the per-user Keychain service would share
credentials across instances. A Mac host with `[environment] backend = "none"` is validated
for this mode. Provider credentials stay in Pi Bot and never pass through the host bridge.

The Woven MCP bearer grant is stored in the dedicated `woven-mcp` credential slot. It is
write-only and absent from the Settings account catalog, config, prompts, logs and web/tool
responses. Only `woven.connect`, `woven.status` and `woven.disconnect` manage it; bots get no
connection-management tools. The endpoint must be HTTPS or HTTP on exactly `127.0.0.1`, `::1`
or `localhost`; URL credentials and fragments are refused, as are redirects. Requests send
`authorization: Bearer`, the bot UUID in `x-woven-bot-id`, and a percent-encoded bot name in
`x-woven-bot-name`, without an `origin` header. Attribution headers do not isolate bots from
one another: all bots in an installation share one trust domain.

Woven tools go only to bots' main channels and threads, including Admin Bot, and never to
subagent children. Woven controls tool authorization. Its principal identifies the installation
and bot without creating a Woven conversation. Only tools marked read-only and not explicitly
non-idempotent may replay. Local cache restoration makes startup independent of Woven availability.

Embedded mode has the same network trust boundary as standalone mode. Its JavaScript bridge
accepts navigation, theme, composer focus and bounded turn context; it exposes no arbitrary RPC,
files or secrets. Hosts validate frame and origin before accepting messages. Sidebar groups
change placement only and grant no additional authority.
