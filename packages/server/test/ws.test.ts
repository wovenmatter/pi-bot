import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PiBotApp, startPiBot } from "../src/app.ts";
import { parseConfig } from "../src/config.ts";
import type { ConversationSnapshot, ServerMessage } from "../src/protocol.ts";
import { echoModels, tempDir } from "./helpers.ts";
import { Client } from "./ws-client.ts";

const isFinalEntry = (conversationId: number, text: string) => (message: ServerMessage) =>
  message.type === "event" &&
  message.conversationId === conversationId &&
  message.event.kind === "entry" &&
  message.event.entry.role === "assistant" &&
  message.event.entry.text === text;

describe("websocket server", () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let app: PiBotApp;
  let wsUrl: string;

  beforeEach(async () => {
    dir = await tempDir();
    const config = parseConfig(
      `[models]\norchestrator = "faux/faux-1"\nbackground = "faux/faux-1"\n[storage]\ndata_dir = "${dir.path}"\n`,
    );
    app = await startPiBot(config, { models: echoModels(15).models, port: 0, log: () => {} });
    wsUrl = `${app.server.url.replace("http", "ws")}/ws`;
  });

  afterEach(async () => {
    await app.close();
    await dir.cleanup();
  });

  it("streams replies, reloads history, and forks threads", async () => {
    const client = await Client.open(wsUrl);
    await client.waitFor((message) => message.type === "hello");

    const { bot } = await client.request<{ bot: { id: string; name: string; createdAt: string } }>(
      "bots.create",
      {
        name: "Scout",
      },
    );
    // Admin Bot always exists and is listed first (oldest).
    expect((await client.request<{ bots: { id: string }[] }>("bots.list")).bots).toEqual([
      expect.objectContaining({ name: "Admin Bot", kind: "admin", manager: false }),
      expect.objectContaining({ id: bot.id, name: "Scout", kind: "bot", manager: false }),
    ]);

    const main = await client.request<ConversationSnapshot>("conversation.open", {
      botId: bot.id,
    });
    expect(main.entries).toEqual([]);
    expect(main.conversationId).toBe(main.mainConversationId);

    await client.request("message.send", { botId: bot.id, text: "hello" });
    await client.waitFor(isFinalEntry(main.conversationId, "echo: hello (n1)"));
    const events = client.events(main.conversationId);
    const kinds = events.map((event) => event.kind);
    expect(kinds).toContain("assistant_start");
    expect(kinds).toContain("delta");
    const streamed = events.flatMap((event) =>
      event.kind === "delta" || event.kind === "assistant_start" ? [event.text] : [],
    );
    // Partials are published every 100 ms; the final entry is authoritative.
    expect(streamed.join("").length).toBeGreaterThan(0);
    expect("echo: hello (n1)".startsWith(streamed.join(""))).toBe(true);

    await client.request("message.send", { botId: bot.id, text: "second" });
    await client.waitFor(isFinalEntry(main.conversationId, "echo: second (n2)"));

    // A fresh connection sees the persisted history.
    const other = await Client.open(wsUrl);
    const reloaded = await other.request<ConversationSnapshot>("conversation.open", {
      botId: bot.id,
    });
    expect(reloaded.entries.map((entry) => [entry.role, entry.text])).toEqual([
      ["user", "hello"],
      ["assistant", "echo: hello (n1)"],
      ["user", "second"],
      ["assistant", "echo: second (n2)"],
    ]);

    // Fork off the first reply: the thread inherits context up to it, not after.
    const firstReply = reloaded.entries[1];
    if (!firstReply) throw new Error("missing first reply");
    const { thread } = await other.request<{ thread: { conversationId: number; title?: string } }>(
      "thread.fork",
      { botId: bot.id, entryId: firstReply.id },
    );
    // Threads have no name of their own; a title is generated later as metadata.
    expect(thread.title).toBeUndefined();
    expect(thread.conversationId).not.toBe(main.conversationId);

    const opened = await other.request<ConversationSnapshot>("conversation.open", {
      botId: bot.id,
      conversationId: thread.conversationId,
    });
    expect(opened.entries.map((entry) => entry.text)).toEqual(["hello", "echo: hello (n1)"]);
    expect(opened.entries.every((entry) => entry.conversationId === main.conversationId)).toBe(
      true,
    );

    await other.request("message.send", {
      botId: bot.id,
      conversationId: thread.conversationId,
      text: "branch",
    });
    // n2: the thread saw "hello" and "branch", not "second".
    await other.waitFor(isFinalEntry(thread.conversationId, "echo: branch (n2)"));

    const { threads } = await other.request<{
      threads: { conversationId: number; title?: string }[];
    }>("threads.list", { botId: bot.id });
    expect(threads).toEqual([
      expect.objectContaining({
        conversationId: thread.conversationId,
        parentConversationId: main.conversationId,
        forkedAt: firstReply.id,
      }),
    ]);
    // Renaming is not part of the protocol.
    await expect(
      other.request("thread.fork", { botId: bot.id, entryId: firstReply.id, title: "Side quest" }),
    ).rejects.toThrow();

    // Main is untouched by the thread.
    const mainAgain = await other.request<ConversationSnapshot>("conversation.open", {
      botId: bot.id,
    });
    expect(mainAgain.entries).toHaveLength(4);

    expect(await other.request("bots.delete", { botId: bot.id })).toEqual({ deleted: true });
    expect((await other.request<{ bots: { name: string }[] }>("bots.list")).bots).toEqual([
      expect.objectContaining({ name: "Admin Bot" }),
    ]);
    // Soft-deleted: it cannot be opened or messaged any more.
    await expect(other.request("conversation.open", { botId: bot.id })).rejects.toThrow(
      /was deleted/,
    );
    // Restorable only through the user's Deleted bots requests.
    const deleted = await other.request<{ bots: { id: string; deletedAt: string }[] }>(
      "bots.listDeleted",
    );
    expect(deleted.bots).toEqual([
      {
        id: bot.id,
        name: bot.name,
        createdAt: bot.createdAt,
        kind: "bot",
        manager: false,
        profileId: "default",
        profileName: "Default",
        defaultProfile: true,
        deletedAt: expect.any(String),
      },
    ]);
    expect(await other.request("bots.restore", { botId: bot.id })).toEqual({
      restored: true,
      bot: {
        id: bot.id,
        name: bot.name,
        createdAt: bot.createdAt,
        kind: "bot",
        manager: false,
        profileId: "default",
        profileName: "Default",
        defaultProfile: true,
      },
    });
    expect(await other.request("bots.restore", { botId: bot.id })).toEqual({ restored: false });
    expect((await other.request<{ bots: unknown[] }>("bots.listDeleted")).bots).toEqual([]);
    expect((await other.request<{ bots: { id: string }[] }>("bots.list")).bots).toEqual([
      expect.objectContaining({ name: "Admin Bot" }),
      expect.objectContaining({ id: bot.id }),
    ]);
    const reopened = await other.request<ConversationSnapshot>("conversation.open", {
      botId: bot.id,
    });
    expect(reopened.entries).toHaveLength(4);
    client.close();
    other.close();
  });

  it("manages one-level teams, keeps Admin Bot off them, and pushes bot changes", async () => {
    type Summary = { id: string; name: string; kind: string; manager: boolean; managerId?: string };
    const client = await Client.open(wsUrl);
    const watcher = await Client.open(wsUrl);
    const create = async (name: string, managerId?: string) =>
      (
        await client.request<{ bot: Summary }>("bots.create", {
          name,
          ...(managerId ? { managerId } : {}),
        })
      ).bot;
    const list = async () => (await client.request<{ bots: Summary[] }>("bots.list")).bots;
    const admin = (await list())[0];
    if (!admin) throw new Error("no Admin Bot");

    const lead = await create("Lead");
    await watcher.waitFor((message) => message.type === "bots.changed");
    await expect(create("Early", lead.id)).rejects.toThrow(/not a manager/);
    expect(
      (await client.request<{ bot: Summary }>("bots.setManager", { botId: lead.id, manager: true }))
        .bot,
    ).toMatchObject({ manager: true });
    const member = await create("Member", lead.id);
    expect(member.managerId).toBe(lead.id);
    const loose = await create("Loose");
    await client.request("bots.setTeam", { botId: loose.id, managerId: lead.id });

    // Admin Bot is not deletable and never on a team; managers have no manager.
    await expect(client.request("bots.delete", { botId: admin.id })).rejects.toThrow(/Admin Bot/);
    await expect(
      client.request("bots.setManager", { botId: admin.id, manager: true }),
    ).rejects.toThrow(/Admin Bot/);
    await expect(
      client.request("bots.setTeam", { botId: admin.id, managerId: lead.id }),
    ).rejects.toThrow(/Admin Bot/);
    await expect(
      client.request("bots.setTeam", { botId: lead.id, managerId: lead.id }),
    ).rejects.toThrow();

    // A member takes over the team; the old manager becomes a member.
    await client.request("bots.replaceManager", { managerId: lead.id, newManagerId: member.id });
    let bots = await list();
    expect(bots.find((entry) => entry.id === member.id)).toMatchObject({ manager: true });
    expect(bots.find((entry) => entry.id === member.id)?.managerId).toBeUndefined();
    expect(bots.find((entry) => entry.id === lead.id)).toMatchObject({
      manager: false,
      managerId: member.id,
    });
    expect(bots.find((entry) => entry.id === loose.id)?.managerId).toBe(member.id);

    // Deleting a manager ungroups its team; restored, it comes back without one.
    await client.request("bots.delete", { botId: member.id });
    bots = await list();
    expect(bots.filter((entry) => entry.managerId)).toEqual([]);
    const restored = await client.request<{ bot: Summary }>("bots.restore", { botId: member.id });
    expect(restored.bot).toMatchObject({ manager: false });
    expect((await list()).filter((entry) => entry.managerId)).toEqual([]);
    client.close();
    watcher.close();
  });

  it("rejects invalid requests and unknown bots", async () => {
    const client = await Client.open(wsUrl);
    await expect(client.request("nope")).rejects.toThrow(/invalid request/);
    await expect(
      client.request("conversation.open", { botId: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toThrow(/no bot/);
    client.close();
  });

  it("refuses cross-site upgrades", async () => {
    await expect(Client.open(wsUrl, { origin: "https://evil.example" })).rejects.toThrow(/403/);
    await expect(Client.open(wsUrl, { host: "evil.example" })).rejects.toThrow(/403/);
    const ok = await Client.open(wsUrl, { origin: "http://localhost:5173" });
    ok.close();
  });

  it("serves health on loopback", async () => {
    const response = await fetch(`${app.server.url}/health`);
    expect(await response.json()).toEqual({ ok: true, version: "0.1.0" });
  });
});

describe("websocket thread titles", () => {
  it("pushes threads.changed when a thread is titled", async () => {
    const dir = await tempDir();
    const config = parseConfig(
      `[models]\norchestrator = "faux/faux-1"\nbackground = "faux/faux-1"\n[models.titles]\nmodel = "faux-titles/t1"\n[storage]\ndata_dir = "${dir.path}"\n`,
    );
    // Replies echo; titles come from their own faux provider.
    const { models } = echoModels(2000);
    const titler = fauxProvider({ provider: "faux-titles", models: [{ id: "t1" }] });
    titler.setResponses([() => fauxAssistantMessage([fauxText('{"title":"Trip planning"}')])]);
    models.setProvider(titler.provider);
    const app = await startPiBot(config, { models, port: 0, log: () => {} });
    try {
      const client = await Client.open(`${app.server.url.replace("http", "ws")}/ws`);
      const { bot } = await client.request<{ bot: { id: string } }>("bots.create", { name: "T" });
      const main = await client.request<ConversationSnapshot>("conversation.open", {
        botId: bot.id,
      });
      await client.request("message.send", { botId: bot.id, text: "hello" });
      await client.waitFor(isFinalEntry(main.conversationId, "echo: hello (n1)"));
      const reply = (
        await client.request<ConversationSnapshot>("conversation.open", { botId: bot.id })
      ).entries[1];
      if (!reply) throw new Error("missing reply");
      const { thread } = await client.request<{ thread: { conversationId: number } }>(
        "thread.fork",
        { botId: bot.id, entryId: reply.id },
      );
      await client.request("message.send", {
        botId: bot.id,
        conversationId: thread.conversationId,
        text: "plan the trip",
      });
      await client.waitFor(
        (message) => message.type === "threads.changed" && message.botId === bot.id,
      );
      const { threads } = await client.request<{ threads: { title?: string }[] }>("threads.list", {
        botId: bot.id,
      });
      expect(threads[0]?.title).toBe("Trip planning");
      client.close();
    } finally {
      await app.close();
      await dir.cleanup();
    }
  });
});
