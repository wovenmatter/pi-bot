import { type PiBotApp, type StartOptions, startPiBot } from "./app.ts";
import { loadConfig, type PiBotConfig } from "./config.ts";
import type { RestartAccepted } from "./server.ts";

/** Set to an exit status (e.g. 75) to have Restart exit for a supervisor instead of reloading. */
export const RESTART_EXIT_CODE_ENV = "PIBOT_RESTART_EXIT_CODE";

/** Parse `PIBOT_RESTART_EXIT_CODE`: an integer 1–255, or undefined for in-process reload. */
export function restartExitCode(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const code = Number(value);
  if (!Number.isInteger(code) || code < 1 || code > 255) {
    throw new Error(`${RESTART_EXIT_CODE_ENV} must be an integer from 1 to 255`);
  }
  return code;
}

export type PiBotProcessOptions = {
  /** config.toml the restart re-reads. */
  readonly configPath: string;
  /** The config already loaded from `configPath`. */
  readonly config: PiBotConfig;
  readonly startOptions?: Omit<StartOptions, "restart" | "port">;
  /** Port override for the first start (tests pass 0). Restarts keep the bound port. */
  readonly port?: number;
  /** Replace `startPiBot` / `loadConfig` (tests). */
  readonly start?: typeof startPiBot;
  readonly load?: (path: string) => Promise<PiBotConfig>;
  /** How long a restart waits for running turns before closing. Default 15 s. */
  readonly drainMs?: number;
  readonly pollMs?: number;
  /** Supervisor mode: exit with this status instead of reloading in place. */
  readonly exitCode?: number;
  readonly exit?: (code: number) => void;
  readonly log?: (message: string) => void;
};

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * The `serve` process: one Pi Bot app that Settings → Config → Restart Pi Bot (or Restart and
 * apply) can restart. A restart
 * re-reads config.toml first (an invalid file is refused and nothing stops), waits a bounded time
 * for running turns, closes the app (sockets, bots, database), then either starts it again in this
 * process on the same port (default; works under `node --watch`, a terminal, or any supervisor) or
 * exits with `exitCode` so a supervisor such as systemd starts a fresh process. Work still live at
 * close is resumed by Pi Durable when the bots are opened again.
 */
export class PiBotProcess {
  readonly #options: PiBotProcessOptions;
  readonly #start: typeof startPiBot;
  readonly #load: (path: string) => Promise<PiBotConfig>;
  readonly #log: (message: string) => void;
  #config: PiBotConfig;
  #app: PiBotApp | undefined;
  #restart: Promise<void> | undefined;
  #closed = false;

  constructor(options: PiBotProcessOptions) {
    this.#options = options;
    this.#config = options.config;
    this.#start = options.start ?? startPiBot;
    this.#load = options.load ?? loadConfig;
    this.#log = options.log ?? ((message) => console.error(message));
  }

  get app(): PiBotApp {
    if (!this.#app) throw new Error("pi-bot is not running");
    return this.#app;
  }

  get config(): PiBotConfig {
    return this.#config;
  }

  async start(): Promise<PiBotApp> {
    this.#app = await this.#launch(this.#config, this.#options.port);
    return this.#app;
  }

  /** Accept a restart and schedule it after the caller's reply is sent. */
  async requestRestart(): Promise<RestartAccepted> {
    if (this.#closed) throw new Error("pi-bot is shutting down");
    if (this.#restart) throw new Error("a restart is already in progress");
    const app = this.app;
    const next = await this.#load(this.#options.configPath);
    if (this.#restart) throw new Error("a restart is already in progress");
    const activeWork = await app.manager.activeWork();
    const mode = this.#options.exitCode === undefined ? "reload" : "exit";
    this.#restart = sleep(50)
      .then(() => this.#run(app, next, mode))
      .catch((error: unknown) => this.#log(`restart failed: ${String(error)}`))
      .finally(() => {
        this.#restart = undefined;
      });
    return { activeWork, mode };
  }

  /** Resolves once a scheduled restart has finished (tests). */
  async settled(): Promise<void> {
    await this.#restart;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#restart;
    const app = this.#app;
    this.#app = undefined;
    await app?.close();
  }

  #launch(config: PiBotConfig, port: number | undefined): Promise<PiBotApp> {
    return this.#start(config, {
      ...this.#options.startOptions,
      ...(port === undefined ? {} : { port }),
      restart: () => this.requestRestart(),
    });
  }

  async #run(app: PiBotApp, next: PiBotConfig, mode: "reload" | "exit"): Promise<void> {
    const drainMs = this.#options.drainMs ?? 15_000;
    const deadline = Date.now() + drainMs;
    let live = await app.manager.activeWork();
    if (live)
      this.#log(`restart: waiting up to ${Math.round(drainMs / 1000)} s for ${live} run(s)`);
    while (live > 0 && Date.now() < deadline) {
      await sleep(this.#options.pollMs ?? 250);
      live = await app.manager.activeWork();
    }
    if (live) this.#log(`restart: ${live} run(s) still live; Pi Durable resumes them on start`);
    const previous = this.#config;
    const port = app.server.port;
    this.#app = undefined;
    await app.close();
    const exit = this.#options.exit ?? ((code: number) => process.exit(code));
    if (mode === "exit" && this.#options.exitCode !== undefined) {
      this.#log(`restart: exiting with status ${this.#options.exitCode} for the supervisor`);
      exit(this.#options.exitCode);
      return;
    }
    const samePlace =
      next.server.host === previous.server.host && next.server.port === previous.server.port;
    try {
      this.#app = await this.#launch(next, samePlace ? port : undefined);
      this.#config = next;
      this.#log("restart: running with the saved config");
    } catch (error) {
      this.#log(
        `restart: new config failed to start (${String(error)}); restoring the previous one`,
      );
      try {
        this.#app = await this.#launch(previous, port);
      } catch (again) {
        this.#log(`restart: could not start again (${String(again)}); exiting`);
        exit(1);
      }
    }
  }
}
