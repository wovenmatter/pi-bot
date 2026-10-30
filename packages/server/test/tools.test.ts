import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_PROMPT, createBotHarnessOptions } from "../src/agent.ts";
import { type Bot, BotManager } from "../src/bots.ts";
import { openSharedDatabase } from "../src/storage/database.ts";
import { type BotPlatform, MessageLimiter } from "../src/tools.ts";
import { FAUX_MODEL, profileOf, tempDir } from "./helpers.ts";

const ctx = BACKGROUND_CONTEXT;

describe("bot tools", () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let db: Awaited<ReturnType<typeof openSharedDatabase>>;
  let manager: BotManager;
  let openManager: () => Promise<BotManager>;
  const faux = fauxProvider({ tokensPerSecond: 5000 });
  // Each request's context as JSON: the prompt and tool declarations ride in system messages.
  const seen: string[] = [];
  type Step = (context: unknown) => ReturnType<typeof fauxAssistantMessage>;
  const tool =
    (name: string, args: Record<string, string>): Step =>
    (context) => {
      seen.push(JSON.stringify(context));
      return fauxAssistantMessage([fauxToolCall(name, args)], {
        stopReason: "toolUse",
      });
    };
  const reply: Step = (context) => {
    seen.push(JSON.stringify(context));
    return fauxAssistantMessage([fauxText("ok")]);
  };

  beforeEach(async () => {
    dir = await tempDir();
    seen.length = 0;
    const models = createModels();
    models.setProvider(faux.provider);
    db = await openSharedDatabase(join(dir.path, "db.sqlite"));
    const platform: BotPlatform = { manager: () => manager, maxMessagesPerHourPerPair: 1 };
    openManager = () =>
      BotManager.open({
        db,
        ensureAdmin: true,
        harnessOptions: (bot) =>
          createBotHarnessOptions({ bot, models, profile: profileOf(FAUX_MODEL), platform }),
      });
    manager = await openManager();
  });

  afterEach(async () => {
    await manager.close();
    await db.close();
    await dir.cleanup();
  });

  const say = async (bot: Bot, text: string) => {
    const sent = await bot.send(text);
    await expect(sent.submission.wait(ctx)).resolves.toMatchObject({ status: "done" });
  };
  const hasTool = (context: string | undefined, name: string) =>
    (context ?? "").includes(`"name":"${name}"`);

  it("names the admin bot Admin Bot and renames an older admin row on open", async () => {
    const admin = await manager.admin();
    expect(admin?.name).toBe("Admin Bot");
    await manager.close();
    await db.run("UPDATE pibot_bots SET name = 'Admin' WHERE kind = 'admin'");
    manager = await openManager();
    expect((await manager.list()).map((bot) => bot.name)).toEqual(["Admin Bot"]);
  });

  it("gives Admin Bot the config tools and prompt; other bots get bot tools", async () => {
    const admin = await manager.admin();
    if (!admin) throw new Error("no Admin Bot");
    faux.setResponses([reply, reply]);
    await say(await manager.get(admin.id), "hi");
    expect(seen[0]).toContain(JSON.stringify(ADMIN_PROMPT).slice(1, 60));
    for (const name of [
      "create_bot",
      "message_bot",
      "set_team",
      "update_config",
      "list_profiles",
      "save_profile",
      "set_bot_profile",
      "write_account_notes",
    ]) {
      expect(hasTool(seen[0], name)).toBe(true);
    }
    expect(hasTool(seen[0], "my_team")).toBe(false);

    const plain = await manager.create("Plain");
    await say(await manager.get(plain.id), "hi");
    expect(seen[1]).toContain("You are Plain");
    for (const name of ["create_bot", "list_bots", "message_bot", "my_team"]) {
      expect(hasTool(seen[1], name)).toBe(true);
    }
    for (const name of ["set_team", "update_config", "restart_server", "save_profile"]) {
      expect(hasTool(seen[1], name)).toBe(false);
    }
  });

  it("creates bots on the creator's team and messages them, with a per-pair limit", async () => {
    const lead = await manager.create("Lead");
    await manager.setManager(lead.id, true);
    const leadBot = await manager.get(lead.id);
    faux.setResponses([tool("create_bot", { name: "Helper" }), reply]);
    await say(leadBot, "make a helper");
    const helper = (await manager.list()).find((bot) => bot.name === "Helper");
    expect(helper).toMatchObject({ managerId: lead.id, manager: false });
    if (!helper) throw new Error("no Helper");

    // The team shows up in the manager's prompt from the next request.
    const helperId = helper.id;
    // Lead and Helper share the faux queue, so each step answers by whose context it sees.
    const step: Step = (context) => {
      const json = JSON.stringify(context);
      if (json.includes("You are Helper")) return reply(context);
      const turn = json.slice(json.lastIndexOf('"content":"delegate"'));
      const results = turn.split('"role":"toolResult"').length - 1;
      if (results >= 2) return reply(context);
      const text = results === 0 ? "please research X" : "again";
      return tool("message_bot", { botId: helperId, text })(context);
    };
    faux.setResponses(Array.from({ length: 10 }, () => step));
    const before = seen.length;
    await say(leadBot, "delegate");
    expect(seen[before]).toContain("You manage a team: Helper.");
    expect(seen.slice(before).join("\n")).toContain("message limit reached");

    const main = await (await manager.get(helperId)).main();
    let history = "";
    for (let tries = 0; tries < 100 && !history.includes("please research X"); tries++) {
      history = JSON.stringify(
        (await main.entries({ order: "ascending" }, 50, undefined, ctx)).items,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(history).toContain('[Message from bot \\"Lead\\"');
    expect(history).not.toContain("again");
  });

  it("sets and clears the top bot from Admin Bot or a bot, and tells the top bot its role", async () => {
    const admin = await manager.admin();
    if (!admin) throw new Error("no Admin Bot");
    const chief = await manager.create("Chief");
    const lead = await manager.create("Lead");
    await manager.setManager(lead.id, true);
    await manager.create("Member", { managerId: lead.id });
    await manager.create("Loose");

    faux.setResponses([tool("set_team", { action: "make_top", botId: chief.id }), reply]);
    await say(await manager.get(admin.id), "make Chief the top bot");
    expect((await manager.record(chief.id)).top).toBe(true);
    faux.setResponses([tool("set_team", { action: "make_top", botId: admin.id }), reply]);
    await say(await manager.get(admin.id), "make yourself the top bot");
    expect(seen.at(-1)).toContain("the Admin Bot can't be the top bot");

    // The top bot's prompt names its role, the teams and the bots on no team.
    let before = seen.length;
    faux.setResponses([reply]);
    await say(await manager.get(chief.id), "hi");
    expect(seen[before]).toContain("You are the top bot: you lead and oversee every bot and team");
    expect(seen[before]).toContain("Teams: Lead (Member). Bots on no team: Loose.");
    // Other bots know who the top bot is.
    before = seen.length;
    faux.setResponses([reply]);
    await say(await manager.get(lead.id), "hi");
    expect(seen[before]).toContain("Chief is the top bot");

    // A bot can take over the slot itself, and give it up.
    faux.setResponses([tool("my_team", { action: "become_top" }), reply]);
    await say(await manager.get(lead.id), "be the top bot");
    expect((await manager.list()).filter((bot) => bot.top).map((bot) => bot.name)).toEqual([
      "Lead",
    ]);
    expect(await manager.record(lead.id)).toMatchObject({ manager: true });
    faux.setResponses([tool("my_team", { action: "stop_top" }), reply]);
    await say(await manager.get(lead.id), "stop being the top bot");
    expect((await manager.list()).some((bot) => bot.top)).toBe(false);

    faux.setResponses([tool("set_team", { action: "make_top", botId: chief.id }), reply]);
    await say(await manager.get(admin.id), "Chief again");
    faux.setResponses([tool("set_team", { action: "clear_top" }), reply]);
    await say(await manager.get(admin.id), "no top bot");
    expect((await manager.list()).some((bot) => bot.top)).toBe(false);
  });

  it("limits messages per pair over a sliding hour", () => {
    let now = 0;
    const limiter = new MessageLimiter(2, () => now);
    expect(limiter.take("a", "b")).toBe(true);
    expect(limiter.take("a", "b")).toBe(true);
    expect(limiter.take("a", "b")).toBe(false);
    expect(limiter.take("b", "a")).toBe(true);
    now = 3_600_001;
    expect(limiter.take("a", "b")).toBe(true);
  });
});
