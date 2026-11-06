import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { BotEnvironmentAdapter, HarnessEnvFactory } from "../env.ts";
import { GITHUB_KNOWN_HOSTS } from "../settings/github-hosts.ts";
import {
  type ContainerEngine,
  type ContainerState,
  type DockerCli,
  DockerEngine,
  type DockerResult,
  nodeDockerCli,
} from "./engine.ts";
import { AgentConnection, RemoteExecutionEnv } from "./remote.ts";

export type { DockerCli, DockerResult } from "./engine.ts";
export { nodeDockerCli } from "./engine.ts";

/** The GitHub SSH key and git identity from Settings, written into every bot container. */
export type GitMaterial = {
  readonly privateKey?: string;
  readonly publicKey?: string;
  readonly name?: string;
  readonly email?: string;
};

export const CONTAINER_USER = "bot";
export const WORKSPACE = "/workspace";
const BOT_LABEL = "pi-bot.bot";
const AGENT_COMMAND = ["node", "/opt/pibot-env/agent.mjs"];
const IMAGE_FILES = [
  "Dockerfile",
  ".dockerignore",
  "package.json",
  "package-lock.json",
  "agent.mjs",
];
/** packages/server/docker, from src/environment or dist/environment alike. */
export const DEFAULT_CONTEXT_DIR = fileURLToPath(new URL("../../docker/", import.meta.url));

export function containerName(botId: string): string {
  return `pi-bot-${botId}`;
}

export function volumeName(botId: string): string {
  return `pi-bot-${botId}-workspace`;
}

export type DockerEnvironmentOptions = {
  readonly docker?: DockerCli;
  /** The container runtime; Docker through `docker` when absent. */
  readonly engine?: ContainerEngine;
  /**
   * Stop a bot's container after this long with no tool call and nothing left running in it. Its
   * memory goes back to the host, its files stay, and the next tool call starts it again.
   */
  readonly idleStopMs?: number;
  /** Start containers on first use instead of at server startup. */
  readonly lazy?: boolean;
  /** Image to run; defaults to `pi-bot-env:<hash of the build context>`, built when missing. */
  readonly image?: string;
  readonly contextDir?: string;
  /** Current SSH key and identity; read on every container start and on `gitChanged()`. */
  readonly git?: () => Promise<GitMaterial>;
  readonly log?: (message: string) => void;
};

/**
 * One Docker container per bot: Ubuntu LTS with git, Node, Python, build tools and Playwright +
 * Chromium, run as the non-root `bot` user (passwordless sudo) with the bot's own named volume at
 * /workspace. Nothing from the host is mounted, there is no Docker socket, no resource limits and
 * full network. Created on first use (`--restart unless-stopped`), stopped on soft delete (volume
 * kept), started again on restore, removed with its volume only on the user's purge, and reconciled at
 * server startup. Every tool call runs in the
 * container through the environment agent; model and search credentials never enter it.
 */
export class DockerEnvironmentAdapter implements BotEnvironmentAdapter {
  readonly kind: string;
  readonly #engine: ContainerEngine;
  readonly #options: DockerEnvironmentOptions;
  readonly #log: (message: string) => void;
  readonly #connections = new Map<string, AgentConnection>();
  readonly #locks = new Map<string, Promise<unknown>>();
  /** Bots whose container this process has started or adopted (and synced git into). */
  readonly #ready = new Set<string>();
  /** When each started bot last used its container; only kept while idle stopping is on. */
  readonly #lastUse = new Map<string, number>();
  #idleTimer: NodeJS.Timeout | undefined;
  #image: Promise<string> | undefined;

  constructor(options: DockerEnvironmentOptions = {}) {
    this.#options = options;
    this.#engine = options.engine ?? new DockerEngine(options.docker ?? nodeDockerCli());
    this.kind = this.#engine.kind;
    this.#log = options.log ?? (() => {});
  }

  harnessEnv(botId: string): HarnessEnvFactory {
    return (target) => {
      const cwd =
        target.cwd && (target.cwd === WORKSPACE || target.cwd.startsWith(`${WORKSPACE}/`))
          ? target.cwd
          : WORKSPACE;
      return new RemoteExecutionEnv(
        `${this.kind}:${containerName(botId)}`,
        cwd,
        this.#connection(botId),
      );
    };
  }

