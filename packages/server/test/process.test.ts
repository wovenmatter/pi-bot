import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPiBot } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { PiBotProcess, restartExitCode } from "../src/process.ts";
import { echoModels, tempDir } from "./helpers.ts";
import { Client } from "./ws-client.ts";

const configText = (dataDir: string, extra = "") =>
  `[credentials]\nbackend = "encrypted-sqlite"\n[models]\norchestrator = "faux/faux-1"\nbackground = "faux/faux-1"\n[storage]\ndata_dir = "${dataDir}"\n${extra}`;

describe("Restart and apply", () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let configPath: string;
  let proc: PiBotProcess | undefined;
  beforeEach(async () => {
    dir = await tempDir();
    configPath = join(dir.path, "config.toml");
    await writeFile(configPath, configText(dir.path));
  });
  afterEach(async () => {
    await proc?.close();
    proc = undefined;
    await dir.cleanup();
  });

  const open = async (options: { exitCode?: number; exit?: (code: number) => void } = {}) => {
    proc = new PiBotProcess({
      configPath,
      config: await loadConfig(configPath),
      startOptions: { models: echoModels().models, log: () => {} },
      port: 0,
      drainMs: 200,
      pollMs: 20,
      log: () => {},
      ...options,
    });
    const app = await proc.start();
    return { proc, url: `${app.server.url.replace("http", "ws")}/ws` };
  };

  it("cleans up the environment after a failed listener start", async () => {
    const first = await startPiBot(await loadConfig(configPath), {
      models: echoModels().models,
      port: 0,
      log: () => {},
    });
    const close = vi.fn();
    try {
      await expect(
        startPiBot(await loadConfig(configPath), {
          models: echoModels().models,
          port: first.server.port,
          log: () => {},
          env: {
            kind: "test",
            harnessEnv: () => {
              throw new Error("unused environment");
            },
            dispose: async () => {},
            close,
          },
        }),
      ).rejects.toThrow();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await first.close();
    }
  });

  it("resumes a non-admin bot through the real app platform", async () => {
    const config = await loadConfig(configPath);
    const first = await startPiBot(config, {
      models: echoModels(2).models,
      port: 0,
      log: () => {},
    });
    const record = await first.manager.create("Resuming worker");
    const worker = await first.manager.get(record.id);
    await worker.send("continue after restart");
    await expect
      .poll(async () =>
        (await worker.harness.inspect(BACKGROUND_CONTEXT)).tasks.some(
          (task) => task.state.kind === "running",
        ),
      )
      .toBe(true);
    await first.close();
    const errors: string[] = [];
    const second = await startPiBot(config, {
      models: echoModels().models,
      port: 0,
      log: (text) => errors.push(text),
    });
    try {
      const reopened = await second.manager.get(record.id);
      const main = await reopened.main();
      await expect
        .poll(async () =>
          (await main.entries({}, 50, undefined, BACKGROUND_CONTEXT)).items.some((entry) =>
            entry.model?.some(
              (message) => message.role === "assistant" && message.stopReason === "stop",
            ),
          ),
        )
        .toBe(true);
      expect(errors.join("\n")).not.toContain("bots are still starting");
    } finally {
      await second.close();
    }
  });

  it("parses the supervisor exit status", () => {
    expect(restartExitCode(undefined)).toBeUndefined();
    expect(restartExitCode("")).toBeUndefined();
    expect(restartExitCode("75")).toBe(75);
    expect(() => restartExitCode("0")).toThrow(/1 to 255/);
    expect(() => restartExitCode("abc")).toThrow(/1 to 255/);
  });

  it("refuses without restart support", async () => {
    const config = await loadConfig(configPath);
    const app = await startPiBot(config, { models: echoModels().models, port: 0, log: () => {} });
    try {
      const client = await Client.open(`${app.server.url.replace("http", "ws")}/ws`);
      await expect(client.request("server.restart")).rejects.toThrow(/restart support/);
      client.close();
    } finally {
      await app.close();
    }
  });

  it("reloads in place on the same port with the saved config", async () => {
    const { proc, url } = await open();
    const port = proc.app.server.port;
    const client = await Client.open(url);
    await client.request("config.update", {
      edits: [{ path: ["search", "provider"], value: "brave" }],
    });
    expect(await client.request("config.get")).toMatchObject({ restartRequired: true });

    expect(await client.request("server.restart")).toEqual({
      restarting: true,
      activeWork: 0,
      mode: "reload",
    });
    await proc.settled();
    expect(proc.app.server.port).toBe(port);
    expect(proc.config.search.provider).toBe("brave");
    client.close();

    const again = await Client.open(url);
    expect(await again.request("config.get")).toMatchObject({ restartRequired: false });
    const accounts = await again.request<{ search: { provider: string } }>("settings.accounts");
    expect(accounts.search.provider).toBe("brave");
    again.close();
  });

  it("refuses an invalid config.toml and keeps running", async () => {
    const { proc, url } = await open();
    await writeFile(configPath, configText(dir.path, "[bot_to_bot]\nmax_rounds_per_request = 0\n"));
    const client = await Client.open(url);
    await expect(client.request("server.restart")).rejects.toThrow(/max_rounds_per_request/);
    expect(await client.request("config.get")).toMatchObject({ path: configPath });
    expect(proc.app).toBeDefined();
    client.close();
  });

  it("exits with the supervisor status in service mode", async () => {
    const exits: number[] = [];
    const { proc, url } = await open({ exitCode: 75, exit: (code) => exits.push(code) });
    const client = await Client.open(url);
    expect(await client.request("server.restart")).toMatchObject({ mode: "exit" });
    await proc.settled();
    expect(exits).toEqual([75]);
    expect(() => proc.app).toThrow(/not running/);
    client.close();
  });
});
