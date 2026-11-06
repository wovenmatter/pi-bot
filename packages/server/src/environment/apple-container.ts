import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type ContainerEngine,
  type ContainerSpec,
  type ContainerState,
  type DockerCli,
  type DockerResult,
  nodeDockerCli,
  type RunOptions,
} from "./engine.ts";
import type { AgentProcess } from "./remote.ts";

const GIB = 1024 ** 3;

/**
 * Each bot's lightweight VM can grow to this. Its memory only returns to the host when it stops,
 * so this is what one busy bot can cost before idle stopping gives it back.
 */
export function defaultMemory(total = totalmem()): string {
  if (total <= 8 * GIB) return "2g";
  if (total <= 16 * GIB) return "4g";
  return "8g";
}

export type AppleContainerOptions = {
  readonly cli?: DockerCli;
  readonly binary?: string;
  /** Where a private copy keeps its helpers; absent for an installed `container`. */
  readonly installRoot?: string;
  /** Where a private copy keeps images and containers. */
  readonly appRoot?: string;
  readonly memory?: string;
  readonly cpus?: number;
  readonly log?: (message: string) => void;
  /** How often to look again while another server has the builder. */
  readonly builderPollMs?: number;
};

export function builderMarker(): string {
  return join(tmpdir(), "pi-bot-container-builder");
}

/** Takes the builder for this server, unless another live server has it. */
function claimBuilder(): "claimed" | "interrupted" | "busy" {
  const marker = builderMarker();
  try {
    writeFileSync(marker, String(process.pid), { flag: "wx" });
    return "claimed";
  } catch {
    const owner = Number(readFileSync(marker, "utf8"));
    if (Number.isInteger(owner) && owner > 0 && owner !== process.pid) {
      try {
        process.kill(owner, 0);
        return "busy";
      } catch {
        // Its server is gone.
      }
    }
    writeFileSync(marker, String(process.pid));
    return "interrupted";
  }
}

/**
 * Apple's `container`: one lightweight VM per container, and no shared VM to keep running, so with
 * no bot working it holds almost no memory. It has no restart policy, so containers start on use.
 * A new named volume is empty and root-owned, unlike Docker's, which copies its image's folder.
 */
export class AppleContainerEngine implements ContainerEngine {
  readonly kind = "container";
  readonly cliName = "container";
  readonly #cli: DockerCli;
  readonly #options: AppleContainerOptions;
  readonly #memory: string;
  readonly #cpus: number;
  #starting: Promise<void> | undefined;
  #installingKernel: Promise<DockerResult> | undefined;
  #building: { readonly abort: AbortController; readonly done: Promise<void> } | undefined;

  constructor(options: AppleContainerOptions = {}) {
    this.#options = options;
    this.#cli = options.cli ?? nodeDockerCli(options.binary ?? "container");
    this.#memory = options.memory ?? defaultMemory();
    this.#cpus = options.cpus ?? availableParallelism();
  }

  run(args: readonly string[], options?: RunOptions) {
    return this.#cli.run(args, options);
  }

  spawn(args: readonly string[]): AgentProcess {
    return this.#cli.spawn(args);
  }

