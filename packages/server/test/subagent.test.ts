import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBotHarnessOptions } from "../src/agent.ts";
import { BotManager } from "../src/bots.ts";
import type { Profile } from "../src/config.ts";
import { openSharedDatabase } from "../src/storage/database.ts";
import { subagentModel } from "../src/subagent.ts";
import { tempDir } from "./helpers.ts";

const ctx = BACKGROUND_CONTEXT;

const profile: Profile = {
  id: "default",
  name: "Default",
  main: "faux/faux-1",
  guidance: "Use the cheap model for lookups.",
  pool: [
    { model: "faux/faux-2", useFor: "Cheap lookups", background: true },
    { model: "faux/faux-3", useFor: "Broken on purpose", background: false },
  ],
};

describe("run_subagent", () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let db: Awaited<ReturnType<typeof openSharedDatabase>>;
  let manager: BotManager;
  const events: string[] = [];
  const contexts: { model: string; json: string }[] = [];
  const faux = fauxProvider({
    tokensPerSecond: 5000,
    models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }],
  });

  /** The main model asks for `calls` in order, then replies with every tool result it saw. */
  const script =
    (calls: Record<string, string>[]): FauxResponseFactory =>
    (context, _options, _state, model) => {
      const json = JSON.stringify(context);
      contexts.push({ model: model.id, json });
      if (model.id === "faux-2") return fauxAssistantMessage([fauxText("child answer: 42")]);
      if (model.id === "faux-3") {
        return fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 rate limited" });
      }
      const results = json.split('"role":"toolResult"').length - 1;
      const next = calls[results];
      if (next) {
        return fauxAssistantMessage([fauxToolCall("run_subagent", next)], {
          stopReason: "toolUse",
        });
      }
      return fauxAssistantMessage([fauxText("main done")]);
    };

  beforeEach(async () => {
    dir = await tempDir();
    events.length = 0;
    contexts.length = 0;
    const models = createModels();
    models.setProvider(faux.provider);
    db = await openSharedDatabase(join(dir.path, "db.sqlite"));
    manager = await BotManager.open({
      db,
      harnessOptions: (bot) =>
        createBotHarnessOptions({
          bot,
          models,
          profile,
          onSubagent: (event) => events.push(`${event.phase} ${event.model}`),
        }),
    });
  });

  afterEach(async () => {
    await manager.close();
    await db.close();
    await dir.cleanup();
  });

  const run = async (calls: Record<string, string>[]) => {
    faux.setResponses(Array.from({ length: 20 }, () => script(calls)));
    const bot = await manager.get((await manager.create("Worker")).id);
    const sent = await bot.send("go");
    await expect(sent.submission.wait(ctx)).resolves.toMatchObject({ status: "done" });
    return contexts.filter((context) => context.model === "faux-1").at(-1)?.json ?? "";
  };

  it("runs a task on a pool model in a separate conversation and returns its answer", async () => {
    const last = await run([{ model: "faux/faux-2", reasoning: "low", task: "find the answer" }]);
    expect(last).toContain("child answer: 42");
    expect(events).toEqual(["start faux/faux-2", "done faux/faux-2"]);
    // The main model sees its pool; the child got only the task, not the main conversation.
    const first = contexts.find((context) => context.model === "faux-1")?.json ?? "";
    expect(first).toContain("faux/faux-2: Cheap lookups");
    expect(first).toContain("Use the cheap model for lookups.");
    const child = contexts.find((context) => context.model === "faux-2")?.json ?? "";
    expect(child).toContain("find the answer");
    expect(child).toContain("You are a subagent");
    expect(child).not.toContain('"content":"go"');
    expect(child).not.toContain('"name":"run_subagent"');
  });

  it('runs "background" work on the pool background model, else the main model', async () => {
    const last = await run([{ model: "background", task: "tidy up" }]);
    expect(last).toContain("child answer: 42");
    expect(events).toEqual(["start faux/faux-2", "done faux/faux-2"]);
    const first = contexts.find((context) => context.model === "faux-1")?.json ?? "";
    expect(first).toContain("faux/faux-2: Cheap lookups (background model)");
    expect(first).toContain('use model \\"background\\": faux/faux-2');
    expect(subagentModel(profile, "background")?.model).toBe("faux/faux-2");
    expect(subagentModel({ ...profile, pool: [] }, "background")).toMatchObject({
      model: "faux/faux-1",
    });
    expect(subagentModel(profile, "faux/faux-3")?.model).toBe("faux/faux-3");
    expect(subagentModel(profile, "faux/faux-9")).toBeUndefined();
  });

  it("returns clear errors so the main model can pick another model", async () => {
    const last = await run([
      { model: "openai/not-in-pool", task: "x" },
      { model: "faux/faux-3", task: "x" },
    ]);
    expect(last).toContain("openai/not-in-pool is not in your pool");
    expect(last).toContain("Subagent on faux/faux-3 failed");
    expect(last).toContain("Pick another pool model");
    expect(events).toEqual(["start faux/faux-3", expect.stringMatching(/^failed faux\/faux-3/)]);
  });
});
