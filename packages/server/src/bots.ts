import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Conversation, type ConversationRecord, Harness } from "@earendil-works/pi-durable";
import { type SqliteDatabase, SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { BotHarnessOptions } from "./agent.ts";
import { conversationId as toConversationId, entryId as toEntryId } from "./ids.ts";
import { sharedDatabaseView } from "./storage/database.ts";
import { type BotRecord, BotRegistry, botPrefix, type ThreadRecord } from "./storage/registry.ts";
import type { TitleGenerator } from "./titles.ts";
import { displayEntry } from "./transcript.ts";

const ctx = BACKGROUND_CONTEXT;

/** What `BotManager` found and repaired when it opened a bot after a restart or crash. */
export type RecoveryReport = {
  /** Forks found in the Pi Durable store but missing from the thread registry, now registered. */
  readonly adoptedThreads: readonly number[];
  /** Registered threads whose conversation is missing from the store (left as is, reported). */
  readonly missingThreads: readonly number[];
  /** Conversations with live runs or queued input at open; scheduling resumed them. */
  readonly resumedConversations: readonly number[];
  /** Untitled threads with a first message whose title generation was restarted. */
  readonly retitledThreads: readonly number[];
};

export class NotFoundError extends Error {
  override name = "NotFoundError";
}

/** One bot: one Pi Durable session (Harness) over its prefixed tables in the shared database. */
export class Bot {
  readonly record: BotRecord;
  readonly harness: Harness;
  readonly #registry: BotRegistry;
  readonly #titles: ThreadTitles | undefined;

  constructor(record: BotRecord, harness: Harness, registry: BotRegistry, titles?: ThreadTitles) {
    this.record = record;
    this.harness = harness;
    this.#registry = registry;
    this.#titles = titles;
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
   * Send a user message to the main channel or a thread. The first message of an untitled thread
   * also starts its title generation, as Woven titles a conversation from its first prompt.
   */
  async send(text: string, conversationId?: number) {
    const conversation = await this.conversation(conversationId);
    const submission = await conversation.submit(
      { type: "input", content: text, whenBusy: "followUp" },
      ctx,
    );
    const main = await this.main();
    if (conversation.id !== main.id) this.#titles?.request(this.id, conversation.id, text);
    return { conversation, submission };
  }

  /**
   * Fork a thread off any message of the main channel or another thread. The fork inherits the
   * context up to and including `entryId` as is: no compaction, no rewriting. Threads have no
   * user-visible name and cannot be renamed; a title is generated later from the first message.
   */
  async fork(options: {
    readonly fromConversationId?: number;
    readonly entryId: number;
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
      title: "",
      createdAt: new Date().toISOString(),
    };
    await this.#registry.addThread(record);
    return record;
  }

  /**
   * Startup reconciliation, run before scheduling resumes. The Pi Durable store is the source of
   * truth, as in Woven Matter: a fork's parent edge is committed with the fork itself, so a crash
   * between `fork()` and the registry write leaves an ownerless fork that only the registry lacks.
   * Such forks are adopted as threads. Task-owned conversations (subagents) are not threads.
   */
  async reconcileThreads(): Promise<Pick<RecoveryReport, "adoptedThreads" | "missingThreads">> {
    const main = await this.main();
    const registered = new Map(
      (await this.#registry.listThreads(this.id)).map((thread) => [thread.conversationId, thread]),
    );
    // Read every conversation record in one read-only transaction; Session has no scan of its own.
    const records = await this.harness.commit(async (tx) => {
      const all: ConversationRecord[] = [];
      let cursor: Parameters<typeof tx.scanConversations>[2];
      do {
        const page = await tx.scanConversations({ order: "ascending" }, 200, cursor);
        all.push(...page.items);
        cursor = page.next;
      } while (cursor !== undefined);
      return all;
    }, ctx);
    const stored = new Set<number>(records.map((record) => record.id));
    const adoptedThreads: number[] = [];
    for (const conversation of records) {
      if (!isThreadFork(conversation, main.id) || registered.has(conversation.id)) continue;
      await this.#registry.addThread({
        botId: this.id,
        conversationId: conversation.id,
        parentConversationId: conversation.parent.conversationId,
        forkedAt: conversation.parent.at,
        title: "",
        createdAt: new Date().toISOString(),
      });
      adoptedThreads.push(conversation.id);
    }
    const missingThreads = [...registered.keys()].filter((id) => !stored.has(id));
    return { adoptedThreads, missingThreads };
  }

  /** The text of a thread's first own user message, or undefined before it has one. */
  async firstUserText(conversationId: number): Promise<string | undefined> {
    const conversation = await this.harness.conversation(toConversationId(conversationId), ctx);
    if (!conversation) return undefined;
    let cursor: Parameters<Conversation["entries"]>[2];
    do {
      const page = await conversation.entries({ order: "ascending" }, 200, cursor, ctx);
      for (const entry of page.items) {
        if (entry.conversationId !== conversationId) continue;
        const shown = displayEntry(entry);
        if (shown?.role === "user" && shown.text.trim()) return shown.text;
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return undefined;
  }

  /** Every thread, newest first; with `query`, only threads whose title matches every term. */
  threads(query?: string): Promise<ThreadRecord[]> {
    return query?.trim()
      ? this.#registry.searchThreads(this.id, query)
      : this.#registry.listThreads(this.id);
  }
}

function isThreadFork(
  conversation: ConversationRecord,
  mainId: number,
): conversation is ConversationRecord & { parent: NonNullable<ConversationRecord["parent"]> } {
  return conversation.id !== mainId && conversation.parent !== undefined && !conversation.owner;
}

/**
 * Background thread titling. At most one request per thread at a time; the title is written only
 * while the thread is still untitled, so a late or repeated request never overwrites one.
 */
export class ThreadTitles {
  readonly #generator: TitleGenerator;
  readonly #registry: BotRegistry;
  readonly #onReport: (error: unknown) => void;
  readonly #inFlight = new Map<string, Promise<void>>();
  readonly #abort = new AbortController();

  constructor(
    generator: TitleGenerator,
    registry: BotRegistry,
    onReport: (error: unknown) => void = () => {},
  ) {
    this.#generator = generator;
    this.#registry = registry;
    this.#onReport = onReport;
  }

  /** Title the thread from `firstPrompt` unless it already has a title or a request running. */
  request(botId: string, conversationId: number, firstPrompt: string): void {
    const key = `${botId}:${conversationId}`;
    if (this.#abort.signal.aborted || this.#inFlight.has(key) || !firstPrompt.trim()) return;
    const run = (async () => {
      const thread = await this.#registry.getThread(botId, conversationId);
      if (!thread || thread.title) return;
      const title = await this.#generator.generate(firstPrompt, this.#abort.signal);
      await this.#registry.setThreadTitleIfUntitled(botId, conversationId, title);
    })()
      .catch((error: unknown) => {
        if (!this.#abort.signal.aborted) this.#onReport(error);
      })
      .finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, run);
  }

  /** Resolves once every running title request has settled (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.#inFlight.size) await Promise.all(this.#inFlight.values());
  }

  async close(): Promise<void> {
    this.#abort.abort();
    await this.idle();
  }
}

export type BotManagerOptions = {
  /** The shared database. The manager never closes it. */
  readonly db: SqliteDatabase;
  /** Harness options for one bot (models, registry, default agent). */
  readonly harnessOptions: (bot: BotRecord) => BotHarnessOptions;
  readonly onBotClosed?: (bot: BotRecord, reason: string) => void;
  readonly onBotDeleted?: (bot: BotRecord) => Promise<void>;
  /** Thread title generation (`[models.titles]`); threads stay untitled without it. */
  readonly titles?: TitleGenerator;
  readonly onReport?: (error: unknown) => void;
  /** Called once per opened bot with what startup recovery found. */
  readonly onRecovered?: (bot: BotRecord, report: RecoveryReport) => void;
};

/**
 * Hosts every bot in this process. Each opened Harness has scheduling enabled (`resume()`), so
 * its own timers drive sleeping and retried tasks; this replaces Durable Object alarms.
 */
export class BotManager {
  readonly registry: BotRegistry;
  readonly titles: ThreadTitles | undefined;
  readonly #bots = new Map<string, Promise<Bot>>();
  #closed = false;

  readonly #options: BotManagerOptions;

  private constructor(options: BotManagerOptions) {
    this.#options = options;
    this.registry = new BotRegistry(options.db);
    this.titles = options.titles
      ? new ThreadTitles(options.titles, this.registry, options.onReport)
      : undefined;
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
    const bot = new Bot(record, harness, this.registry, this.titles);
    let report: RecoveryReport;
    try {
      report = await this.#recover(bot);
    } catch (error) {
      await harness.close(ctx).catch(() => {});
      throw error;
    }
    void harness.closed.then((end) => {
      const current = this.#bots.get(id);
      void current?.then((bot) => {
        if (bot.harness === harness) this.#bots.delete(id);
      });
      this.#options.onBotClosed?.(record, end.reason);
    });
    this.#options.onRecovered?.(record, report);
    return bot;
  }

  /**
   * Woven Matter's load path (`engine.mjs` `create`): reinstall the host around committed work,
   * inspect it, then resume scheduling so interrupted runs and queued input continue. Pi Durable's
   * open already reconciled interrupted invocations; `resume()` lets them run again.
   */
  async #recover(bot: Bot): Promise<RecoveryReport> {
    const { harness } = bot;
    const threads = await bot.reconcileThreads();
    const live = await harness.inspect(ctx);
    const resumed = new Set<number>();
    for (const submission of live.submissions) resumed.add(submission.conversationId);
    for (const task of live.tasks) resumed.add(task.record.conversationId);
    harness.resume();
    const retitledThreads: number[] = [];
    if (this.titles) {
      for (const thread of await this.registry.listThreads(bot.id)) {
        if (thread.title || threads.missingThreads.includes(thread.conversationId)) continue;
        const first = await bot.firstUserText(thread.conversationId);
        if (!first) continue;
        this.titles.request(bot.id, thread.conversationId, first);
        retitledThreads.push(thread.conversationId);
      }
    }
    return { ...threads, resumedConversations: [...resumed], retitledThreads };
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
    await this.titles?.close();
    const bots = [...this.#bots.values()];
    this.#bots.clear();
    for (const pending of bots) {
      const bot = await pending.catch(() => undefined);
      if (bot) await bot.harness.close(ctx);
    }
  }
}
