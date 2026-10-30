import type { DisplayEntry, StreamEvent, ThreadSummary } from "../protocol.ts";

/** A thread's read-only name: its generated title, else a placeholder until one arrives. */
export const threadLabel = (thread: ThreadSummary | undefined): string =>
  thread?.title || "Untitled thread";

export type PendingMessage = { key: number; text: string };

export type ConversationState = {
  entries: DisplayEntry[];
  /** Text of the assistant reply being generated; the final entry replaces it. */
  streaming: string | null;
  running: boolean;
  /** Sent messages not yet recorded as entries (queued behind a running reply). */
  pending: PendingMessage[];
};

export const emptyConversation: ConversationState = {
  entries: [],
  streaming: null,
  running: false,
  pending: [],
};

/** Adds or replaces entries by id, keeping first-seen order (history arrives oldest first). */
export function mergeEntries(current: DisplayEntry[], incoming: DisplayEntry[]): DisplayEntry[] {
  const next = [...current];
  for (const entry of incoming) {
    const index = next.findIndex((existing) => existing.id === entry.id);
    if (index === -1) next.push(entry);
    else next[index] = entry;
  }
  return next;
}

export function applyStreamEvent(state: ConversationState, event: StreamEvent): ConversationState {
  switch (event.kind) {
    case "run":
      return event.state === "start"
        ? { ...state, running: true }
        : { ...state, running: false, streaming: null };
    case "assistant_start":
      return { ...state, streaming: event.text };
    case "delta":
      return { ...state, streaming: (state.streaming ?? "") + event.text };
    case "entry": {
      const { entry } = event;
      let pending = state.pending;
      if (entry.role === "user") {
        const index = pending.findIndex((item) => item.text === entry.text);
        if (index !== -1) pending = pending.filter((_, i) => i !== index);
      }
      return {
        ...state,
        entries: mergeEntries(state.entries, [entry]),
        streaming: entry.role === "assistant" ? null : state.streaming,
        pending,
      };
    }
    case "error":
      return state;
  }
}
