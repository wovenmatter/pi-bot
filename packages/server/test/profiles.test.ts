import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBotHarnessOptions } from "../src/agent.ts";
import { BotManager } from "../src/bots.ts";
import { parseConfig } from "../src/config.ts";
import { ProfileError, ProfileStore, persistProfiles, writeProfilesToml } from "../src/profiles.ts";
import { openSharedDatabase } from "../src/storage/database.ts";
import { tempDir } from "./helpers.ts";

const ctx = BACKGROUND_CONTEXT;
const legacy = `# mine
[models]
orchestrator = "faux/faux-1"   # main
background = "faux/faux-2"

[models.titles]
model = "faux/faux-2"
`;

describe("ProfileStore", () => {
  const store = () =>
    new ProfileStore(parseConfig(legacy).modelProfiles, {
      checkModel: (ref) => {
        if (!ref.startsWith("faux/")) throw new Error(`unknown model ${ref}`);
      },
    });

  it("validates, saves, removes and sets the default", async () => {
    const profiles = store();
    const changes: string[] = [];
    profiles.onChange((previous) => {
      changes.push(`${previous.profiles.length}->${profiles.list().length}`);
    });
    await expect(profiles.save({ id: "Bad Id", name: "x", main: "faux/faux-1" })).rejects.toThrow(
      ProfileError,
    );
    await expect(profiles.save({ id: "x", name: "x", main: "openai/gpt" })).rejects.toThrow(
      /unknown model/,
    );
    await expect(
      profiles.save({
        id: "x",
        name: "x",
        main: "faux/faux-1",
        pool: [
          { model: "faux/faux-2", background: true },
          { model: "faux/faux-3", background: true },
        ],
      }),
    ).rejects.toThrow(/background/);
    await expect(
      profiles.save({
        id: "x",
        name: "x",
        main: "faux/faux-1",
        pool: [{ model: "faux/faux-2" }, { model: "faux/faux-2" }],
      }),
    ).rejects.toThrow(/twice|duplicate/i);
    await profiles.save(
      { id: "fast", name: "Fast", main: "faux/faux-2", pool: [{ model: "faux/faux-1" }] },
      { create: true },
    );
    await expect(
      profiles.save({ id: "fast", name: "Fast", main: "faux/faux-2" }, { create: true }),
    ).rejects.toThrow(/already exists/);
    expect(profiles.get("fast")?.pool).toEqual([
      { model: "faux/faux-1", useFor: "", background: false },
    ]);
    expect(profiles.resolve("missing").id).toBe("default");
    await expect(profiles.remove("default")).rejects.toThrow(/cannot be deleted/);
    await profiles.setDefault("fast");
    expect(profiles.resolve(undefined).id).toBe("fast");
    await profiles.remove("default");
    expect(profiles.list().map((profile) => profile.id)).toEqual(["fast"]);
    expect(changes).toEqual(["1->2", "2->2", "2->1"]);
  });

  it("writes profiles to config.toml, dropping legacy roles and keeping the rest", async () => {
    const profiles = store();
    await profiles.save({
      id: "default",
      name: "Default",
      main: "faux/faux-1",
      guidance: 'Say "hi"\nthen work.',
      pool: [{ model: "faux/faux-2", useFor: "Background", background: true }],
    });
    const text = writeProfilesToml(legacy, profiles.snapshot());
    expect(text).toContain("# mine");
    expect(text).not.toContain("orchestrator");
    expect(text).toContain('[models.titles]\nmodel = "faux/faux-2"');
    const parsed = parseConfig(text);
    expect(parsed.modelProfiles).toEqual(profiles.snapshot());
    expect(parseToml(text)).toMatchObject({ models: { default_profile: "default" } });
    // Idempotent.
    expect(writeProfilesToml(text, profiles.snapshot())).toBe(text);

    const dir = await tempDir();
    try {
      const path = join(dir.path, "config.toml");
      await writeFile(path, legacy, { mode: 0o640 });
      await persistProfiles(path, profiles.snapshot());
      expect(await readFile(path, "utf8")).toBe(text);
      expect((await stat(path)).mode & 0o777).toBe(0o640);
    } finally {
      await dir.cleanup();
    }
  });
});

