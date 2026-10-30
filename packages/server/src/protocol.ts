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
  z.object({
    id: requestId,
    type: z.literal("bots.create"),
    name: z.string().min(1).max(80),
    managerId: botId.optional(),
  }),
  // The Admin Bot is rejected: it cannot be deleted.
  z.object({ id: requestId, type: z.literal("bots.delete"), botId }),
  // User-only, from Settings → Bots → Deleted bots. Never exposed to agent tools.
  z.object({ id: requestId, type: z.literal("bots.listDeleted") }),
  z.object({ id: requestId, type: z.literal("bots.restore"), botId }),
  // Teams (Settings → Bots). One level: managers have no manager; Admin Bot is never on a team.
  z.strictObject({
    id: requestId,
    type: z.literal("bots.setManager"),
    botId,
    manager: z.boolean(),
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("bots.setTeam"),
    botId,
    managerId: botId.nullable(),
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("bots.replaceManager"),
    managerId: botId,
    newManagerId: botId,
  }),
  // First-run onboarding: sign in to a provider, then (if Admin Bot's profile's main model is
  // not available) pick that main model; Admin Bot then sets up profiles in chat.
  z.strictObject({ id: requestId, type: z.literal("onboarding.status") }),
  z.strictObject({
    id: requestId,
    type: z.literal("onboarding.setMainModel"),
    model: modelRefText,
  }),
  // Model profiles (live, no restart).
  z.strictObject({ id: requestId, type: z.literal("profiles.list") }),
  z.strictObject({
    id: requestId,
    type: z.literal("profiles.save"),
    create: z.boolean().optional(),
    profile: z.strictObject({
      id: z.string().max(40),
      name: z.string().max(80),
      main: modelRefText,
      fallbacks: z.array(modelRefText).max(5).optional(),
      guidance: z.string().max(4000).optional(),
      pool: z
        .array(
          z.strictObject({
            model: modelRefText,
            useFor: z.string().max(500).optional(),
            background: z.boolean().optional(),
          }),
        )
        .max(50),
    }),
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("profiles.delete"),
    profileId: z.string().max(40),
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("profiles.setDefault"),
    profileId: z.string().max(40),
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("bots.setProfile"),
    botId: z.string(),
    profileId: z.string().max(40).nullable(),
  }),
  z.strictObject({ id: requestId, type: z.literal("account.notes") }),
  z.strictObject({
    id: requestId,
    type: z.literal("account.setNotes"),
    notes: z.string().max(8000),
  }),
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

export type BotSummary = {
  id: string;
  name: string;
  createdAt: string;
  kind: "admin" | "bot";
  manager: boolean;
  managerId?: string;
  /** The profile this bot runs (its own or the default). */
  profileId: string;
  profileName: string;
  /** Runs the default profile (no profile of its own). */
  defaultProfile: boolean;
  /** Set while the main model is out (fallback or paused), and briefly after it returns. */
  modelStatus?: ModelStatusSummary;
};

/** A limited main model: only what the provider said (kind, and reset when it gave one). */
export type ModelLimitSummary = {
  model: string;
  /** e.g. "ChatGPT account", "OpenRouter key". */
  account: string;
  kind: "five_hour" | "weekly" | "usage" | "credits";
  /** Epoch ms, only when the provider returned it. */
  resetsAt?: number;
  /** Epoch ms: when it is tried again (the reset, or a cooldown when unknown). */
  retryAt: number;
};
export type ModelStatusSummary = {
  kind: "fallback" | "paused" | "returned";
  /** Epoch ms of the change. */
  at: number;
  primary: string;
  active: string;
  limits: ModelLimitSummary[];
};

export type PoolModelSummary = { model: string; useFor: string; background?: boolean };
export type ProfileSummary = {
  id: string;
  name: string;
  main: string;
  /** Ordered main-model fallbacks for usage limits (absent: none). */
  fallbacks?: string[];
  guidance?: string;
  pool: PoolModelSummary[];
  default?: boolean;
};
export type ProfilesList = { defaultId: string; profiles: ProfileSummary[] };

export type OnboardingStatus = {
  adminId: string;
  /** Admin Bot's profile and its main model. */
  profileId: string;
  mainModel: string;
  /** The main model belongs to a signed-in (or keyed) provider. */
  mainModelAvailable: boolean;
  /** Any model provider account is configured. */
  signedIn: boolean;
  /** Show onboarding: nothing is signed in, or Admin Bot's main model is not available. */
  needed: boolean;
};
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
  /** The bot list changed (a bot created one, a team changed): clients refetch `bots.list`. */
  | { type: "bots.changed" }
  /** Progress of a sign-in started by this connection (`login.start`). */
  | { type: "login"; loginId: string; event: LoginEvent };
