import type { FetchFunction, Models } from "@earendil-works/pi-ai";
import {
  type AgentChange,
  type CompactionSettings,
  configure,
  defineExtension,
  type Harness,
  type HarnessOptions,
  section,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createCompactionRegistry, NativeCompaction } from "./compaction/context.ts";
import { type ModelRef, parseModelRef, type RawConfig } from "./config.ts";
import type { BotEnvironmentAdapter } from "./env.ts";
import type { BeforeCompactHook } from "./memory.ts";
import type { BotRecord } from "./storage/registry.ts";
import { type BotPlatform, botTools } from "./tools.ts";

export type CompactionConfig = RawConfig["compaction"];

/** `[compaction]` as Pi Durable's harness-wide policy with per-model overrides. */
export function compactionSettings(config: CompactionConfig | undefined): CompactionSettings {
  if (!config) return { backgroundTokens: 0 };
  const overrides = Object.fromEntries(
    Object.entries(config.models).map(([ref, value]) => [
      ref,
      {
        ...(value.enabled !== undefined ? { enabled: value.enabled } : {}),
        ...(value.reserve_tokens !== undefined ? { reserveTokens: value.reserve_tokens } : {}),
        ...(value.keep_recent_tokens !== undefined
          ? { keepRecentTokens: value.keep_recent_tokens }
          : {}),
        ...(value.background_tokens !== undefined
          ? { backgroundTokens: value.background_tokens }
          : {}),
      },
    ]),
  );
  return {
    enabled: config.enabled,
    reserveTokens: config.reserve_tokens,
    keepRecentTokens: config.keep_recent_tokens,
    backgroundTokens: config.background_tokens,
    ...(Object.keys(overrides).length ? { modelOverrides: overrides } : {}),
  };
}

/** Harness options plus the callback that hands hooks the opened Harness. */
export type BotHarnessOptions = HarnessOptions & { readonly attach?: (harness: Harness) => void };

export type BotAgentOptions = {
  readonly bot: BotRecord;
  /** pi-ai models resolving credentials from the shared credential store. */
  readonly models: Models | (() => Models);
  /** The configured `models.orchestrator` role, unless the bot has its own `model`; never hardcoded. */
  readonly orchestrator: ModelRef;
  /** Bot tools (list/create/message bots, teams, Admin Bot's settings); omitted: none. */
  readonly platform?: BotPlatform;
  readonly env?: BotEnvironmentAdapter;
  readonly onReport?: (error: unknown, info: unknown) => void;
  readonly compaction?: CompactionConfig;
  /** Fetch for provider requests (native compaction and generation); tests inject a fake. */
  readonly fetch?: FetchFunction;
  /** Memory extraction before every compaction; a no-op stub by default. */
  readonly onBeforeCompact?: BeforeCompactHook;
};

/** The agent every new bot's main channel starts with. Threads inherit it via fork. */
export function defaultAgent(orchestrator: ModelRef): AgentChange {
  return { model: { provider: orchestrator.provider, modelId: orchestrator.modelId } };
}

const CONTAINER =
  " Your tools run in your own Linux container (Ubuntu, non-root user with sudo) with your files in /workspace; git, Node, Python, build tools and Playwright with Chromium are installed.";

/** Admin Bot's standing instructions: account/config management, user's ask = go-ahead. */
export const ADMIN_PROMPT = `You are Admin Bot, the account and configuration bot of this Pi Bot. You are the only bot whose job is account and config management: provider sign-ins, models, search keys, GitHub, config.toml and restart-and-apply. You also create and organize bots and teams on the user's behalf.
Before you change config (config.toml edits, model changes, restarts), say exactly what you will change and ask the user to confirm, unless the user already asked for that change: their request is the go-ahead. Do not ask twice.
Sign-ins and keys are entered by the user in Settings (Account & sign-ins, Search, GitHub): point them there. Never ask the user to paste a secret into the chat and never reveal one.
You are never on a team and never manage one. Deleting and restoring bots is done by the user in the web UI.
In your first conversation, briefly explain what Pi Bot can do: bots, each with one long-lived main channel and threads forked off any message; tools in each bot's own Linux container when enabled; optional one-level teams, where a manager bot assigns work to its members; and bots messaging each other. Then ask which bots or teams the user wants and create them.`;

