import { describe, expect, it } from "vitest";
import {
  applyStreamEvent,
  emptyConversation,
  mergeEntries,
} from "../src/features/conversation-state.ts";
import { parseRoute, routeHref } from "../src/routes.ts";

const user = { id: 1, conversationId: 7, role: "user", text: "hi" } as const;
const reply = { id: 2, conversationId: 7, role: "assistant", text: "hello there" } as const;

describe("conversation state", () => {
  it("builds streaming text and replaces it with the final entry", () => {
    let state = applyStreamEvent(emptyConversation, { kind: "run", state: "start" });
    state = applyStreamEvent(state, { kind: "assistant_start", text: "hel" });
    state = applyStreamEvent(state, { kind: "delta", text: "lo" });
    expect(state.streaming).toBe("hello");
    state = applyStreamEvent(state, { kind: "entry", entry: reply });
    expect(state.streaming).toBeNull();
    expect(state.entries).toEqual([reply]);
    state = applyStreamEvent(state, { kind: "run", state: "end" });
    expect(state.running).toBe(false);
  });

  it("clears a pending message when its user entry arrives", () => {
    const state = applyStreamEvent(
      { ...emptyConversation, pending: [{ key: 1, text: "hi" }] },
      { kind: "entry", entry: user },
    );
    expect(state.pending).toEqual([]);
    expect(state.entries).toEqual([user]);
  });

  it("de-duplicates entries by id, keeping order", () => {
    const updated = { ...reply, text: "final" };
    expect(mergeEntries([user, reply], [updated, user])).toEqual([user, updated]);
  });
});

describe("routes", () => {
  it("round-trips bot and thread routes", () => {
    expect(parseRoute("")).toEqual({});
    expect(parseRoute(routeHref({ botId: "b" }))).toEqual({ botId: "b" });
    expect(parseRoute(routeHref({ botId: "b", conversationId: 3 }))).toEqual({
      botId: "b",
      conversationId: 3,
    });
    expect(parseRoute("#/b/x")).toEqual({ botId: "b" });
  });
});
