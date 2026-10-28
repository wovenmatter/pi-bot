import { z } from "zod";
import type { LoginEvent } from "./settings/service.ts";
import type { DisplayEntry } from "./transcript.ts";

const botId = z.string().uuid();
const conversationId = z.number().int().nonnegative();
const accountId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const modelRefText = z.string().min(3).max(200);
const configText = z.string().max(256 * 1024);
const requestId = z.union([z.string().max(64), z.number().int()]);

/** Client → server requests. Every request carries an `id` echoed in its result or error. */
export const requestSchema = z.discriminatedUnion("type", [
  z.object({ id: requestId, type: z.literal("bots.list") }),
  z.object({ id: requestId, type: z.literal("bots.create"), name: z.string().min(1).max(80) }),
  z.object({ id: requestId, type: z.literal("bots.delete"), botId }),
  // User-only, from Settings → Deleted bots. Never exposed to agent or orchestrator tools.
  z.object({ id: requestId, type: z.literal("bots.listDeleted") }),
  z.object({ id: requestId, type: z.literal("bots.restore"), botId }),
  z.object({ id: requestId, type: z.literal("bots.orchestrator") }),
  z.object({ id: requestId, type: z.literal("bots.setOrchestrator"), botId }),
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
  z.strictObject({
    id: requestId,
    type: z.literal("thread.fork"),
    botId,
    conversationId: conversationId.optional(),
    entryId: z.number().int().nonnegative(),
    // Strict: threads cannot be named or renamed (`title` is rejected).
  }),
  z.object({
    id: requestId,
    type: z.literal("threads.list"),
    botId,
    /** Search thread titles (every term must match). */
    query: z.string().max(200).optional(),
  }),
  // Settings (user-only, from the Settings page). Secrets are write-only: nothing returns a key.
  z.strictObject({ id: requestId, type: z.literal("settings.accounts") }),
  z.strictObject({
    id: requestId,
    type: z.literal("credentials.set"),
    accountId,
    key: z.string().min(1).max(8192),
  }),
  z.strictObject({ id: requestId, type: z.literal("credentials.remove"), accountId }),
  z.strictObject({
    id: requestId,
    type: z.literal("login.start"),
    accountId,
    method: z.string().min(1).max(64).optional(),
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("login.respond"),
    loginId: z.string().uuid(),
    promptId: z.string().uuid(),
    value: z.string().max(8192),
  }),
  z.strictObject({ id: requestId, type: z.literal("login.cancel"), loginId: z.string().uuid() }),
  z.strictObject({ id: requestId, type: z.literal("models.catalog") }),
  z.strictObject({
    id: requestId,
    type: z.literal("models.setRoles"),
    orchestrator: modelRefText.optional(),
    background: modelRefText.optional(),
    titles: modelRefText.optional(),
    titlesReasoning: z.string().max(16).optional(),
  }),
  z.strictObject({ id: requestId, type: z.literal("config.get") }),
  z.strictObject({ id: requestId, type: z.literal("config.validate"), text: configText }),
  z.strictObject({ id: requestId, type: z.literal("config.save"), text: configText }),
  z.strictObject({
    id: requestId,
    type: z.literal("config.update"),
    edits: z
      .array(
        z.strictObject({
          path: z
            .array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/))
            .min(1)
            .max(4),
          value: z.union([z.string().max(1000), z.number().finite(), z.boolean()]),
        }),
      )
      .min(1)
      .max(20),
  }),
  z.strictObject({ id: requestId, type: z.literal("github.get") }),
  z.strictObject({
    id: requestId,
    type: z.literal("github.setSshKey"),
    privateKey: z.string().min(1).max(16_384),
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("github.generateSshKey"),
    comment: z
      .string()
      .regex(/^[\x21-\x7e]{1,100}$/)
      .default("pi-bot"),
  }),
  z.strictObject({ id: requestId, type: z.literal("github.removeSshKey") }),
  z.strictObject({
    id: requestId,
    type: z.literal("github.setIdentity"),
    name: z.string().trim().min(1).max(200),
    email: z.email().max(320),
  }),
  z.strictObject({ id: requestId, type: z.literal("server.restart") }),
]);

export type Request = z.infer<typeof requestSchema>;
export type RequestType = Request["type"];

export type BotSummary = { id: string; name: string; createdAt: string };
export type DeletedBotSummary = BotSummary & { deletedAt: string };
export type ThreadSummary = {
  conversationId: number;
  parentConversationId: number;
  forkedAt: number;
  /** Generated metadata for listing and search; absent until generated. Never shown in the UI. */
  title?: string;
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
  | { type: "event"; botId: string; conversationId: number; event: StreamEvent }
  /** Progress of a sign-in started by this connection (`login.start`). */
  | { type: "login"; loginId: string; event: LoginEvent };
