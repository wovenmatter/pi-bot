import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PiBotClient } from "../src/api.ts";
import { Onboarding } from "../src/features/Onboarding.tsx";
import { AccountNotes } from "../src/features/settings/Accounts.tsx";
import { BotsPanel, placementOf } from "../src/features/settings/Bots.tsx";
import {
  MainModelPicker,
  ProfileEditor,
  ProfilesPanel,
} from "../src/features/settings/Profiles.tsx";
import type { BotSummary, ProfileSummary, ProviderModels } from "../src/protocol.ts";
import { groupBots } from "../src/shell/bot-groups.ts";
import { Sidebar } from "../src/shell/Sidebar.tsx";

const noop = () => {};
const bot = (id: string, extra: Partial<BotSummary> = {}): BotSummary => ({
  id,
  name: id[0]?.toUpperCase() + id.slice(1),
  createdAt: "2026-10-29T00:00:00Z",
  kind: "bot",
  manager: false,
  top: false,
  profileId: "default",
  profileName: "Default",
  defaultProfile: true,
  ...extra,
});
const bots = [
  bot("loose"),
  bot("lead", { manager: true }),
  bot("admin", {
    name: "Admin Bot",
    kind: "admin",
    profileId: "fast",
    profileName: "Fast",
    defaultProfile: false,
  }),
  bot("member", { managerId: "lead" }),
];

describe("bot groups", () => {
  it("pins Admin Bot and nests members under their manager", () => {
    const groups = groupBots(bots);
    expect(groups.admin?.id).toBe("admin");
    expect(groups.teams.map((t) => [t.manager.id, t.members.map((m) => m.id)])).toEqual([
      ["lead", ["member"]],
    ]);
    expect(groups.ungrouped.map((b) => b.id)).toEqual(["loose"]);
  });

  it("sidebar lists Admin Bot first without a delete button", () => {
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
    const order = ["Admin Bot", "Lead", "Member", "Loose"].map((name) => html.indexOf(`>${name}<`));
    expect(order.every((at, i) => at > 0 && (i === 0 || at > (order[i - 1] ?? 0)))).toBe(true);
    expect(html).not.toContain("Delete Admin Bot");
    expect(html).toContain("Delete Lead");
    expect(html).toContain("rail-member");
  });

  it("lists the selected bot's threads by their generated titles, read-only", () => {
    const html = renderToStaticMarkup(
      <Sidebar
        bots={bots}
        botId="lead"
        conversationId={7}
        mainConversationId={1}
        threads={[
          {
            conversationId: 7,
            parentConversationId: 1,
            forkedAt: 3,
            createdAt: "",
            title: "Q4 plan",
          },
          { conversationId: 8, parentConversationId: 1, forkedAt: 4, createdAt: "" },
        ]}
        settings={false}
        connection="open"
        theme="green"
        onTheme={noop}
        onCreate={async () => {}}
        onDelete={noop}
      />,
    );
    expect(html).toMatch(/href="#\/lead\/7"[^>]*aria-current="page"/);
    expect(html).toContain(">Q4 plan<");
    expect(html).toContain(">Untitled thread<");
    expect(html).not.toMatch(/rename/i);
  });
});