  #connection(botId: string): AgentConnection {
    let connection = this.#connections.get(botId);
    if (!connection) {
      connection = new AgentConnection(
        async () => {
          await this.ensure(botId);
          return this.#engine.spawn(
            this.#engine.execArgs(
              containerName(botId),
              { user: CONTAINER_USER, cwd: WORKSPACE },
              AGENT_COMMAND,
            ),
          );
        },
        this.#log,
        () => this.#touch(botId),
      );
      this.#connections.set(botId, connection);
    }
    return connection;
  }

  /** Serialize lifecycle operations per bot. */
  #locked<T>(botId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(botId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    this.#locks.set(botId, next);
    // Not `finally`: that copy would re-reject with no handler; the caller gets `next` itself.
    const release = () => {
      if (this.#locks.get(botId) === next) this.#locks.delete(botId);
    };
    next.then(release, release);
    return next;
  }

  /** The image tag, building it from the context directory when it does not exist yet. */
  image(): Promise<string> {
    if (!this.#image) {
      const pending = this.#resolveImage();
      this.#image = pending;
      pending.catch(() => {
        if (this.#image === pending) this.#image = undefined;
      });
    }
    return this.#image;
  }

  async #resolveImage(): Promise<string> {
    if (this.#options.image) return this.#options.image;
    const dir = this.#options.contextDir ?? DEFAULT_CONTEXT_DIR;
    const hash = createHash("sha256");
    for (const file of IMAGE_FILES) {
      hash
        .update(file)
        .update("\0")
        .update(await readFile(`${dir}/${file}`))
        .update("\0");
    }
    const tag = `pi-bot-env:${hash.digest("hex").slice(0, 12)}`;
    if (await this.#engine.imageExists(tag)) return tag;
    this.#log(`building bot environment image ${tag} (first run takes a few minutes)`);
    await this.#engine.build([tag, "pi-bot-env:latest"], dir);
    return tag;
  }

  state(botId: string): Promise<ContainerState> {
    return this.#engine.state(containerName(botId));
  }

  /** Make sure the bot's container exists and runs; sync git into it the first time. */
  ensure(botId: string): Promise<void> {
    return this.#locked(botId, async () => {
      const name = containerName(botId);
      const state = await this.state(botId);
      if (state === "missing") {
        const image = await this.image();
        await this.#engine.create({
          name,
          hostname: `bot-${botId.slice(0, 8)}`,
          labelKey: BOT_LABEL,
          labelValue: botId,
          volume: volumeName(botId),
          target: WORKSPACE,
          image,
          owner: CONTAINER_USER,
        });
        this.#log(`bot ${botId}: created container ${name}`);
        this.#ready.delete(botId);
      } else if (state === "stopped") {
        await this.#engine.start(name);
        this.#ready.delete(botId);
      }
      if (!this.#ready.has(botId)) {
        await this.#syncGit(botId);
        this.#ready.add(botId);
      }
      this.#touch(botId);
    });
  }

  async #must(args: readonly string[], what: string, input?: string): Promise<DockerResult> {
    const result = await this.#engine.run(args, input === undefined ? {} : { input });
    if (result.code !== 0) {
      throw new Error(`${this.#engine.cliName} ${what}: ${result.stderr.trim() || "failed"}`);
    }
    return result;
  }

  #touch(botId: string): void {
    const idle = this.#options.idleStopMs;
    if (!idle) return;
    this.#lastUse.set(botId, Date.now());
    if (!this.#idleTimer) {
      this.#idleTimer = setInterval(() => void this.#sweepIdle(), Math.min(idle, 60_000));
      this.#idleTimer.unref();
    }
  }

  /** Tests run the same sweep the timer does, without waiting for it. */
  sweepIdleForTest(): Promise<void> {
    return this.#sweepIdle();
  }

  async #sweepIdle(): Promise<void> {
    for (const botId of [...this.#lastUse.keys()]) {
      await this.#stopIfIdle(botId).catch((error: unknown) =>
        this.#log(`bot ${botId}: idle stop: ${(error as Error).message}`),
      );
    }
  }

  /** Inside the bot's lock, so a tool call arriving now waits and then starts it again. */
  #stopIfIdle(botId: string): Promise<void> {
    const idle = this.#options.idleStopMs ?? 0;
    const due = () => {
      const last = this.#lastUse.get(botId);
      return last !== undefined && Date.now() - last >= idle && !this.#connections.get(botId)?.busy;
    };
    if (!due()) return Promise.resolve();
    return this.#locked(botId, async () => {
      if (!due()) return;
      const name = containerName(botId);
      if (await this.#hasRunningWork(name)) {
        this.#touch(botId); // A dev server or a long job: leave it alone and look again later.
        return;
      }
      if (!due()) return;
      this.#connections.get(botId)?.close();
      this.#ready.delete(botId);
      this.#lastUse.delete(botId);
      await this.#engine.stop(name);
      this.#log(`bot ${botId}: stopped idle container ${name}`);
    });
  }

  /** Anything besides the container's init and the environment agent. */
  async #hasRunningWork(name: string): Promise<boolean> {
    const listed = await this.#engine.run(
      this.#engine.execArgs(name, { user: "root" }, ["ps", "-eo", "pid=,args="]),
    );
    if (listed.code !== 0) return false; // Already stopped, or gone.
    return listed.stdout.split("\n").some((line) => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!match) return false;
      const [, pid, command = ""] = match;
      if (pid === "1") return false;
      return !/^(\/usr\/bin\/tini\b|sleep infinity$|ps -eo |node \/opt\/pibot-env\/agent\.mjs)/.test(
        command,
      );
    });
  }

  /** Soft delete: stop the container and its agent, keep the container and its volume. */
  dispose(botId: string): Promise<void> {
    // Kept in the map (not deleted) so `close()` still reaches it if it is used again.
    this.#connections.get(botId)?.close();
    return this.#locked(botId, async () => {
      this.#ready.delete(botId);
      this.#lastUse.delete(botId);
      await this.#engine.stop(containerName(botId));
    });
  }

  /**
   * Purge (user-only, for an already soft-deleted bot): remove its container and its workspace
   * volume. Either one already missing is fine; Docker unreachable or any other failure throws.
   */
  purge(botId: string): Promise<void> {
    this.#connections.get(botId)?.close();
    this.#connections.delete(botId);
    return this.#locked(botId, async () => {
      this.#ready.delete(botId);
      this.#lastUse.delete(botId);
      const container = containerName(botId);
      const volume = volumeName(botId);
      const remove = async (what: string, run: () => Promise<void>) => {
        await run().catch((error: unknown) => {
          throw new Error(`${this.#engine.cliName} remove ${what}: ${(error as Error).message}`);
        });
      };
      // The container first: a volume in use cannot be removed.
      await remove(`container ${container}`, () => this.#engine.remove(container));
      await remove(`volume ${volume}`, () => this.#engine.removeVolume(volume));
      this.#log(`bot ${botId}: removed container ${container} and volume ${volume}`);
    });
  }

  /** Restore: start the bot's container again (created if it never existed). */
  restore(botId: string): Promise<void> {
    return this.ensure(botId);
  }

  /**
   * Startup: every active bot's container exists and runs; containers of this server's
   * soft-deleted bots are stopped. Containers of bots this server doesn't know (another Pi Bot
   * instance on the same Docker daemon) are left alone. Never removes containers or volumes.
   */
  async reconcile(
    activeBotIds: readonly string[],
    deletedBotIds: readonly string[] = [],
  ): Promise<void> {
    const deleted = new Set(deletedBotIds);
    await this.#engine.ping();
    if (this.#options.lazy) {
      // Ready before the first tool call needs it, which then waits only for a container.
      void this.image().catch((error: unknown) =>
        this.#log(`environment image: ${(error as Error).message}`),
      );
    } else {
      for (const botId of activeBotIds) {
        try {
          await this.ensure(botId);
        } catch (error) {
          this.#log(`bot ${botId}: environment: ${(error as Error).message}`);
        }
      }
    }
    const active = new Set(activeBotIds);
    for (const botId of await this.#engine.running(BOT_LABEL).catch(() => [])) {
      if (deleted.has(botId)) await this.dispose(botId).catch(() => {});
      // Left running by the last server: count it as just used, so idle stopping can reach it.
      else if (active.has(botId)) this.#touch(botId);
    }
  }

  /** Settings changed the SSH key or git identity: rewrite it in every running container. */
  async gitChanged(): Promise<void> {
    for (const botId of [...this.#ready]) {
      await this.#locked(botId, () => this.#syncGit(botId)).catch((error: unknown) =>
        this.#log(`bot ${botId}: git sync: ${(error as Error).message}`),
      );
    }
  }

  /** `~/.ssh` (0700; key, config and known_hosts 0600) and `git config --global` for `bot`. */
  async #syncGit(botId: string): Promise<void> {
    const material = (await this.#options.git?.()) ?? {};
    const name = containerName(botId);
    const exec = (script: string, input?: string, ...args: string[]) =>
      this.#must(
        this.#engine.execArgs(name, { user: CONTAINER_USER }, ["sh", "-c", script, "sh", ...args]),
        "git sync",
        input,
      );
    await exec(
      [
        "set -e",
        "umask 077",
        "mkdir -p ~/.ssh && chmod 700 ~/.ssh",
        "touch ~/.ssh/known_hosts && chmod 600 ~/.ssh/known_hosts",
        "grep -v '^github.com ' ~/.ssh/known_hosts > ~/.ssh/known_hosts.tmp || true",
        "cat >> ~/.ssh/known_hosts.tmp && mv ~/.ssh/known_hosts.tmp ~/.ssh/known_hosts",
        "printf 'Host github.com\\n  User git\\n  IdentityFile ~/.ssh/id_pibot_github\\n  IdentitiesOnly yes\\n' > ~/.ssh/config",
        "chmod 600 ~/.ssh/config",
      ].join("\n"),
      `${GITHUB_KNOWN_HOSTS.join("\n")}\n`,
    );
    if (material.privateKey) {
      const key = material.privateKey.endsWith("\n")
        ? material.privateKey
        : `${material.privateKey}\n`;
      await exec(
        "set -e; umask 077; cat > ~/.ssh/id_pibot_github.tmp && chmod 600 ~/.ssh/id_pibot_github.tmp && mv ~/.ssh/id_pibot_github.tmp ~/.ssh/id_pibot_github",
        key,
      );
      await exec(
        "set -e; umask 077; cat > ~/.ssh/id_pibot_github.pub && chmod 600 ~/.ssh/id_pibot_github.pub",
        material.publicKey ? `${material.publicKey.trim()}\n` : "",
      );
    } else {
      await exec("rm -f ~/.ssh/id_pibot_github ~/.ssh/id_pibot_github.pub");
    }
    const identity = (key: string, value: string | undefined) =>
      value
        ? exec('git config --global "$1" "$2"', undefined, key, value)
        : exec('git config --global --unset "$1" || true', undefined, key);
    await identity("user.name", material.name);
    await identity("user.email", material.email ?? "bot@pi-bot.invalid");
  }

  /**
   * Server shutdown with idle stopping on: the same stop that idle time would do, because nothing
   * else would stop these containers while the server is down. They start again on next use.
   */
  async shutdown(): Promise<void> {
    this.close();
    const bots = [...this.#lastUse.keys()];
    this.#lastUse.clear();
    this.#ready.clear();
    await Promise.race([
      Promise.allSettled([
        ...bots.map((botId) => this.#engine.stop(containerName(botId))),
        this.#engine.cancel?.(),
      ]),
      new Promise((resolve) => setTimeout(resolve, 15_000).unref()),
    ]);
  }

  /** Stop every agent connection (server shutdown); containers keep running. */
  close(): void {
    if (this.#idleTimer) clearInterval(this.#idleTimer);
    this.#idleTimer = undefined;
    for (const connection of this.#connections.values()) connection.close();
    this.#connections.clear();
  }
}

export { GITHUB_KNOWN_HOSTS } from "../settings/github-hosts.ts";
