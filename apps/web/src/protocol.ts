// Wire types for the Pi Bot WebSocket API. Mirrors packages/server/src/protocol.ts; the web
// client keeps its own copy so it never imports server code into the browser bundle.

export type DisplayEntry = {
  readonly id: number;
  /** The conversation that owns the entry; differs from the viewed one for inherited entries. */
  readonly conversationId: number;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly error?: string;
};

export type BotSummary = { id: string; name: string; createdAt: string };

export type ThreadSummary = {
  conversationId: number;
  parentConversationId: number;
  forkedAt: number;
  title: string;
  createdAt: string;
};

export type ConversationSnapshot = {
  botId: string;
  conversationId: number;
  mainConversationId: number;
  entries: DisplayEntry[];
  running: boolean;
  streaming?: string;
};

export type StreamEvent =
  | { kind: "run"; state: "start" | "end" }
  | { kind: "assistant_start"; text: string }
  | { kind: "delta"; text: string }
  | { kind: "entry"; entry: DisplayEntry }
  | { kind: "error"; message: string };

export type EventMessage = {
  type: "event";
  botId: string;
  conversationId: number;
  event: StreamEvent;
};

export type ServerMessage =
  | { type: "hello"; version: string }
  | { type: "result"; id: string | number; data: unknown }
  | { type: "error"; id?: string | number; message: string }
  | EventMessage;

/** Request bodies (without `id`) and the result each one resolves to. */
export type Requests = {
  "bots.list": { body: Record<never, never>; result: { bots: BotSummary[] } };
  "bots.create": { body: { name: string }; result: { bot: BotSummary } };
  "bots.delete": { body: { botId: string }; result: { deleted: boolean } };
  "conversation.open": {
    body: { botId: string; conversationId?: number };
    result: ConversationSnapshot;
  };
  "conversation.close": {
    body: { botId: string; conversationId: number };
    result: { closed: boolean };
  };
  "message.send": {
    body: { botId: string; conversationId?: number; text: string };
    result: { conversationId: number; submissionId: number };
  };
  "thread.fork": {
    body: { botId: string; conversationId?: number; entryId: number; title?: string };
    result: { thread: ThreadSummary };
  };
  "threads.list": { body: { botId: string }; result: { threads: ThreadSummary[] } };
};
