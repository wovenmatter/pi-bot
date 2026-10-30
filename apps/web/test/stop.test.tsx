import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ComposerActions, stopReply } from "../src/features/Conversation.tsx";
import { applyStreamEvent, emptyConversation } from "../src/features/conversation-state.ts";

const actions = (running: boolean, extra: { stopping?: boolean } = {}) =>
  renderToStaticMarkup(
    <ComposerActions
      running={running}
      stopping={extra.stopping ?? false}
      canSend
      canStop
      onStop={() => {}}
    />,
  );

describe("Stop reply", () => {
  it("shows Stop beside Send only while a reply is running", () => {
    const idle = actions(false);
    expect(idle).not.toContain("Stop reply");
    expect(idle).toContain('aria-label="Send message"');

    const running = actions(true);
    expect(running).toContain('class="stop-button"');
    expect(running).toContain('aria-label="Stop reply"');
    expect(running).toContain("lucide-square");
    expect(running.indexOf("Stop reply")).toBeLessThan(running.indexOf("Send message"));
    expect(actions(true, { stopping: true })).toMatch(/aria-label="Stop reply"[^>]*disabled/);
  });

  it("follows the run: Stop goes away when the turn ends", () => {
    const started = applyStreamEvent(emptyConversation, { kind: "run", state: "start" });
    expect(started.running).toBe(true);
    expect(applyStreamEvent(started, { kind: "run", state: "end" }).running).toBe(false);
  });

  it("sends conversation.abort for the open conversation", async () => {
    const request = vi.fn(async () => ({ conversationId: 7, stopped: true as const }));
    await expect(stopReply({ request } as never, "b1", 7)).resolves.toEqual({
      conversationId: 7,
      stopped: true,
    });
    expect(request).toHaveBeenCalledWith("conversation.abort", { botId: "b1", conversationId: 7 });
  });
});
