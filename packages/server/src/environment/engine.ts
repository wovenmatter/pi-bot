import { spawn } from "node:child_process";
import type { AgentProcess } from "./remote.ts";

export type DockerResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type RunOptions = {
  readonly input?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
};

/** The `docker` CLI. Tests substitute a fake; nothing here talks to the Docker socket directly. */
export interface DockerCli {
  run(args: readonly string[], options?: RunOptions): Promise<DockerResult>;
  /** A long-lived `docker exec -i …` whose stdio carries the environment agent. */
  spawn(args: readonly string[]): AgentProcess;
}

/**
 * Only what the runtime's CLI itself needs. `exec` never forwards the server's environment
 * into a container, and this keeps the CLI child free of anything else the server holds.
 */
function cliEnv(): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "USER", "XDG_RUNTIME_DIR", "DOCKER_HOST", "DOCKER_CONTEXT"];
  return Object.fromEntries(
    keep.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
  );
}

export function nodeDockerCli(binary = "docker"): DockerCli {
  return {
    run(args, options = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn(binary, args, {
          env: cliEnv(),
          stdio: "pipe",
          ...(options.signal ? { signal: options.signal } : {}),
        });
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
      return spawn(binary, args, { env: cliEnv(), stdio: ["pipe", "pipe", "pipe"] });
    },
  };
}

export type ContainerState = "missing" | "running" | "stopped";

export type ContainerSpec = {
  readonly name: string;
  readonly hostname: string;
  readonly labelKey: string;
  readonly labelValue: string;
  readonly volume: string;
  /** Where the volume mounts. */
  readonly target: string;
  readonly image: string;
  /** The account that owns the volume's root, as Docker gives a new volume from its image. */
  readonly owner: string;
};

/** What a bot environment needs from a container runtime. Missing things are never errors. */
export interface ContainerEngine {
  /** `docker` or `container`, the same word as `[environment] backend`. */
  readonly kind: string;
  /** The CLI's name, for messages. */
  readonly cliName: string;
  run(args: readonly string[], options?: RunOptions): Promise<DockerResult>;
  spawn(args: readonly string[]): AgentProcess;
  /** Server shutdown: end a build in progress and whatever it holds. */
  cancel?(): Promise<void>;
  /** Throws when the runtime can't be reached. */
  ping(): Promise<void>;
  imageExists(tag: string): Promise<boolean>;
  build(tags: readonly string[], dir: string): Promise<void>;
  state(name: string): Promise<ContainerState>;
  create(spec: ContainerSpec): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  removeVolume(name: string): Promise<void>;
  execArgs(
    name: string,
    options: { readonly user: string; readonly cwd?: string },
    command: readonly string[],
  ): string[];
  /** The label's value on each running container that has it. */
  running(label: string): Promise<string[]>;
}

export class DockerEngine implements ContainerEngine {
  readonly kind = "docker";
  readonly cliName = "docker";
  readonly #cli: DockerCli;

  constructor(cli: DockerCli) {
    this.#cli = cli;
  }

  run(args: readonly string[], options?: RunOptions) {
    return this.#cli.run(args, options);
  }

  spawn(args: readonly string[]): AgentProcess {
    return this.#cli.spawn(args);
  }

  async ping(): Promise<void> {
    const ping = await this.#cli.run(["version", "--format", "{{.Server.Version}}"]);
    if (ping.code !== 0) throw new Error(`docker is not reachable: ${ping.stderr.trim()}`);
  }

  async imageExists(tag: string): Promise<boolean> {
    return (await this.#cli.run(["image", "inspect", tag])).code === 0;
  }

  async build(tags: readonly string[], dir: string): Promise<void> {
    const built = await this.#cli.run(["build", ...tags.flatMap((tag) => ["-t", tag]), dir], {
      timeoutMs: 60 * 60_000,
    });
    if (built.code !== 0) {
      throw new Error(
        `docker build failed: ${built.stderr.trim().split("\n").slice(-5).join(" ")}`,
      );
    }
  }

  async state(name: string): Promise<ContainerState> {
    const result = await this.#cli.run(["container", "inspect", "-f", "{{.State.Running}}", name]);
    if (result.code !== 0) {
      if (/no such (container|object)/i.test(result.stderr)) return "missing";
      throw new Error(`docker: ${result.stderr.trim() || "container inspect failed"}`);
    }
    return result.stdout.trim() === "true" ? "running" : "stopped";
  }

  async create(spec: ContainerSpec): Promise<void> {
    await this.#must(
      [
        "run",
        "-d",
        "--name",
        spec.name,
        "--hostname",
        spec.hostname,
        "--restart",
        "unless-stopped",
        "--label",
        `${spec.labelKey}=${spec.labelValue}`,
        "--mount",
        `type=volume,source=${spec.volume},target=${spec.target}`,
        spec.image,
      ],
      "create container",
    );
  }

  async start(name: string): Promise<void> {
    await this.#must(["start", name], "start container");
  }

  async stop(name: string): Promise<void> {
    const result = await this.#cli.run(["stop", "-t", "10", name]);
    if (result.code !== 0 && !/no such container/i.test(result.stderr)) {
      throw new Error(`docker stop container: ${result.stderr.trim()}`);
    }
  }

  async remove(name: string): Promise<void> {
    const result = await this.#cli.run(["rm", "-f", name]);
    if (result.code !== 0 && !/no such container/i.test(result.stderr)) {
      throw new Error(result.stderr.trim() || "failed");
    }
  }

  async removeVolume(name: string): Promise<void> {
    const result = await this.#cli.run(["volume", "rm", name]);
    if (result.code !== 0 && !/no such volume/i.test(result.stderr)) {
      throw new Error(result.stderr.trim() || "failed");
    }
  }

  execArgs(
    name: string,
    options: { readonly user: string; readonly cwd?: string },
    command: readonly string[],
  ): string[] {
    return [
      "exec",
      "-i",
      "-u",
      options.user,
      ...(options.cwd ? ["-w", options.cwd] : []),
      name,
      ...command,
    ];
  }

  async running(label: string): Promise<string[]> {
    const listed = await this.#cli.run([
      "ps",
      "--filter",
      `label=${label}`,
      "--format",
      `{{.Label "${label}"}}`,
    ]);
    if (listed.code !== 0) return [];
    return listed.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async #must(args: readonly string[], what: string): Promise<void> {
    const result = await this.#cli.run(args);
    if (result.code !== 0) throw new Error(`docker ${what}: ${result.stderr.trim() || "failed"}`);
  }
}
