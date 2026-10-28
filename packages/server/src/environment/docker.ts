import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { BotEnvironmentAdapter, HarnessEnvFactory } from "../env.ts";
import { AgentConnection, type AgentProcess, RemoteExecutionEnv } from "./remote.ts";

export type DockerResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

/** The `docker` CLI. Tests substitute a fake; nothing here talks to the Docker socket directly. */
export interface DockerCli {
  run(
    args: readonly string[],
    options?: { readonly input?: string; readonly timeoutMs?: number },
  ): Promise<DockerResult>;
  /** A long-lived `docker exec -i …` whose stdio carries the environment agent. */
  spawn(args: readonly string[]): AgentProcess;
}

/**
 * Only what the docker CLI itself needs. `docker exec` never forwards the server's environment
 * into a container, and this keeps the CLI child free of anything else the server holds.
 */
function dockerCliEnv(): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "USER", "XDG_RUNTIME_DIR", "DOCKER_HOST", "DOCKER_CONTEXT"];
  return Object.fromEntries(
    keep.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
  );
}

export function nodeDockerCli(binary = "docker"): DockerCli {
  return {
    run(args, options = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn(binary, args, { env: dockerCliEnv(), stdio: "pipe" });
        let stdout = "";
        let stderr = "";
        const timer = options.timeoutMs
          ? setTimeout(() => child.kill("SIGTERM"), options.timeoutMs)
          : undefined;
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on("error", (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code) => {
          if (timer) clearTimeout(timer);
          resolve({ code: code ?? 1, stdout, stderr });
        });
        child.stdin.end(options.input ?? "");
      });
    },
    spawn(args) {
      return spawn(binary, args, { env: dockerCliEnv(), stdio: ["pipe", "pipe", "pipe"] });
    },
  };
}

/** The GitHub SSH key and git identity from Settings, written into every bot container. */
export type GitMaterial = {
  readonly privateKey?: string;
  readonly publicKey?: string;
  readonly name?: string;
  readonly email?: string;
};

/** GitHub's published SSH host keys (api.github.com/meta), pinned in each container. */
export const GITHUB_KNOWN_HOSTS = [
  "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
  "github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=",
  "github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=",
];

export const CONTAINER_USER = "bot";
export const WORKSPACE = "/workspace";
const BOT_LABEL = "pi-bot.bot";
const AGENT_COMMAND = ["node", "/opt/pibot-env/agent.mjs"];
const IMAGE_FILES = ["Dockerfile", ".dockerignore", "package.json", "agent.mjs"];
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
  /** Image to run; defaults to `pi-bot-env:<hash of the build context>`, built when missing. */
  readonly image?: string;
  readonly contextDir?: string;
  /** Current SSH key and identity; read on every container start and on `gitChanged()`. */
  readonly git?: () => Promise<GitMaterial>;
  readonly log?: (message: string) => void;
};

type ContainerState = "missing" | "running" | "stopped";

/**
 * One Docker container per bot: Ubuntu LTS with git, Node, Python, build tools and Playwright +
 * Chromium, run as the non-root `bot` user (passwordless sudo) with the bot's own named volume at
 * /workspace. Nothing from the host is mounted, there is no Docker socket, no resource limits and
 * full network. Created on first use (`--restart unless-stopped`), stopped on soft delete (volume
 * kept), started again on restore, and reconciled at server startup. Every tool call runs in the
 * container through the environment agent; model and search credentials never enter it.
 */
export class DockerEnvironmentAdapter implements BotEnvironmentAdapter {
  readonly kind = "docker";
  readonly #docker: DockerCli;
  readonly #options: DockerEnvironmentOptions;
  readonly #log: (message: string) => void;
  readonly #connections = new Map<string, AgentConnection>();
  readonly #locks = new Map<string, Promise<unknown>>();
  /** Bots whose container this process has started or adopted (and synced git into). */
  readonly #ready = new Set<string>();
  #image: Promise<string> | undefined;

  constructor(options: DockerEnvironmentOptions = {}) {
    this.#options = options;
    this.#docker = options.docker ?? nodeDockerCli();
    this.#log = options.log ?? (() => {});
  }

