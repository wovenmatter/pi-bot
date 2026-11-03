import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PiBotClient } from "../src/api.ts";
import { Onboarding } from "../src/features/Onboarding.tsx";
import { AccountNotes } from "../src/features/settings/Accounts.tsx";
import { BotsPanel, placementOf, roleOf } from "../src/features/settings/Bots.tsx";
import {
  MainModelPicker,
  ProfileEditor,
  ProfilesPanel,
  priceText,
  priceTierTexts,
  toDraft,
  toInput,
  usd,
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
  orchestrator: false,
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
        onCreate={async () => {}}
        onDelete={noop}
      />,
    );
    const order = ["Admin Bot", "Lead", "Member", "Loose"].map((name) => html.indexOf(`>${name}<`));
    expect(order.every((at, i) => at > 0 && (i === 0 || at > (order[i - 1] ?? 0)))).toBe(true);
    expect(html).not.toContain("Delete Admin Bot");
    expect(html).toContain("Delete Lead");
    expect(html).toMatch(
      /<img class="brand-mark" src="data:image\/svg\+xml[^"]*%23F09082[^"]*%23F1BE58[^"]*" alt="" aria-hidden="true"\/>/,
    );
    expect(html).not.toContain(">π<");
    const adminLink = html.slice(html.lastIndexOf("<a", html.indexOf(">Admin Bot<")));
    expect(adminLink.slice(0, adminLink.indexOf("</a>"))).toContain("lucide-sliders-horizontal");
    expect(html).not.toContain("lucide-shield");
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

describe("orchestrator", () => {
  const withOrchestrator = [
    bot("loose"),
    bot("lead", { manager: true }),
    bot("chief", { orchestrator: true, manager: true }),
    bots[2] as BotSummary,
    bot("member", { managerId: "lead" }),
    bot("aide", { managerId: "chief" }),
  ];

  it("groups the orchestrator after Admin Bot with its own team, apart from other teams", () => {
    const groups = groupBots(withOrchestrator);
    expect(groups.orchestrator?.bot.id).toBe("chief");
    expect(groups.orchestrator?.members.map((m) => m.id)).toEqual(["aide"]);
    expect(groups.teams.map((t) => t.manager.id)).toEqual(["lead"]);
    expect(groups.ungrouped.map((b) => b.id)).toEqual(["loose"]);
    expect(groupBots(bots).orchestrator).toBeUndefined();
  });

  it("sidebar lists the orchestrator right after Admin Bot with a small label", () => {
    const html = renderToStaticMarkup(
      <Sidebar
        bots={withOrchestrator}
        botId="admin"
        conversationId={undefined}
        mainConversationId={undefined}
        settings={false}
        connection="open"
        onCreate={async () => {}}
        onDelete={noop}
      />,
    );
    const order = ["Admin Bot", "Chief", "Aide", "Lead", "Member", "Loose"].map((name) =>
      html.indexOf(`>${name}<`),
    );
    expect(order.every((at, i) => at > 0 && (i === 0 || at > (order[i - 1] ?? 0)))).toBe(true);
    expect(html.match(/class="badge">Orchestrator</g)).toHaveLength(1);
    expect(html.indexOf("Orchestrator<")).toBeGreaterThan(html.indexOf(">Chief<"));
    expect(html.indexOf("Orchestrator<")).toBeLessThan(html.indexOf(">Aide<"));
  });

  it("bots panel sets the orchestrator, lists it first with its team and keeps it off other teams", () => {
    const html = renderToStaticMarkup(
      <BotsPanel
        bots={withOrchestrator}
        profiles={profiles}
        onSetProfile={noop}
        onPlace={noop}
        onReplaceManager={noop}
        onSetOrchestrator={noop}
        onRename={noop}
      />,
    );
    const picker = html.slice(html.indexOf('aria-label="Orchestrator"'), html.indexOf("</select>"));
    expect(picker).toContain(">None<");
    expect(picker).toContain('value="chief" selected=""');
    expect(picker).not.toContain("Admin Bot");
    const rows = ["Chief", "Aide", "Lead", "Member", "Loose", "Admin Bot"].map((name) =>
      html.indexOf(`<strong>${name}`),
    );
    expect(rows.every((at, i) => at > 0 && (i === 0 || at > (rows[i - 1] ?? 0)))).toBe(true);
    expect(html).toContain('<strong>Chief<span class="badge">Orchestrator</span></strong>');
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
        onSetOrchestrator={noop}
        onRename={noop}
      />,
    );
    expect(none).toContain('<option value="" selected="">None</option>');
    expect(none).not.toContain('class="badge">Orchestrator');
  });

  it("labels every bot's role apart from its name and offers rename to all but Admin Bot", () => {
    const html = renderToStaticMarkup(
      <BotsPanel
        bots={withOrchestrator}
        profiles={profiles}
        onSetProfile={noop}
        onPlace={noop}
        onReplaceManager={noop}
        onSetOrchestrator={noop}
        onRename={noop}
      />,
    );
    const role = (name: string) =>
      html.match(new RegExp(`<strong>${name}<span class="badge">(\\w+)<`))?.[1];
    expect(["Admin Bot", "Chief", "Lead", "Member", "Loose"].map(role)).toEqual([
      "Admin",
      "Orchestrator",
      "Manager",
      "Bot",
      "Bot",
    ]);
    expect(withOrchestrator.map(roleOf)).toEqual([
      "Bot",
      "Manager",
      "Orchestrator",
      "Admin",
      "Bot",
      "Bot",
    ]);
    expect(html).not.toContain("Rename Admin Bot");
    for (const name of ["Chief", "Lead", "Member", "Loose", "Aide"]) {
      expect(html).toContain(`aria-label="Rename ${name}"`);
    }
    expect(html).toContain('<option value="manager">Manager</option>');
    expect(html).not.toMatch(/top bot|Leads a team/i);
  });
});

