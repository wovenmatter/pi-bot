import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PiBotClient } from "../src/api.ts";
import { Onboarding } from "../src/features/Onboarding.tsx";
import {
  AccountNotes,
  BotProfilesPanel,
  MainModelPicker,
  ProfileEditor,
  ProfilesPanel,
} from "../src/features/settings/Profiles.tsx";
import { placementOf, TeamsPanel } from "../src/features/settings/Teams.tsx";
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
});

describe("teams panel", () => {
  it("maps bots to placements and hides Admin Bot", () => {
    expect(bots.map(placementOf)).toEqual(["none", "manager", "none", "lead"]);
    const html = renderToStaticMarkup(
      <TeamsPanel bots={bots} onPlace={noop} onReplaceManager={noop} />,
    );
    expect(html).not.toContain("Team for Admin Bot");
    expect(html).toContain("Team: Member");
    expect(html).toContain("On Lead&#x27;s team");
    expect(html).toContain("Hand Lead&#x27;s team to");
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
    expect(html).toContain('Default<small class="muted"> · default</small>');
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
    const fresh = renderToStaticMarkup(
      <ProfileEditor providers={providers} onSave={async () => {}} onCancel={noop} />,
    );
    expect(fresh).toContain("Can&#x27;t be changed");
    expect(fresh).toContain("Create profile");
  });

  it("picks a profile per bot, with the default as the empty choice", () => {
    const html = renderToStaticMarkup(
      <BotProfilesPanel bots={bots} profiles={profiles} onSet={noop} />,
    );
    expect(html).toContain("Profile for Admin Bot");
    expect(html).toContain('<option value="">Default (Default)</option>');
    expect(html).toContain('value="fast" selected=""');
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
