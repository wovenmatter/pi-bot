import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  DeletedBotsList,
  formatDeletedAt,
  purgeConfirmText,
  purgeDeletedBot,
} from "../src/features/Settings.tsx";
import { parseRoute, routeHref } from "../src/routes.ts";

const deleted = [
  {
    id: "b1",
    name: "Scout",
    createdAt: "2026-10-01T12:00:00.000Z",
    deletedAt: "2026-10-26T15:30:00.000Z",
    kind: "bot" as const,
    manager: false,
    orchestrator: false,
    profileId: "default",
    profileName: "Default",
    defaultProfile: true,
  },
];

describe("Settings → Bots → Deleted bots", () => {
  it("lists each deleted bot with its deleted date and a Restore button", () => {
    const html = renderToStaticMarkup(<DeletedBotsList bots={deleted} onRestore={() => {}} />);
    expect(html).toContain("Deleted bots");
    expect(html).toContain("Scout");
    expect(html).toContain('dateTime="2026-10-26T15:30:00.000Z"');
    expect(html).toContain(formatDeletedAt(deleted[0]?.deletedAt ?? ""));
    expect(html).toContain('aria-label="Restore Scout"');
    expect(html).not.toContain("disabled");
  });

  it("shows an empty state and disables Restore while one is in flight", () => {
    expect(renderToStaticMarkup(<DeletedBotsList bots={[]} onRestore={() => {}} />)).toContain(
      "No deleted bots.",
    );
    const busy = renderToStaticMarkup(
      <DeletedBotsList bots={deleted} restoring="b1" onRestore={() => {}} />,
    );
    expect(busy).toContain("Restoring…");
    expect(busy).toContain("disabled");
  });

  it("offers Delete permanently per deleted bot, disabled while one is in flight", () => {
    const html = renderToStaticMarkup(
      <DeletedBotsList bots={deleted} onRestore={() => {}} onPurge={() => {}} />,
    );
    expect(html).toContain('aria-label="Delete Scout permanently"');
    expect(html).toContain('class="text-button danger"');
    expect(html).not.toContain("disabled");
    const busy = renderToStaticMarkup(
      <DeletedBotsList bots={deleted} purging="b1" onRestore={() => {}} onPurge={() => {}} />,
    );
    expect(busy).toContain("Deleting…");
    expect(busy.match(/disabled/g)).toHaveLength(2);
  });

  it("confirms a permanent delete: cancel sends nothing, confirm sends bots.purge", async () => {
    const bot = deleted[0];
    if (!bot) throw new Error("no bot");
    const text = purgeConfirmText(bot);
    expect(text).toContain("Delete Scout permanently?");
    for (const part of [
      "conversations",
      "threads",
      "memory and notes",
      "settings",
      "Docker workspace volume and container",
      "can't be undone",
    ]) {
      expect(text).toContain(part);
    }

    const request = vi.fn(async () => ({ purged: true as const, tables: 9 }));
    const asked: string[] = [];
    const cancel = (message: string) => {
      asked.push(message);
      return false;
    };
    expect(await purgeDeletedBot({ request } as never, bot, cancel)).toBeUndefined();
    expect(asked).toEqual([text]);
    expect(request).not.toHaveBeenCalled();

    expect(await purgeDeletedBot({ request } as never, bot, () => true)).toEqual({
      purged: true,
      tables: 9,
    });
    expect(request).toHaveBeenCalledExactlyOnceWith("bots.purge", { botId: "b1" });
  });

  it("routes #/settings separately from bots", () => {
    expect(parseRoute("#/settings")).toEqual({ settings: true });
    expect(routeHref({ settings: true })).toBe("#/settings");
    expect(parseRoute("#/b1/3")).toEqual({ botId: "b1", conversationId: 3 });
  });
});
