import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsNav } from "../src/features/Settings.tsx";
import { AccountsList } from "../src/features/settings/Accounts.tsx";
import {
  ConfigEditor,
  LimitsForm,
  limitEdits,
  RestartSection,
} from "../src/features/settings/Config.tsx";
import { GitHubSettings } from "../src/features/settings/GitHub.tsx";
import { LoginPanel, loginView } from "../src/features/settings/Login.tsx";
import { TitleModelSettings } from "../src/features/settings/Models.tsx";
import { SearchSettings } from "../src/features/settings/Search.tsx";
import { RestartNotice } from "../src/features/settings/shared.tsx";
import type { AccountStatus, EffectiveConfig, LoginEvent } from "../src/protocol.ts";
import { parseRoute, routeHref } from "../src/routes.ts";

const noop = () => {};
const actions = {
  onSaveKey: async () => true,
  onRemove: noop,
  onSignIn: noop,
  onRespond: noop,
  onCancelLogin: noop,
  onCloseLogin: noop,
};

const accounts: AccountStatus[] = [
  {
    id: "openai-codex",
    provider: "openai-codex",
    group: "OpenAI",
    label: "ChatGPT subscription",
    method: "oauth",
    help: "Sign in with ChatGPT.",
    configured: false,
  },
  {
    id: "openai",
    provider: "openai",
    group: "OpenAI",
    label: "OpenAI API key",
    method: "api_key",
    help: "From platform.openai.com.",
    configured: true,
    detail: "Key ••••ABCD",
  },
  {
    id: "openrouter",
    provider: "openrouter",
    group: "OpenRouter",
    label: "OpenRouter",
    method: "api_key",
    help: "From openrouter.ai.",
    configured: true,
    ambient: true,
    detail: "From OPENROUTER_API_KEY",
  },
];

