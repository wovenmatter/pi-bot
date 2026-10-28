import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialStore, MutableModels } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { claudeAgentProvider } from "./claude/provider.ts";
import type { ClaudeAgentOptions } from "./claude/runtime.ts";
import type { ModelRef } from "./config.ts";

export type PiBotModelsOptions = {
  /** The Claude Agent SDK runtime; `directory` defaults to a per-user temp dir (app: the data dir). */
  readonly claude?: Partial<ClaudeAgentOptions>;
};

/**
 * pi-ai models for every bot. Request auth resolves from the shared credential store (API keys
 * and pi-ai OAuth logins); which model a role uses comes from config, never from code.
 * `claude-subscription` is Claude through the Claude Agent SDK (see `claude/provider.ts`).
 */
export function createPiBotModels(
  credentials: CredentialStore,
  options: PiBotModelsOptions = {},
): MutableModels {
  const models = createModels({ credentials });
  models.setProvider(openaiProvider());
  models.setProvider(openaiCodexProvider());
  models.setProvider(anthropicProvider());
  models.setProvider(openrouterProvider());
  models.setProvider(xaiProvider());
  models.setProvider(
    claudeAgentProvider({
      ...options.claude,
      directory:
        options.claude?.directory ??
        join(tmpdir(), `pi-bot-claude-agent-${process.getuid?.() ?? "user"}`),
    }),
  );
  return models;
}

/** Problems with the configured roles, for startup warnings (unknown provider or model). */
export function checkModelRoles(models: MutableModels, roles: Record<string, ModelRef>): string[] {
  const problems: string[] = [];
  for (const [role, ref] of Object.entries(roles)) {
    if (!models.getProvider(ref.provider)) {
      problems.push(`models.${role}: unknown provider "${ref.provider}"`);
    } else if (!models.getModel(ref.provider, ref.modelId)) {
      problems.push(`models.${role}: provider "${ref.provider}" has no model "${ref.modelId}"`);
    }
  }
  return problems;
}
