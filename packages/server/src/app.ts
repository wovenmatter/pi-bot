import type { Models } from "@earendil-works/pi-ai";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { createBotHarnessOptions } from "./agent.ts";
import { BotManager } from "./bots.ts";
import type { PiBotConfig } from "./config.ts";
import { type OpenedCredentialStore, openCredentialStore } from "./credentials/index.ts";
import type { BotEnvironmentAdapter } from "./env.ts";
import { checkModelRoles, createPiBotModels } from "./models.ts";
import { type PiBotServer, startServer } from "./server.ts";
import { openSharedDatabase } from "./storage/database.ts";

export type PiBotApp = {
  readonly db: SqliteDatabase;
  readonly credentials: OpenedCredentialStore;
  readonly models: Models;
  readonly manager: BotManager;
  readonly server: PiBotServer;
  close(): Promise<void>;
};

export type StartOptions = {
  /** Override the pi-ai models (tests use the faux provider). */
  readonly models?: Models;
  readonly env?: BotEnvironmentAdapter;
  readonly port?: number;
  readonly webDir?: string;
  readonly log?: (message: string) => void;
};

/** Open the shared database, credential store, models and every bot, then listen. */
export async function startPiBot(
  config: PiBotConfig,
  options: StartOptions = {},
): Promise<PiBotApp> {
  const env = options.env;
  const log = options.log ?? ((message: string) => console.error(message));
  const db = await openSharedDatabase(config.paths.database);
  try {
    const credentials = await openCredentialStore(config, db);
    if (credentials.note) log(credentials.note);
    const models = options.models ?? createPiBotModels(credentials.store);
    if (!options.models) {
      for (const problem of checkModelRoles(createPiBotModels(credentials.store), config.roles)) {
        log(`warning: ${problem}`);
      }
    }
    const manager = await BotManager.open({
      db,
      harnessOptions: (bot) =>
        createBotHarnessOptions({
          botId: bot.id,
          botName: bot.name,
          models,
          orchestrator: config.roles.orchestrator,
          compaction: config.compaction,
          ...(env ? { env } : {}),
          onReport: (error) => log(`bot ${bot.id}: ${String(error)}`),
        }),
      onBotClosed: (bot, reason) => {
        if (reason !== "closed") log(`bot ${bot.id} harness ${reason}`);
      },
      ...(env ? { onBotDeleted: (bot) => env.dispose(bot.id) } : {}),
    });
    const webDir = options.webDir ?? config.paths.webDir;
    const server = await startServer({
      manager,
      host: config.server.host,
      port: options.port ?? config.server.port,
      ...(webDir ? { webDir } : {}),
      log,
    });
    return {
      db,
      credentials,
      models,
      manager,
      server,
      async close() {
        await server.close();
        await manager.close();
        await db.close();
      },
    };
  } catch (error) {
    await db.close().catch(() => {});
    throw error;
  }
}