  harnessEnv(botId: string): HarnessEnvFactory {
    return (target) => {
      const cwd =
        target.cwd && (target.cwd === WORKSPACE || target.cwd.startsWith(`${WORKSPACE}/`))
          ? target.cwd
          : WORKSPACE;
      return new RemoteExecutionEnv(`docker:${containerName(botId)}`, cwd, this.#connection(botId));
    };
  }

  #connection(botId: string): AgentConnection {
    let connection = this.#connections.get(botId);
    if (!connection) {
      connection = new AgentConnection(async () => {
        await this.ensure(botId);
        return this.#docker.spawn([
          "exec",
          "-i",
          "-u",
          CONTAINER_USER,
          "-w",
          WORKSPACE,
          containerName(botId),
          ...AGENT_COMMAND,
        ]);
      }, this.#log);
      this.#connections.set(botId, connection);
    }
    return connection;
  }

  /** Serialize lifecycle operations per bot. */
  #locked<T>(botId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(botId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    this.#locks.set(botId, next);
    void next.finally(() => {
      if (this.#locks.get(botId) === next) this.#locks.delete(botId);
    });
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
    if ((await this.#docker.run(["image", "inspect", tag])).code === 0) return tag;
    this.#log(`building bot environment image ${tag} (first run takes a few minutes)`);
    const built = await this.#docker.run(["build", "-t", tag, "-t", "pi-bot-env:latest", dir], {
      timeoutMs: 60 * 60_000,
    });
    if (built.code !== 0) {
      throw new Error(
        `docker build failed: ${built.stderr.trim().split("\n").slice(-5).join(" ")}`,
      );
    }
    return tag;
  }

  async state(botId: string): Promise<ContainerState> {
    const result = await this.#docker.run([
      "container",
      "inspect",
      "-f",
      "{{.State.Running}}",
      containerName(botId),
    ]);
    if (result.code !== 0) {
      if (/no such (container|object)/i.test(result.stderr)) return "missing";
      throw new Error(`docker: ${result.stderr.trim() || "container inspect failed"}`);
    }
    return result.stdout.trim() === "true" ? "running" : "stopped";
  }

  /** Make sure the bot's container exists and runs; sync git into it the first time. */
  ensure(botId: string): Promise<void> {
    return this.#locked(botId, async () => {
      const name = containerName(botId);
      const state = await this.state(botId);
      if (state === "missing") {
        const image = await this.image();
        await this.#must(
          [
            "run",
            "-d",
            "--name",
            name,
            "--hostname",
            `bot-${botId.slice(0, 8)}`,
            "--restart",
            "unless-stopped",
            "--label",
            `${BOT_LABEL}=${botId}`,
            "--mount",
            `type=volume,source=${volumeName(botId)},target=${WORKSPACE}`,
            image,
          ],
          "create container",
        );
        this.#log(`bot ${botId}: created container ${name}`);
        this.#ready.delete(botId);
      } else if (state === "stopped") {
        await this.#must(["start", name], "start container");
        this.#ready.delete(botId);
      }
      if (!this.#ready.has(botId)) {
        await this.#syncGit(botId);
        this.#ready.add(botId);
      }
    });
  }

  async #must(args: readonly string[], what: string, input?: string): Promise<DockerResult> {
    const result = await this.#docker.run(args, input === undefined ? {} : { input });
    if (result.code !== 0) throw new Error(`docker ${what}: ${result.stderr.trim() || "failed"}`);
    return result;
  }

  /** Soft delete: stop the container and its agent, keep the container and its volume. */
  dispose(botId: string): Promise<void> {
    this.#connections.get(botId)?.close();
    this.#connections.delete(botId);
    return this.#locked(botId, async () => {
      this.#ready.delete(botId);
      const result = await this.#docker.run(["stop", "-t", "10", containerName(botId)]);
      if (result.code !== 0 && !/no such container/i.test(result.stderr)) {
        throw new Error(`docker stop container: ${result.stderr.trim()}`);
      }
    });
  }

  /** Restore: start the bot's container again (created if it never existed). */
  restore(botId: string): Promise<void> {
    return this.ensure(botId);
  }

  /**
   * Startup: every active bot's container exists and runs; containers of bots that are not
   * active (soft-deleted) are stopped. Never removes containers or volumes.
   */
  async reconcile(activeBotIds: readonly string[]): Promise<void> {
    const active = new Set(activeBotIds);
    const ping = await this.#docker.run(["version", "--format", "{{.Server.Version}}"]);
    if (ping.code !== 0) throw new Error(`docker is not reachable: ${ping.stderr.trim()}`);
    for (const botId of activeBotIds) {
      try {
        await this.ensure(botId);
      } catch (error) {
        this.#log(`bot ${botId}: environment: ${(error as Error).message}`);
      }
    }
    const listed = await this.#docker.run([
      "ps",
      "--filter",
      `label=${BOT_LABEL}`,
      "--format",
      `{{.Label "${BOT_LABEL}"}}`,
    ]);
    if (listed.code !== 0) return;
    for (const botId of listed.stdout.split("\n").map((line) => line.trim())) {
      if (botId && !active.has(botId)) await this.dispose(botId).catch(() => {});
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
        ["exec", "-i", "-u", CONTAINER_USER, name, "sh", "-c", script, "sh", ...args],
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
    await identity("user.email", material.email);
  }

  /** Stop every agent connection (server shutdown); containers keep running. */
  close(): void {
    for (const connection of this.#connections.values()) connection.close();
    this.#connections.clear();
  }
}
