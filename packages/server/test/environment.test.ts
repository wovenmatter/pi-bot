import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
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
        default:
          return { code: 1, stdout: "", stderr: `unexpected ${command}` };
      }
    },
    spawn(args) {
      spawns.push([...args]);
      return localAgent();
    },
  };
  return { docker, containers, calls, spawns };
}

const BOT_A = "11111111-1111-4111-8111-111111111111";
const BOT_B = "22222222-2222-4222-8222-222222222222";
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

    // Startup: A active (stopped → started), B soft-deleted (running → stopped).
    fake.containers.set(containerName(BOT_A), {
      ...(fake.containers.get(containerName(BOT_A)) as Container),
      running: false,
    });
    const fresh = new DockerEnvironmentAdapter({ docker: fake.docker });
    await fresh.reconcile([BOT_A]);
    expect(fake.containers.get(containerName(BOT_A))?.running).toBe(true);
    expect(fake.containers.get(containerName(BOT_B))?.running).toBe(false);
    fresh.close();
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
