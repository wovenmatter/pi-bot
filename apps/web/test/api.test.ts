import { afterEach, describe, expect, it, vi } from "vitest";
import { PiBotClient } from "../src/api.ts";

/** Just enough WebSocket for PiBotClient: listeners and a way to deliver a server message. */
class FakeSocket {
  static last: FakeSocket | undefined;
  readonly #listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
  constructor() {
    FakeSocket.last = this;
  }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
  send(): void {}
  close(): void {}
}

afterEach(() => vi.unstubAllGlobals());

describe("PiBotClient", () => {
  it("rejects pending requests immediately on close and ignores stale sockets", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const client = new PiBotClient("ws://pi-bot.test/ws");
    client.connect();
    const old = FakeSocket.last;
    if (!old) throw new Error("no socket");
    old.emit("open");
    const pending = client.request("bots.list", {});
    const rejected = expect(pending).rejects.toThrow("Connection closed");
    client.close();
    await rejected;
    client.connect();
    old.emit("open");
    expect(client.state).toBe("connecting");
    const listener = vi.fn();
    client.onBotsChanged(listener);
    old.emit("message", { data: JSON.stringify({ type: "bots.changed" }) });
    expect(listener).not.toHaveBeenCalled();
    client.close();
  });

  it("passes threads.changed pushes to thread listeners with the bot id", () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const client = new PiBotClient("ws://pi-bot.test/ws");
    client.connect();
    const socket = FakeSocket.last;
    if (!socket) throw new Error("no socket");
    socket.emit("open");
    const seen: string[] = [];
    const bots = vi.fn();
    const stop = client.onThreadsChanged((botId) => seen.push(botId));
    client.onBotsChanged(bots);

    socket.emit("message", { data: JSON.stringify({ type: "threads.changed", botId: "b1" }) });
    stop();
    socket.emit("message", { data: JSON.stringify({ type: "threads.changed", botId: "b2" }) });

    expect(seen).toEqual(["b1"]);
    expect(bots).not.toHaveBeenCalled();
    client.close();
  });

  it("passes memory.changed pushes to memory listeners with the bot id", () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const client = new PiBotClient("ws://pi-bot.test/ws");
    client.connect();
    const socket = FakeSocket.last;
    if (!socket) throw new Error("no socket");
    socket.emit("open");
    const seen: string[] = [];
    const threads = vi.fn();
    const stop = client.onMemoryChanged((botId) => seen.push(botId));
    client.onThreadsChanged(threads);

    socket.emit("message", { data: JSON.stringify({ type: "memory.changed", botId: "b1" }) });
    stop();
    socket.emit("message", { data: JSON.stringify({ type: "memory.changed", botId: "b2" }) });

    expect(seen).toEqual(["b1"]);
    expect(threads).not.toHaveBeenCalled();
    client.close();
  });
});
