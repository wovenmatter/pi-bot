import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import type { CredentialStore, Models } from "@earendil-works/pi-ai";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { createBotHarnessOptions } from "./agent.ts";
import { BotManager } from "./bots.ts";
import { type ModelRef, type PiBotConfig, parseModelRef } from "./config.ts";
import { type OpenedCredentialStore, openCredentialStore } from "./credentials/index.ts";
import { type BotEnvironmentAdapter, DockerEnvironmentAdapter } from "./env.ts";
import { ModelAvailability } from "./limits.ts";
import { MemoryExtractor, memorySection } from "./memory.ts";
import { checkModelRoles, createPiBotModels } from "./models.ts";
import { ProfileStore, persistProfiles } from "./profiles.ts";
import { type PiBotServer, type RestartAccepted, startServer } from "./server.ts";
import { SettingsService } from "./settings/service.ts";
import { openSharedDatabase } from "./storage/database.ts";
import { BotRegistry } from "./storage/registry.ts";
import { TitleGenerator } from "./titles.ts";
import { type BotPlatform, forgetBotMessages } from "./tools.ts";

export type PiBotApp = {
  readonly db: SqliteDatabase;
  readonly credentials: OpenedCredentialStore;
  readonly models: Models;
  readonly manager: BotManager;
  /** Marked main-model usage limits (persisted in `pibot_limits`). */
  readonly availability: ModelAvailability;
  readonly server: PiBotServer;
  readonly env?: BotEnvironmentAdapter;
  /** Startup environment reconcile (in the background; never rejects). */
  readonly reconciled: Promise<void>;
  close(): Promise<void>;
};

/**
 * Reconcile in the background: Docker may still be starting at boot, so retry a few times.
 * Bots and the UI are already up; a container is also created on first tool use.
 */
async function reconcileWithRetry(
  env: BotEnvironmentAdapter,
  bots: () => Promise<{ active: string[]; deleted: string[] }>,
  log: (message: string) => void,
  attempts = 6,
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { active, deleted } = await bots();
      await env.reconcile?.(active, deleted);
      return;
    } catch (error) {
      log(`environment reconcile (attempt ${attempt}/${attempts}): ${String(error)}`);
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
    }
  }
}