  /** Its services don't start at login, so reaching them includes starting them. */
  ping(): Promise<void> {
    if (!this.#starting) {
      const pending = this.#ensureServices().finally(() => {
        if (this.#starting === pending) this.#starting = undefined;
      });
      this.#starting = pending;
    }
    return this.#starting;
  }

  async #ensureServices(): Promise<void> {
    if ((await this.#cli.run(["system", "status"])).code === 0) return;
    this.#options.log?.("starting Apple container services");
    const location = [
      ...(this.#options.installRoot ? ["--install-root", this.#options.installRoot] : []),
      ...(this.#options.appRoot ? ["--app-root", this.#options.appRoot] : []),
    ];
    const started = await this.#cli.run(
      ["system", "start", "--enable-kernel-install", ...location],
      {
        timeoutMs: 15 * 60_000,
      },
    );
    if (started.code !== 0) {
      throw new Error(
        `container is not reachable: ${(started.stderr || started.stdout).trim().slice(-400)}`,
      );
    }
    // Installing the kernel leaves about 750 MB in the API server until it restarts.
    if (/installing kernel/i.test(started.stdout + started.stderr)) {
      await this.#cli.run(["system", "stop"]);
      const again = await this.#cli.run(
        ["system", "start", "--disable-kernel-install", ...location],
        {
          timeoutMs: 5 * 60_000,
        },
      );
      if (again.code !== 0) {
        throw new Error(
          `container is not reachable: ${(again.stderr || again.stdout).trim().slice(-400)}`,
        );
      }
    }
  }

  async imageExists(tag: string): Promise<boolean> {
    await this.ping();
    return (await this.#cli.run(["image", "inspect", tag])).code === 0;
  }

  /** Its builder VM would otherwise keep 2 GB or more after the build. */
  async build(tags: readonly string[], dir: string): Promise<void> {
    await this.ping();
    const abort = new AbortController();
    const done = this.#buildWith(tags, dir, abort.signal);
    const building = { abort, done: done.catch(() => {}) };
    this.#building = building;
    try {
      await done;
    } finally {
      if (this.#building === building) this.#building = undefined;
    }
  }

  async #buildWith(tags: readonly string[], dir: string, signal: AbortSignal): Promise<void> {
    // Apple has one builder per user, so a second server waits for the first and may find the
    // image already built. A marker whose server is gone means its build was interrupted.
    let claim = claimBuilder();
    while (claim === "busy") {
      await delay(this.#options.builderPollMs ?? 5000, undefined, { signal });
      if ((await this.#cli.run(["image", "inspect", tags[0] ?? ""])).code === 0) return;
      claim = claimBuilder();
    }
    // A builder already running is someone else's on an installed `container`. A private copy
    // has no one else to leave one.
    const status = await this.#cli.run(["builder", "status"]);
    const ours =
      this.#options.installRoot !== undefined ||
      !/\brunning\b/i.test(status.stdout) ||
      claim === "interrupted";
    let released = !ours;
    try {
      if (ours) {
        await this.#cli.run(["builder", "delete", "--force"]);
        const started = await this.#withKernel(
          ["builder", "start", "--cpus", String(this.#cpus), "--memory", "4g"],
          { timeoutMs: 10 * 60_000, signal },
        );
        if (started.code !== 0) {
          throw new Error(`container builder: ${started.stderr.trim().slice(-400) || "failed"}`);
        }
      }
      const built = await this.#cli.run(
        ["build", "--progress", "plain", ...tags.flatMap((tag) => ["-t", tag]), dir],
        { timeoutMs: 60 * 60_000, signal },
      );
      if (built.code !== 0) {
        throw new Error(
          `container build failed: ${(built.stderr || built.stdout).trim().split("\n").slice(-5).join(" ")}`,
        );
      }
    } finally {
      if (ours) {
        // Forced: a builder still starting when its start was cancelled can't be stopped first.
        released = (await this.#cli.run(["builder", "delete", "--force"])).code === 0;
      }
      if (released) rmSync(builderMarker(), { force: true });
    }
  }

  async cancel(): Promise<void> {
    const building = this.#building;
    if (!building) return;
    building.abort.abort();
    await building.done;
  }

  async state(name: string): Promise<ContainerState> {
    let result = await this.#cli.run(["inspect", name]);
    if (result.code !== 0 && /xpc|apiserver|system start/i.test(result.stderr)) {
      await this.ping();
      result = await this.#cli.run(["inspect", name]);
    }
    if (result.code !== 0) {
      if (/not found/i.test(result.stderr)) return "missing";
      throw new Error(`container: ${result.stderr.trim() || "inspect failed"}`);
    }
    const [record] = JSON.parse(result.stdout) as { status?: unknown }[];
    if (!record) return "missing";
    return stateOf(record.status) === "running" ? "running" : "stopped";
  }

  async create(spec: ContainerSpec): Promise<void> {
    await this.ping();
    const volume = await this.#cli.run(["volume", "create", spec.volume]);
    if (volume.code !== 0 && !/already exists/i.test(volume.stderr)) {
      throw new Error(`container create volume: ${volume.stderr.trim() || "failed"}`);
    }
    await this.#must(
      [
        "run",
        "-d",
        "--progress",
        "none",
        "--name",
        spec.name,
        "--label",
        `${spec.labelKey}=${spec.labelValue}`,
        "--memory",
        this.#memory,
        "--cpus",
        String(this.#cpus),
        "--mount",
        `type=volume,source=${spec.volume},target=${spec.target}`,
        spec.image,
      ],
      "create container",
    );
    await this.#must(
      ["exec", "-u", "root", spec.name, "chown", `${spec.owner}:${spec.owner}`, spec.target],
      "prepare volume",
    );
  }

  async start(name: string): Promise<void> {
    await this.ping();
    await this.#must(["start", name], "start container");
  }

  async stop(name: string): Promise<void> {
    const result = await this.#cli.run(["stop", "--time", "10", name]);
    if (result.code !== 0 && !/not ?found/i.test(result.stderr)) {
      throw new Error(`container stop: ${result.stderr.trim()}`);
    }
  }

  async remove(name: string): Promise<void> {
    await this.ping();
    const result = await this.#cli.run(["delete", "--force", name]);
    if (result.code !== 0 && !/not ?found/i.test(result.stderr)) {
      throw new Error(result.stderr.trim() || "failed");
    }
  }

  async removeVolume(name: string): Promise<void> {
    await this.ping();
    if ((await this.#cli.run(["volume", "inspect", name])).code !== 0) return;
    const result = await this.#cli.run(["volume", "delete", name]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || "failed");
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
    const listed = await this.#cli.run(["list", "--format", "json"]);
    if (listed.code !== 0) return [];
    const records = JSON.parse(listed.stdout) as {
      status?: unknown;
      configuration?: { labels?: Record<string, string> };
    }[];
    return records.flatMap((record) => {
      const value = record.configuration?.labels?.[label];
      return value && stateOf(record.status) === "running" ? [value] : [];
    });
  }

  async #must(args: readonly string[], what: string): Promise<void> {
    const result = await this.#withKernel(args);
    if (result.code !== 0) {
      throw new Error(`container ${what}: ${result.stderr.trim() || "failed"}`);
    }
  }

  /**
   * The first start downloads the kernel, and a server stopped during that leaves the services
   * running without one, so a later start can't tell. The command that needs it can.
   */
  async #withKernel(args: readonly string[], options?: RunOptions): Promise<DockerResult> {
    const result = await this.#cli.run(args, options);
    if (result.code === 0 || !/kernel not configured/i.test(result.stderr + result.stdout)) {
      return result;
    }
    if (!this.#installingKernel) {
      this.#options.log?.("installing the Apple container kernel");
      // Forced: a stopped install can leave the file without the link that makes it the default.
      const pending = this.#cli
        .run(["system", "kernel", "set", "--recommended", "--force"], { timeoutMs: 15 * 60_000 })
        .finally(() => {
          this.#installingKernel = undefined;
        });
      this.#installingKernel = pending;
    }
    const installed = await this.#installingKernel;
    if (installed.code !== 0) {
      throw new Error(
        `container kernel: ${(installed.stderr || installed.stdout).trim().slice(-400)}`,
      );
    }
    return this.#cli.run(args, options);
  }
}

/** `status` is a word in older releases and `{ state }` in newer ones. */
function stateOf(status: unknown): string | undefined {
  if (typeof status === "string") return status;
  if (status && typeof status === "object" && "state" in status) {
    const value = (status as { state?: unknown }).state;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}
