import type { HarnessOptions } from "@earendil-works/pi-durable";

export type HarnessEnvFactory = NonNullable<HarnessOptions["env"]>;

/**
 * Builds the execution environment (filesystem, shell) a bot's tools run in. With an adapter the
 * bot gets Pi Durable's coding tools (bash, read, write, edit), all executing in that environment.
 */
export interface BotEnvironmentAdapter {
  readonly kind: string;
  /** The `HarnessOptions.env` callback for one bot. */
  harnessEnv(botId: string): HarnessEnvFactory;
  /**
   * Release the bot's runtime (containers) when it is soft-deleted. Keep volumes and other data on
   * disk: a soft delete never removes data.
   */
  dispose(botId: string): Promise<void>;
  /**
   * The user purged a deleted bot (Settings → Bots → Deleted bots → Delete permanently): remove
   * its runtime and its workspace data. Already-missing pieces are fine; throws when it could not.
   */
  purge?(botId: string): Promise<void>;
  /** A soft-deleted bot came back: bring its runtime back up. */
  restore?(botId: string): Promise<void>;
  /**
   * Server startup: every active bot's runtime exists and runs; the soft-deleted bots' runtimes
   * are stopped. Runtimes of bots this server doesn't know are left alone.
   */
  reconcile?(activeBotIds: readonly string[], deletedBotIds: readonly string[]): Promise<void>;
  /** The GitHub SSH key or git identity changed in Settings. */
  gitChanged?(): Promise<void>;
  /** Server shutdown: drop connections; runtimes keep running. */
  close?(): void;
}

export {
  DockerEnvironmentAdapter,
  type DockerEnvironmentOptions,
  type GitMaterial,
} from "./environment/docker.ts";
