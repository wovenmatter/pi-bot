import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PiBotClient } from "../src/api.ts";
import { Onboarding } from "../src/features/Onboarding.tsx";
import { AdminModelPicker, placementOf, TeamsPanel } from "../src/features/settings/Teams.tsx";
import type { BotSummary } from "../src/protocol.ts";
import { groupBots } from "../src/shell/bot-groups.ts";
import { Sidebar } from "../src/shell/Sidebar.tsx";

const noop = () => {};
const bot = (id: string, extra: Partial<BotSummary> = {}): BotSummary => ({
  id,
  name: id[0]?.toUpperCase() + id.slice(1),
  createdAt: "2026-10-29T00:00:00Z",
  kind: "bot",
  manager: false,
  ...extra,
});
const bots = [
  bot("loose"),
  bot("lead", { manager: true }),
  bot("admin", { kind: "admin", model: "openai/gpt-x" }),
  bot("member", { managerId: "lead" }),
];

describe("bot groups", () => {
  it("pins Admin and nests members under their manager", () => {
    const groups = groupBots(bots);
    expect(groups.admin?.id).toBe("admin");
    expect(groups.teams.map((t) => [t.manager.id, t.members.map((m) => m.id)])).toEqual([
      ["lead", ["member"]],
    ]);
    expect(groups.ungrouped.map((b) => b.id)).toEqual(["loose"]);
  });

  it("sidebar lists Admin first without a delete button", () => {
    const html = renderToStaticMarkup(
      <Sidebar
        bots={bots}
        botId="admin"
        conversationId={undefined}
        mainConversationId={undefined}
        settings={false}
        connection="open"
        theme="green"
        onTheme={noop}
        onCreate={async () => {}}
        onDelete={noop}
      />,
    );
    const order = ["Admin", "Lead", "Member", "Loose"].map((name) => html.indexOf(`>${name}<`));
    expect(order.every((at, i) => at > 0 && (i === 0 || at > (order[i - 1] ?? 0)))).toBe(true);
    expect(html).not.toContain("Delete Admin");
    expect(html).toContain("Delete Lead");
    expect(html).toContain("rail-member");
  });
});

describe("teams panel", () => {
  it("maps bots to placements and hides Admin", () => {
    expect(bots.map(placementOf)).toEqual(["none", "manager", "none", "lead"]);
    const html = renderToStaticMarkup(
      <TeamsPanel bots={bots} onPlace={noop} onReplaceManager={noop} />,
    );
    expect(html).not.toContain("Team for Admin");
    expect(html).toContain("Team: Member");
    expect(html).toContain("On Lead&#x27;s team");
    expect(html).toContain("Hand Lead&#x27;s team to");
  });

  it("admin model picker needs a signed-in provider", () => {
    expect(
      renderToStaticMarkup(<AdminModelPicker providers={[]} onSave={async () => {}} />),
    ).toContain("Sign in to a model provider first");
    const html = renderToStaticMarkup(
      <AdminModelPicker
        providers={[
          {
            id: "openai",
            name: "OpenAI",
            models: [{ id: "gpt-x", name: "GPT X", reasoning: false, contextWindow: 1 }],
          },
        ]}
        current="openai/gpt-x"
        onSave={async () => {}}
      />,
    );
    expect(html).toContain('value="openai/gpt-x" selected=""');
  });
});

describe("onboarding", () => {
  const client = new PiBotClient("ws://127.0.0.1:9/ws");
  it("asks to sign in before picking a model", () => {
    const html = renderToStaticMarkup(
      <Onboarding
        client={client}
        connected={false}
        status={{ adminId: "admin", signedIn: false, needed: true }}
        onStatus={noop}
      />,
    );
    expect(html).toContain("1. Sign in");
    expect(html).toContain("Sign in first.");
  });
  it("offers the model step once signed in", () => {
    const html = renderToStaticMarkup(
      <Onboarding
        client={client}
        connected={false}
        status={{ adminId: "admin", signedIn: true, needed: true }}
        onStatus={noop}
      />,
    );
    expect(html).toContain("Signed in.");
    expect(html).not.toContain("Sign in first.");
  });
});
