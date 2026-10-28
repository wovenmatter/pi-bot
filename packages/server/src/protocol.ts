import { z } from "zod";
import type { DisplayEntry } from "./transcript.ts";

const botId = z.string().uuid();
const conversationId = z.number().int().nonnegative();
const requestId = z.union([z.string().max(64), z.number().int()]);

/** Client → server requests. Every request carries an `id` echoed in its result or error. */
export const requestSchema = z.discriminatedUnion("type", [
  z.object({ id: requestId, type: z.literal("bots.list") }),
  z.object({ id: requestId, type: z.literal("bots.create"), name: z.string().min(1).max(80) }),
  z.object({ id: requestId, type: z.literal("bots.delete"), botId }),
  z.object({
    id: requestId,
    type: z.literal("conversation.open"),
    botId,
    conversationId: conversationId.optional(),
  }),
  z.object({
    id: requestId,
    type: z.literal("conversation.close"),
    botId,
    conversationId,
  }),
  z.object({
    id: requestId,
    type: z.literal("message.send"),
    botId,
    conversationId: conversationId.optional(),
    text: z.string().min(1).max(100_000),
  }),
  z.object({
    id: requestId,
    type: z.literal("thread.fork"),
    botId,
    conversationId: conversationId.optional(),
    entryId: z.number().int().nonnegative(),
    title: z.string().max(120).optional(),
  }),
  z.object({ id: requestId, type: z.literal("threads.list"), botId }),
]);

export type Request = z.infer<typeof requestSchema>;
export type RequestType = Request["type"];

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
  /** Oldest first; inherited entries carry their parent's conversationId. */
  entries: DisplayEntry[];
  running: boolean;
  /** Text of an assistant message still being generated when the conversation was opened. */
  streaming?: string;
};

export type StreamEvent =
  | { kind: "run"; state: "start" | "end" }
  | { kind: "assistant_start"; text: string }
  | { kind: "delta"; text: string }
  | { kind: "entry"; entry: DisplayEntry }
  | { kind: "error"; message: string };

/** Server → client messages. */
export type ServerMessage =
  | { type: "hello"; version: string }
  | { type: "result"; id: string | number; data: unknown }
  | { type: "error"; id?: string | number; message: string }
  | { type: "event"; botId: string; conversationId: number; event: StreamEvent };
