# Per-bot environments (Docker)

By default (`[environment] backend = "none"`) bots have no coding tools. With

```toml
[environment]
backend = "docker"
# image = "pi-bot-env:latest"   # default: built from packages/server/docker on first use
```

every bot gets its own Docker container, and its `bash`, `read`, `write` and `edit` tools run
there. This also holds for Claude via the Agent SDK: Claude Code runs on the server with no
built-in tools, and Pi Bot executes its tool calls in the container.

## Image

`packages/server/docker`: Ubuntu 24.04 with git, openssh-client, Node 24, Python 3, build tools,
ripgrep, jq, Playwright with Chromium, and tini. It is built on first use and tagged
`pi-bot-env:<hash of the image files>` plus `:latest`; a changed Dockerfile gives a new tag for new
containers, while existing containers keep their image.

## Container

- Named `pi-bot-<bot id>`, started with `--restart unless-stopped`.
- Runs as the non-root user `bot` (uid 1000), who has passwordless sudo inside the container.
- Its own named volume, `pi-bot-<bot id>-workspace`, at `/workspace`.
- Full internet access on Docker's default network, and no CPU or memory limits.
- No host directories are mounted and there is no Docker socket.

## Lifecycle

Created on first use. At startup, the server makes sure every active bot's container exists and
runs (retrying while Docker starts) and stops containers of deleted bots. Soft delete stops the
container; restore starts it again. Containers and volumes are never removed by Pi Bot.

## Bridge

The server runs `docker exec -i -u bot … node /opt/pibot-env/agent.mjs`, a small agent that serves
Pi Durable's execution environment over JSON lines on stdio. `docker exec` doesn't pass the
server's environment, so model and search credentials stay on the host.

## Git

The SSH key and identity from Settings → GitHub (generated server-side, or a pasted unencrypted
OpenSSH key) are written into every container: the private key at `~/.ssh/id_pibot_github`
(0600), an `~/.ssh/config` entry, GitHub's pinned host keys, and `git config --global`
`user.name`/`user.email`. This happens when the container starts and again whenever they change in
Settings. Every bot can therefore use that key; give it only the access you want bots to have.
