import type { Api, AssistantMessage, Message, Model, Models } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { BotManager } from "./bots.ts";
import { parseModelRef } from "./config.ts";
import { type CronSchedule, parseCron, zonedParts } from "./cron.ts";
import { displayEntry } from "./transcript.ts";

/** What the memory extractor sees before a compaction replaces part of a conversation's context. */
export type BeforeCompactInput = {
  readonly conversationId: number;
  readonly reason: string;
  /** The entries the compaction covers (the head marker first). They stay in SQLite. */
  readonly entries: readonly EntryRecord[];
  readonly messages: readonly Message[];
};

/**
 * The memory-extraction point of every compaction (main channel and threads alike). It runs
 * before the provider or Pi Durable summarizes, so durable facts can be extracted from the
 * covered messages. A throw is reported and compaction continues.
 */
export type BeforeCompactHook = (
  input: BeforeCompactInput,
  context: unknown,
) => void | Promise<void>;

/**
 * The hook in use: a no-op. Compaction never deletes entries, so `MemoryExtractor` reads covered
 * messages from SQLite on its own schedule instead.
 */
export const noopBeforeCompact: BeforeCompactHook = () => {};

/** Facts kept per bot; the oldest are dropped beyond this. */
export const MAX_FACTS = 200;
/** New facts taken from one extraction. */
const MAX_NEW_FACTS = 20;
const MAX_FACT_CHARS = 300;
/** Transcript sent per extraction; older new messages beyond it are skipped (newest kept). */
const MAX_TRANSCRIPT_CHARS = 60_000;
const MAX_MESSAGE_CHARS = 4_000;

/**
 * The bot's memory as its prompt section. It changes only when an extraction adds facts, so the
 * system prompt stays cacheable between extractions.
 */
export function memorySection(facts: readonly string[]): string | undefined {
  if (facts.length === 0) return undefined;
  return [
    "What you remember from earlier conversations with the user (durable facts and preferences):",
    ...facts.map((fact) => `- ${fact}`),
  ].join("\n");
}

/** The request sent to the extraction model. */
export function extractionPrompt(existing: readonly string[], transcript: string): string {
  return `You maintain the long-term memory of a personal assistant. From the conversation below, extract durable facts about the user: preferences, projects, people, decisions and standing instructions that will still matter in future conversations.
Skip small talk, one-off requests, anything already in memory and any secret (passwords, keys, tokens).
Reply with one short, self-contained fact per line, each starting with "- ". Reply NONE if there is nothing new.

Memory so far:
${existing.length ? existing.map((fact) => `- ${fact}`).join("\n") : "(empty)"}

Conversation:
${transcript}`;
}

/** The facts in a reply: bullet lines, trimmed and capped. */
export function parseFacts(reply: string): string[] {
  const facts: string[] = [];
  for (const line of reply.split(/\r?\n/)) {
    const match = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line);
    const fact = match?.[1]?.trim().replace(/\s+/g, " ");
    if (!fact || /^none\.?$/i.test(fact)) continue;
    facts.push(fact.length > MAX_FACT_CHARS ? `${fact.slice(0, MAX_FACT_CHARS - 1)}…` : fact);
  }
  return facts;
}

const normalize = (fact: string) =>
  fact
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * `existing` plus the facts of `found` it doesn't already have (case and punctuation ignored),
 * capped at `MAX_FACTS` (oldest dropped), and how many were added.
 */
export function mergeFacts(
  existing: readonly string[],
  found: readonly string[],
): { facts: string[]; added: number } {
  const seen = new Set(existing.map(normalize));
  const added: string[] = [];
  for (const fact of found) {
    const key = normalize(fact);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    added.push(fact);
    if (added.length >= MAX_NEW_FACTS) break;
  }
  return { facts: [...existing, ...added].slice(-MAX_FACTS), added: added.length };
}

export type MemoryExtractorOptions = {
  readonly manager: BotManager;
  /** Models for extraction requests (the app's credential-backed models). */
  readonly models: Models | (() => Models);
  /** `[extraction] schedule`; omitted: idle extraction only. */
  readonly schedule?: string;
  /** `[extraction] timezone` the schedule is read in. */
  readonly timeZone?: string;
  /** A bot idle this long after new messages is extracted; 0: never on idle. */
  readonly idleMs: number;
  readonly log?: (message: string) => void;
  readonly now?: () => number;
  readonly timeoutMs?: number;
};

const replyText = (message: AssistantMessage) =>
  message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");

/**
 * Scheduled memory extraction. Each tick (a minute) queues every bot when the cron schedule fires,
 * and any bot idle `idleMs` since its newest unprocessed message. Queued bots run one at a time:
 * new user and assistant messages since the bot's checkpoint go to its background model (else its
 * main model, quietly trying the next on failure), and new facts are appended to its memory with
 * the checkpoint in one write. Nothing touches the bots' conversations, so user turns never wait.
 */
