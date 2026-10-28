import { join } from "node:path";
import type { CredentialStore, Models } from "@earendil-works/pi-ai";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { createBotHarnessOptions } from "./agent.ts";
import { BotManager } from "./bots.ts";
import type { PiBotConfig } from "./config.ts";
import { type OpenedCredentialStore, openCredentialStore } from "./credentials/index.ts";
import type { BotEnvironmentAdapter } from "./env.ts";
import { checkModelRoles, createPiBotModels } from "./models.ts";
import { type PiBotServer, type RestartAccepted, startServer } from "./server.ts";
import { SettingsService } from "./settings/service.ts";
import { openSharedDatabase } from "./storage/database.ts";
import { TitleGenerator } from "./titles.ts";

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
  /** Models behind Settings (sign-in flows, model list), over the opened store. Defaults to `models`. */
  readonly settingsModels?: (credentials: CredentialStore) => Models;
  /** Backs `server.restart` (see `PiBotProcess`); without it Settings cannot restart the server. */
  readonly restart?: () => Promise<RestartAccepted>;
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
    const models =
      options.models ??
      createPiBotModels(credentials.store, {
        claude: { directory: join(config.paths.dataDir, "claude-agent") },
      });
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
      titles: new TitleGenerator({
        models,
        model: config.roles.titles,
        reasoning: config.models.titles.reasoning,
      }),
      onReport: (error) => log(`thread title: ${String(error)}`),
      onRecovered: (bot, report) => {
        const parts = [
          report.resumedConversations.length &&
            `resumed live work in conversations ${report.resumedConversations.join(", ")}`,
          report.adoptedThreads.length &&
            `registered unrecorded forks ${report.adoptedThreads.join(", ")} as threads`,
          report.missingThreads.length &&
            `threads ${report.missingThreads.join(", ")} have no stored conversation`,
          report.retitledThreads.length &&
            `restarted titles for threads ${report.retitledThreads.join(", ")}`,
        ].filter(Boolean);
        if (parts.length) log(`bot ${bot.id} recovery: ${parts.join("; ")}`);
      },
    });
    const settings = new SettingsService({
      credentials: credentials.store,
      models: options.settingsModels?.(credentials.store) ?? models,
      config,
    });
    const webDir = options.webDir ?? config.paths.webDir;
    const server = await startServer({
      manager,
      settings,
      host: config.server.host,
      port: options.port ?? config.server.port,
      ...(webDir ? { webDir } : {}),
      ...(options.restart ? { restart: options.restart } : {}),
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