describe("bots panel", () => {
  const panel = (list: BotSummary[], children?: ReactNode) =>
    renderToStaticMarkup(
      <BotsPanel
        bots={list}
        profiles={profiles}
        onSetProfile={noop}
        onPlace={noop}
        onReplaceManager={noop}
        onSetOrchestrator={noop}
        onRename={noop}
      >
        {children}
      </BotsPanel>,
    );
  const rowOf = (html: string, name: string) => {
    const at = html.indexOf(`<strong>${name}<`);
    return html.slice(html.lastIndexOf("<li", at), at);
  };

  it("lists teams with members nested under their manager, then Admin Bot after a separator", () => {
    const html = panel(bots);
    const order = ["Lead", "Member", "Loose", "Admin Bot"].map((name) =>
      html.indexOf(`<strong>${name}<`),
    );
    expect(order.every((at, i) => at > 0 && (i === 0 || at > (order[i - 1] ?? 0)))).toBe(true);
    expect(rowOf(html, "Member")).toContain('class="bot-row bot-member"');
    for (const name of ["Lead", "Loose", "Admin Bot"]) {
      expect(rowOf(html, name)).toContain('class="bot-row"');
    }
    const separators = [...html.matchAll(/<hr class="bots-separator"\/>/g)].map((m) => m.index);
    expect(separators).toHaveLength(1);
    expect(separators[0]).toBeGreaterThan(html.indexOf("<strong>Loose<"));
    expect(separators[0]).toBeLessThan(html.indexOf("<strong>Admin Bot<"));
  });

  it("nests the orchestrator's own team under it", () => {
    const html = panel([
      bot("loose"),
      bot("chief", { orchestrator: true, manager: true }),
      bots[2] as BotSummary,
      bot("aide", { managerId: "chief" }),
    ]);
    expect(html.indexOf("<strong>Chief<")).toBeLessThan(html.indexOf("<strong>Aide<"));
    expect(html.indexOf("<strong>Aide<")).toBeLessThan(html.indexOf("<strong>Loose<"));
    expect(rowOf(html, "Aide")).toContain('class="bot-row bot-member"');
    expect(rowOf(html, "Chief")).toContain('class="bot-row"');
  });

  it("puts the deleted bots after Admin Bot behind a second separator", () => {
    const html = panel(bots, <p>Deleted list</p>);
    const separators = [...html.matchAll(/<hr class="bots-separator"\/>/g)].map(
      (m) => m.index ?? 0,
    );
    expect(separators).toHaveLength(2);
    expect(separators[1]).toBeGreaterThan(html.indexOf("<strong>Admin Bot<"));
    expect(separators[1]).toBeLessThan(html.indexOf("Deleted list"));
  });

  it("maps bots to placements and keeps Admin Bot off teams", () => {
    expect(bots.map(placementOf)).toEqual(["none", "manager", "none", "lead"]);
    const html = renderToStaticMarkup(
      <BotsPanel
        bots={bots}
        profiles={profiles}
        onSetProfile={noop}
        onPlace={noop}
        onReplaceManager={noop}
        onSetOrchestrator={noop}
        onRename={noop}
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
        onSetOrchestrator={noop}
        onRename={noop}
      />,
    );
    expect(html).toContain("Profile for Admin Bot");
    expect(html).toContain('<option value="">Default (Default)</option>');
    expect(html).toContain('value="fast" selected=""');
    expect(html).not.toContain("Model profiles");
  });
});

