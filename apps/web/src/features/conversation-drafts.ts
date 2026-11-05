import { type SetStateAction, useCallback, useState, useSyncExternalStore } from "react";

export type DraftAttachment = { id: number; name: string; text: string };
type Draft = { text: string; attachments: DraftAttachment[] };
type DraftKey = number | "main";
const emptyDraft: Draft = { text: "", attachments: [] };

/** In-memory drafts for one bot workspace; closing a pane must not discard unsent content. */
export class ConversationDrafts {
  readonly #drafts = new Map<DraftKey, Draft>();
  readonly #listeners = new Map<DraftKey, Set<() => void>>();
  #attachmentId = 0;
  nextAttachmentId = () => ++this.#attachmentId;

  read(key: DraftKey): Draft {
    return this.#drafts.get(key) ?? emptyDraft;
  }
  update(key: DraftKey, apply: (draft: Draft) => Draft): void {
    const current = this.read(key);
    const next = apply(current);
    if (next.text === current.text && next.attachments === current.attachments) return;
    if (next.text || next.attachments.length) this.#drafts.set(key, next);
    else this.#drafts.delete(key);
    for (const notify of this.#listeners.get(key) ?? []) notify();
  }
  subscribe(key: DraftKey, notify: () => void): () => void {
    let listeners = this.#listeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(key, listeners);
    }
    listeners.add(notify);
    return () => {
      listeners.delete(notify);
      if (!listeners.size) this.#listeners.delete(key);
    };
  }
}

export function useConversationDrafts(
  shared: ConversationDrafts | undefined,
  conversationId?: number,
) {
  const [store] = useState(() => shared ?? new ConversationDrafts());
  const key = conversationId ?? "main";
  const subscribe = useCallback((notify: () => void) => store.subscribe(key, notify), [store, key]);
  const snapshot = useCallback(() => store.read(key), [store, key]);
  const draft = useSyncExternalStore(subscribe, snapshot, snapshot);
  const setText = useCallback(
    (action: SetStateAction<string>) => {
      store.update(key, (current) => ({
        ...current,
        text: typeof action === "function" ? action(current.text) : action,
      }));
    },
    [store, key],
  );
  const setAttachments = useCallback(
    (action: SetStateAction<DraftAttachment[]>) => {
      store.update(key, (current) => ({
        ...current,
        attachments: typeof action === "function" ? action(current.attachments) : action,
      }));
    },
    [store, key],
  );
  return [draft, setText, setAttachments, store.nextAttachmentId] as const;
}
