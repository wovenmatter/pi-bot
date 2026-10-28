import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Conversation, Harness } from "@earendil-works/pi-durable";
import { type SqliteDatabase, SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { BotHarnessOptions } from "./agent.ts";
import { conversationId as toConversationId, entryId as toEntryId } from "./ids.ts";
import { sharedDatabaseView } from "./storage/database.ts";
import { type BotRecord, BotRegistry, botPrefix, type ThreadRecord } from "./storage/registry.ts";

const ctx = BACKGROUND_CONTEXT;

export class NotFoundError extends Error {
  override name = "NotFoundError";
}

/** One bot: one Pi Durable session (Harness) over its prefixed tables in the shared database. */
export class Bot {
  readonly record: BotRecord;
  readonly harness: Harness;
  readonly #registry: BotRegistry;

  constructor(record: BotRecord, harness: Harness, registry: BotRegistry) {
    this.record = record;
    this.harness = harness;
    this.#registry = registry;
  }

  get id(): string {
    return this.record.id;
  }

  /** The main channel: the session's root conversation, one long-lived conversation. */
  main(): Promise<Conversation> {
    return this.harness.root(ctx);
  }

  /** The main channel when `conversationId` is omitted, otherwise one of this bot's threads. */
  async conversation(conversationId?: number): Promise<Conversation> {
    const main = await this.main();
    if (conversationId === undefined || conversationId === main.id) return main;
    const thread = await this.#registry.getThread(this.id, conversationId);
    if (!thread) throw new NotFoundError(`no thread ${conversationId} on bot ${this.id}`);
    const conversation = await this.harness.conversation(toConversationId(conversationId), ctx);
    if (!conversation) throw new NotFoundError(`thread ${conversationId} has no conversation`);
    return conversation;
  }

  /**
   * Fork a thread off any message of the main channel or another thread. The fork inherits the
   * context up to and including `entryId` as is: no compaction, no rewriting.
   */
  async fork(options: {
    readonly fromConversationId?: number;
    readonly entryId: number;
    readonly title?: string;
  }): Promise<ThreadRecord> {
    const parent = await this.conversation(options.fromConversationId);
    const thread = await parent.fork(
      toEntryId(options.entryId),
      { ownership: { kind: "ownerless" } },
      ctx,
    );
    const record: ThreadRecord = {
      botId: this.id,
      conversationId: thread.id,
      parentConversationId: parent.id,
      forkedAt: options.entryId,
      title: options.title?.trim() || "Thread",
      createdAt: new Date().toISOString(),
    };
    await this.#registry.addThread(record);
    return record;
  }

  threads(): Promise<ThreadRecord[]> {
    return this.#registry.listThreads(this.id);
  }
}

export type BotManagerOptions = {
  /** The shared database. The manager never closes it. */
  readonly db: SqliteDatabase;
  /** Harness options for one bot (models, registry, default agent). */
  readonly harnessOptions: (bot: BotRecord) => BotHarnessOptions;
  readonly onBotClosed?: (bot: BotRecord, reason: string) => void;
  readonly onBotDeleted?: (bot: BotRecord) => Promise<void>;
};

/**
 * Hosts every bot in this process. Each opened Harness has scheduling enabled (`resume()`), so
 * its own timers drive sleeping and retried tasks; this replaces Durable Object alarms.
 */
export class BotManager {
  readonly registry: BotRegistry;
  readonly #bots = new Map<string, Promise<Bot>>();
  #closed = false;

  readonly #options: BotManagerOptions;

  private constructor(options: BotManagerOptions) {
    this.#options = options;
    this.registry = new BotRegistry(options.db);
  }

  static async open(options: BotManagerOptions): Promise<BotManager> {
    const manager = new BotManager(options);
    await manager.registry.migrate();
    for (const record of await manager.registry.list()) await manager.get(record.id);
    return manager;
  }

  list(): Promise<BotRecord[]> {
    return this.registry.list();
  }

  async create(name: string): Promise<BotRecord> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("bot name is required");
    if (trimmed.length > 80) throw new Error("bot name is too long");
    const id = randomUUID();
    const record: BotRecord = {
      id,
      name: trimmed,
      prefix: botPrefix(id),
      createdAt: new Date().toISOString(),
    };
    await this.registry.insert(record);
    try {
      const bot = await this.get(id);
      await bot.main();
    } catch (error) {
      await this.delete(id).catch(() => {});
      throw error;
    }
    return record;
  }

  /** The open bot, opening (or reopening after a failure) its Harness on demand. */
  get(id: string): Promise<Bot> {
    if (this.#closed) return Promise.reject(new Error("bot manager is closed"));
    let bot = this.#bots.get(id);
    if (!bot) {
      bot = this.#open(id);
      this.#bots.set(id, bot);
      bot.catch(() => this.#bots.delete(id));
    }
    return bot;
  }

  async #open(id: string): Promise<Bot> {
    const record = await this.registry.get(id);
    if (!record) throw new NotFoundError(`no bot ${id}`);
    const storage = await SqliteStorage.open(sharedDatabaseView(this.#options.db), {
      prefix: record.prefix,
    });
    const { attach, ...options } = this.#options.harnessOptions(record);
    const harness = await Harness.open(storage, options, ctx);
    attach?.(harness);
    harness.resume();
    void harness.closed.then((end) => {
      const current = this.#bots.get(id);
      void current?.then((bot) => {
        if (bot.harness === harness) this.#bots.delete(id);
      });
      this.#options.onBotClosed?.(record, end.reason);
    });
    return new Bot(record, harness, this.registry);
  }

  async delete(id: string): Promise<boolean> {
    const record = await this.registry.get(id);
    if (!record) return false;
    const open = this.#bots.get(id);
    this.#bots.delete(id);
    if (open) {
      const bot = await open.catch(() => undefined);
      if (bot) await bot.harness.close(ctx);
    }
    const removed = await this.registry.remove(id);
    if (removed) await this.#options.onBotDeleted?.(record);
    return removed;
  }

  async close(): Promise<void> {
    this.#closed = true;
    const bots = [...this.#bots.values()];
    this.#bots.clear();
    for (const pending of bots) {
      const bot = await pending.catch(() => undefined);
      if (bot) await bot.harness.close(ctx);
    }
  }
}