describe("Settings sections", () => {
  it("routes each section and keeps #/settings for the first one", () => {
    expect(parseRoute("#/settings/github")).toEqual({ settings: true, section: "github" });
    expect(parseRoute("#/settings/profiles")).toEqual({ settings: true, section: "profiles" });
    // The old Models tab folded into Profiles; its links still land there.
    expect(parseRoute("#/settings/models")).toEqual({ settings: true, section: "profiles" });
    expect(parseRoute("#/settings/nope")).toEqual({ settings: true });
    expect(parseRoute("#/settings/toString")).toEqual({ settings: true });
    expect(routeHref({ settings: true, section: "accounts" })).toBe("#/settings");
    expect(routeHref({ settings: true, section: "config" })).toBe("#/settings/config");
    const nav = renderToStaticMarkup(<SettingsNav section="search" />);
    const labels = [...nav.matchAll(/<a [^>]*>([^<]+)<\/a>/g)].map((match) => match[1]);
    expect(labels).toEqual(["Accounts", "Profiles", "Bots", "Search", "GitHub", "Config"]);
    expect(nav).toContain('href="#/settings/search" class="active" aria-current="page"');
  });

  it("groups accounts, masks keys and never prefills key inputs", () => {
    const html = renderToStaticMarkup(<AccountsList accounts={accounts} actions={actions} />);
    expect(html).toContain("<h3>OpenAI</h3>");
    expect(html).toContain("Key ••••ABCD");
    expect(html).toContain("Not signed in");
    expect(html).toContain(">Sign in<");
    expect(html).toContain('type="password"');
    expect(html).not.toMatch(/type="password"[^>]*value="[^"]/);
    expect(html).toContain('aria-label="Remove OpenAI API key"');
    // Environment credentials can't be removed from here.
    expect(html).toContain("From OPENROUTER_API_KEY");
    expect(html).not.toContain('aria-label="Remove OpenRouter"');
    // Short help stays inline; long provider instructions fold under "How it works".
    expect(html).not.toContain("How it works");
    const long = "Open the sign-in page on any device, approve, then paste the code it shows here.";
    const folded = renderToStaticMarkup(
      <AccountsList
        accounts={[{ ...(accounts[0] as AccountStatus), help: `${long} ${long}` }]}
        actions={actions}
      />,
    );
    expect(folded).toContain("<summary>How it works</summary>");
    expect(folded).toContain(long);
  });

  it("shows the sign-in link, device code and the open prompt", () => {
    const events: LoginEvent[] = [
      {
        kind: "device_code",
        userCode: "ABCD-1234",
        verificationUri: "https://auth.example/device",
      },
      { kind: "auth_url", url: "https://auth.example/authorize?x=1", instructions: "Sign in." },
      {
        kind: "prompt",
        promptId: "p1",
        prompt: { type: "manual_code", message: "Paste the redirect URL" },
      },
    ];
    const login = { loginId: "l1", accountId: "openai-codex", label: "ChatGPT", events };
    const html = renderToStaticMarkup(
      <LoginPanel login={login} onRespond={noop} onCancel={noop} onClose={noop} />,
    );
    expect(html).toContain("ABCD-1234");
    expect(html).toContain('href="https://auth.example/device"');
    expect(html).toContain('href="https://auth.example/authorize?x=1"');
    expect(html).toContain("Paste the redirect URL");
    expect(html).toContain('aria-label="Cancel sign-in"');

    expect(
      loginView([...events, { kind: "prompt_closed", promptId: "p1" }]).prompt,
    ).toBeUndefined();
    expect(loginView([...events, { kind: "done" }])).toMatchObject({ status: "done" });
    const failed = renderToStaticMarkup(
      <LoginPanel
        login={{ ...login, events: [{ kind: "error", message: "Sign-in cancelled" }] }}
        onRespond={noop}
        onCancel={noop}
        onClose={noop}
      />,
    );
    expect(failed).toContain("Sign-in cancelled");
    expect(failed).toContain('aria-label="Close"');
  });

  it("renders select prompts as choices", () => {
    const html = renderToStaticMarkup(
      <LoginPanel
        login={{
          loginId: "l1",
          accountId: "openai-codex",
          label: "ChatGPT",
          events: [
            {
              kind: "prompt",
              promptId: "p1",
              prompt: {
                type: "select",
                message: "How do you want to sign in?",
                options: [
                  { id: "device", label: "Device code" },
                  { id: "browser", label: "Browser" },
                ],
              },
            },
          ],
        }}
        onRespond={noop}
        onCancel={noop}
        onClose={noop}
      />,
    );
    expect(html).toContain("Device code");
    expect(html).toContain("Browser");
  });

  it("offers the global title model from signed-in providers", () => {
    const html = renderToStaticMarkup(
      <TitleModelSettings
        providers={[
          {
            id: "openai",
            name: "OpenAI",
            models: [{ id: "gpt-x", name: "GPT X", reasoning: true, contextWindow: 200_000 }],
          },
        ]}
        roles={{ titles: "gone/model", titlesReasoning: "high" }}
        reasoningLevels={["low", "high"]}
        onSave={async () => {}}
      />,
    );
    expect(html).toContain("Names threads");
    expect(html).not.toContain("Background");
    expect(html).toContain('value="openai/gpt-x"');
    expect(html).toContain("gone/model (not signed in)");
    expect(html).toContain("200k context");
  });

  it("shows search keys masked and the default provider", () => {
    const html = renderToStaticMarkup(
      <SearchSettings
        search={{
          provider: "brave",
          providers: [
            { ...accounts[1], id: "exa", label: "Exa", configured: false } as AccountStatus,
            { ...accounts[1], id: "brave", label: "Brave Search" } as AccountStatus,
          ],
        }}
        onSetDefault={noop}
        onSaveKey={async () => true}
        onRemove={noop}
      />,
    );
    expect(html).toMatch(/aria-checked="true"[^>]*>Brave Search</);
    expect(html).toContain("Key ••••ABCD");
  });

  it("shows only the public half of the GitHub SSH key and the git identity", () => {
    const html = renderToStaticMarkup(
      <GitHubSettings
        status={{
          sshKey: {
            type: "ssh-ed25519",
            publicKey: "ssh-ed25519 AAAAC3Nza pi-bot",
            fingerprint: "SHA256:abc",
            comment: "pi-bot",
          },
          identity: { name: "Pi Bot", email: "bot@example.com" },
        }}
        onGenerate={async () => {}}
        onPaste={async () => true}
        onRemove={noop}
        onSaveIdentity={async () => true}
      />,
    );
    expect(html).toContain("ssh-ed25519 AAAAC3Nza pi-bot");
    expect(html).toContain("SHA256:abc");
    expect(html).toContain('value="Pi Bot"');
    expect(html).toContain("Replace with a new key");
    expect(html).not.toContain("PRIVATE KEY-----\n");
    const empty = renderToStaticMarkup(
      <GitHubSettings
        status={{ identity: {} }}
        onGenerate={async () => {}}
        onPaste={async () => true}
        onRemove={noop}
        onSaveIdentity={async () => true}
      />,
    );
    expect(empty).toContain("No SSH key stored.");
    expect(empty).toContain("Generate a key");
  });

  it("edits limits as config edits and shows validation errors", () => {
    const effective: EffectiveConfig = {
      bot_to_bot: { max_rounds_per_request: 5, max_messages_per_hour_per_pair: 30 },
      extraction: { schedule: "0 3 * * *", timezone: "UTC" },
      search: { provider: "exa" },
      git: {},
    };
    const html = renderToStaticMarkup(
      <LimitsForm effective={effective} onSave={async () => true} />,
    );
    expect(html).toContain('value="0 3 * * *"');
    expect(html).toContain('value="30"');
    const before = { maxRounds: "5", maxMessages: "30", schedule: "0 3 * * *", timezone: "UTC" };
    expect(
      limitEdits(before, { ...before, maxRounds: "7", timezone: " America/New_York " }),
    ).toEqual([
      { path: ["bot_to_bot", "max_rounds_per_request"], value: 7 },
      { path: ["extraction", "timezone"], value: "America/New_York" },
    ]);
    expect(limitEdits(before, { ...before, maxMessages: "lots" })).toEqual([
      { path: ["bot_to_bot", "max_messages_per_hour_per_pair"], value: "lots" },
    ]);

    const editor = renderToStaticMarkup(
      <ConfigEditor
        path="/home/me/.config/pi-bot/config.toml"
        text={'[models]\norchestrator = "x"'}
        validation={{ ok: false, error: "models.orchestrator: expected provider/model" }}
        onChange={noop}
        onValidate={noop}
        onSave={noop}
      />,
    );
    expect(editor).toContain("models.orchestrator: expected provider/model");
    expect(editor).toContain('role="alert"');
    const idle = { phase: "idle" } as const;
    const pending = renderToStaticMarkup(<RestartNotice show state={idle} onRestart={noop} />);
    expect(pending).toContain("Restart Pi Bot to apply");
    expect(pending).toContain("Restart and apply");
    expect(renderToStaticMarkup(<RestartNotice show={false} state={idle} onRestart={noop} />)).toBe(
      "",
    );
    // Config → Restart offers a restart at any time, apart from the editors.
    const section = renderToStaticMarkup(<RestartSection restarting={false} onRestart={noop} />);
    expect(section).toContain("Restart Pi Bot");
    expect(section).not.toContain("disabled");
    expect(renderToStaticMarkup(<RestartSection restarting onRestart={noop} />)).toContain(
      "Restarting…",
    );
    // The raw file editor sits in its own folded section.
    expect(editor).toContain("<summary><span>Edit the file</span></summary>");
  });

  it("shows restart progress, the server coming back and a stuck restart", () => {
    const restarting = renderToStaticMarkup(
      <RestartNotice
        show
        state={{ phase: "restarting", activeWork: 2, mode: "reload", dropped: false }}
        onRestart={noop}
      />,
    );
    expect(restarting).toContain("Restarting Pi Bot");
    expect(restarting).toContain("2 running turns finish");
    expect(restarting).not.toContain("Restart and apply");
    expect(
      renderToStaticMarkup(
        <RestartNotice
          show={false}
          state={{ phase: "restarting", activeWork: 0, mode: "exit", dropped: true }}
          onRestart={noop}
        />,
      ),
    ).toContain("service manager");
    expect(
      renderToStaticMarkup(
        <RestartNotice show={false} state={{ phase: "back" }} onRestart={noop} />,
      ),
    ).toContain("Pi Bot is back");
    const failed = renderToStaticMarkup(
      <RestartNotice
        show
        state={{ phase: "failed", message: "Pi Bot has not come back yet." }}
        onRestart={noop}
      />,
    );
    expect(failed).toContain("has not come back");
    expect(failed).toContain("Restart and apply");
  });

  it("offers the other sign-in methods and only explains localhost for redirect pastes", () => {
    const chatgpt: AccountStatus = {
      ...(accounts[0] as AccountStatus),
      loginMethods: [
        { id: "device_code", label: "Device code" },
        { id: "browser", label: "Browser, then paste the redirect URL" },
      ],
    };
    const row = renderToStaticMarkup(<AccountsList accounts={[chatgpt]} actions={actions} />);
    expect(row).toContain("Or sign in with");
    expect(row).toContain("Browser, then paste the redirect URL");
    expect(row).not.toContain(">Device code<");

    const claude = (placeholder: string) =>
      renderToStaticMarkup(
        <LoginPanel
          login={{
            loginId: "l2",
            accountId: "claude-oauth",
            label: "Claude",
            events: [
              { kind: "auth_url", url: "https://claude.ai/oauth/authorize?x=1" },
              {
                kind: "prompt",
                promptId: "p1",
                prompt: { type: "manual_code", message: "Paste the code", placeholder },
              },
            ],
          }}
          onRespond={noop}
          onCancel={noop}
          onClose={noop}
        />,
      );
    expect(claude("code#state")).not.toContain("localhost");
    expect(claude("http://localhost:1455/auth/callback")).toContain("localhost address");

    const failed = renderToStaticMarkup(
      <LoginPanel
        login={{
          loginId: "l3",
          accountId: "openai-codex",
          label: "ChatGPT",
          events: [{ kind: "error", message: "Device code login is not enabled" }],
        }}
        alternates={[{ id: "browser", label: "Browser, then paste the redirect URL" }]}
        onRespond={noop}
        onCancel={noop}
        onClose={noop}
        onRetry={noop}
      />,
    );
    expect(failed).toContain("Try instead");
    expect(failed).toContain("Browser, then paste the redirect URL");
  });
});