export class MemoryExtractor {
  readonly #options: MemoryExtractorOptions;
  readonly #schedule: CronSchedule | undefined;
  readonly #queue = new Set<string>();
  /** Per bot: the newest entry id seen and since when (idle detection). */
  readonly #seen = new Map<string, { id: number; since: number }>();
  readonly #failedAt = new Map<string, number>();
  readonly #abort = new AbortController();
  #lastMinute: string | undefined;
  #worker: Promise<void> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: MemoryExtractorOptions) {
    this.#options = options;
    this.#schedule = options.schedule ? parseCron(options.schedule) : undefined;
  }

  /** Tick every `intervalMs` (a minute) until `close()`. */
  start(intervalMs = 60_000): void {
    if (this.#timer) return;
    let ticking = false;
    this.#timer = setInterval(() => {
      if (ticking) return;
      ticking = true;
      this.tick()
        .catch((error: unknown) => this.#log(`memory: ${String(error)}`))
        .finally(() => {
          ticking = false;
        });
    }, intervalMs);
    this.#timer.unref?.();
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  #log(message: string): void {
    this.#options.log?.(message);
  }

  /** Queue the bots that are due: all of them when the schedule fires, plus idle ones. */
  async tick(): Promise<void> {
    if (this.#abort.signal.aborted) return;
    const now = this.#now();
    const { manager } = this.#options;
    const bots = await manager.list();
    const timeZone = this.#options.timeZone ?? "UTC";
    const minute = zonedParts(now, timeZone).join(":");
    if (this.#schedule?.matches(now, timeZone) && this.#lastMinute !== minute) {
      this.#lastMinute = minute;
      for (const bot of bots) this.request(bot.id);
    }
    const idleMs = this.#options.idleMs;
    if (idleMs <= 0) return;
    for (const record of bots) {
      const bot = await manager.get(record.id).catch(() => undefined);
      if (!bot) continue;
      const latest = await bot.latestEntryId();
      const seen = this.#seen.get(record.id);
      if (seen?.id !== latest) this.#seen.set(record.id, { id: latest, since: now });
      const since = Math.max(
        this.#seen.get(record.id)?.since ?? now,
        this.#failedAt.get(record.id) ?? 0,
      );
      if (now - since < idleMs) continue;
      const { checkpoint } = await manager.registry.memory(record.id);
      if (latest > checkpoint) this.request(record.id);
    }
  }

  /** Queue one bot's extraction (deduplicated; one runs at a time). */
  request(botId: string): void {
    if (this.#abort.signal.aborted) return;
    this.#queue.add(botId);
    this.#worker ??= this.#drain();
  }

  async #drain(): Promise<void> {
    try {
      // A Set iterates entries added while it runs, so later requests join this loop.
      for (const botId of this.#queue) {
        this.#queue.delete(botId);
        if (this.#abort.signal.aborted) return;
        try {
          const added = await this.extract(botId);
          this.#failedAt.delete(botId);
          if (added) this.#log(`memory: bot ${botId}: ${added} new fact(s)`);
        } catch (error) {
          this.#failedAt.set(botId, this.#now());
          if (!this.#abort.signal.aborted) {
            this.#log(`memory: bot ${botId}: ${error instanceof Error ? error.message : error}`);
          }
        }
      }
    } finally {
      this.#worker = undefined;
    }
  }

  /**
   * Extract one bot now: returns how many facts were added. Without new messages nothing is sent;
   * without new chat text only the checkpoint moves. A model failure leaves the checkpoint as is.
   */
  async extract(botId: string): Promise<number> {
    const { manager } = this.#options;
    const bot = await manager.get(botId);
    const memory = await manager.registry.memory(botId);
    let checkpoint = memory.checkpoint;
    const lines: { id: number; text: string }[] = [];
    for (const { conversationId } of await bot.conversations()) {
      for await (const entry of bot.ownEntries(conversationId, memory.checkpoint)) {
        checkpoint = Math.max(checkpoint, entry.id);
        const shown = displayEntry(entry);
        const text = shown?.text.trim();
        if (!shown || !text) continue;
        const clipped =
          text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
        lines.push({ id: entry.id, text: `${shown.role}: ${clipped}` });
      }
    }
    if (checkpoint === memory.checkpoint) return 0;
    if (lines.length === 0) {
      await manager.registry.saveMemory(botId, memory.facts, checkpoint);
      return 0;
    }
    lines.sort((a, b) => a.id - b.id);
    const kept: string[] = [];
    let size = 0;
    for (const line of lines.reverse()) {
      if (size + line.text.length > MAX_TRANSCRIPT_CHARS && kept.length) break;
      kept.unshift(line.text);
      size += line.text.length + 1;
    }
    const reply = await this.#ask(botId, extractionPrompt(memory.facts, kept.join("\n")));
    const { facts, added } = mergeFacts(memory.facts, parseFacts(reply));
    await manager.registry.saveMemory(botId, facts, checkpoint);
    return added;
  }

  /** The reply of the first background model that answers. */
  async #ask(botId: string, prompt: string): Promise<string> {
    const source = this.#options.models;
    const models = typeof source === "function" ? source() : source;
    const candidates = this.#options.manager.backgroundModels(botId);
    if (candidates.length === 0) throw new Error("no model available for memory extraction");
    let failure: unknown;
    for (const ref of candidates) {
      const { provider, modelId } = parseModelRef(ref);
      const model: Model<Api> | undefined = models.getModel(provider, modelId);
      if (!model) {
        failure = new Error(`unknown model ${ref}`);
        continue;
      }
      const timeout = AbortSignal.timeout(this.#options.timeoutMs ?? 120_000);
      try {
        const reply = await models
          .streamSimple(
            model,
            { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
            { signal: AbortSignal.any([this.#abort.signal, timeout]) },
          )
          .result();
        if (reply.stopReason === "error" || reply.stopReason === "aborted") {
          throw new Error(reply.errorMessage ?? `request ${reply.stopReason}`);
        }
        return replyText(reply);
      } catch (error) {
        failure = new Error(`${ref}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw failure;
  }

  /** Resolves once the queue is empty (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.#worker) await this.#worker;
  }

  async close(): Promise<void> {
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#abort.abort();
    this.#queue.clear();
    await this.idle();
  }
}