/** The preamble, read live so team changes apply from the next request. */
async function preamble(options: BotAgentOptions): Promise<string> {
  const container = options.env ? CONTAINER : "";
  if (options.bot.kind === "admin") return ADMIN_PROMPT + container;
  let text = `You are ${options.bot.name}, a personal assistant bot running on Pi Bot. Be concise and helpful.${container}`;
  const platform = options.platform;
  if (!platform) return text;
  text +=
    "\nYou can create bots when the user asks (create_bot) and message any bot (message_bot). Account and config changes (sign-ins, models, keys, config) are Admin Bot's job: send the user to Admin Bot.";
  const bots = await platform.manager().list();
  const self = bots.find((bot) => bot.id === options.bot.id);
  if (self?.manager) {
    const members = bots.filter((bot) => bot.managerId === self.id).map((bot) => bot.name);
    text += `\nYou manage a team: ${members.length ? members.join(", ") : "no members yet"}. Your main job is to assign work to your team and orchestrate it (message_bot); bots you create join your team.`;
  } else if (self?.managerId) {
    const lead = bots.find((bot) => bot.id === self.managerId);
    text += `\nYou are on ${lead?.name ?? "a"}'s team; ${lead?.name ?? "your manager"} assigns your work. Bots you create join this team.`;
  }
  return text;
}

/**
 * Harness options for one bot, following the pi-durable-chat composition: one registry and
 * extension, `conversationCreated` configures only the root (main channel) conversation; forks
 * keep the copies they were forked with. With an environment adapter the bot also gets Pi Durable's
 * coding tools (bash, read, write, edit), which run in that environment (the bot's container);
 * without one it has no tools.
 */
export function createBotHarnessOptions(options: BotAgentOptions): BotHarnessOptions {
  const source = options.models;
  const native = new NativeCompaction(typeof source === "function" ? source : () => source, {
    native: options.compaction?.native ?? "auto",
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.onBeforeCompact ? { onBeforeCompact: options.onBeforeCompact } : {}),
    ...(options.onReport ? { onReport: options.onReport } : {}),
  });
  const extension = defineExtension({
    name: "pi-bot",
    sections: [section("preamble", () => preamble(options), { tag: false })],
    // One implementation for the main channel and every thread.
    hooks: [
      { task: "pi.generation", handlers: { beforeRequest: native.beforeRequest } },
      { task: "pi.compaction", handlers: { beforeCompact: native.beforeCompact } },
    ],
  });
  const registry = createCompactionRegistry();
  registry.install(extension);
  if (options.env) registry.install(CodingTools);
  const tools = options.platform ? botTools(options.bot, options.platform) : undefined;
  if (tools) registry.install(tools);
  const extensions = [extension, ...(options.env ? [CodingTools] : []), ...(tools ? [tools] : [])];
  const agent = defaultAgent(
    options.bot.model ? parseModelRef(options.bot.model) : options.orchestrator,
  );
  return {
    models: native.models(),
    registry,
    settings: {
      extensions,
      documentRetentionMs: 0,
      // Woven's durable-session settings: SSE transport, no hidden retries, no background compaction.
      stream: { transport: "sse", maxRetries: 0 },
      compaction: compactionSettings(options.compaction),
    },
    attach: (harness) => native.harness.attach(harness),
    conversationCreated: (tx, conversation) =>
      conversation.owner === undefined && conversation.parent === undefined
        ? configure(tx, conversation.id, agent)
        : undefined,
    ...(options.env ? { env: options.env.harnessEnv(options.bot.id) } : {}),
    ...(options.onReport ? { onReport: options.onReport } : {}),
  };
}
