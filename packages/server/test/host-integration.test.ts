import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PiBotApp, startPiBot } from "../src/app.ts";
import { parseConfig } from "../src/config.ts";
import { fallbackNote } from "../src/limits.ts";
import { contextNote, stripContextNote } from "../src/message-context.ts";
import type { BotSummary, ConversationSnapshot } from "../src/protocol.ts";
import { openSharedDatabase } from "../src/storage/database.ts";
import { BotRegistry, type SidebarGroup } from "../src/storage/registry.ts";
import { echoModels, tempDir } from "./helpers.ts";
import { Client } from "./ws-client.ts";

const ctx = BACKGROUND_CONTEXT;
describe("Woven host protocol", () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let app: PiBotApp;
  let client: Client;
  const open = async () => {
    app = await startPiBot(
      parseConfig(
        `[models]\norchestrator = "faux/faux-1"\n[storage]\ndata_dir = "${dir.path}"\n[credentials]\nbackend = "encrypted-sqlite"\n[environment]\nbackend = "none"\n[extraction]\nenabled = false\n`,
      ),
      { models: echoModels().models, port: 0, log: () => {} },
    );
    client = await Client.open(`${app.server.url.replace("http", "ws")}/ws`);
  };
  beforeEach(async () => {
    dir = await tempDir();
    await open();
  });
  afterEach(async () => {
    client.close();
    await app.close();
    await dir.cleanup();
  });

  it("accepts a retried host delivery without submitting it twice", async () => {
    const { bots } = (await client.request("bots.list")) as { bots: BotSummary[] };
    const botId = bots[0]?.id as string;
    const first = (await client.request("message.send", {
      botId,
      text: "session finished",
      deliveryId: "delivery-1",
    })) as { submissionId?: unknown };
    expect(first.submissionId).toBeDefined();
    const retry = await client.request("message.send", {
      botId,
      text: "session finished",
      deliveryId: "delivery-1",
    });
    expect(retry).toEqual({ duplicate: true });
  });

  it("joins a retry that overlaps the original delivery", async () => {
    const { bots } = (await client.request("bots.list")) as { bots: BotSummary[] };
    const botId = bots[0]?.id as string;
    const body = { botId, text: "session finished", deliveryId: "delivery-3" };
    const [first, retry] = (await Promise.all([
      client.request("message.send", body),
      client.request("message.send", body),
    ])) as [{ submissionId?: unknown }, { submissionId?: unknown; duplicate?: unknown }];
    expect(first.submissionId).toBeDefined();
    // Whichever arrives second joins the first, or finds it already finished. Neither submits.
    if (retry.duplicate !== true) expect(retry.submissionId).toBe(first.submissionId);
    const { entries } = (await client.request("conversation.open", { botId })) as {
      entries: { role: string; text?: string }[];
    };
    expect(
      entries.filter((entry) => entry.role === "user" && entry.text === body.text),
    ).toHaveLength(1);
  });

  it("lets a retry through when a delivery was claimed but never accepted", async () => {
    const { bots } = (await client.request("bots.list")) as { bots: BotSummary[] };
    const botId = bots[0]?.id as string;
    // A crash between claiming and accepting leaves exactly this row behind.
    expect(await app.manager.registry.claimDelivery("delivery-2")).toBe(true);
    const retry = (await client.request("message.send", {
      botId,
      text: "session finished",
      deliveryId: "delivery-2",
    })) as { submissionId?: unknown };
    expect(retry.submissionId).toBeDefined();
    expect(await app.manager.registry.claimDelivery("delivery-2")).toBe(false);
  });

  it("adds the accepted column to a deliveries table from an earlier revision", async () => {
    const db = await openSharedDatabase(":memory:");
    await db.exec(
      "CREATE TABLE pibot_host_deliveries (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL) STRICT",
    );
    await db.run(
      "INSERT INTO pibot_host_deliveries (id, created_at) VALUES ('old', ?)",
      Date.now(),
    );
    const registry = new BotRegistry(db);
    await registry.migrate();
    await registry.migrate();
    expect(await registry.claimDelivery("old")).toBe(true);
    await registry.acceptDelivery("old");
    expect(await registry.claimDelivery("old")).toBe(false);
    await db.close();
  });

  it("publishes the same persisted UUID and capabilities on health and hello after restart", async () => {
    const health = (await (await fetch(`${app.server.url}/health`)).json()) as {
      protocol: number;
      installationId: string;
      capabilities: string[];
      ok: boolean;
      version: string;
    };
    expect(health).toMatchObject({
      protocol: 1,
      installationId: expect.stringMatching(/^[a-f0-9-]{36}$/),
      capabilities: ["groups", "woven.mcp", "message.context"],
    });
    const hello = await client.waitFor((message) => message.type === "hello");
    expect(hello).toMatchObject({
      protocol: health.protocol,
      installationId: health.installationId,
      capabilities: health.capabilities,
      type: "hello",
    });
    expect(app.env).toBeUndefined();
    expect(app.credentials.backend).toBe("encrypted-sqlite");
    client.close();
    await app.close();
    await open();
    expect(await (await fetch(`${app.server.url}/health`)).json()).toEqual(health);
  });

  it("stores groups independently of teams and broadcasts CRUD, reorder, membership and purge", async () => {
    const admin = await app.manager.admin();
    const lead = await app.manager.create("Manager");
    await app.manager.setManager(lead.id, true);
    const member = await app.manager.create("Member", { managerId: lead.id });
    const { group: a } = await client.request<{ group: SidebarGroup }>("groups.create", {
      name: "Work",
    });
    const { group: b } = await client.request<{ group: SidebarGroup }>("groups.create", {
      name: "Home",
    });
    await client.waitFor((message) => message.type === "groups.changed");
    expect(await client.request("groups.rename", { groupId: a.id, name: "Projects" })).toEqual({
      group: { ...a, name: "Projects" },
    });
    expect(await client.request("groups.reorder", { groupIds: [b.id, a.id] })).toMatchObject({
      groups: [
        { id: b.id, position: 0 },
        { id: a.id, position: 1 },
      ],
    });
    await expect(client.request("groups.reorder", { groupIds: [a.id, a.id] })).rejects.toThrow(
      /exactly once/,
    );
    await expect(client.request("groups.reorder", { groupIds: [] })).rejects.toThrow(
      /exactly once/,
    );
    await expect(client.request("groups.create", { name: "  " })).rejects.toThrow();
    await expect(
      client.request("bots.setGroup", { botId: admin?.id, groupId: a.id }),
    ).rejects.toThrow(/Admin Bot/);
    const { bot } = await client.request<{ bot: BotSummary }>("bots.setGroup", {
      botId: member.id,
      groupId: a.id,
    });
    expect(bot).toMatchObject({
      groupId: a.id,
      managerId: lead.id,
      manager: false,
      kind: "bot",
      orchestrator: false,
    });
    await client.waitFor((message) => message.type === "bots.changed");
    await expect(
      client.request("bots.setGroup", {
        botId: member.id,
        groupId: "00000000-0000-4000-8000-000000000000",
      }),
    ).rejects.toThrow(/group/);
    client.close();
    await app.close();
    await open();
    expect((await app.manager.record(member.id)).groupId).toBe(a.id);
    expect(await client.request("groups.list")).toMatchObject({
      groups: [{ id: b.id }, { id: a.id }],
    });
    await client.request("groups.delete", { groupId: a.id });
    expect(await app.manager.record(member.id)).toMatchObject({ managerId: lead.id });
    expect((await app.manager.record(member.id)).groupId).toBeUndefined();
    await client.request("bots.setGroup", { botId: member.id, groupId: b.id });
    await client.request("bots.setGroup", { botId: member.id, groupId: null });
    expect((await app.manager.record(member.id)).groupId).toBeUndefined();
    await client.request("bots.setGroup", { botId: member.id, groupId: b.id });
    await client.request("bots.delete", { botId: member.id });
    await client.request("bots.purge", { botId: member.id });
    expect(await app.db.get("SELECT id FROM pibot_bots WHERE id = ?", member.id)).toBeUndefined();
    expect(await client.request("groups.list")).toMatchObject({ groups: [{ id: b.id }] });
  });

  it("sends bounded host context ahead of one user turn, hides it in snapshots and forbids bot context", async () => {
    const bot = await app.manager.get((await app.manager.create("Context")).id);
    const opened = await client.request<ConversationSnapshot>("conversation.open", {
      botId: bot.id,
    });
    const context = 'Selected document: "Report"\nLine 2 ]';
    await client.request("message.send", { botId: bot.id, text: "Review this", context });
    await client.waitFor(
      (message) =>
        message.type === "event" && message.event.kind === "run" && message.event.state === "end",
    );
    const snapshot = await client.request<ConversationSnapshot>("conversation.open", {
      botId: bot.id,
    });
    expect(snapshot.entries.find((entry) => entry.role === "user")?.text).toBe("Review this");
    expect(snapshot.entries.find((entry) => entry.role === "assistant")?.text).toContain(
      contextNote(context),
    );
    expect(
      client
        .events(opened.conversationId)
        .some(
          (event) =>
            event.kind === "entry" &&
            event.entry.role === "user" &&
            event.entry.text === "Review this",
        ),
    ).toBe(true);
    await expect(
      client.request("message.send", { botId: bot.id, text: "long", context: "x".repeat(4001) }),
    ).rejects.toThrow();
    const sent = await bot.send("from bot", undefined, 1, "must not reach model");
    await sent.submission.wait(ctx);
    const raw = await (await bot.main()).context(ctx);
    expect(JSON.stringify(raw)).not.toContain("must not reach model");
    expect(stripContextNote(`${contextNote(context)}\n\nVisible`)).toBe("Visible");
    const note = fallbackNote("a/b", "usage", "c/d");
    expect(note).toContain("Note:");
  });
});

it("migrates a legacy registry without changing team columns or bot data", async () => {
  const db = await openSharedDatabase(":memory:");
  try {
    await db.exec(
      "CREATE TABLE pibot_bots (id TEXT PRIMARY KEY, name TEXT NOT NULL, schema_prefix TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, is_manager INTEGER NOT NULL DEFAULT 0, manager_id TEXT) STRICT;",
    );
    await db.run(
      "INSERT INTO pibot_bots VALUES (?, 'Existing', 'pibot_existing_', '2026-01-01', 1, NULL)",
      "00000000-0000-4000-8000-000000000000",
    );
    const registry = new BotRegistry(db);
    await registry.migrate();
    await registry.migrate();
    const group = await registry.createGroup("First");
    const bot = (await registry.list())[0];
    expect(bot).toMatchObject({ name: "Existing", manager: true });
    if (!bot) throw new Error("missing bot");
    await registry.setGroup(bot.id, group.id);
    expect((await registry.get(bot.id))?.groupId).toBe(group.id);
    await registry.deleteGroup(group.id);
    expect((await registry.get(bot.id))?.groupId).toBeUndefined();
  } finally {
    await db.close();
  }
});
