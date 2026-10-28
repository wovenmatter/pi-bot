import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type PiBotApp, startPiBot } from "../src/app.ts";
import { parseConfig } from "../src/config.ts";
import type { ConversationSnapshot, ServerMessage, StreamEvent } from "../src/protocol.ts";
import { echoModels, tempDir } from "./helpers.ts";

class Client {
  readonly messages: ServerMessage[] = [];
  readonly #socket: WebSocket;
  readonly #waiters = new Set<() => void>();
  #next = 1;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (data) => {
      this.messages.push(JSON.parse(data.toString()) as ServerMessage);
      for (const wake of this.#waiters) wake();
    });
  }

  static open(url: string, headers: Record<string, string> = {}): Promise<Client> {
    const socket = new WebSocket(url, { headers });
    return new Promise((resolve, reject) => {
      const client = new Client(socket);
      socket.once("open", () => resolve(client));
      socket.once("error", reject);
      socket.once("unexpected-response", (_request, response) =>
        reject(new Error(`HTTP ${response.statusCode}`)),
      );
    });
  }

  waitFor<T extends ServerMessage>(predicate: (message: ServerMessage) => boolean, timeout = 5000) {
    return new Promise<T>((resolve, reject) => {
      const check = () => {
        const found = this.messages.find(predicate);
        if (!found) return;
        this.#waiters.delete(check);
        clearTimeout(timer);
        resolve(found as T);
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(check);
        reject(new Error("timed out waiting for message"));
      }, timeout);
      this.#waiters.add(check);
      check();
    });
  }

  async request<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    const id = this.#next++;
    this.#socket.send(JSON.stringify({ id, type, ...payload }));
    const reply = await this.waitFor(
      (message) => (message.type === "result" || message.type === "error") && message.id === id,
    );
    if (reply.type === "error") throw new Error(reply.message);
    return (reply as Extract<ServerMessage, { type: "result" }>).data as T;
  }

  events(conversationId: number): StreamEvent[] {
    return this.messages.flatMap((message) =>
      message.type === "event" && message.conversationId === conversationId ? [message.event] : [],
    );
  }

  close() {
    this.#socket.close();
  }
}

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
    expect((await client.request<{ bots: { id: string }[] }>("bots.list")).bots).toEqual([
      expect.objectContaining({ id: bot.id, name: "Scout" }),
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
    expect((await other.request<{ bots: unknown[] }>("bots.list")).bots).toEqual([]);
    // Soft-deleted: it cannot be opened or messaged any more.
    await expect(other.request("conversation.open", { botId: bot.id })).rejects.toThrow(
      /was deleted/,
    );
    // Restorable only through the user's Deleted bots requests.
    const deleted = await other.request<{ bots: { id: string; deletedAt: string }[] }>(
      "bots.listDeleted",
    );
    expect(deleted.bots).toEqual([
      { id: bot.id, name: bot.name, createdAt: bot.createdAt, deletedAt: expect.any(String) },
    ]);
    expect(await other.request("bots.restore", { botId: bot.id })).toEqual({
      restored: true,
      bot: { id: bot.id, name: bot.name, createdAt: bot.createdAt },
    });
    expect(await other.request("bots.restore", { botId: bot.id })).toEqual({ restored: false });
    expect((await other.request<{ bots: unknown[] }>("bots.listDeleted")).bots).toEqual([]);
    expect((await other.request<{ bots: { id: string }[] }>("bots.list")).bots).toEqual([
      expect.objectContaining({ id: bot.id }),
    ]);
    const reopened = await other.request<ConversationSnapshot>("conversation.open", {
      botId: bot.id,
    });
    expect(reopened.entries).toHaveLength(4);
    client.close();
    other.close();
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
