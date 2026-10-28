import type { Models } from "@earendil-works/pi-ai";
import {
  type AgentChange,
  configure,
  createRegistry,
  defineExtension,
  type HarnessOptions,
  section,
} from "@earendil-works/pi-durable";
import type { ModelRef } from "./config.ts";
import type { BotEnvironmentAdapter } from "./env.ts";

export type BotAgentOptions = {
  readonly botId: string;
  readonly botName: string;
  /** pi-ai models resolving credentials from the shared credential store. */
  readonly models: Models | (() => Models);
  /** The configured `models.orchestrator` role; never hardcoded. */
  readonly orchestrator: ModelRef;
  readonly env?: BotEnvironmentAdapter;
  readonly onReport?: (error: unknown, info: unknown) => void;
};

/** The agent every new bot's main channel starts with. Threads inherit it via fork. */
export function defaultAgent(orchestrator: ModelRef): AgentChange {
  return { model: { provider: orchestrator.provider, modelId: orchestrator.modelId } };
}

/**
 * Harness options for one bot, following the pi-durable-chat composition: one registry and
 * extension, `conversationCreated` configures only the root (main channel) conversation; forks
 * keep the copies they were forked with. No tools in milestone 1.
 */
export function createBotHarnessOptions(options: BotAgentOptions): HarnessOptions {
  const extension = defineExtension({
    name: "pi-bot",
    sections: [
      section(
        "preamble",
        () =>
          `You are ${options.botName}, a personal assistant bot running on Pi Bot. Be concise and helpful.`,
        { tag: false },
      ),
    ],
  });
  const registry = createRegistry();
  registry.install(extension);
  const agent = defaultAgent(options.orchestrator);
  return {
    models: options.models,
    registry,
    settings: { extensions: [extension], documentRetentionMs: 0 },
    conversationCreated: (tx, conversation) =>
      conversation.owner === undefined && conversation.parent === undefined
        ? configure(tx, conversation.id, agent)
        : undefined,
    ...(options.env ? { env: options.env.harnessEnv(options.botId) } : {}),
    ...(options.onReport ? { onReport: options.onReport } : {}),
  };
}
