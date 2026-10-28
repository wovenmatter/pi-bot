import type { HarnessOptions } from "@earendil-works/pi-durable";

export type HarnessEnvFactory = NonNullable<HarnessOptions["env"]>;

/**
 * Builds the execution environment (filesystem, shell) a bot's tools run in. Milestone 1 has no
 * tools, so no adapter is wired by default; the Docker adapter below is the planned shape.
 */
export interface BotEnvironmentAdapter {
  readonly kind: string;
  /** The `HarnessOptions.env` callback for one bot. */
  harnessEnv(botId: string): HarnessEnvFactory;
  /**
   * Release the bot's runtime (containers) when it is soft-deleted. Keep volumes and other data on
   * disk: bot deletion never removes data, and purging is deferred.
   */
  dispose(botId: string): Promise<void>;
}

/**
 * Stub: one Docker container per bot. Not implemented in milestone 1; it supplies no
 * environment, so conversations run without one.
 */
export class DockerEnvironmentAdapter implements BotEnvironmentAdapter {
  readonly kind = "docker";

  readonly options: { readonly image?: string };

  constructor(options: { readonly image?: string } = {}) {
    this.options = options;
  }

  harnessEnv(_botId: string): HarnessEnvFactory {
    return () => undefined;
  }

  async dispose(_botId: string): Promise<void> {}
}
