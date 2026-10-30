import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeletedBotsList, formatDeletedAt } from "../src/features/Settings.tsx";
import { parseRoute, routeHref } from "../src/routes.ts";

const deleted = [
  {
    id: "b1",
    name: "Scout",
    createdAt: "2026-10-01T12:00:00.000Z",
    deletedAt: "2026-10-26T15:30:00.000Z",
    kind: "bot" as const,
    manager: false,
    top: false,
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

  it("routes #/settings separately from bots", () => {
    expect(parseRoute("#/settings")).toEqual({ settings: true });
    expect(routeHref({ settings: true })).toBe("#/settings");
    expect(parseRoute("#/b1/3")).toEqual({ botId: "b1", conversationId: 3 });
  });
});