describe("top bot", () => {
  const withTop = [
    bot("loose"),
    bot("lead", { manager: true }),
    bot("chief", { top: true, manager: true }),
    bots[2] as BotSummary,
    bot("member", { managerId: "lead" }),
    bot("aide", { managerId: "chief" }),
  ];

  it("groups the top bot after Admin Bot with its own team, apart from other teams", () => {
    const groups = groupBots(withTop);
    expect(groups.top?.bot.id).toBe("chief");
    expect(groups.top?.members.map((m) => m.id)).toEqual(["aide"]);
    expect(groups.teams.map((t) => t.manager.id)).toEqual(["lead"]);
    expect(groups.ungrouped.map((b) => b.id)).toEqual(["loose"]);
    expect(groupBots(bots).top).toBeUndefined();
  });

  it("sidebar lists the top bot right after Admin Bot with a small label", () => {
    const html = renderToStaticMarkup(
      <Sidebar
        bots={withTop}
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
    const order = ["Admin Bot", "Chief", "Aide", "Lead", "Member", "Loose"].map((name) =>
      html.indexOf(`>${name}<`),
    );
    expect(order.every((at, i) => at > 0 && (i === 0 || at > (order[i - 1] ?? 0)))).toBe(true);
    expect(html.match(/class="badge">Top bot</g)).toHaveLength(1);
    expect(html.indexOf("Top bot<")).toBeGreaterThan(html.indexOf(">Chief<"));
    expect(html.indexOf("Top bot<")).toBeLessThan(html.indexOf(">Aide<"));
  });

  it("bots panel sets the top bot, lists it first and keeps it off other teams", () => {
    const html = renderToStaticMarkup(
      <BotsPanel
        bots={withTop}
        profiles={profiles}
        onSetProfile={noop}
        onPlace={noop}
        onReplaceManager={noop}
        onSetTop={noop}
      />,
    );
    const picker = html.slice(html.indexOf('aria-label="Top bot"'), html.indexOf("</select>"));
    expect(picker).toContain(">None<");
    expect(picker).toContain('value="chief" selected=""');
    expect(picker).not.toContain("Admin Bot");
    const rows = ["Admin Bot", "Chief", "Loose", "Lead"].map((name) =>
      html.indexOf(`<strong>${name}`),
    );
    expect(rows.every((at, i) => at > 0 && (i === 0 || at > (rows[i - 1] ?? 0)))).toBe(true);
    expect(html).toContain('<strong>Chief<span class="badge">Top bot</span></strong>');
    const chiefTeam = html.slice(html.indexOf('aria-label="Team for Chief"'));
    expect(chiefTeam.slice(0, chiefTeam.indexOf("</select>"))).not.toContain("On Lead");
    expect(html).toContain("Team: Aide");
    const none = renderToStaticMarkup(
      <BotsPanel
        bots={bots}
        profiles={profiles}
        onSetProfile={noop}
        onPlace={noop}
        onReplaceManager={noop}
        onSetTop={noop}
      />,
    );
    expect(none).toContain('<option value="" selected="">None</option>');
    expect(none).not.toContain('class="badge"');
  });
});

describe("bots panel", () => {
  it("maps bots to placements and keeps Admin Bot off teams", () => {
    expect(bots.map(placementOf)).toEqual(["none", "manager", "none", "lead"]);
    const html = renderToStaticMarkup(
      <BotsPanel
        bots={bots}
        profiles={profiles}
        onSetProfile={noop}
        onPlace={noop}
        onReplaceManager={noop}
        onSetTop={noop}
      />,
    );
    expect(html).not.toContain("Team for Admin Bot");
    expect(html).toContain("Never on a team");
    expect(html).toContain("Team: Member");
    expect(html).toContain("On Lead&#x27;s team");
    expect(html).toContain("Hand Lead&#x27;s team to");
  });

  it("picks a profile per bot, with the default as the empty choice", () => {
    const html = renderToStaticMarkup(
      <BotsPanel
        bots={bots}
        profiles={profiles}
        onSetProfile={noop}
        onPlace={noop}
        onReplaceManager={noop}
        onSetTop={noop}
      />,
    );
    expect(html).toContain("Profile for Admin Bot");
    expect(html).toContain('<option value="">Default (Default)</option>');
    expect(html).toContain('value="fast" selected=""');
    expect(html).not.toContain("Model profiles");
  });
});

const providers: ProviderModels[] = [
  {
    id: "openai",
    name: "OpenAI",
    models: [{ id: "gpt-x", name: "GPT X", reasoning: false, contextWindow: 1 }],
  },
];
const profiles: ProfileSummary[] = [
  {
    id: "default",
    name: "Default",
    main: "openai/gpt-x",
    pool: [{ model: "openai/gpt-x", useFor: "Lookups", background: true }],
    default: true,
  },
  { id: "fast", name: "Fast", main: "gone/model", guidance: "Be quick.", pool: [] },
];

describe("profiles", () => {
  it("main model picker needs a signed-in provider and an available model", () => {
    expect(
      renderToStaticMarkup(<MainModelPicker providers={[]} onSave={async () => {}} />),
    ).toContain("Sign in to a model provider first");
    const html = renderToStaticMarkup(
      <MainModelPicker providers={providers} current="gone/model" onSave={async () => {}} />,
    );
    // An unavailable current model isn't preselected: the first signed-in model is.
    expect(html).toContain('value="openai/gpt-x" selected=""');
  });

  it("lists profiles with their pool, default and bots", () => {
    const html = renderToStaticMarkup(
      <ProfilesPanel
        profiles={profiles}
        bots={bots}
        providers={providers}
        onSave={async () => {}}
        onDelete={noop}
        onSetDefault={noop}
      />,
    );
    expect(html).toContain('Default<span class="badge">Default</span>');
    expect(html).toContain("openai/gpt-x (background)");
    expect(html).toContain("Used by Admin Bot");
    expect(html).toContain("Delete profile Fast");
    expect(html).not.toContain("Delete profile Default");
    expect(html).toContain("New profile");
  });

  it("edits a profile's main model, pool notes and guidance", () => {
    const html = renderToStaticMarkup(
      <ProfileEditor
        profile={profiles[1]}
        providers={providers}
        onSave={async () => {}}
        onCancel={noop}
      />,
    );
    expect(html).toContain("gone/model (not signed in)");
    expect(html).toContain("Be quick.");
    expect(html).toContain("Add pool model");
    expect(html).not.toContain("Can&#x27;t be changed");
    // Folding sections, each with a one-line summary; only the main model starts open.
    const sections = [...html.matchAll(/<details class="profile-section"( open="")?>/g)];
    expect(sections.map((match) => match[1] !== undefined)).toEqual([true, false, false, false]);
    for (const summary of ["gone/model", "None, the bot pauses", "Be quick."]) {
      expect(html).toContain(`<span class="profile-section-summary">${summary}</span>`);
    }
    const fresh = renderToStaticMarkup(
      <ProfileEditor providers={providers} onSave={async () => {}} onCancel={noop} />,
    );
    expect(fresh).toContain("Can&#x27;t be changed");
    expect(fresh).toContain("Create profile");
  });

  it("keeps account notes as guidance", () => {
    const html = renderToStaticMarkup(<AccountNotes notes="Codex $200" onSave={async () => {}} />);
    expect(html).toContain("Codex $200");
    expect(html).toContain("Guidance, not hard limits");
  });
});

describe("onboarding", () => {
  const client = new PiBotClient("ws://127.0.0.1:9/ws");
  const status = {
    adminId: "admin",
    profileId: "default",
    mainModel: "openai/gpt-x",
    mainModelAvailable: false,
    signedIn: true,
    needed: true,
  };
  it("asks to sign in before picking a model", () => {
    const html = renderToStaticMarkup(
      <Onboarding
        client={client}
        connected={false}
        status={{ ...status, signedIn: false }}
        onStatus={noop}
      />,
    );
    expect(html).toContain("Sign in to a provider");
    expect(html).toMatch(/aria-current="step"[^>]*>.*Sign in</);
    expect(html).not.toContain("Choose Admin Bot");
  });
  it("offers the main-model step once signed in", () => {
    const html = renderToStaticMarkup(
      <Onboarding client={client} connected={false} status={status} onStatus={noop} />,
    );
    expect(html).toContain("Choose Admin Bot&#x27;s model");
    expect(html).toMatch(/aria-current="step"[^>]*>.*Choose a model</);
    expect(html).not.toContain("Sign in to a provider");
  });
});