const SOURCE = "pi-ai 1.5.0 bundled openai catalog, generated 2026-11-02";
const providers: ProviderModels[] = [
  {
    id: "openai",
    name: "OpenAI",
    access: { kind: "api_key", label: "OpenAI API key" },
    models: [
      {
        id: "gpt-x",
        name: "GPT X",
        reasoning: true,
        contextWindow: 272_000,
        maxTokens: 128_000,
        input: ["text", "image"],
        pricing: {
          status: "listed",
          rates: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
          tiers: [
            { inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 },
          ],
          source: SOURCE,
        },
        limit: { kind: "weekly", label: "weekly limit", account: "OpenAI API key" },
      },
      {
        id: "gpt-free",
        name: "GPT Free",
        reasoning: false,
        contextWindow: 1,
        pricing: { status: "zero", source: SOURCE },
      },
      { id: "gpt-old", name: "GPT Old", reasoning: false, contextWindow: 1 },
    ],
  },
];
const profiles: ProfileSummary[] = [
  {
    id: "default",
    name: "Default",
    main: "openai/gpt-x",
    pool: [{ model: "openai/gpt-free", useFor: "Lookups" }],
    default: true,
  },
  {
    id: "fast",
    name: "Fast",
    main: "gone/model",
    memoryModel: "openai/gpt-free",
    guidance: "Be quick.",
    pool: [],
  },
];

const POOL_COPY =
  "Additional models available for subagents. The main model can always spawn subagents using itself, even when this list is empty.";
