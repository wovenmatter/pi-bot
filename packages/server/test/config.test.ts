import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, isAllowedBindHost, parseConfig, parseModelRef } from "../src/config.ts";

const minimal = `
[models]
orchestrator = "openai/gpt-6-sol"
background = "openrouter/anthropic/claude-sonnet-5"
`;

describe("config", () => {
  it("parses config.example.toml", async () => {
    const path = resolve(import.meta.dirname, "../../../config.example.toml");
    const config = parseConfig(await readFile(path, "utf8"), "/tmp/cfg", path);
    expect(config.server).toMatchObject({ host: "127.0.0.1", port: 4317 });
    expect(config.modelProfiles.defaultId).toBe("default");
    expect(config.modelProfiles.profiles).toEqual([
      {
        id: "default",
        name: "Default",
        main: "openai/gpt-6-sol",
        fallbacks: ["claude-subscription/claude-opus-5-5", "openrouter/openai/gpt-6.1-sol"],
        memoryModel: "openai/gpt-6-luna",
        guidance:
          "Luna is fine for quick lookups and summaries. Sonnet writes nicer prose; Sol is thorough.",
        pool: [
          { model: "openai/gpt-6-luna", useFor: "Quick lookups and summaries" },
          {
            model: "openrouter/anthropic/claude-sonnet-5",
            useFor: "Careful writing and code review",
          },
        ],
      },
    ]);
    expect(config.roles.titles).toEqual({ provider: "openai-codex", modelId: "gpt-6-luna" });
    expect(config.models.titles.reasoning).toBe("high");
    expect(config.extraction.timezone).toBe("America/New_York");
    expect(config.bot_to_bot).toEqual({
      max_rounds_per_request: 5,
      max_messages_per_hour_per_pair: 30,
    });
  });

  it("applies defaults and resolves paths", () => {
    const config = parseConfig(`${minimal}\n[storage]\ndata_dir = "state"\n`, "/srv/pibot");
    expect(config.paths.dataDir).toBe("/srv/pibot/state");
    expect(config.paths.database).toBe("/srv/pibot/state/pi-bot.sqlite");
    expect(config.paths.keyFile).toBe("/srv/pibot/state/credentials.key");
    expect(config.credentials.backend).toBe("auto");
    expect(config.extraction.schedule).toBe("0 3 * * *");
  });

  it("turns legacy orchestrator/background roles into a default profile with a memory model", () => {
    const config = parseConfig(minimal);
    expect(config.modelProfiles).toEqual({
      defaultId: "default",
      profiles: [
        {
          id: "default",
          name: "Default",
          main: "openai/gpt-6-sol",
          // The old background role was memory extraction: it is not a subagent pool model.
          memoryModel: "openrouter/anthropic/claude-sonnet-5",
          pool: [],
        },
      ],
    });
    const same = parseConfig('[models]\norchestrator = "a/b"\nbackground = "a/b"\n');
    expect(same.modelProfiles.profiles[0]).toEqual({
      id: "default",
      name: "Default",
      main: "a/b",
      pool: [],
    });
  });

  it("reads memory_model, and a legacy pool background flag as the memory model only", () => {
    const base = '[profiles.p]\nname = "P"\nmain = "a/main"\n';
    expect(parseConfig(base).modelProfiles.profiles[0]?.memoryModel).toBeUndefined();
    expect(
      parseConfig(`${base}memory_model = "a/mem"\n`).modelProfiles.profiles[0]?.memoryModel,
    ).toBe("a/mem");
    const legacy = parseConfig(
      `${base}[profiles.p.pool."a/cheap"]\nuse_for = "x"\nbackground = true\n[profiles.p.pool."a/other"]\nbackground = false\n`,
    );
    expect(legacy.modelProfiles.profiles[0]).toEqual({
      id: "p",
      name: "P",
      main: "a/main",
      memoryModel: "a/cheap",
      // The pool keeps its models; no entry carries any background meaning any more.
      pool: [
        { model: "a/cheap", useFor: "x" },
        { model: "a/other", useFor: "" },
      ],
    });
    // An explicit memory_model wins over a leftover flag.
    const both = parseConfig(
      `${base}memory_model = "a/mem"\n[profiles.p.pool."a/cheap"]\nbackground = true\n`,
    );
    expect(both.modelProfiles.profiles[0]?.memoryModel).toBe("a/mem");
    expect(() => parseConfig(`${base}memory_model = "nope"\n`)).toThrow(ConfigError);
  });

  it("validates profiles and the default profile", () => {
    const profiles = `[models]\ndefault_profile = "fast"\n[profiles.fast]\nname = "Fast"\nmain = "a/b"\n`;
    const config = parseConfig(profiles);
    expect(config.modelProfiles.defaultId).toBe("fast");
    expect(() => parseConfig(`[profiles.fast]\nname = "Fast"\nmain = "a/b"\n`)).not.toThrow();
    expect(() =>
      parseConfig(
        `[models]\ndefault_profile = "nope"\n[profiles.fast]\nname = "F"\nmain = "a/b"\n`,
      ),
    ).toThrow(/nope/);
    expect(() => parseConfig(`[profiles.fast]\nname = "F"\nmain = "gpt"\n`)).toThrow(ConfigError);
  });

  it("requires model roles (no hardcoded default model)", () => {
    expect(() => parseConfig("[server]\nport = 1\n")).toThrow(ConfigError);
  });

  it.each([
    ["public bind host", `${minimal}[server]\nhost = "0.0.0.0"\n`, "server.host"],
    ["bad port", `${minimal}[server]\nport = 70000\n`, "server.port"],
    [
      "bad model ref",
      `[models]\norchestrator = "gpt"\nbackground = "a/b"\n`,
      "models.orchestrator",
    ],
    ["bad time zone", `${minimal}[extraction]\ntimezone = "Mars/Olympus"\n`, "extraction.timezone"],
    ["bad cron", `${minimal}[extraction]\nschedule = "daily"\n`, "extraction.schedule"],
    ["unknown key", `${minimal}[server]\nbogus = true\n`, "bogus"],
    ["zero limit", `${minimal}[bot_to_bot]\nmax_rounds_per_request = 0\n`, "max_rounds"],
  ])("rejects %s", (_name, text, needle) => {
    expect(() => parseConfig(text)).toThrow(needle);
  });

  it("rejects invalid TOML", () => {
    expect(() => parseConfig("[models\n")).toThrow(/invalid TOML/);
  });

  it("only allows loopback and tailnet bind hosts", () => {
    for (const host of [
      "127.0.0.1",
      "localhost",
      "::1",
      "[::1]",
      "100.101.102.103",
      "fd7a:115c:a1e0::1",
    ]) {
      expect(isAllowedBindHost(host), host).toBe(true);
    }
    for (const host of ["0.0.0.0", "::", "192.168.1.5", "8.8.8.8", "100.128.0.1", "example.com"]) {
      expect(isAllowedBindHost(host), host).toBe(false);
    }
  });

  it("parses model refs", () => {
    expect(parseModelRef("openai/gpt-6-sol")).toEqual({ provider: "openai", modelId: "gpt-6-sol" });
    expect(() => parseModelRef("nope")).toThrow();
  });
});
