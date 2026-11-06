import { spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { cp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { FileError } from "@earendil-works/pi-durable/env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBotHarnessOptions } from "../src/agent.ts";
import { BotManager } from "../src/bots.ts";
import type { BotEnvironmentAdapter } from "../src/env.ts";
import { AppleContainerEngine, defaultMemory } from "../src/environment/apple-container.ts";
import {
  containerName,
  type DockerCli,
  DockerEnvironmentAdapter,
  type DockerResult,
  GITHUB_KNOWN_HOSTS,
  volumeName,
} from "../src/environment/docker.ts";
import { AgentConnection, RemoteExecutionEnv } from "../src/environment/remote.ts";
import { openSharedDatabase } from "../src/storage/database.ts";
import { FAUX_MODEL, profileOf, tempDir } from "./helpers.ts";

const AGENT = fileURLToPath(new URL("../docker/agent.mjs", import.meta.url));
const ctx = BACKGROUND_CONTEXT;

/** The real environment agent as a local child (what `docker exec -i … node agent.mjs` runs). */
function localAgent() {
  return spawn(process.execPath, [AGENT], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function must<T>(result: { ok: true; value: T } | { ok: false; error: Error }): T {
  if (!result.ok) throw result.error;
  return result.value;
}

describe("environment agent bridge", () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let connection: AgentConnection;
  let env: RemoteExecutionEnv;
  let spawned = 0;
  beforeEach(async () => {
    dir = await tempDir();
    spawned = 0;
    connection = new AgentConnection(async () => {
      spawned++;
      return localAgent();
    });
    env = new RemoteExecutionEnv("test", dir.path, connection);
  });
  afterEach(async () => {
    connection.close();
    await dir.cleanup();
  });

  it("runs file and shell operations in the agent, lazily", async () => {
    expect(spawned).toBe(0);
    must(await env.createDir("a", { recursive: true }, ctx));
    must(await env.writeFile("a/b.txt", "hello\nworld\n", ctx));
    expect(spawned).toBe(1);
    expect(await readFile(join(dir.path, "a/b.txt"), "utf8")).toBe("hello\nworld\n");
    expect(must(await env.readTextFile("a/b.txt", ctx))).toBe("hello\nworld\n");
    must(await env.writeFile("bin", new Uint8Array([0, 1, 254, 255]), ctx));
    expect([...must(await env.readBinaryFile("bin", ctx))]).toEqual([0, 1, 254, 255]);
    expect(must(await env.fileInfo("a/b.txt", ctx))).toMatchObject({ kind: "file", size: 12 });

    const missing = await env.readTextFile("nope.txt", ctx);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error).toBeInstanceOf(FileError);
      expect(missing.error.code).toBe("not_found");
    }

    const reader = must(await env.openTextLineReader("a/b.txt", ctx));
    expect(must(await reader.readLine(ctx))).toEqual({ text: "hello", terminated: true });
    expect(must(await reader.readLine(ctx))).toEqual({ text: "world", terminated: true });
    await reader.close(ctx);

    const binary = must(await env.openBinaryReader("bin", undefined, ctx));
    expect([...must(await binary.read(1, 2, ctx))]).toEqual([1, 254]);
    await binary.close(ctx);

    const output: string[] = [];
    const run = must(
      await env.exec(
        "echo out; echo err >&2; pwd; exit 3",
        { onOutput: (text, _context, info) => output.push(`${info.stream}:${text}`) },
        ctx,
      ),
    );
    expect(run.exitCode).toBe(3);
    const joined = output.join("");
    expect(joined).toContain("stdout:out");
    expect(joined).toContain("stderr:err");
    expect(joined).toContain(dir.path);
    expect(spawned).toBe(1);
  });

  it("keeps watch callbacks alive until idempotent stop", async () => {
    must(await env.writeFile("watched.txt", "before", ctx));
    const changes: unknown[] = [];
    const watcher = must(
      await env.watch([{ path: "watched.txt" }], (change) => changes.push(change), ctx),
    );
    must(await env.writeFile("watched.txt", "after", ctx));
    await expect.poll(() => changes.length).toBeGreaterThan(0);
    await watcher.stop(ctx);
    await watcher.stop(ctx);
    const count = changes.length;
    must(await env.writeFile("watched.txt", "stopped", ctx));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(changes).toHaveLength(count);
  });

  it("contains child spawn failures and can start a replacement", async () => {
    connection.close();
    let attempts = 0;
    connection = new AgentConnection(async () =>
      ++attempts === 1
        ? spawn("/pi-bot-test-does-not-exist", [], { stdio: ["pipe", "pipe", "pipe"] })
        : localAgent(),
    );
    env = new RemoteExecutionEnv("test", dir.path, connection);
    await expect(env.exists(".", ctx)).rejects.toThrow();
    expect(must(await env.exists(".", ctx))).toBe(true);
  });

  it("contains pipe errors and retires the failed agent", async () => {
    connection.close();
    let child: ReturnType<typeof localAgent> | undefined;
    connection = new AgentConnection(async () => {
      child = localAgent();
      return child;
    });
    env = new RemoteExecutionEnv("test", dir.path, connection);
    expect(must(await env.exists(".", ctx))).toBe(true);
    child?.stdin.emit("error", new Error("test EPIPE"));
    expect(connection.started).toBe(false);
    expect(must(await env.exists(".", ctx))).toBe(true);
  });

  it("does not inherit the server's environment", async () => {
    process.env.PIBOT_TEST_SECRET = "should-not-leak";
    try {
      const output: string[] = [];
      must(await env.exec("env", { onOutput: (text) => output.push(text) }, ctx));
      expect(output.join("")).not.toContain("should-not-leak");
    } finally {
      delete process.env.PIBOT_TEST_SECRET;
    }
  });

  it("cancels a running command through the context", async () => {
    const { context, cancel } = withCancel(ctx);
    const started = Date.now();
    const pending = env.exec("sleep 20", undefined, context);
    setTimeout(() => cancel(new Error("stop")), 300);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("starts a new agent after the old one exits", async () => {
    must(await env.exists(".", ctx));
    connection.close();
    expect(must(await env.exists(".", ctx))).toBe(true);
    expect(spawned).toBe(2);
  });
});

type Container = { running: boolean; image: string; args: string[] };

/** A fake `docker` CLI: containers in memory, `exec -i … agent.mjs` spawns the real agent locally. */
function fakeDocker(options: { imageExists?: boolean } = {}) {
  const containers = new Map<string, Container>();
  const volumes = new Set<string>();
  const calls: { args: string[]; input?: string }[] = [];
  const spawns: string[][] = [];
  let images = new Set<string>(options.imageExists === false ? [] : ["*"]);
  const ok = (stdout = ""): DockerResult => ({ code: 0, stdout, stderr: "" });
  const docker: DockerCli = {
    async run(args, opts = {}) {
      calls.push({ args: [...args], ...(opts.input !== undefined ? { input: opts.input } : {}) });
      const [command, ...rest] = args;
      switch (command) {
        case "version":
          return ok("29.0.0\n");
        case "image": {
          const tag = rest[1] ?? "";
          return images.has("*") || images.has(tag)
            ? ok("[]")
            : { code: 1, stdout: "", stderr: "Error: No such image" };
        }
        case "build":
          images = new Set([...images, rest[1] ?? ""]);
          return ok();
        case "container": {
          const name = rest.at(-1) ?? "";
          const found = containers.get(name);
          if (!found) return { code: 1, stdout: "", stderr: `Error: No such container: ${name}` };
          return ok(found.running ? "true\n" : "false\n");
        }
        case "run": {
          const name = rest[rest.indexOf("--name") + 1] ?? "";
          containers.set(name, { running: true, image: rest.at(-1) ?? "", args: [...rest] });
          volumes.add(`${name}-workspace`);
          return ok("id\n");
        }
        case "start":
        case "stop": {
          const name = rest.at(-1) ?? "";
          const found = containers.get(name);
          if (!found) return { code: 1, stdout: "", stderr: "Error: No such container" };
          found.running = command === "start";
          return ok();
        }
        case "ps":
          return ok(
            [...containers.entries()]
              .filter(([, c]) => c.running)
              .map(([name]) => name.replace(/^pi-bot-/, ""))
              .join("\n"),
          );
        case "exec":
          return ok();
        case "rm": {
          const name = rest.at(-1) ?? "";
          if (!containers.delete(name)) {
            return { code: 1, stdout: "", stderr: `Error: No such container: ${name}` };
          }
          return ok(`${name}\n`);
        }
        case "volume": {
          const name = rest.at(-1) ?? "";
          if (!volumes.delete(name)) {
            return { code: 1, stdout: "", stderr: `Error: get ${name}: no such volume` };
          }
          return ok(`${name}\n`);
        }
        default:
          return { code: 1, stdout: "", stderr: `unexpected ${command}` };
      }
    },
    spawn(args) {
      spawns.push([...args]);
      return localAgent();
    },
  };
  return { docker, containers, volumes, calls, spawns };
}

const BOT_A = "11111111-1111-4111-8111-111111111111";
const BOT_B = "22222222-2222-4222-8222-222222222222";
const BOT_C = "33333333-3333-4333-8333-333333333333";
const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAfake\n-----END OPENSSH PRIVATE KEY-----";

describe("DockerEnvironmentAdapter", () => {
  let adapter: DockerEnvironmentAdapter | undefined;
  afterEach(() => adapter?.close());

  it("creates the bot's container on first use with the locked settings", async () => {
    const fake = fakeDocker();
    adapter = new DockerEnvironmentAdapter({
      docker: fake.docker,
      git: async () => ({
        privateKey: KEY,
        publicKey: "ssh-ed25519 AAAA pi",
        name: "Trey",
        email: "t@example.com",
      }),
    });
    const env = await adapter.harnessEnv(BOT_A)({ conversationId: 1 } as never, {} as never);
    if (!env) throw new Error("no env");
    expect(env.cwd).toBe("/workspace");
    expect(fake.calls).toEqual([]);

    expect(must(await env.exists("/", ctx))).toBe(true);
    const container = fake.containers.get(containerName(BOT_A));
    expect(container?.running).toBe(true);
    const args = container?.args.join(" ") ?? "";
    expect(args).toContain("--restart unless-stopped");
    expect(args).toContain(`type=volume,source=${volumeName(BOT_A)},target=/workspace`);
    expect(args).toContain(`pi-bot.bot=${BOT_A}`);
    // Nothing from the host, no Docker socket, no resource limits, default (full) network.
    expect(args).not.toMatch(
      /-v |--volume|type=bind|docker\.sock|--memory|--cpus|--pids-limit|--network|--privileged|-e |--env/,
    );
    expect(container?.image).toMatch(/^pi-bot-env:[0-9a-f]{12}$/);

    expect(fake.spawns).toEqual([
      [
        "exec",
        "-i",
        "-u",
        "bot",
        "-w",
        "/workspace",
        containerName(BOT_A),
        "node",
        "/opt/pibot-env/agent.mjs",
      ],
    ]);

    // Git: key and known_hosts only on stdin (never argv), identity via git config.
    const execs = fake.calls.filter((call) => call.args[0] === "exec");
    for (const call of execs) expect(call.args.join(" ")).not.toContain("AAAAfake");
    expect(execs.some((call) => call.input === `${KEY}\n`)).toBe(true);
    expect(execs.some((call) => call.input === `${GITHUB_KNOWN_HOSTS.join("\n")}\n`)).toBe(true);
    expect(
      execs.some((call) => call.args.join(" ").includes("chmod 600 ~/.ssh/id_pibot_github")),
    ).toBe(true);
    expect(
      execs.some((call) => call.args.includes("user.name") && call.args.includes("Trey")),
    ).toBe(true);
    expect(
      execs.some((call) => call.args.includes("user.email") && call.args.includes("t@example.com")),
    ).toBe(true);
    for (const call of execs) expect(call.args.slice(0, 4)).toEqual(["exec", "-i", "-u", "bot"]);
  });

  it("uses a new image when only the dependency lockfile changes", async () => {
    const dir = await tempDir();
    try {
      const contextDir = join(dir.path, "docker");
      await cp(fileURLToPath(new URL("../docker", import.meta.url)), contextDir, {
        recursive: true,
        filter: (source) => !source.includes("node_modules"),
      });
      const fake = fakeDocker();
      const first = await new DockerEnvironmentAdapter({ docker: fake.docker, contextDir }).image();
      const lockPath = join(contextDir, "package-lock.json");
      const lock = JSON.parse(await readFile(lockPath, "utf8"));
      lock.packages[""].version = "0.0.0-test";
      await writeFile(lockPath, JSON.stringify(lock));
      const second = await new DockerEnvironmentAdapter({
        docker: fake.docker,
        contextDir,
      }).image();
      expect(second).not.toBe(first);
    } finally {
      await dir.cleanup();
    }
  });

  it("builds the image when it is missing", async () => {
    const fake = fakeDocker({ imageExists: false });
    adapter = new DockerEnvironmentAdapter({ docker: fake.docker });
    await adapter.ensure(BOT_A);
    const build = fake.calls.find((call) => call.args[0] === "build");
    expect(build?.args.slice(0, 3)).toEqual([
      "build",
      "-t",
      fake.containers.get(containerName(BOT_A))?.image,
    ]);
    expect(build?.args.at(-1)).toMatch(/docker\/?$/);
  });

  it("stops on soft delete, starts on restore, and reconciles at startup", async () => {
    const fake = fakeDocker();
    adapter = new DockerEnvironmentAdapter({ docker: fake.docker });
    await adapter.ensure(BOT_A);
    await adapter.ensure(BOT_B);
    await adapter.dispose(BOT_A);
    expect(fake.containers.get(containerName(BOT_A))?.running).toBe(false);
    // The container and its volume are kept: only `stop`, never `rm`.
    expect(fake.calls.some((call) => ["rm", "volume"].includes(call.args[0] ?? ""))).toBe(false);
    await adapter.restore(BOT_A);
    expect(fake.containers.get(containerName(BOT_A))?.running).toBe(true);

    // Startup: A active (stopped → started), B soft-deleted (running → stopped), C unknown to this
    // server (another instance's bot on the same Docker daemon) left running.
    await adapter.ensure(BOT_C);
    fake.containers.set(containerName(BOT_A), {
      ...(fake.containers.get(containerName(BOT_A)) as Container),
      running: false,
    });
    const fresh = new DockerEnvironmentAdapter({ docker: fake.docker });
    await fresh.reconcile([BOT_A], [BOT_B]);
    expect(fake.containers.get(containerName(BOT_A))?.running).toBe(true);
    expect(fake.containers.get(containerName(BOT_B))?.running).toBe(false);
    expect(fake.containers.get(containerName(BOT_C))?.running).toBe(true);
    fresh.close();
  });

  it("removes only the purged bot's container and volume; missing ones are fine", async () => {
    const fake = fakeDocker();
    adapter = new DockerEnvironmentAdapter({ docker: fake.docker });
    await adapter.ensure(BOT_A);
    await adapter.ensure(BOT_B);
    await adapter.dispose(BOT_A);
    fake.calls.length = 0;

    await adapter.purge(BOT_A);
    expect(fake.calls.map((call) => call.args)).toEqual([
      ["rm", "-f", `pi-bot-${BOT_A}`],
      ["volume", "rm", `pi-bot-${BOT_A}-workspace`],
    ]);
    expect(fake.containers.has(containerName(BOT_A))).toBe(false);
    expect(fake.volumes.has(volumeName(BOT_A))).toBe(false);
    expect(fake.containers.get(containerName(BOT_B))?.running).toBe(true);
    expect(fake.volumes.has(volumeName(BOT_B))).toBe(true);

    // Already gone: still fine.
    await expect(adapter.purge(BOT_A)).resolves.toBeUndefined();
  });

  it("fails a purge clearly when Docker is unavailable", async () => {
    const down: DockerCli = {
      run: async () => ({ code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }),
      spawn: () => localAgent(),
    };
    adapter = new DockerEnvironmentAdapter({ docker: down });
    await expect(adapter.purge(BOT_A)).rejects.toThrow(
      `docker remove container pi-bot-${BOT_A}: Cannot connect to the Docker daemon`,
    );
    const missing: DockerCli = {
      run: async () => {
        throw new Error("spawn docker ENOENT");
      },
      spawn: () => localAgent(),
    };
    const other = new DockerEnvironmentAdapter({ docker: missing });
    await expect(other.purge(BOT_A)).rejects.toThrow(/spawn docker ENOENT/);
    other.close();
  });

  it("rewrites git in running containers when Settings changes it", async () => {
    const fake = fakeDocker();
    let name = "Old";
    adapter = new DockerEnvironmentAdapter({ docker: fake.docker, git: async () => ({ name }) });
    await adapter.ensure(BOT_A);
    name = "New";
    fake.calls.length = 0;
    await adapter.gitChanged();
    expect(fake.calls.some((call) => call.args.includes("New"))).toBe(true);
    // No key: any previously written key is removed.
    expect(
      fake.calls.some((call) => call.args.join(" ").includes("rm -f ~/.ssh/id_pibot_github")),
    ).toBe(true);
  });

  it("fails reconcile while Docker is unreachable, so startup retries", async () => {
    const docker: DockerCli = {
      run: async () => ({ code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }),
      spawn: () => localAgent(),
    };
    adapter = new DockerEnvironmentAdapter({ docker });
    await expect(adapter.reconcile([BOT_A])).rejects.toThrow(/not reachable/);
  });
});

/** A scripted `container` CLI: every call is recorded and `respond` decides the result. */
function appleCli(respond: (args: readonly string[]) => Partial<DockerResult> | undefined) {
  const calls: string[][] = [];
  const cli: DockerCli = {
    async run(args) {
      calls.push([...args]);
      return { code: 0, stdout: "", stderr: "", ...respond(args) };
    },
    spawn() {
      throw new Error("not used");
    },
  };
  return { cli, calls };
}

const running = (label?: string) =>
  JSON.stringify([
    {
      status: { state: "running" },
      configuration: { labels: label ? { "pi-bot.bot": label } : {} },
    },
  ]);

describe("AppleContainerEngine", () => {
  it("creates the volume, limits the VM, and gives the bot its volume", async () => {
    const { cli, calls } = appleCli(() => undefined);
    const engine = new AppleContainerEngine({ cli, memory: "4g", cpus: 6 });
    await engine.create({
      name: "pi-bot-x",
      hostname: "bot-x",
      labelKey: "pi-bot.bot",
      labelValue: "x",
      volume: "pi-bot-x-workspace",
      target: "/workspace",
      image: "pi-bot-env:abc",
      owner: "bot",
    });
    expect(calls).toContainEqual(["volume", "create", "pi-bot-x-workspace"]);
    const run = calls.find((call) => call[0] === "run") ?? [];
    expect(run.join(" ")).toContain("--memory 4g --cpus 6");
    expect(run.join(" ")).toContain(
      "--mount type=volume,source=pi-bot-x-workspace,target=/workspace",
    );
    expect(run).not.toContain("--restart");
    expect(calls.at(-1)).toEqual([
      "exec",
      "-u",
      "root",
      "pi-bot-x",
      "chown",
      "bot:bot",
      "/workspace",
    ]);
  });

  it("keeps an existing volume when a container is recreated", async () => {
    const { cli, calls } = appleCli((args) =>
      args[0] === "volume" ? { code: 1, stderr: "Error: volume 'v' already exists" } : undefined,
    );
    const spec = {
      name: "n",
      hostname: "h",
      labelKey: "k",
      labelValue: "v",
      volume: "v",
      target: "/w",
      image: "i",
      owner: "bot",
    };
    await new AppleContainerEngine({ cli }).create(spec);
    expect(calls.some((call) => call[0] === "run")).toBe(true);
    expect(calls.some((call) => call.includes("delete"))).toBe(false);
  });

  it("reads each container state, in both status shapes", async () => {
    const answers: Record<string, Partial<DockerResult>> = {
      up: { stdout: running() },
      down: { stdout: JSON.stringify([{ status: { state: "stopped" } }]) },
      old: { stdout: JSON.stringify([{ status: "running" }]) },
      gone: { code: 1, stderr: "Error: container not found: gone" },
    };
    const { cli } = appleCli((args) => answers[args[1] ?? ""]);
    const engine = new AppleContainerEngine({ cli });
    expect(await engine.state("up")).toBe("running");
    expect(await engine.state("down")).toBe("stopped");
    expect(await engine.state("old")).toBe("running");
    expect(await engine.state("gone")).toBe("missing");
  });

  it("starts its services when a state check finds them down, and installs the kernel", async () => {
    let up = false;
    const { cli, calls } = appleCli((args) => {
      if (args[0] === "system" && args[1] === "start") {
        up = true;
        return undefined;
      }
      if (args[0] === "system" && args[1] === "status") return up ? undefined : { code: 1 };
      if (args[0] === "inspect" && !up)
        return { code: 1, stderr: 'interrupted: "XPC connection error: Connection invalid"' };
      if (args[0] === "inspect") return { stdout: running() };
      return undefined;
    });
    const engine = new AppleContainerEngine({ cli, installRoot: "/r/rt", appRoot: "/r/data" });
    expect(await engine.state("x")).toBe("running");
    expect(calls).toContainEqual([
      "system",
      "start",
      "--enable-kernel-install",
      "--install-root",
      "/r/rt",
      "--app-root",
      "/r/data",
    ]);
  });

  it("restarts its services after installing the kernel, which frees the memory that took", async () => {
    let up = false;
    const { cli, calls } = appleCli((args) => {
      if (args[1] === "status") return up ? undefined : { code: 1 };
      if (args[1] === "start") {
        up = true;
        return { stdout: args.includes("--enable-kernel-install") ? "Installing kernel...\n" : "" };
      }
      return undefined;
    });
    await new AppleContainerEngine({ cli }).ping();
    expect(calls.map((call) => call.slice(0, 3).join(" "))).toEqual([
      "system status",
      "system start --enable-kernel-install",
      "system stop",
      "system start --disable-kernel-install",
    ]);
  });

  it("installs a kernel a stopped server never finished installing, then carries on", async () => {
    let kernel = false;
    const { cli, calls } = appleCli((args) => {
      if (args[0] === "system" && args[1] === "kernel") {
        kernel = true;
        return undefined;
      }
      if (args[0] === "run" && !kernel) {
        return { code: 1, stderr: "Error: default kernel not configured for architecture arm64" };
      }
      return undefined;
    });
    const spec = {
      name: "n",
      hostname: "h",
      labelKey: "k",
      labelValue: "v",
      volume: "v",
      target: "/w",
      image: "i",
      owner: "bot",
    };
    await new AppleContainerEngine({ cli }).create(spec);
    expect(calls).toContainEqual(["system", "kernel", "set", "--recommended", "--force"]);
    expect(calls.filter((call) => call[0] === "run")).toHaveLength(2);
  });

  it("fails clearly when its services can't start", async () => {
    const { cli } = appleCli((args) =>
      args[0] === "system" ? { code: 1, stderr: "no kernel available" } : undefined,
    );
    await expect(new AppleContainerEngine({ cli }).ping()).rejects.toThrow(/no kernel available/);
  });

  it("treats missing containers and volumes as already removed, and reports other failures", async () => {
    const missing = appleCli((args) => {
      if (args[0] === "delete" || args[0] === "stop")
        return { code: 1, stderr: 'internalError: "notFound: container with ID x not found"' };
      if (args[0] === "volume") return { code: 1, stderr: "not there" };
      return undefined;
    });
    const engine = new AppleContainerEngine({ cli: missing.cli });
    await engine.stop("x");
    await engine.remove("x");
    await engine.removeVolume("v");
    expect(missing.calls.some((call) => call[0] === "volume" && call[1] === "delete")).toBe(false);
    const broken = appleCli((args) =>
      args[0] === "delete" ? { code: 1, stderr: "disk error" } : undefined,
    );
    await expect(new AppleContainerEngine({ cli: broken.cli }).remove("x")).rejects.toThrow(
      /disk error/,
    );
  });

  it("removes the builder after a build, even a failed one, so it stops holding memory", async () => {
    const { cli, calls } = appleCli((args) =>
      args[0] === "build" ? { code: 1, stderr: "apt failed" } : undefined,
    );
    await expect(new AppleContainerEngine({ cli }).build(["a:1"], "/ctx")).rejects.toThrow(
      /apt failed/,
    );
    const words = calls.map((call) => call.slice(0, 2).join(" "));
    expect(words.lastIndexOf("builder delete")).toBeGreaterThan(
      words.findIndex((w) => w.startsWith("build ")),
    );
    expect(calls.at(-1)).toEqual(["builder", "delete", "--force"]);
  });

  it("leaves a builder that was already running alone", async () => {
    rmSync(join(tmpdir(), "pi-bot-container-builder"), { force: true });
    const { cli, calls } = appleCli((args) =>
      args[0] === "builder" && args[1] === "status" ? { stdout: "buildkit running" } : undefined,
    );
    await new AppleContainerEngine({ cli }).build(["a:1"], "/ctx");
    expect(calls.some((call) => call[0] === "builder" && call[1] !== "status")).toBe(false);
  });

  it("clears a builder its own interrupted build left on an installed container", async () => {
    const marker = join(tmpdir(), "pi-bot-container-builder");
    writeFileSync(marker, "");
    const { cli, calls } = appleCli((args) =>
      args[0] === "builder" && args[1] === "status" ? { stdout: "buildkit running" } : undefined,
    );
    await new AppleContainerEngine({ cli }).build(["a:1"], "/ctx");
    expect(calls.map((call) => call[1])).toContain("start");
    expect(existsSync(marker)).toBe(false);
  });

  it("clears a builder an interrupted build left, in a private copy", async () => {
    const { cli, calls } = appleCli((args) =>
      args[0] === "builder" && args[1] === "status" ? { stdout: "buildkit running" } : undefined,
    );
    await new AppleContainerEngine({ cli, installRoot: "/r" }).build(["a:1"], "/ctx");
    const words = calls.map((call) => call.slice(0, 2).join(" "));
    expect(words.filter((word) => word === "builder delete")).toHaveLength(2);
    expect(words).toContain("builder start");
  });

  it("cancels a build when the server stops, and still removes the builder", async () => {
    const calls: string[][] = [];
    const cli: DockerCli = {
      run(args, options) {
        calls.push([...args]);
        if (args[0] !== "build") return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        return new Promise((_, reject) =>
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        );
      },
      spawn() {
        throw new Error("not used");
      },
    };
    const engine = new AppleContainerEngine({ cli });
    const build = engine.build(["a:1"], "/ctx");
    build.catch(() => {});
    while (!calls.some((call) => call[0] === "build")) await new Promise((r) => setTimeout(r, 1));
    await engine.cancel();
    await expect(build).rejects.toThrow("aborted");
    expect(calls.at(-1)).toEqual(["builder", "delete", "--force"]);
  });

  it("removes the builder when a build is cancelled while it starts", async () => {
    const calls: string[][] = [];
    const cli: DockerCli = {
      run(args, options) {
        calls.push([...args]);
        if (args[0] === "builder" && args[1] === "start") {
          return new Promise((_, reject) =>
            options?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
          );
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      spawn() {
        throw new Error("not used");
      },
    };
    const engine = new AppleContainerEngine({ cli });
    const build = engine.build(["a:1"], "/ctx");
    build.catch(() => {});
    while (!calls.some((call) => call[1] === "start" && call[0] === "builder")) {
      await new Promise((r) => setTimeout(r, 1));
    }
    await engine.cancel();
    await expect(build).rejects.toThrow("aborted");
    expect(calls.at(-1)).toEqual(["builder", "delete", "--force"]);
    expect(calls.some((call) => call[0] === "build")).toBe(false);
  });

  it("lists only its own running containers", async () => {
    const records = JSON.stringify([
      { status: { state: "running" }, configuration: { labels: { "pi-bot.bot": "a" } } },
      { status: { state: "stopped" }, configuration: { labels: { "pi-bot.bot": "b" } } },
      { status: { state: "running" }, configuration: { labels: {} } },
    ]);
    const { cli } = appleCli((args) => (args[0] === "list" ? { stdout: records } : undefined));
    expect(await new AppleContainerEngine({ cli }).running("pi-bot.bot")).toEqual(["a"]);
  });

  it("scales each VM's limit with the Mac", () => {
    const gib = 1024 ** 3;
    expect(defaultMemory(8 * gib)).toBe("2g");
    expect(defaultMemory(16 * gib)).toBe("4g");
    expect(defaultMemory(32 * gib)).toBe("8g");
  });
});

describe("idle stopping", () => {
  /** An engine whose one container starts running, so stops and restarts are visible. */
  function fakeEngine(work: string[] = [], agent = localAgent) {
    const events: string[] = [];
    let state: "missing" | "running" | "stopped" = "missing";
    const engine = new AppleContainerEngine({
      cli: {
        async run(args) {
          if (args[0] === "exec" && args.includes("ps")) {
            return {
              code: 0,
              stderr: "",
              stdout: [
                "    1 /usr/bin/tini -- sleep infinity",
                "    7 sleep infinity",
                ...work,
                "   40 ps -eo pid=,args=",
              ].join("\n"),
            };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        spawn: () => agent(),
      },
    });
    engine.ping = async () => {};
    engine.imageExists = async () => true;
    engine.state = async () => state;
    engine.create = async () => {
      state = "running";
      events.push("create");
    };
    engine.start = async () => {
      state = "running";
      events.push("start");
    };
    engine.stop = async () => {
      state = "stopped";
      events.push("stop");
    };
    return { engine, events, stateNow: () => state };
  }

  const settle = async (done: () => boolean) => {
    for (let i = 0; i < 200 && !done(); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
  };

  it("stops an idle container, and the next tool call starts it again", async () => {
    const { engine, events, stateNow } = fakeEngine();
    const adapter = new DockerEnvironmentAdapter({
      engine,
      image: "i",
      idleStopMs: 20,
      lazy: true,
    });
    await adapter.ensure("bot");
    expect(events).toEqual(["create"]);
    await (adapter as unknown as { reconcile: (a: string[]) => Promise<void> }).reconcile(["bot"]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await invokeSweep(adapter);
    await settle(() => stateNow() === "stopped");
    expect(events).toEqual(["create", "stop"]);
    await adapter.ensure("bot");
    expect(events).toEqual(["create", "stop", "start"]);
    adapter.close();
  });

  it("does not start any container at server startup", async () => {
    const { engine, events } = fakeEngine();
    const adapter = new DockerEnvironmentAdapter({
      engine,
      image: "i",
      idleStopMs: 20,
      lazy: true,
    });
    await adapter.reconcile(["a", "b"], []);
    expect(events).toEqual([]);
    adapter.close();
  });

  it("leaves a container alone while something still runs in it", async () => {
    const { engine, events } = fakeEngine(["   12 node server.js"]);
    const adapter = new DockerEnvironmentAdapter({
      engine,
      image: "i",
      idleStopMs: 10,
      lazy: true,
    });
    await adapter.ensure("bot");
    await new Promise((resolve) => setTimeout(resolve, 25));
    await invokeSweep(adapter);
    expect(events).toEqual(["create"]);
    adapter.close();
  });

  it("keeps a container that a tool call is using", async () => {
    // An agent that never answers: the call stays in flight for as long as the test needs.
    const { engine, events } = fakeEngine([], () => spawn("sleep", ["5"], { stdio: "pipe" }));
    const adapter = new DockerEnvironmentAdapter({
      engine,
      image: "i",
      idleStopMs: 10,
      lazy: true,
    });
    const factory = adapter.harnessEnv("bot") as unknown as (target: {
      cwd: string;
    }) => RemoteExecutionEnv;
    const inFlight = factory({ cwd: "/workspace" })
      .exec("sleep 60", undefined, ctx)
      .catch(() => undefined);
    await settle(() => events.includes("create"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    await invokeSweep(adapter);
    expect(events).toEqual(["create"]);
    adapter.close();
    await inFlight;
  });

  it("stops started containers when the server shuts down", async () => {
    const { engine, events } = fakeEngine();
    const adapter = new DockerEnvironmentAdapter({
      engine,
      image: "i",
      idleStopMs: 60_000,
      lazy: true,
    });
    await adapter.ensure("bot");
    await adapter.shutdown();
    expect(events).toEqual(["create", "stop"]);
  });

  it("does nothing with idle stopping off", async () => {
    const { engine, events } = fakeEngine();
    const adapter = new DockerEnvironmentAdapter({ engine, image: "i", lazy: true });
    await adapter.ensure("bot");
    await invokeSweep(adapter);
    expect(events).toEqual(["create"]);
    adapter.close();
  });
});

function invokeSweep(adapter: DockerEnvironmentAdapter): Promise<void> {
  return adapter.sweepIdleForTest();
}

describe("bot tools", () => {
  it("runs the model's bash tool call in the bot's environment", async () => {
    const dir = await tempDir();
    const connection = new AgentConnection(async () => localAgent());
    const disposed: string[] = [];
    const env: BotEnvironmentAdapter = {
      kind: "local-agent",
      harnessEnv: () => () => new RemoteExecutionEnv("local", dir.path, connection),
      dispose: async (botId) => {
        disposed.push(botId);
      },
    };
    const faux = fauxProvider({ tokensPerSecond: 5000 });
    let toolResult = "";
    faux.setResponses([
      () =>
        fauxAssistantMessage(
          [fauxToolCall("bash", { command: "echo from-env > out.txt && cat out.txt" })],
          { stopReason: "toolUse" },
        ),
      (context) => {
        const messages = (context as { messages: { role: string; content: unknown }[] }).messages;
        toolResult = JSON.stringify(messages.filter((message) => message.role === "toolResult"));
        return fauxAssistantMessage([fauxText("done")]);
      },
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const db = await openSharedDatabase(join(dir.path, "db.sqlite"));
    const manager = await BotManager.open({
      db,
      harnessOptions: (bot) =>
        createBotHarnessOptions({
          bot,
          models,
          profile: profileOf(FAUX_MODEL),
          env,
        }),
      onBotDeleted: (bot) => env.dispose(bot.id),
    });
    try {
      const record = await manager.create("Tooly");
      const bot = await manager.get(record.id);
      const sent = await bot.send("run it");
      await expect(sent.submission.wait(ctx)).resolves.toMatchObject({ status: "done" });
      expect(await readFile(join(dir.path, "out.txt"), "utf8")).toBe("from-env\n");
      expect(toolResult).toContain("from-env");
      await manager.delete(record.id);
      expect(disposed).toEqual([record.id]);
    } finally {
      connection.close();
      await manager.close();
      await db.close();
      await dir.cleanup();
    }
  });
});
