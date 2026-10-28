import { stat } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BOTS_TABLE, botPrefix, prefixedObjects, THREADS_TABLE } from "../src/storage/registry.ts";
import { openTestManager, tempDir } from "./helpers.ts";

const ctx = BACKGROUND_CONTEXT;

describe("shared storage", () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(async () => {
    await dir.cleanup();
  });

  it("derives Woven-style per-bot prefixes", () => {
    expect(botPrefix("0b9e1c2d-3f4a-4b5c-8d6e-7f8091a2b3c4")).toBe(
      "pibot_0b9e1c2d3f4a4b5c8d6e7f8091a2b3c4_",
    );
    expect(() => botPrefix("../evil")).toThrow();
    expect(() => botPrefix("bots")).toThrow();
  });

  it("creates the database 0600 in a 0700 directory", async () => {
    const dbPath = join(dir.path, "state", "pi-bot.sqlite");
    const t = await openTestManager(dbPath);
    try {
      expect((await stat(dbPath)).mode & 0o777).toBe(0o600);
      expect((await stat(join(dir.path, "state"))).mode & 0o777).toBe(0o700);
    } finally {
      await t.close();
    }
  });

  it("keeps every bot's durable tables under its own prefix", async () => {
    const t = await openTestManager(join(dir.path, "pi-bot.sqlite"));
    try {
      const a = await t.manager.create("Alpha");
      const b = await t.manager.create("Beta");
      expect(a.prefix).not.toBe(b.prefix);

      const all = await t.db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      );
      const names = all.map((row) => row.name);
      expect(names).toContain(BOTS_TABLE);
      expect(names).toContain(THREADS_TABLE);
      // Nothing outside the shared tables escapes a bot prefix.
      for (const name of names) {
        if (name === BOTS_TABLE || name === THREADS_TABLE) continue;
        expect(name.startsWith(a.prefix) || name.startsWith(b.prefix), name).toBe(true);
      }
      const aTables = await prefixedObjects(t.db, a.prefix);
      const bTables = await prefixedObjects(t.db, b.prefix);
      expect(aTables.length).toBeGreaterThan(0);
      expect(aTables.map((o) => o.name.slice(a.prefix.length))).toEqual(
        bTables.map((o) => o.name.slice(b.prefix.length)),
      );

      const rows = await t.db.all<{ id: string; schema_prefix: string }>(
        `SELECT id, schema_prefix FROM ${BOTS_TABLE} ORDER BY created_at`,
      );
      expect(rows).toEqual([
        { id: a.id, schema_prefix: a.prefix },
        { id: b.id, schema_prefix: b.prefix },
      ]);
    } finally {
      await t.close();
    }
  });

  it("drops only the deleted bot's tables and registry row", async () => {
    const t = await openTestManager(join(dir.path, "pi-bot.sqlite"));
    try {
      const a = await t.manager.create("Alpha");
      const b = await t.manager.create("Beta");
      const before = (await prefixedObjects(t.db, b.prefix)).length;
      expect(await t.manager.delete(a.id)).toBe(true);
      expect(await prefixedObjects(t.db, a.prefix)).toEqual([]);
      expect((await prefixedObjects(t.db, b.prefix)).length).toBe(before);
      expect((await t.manager.list()).map((bot) => bot.id)).toEqual([b.id]);
      expect(await t.manager.delete(a.id)).toBe(false);
      // The surviving bot still works.
      const main = await (await t.manager.get(b.id)).main();
      const sub = await main.submit({ type: "input", content: "still here?" }, ctx);
      await expect(sub.wait(ctx)).resolves.toMatchObject({ status: "done" });
    } finally {
      await t.close();
    }
  });
});
