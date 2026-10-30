import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PiBotApp, startPiBot } from "../src/app.ts";
import { BotRuleError, NotFoundError } from "../src/bots.ts";
import { parseConfig } from "../src/config.ts";
import {
  BOTS_TABLE,
  NOTES_TABLE,
  prefixedObjects,
  THREADS_TABLE,
} from "../src/storage/registry.ts";
import { MessageLimiter } from "../src/tools.ts";
import { echoModels, openTestManager, tempDir } from "./helpers.ts";
import { Client } from "./ws-client.ts";

const ctx = BACKGROUND_CONTEXT;

describe("purging deleted bots", () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(async () => {
    await dir.cleanup();
  });

  it("removes every row and table of the bot and leaves the others intact", async () => {
    const purged: string[] = [];
    const t = await openTestManager(join(dir.path, "pi-bot.sqlite"), {
      ensureAdmin: true,
      onBotPurged: async (botId) => {
        purged.push(botId);
        return { removed: true };
      },
    });
    try {
      const a = await t.manager.create("Alpha");
      const b = await t.manager.create("Beta");
      await t.manager.setManager(a.id, true);
      await t.manager.setTeam(b.id, a.id);
      const alpha = await t.manager.get(a.id);
      const sent = await alpha.send("remember me");
      await expect(sent.submission.wait(ctx)).resolves.toMatchObject({ status: "done" });
      const main = await alpha.main();
      const last = (await main.entries({ order: "descending" }, 1, undefined, ctx)).items[0];
      if (!last) throw new Error("empty main");
      await alpha.fork({ entryId: last.id as unknown as number });
      const beta = await t.manager.get(b.id);
      await (await beta.send("hi")).submission.wait(ctx);
      await t.manager.registry.setNote("account", "plans");
      const betaObjects = await prefixedObjects(t.db, b.prefix);
      const betaThreads = await t.manager.registry.listThreads(b.id);

      // Live bots and Admin Bot are refused; nothing is touched.
      await expect(t.manager.purge(a.id)).rejects.toThrow(BotRuleError);
      const admin = await t.manager.admin();
      if (!admin) throw new Error("no admin");
      await expect(t.manager.purge(admin.id)).rejects.toThrow(BotRuleError);
      expect((await prefixedObjects(t.db, a.prefix)).length).toBeGreaterThan(0);

      await t.manager.delete(a.id);
      await alpha.harness.closed;
      expect(await t.manager.purge(a.id)).toEqual({
        tables: expect.any(Number),
        environment: { removed: true },
      });
      expect(purged).toEqual([a.id]);

      // Every table under its prefix, its thread rows and its registry row are gone.
      expect(await prefixedObjects(t.db, a.prefix)).toEqual([]);
      expect(await t.db.all(`SELECT * FROM ${THREADS_TABLE} WHERE bot_id = ?`, a.id)).toEqual([]);
      expect(await t.db.all(`SELECT * FROM ${BOTS_TABLE} WHERE id = ?`, a.id)).toEqual([]);
      expect(await t.db.all(`SELECT id FROM ${BOTS_TABLE} WHERE manager_id = ?`, a.id)).toEqual([]);
      expect(await t.manager.listDeleted()).toEqual([]);
      await expect(t.manager.get(a.id)).rejects.toThrow(NotFoundError);
      expect(await t.manager.restore(a.id)).toBeUndefined();
      await expect(t.manager.purge(a.id)).rejects.toThrow(NotFoundError);

      // Other bots and shared tables are untouched, and Beta still works.
      expect(await prefixedObjects(t.db, b.prefix)).toEqual(betaObjects);
      expect(await t.manager.registry.listThreads(b.id)).toEqual(betaThreads);
      expect((await t.manager.list()).map((bot) => bot.name)).toEqual(["Admin Bot", "Beta"]);
      expect(await t.manager.registry.note("account")).toMatchObject({ text: "plans" });
      expect(await t.db.get(`SELECT count(*) AS n FROM ${NOTES_TABLE}`)).toEqual({ n: 1 });
      const again = await beta.send("still here?");
      await expect(again.submission.wait(ctx)).resolves.toMatchObject({ status: "done" });
    } finally {
      await t.close();
    }
  });

  it("still purges the data when the environment can't be removed, and says so", async () => {
    const t = await openTestManager(join(dir.path, "pi-bot.sqlite"), {
      onBotPurged: async () => {
        throw new Error("docker remove volume pi-bot-x-workspace: Cannot connect to the daemon");
      },
    });
    try {
      const a = await t.manager.create("Alpha");
      await t.manager.delete(a.id);
      expect(await t.manager.purge(a.id)).toEqual({
        tables: expect.any(Number),
        environment: {
          removed: false,
          error: "docker remove volume pi-bot-x-workspace: Cannot connect to the daemon",
        },
      });
      expect(await prefixedObjects(t.db, a.prefix)).toEqual([]);
      expect(await t.manager.listDeleted()).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("forgets a purged bot's bot-to-bot message counts", () => {
    const limiter = new MessageLimiter(1);
    expect(limiter.take("a", "b")).toBe(true);
    expect(limiter.take("c", "a")).toBe(true);
    expect(limiter.take("b", "c")).toBe(true);
    limiter.forget("a");
    expect(limiter.size).toBe(1);
    expect(limiter.take("b", "c")).toBe(false);
  });
});

describe("bots.purge over the WebSocket", () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let app: PiBotApp;
  let client: Client;
  beforeEach(async () => {
    dir = await tempDir();
    const config = parseConfig(
      `[models]\norchestrator = "faux/faux-1"\nbackground = "faux/faux-1"\n[storage]\ndata_dir = "${dir.path}"\n`,
    );
    app = await startPiBot(config, { models: echoModels().models, port: 0, log: () => {} });
    client = await Client.open(`${app.server.url.replace("http", "ws")}/ws`);
  });
  afterEach(async () => {
    client.close();
    await app.close();
    await dir.cleanup();
  });

  it("purges only deleted bots and pushes bots.changed", async () => {
    const { bot } = await client.request<{ bot: { id: string } }>("bots.create", { name: "Gone" });
    const { bots } = await client.request<{ bots: { id: string; kind: string }[] }>("bots.list");
    const admin = bots.find((entry) => entry.kind === "admin");
    await expect(client.request("bots.purge", { botId: bot.id })).rejects.toThrow(
      /only deleted bots/,
    );
    await expect(client.request("bots.purge", { botId: admin?.id })).rejects.toThrow(/Admin Bot/);
    await expect(client.request("bots.purge", { botId: bot.id, force: true })).rejects.toThrow(
      /invalid request/,
    );

    await client.request("bots.delete", { botId: bot.id });
    const before = client.messages.length;
    // No environment backend in this app: nothing to remove, so no environment report.
    expect(await client.request("bots.purge", { botId: bot.id })).toEqual({
      purged: true,
      tables: expect.any(Number),
    });
    await client.waitFor(
      (message) => message.type === "bots.changed" && client.messages.indexOf(message) >= before,
    );
    expect(await client.request("bots.listDeleted")).toEqual({ bots: [] });
    await expect(client.request("bots.restore", { botId: bot.id })).resolves.toEqual({
      restored: false,
    });
    await expect(client.request("bots.purge", { botId: bot.id })).rejects.toThrow(/no deleted bot/);
  });
});
