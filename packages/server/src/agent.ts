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
import type { ModelRef, RawConfig } from "./config.ts";
import type { BotEnvironmentAdapter } from "./env.ts";
import type { BeforeCompactHook } from "./memory.ts";

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
  readonly botId: string;
  readonly botName: string;
  /** pi-ai models resolving credentials from the shared credential store. */
  readonly models: Models | (() => Models);
  /** The configured `models.orchestrator` role; never hardcoded. */
  readonly orchestrator: ModelRef;
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
    sections: [
      section(
        "preamble",
        () =>
          `You are ${options.botName}, a personal assistant bot running on Pi Bot. Be concise and helpful.` +
          (options.env
            ? " Your tools run in your own Linux container (Ubuntu, non-root user with sudo) with your files in /workspace; git, Node, Python, build tools and Playwright with Chromium are installed."
            : ""),
        { tag: false },
      ),
    ],
    // One implementation for the main channel and every thread.
    hooks: [
      { task: "pi.generation", handlers: { beforeRequest: native.beforeRequest } },
      { task: "pi.compaction", handlers: { beforeCompact: native.beforeCompact } },
    ],
  });
  const registry = createCompactionRegistry();
  registry.install(extension);
  if (options.env) registry.install(CodingTools);
  const agent = defaultAgent(options.orchestrator);
  return {
    models: native.models(),
    registry,
    settings: {
      extensions: options.env ? [extension, CodingTools] : [extension],
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
    ...(options.env ? { env: options.env.harnessEnv(options.botId) } : {}),
    ...(options.onReport ? { onReport: options.onReport } : {}),
  };
}
