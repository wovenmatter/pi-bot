import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NotFoundError } from "../src/bots.ts";
import { FAUX_MODEL, openTestManager, tempDir } from "./helpers.ts";

const ctx = BACKGROUND_CONTEXT;

describe("bots", () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(async () => {
    await dir.cleanup();
  });

  it("creates and lists bots, each with a main-channel conversation", async () => {
    const t = await openTestManager(join(dir.path, "pi-bot.sqlite"));
    try {
      expect(await t.manager.list()).toEqual([]);
      const alpha = await t.manager.create("  Alpha ");
      const beta = await t.manager.create("Beta");
      expect(alpha.name).toBe("Alpha");
      expect((await t.manager.list()).map((bot) => bot.name)).toEqual(["Alpha", "Beta"]);
      expect(beta.id).not.toBe(alpha.id);

      const main = await (await t.manager.get(alpha.id)).main();
      expect(main.id).toBe(ROOT_CONVERSATION_ID);
      // The default agent comes from the configured orchestrator role.
      expect((await main.agent(ctx)).model).toMatchObject(FAUX_MODEL);
    } finally {
      await t.close();
    }
  });

  it("rejects empty names and unknown bots", async () => {
    const t = await openTestManager(join(dir.path, "pi-bot.sqlite"));
    try {
      await expect(t.manager.create("   ")).rejects.toThrow(/required/);
      await expect(t.manager.get("00000000-0000-4000-8000-000000000000")).rejects.toThrow(
        NotFoundError,
      );
    } finally {
      await t.close();
    }
  });

  it("persists bots and main-channel history across restarts", async () => {
    const path = join(dir.path, "pi-bot.sqlite");
    const first = await openTestManager(path);
    const bot = await first.manager.create("Alpha");
    const main = await (await first.manager.get(bot.id)).main();
    const sub = await main.submit({ type: "input", content: "remember me" }, ctx);
    await expect(sub.wait(ctx)).resolves.toMatchObject({ status: "done" });
    await first.close();

    const second = await openTestManager(path);
    try {
      expect((await second.manager.list()).map((b) => b.id)).toEqual([bot.id]);
      const reopened = await (await second.manager.get(bot.id)).main();
      const page = await reopened.entries({ order: "ascending" }, 50, undefined, ctx);
      const text = JSON.stringify(page.items);
      expect(text).toContain("remember me");
      expect(text).toContain("echo: remember me");
    } finally {
      await second.close();
    }
  });

  it("soft-deletes: closes and evicts the harness, releases the env once, refuses messages", async () => {
    const released: string[] = [];
    const t = await openTestManager(join(dir.path, "pi-bot.sqlite"), {
      onBotDeleted: async (record) => {
        released.push(record.id);
      },
    });
    try {
      const record = await t.manager.create("Alpha");
      const bot = await t.manager.get(record.id);
      expect(await t.manager.delete(record.id)).toBe(true);
      await expect(bot.harness.closed).resolves.toBeDefined();
      expect(released).toEqual([record.id]);
      await expect(t.manager.get(record.id)).rejects.toThrow(NotFoundError);
      await expect(t.manager.get(record.id)).rejects.toThrow(`bot ${record.id} was deleted`);
      expect(await t.manager.list()).toEqual([]);
      expect(await t.manager.delete(record.id)).toBe(false);
      expect(released).toEqual([record.id]);
      // Unknown bots keep their own error.
      await expect(t.manager.get("00000000-0000-4000-8000-000000000000")).rejects.toThrow(/no bot/);
    } finally {
      await t.close();
    }
  });
});
