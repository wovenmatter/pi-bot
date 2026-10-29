import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Conversation, type ConversationRecord, Harness } from "@earendil-works/pi-durable";
import { type SqliteDatabase, SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { BotHarnessOptions } from "./agent.ts";
import { conversationId as toConversationId, entryId as toEntryId } from "./ids.ts";
import { sharedDatabaseView } from "./storage/database.ts";
import {
  type BotRecord,
  BotRegistry,
  botPrefix,
  type DeletedBotRecord,
  type ThreadRecord,
} from "./storage/registry.ts";
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

/** A request that breaks a bot rule (Admin Bot is locked; teams are one level deep). */
export class BotRuleError extends Error {
  override name = "BotRuleError";
}

export const ADMIN_NAME = "Admin Bot";

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
  /** After a soft delete: release runtime resources (containers). Never delete bot data. */
  readonly onBotDeleted?: (bot: BotRecord) => Promise<void>;
  /** After a restore: bring the bot's runtime environment (container) back up. */
  readonly onBotRestored?: (bot: BotRecord) => Promise<void>;
  /** Thread title generation (`[models.titles]`); threads stay untitled without it. */
  readonly titles?: TitleGenerator;
  readonly onReport?: (error: unknown) => void;
  /** Called once per opened bot with what startup recovery found. */
  readonly onRecovered?: (bot: BotRecord, report: RecoveryReport) => void;
  /** Create the Admin Bot on open when there is none (the app does; most tests do not). */
  readonly ensureAdmin?: boolean;
  /** A bot was created, deleted, restored or moved between teams (pushes a refresh to clients). */
  readonly onBotsChanged?: () => void;
  /** Applies a model to a bot's open main channel (`setModel`); see `agent.ts`. */
  readonly applyModel?: (bot: Bot, model: string) => Promise<void>;
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
    if (options.ensureAdmin) {
      if (await manager.registry.admin()) await manager.registry.renameAdmin(ADMIN_NAME);
      else await manager.#insert(ADMIN_NAME, { kind: "admin", manager: false });
    }
    // Live bots only: soft-deleted bots are neither loaded nor recovered.
    for (const record of await manager.registry.list()) await manager.get(record.id);
    return manager;
  }

  list(): Promise<BotRecord[]> {
    return this.registry.list();
  }

  /** The Admin Bot (undefined only without `ensureAdmin`). */
  admin(): Promise<BotRecord | undefined> {
    return this.registry.admin();
  }

  /** A live bot's record, or a NotFoundError. */
  async record(id: string): Promise<BotRecord> {
    const record = await this.registry.get(id);
    if (!record) throw new NotFoundError(`no bot ${id}`);
    return record;
  }

  /**
   * Create a bot. With `managerId` it joins that manager's team. `createdBy` is the bot that
   * asked for it (an agent tool): a bot created by a manager or a team member joins that team.
   */
  async create(
    name: string,
    options: { readonly managerId?: string; readonly createdBy?: string } = {},
  ): Promise<BotRecord> {
    let managerId = options.managerId;
    if (managerId === undefined && options.createdBy) {
      const creator = await this.record(options.createdBy);
      managerId = creator.manager ? creator.id : creator.managerId;
    }
    if (managerId !== undefined) await this.#requireManager(managerId);
    const record = await this.#insert(name, {
      kind: "bot",
      manager: false,
      ...(managerId ? { managerId } : {}),
    });
    this.#options.onBotsChanged?.();
    return record;
  }

  async #insert(
    name: string,
    team: Pick<BotRecord, "kind" | "manager" | "managerId">,
  ): Promise<BotRecord> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("bot name is required");
    if (trimmed.length > 80) throw new Error("bot name is too long");
    const id = randomUUID();
    const record: BotRecord = {
      id,
      name: trimmed,
      prefix: botPrefix(id),
      createdAt: new Date().toISOString(),
      ...team,
    };
    await this.registry.insert(record);
    try {
      const bot = await this.get(id);
      await bot.main();
    } catch (error) {
      // A half-created bot is soft-deleted like any other; its tables stay until purging exists.
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
    if (!record) {
      // Soft-deleted bots are never opened, so never recovered or messaged.
      if (await this.registry.deletedAt(id)) throw new NotFoundError(`bot ${id} was deleted`);
      throw new NotFoundError(`no bot ${id}`);
    }
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
    // `#open` rejects soft-deleted bots before a harness exists, so they never reach recovery.
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

  /**
   * Soft-delete a bot. Only the user deletes bots (the WebSocket `bots.delete` request); no agent
   * or orchestrator tool may call this. The registry row is marked deleted first, so no new open
   * can start, then the in-memory harness is closed and evicted and the bot's runtime environment
   * released. Its tables, threads and data stay in the database, so `restore()` can bring it back
   * (from Settings → Deleted bots); purging is deferred.
   */
  async delete(id: string): Promise<boolean> {
    const record = await this.registry.get(id);
    if (!record) return false;
    if (record.kind === "admin") throw new BotRuleError("the Admin Bot cannot be deleted");
    if (!(await this.registry.markDeleted(id))) return false;
    // Deleting a manager ungroups its team; a deleted bot comes back on no team.
    if (record.manager) await this.registry.moveMembers(id, undefined);
    await this.registry.setTeam(id, { manager: false });
    this.#options.onBotsChanged?.();
    const open = this.#bots.get(id);
    this.#bots.delete(id);
    if (open) {
      const bot = await open.catch(() => undefined);
      if (bot) await bot.harness.close(ctx);
    }
    await this.#options.onBotDeleted?.(record);
    return true;
  }

  /** Soft-deleted bots, for the user's Settings → Deleted bots. User-only, like `delete`. */
  listDeleted(): Promise<DeletedBotRecord[]> {
    return this.registry.listDeleted();
  }

  /**
   * Restore a soft-deleted bot (user-only: no agent or orchestrator tool may call this). Clears
   * `deleted_at`, then opens the bot as on a normal load: its history and threads are intact, it
   * goes through startup recovery, and its environment is re-acquired lazily through
   * `harnessOptions`. Returns undefined for an unknown or live bot.
   */
  async restore(id: string): Promise<BotRecord | undefined> {
    if (this.#closed) throw new Error("bot manager is closed");
    if (!(await this.registry.restore(id))) return undefined;
    const bot = await this.get(id);
    await this.#options.onBotRestored?.(bot.record);
    this.#options.onBotsChanged?.();
    return this.record(id);
  }

  async #requireManager(id: string): Promise<BotRecord> {
    const manager = await this.registry.get(id);
    if (!manager) throw new NotFoundError(`no bot ${id}`);
    if (!manager.manager) throw new BotRuleError(`${manager.name} is not a manager`);
    return manager;
  }

  async #requireTeamable(id: string): Promise<BotRecord> {
    const record = await this.record(id);
    if (record.kind === "admin") throw new BotRuleError("the Admin Bot is never on a team");
    return record;
  }

  /**
   * Promote a bot to manager (it leaves any team it was on: managers have no manager) or demote
   * it (its team is ungrouped).
   */
  async setManager(id: string, manager: boolean): Promise<BotRecord> {
    const record = await this.#requireTeamable(id);
    if (manager) {
      await this.registry.setTeam(id, { manager: true });
    } else if (record.manager) {
      await this.registry.moveMembers(id, undefined);
      await this.registry.setTeam(id, { manager: false });
    }
    this.#options.onBotsChanged?.();
    return this.record(id);
  }

  /** Put a bot on `managerId`'s team, or off any team with `undefined`. */
  async setTeam(id: string, managerId: string | undefined): Promise<BotRecord> {
    const record = await this.#requireTeamable(id);
    if (managerId !== undefined) {
      if (record.manager) throw new BotRuleError(`${record.name} is a manager; demote it first`);
      if (managerId === id) throw new BotRuleError("a bot cannot manage itself");
      await this.#requireManager(managerId);
    }
    await this.registry.setTeam(id, {
      manager: record.manager,
      ...(managerId ? { managerId } : {}),
    });
    this.#options.onBotsChanged?.();
    return this.record(id);
  }

  /**
   * Give a team a new manager: `newManagerId` is promoted and takes over every member, and the old
   * manager stays on the team as a member.
   */
  async replaceManager(managerId: string, newManagerId: string): Promise<BotRecord> {
    const old = await this.#requireManager(managerId);
    const next = await this.#requireTeamable(newManagerId);
    if (next.id === old.id) return old;
    if (next.manager) throw new BotRuleError(`${next.name} already manages a team`);
    await this.registry.setTeam(next.id, { manager: true });
    await this.registry.moveMembers(old.id, next.id, next.id);
    await this.registry.setTeam(old.id, { manager: false, managerId: next.id });
    this.#options.onBotsChanged?.();
    return this.record(next.id);
  }

  /** Set the model of a bot's main channel (`provider/modelId`); used for the Admin Bot model. */
  async setModel(id: string, model: string): Promise<BotRecord> {
    const bot = await this.get(id);
    await this.#options.applyModel?.(bot, model);
    await this.registry.setModel(id, model);
    this.#options.onBotsChanged?.();
    return this.record(id);
  }

  /**
   * Live runs across every open bot: queued submissions plus running tasks, from Pi Durable's
   * inspection. A graceful restart waits for this to reach zero (bounded), and Pi Durable resumes
   * whatever is still live when the next process opens the bots.
   */
  async activeWork(): Promise<number> {
    let count = 0;
    for (const pending of [...this.#bots.values()]) {
      const bot = await pending.catch(() => undefined);
      if (!bot) continue;
      const live = await bot.harness.inspect(ctx).catch(() => undefined);
      if (live) count += live.submissions.length + live.tasks.length;
    }
    return count;
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
