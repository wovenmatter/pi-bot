import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { createBotHarnessOptions } from "../src/agent.ts";
import { BotManager } from "../src/bots.ts";
import { openSharedDatabase } from "../src/storage/database.ts";

export const FAUX_MODEL = { provider: "faux", modelId: "faux-1" } as const;

export async function tempDir(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "pi-bot-test-"));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

type ContextLike = { messages?: readonly { role: string; content: unknown }[] };

function lastUserText(context: ContextLike): string {
  const users = (context.messages ?? []).filter((message) => message.role === "user");
  const content = users.at(-1)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: "text"; text: string } => block?.type === "text")
      .map((block) => block.text)
      .join("");
  }
  return "";
}

/** Faux models that answer `echo: <last user text>` (n<user messages seen>) forever. */
export function echoModels(tokensPerSecond = 2000) {
  // One-token (4 char) chunks; pi-durable publishes partial messages every 100 ms.
  const faux = fauxProvider({ tokensPerSecond, tokenSize: { min: 1, max: 1 } });
  const echo: FauxResponseStep = (context) => {
    const ctx = context as unknown as ContextLike;
    const seen = (ctx.messages ?? []).filter((message) => message.role === "user").length;
    return fauxAssistantMessage([fauxText(`echo: ${lastUserText(ctx)} (n${seen})`)]);
  };
  faux.setResponses(Array.from({ length: 200 }, () => echo));
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}

export async function openTestManager(dbPath: string) {
  const db = await openSharedDatabase(dbPath);
  const { faux, models } = echoModels();
  const manager = await BotManager.open({
    db,
    harnessOptions: (bot) =>
      createBotHarnessOptions({
        botId: bot.id,
        botName: bot.name,
        models,
        orchestrator: FAUX_MODEL,
      }),
  });
  return {
    db,
    faux,
    models,
    manager,
    close: async () => {
      await manager.close();
      await db.close();
    },
  };
}
