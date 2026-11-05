import { describe, expect, it, vi } from "vitest";
import { ConversationDrafts } from "../src/features/conversation-drafts.ts";

describe("conversation drafts", () => {
  it("retains text and attachments per conversation while panes unsubscribe and reopen", () => {
    const store = new ConversationDrafts();
    const empty = store.read(7);
    expect(store.read(7)).toBe(empty);
    const mainChanged = vi.fn();
    const threadChanged = vi.fn();
    const stopMain = store.subscribe("main", mainChanged);
    const stopThread = store.subscribe(7, threadChanged);
    const file = { id: store.nextAttachmentId(), name: "notes.txt", text: "local attachment" };
    store.update(7, () => ({ text: "Unsent thread reply", attachments: [file] }));
    expect(mainChanged).not.toHaveBeenCalled();
    expect(threadChanged).toHaveBeenCalledTimes(1);
    stopThread();
    expect(store.read(7)).toEqual({ text: "Unsent thread reply", attachments: [file] });
    expect(store.read("main")).toBe(empty);
    expect(store.nextAttachmentId()).toBeGreaterThan(file.id);
    stopMain();
  });

  it("applies a delayed send acknowledgement to the latest draft without clearing new edits", () => {
    const store = new ConversationDrafts();
    const sentFile = { id: store.nextAttachmentId(), name: "sent.txt", text: "sent" };
    const newFile = { id: store.nextAttachmentId(), name: "new.txt", text: "new" };
    store.update(7, () => ({ text: "sent reply", attachments: [sentFile] }));
    const reopened = vi.fn();
    const stop = store.subscribe(7, reopened);
    store.update(7, () => ({ text: "new reply", attachments: [sentFile, newFile] }));
    store.update(7, (current) => ({
      text: current.text.trim() === "sent reply" ? "" : current.text,
      attachments: current.attachments.filter((file) => file !== sentFile),
    }));
    expect(store.read(7)).toEqual({ text: "new reply", attachments: [newFile] });
    expect(reopened).toHaveBeenCalledTimes(2);
    store.update(7, () => ({ text: "", attachments: [] }));
    expect(store.read(7)).toBe(store.read("main"));
    stop();
  });
});