describe("bot profiles", () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(async () => {
    await dir.cleanup();
  });

  const open = async (path: string, profiles: ProfileStore) => {
    const faux = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const db = await openSharedDatabase(path);
    const manager = await BotManager.open({
      db,
      profiles,
      log: () => {},
      harnessOptions: (bot, self) =>
        createBotHarnessOptions({
          bot,
          models,
          profile: () => profiles.resolve(self.assignedProfile(bot.id)),
        }),
    });
    return {
      db,
      manager,
      close: async () => {
        await manager.close();
        await db.close();
      },
    };
  };
  const mainModel = async (manager: BotManager, id: string) =>
    (await (await (await manager.get(id)).main()).agent(ctx)).model;

  it("assigns profiles live, follows edits and falls back when a profile is deleted", async () => {
    const profiles = new ProfileStore(parseConfig(legacy).modelProfiles);
    const t = await open(join(dir.path, "db.sqlite"), profiles);
    try {
      const bot = await t.manager.create("Worker");
      expect(await mainModel(t.manager, bot.id)).toEqual({ provider: "faux", modelId: "faux-1" });
      await profiles.save({ id: "fast", name: "Fast", main: "faux/faux-2" }, { create: true });
      await t.manager.setProfile(bot.id, "fast");
      expect(t.manager.assignedProfile(bot.id)).toBe("fast");
      expect(await mainModel(t.manager, bot.id)).toEqual({ provider: "faux", modelId: "faux-2" });
      await expect(t.manager.setProfile(bot.id, "nope")).rejects.toThrow(/nope/);

      // Editing the default changes every bot on it.
      const other = await t.manager.create("Other");
      await profiles.save({ id: "default", name: "Default", main: "faux/faux-2" });
      expect(await mainModel(t.manager, other.id)).toEqual({ provider: "faux", modelId: "faux-2" });
      await profiles.save({ id: "default", name: "Default", main: "faux/faux-1" });

      await profiles.remove("fast");
      expect(t.manager.assignedProfile(bot.id)).toBeUndefined();
      expect((await t.manager.registry.get(bot.id))?.profile).toBeUndefined();
      expect(await mainModel(t.manager, bot.id)).toEqual({ provider: "faux", modelId: "faux-1" });
    } finally {
      await t.close();
    }
  });

  it("migrates a legacy per-bot model to a profile", async () => {
    const path = join(dir.path, "db.sqlite");
    const profiles = new ProfileStore(parseConfig(legacy).modelProfiles);
    const first = await open(path, profiles);
    const same = await first.manager.create("Same");
    const own = await first.manager.create("Admin Bot");
    await first.close();
    const db = await openSharedDatabase(path);
    await db.run("UPDATE pibot_bots SET model = 'faux/faux-1' WHERE id = ?", same.id);
    await db.run("UPDATE pibot_bots SET model = 'faux/faux-2' WHERE id = ?", own.id);
    await db.close();

    const second = await open(path, profiles);
    try {
      expect(profiles.list().map((profile) => profile.id)).toEqual(["default", "admin-bot"]);
      expect(profiles.get("admin-bot")).toMatchObject({
        name: "Admin Bot",
        main: "faux/faux-2",
        pool: profiles.get("default")?.pool,
      });
      expect(second.manager.assignedProfile(same.id)).toBeUndefined();
      expect(second.manager.assignedProfile(own.id)).toBe("admin-bot");
      expect((await second.manager.registry.get(own.id))?.legacyModel).toBeUndefined();
      expect(await mainModel(second.manager, own.id)).toEqual({
        provider: "faux",
        modelId: "faux-2",
      });
    } finally {
      await second.close();
    }
  });
});
