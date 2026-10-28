import type { Message } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";

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
 * before the provider or Pi Durable summarizes, so a later milestone can extract durable facts
 * from the covered messages. A throw is reported and compaction continues.
 */
export type BeforeCompactHook = (
  input: BeforeCompactInput,
  context: unknown,
) => void | Promise<void>;

/** Milestone 2: wired, deliberately a no-op. */
export const noopBeforeCompact: BeforeCompactHook = () => {};
