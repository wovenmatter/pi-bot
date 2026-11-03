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
import {
  migrateLegacyBackground,
  migrateLegacyBackgroundFile,
  ProfileConflictError,
  ProfileError,
  ProfileStore,
  persistProfiles,
  writeProfilesToml,
} from "../src/profiles.ts";
import {
  ConfigConflictError,
  readConfigFile,
  updateConfigFile,
} from "../src/settings/config-file.ts";
import { setTomlValues } from "../src/settings/toml-edit.ts";
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
      profiles.save({ id: "x", name: "x", main: "faux/faux-1", memoryModel: "openai/gpt" }),
    ).rejects.toThrow(/unknown model/);
    await expect(
      profiles.save({ id: "x", name: "x", main: "faux/faux-1", memoryModel: "nope" }),
    ).rejects.toThrow(/invalid model/);
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
    expect(profiles.get("fast")?.pool).toEqual([{ model: "faux/faux-1", useFor: "" }]);
    // No memory model: the active main model extracts. "" and null mean the same.
    expect(profiles.get("fast")?.memoryModel).toBeUndefined();
    const memory = await profiles.save({
      id: "fast",
      name: "Fast",
      main: "faux/faux-2",
      memoryModel: "faux/faux-3",
      pool: [{ model: "faux/faux-1" }],
    });
    expect(memory.memoryModel).toBe("faux/faux-3");
    // The memory model is never a pool model and never a subagent alias.
    expect(memory.pool).toEqual([{ model: "faux/faux-1", useFor: "" }]);
    for (const cleared of ["", null]) {
      expect(
        (
          await profiles.save({
            id: "fast",
            name: "Fast",
            main: "faux/faux-2",
            memoryModel: cleared,
          })
        ).memoryModel,
      ).toBeUndefined();
    }
    expect(profiles.resolve("missing").id).toBe("default");
    await expect(profiles.remove("default")).rejects.toThrow(/cannot be deleted/);
    await profiles.setDefault("fast");
    expect(profiles.resolve(undefined).id).toBe("fast");
    await profiles.remove("default");
    expect(profiles.list().map((profile) => profile.id)).toEqual(["fast"]);
    expect(changes).toEqual(["1->2", "2->2", "2->2", "2->2", "2->2", "2->1"]);
  });

  it("validates main-model fallbacks", async () => {
    const profiles = store();
    const save = (fallbacks: string[]) =>
      profiles.save({ id: "default", name: "Default", main: "faux/faux-1", fallbacks });
    await expect(save(["faux/faux-1"])).rejects.toThrow(/main model/);
    await expect(save(["faux/faux-2", "faux/faux-2"])).rejects.toThrow(/twice/);
    await expect(save(["openai/gpt"])).rejects.toThrow(/unknown model/);
    await expect(
      save(["faux/a", "faux/b", "faux/c", "faux/d", "faux/e", "faux/f"]),
    ).rejects.toThrow(/at most 5/);
    expect((await save(["faux/faux-2"])).fallbacks).toEqual(["faux/faux-2"]);
    expect((await save([])).fallbacks).toBeUndefined();
    expect(() =>
      parseConfig('[profiles.p]\nname = "P"\nmain = "faux/a"\nfallbacks = ["faux/a"]\n'),
    ).toThrow(/fallbacks/);
  });

  it("writes profiles to config.toml, dropping legacy roles and keeping the rest", async () => {
    const profiles = store();
    await profiles.save({
      id: "default",
      name: "Default",
      main: "faux/faux-1",
      fallbacks: ["faux/faux-3", "faux/faux-2"],
      memoryModel: "faux/faux-2",
      guidance: 'Say "hi"\nthen work.',
      pool: [{ model: "faux/faux-2", useFor: "Lookups" }],
    });
    const text = writeProfilesToml(legacy, profiles.snapshot());
    expect(text).toContain("# mine");
    expect(text).not.toContain("orchestrator");
    expect(text).not.toContain("background");
    expect(text).toContain('memory_model = "faux/faux-2"');
    expect(text).toContain('[models.titles]\nmodel = "faux/faux-2"');
    expect(text).toContain('fallbacks = ["faux/faux-3", "faux/faux-2"]');
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

describe("profile writes next to other config.toml writes", () => {
  const base = `# mine
[models]
default_profile = "default"

[profiles.default]
name = "Default"
main = "faux/faux-1"

[profiles.default.pool."faux/faux-2"]
use_for = "Background"
background = true

# fast profile
[profiles.fast]
name = "Fast"
main = "faux/faux-2"

[extraction]
schedule = "0 3 * * *"
`;
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let path: string;
  beforeEach(async () => {
    dir = await tempDir();
    path = join(dir.path, "config.toml");
    await writeFile(path, base, { mode: 0o640 });
  });
  afterEach(async () => {
    await dir.cleanup();
  });
  /** A store running what the file said at startup, persisting like the app does. */
  const live = () =>
    new ProfileStore(parseConfig(base).modelProfiles, {
      persist: (set) => persistProfiles(path, set),
    });
  /** An edit saved straight to the file (raw editor), pending a restart. */
  const editFile = (from: string, to: string) =>
    updateConfigFile(path, ({ text }) => {
      expect(text).toContain(from);
      return text.replace(from, to);
    });

  it("writes only the changed profile, in place, keeping other pending file edits", async () => {
    const profiles = live();
    await editFile('name = "Fast"', 'name = "Fast (edited)"');
    await profiles.save({ id: "default", name: "Default", main: "faux/faux-3" });
    let text = await readFile(path, "utf8");
    expect(text).toContain('name = "Fast (edited)"');
    expect(text).toContain("# mine");
    expect(text).toContain("# fast profile");
    // The default profile stays first; its pool table went with it.
    expect(text.indexOf("[profiles.default]")).toBeLessThan(text.indexOf("[profiles.fast]"));
    expect(text).not.toContain('faux/faux-2"]');
    expect(parseConfig(text).modelProfiles.profiles.map((p) => [p.id, p.main, p.name])).toEqual([
      ["default", "faux/faux-3", "Default"],
      ["fast", "faux/faux-2", "Fast (edited)"],
    ]);
    expect((await stat(path)).mode & 0o777).toBe(0o640);

    await profiles.save({ id: "slow", name: "Slow", main: "faux/faux-1" }, { create: true });
    text = await readFile(path, "utf8");
    expect(text).toContain('name = "Fast (edited)"');
    expect(parseConfig(text).modelProfiles.profiles.map((p) => p.id)).toEqual([
      "default",
      "fast",
      "slow",
    ]);
  });

  it("refuses a live change to a profile with a pending file edit, writing nothing", async () => {
    const profiles = live();
    await editFile('main = "faux/faux-2"', 'main = "faux/faux-9"');
    const pending = await readFile(path, "utf8");
    await expect(
      profiles.save({ id: "fast", name: "Fast", main: "faux/faux-3" }),
    ).rejects.toBeInstanceOf(ProfileConflictError);
    await expect(profiles.remove("fast")).rejects.toThrow(/restart/);
    expect(await readFile(path, "utf8")).toBe(pending);
    // The store did not change either.
    expect(profiles.get("fast")?.main).toBe("faux/faux-2");

    // A profile created in the file meanwhile can't be created live under the same id.
    await editFile(
      "[extraction]",
      '[profiles.new]\nname = "New"\nmain = "faux/faux-1"\n\n[extraction]',
    );
    await expect(
      profiles.save({ id: "new", name: "Mine", main: "faux/faux-2" }, { create: true }),
    ).rejects.toBeInstanceOf(ProfileConflictError);
  });

  it("removes a profile the file already dropped, and guards a pending default", async () => {
    const profiles = live();
    await editFile('# fast profile\n[profiles.fast]\nname = "Fast"\nmain = "faux/faux-2"\n', "");
    await profiles.remove("fast");
    expect(
      parseConfig(await readFile(path, "utf8")).modelProfiles.profiles.map((p) => p.id),
    ).toEqual(["default"]);

    await profiles.save({ id: "fast", name: "Fast", main: "faux/faux-2" }, { create: true });
    await editFile('default_profile = "default"', 'default_profile = "fast"');
    await expect(profiles.setDefault("fast")).rejects.toThrow(/default profile was changed/);
  });

  it("serializes with other writers, so neither change is lost", async () => {
    const profiles = live();
    await Promise.all([
      profiles.save({ id: "fast", name: "Fast", main: "faux/faux-3" }),
      updateConfigFile(path, ({ text }) =>
        setTomlValues(text, [{ path: ["extraction", "timezone"], value: "Europe/Paris" }]),
      ),
      profiles.save({ id: "other", name: "Other", main: "faux/faux-1" }, { create: true }),
    ]);
    const config = parseConfig(await readFile(path, "utf8"));
    expect(config.extraction.timezone).toBe("Europe/Paris");
    expect(config.modelProfiles.profiles.map((p) => [p.id, p.main])).toEqual([
      ["default", "faux/faux-1"],
      ["fast", "faux/faux-3"],
      ["other", "faux/faux-1"],
    ]);
  });

  it("keeps a legacy background flag as the memory model through a live save", async () => {
    const profiles = live();
    // The file's flag reads as the running memory model: no false conflict.
    expect(profiles.get("default")?.memoryModel).toBe("faux/faux-2");
    const current = profiles.get("default");
    if (!current) throw new Error("no default profile");
    await profiles.save({ ...current, name: "Default (renamed)" });
    const text = await readFile(path, "utf8");
    expect(text).not.toContain("background");
    expect(text).toContain('memory_model = "faux/faux-2"');
    expect(text).toContain("# fast profile");
    expect(parseConfig(text).modelProfiles.profiles[0]).toEqual({
      id: "default",
      name: "Default (renamed)",
      main: "faux/faux-1",
      memoryModel: "faux/faux-2",
      pool: [{ model: "faux/faux-2", useFor: "Background" }],
    });
  });

  it("round-trips a raw memory_model edit and guards it until a restart", async () => {
    const profiles = live();
    // A raw editor save that sets the fast profile's memory model, pending a restart.
    await editFile('main = "faux/faux-2"', 'main = "faux/faux-2"\nmemory_model = "faux/faux-3"');
    // A live change to another profile keeps the raw edit.
    await profiles.save({ id: "default", name: "Default", main: "faux/faux-3" });
    let text = await readFile(path, "utf8");
    expect(text).toContain('memory_model = "faux/faux-3"');
    expect(parseConfig(text).modelProfiles.profiles[1]?.memoryModel).toBe("faux/faux-3");
    // A live change to the edited profile is refused: it was made against what runs.
    await expect(
      profiles.save({ id: "fast", name: "Fast live", main: "faux/faux-2" }),
    ).rejects.toBeInstanceOf(ProfileConflictError);
    expect(await readFile(path, "utf8")).toBe(text);
    // After a restart the store runs the file, and saving it writes the same memory model back.
    const restarted = new ProfileStore(parseConfig(text).modelProfiles, {
      persist: (set) => persistProfiles(path, set),
    });
    const fast = restarted.get("fast");
    if (!fast) throw new Error("no fast profile");
    await restarted.save({ ...fast, name: "Fast 2" });
    text = await readFile(path, "utf8");
    expect(parseConfig(text).modelProfiles.profiles[1]).toEqual({
      id: "fast",
      name: "Fast 2",
      main: "faux/faux-2",
      memoryModel: "faux/faux-3",
      pool: [],
    });
  });

  it("rewrites legacy background flags as memory_model on start, keeping the rest", async () => {
    // A pending raw edit elsewhere in the file must survive.
    await editFile('schedule = "0 3 * * *"', 'schedule = "0 4 * * *"   # mine too');
    const before = parseConfig(await readFile(path, "utf8")).modelProfiles;
    expect(await migrateLegacyBackgroundFile(path)).toBe(true);
    const text = await readFile(path, "utf8");
    expect(text).not.toContain("background");
    expect(text).toContain(
      '[profiles.default]\nname = "Default"\nmain = "faux/faux-1"\nmemory_model = "faux/faux-2"\n',
    );
    expect(text).toContain('[profiles.default.pool."faux/faux-2"]\nuse_for = "Background"\n');
    expect(text).toContain("# mine\n");
    expect(text).toContain("# fast profile");
    expect(text).toContain('schedule = "0 4 * * *"   # mine too');
    expect(parseConfig(text).modelProfiles).toEqual(before);
    expect((await stat(path)).mode & 0o777).toBe(0o640);
    // Idempotent: nothing left to rewrite.
    expect(await migrateLegacyBackgroundFile(path)).toBe(false);
    expect(await readFile(path, "utf8")).toBe(text);
  });

  it("clears the old automatic pool note without changing custom notes or memory selection", async () => {
    const source = `[profiles.p]
name = "P"
main = "a/b"
memory_model = "a/m"
# keep my preferences
guidance = "Prefer careful reviews"
[profiles.p.pool."a/c"]
use_for = "Background work" # old automatic default
[profiles.p.pool."a/d"]
use_for = "Background work for document summaries"
`;
    await writeFile(path, source, { mode: 0o640 });
    expect(parseConfig(source).modelProfiles.profiles[0]?.pool[0]?.useFor).toBe("");
    expect(await migrateLegacyBackgroundFile(path)).toBe(true);
    const saved = await readFile(path, "utf8");
    expect(saved).toContain('use_for = "" # old automatic default');
    expect(saved).toContain("# keep my preferences");
    expect(parseConfig(saved).modelProfiles.profiles[0]).toMatchObject({
      memoryModel: "a/m",
      guidance: "Prefer careful reviews",
      pool: [
        { model: "a/c", useFor: "" },
        { model: "a/d", useFor: "Background work for document summaries" },
      ],
    });
    expect((await stat(path)).mode & 0o777).toBe(0o640);
    expect(await migrateLegacyBackgroundFile(path)).toBe(false);
  });

  it("leaves legacy flags alone where a line edit can't reach them", () => {
    const inline = `[profiles.p]\nname = "P"\nmain = "a/b"\npool = { "a/c" = { background = true } }\n`;
    expect(migrateLegacyBackground(inline)).toBeUndefined();
    expect(parseConfig(inline).modelProfiles.profiles[0]?.memoryModel).toBe("a/c");
    // A false flag is just dropped; an explicit memory_model is kept.
    const mixed = `[profiles.p]\nname = "P"\nmain = "a/b"\nmemory_model = "a/m"\n\n[profiles.p.pool."a/c"]\nbackground = true # old\n`;
    const next = migrateLegacyBackground(mixed);
    expect(next).toBe(
      `[profiles.p]\nname = "P"\nmain = "a/b"\nmemory_model = "a/m"\n\n[profiles.p.pool."a/c"]\n`,
    );
    expect(migrateLegacyBackground('[profiles.p]\nname = "P"\nmain = "a/b"\n')).toBeUndefined();
  });

  it.each([
    [
      "an inline pool table",
      'pool = { "faux/faux-2" = { use_for = "Cheap", background = true } }\n',
    ],
    [
      "inline pool entries",
      '\n[profiles.p.pool]\n"faux/faux-2" = { use_for = "Cheap", background = true }\n',
    ],
  ])("clearing the memory model of %s never re-inherits the legacy flag", async (_name, pool) => {
    const inline = `# inline legacy\n[models]\ndefault_profile = "p"\n\n[profiles.p]\nname = "P"\nmain = "faux/faux-1"\n${pool}\n[extraction]\nschedule = "0 3 * * *"\n`;
    await writeFile(path, inline, { mode: 0o640 });
    // The start-up rewrite can't reach it with a line edit, so it leaves the file alone.
    expect(migrateLegacyBackground(inline, path)).toBeUndefined();
    expect(await migrateLegacyBackgroundFile(path)).toBe(false);
    expect(await readFile(path, "utf8")).toBe(inline);
    const running = parseConfig(inline).modelProfiles;
    expect(running.profiles[0]?.memoryModel).toBe("faux/faux-2");
    const profiles = new ProfileStore(running, { persist: (set) => persistProfiles(path, set) });
    // Settings → "Use active main model", saved.
    await profiles.save({
      id: "p",
      name: "P",
      main: "faux/faux-1",
      pool: [{ model: "faux/faux-2", useFor: "Cheap" }],
    });
    const text = await readFile(path, "utf8");
    expect(text).not.toContain("background");
    expect(text).not.toContain("memory_model");
    expect(text).toContain("# inline legacy");
    expect(text).toContain('schedule = "0 3 * * *"');
    // After a restart the profile still uses the active main model and keeps its pool notes.
    const restarted = parseConfig(text).modelProfiles.profiles[0];
    if (!restarted) throw new Error("no profile after restart");
    expect(restarted).toEqual({
      id: "p",
      name: "P",
      main: "faux/faux-1",
      pool: [{ model: "faux/faux-2", useFor: "Cheap" }],
    });
    expect(await migrateLegacyBackgroundFile(path)).toBe(false);
    // Setting it again and resetting it again round-trips through the file too.
    const again = new ProfileStore(parseConfig(text).modelProfiles, {
      persist: (set) => persistProfiles(path, set),
    });
    await again.save({ ...restarted, memoryModel: "faux/faux-3" });
    expect(parseConfig(await readFile(path, "utf8")).modelProfiles.profiles[0]?.memoryModel).toBe(
      "faux/faux-3",
    );
    await again.save({ ...restarted, memoryModel: null });
    const reset = parseConfig(await readFile(path, "utf8")).modelProfiles.profiles[0];
    expect(reset?.memoryModel).toBeUndefined();
  });

  it("refuses a write based on a revision the file no longer has", async () => {
    const first = await readConfigFile(path);
    await live().save({ id: "fast", name: "Fast", main: "faux/faux-3" });
    await expect(
      updateConfigFile(path, () => `${first.text}# stale\n`, { expectedRevision: first.revision }),
    ).rejects.toBeInstanceOf(ConfigConflictError);
    expect(await readFile(path, "utf8")).toContain('main = "faux/faux-3"');
    const now = await readConfigFile(path);
    const saved = await updateConfigFile(path, ({ text }) => `${text}# fresh\n`, {
      expectedRevision: now.revision,
    });
    expect(saved.revision).not.toBe(now.revision);
    expect(await readFile(path, "utf8")).toMatch(/# fresh\n$/);
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

      const deleted = await t.manager.create("Deleted worker");
      await t.manager.setProfile(deleted.id, "fast");
      await t.manager.delete(deleted.id);
      await profiles.remove("fast");
      expect(
        (await t.manager.listDeleted()).find((item) => item.id === deleted.id)?.profile,
      ).toBeUndefined();
      await profiles.save(
        { id: "fast", name: "Replacement", main: "faux/faux-2" },
        { create: true },
      );
      await t.manager.restore(deleted.id);
      expect(await mainModel(t.manager, deleted.id)).toEqual({
        provider: "faux",
        modelId: "faux-1",
      });
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
      expect(profiles.get("default")?.memoryModel).toBe("faux/faux-2");
      expect(profiles.get("admin-bot")).toMatchObject({
        name: "Admin Bot",
        main: "faux/faux-2",
        memoryModel: "faux/faux-2",
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