const PREFERENCES_COPY =
  "Describe your preferences and experiences with these models. The main model uses this guidance when choosing models for subagents.";

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

  it("lists profiles with their model pool, memory model, default and bots", () => {
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
    expect(html).toContain("Model pool: main model + openai/gpt-free");
    expect(html).toContain("Model pool: main model only");
    expect(html).toContain("Memory extraction: active main model");
    expect(html).toContain("Memory extraction: openai/gpt-free");
    expect(html).not.toMatch(/background/i);
    expect(html).toContain("Used by Admin Bot");
    expect(html).toContain("Delete profile Fast");
    expect(html).not.toContain("Delete profile Default");
    expect(html).toContain("New profile");
  });

  it("edits main model, memory extraction, model pool and model preferences", () => {
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
    expect(sections.map((match) => match[1] !== undefined)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    const titles = [...html.matchAll(/<span class="profile-section-title">([^<]+)<\/span>/g)].map(
      (match) => match[1],
    );
    expect(titles).toEqual([
      "Main model",
      "Fallbacks",
      "Memory extraction",
      "Model pool",
      "Model preferences",
    ]);
    for (const summary of [
      "gone/model",
      "None, the bot pauses",
      "openai/gpt-free",
      "Main model only",
      "Be quick.",
    ]) {
      expect(html).toContain(`<span class="profile-section-summary">${summary}</span>`);
    }
    expect(html).toContain(POOL_COPY);
    expect(html).toContain(PREFERENCES_COPY);
    expect(html).toContain(
      "Reviews new conversation messages and saves useful facts into the bot&#x27;s memory, on the extraction schedule and when the bot goes idle, if memory extraction is enabled. Doesn&#x27;t affect chat or subagents.",
    );
    // The memory model choice offers the active main model explicitly.
    expect(html).toContain('<option value="">Use active main model</option>');
    expect(html).toContain('value="openai/gpt-free" selected=""');
    expect(html.toLowerCase()).not.toContain("model helpers");
    expect(html).not.toMatch(/background/i);
    expect(html).not.toContain("Guidance");

    const fresh = renderToStaticMarkup(
      <ProfileEditor providers={providers} onSave={async () => {}} onCancel={noop} />,
    );
    expect(fresh).toContain("Can&#x27;t be changed");
    expect(fresh).toContain("Create profile");
    // A new profile extracts memory on the active main model unless told otherwise.
    expect(fresh).toContain('<span class="profile-section-summary">Use active main model</span>');
  });

  it("keeps each model's full metadata inside a collapsed disclosure", () => {
    const html = renderToStaticMarkup(
      <ProfileEditor
        profile={{
          ...profiles[0],
          pool: [
            { model: "openai/gpt-free", useFor: "Lookups" },
            { model: "openai/gpt-old", useFor: "" },
            { model: "gone/model", useFor: "" },
          ],
        }}
        providers={providers}
        onSave={async () => {}}
        onCancel={noop}
      />,
    );
    expect(html).toContain("Main model <code>openai/gpt-x</code>");
    expect(html).toContain(
      "$2 in · $10 out · $0.2 cache read · $2.5 cache write per 1M tokens (other rates above set input sizes) · 272k context · 128k max output · text, image · reasoning · OpenAI API key · weekly limit, reset unknown",
    );
    // Metadata is present for inspection, but all four model disclosures start closed.
    const metadata = [...html.matchAll(/<details class="profile-model-facts"( open="")?>/g)];
    expect(metadata).toHaveLength(4);
    expect(metadata.every((match) => match[1] === undefined)).toBe(true);
    expect(html).toContain('<summary aria-label="Model details for GPT X">Model details</summary>');
    expect(html).toContain(
      "Above 272k input tokens: $4 in · $15 out · $0.4 cache read · $5 cache write per 1M tokens",
    );
    expect(html).not.toContain("higher");
    expect(html).toContain("API price listed as $0 (free or unpriced)");
    expect(html).toContain("API price unknown");
    expect(html).toContain("Not signed in: no catalog details");
    expect(html).toContain(`Source: ${SOURCE}.`);
    expect(html).toContain(
      "Prices are raw API list prices in USD: a relative cost signal, also for subscription models, not an exact measure of a subscription&#x27;s allowance or charges.",
    );
    expect(priceText(undefined)).toBe("API price unknown");
  });

  it("keeps tiny prices and makes no assumption about tier direction", () => {
    expect(usd(0.000001)).toBe("$0.000001");
    expect(usd(2.5)).toBe("$2.5");
    expect(usd(0)).toBe("$0");
    const cheaperTier = {
      status: "listed" as const,
      rates: { input: 0.000001, output: 2, cacheRead: 0, cacheWrite: 0 },
      tiers: [
        { inputTokensAbove: 1_000_000, input: 0.0000005, output: 1, cacheRead: 0, cacheWrite: 0 },
      ],
      source: SOURCE,
    };
    expect(priceText(cheaperTier)).toBe(
      "$0.000001 in · $2 out · $0 cache read · $0 cache write per 1M tokens (other rates above set input sizes)",
    );
    expect(priceTierTexts(cheaperTier)).toEqual([
      "Above 1M input tokens: $0.0000005 in · $1 out · $0 cache read · $0 cache write per 1M tokens",
    ]);
    expect(priceTierTexts({ status: "zero", source: SOURCE })).toEqual([]);
  });

  it("round-trips a profile through the editor draft", () => {
    const profile: ProfileSummary = {
      id: "p",
      name: "P",
      main: "openai/gpt-x",
      fallbacks: ["openai/gpt-old"],
      memoryModel: "openai/gpt-free",
      guidance: "Opus writes nicer code. Sol is thorough. Check Astra's work.",
      pool: [{ model: "openai/gpt-free", useFor: "Lookups" }],
    };
    expect(toInput(toDraft(profile))).toEqual({
      id: "p",
      name: "P",
      main: "openai/gpt-x",
      fallbacks: ["openai/gpt-old"],
      memoryModel: "openai/gpt-free",
      guidance: "Opus writes nicer code. Sol is thorough. Check Astra's work.",
      pool: [{ model: "openai/gpt-free", useFor: "Lookups" }],
    });
    // "Use active main model" sends no memory model.
    const plain = toInput(toDraft({ ...profile, memoryModel: undefined, pool: [] }));
    expect(plain).not.toHaveProperty("memoryModel");
    expect(plain.pool).toEqual([]);
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
    expect(html).toMatch(
      /<img class="brand-mark onboarding-mark" src="data:image\/svg\+xml[^"]*%23F09082/,
    );
    expect(html).not.toMatch(/>\s*π\s*</);
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
