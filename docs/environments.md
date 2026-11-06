# Per-bot environments

By default (`[environment] backend = "none"`) bots have no coding tools. With

```toml
[environment]
backend = "docker"
# image = "pi-bot-env:latest"   # default: built from packages/server/docker on first use
```

every bot gets its own Docker container, and its `bash`, `read`, `write` and `edit` tools run
there. This also holds for Claude via the Agent SDK: Claude Code runs on the server with no
built-in tools, and Pi Bot executes its tool calls in the container.

On a Mac with macOS 26 or later, `backend = "container"` runs the same image through Apple's
[`container`](https://github.com/apple/container) instead; see [below](#apple-container).

## Image

`packages/server/docker`: Ubuntu 26.04 with git, openssh-client, Node 26, Python 3, build tools,
ripgrep, jq, Playwright with Chromium, and tini. It is built on first use and tagged
`pi-bot-env:<hash of the image files>` plus `:latest`; a changed Dockerfile gives a new tag for new
containers, while existing containers keep their image.

The environment dependencies are locked in `package-lock.json` and installed with `npm ci`.
The lockfile is part of the image hash, so dependency-only updates also produce a new image.

## Container

- Named `pi-bot-<bot id>`, started with `--restart unless-stopped`.
- Runs as the non-root user `bot` (uid 1000), who has passwordless sudo inside the container.
- Its own named volume, `pi-bot-<bot id>-workspace`, at `/workspace`.
- Full internet access on Docker's default network, and no CPU or memory limits.
- No host directories are mounted and there is no Docker socket.

## Lifecycle

Created on first use. At startup, the server makes sure every active bot's container exists and
runs (retrying while Docker starts) and stops containers of its own deleted bots; containers of
bots it does not know, such as another Pi Bot instance on the same Docker daemon, are left alone.
Soft delete stops the container; restore starts it again. Pi Bot removes a container and its volume only when you
permanently delete a deleted bot (`docker rm -f pi-bot-<id>`, then `docker volume rm
pi-bot-<id>-workspace`; either already missing is fine). If Docker is unavailable then, the bot's
data is still purged and Settings says the workspace was not removed, so you can remove it by hand.

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

## Apple container

```toml
[environment]
backend = "container"
# binary = "/usr/local/bin/container"   # when it isn't on PATH
# memory = "4g"                         # each bot's VM limit; 2g, 4g or 8g by the Mac's memory
# cpus = 8                              # each bot's VM; all of them by default
# idle_stop_minutes = 5                 # 0: never
```

Each bot gets its own lightweight VM, and there is no shared VM to keep running. That is what
makes it the choice for a Mac: measured on a 32 GB Mac mini with this image, Docker Desktop held
3.8 GB with no containers and 6.9 GB after building the image, and kept it, while Apple's held
22 MB with no containers and about 500 MB for each idle bot. File and CPU work ran at about the
same speed in both.

A VM keeps the memory it has touched until it stops, so a bot that has run a build holds on to it.
The server therefore works differently than with Docker:

- **Containers start on first use**, not at server startup.
- **An idle container stops** after `idle_stop_minutes` with no tool call and nothing still running
  in it, which gives its memory back. A dev server or a long job keeps it up. Its files stay, and
  the next tool call starts it again in about a second, with `/tmp` and installed packages intact.
- **Containers stop when the server does**, and there is no restart policy.
- **The image builds at server startup**, in a builder VM that is removed afterward so it stops
  holding memory.
- **`--memory` limits each VM.** The default leaves room for Chromium and most builds. A build that
  needs more can set `memory`.

The services start on demand with `container system start`, which downloads Apple's recommended
kernel the first time. A new volume starts empty and root-owned, so the server gives `/workspace`
to `bot` itself; Docker copies that from the image.

## Runtime refresh — November 2, 2026

Pi Durable, pi-ai, and Chord are pinned to 1.5.0 in the server and container lockfiles.
The six exact Pi 1.5.0 package-age exceptions and Chord's ws 8.22.1 peer allowance
were explicitly approved for this update; no blanket exception is enabled.

Pi 1.5 removed event streams. The WebSocket bridge now watches conversation revisions,
diffs partial replies, recovers skipped transcript windows, and maps live state to the
existing client protocol. SQLite views forward counted writes, lifecycle callbacks use
the new report/end shapes, and remote file watchers implement idempotent stop.

Validation: full build/typecheck/lint/tests; no outdated workspace dependencies,
peer issues, or audit findings; disposable 1.4.1 SQLite history reopened and continued
on 1.5.0; container file/shell operations and Chromium 156.0.8078.4; isolated faux-model
browser chat, reload, settings, and sidebar hover checks. Real provider authentication
was not exercised.
