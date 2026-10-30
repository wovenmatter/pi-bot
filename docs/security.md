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
- `[credentials] backend = "auto"` would use the macOS Keychain on a Mac, but that store is a stub,
  so it falls back to encrypted SQLite everywhere; `backend = "keychain"` fails at startup.
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
seen stays in `pi-bot.sqlite`. Protect the data dir and its backups accordingly.
