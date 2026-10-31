import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { deleteFactConfirmText, MemoryPanel } from "../src/features/settings/Memory.tsx";
import type { BotSummary } from "../src/protocol.ts";

const noop = () => {};
const save = async () => true;
const bot = (id: string, name: string): BotSummary => ({
  id,
  name,
  createdAt: "2026-10-29T00:00:00Z",
  kind: "bot",
  manager: false,
  orchestrator: false,
  profileId: "default",
  profileName: "Default",
  defaultProfile: true,
});
const bots = [bot("ada", "Ada"), bot("bo", "Bo")];
const panel = (facts: string[] | undefined, botId: string | undefined = "ada") =>
  renderToStaticMarkup(
    <MemoryPanel
      bots={bots}
      botId={botId}
      facts={facts}
      onSelect={noop}
      onAdd={save}
      onUpdate={save}
      onDelete={noop}
    />,
  );

describe("MemoryPanel", () => {
  it("lists the selected bot's facts with edit and delete, and an add field", () => {
    const html = panel(["The user prefers tea", "The user lives in Lisbon"]);
    expect(html).toContain("<h3");
    expect(html).toContain(">Memory</h3>");
    expect(html).toMatch(/<option value="ada" selected="">Ada<\/option>/);
    expect(html).toContain('aria-label="Ada&#x27;s memory"');
    expect(html.indexOf("The user prefers tea")).toBeLessThan(
      html.indexOf("The user lives in Lisbon"),
    );
    expect(html).toContain('aria-label="Edit memory: The user prefers tea"');
    expect(html).toContain('aria-label="Delete memory: The user lives in Lisbon"');
    expect(html).toContain('class="text-button danger"');
    expect(html).toContain('aria-label="New memory"');
    expect(html).toContain(">Add</button>");
    expect(html).not.toContain("doesn&#x27;t remember");
  });

  it("shows one short line when the bot remembers nothing, and loads otherwise", () => {
    const empty = panel([]);
    expect(empty).toContain("Ada doesn&#x27;t remember anything yet.");
    expect(empty).not.toContain("settings-list");
    expect(empty).toContain('aria-label="New memory"');
    expect(panel(undefined)).toContain("Loading…");
    // No bots yet: just the section, no list or field.
    const none = renderToStaticMarkup(
      <MemoryPanel
        bots={[]}
        botId={undefined}
        facts={undefined}
        onSelect={noop}
        onAdd={save}
        onUpdate={save}
        onDelete={noop}
      />,
    );
    expect(none).not.toContain("New memory");
    expect(none).not.toContain("Loading…");
  });

  it("names the fact in the delete confirmation", () => {
    expect(deleteFactConfirmText("The user has a cat")).toBe(
      "Delete this memory?\n\nThe user has a cat",
    );
  });
});