export type StartOptions = {
  /** Override the pi-ai models (tests use the faux provider). */
  readonly models?: Models;
  /** Where bots' tools run; defaults to `[environment] backend` (`docker`: one container per bot). */
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
  const log = options.log ?? ((message: string) => console.error(message));
  let settings: SettingsService | undefined;
  let server: PiBotServer | undefined;
  let manager: BotManager | undefined;
  const platform: BotPlatform = {
    manager: () => {
      if (!manager) throw new Error("bots are still starting");
      return manager;
    },
    settings: () => settings,
    ...(options.restart ? { restart: options.restart } : {}),
    maxMessagesPerHourPerPair: config.bot_to_bot.max_messages_per_hour_per_pair,
    maxRoundsPerRequest: config.bot_to_bot.max_rounds_per_request,
  };
  const env =
    options.env ??
    (config.environment.backend === "docker"
      ? new DockerEnvironmentAdapter({
          ...(config.environment.image ? { image: config.environment.image } : {}),
          git: async () => (settings ? settings.gitMaterial() : {}),
          log,
        })
      : undefined);
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
      const refs: Record<string, ModelRef> = { "titles.model": config.roles.titles };
      for (const profile of config.modelProfiles.profiles) {
        refs[`profiles.${profile.id}.main`] = parseModelRef(profile.main);
        for (const entry of profile.pool) {
          refs[`profiles.${profile.id}.pool "${entry.model}"`] = parseModelRef(entry.model);
        }
      }
      for (const problem of checkModelRoles(createPiBotModels(credentials.store), refs)) {
        log(`warning: ${problem}`);
      }
    }
    const configPath = config.source;
    const profiles = new ProfileStore(config.modelProfiles, {
      ...(configPath ? { persist: (set) => persistProfiles(configPath, set) } : {}),
      checkModel: (ref) => settings?.checkModel(ref),
    });
    if (configPath && Object.keys(config.profiles).length === 0) {
      // Legacy `[models] orchestrator`/`background`: write them out as `[profiles.default]`.
      await copyFile(configPath, `${configPath}.pre-profiles.bak`).catch(() => {});
      await persistProfiles(configPath, profiles.snapshot()).then(
        () =>
          log(`config: wrote [models] orchestrator/background as [profiles.${profiles.defaultId}]`),
        (error: unknown) => log(`config: could not write profiles: ${String(error)}`),
      );
    }
    // Marked usage limits outlive a restart: restore the live ones before any bot opens.
    const registry = new BotRegistry(db);
    await registry.migrate();
    const availability = new ModelAvailability({
      store: registry,
      onError: (error) => log(`usage limits: could not save: ${String(error)}`),
    });
    for (const entry of await availability.load()) {
      log(
        `usage limit (from before the restart): ${entry.model} (${entry.account}): ${entry.kind}, retry ${new Date(entry.retryAt).toISOString()}`,
      );
    }
    const opened = await BotManager.open({
      db,
      ensureAdmin: true,
      onBotsChanged: () => server?.botsChanged(),
      onThreadsChanged: (botId) => server?.threadsChanged(botId),
      availability,
      onModelStatus: () => server?.botsChanged(),
      profiles,
      log,
      harnessOptions: (bot, self) =>
        createBotHarnessOptions({
          bot,
          models,
          profile: () => profiles.resolve(self.assignedProfile(bot.id)),
          onSubagent: (event) =>
            log(
              `bot ${bot.id}: subagent ${event.phase} on ${event.model}${event.reasoning ? ` (${event.reasoning})` : ""}${event.detail ? `: ${event.detail}` : ""}`,
            ),
          platform,
          web: { credentials: credentials.store, provider: config.search.provider },
          compaction: config.compaction,
          ...(env ? { env } : {}),
          onReport: (error) => log(`bot ${bot.id}: ${String(error)}`),
          onLimit: (conversationId, model, limit) =>
            self.reportLimit(bot.id, conversationId, model, limit),
          fallbackNote: (conversationId) => self.fallbackNote(bot.id, conversationId),
          memory: async () => memorySection((await self.registry.memory(bot.id)).facts),
        }),
      onBotClosed: (bot, reason) => {
        if (reason !== "closed") log(`bot ${bot.id} harness ${reason}`);
      },
      ...(env ? { onBotDeleted: (bot) => env.dispose(bot.id) } : {}),
      onBotPurged: async (botId) => {
        forgetBotMessages(platform, botId);
        if (!env) return undefined;
        if (!env.purge)
          return { removed: false, error: `the ${env.kind} environment can't remove workspaces` };
        await env.purge(botId);
        return { removed: true };
      },
      ...(env?.restore
        ? {
            onBotRestored: (bot) =>
              env
                .restore?.(bot.id)
                .catch((error: unknown) => log(`bot ${bot.id}: environment: ${String(error)}`)) ??
              Promise.resolve(),
          }
        : {}),
      // An explicit [models.titles] model titles every thread; otherwise each bot's pool
      // background model goes first, with the default title model as its quiet fallback.
      titles: new TitleGenerator({
        models,
        model: config.roles.titles,
        explicit: config.roles.titlesConfigured,
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
    manager = opened;
    const extraction = config.extraction;
    const memory = extraction.enabled
      ? new MemoryExtractor({
          manager: opened,
          models,
          schedule: extraction.schedule,
          timeZone: extraction.timezone,
          idleMs: extraction.idle_minutes * 60_000,
          onChanged: (botId) => server?.memoryChanged(botId),
          log,
        })
      : undefined;
    memory?.start();
    settings = new SettingsService({
      credentials: credentials.store,
      models: options.settingsModels?.(credentials.store) ?? models,
      config,
      // New credentials for a provider account end its marked limits; bots go back to main.
      onCredentialsChanged: (provider) => availability.clear(provider),
      ...(env?.gitChanged
        ? {
            onGitChanged: () =>
              void env.gitChanged?.().catch((error: unknown) => log(`git sync: ${String(error)}`)),
          }
        : {}),
    });
    const reconciled = env?.reconcile
      ? reconcileWithRetry(
          env,
          async () => ({
            active: (await opened.list()).map((bot) => bot.id),
            deleted: (await opened.listDeleted()).map((bot) => bot.id),
          }),
          log,
        )
      : Promise.resolve();
    const webDir = options.webDir ?? config.paths.webDir;
    server = await startServer({
      manager: opened,
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
      manager: opened,
      availability,
      server,
      ...(env ? { env } : {}),
      reconciled,
      async close() {
        await server?.close();
        await memory?.close();
        await opened.close();
        availability.close();
        await availability.flushed();
        env?.close?.();
        await db.close();
      },
    };
  } catch (error) {
    await db.close().catch(() => {});
    throw error;
  }
}
