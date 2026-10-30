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
});
