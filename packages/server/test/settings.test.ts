import { execFileSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AuthResult, CredentialStore, Provider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PiBotApp, startPiBot } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { ServerMessage } from "../src/protocol.ts";
import type { AccountStatus, LoginEvent } from "../src/settings/service.ts";
import type { SshPublicKey } from "../src/settings/ssh-key.ts";
import { setTomlValues } from "../src/settings/toml-edit.ts";
import { echoModels, tempDir } from "./helpers.ts";
import { Client } from "./ws-client.ts";

describe("setTomlValues", () => {
  const doc = [
    "# Pi Bot",
    "[models]",
    'orchestrator = "openai/gpt-6-sol"   # main channel',
    'background = "openai/gpt-6-luna"',
    "",
    "[models.titles]",
    'model = "openai-codex/gpt-6-luna"',
    "",
    "[extraction]",
    'schedule = "0 3 * * *"',
    "",
  ].join("\n");

  it("replaces values in place and keeps comments", () => {
    const next = setTomlValues(doc, [
      { path: ["models", "orchestrator"], value: "xai/grok-5" },
      { path: ["models", "titles", "model"], value: "openai/gpt-6-luna" },
    ]);
    expect(next).toContain('orchestrator = "xai/grok-5"   # main channel');
    expect(next).toContain("# Pi Bot");
    expect(next).toContain('[models.titles]\nmodel = "openai/gpt-6-luna"');
  });

  it("inserts missing keys into their table and appends missing tables", () => {
    const next = setTomlValues(doc, [
      { path: ["models", "titles", "reasoning"], value: "low" },
      { path: ["bot_to_bot", "max_rounds_per_request"], value: 7 },
      { path: ["extraction", "timezone"], value: "America/New_York" },
    ]);
    const parsed = parseToml(next) as Record<string, Record<string, unknown>>;
    expect(parsed.models?.titles).toEqual({ model: "openai-codex/gpt-6-luna", reasoning: "low" });
    expect(parsed.bot_to_bot).toEqual({ max_rounds_per_request: 7 });
    expect(parsed.extraction).toEqual({ schedule: "0 3 * * *", timezone: "America/New_York" });
    expect(next).toContain('reasoning = "low"\n\n[extraction]');
  });

  it("falls back to re-serializing when a line edit can't reach the key", () => {
    const inline = 'models = { orchestrator = "a/b", background = "a/c" }\n';
    const next = setTomlValues(inline, [{ path: ["models", "background"], value: "x/y" }]);
    expect(parseToml(next)).toEqual({ models: { orchestrator: "a/b", background: "x/y" } });
  });

  it("rejects invalid TOML", () => {
    expect(() => setTomlValues("[models\n", [{ path: ["a", "b"], value: 1 }])).toThrow();
  });
});

const ACCESS = "fake-access-token-0001";
const OPENAI_KEY = "sk-test-openai-key-ABCD";

/** Key-only provider: configured by a stored key, or ambiently via `ambient`. */
function keyProvider(id: string, ambient?: string): Provider {
  const faux = fauxProvider({ provider: id, models: [{ id: `${id}-model`, name: `${id} model` }] });
  return {
    ...faux.provider,
    id,
    name: `Fake ${id}`,
    auth: {
      apiKey: {
        name: `${id} key`,
        async resolve({ credential }): Promise<AuthResult | undefined> {
          if (credential?.key) return { auth: { apiKey: credential.key }, source: "stored" };
          return ambient ? { auth: { apiKey: "ambient" }, source: ambient } : undefined;
        },
      },
    },
  };
}

/** ChatGPT-like OAuth: a method select, an auth URL, then a pasted redirect URL. */
function oauthProvider(): Provider {
  const faux = fauxProvider({
    provider: "openai-codex",
    models: [{ id: "gpt-fake", name: "GPT Fake", reasoning: true }],
  });
  return {
    ...faux.provider,
    id: "openai-codex",
    name: "Fake ChatGPT",
    auth: {
      oauth: {
        name: "Fake ChatGPT",
        async login(interaction) {
          const method = await interaction.prompt({
            type: "select",
            message: "How do you want to sign in?",
            options: [
              { id: "browser", label: "Browser" },
              { id: "device_code", label: "Device code" },
            ],
          });
          if (method === "device_code") {
            interaction.notify({
              type: "device_code",
              userCode: "ABCD-EFGH",
              verificationUri: "https://auth.example/device",
            });
            await new Promise<void>((_resolve, reject) =>
              interaction.signal.addEventListener("abort", () => reject(new Error("aborted"))),
            );
          }
          interaction.notify({ type: "auth_url", url: "https://auth.example/authorize?s=1" });
          const pasted = await interaction.prompt({
            type: "manual_code",
            message: "Paste the redirect URL",
          });
          if (!pasted.includes("code=good")) throw new Error("state mismatch");
          return {
            type: "oauth",
            access: ACCESS,
            refresh: "fake-refresh",
            expires: Date.now() + 3_600_000,
          };
        },
        async refresh(credential) {
          return credential;
        },
        async toAuth(credential) {
          return { apiKey: credential.access };
        },
      },
    },
  };
}

function settingsModels(credentials: CredentialStore) {
  const models = createModels({ credentials });
  models.setProvider(oauthProvider());
  models.setProvider(keyProvider("openai"));
  models.setProvider(keyProvider("openrouter", "OPENROUTER_API_KEY"));
  models.setProvider(keyProvider("claude-subscription"));
  return models;
}

describe("settings over the websocket", () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let app: PiBotApp;
  let client: Client;
  let credentials: CredentialStore;
  let configPath: string;

  beforeEach(async () => {
    dir = await tempDir();
    configPath = join(dir.path, "config.toml");
    await writeFile(
      configPath,
      [
        "# my settings",
        "[models]",
        'orchestrator = "faux/faux-1"   # main',
        'background = "faux/faux-1"',
        "[storage]",
        `data_dir = "${dir.path}"`,
        "",
      ].join("\n"),
      { mode: 0o640 },
    );
    app = await startPiBot(await loadConfig(configPath), {
      models: echoModels(15).models,
      settingsModels,
      port: 0,
      log: () => {},
    });
    credentials = app.credentials.store;
    client = await Client.open(`${app.server.url.replace("http", "ws")}/ws`);
  });

  afterEach(async () => {
    client.close();
    await app.close();
    await dir.cleanup();
  });

  const accounts = () =>
    client.request<{
      accounts: AccountStatus[];
      search: { provider: string; providers: AccountStatus[] };
    }>("settings.accounts");
  const account = async (id: string) =>
    (await accounts()).accounts.find((entry) => entry.id === id);

  it("stores keys write-only and shows only a masked hint", async () => {
    expect(await account("openai")).toMatchObject({ configured: false });
    expect(await account("openrouter")).toMatchObject({
      configured: true,
      ambient: true,
      detail: "From OPENROUTER_API_KEY",
    });

    await client.request("credentials.set", { accountId: "openai", key: `  ${OPENAI_KEY} ` });
    expect(await credentials.read("openai")).toEqual({ type: "api_key", key: OPENAI_KEY });
    expect(await account("openai")).toMatchObject({ configured: true, detail: "Key ••••ABCD" });
    // No response ever carries the stored key.
    expect(JSON.stringify(client.messages)).not.toContain(OPENAI_KEY.slice(0, 12));

    await client.request("credentials.set", { accountId: "exa", key: "exa-key-0000000000" });
    const { search } = await accounts();
    expect(search.provider).toBe("exa");
    expect(search.providers.find((entry) => entry.id === "exa")).toMatchObject({
      configured: true,
    });

    await client.request("credentials.remove", { accountId: "openai" });
    expect(await credentials.read("openai")).toBeUndefined();
  });

  it("validates keys and only accepts known slots", async () => {
    // Claude has one sign-in row now; the old long-lived-token key slot is gone.
    await expect(
      client.request("credentials.set", {
        accountId: "claude-subscription",
        key: "sk-ant-oat01-fake-token",
      }),
    ).rejects.toThrow(/no key slot/);
    await expect(
      client.request("credentials.set", { accountId: "claude-oauth", key: "sk-ant-oat01-x" }),
    ).rejects.toThrow(/no key slot/);
    await expect(
      client.request("credentials.set", { accountId: "openai", key: "two words" }),
    ).rejects.toThrow(/spaces/);
    await expect(
      client.request("credentials.set", { accountId: "somewhere-else", key: "abc" }),
    ).rejects.toThrow(/no key slot/);
    await expect(
      client.request("credentials.set", { accountId: "openai-codex", key: "abc" }),
    ).rejects.toThrow(/no key slot/);
  });

  it("lists providers in onboarding order with API keys folded under their sign-ins", async () => {
    const list = (await accounts()).accounts;
    expect(list.map((entry) => entry.id)).toEqual([
      "claude-oauth",
      "anthropic",
      "openai-codex",
      "openai",
      "xai-oauth",
      "xai",
      "openrouter",
      "opencode-go",
    ]);
    expect([...new Set(list.map((entry) => entry.group))]).toEqual([
      "Claude",
      "OpenAI",
      "Grok (xAI)",
      "OpenRouter",
      "OpenCode Go",
    ]);
    expect(
      Object.fromEntries(list.flatMap((e) => (e.alternateTo ? [[e.id, e.alternateTo]] : []))),
    ).toEqual({ anthropic: "claude-oauth", openai: "openai-codex", xai: "xai-oauth" });
    expect(list.filter((entry) => entry.group === "Claude" && entry.method === "oauth")).toEqual([
      expect.objectContaining({ id: "claude-oauth", signInLabel: "Sign in with Claude" }),
    ]);
  });

  it("shows the Claude row connected for any stored Claude token and signs it out", async () => {
    expect(await account("claude-oauth")).toMatchObject({ configured: false });
    const day = 24 * 3600_000;
    await credentials.modify("claude-subscription", async () => ({
      type: "oauth",
      access: "sk-ant-oat01-signed-in",
      refresh: "",
      expires: Date.now() + 300 * day,
    }));
    expect((await account("claude-oauth"))?.detail).toMatch(/^Signed in · token valid until/);
    await credentials.modify("claude-subscription", async () => ({
      type: "oauth",
      access: "sk-ant-oat01-signed-in",
      refresh: "",
      expires: Date.now() - day,
    }));
    expect((await account("claude-oauth"))?.detail).toMatch(/· sign in again$/);
    // A token saved from the CLI (`pi-bot set-key claude-subscription`) counts too.
    await credentials.modify("claude-subscription", async () => ({
      type: "api_key",
      key: "sk-ant-oat01-from-cli-WXYZ",
    }));
    expect(await account("claude-oauth")).toMatchObject({
      configured: true,
      detail: "Key ••••WXYZ",
    });
    await client.request("credentials.remove", { accountId: "claude-oauth" });
    expect(await credentials.read("claude-subscription")).toBeUndefined();
    expect(JSON.stringify(client.messages)).not.toContain("sk-ant-oat01-");
  });

  const loginEvents = (loginId: string) =>
    client.messages.flatMap((message) =>
      message.type === "login" && message.loginId === loginId ? [message.event] : [],
    );
  const waitLogin = <K extends LoginEvent["kind"]>(loginId: string, kind: K) =>
    client
      .waitFor(
        (message: ServerMessage) =>
          message.type === "login" && message.loginId === loginId && message.event.kind === kind,
      )
      .then(
        (message) =>
          (message as Extract<ServerMessage, { type: "login" }>).event as Extract<
            LoginEvent,
            { kind: K }
          >,
      );
  const promptAt = async (loginId: string, index: number) => {
    await client.waitFor(
      () => loginEvents(loginId).filter((event) => event.kind === "prompt").length > index,
    );
    return loginEvents(loginId).filter((event) => event.kind === "prompt")[index] as Extract<
      LoginEvent,
      { kind: "prompt" }
    >;
  };

  it("clears a provider's marked usage limits when its key is set or removed", async () => {
    const hour = { kind: "weekly", resetsAt: Date.now() + 3_600_000 } as const;
    app.availability.mark("openai/gpt-x", hour);
    app.availability.mark("openrouter/a/b", { kind: "credits" });
    await client.request("credentials.set", { accountId: "openai", key: OPENAI_KEY });
    expect(app.availability.available("openai/gpt-x")).toBe(true);
    // Other accounts keep theirs.
    expect(app.availability.available("openrouter/a/b")).toBe(false);
    app.availability.mark("openai/gpt-x", hour);
    await client.request("credentials.remove", { accountId: "openai" });
    expect(app.availability.available("openai/gpt-x")).toBe(true);
    await app.availability.flushed();
    expect((await app.manager.registry.limits()).map((row) => row.key)).toEqual(["openrouter/*"]);
  });

  it("runs a remote OAuth sign-in: chosen method, auth URL, pasted redirect", async () => {
    // A completed sign-in ends the account's marked limits.
    app.availability.mark("openai-codex/gpt-fake", { kind: "five_hour" });
    await expect(
      client.request("login.start", { accountId: "openai-codex", method: "nope" }),
    ).rejects.toThrow(/unknown sign-in method/);
    const { loginId } = await client.request<{ loginId: string }>("login.start", {
      accountId: "openai-codex",
      method: "browser",
    });
    expect((await waitLogin(loginId, "auth_url")).url).toBe("https://auth.example/authorize?s=1");
    // The method was picked up front: the provider's picker never reaches the browser.
    const paste = await promptAt(loginId, 0);
    expect(paste.prompt.type).toBe("manual_code");
    expect(app.availability.available("openai-codex/gpt-fake")).toBe(false);
    await client.request("login.respond", {
      loginId,
      promptId: paste.promptId,
      value: "http://localhost:1455/auth/callback?code=good&state=s",
    });
    await waitLogin(loginId, "done");
    expect(app.availability.available("openai-codex/gpt-fake")).toBe(true);
    expect(await credentials.read("openai-codex")).toMatchObject({ type: "oauth", access: ACCESS });
    expect((await account("openai-codex"))?.detail).toMatch(/^Signed in · token valid until/);
    expect(JSON.stringify(client.messages)).not.toContain(ACCESS);
  });

  it("reports failed and cancelled sign-ins", async () => {
    const first = await client.request<{ loginId: string }>("login.start", {
      accountId: "openai-codex",
      method: "browser",
    });
    const paste = await promptAt(first.loginId, 0);
    await client.request("login.respond", {
      loginId: first.loginId,
      promptId: paste.promptId,
      value: "garbage",
    });
    expect((await waitLogin(first.loginId, "error")).message).toBe("state mismatch");

    // Default method for ChatGPT is the device code (as in Woven Matter).
    const second = await client.request<{ loginId: string }>("login.start", {
      accountId: "openai-codex",
    });
    expect(await waitLogin(second.loginId, "device_code")).toMatchObject({ userCode: "ABCD-EFGH" });
    await client.request("login.cancel", { loginId: second.loginId });
    expect((await waitLogin(second.loginId, "error")).message).toBe("Sign-in cancelled");
    expect(await credentials.read("openai-codex")).toBeUndefined();

    await expect(client.request("login.start", { accountId: "openai" })).rejects.toThrow(
      /no sign-in/,
    );
    // Another connection can't drive someone else's sign-in.
    const third = await client.request<{ loginId: string }>("login.start", {
      accountId: "openai-codex",
    });
    const intruder = await Client.open(`${app.server.url.replace("http", "ws")}/ws`);
    await expect(intruder.request("login.cancel", { loginId: third.loginId })).rejects.toThrow(
      /unknown sign-in/,
    );
    intruder.close();
  });

  it("migrates legacy model roles to a default profile in config.toml", async () => {
    const text = await readFile(configPath, "utf8");
    expect(text).toContain("# my settings");
    expect(text).toContain("[profiles.default]");
    expect(text).toContain('main = "faux/faux-1"');
    expect(text).toContain('default_profile = "default"');
    expect(text).not.toContain("orchestrator =");
    expect((await stat(configPath)).mode & 0o777).toBe(0o640);
    expect(await readFile(`${configPath}.pre-profiles.bak`, "utf8")).toContain("orchestrator =");
  });

  it("onboards Admin Bot: needs an available main model, then sets it on its profile", async () => {
    type Status = {
      adminId: string;
      profileId: string;
      mainModel: string;
      mainModelAvailable: boolean;
      signedIn: boolean;
      needed: boolean;
    };
    const before = await client.request<Status>("onboarding.status");
    // OPENROUTER_API_KEY counts as signed in; faux/faux-1 is not a signed-in provider's model.
    expect(before).toMatchObject({
      signedIn: true,
      profileId: "default",
      mainModel: "faux/faux-1",
      mainModelAvailable: false,
      needed: true,
    });
    await expect(
      client.request("onboarding.setMainModel", { model: "openai/missing" }),
    ).rejects.toThrow(/unknown model/);
    await client.request("credentials.set", { accountId: "openai", key: OPENAI_KEY });
    await client.request("onboarding.setMainModel", { model: "openai/openai-model" });
    expect(await client.request<Status>("onboarding.status")).toEqual({
      adminId: before.adminId,
      profileId: "default",
      mainModel: "openai/openai-model",
      mainModelAvailable: true,
      signedIn: true,
      needed: false,
    });
    // Live: Admin Bot's main channel runs the new main model, no restart.
    const admin = await app.manager.get(before.adminId);
    const agent = await (await admin.main()).agent(BACKGROUND_CONTEXT);
    expect(agent.model).toEqual({ provider: "openai", modelId: "openai-model" });
    expect(await readFile(configPath, "utf8")).toContain('main = "openai/openai-model"');
  });

  it("manages profiles, bot assignments and account notes live", async () => {
    type List = {
      defaultId: string;
      profiles: { id: string; name: string; main: string; pool: unknown[] }[];
    };
    type Summary = { id: string; profileId: string; profileName: string; defaultProfile: boolean };
    const initial = await client.request<List>("profiles.list");
    expect(initial).toMatchObject({ defaultId: "default", profiles: [{ id: "default" }] });
    await expect(
      client.request("profiles.save", {
        create: true,
        profile: { id: "cheap", name: "Cheap", main: "openai/missing", pool: [] },
      }),
    ).rejects.toThrow(/unknown model/);
    await client.request("credentials.set", { accountId: "openai", key: OPENAI_KEY });
    const saved = await client.request<List>("profiles.save", {
      create: true,
      profile: {
        id: "cheap",
        name: "Cheap",
        main: "openai/openai-model",
        guidance: "Prefer low reasoning.",
        pool: [{ model: "openai/openai-model", useFor: "Summaries", background: true }],
      },
    });
    expect(saved.profiles.map((profile) => profile.id)).toEqual(["default", "cheap"]);
    await expect(
      client.request("profiles.save", {
        create: true,
        profile: { id: "cheap", name: "Again", main: "openai/openai-model", pool: [] },
      }),
    ).rejects.toThrow(/already exists/);

    const { bot } = await client.request<{ bot: Summary }>("bots.create", { name: "Worker" });
    expect(bot).toMatchObject({
      profileId: "default",
      profileName: "Default",
      defaultProfile: true,
    });
    const assigned = await client.request<{ bot: Summary }>("bots.setProfile", {
      botId: bot.id,
      profileId: "cheap",
    });
    expect(assigned.bot).toMatchObject({ profileId: "cheap", profileName: "Cheap" });
    const worker = await app.manager.get(bot.id);
    const model = async () => (await (await worker.main()).agent(BACKGROUND_CONTEXT)).model;
    expect(await model()).toEqual({ provider: "openai", modelId: "openai-model" });

    const text = await readFile(configPath, "utf8");
    expect(text).toContain("[profiles.cheap]");
    expect(text).toContain('[profiles.cheap.pool."openai/openai-model"]');
    expect(text).toContain("background = true");
    expect(text).toContain("# my settings");

    await expect(client.request("profiles.delete", { profileId: "default" })).rejects.toThrow(
      /cannot be deleted/,
    );
    await client.request("profiles.setDefault", { profileId: "cheap" });
    await client.request("profiles.setDefault", { profileId: "default" });
    const after = await client.request<List>("profiles.delete", { profileId: "cheap" });
    expect(after.profiles.map((profile) => profile.id)).toEqual(["default"]);
    // Its bots fall back to the default profile, live.
    const { bots } = await client.request<{ bots: Summary[] }>("bots.list");
    expect(bots.find((entry) => entry.id === bot.id)).toMatchObject({
      profileId: "default",
      defaultProfile: true,
    });
    expect(await model()).toEqual({ provider: "faux", modelId: "faux-1" });

    expect(await client.request("account.notes")).toEqual({ notes: "" });
    await client.request("account.setNotes", { notes: "ChatGPT Pro; ~$100/month on OpenRouter" });
    expect(await client.request("account.notes")).toMatchObject({
      notes: "ChatGPT Pro; ~$100/month on OpenRouter",
    });
  });

  it("lists models for signed-in providers and writes the title model to config.toml", async () => {
    let catalog = await client.request<{
      providers: { id: string; models: { id: string }[] }[];
      roles: Record<string, string>;
    }>("models.catalog");
    expect(catalog.providers.map((provider) => provider.id).sort()).toEqual(["openrouter"]);
    expect(catalog.roles).toEqual({ titles: "openai-codex/gpt-6-luna", titlesReasoning: "high" });

    await client.request("credentials.set", { accountId: "openai", key: OPENAI_KEY });
    catalog = await client.request("models.catalog");
    expect(catalog.providers.find((provider) => provider.id === "openai")?.models).toEqual([
      expect.objectContaining({ id: "openai-model" }),
    ]);

    await expect(client.request("models.setRoles", { titles: "openai/missing" })).rejects.toThrow(
      /unknown model/,
    );
    const result = await client.request<{
      roles: Record<string, string>;
      restartRequired: boolean;
    }>("models.setRoles", { titles: "openai/openai-model", titlesReasoning: "low" });
    expect(result).toMatchObject({
      restartRequired: true,
      roles: { titles: "openai/openai-model", titlesReasoning: "low" },
    });
    const text = await readFile(configPath, "utf8");
    expect(text).toContain('model = "openai/openai-model"');
    expect(text).toContain("# my settings");
    expect((await stat(configPath)).mode & 0o777).toBe(0o640);
    await expect(client.request("models.setRoles", { titlesReasoning: "extreme" })).rejects.toThrow(
      /reasoning/,
    );
  });

  it("gets, validates, saves and updates config.toml", async () => {
    const current = await client.request<{ path: string; text: string; restartRequired: boolean }>(
      "config.get",
    );
    expect(current).toMatchObject({ path: configPath, restartRequired: false });
    expect(current.text).toContain("# my settings");

    expect(await client.request("config.validate", { text: current.text })).toEqual({ ok: true });
    const bad = await client.request<{ ok: boolean; error: string }>("config.validate", {
      text: `${current.text}\n[bot_to_bot]\nmax_rounds_per_request = 0\n`,
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/max_rounds_per_request/);
    await expect(
      client.request("config.save", { text: `${current.text}\n[server]\nhost = "0.0.0.0"\n` }),
    ).rejects.toThrow(/loopback or tailnet/);
    expect(await readFile(configPath, "utf8")).toBe(current.text);

    await client.request("config.update", {
      edits: [
        { path: ["bot_to_bot", "max_rounds_per_request"], value: 9 },
        { path: ["extraction", "timezone"], value: "America/New_York" },
        { path: ["search", "provider"], value: "brave" },
      ],
    });
    const updated = parseToml(await readFile(configPath, "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    expect(updated.bot_to_bot?.max_rounds_per_request).toBe(9);
    expect(updated.extraction?.timezone).toBe("America/New_York");
    expect(updated.search?.provider).toBe("brave");
    expect(await client.request("config.get")).toMatchObject({
      effective: {
        bot_to_bot: { max_rounds_per_request: 9, max_messages_per_hour_per_pair: 30 },
        extraction: { timezone: "America/New_York" },
        search: { provider: "brave" },
      },
    });
    await expect(
      client.request("config.update", { edits: [{ path: ["search", "provider"], value: "bing" }] }),
    ).rejects.toThrow(/search/);
    await expect(
      client.request("config.update", {
        edits: [{ path: ["extraction", "timezone"], value: "Mars/Base" }],
      }),
    ).rejects.toThrow(/time zone/);

    const saved = `${await readFile(configPath, "utf8")}# edited\n`;
    expect(await client.request("config.save", { text: saved })).toEqual({
      saved: true,
      restartRequired: true,
    });
    expect(await client.request("config.get")).toMatchObject({
      text: saved,
      restartRequired: true,
    });
  });

  it("stores a GitHub SSH key write-only and the git identity in config.toml", async () => {
    expect(await client.request("github.get")).toEqual({ identity: {} });

    const { sshKey } = await client.request<{ sshKey: SshPublicKey }>("github.generateSshKey", {
      comment: "pi-bot@test",
    });
    expect(sshKey.type).toBe("ssh-ed25519");
    expect(sshKey.publicKey).toMatch(/^ssh-ed25519 AAAA[A-Za-z0-9+/=]+ pi-bot@test$/);
    expect(sshKey.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    const stored = await credentials.read("github-ssh");
    if (stored?.type !== "api_key" || !stored.key) throw new Error("expected a stored key");
    expect(stored.key).toContain("-----BEGIN OPENSSH PRIVATE KEY-----");
    // The private half never goes back over the socket.
    expect(JSON.stringify(client.messages)).not.toContain("PRIVATE KEY");

    // ssh-keygen agrees on the format and fingerprint, when it is installed.
    const file = join(dir.path, "id_test");
    await writeFile(file, stored.key, { mode: 0o600 });
    let keygen: string | undefined;
    try {
      keygen = execFileSync("ssh-keygen", ["-lf", file], { encoding: "utf8" });
    } catch {
      keygen = undefined;
    }
    if (keygen !== undefined) expect(keygen).toContain(sshKey.fingerprint);

    // Pasting the same key back reads the same public half.
    await client.request("github.removeSshKey");
    expect(await client.request("github.get")).toEqual({ identity: {} });
    const pasted = await client.request<{ sshKey: SshPublicKey }>("github.setSshKey", {
      privateKey: `\r\n${stored.key.replace(/\n/g, "\r\n")}  `,
    });
    expect(pasted.sshKey).toEqual(sshKey);
    expect(await client.request("github.get")).toMatchObject({ sshKey });

    await expect(
      client.request("github.setSshKey", { privateKey: sshKey.publicKey }),
    ).rejects.toThrow(/public key/);
    await expect(
      client.request("github.setSshKey", { privateKey: "-----BEGIN RSA PRIVATE KEY-----\nAA" }),
    ).rejects.toThrow(/OpenSSH private key/);
    // Same key, re-labelled as encrypted: passphrase-protected keys are refused.
    const body = stored.key
      .replace("-----BEGIN OPENSSH PRIVATE KEY-----", "")
      .replace("-----END OPENSSH PRIVATE KEY-----", "")
      .replace(/\s+/g, "");
    const raw = Buffer.from(body, "base64");
    const magic = "openssh-key-v1\0".length;
    const cipher = Buffer.from("aes256-ctr");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(cipher.length);
    const encrypted = Buffer.concat([
      raw.subarray(0, magic),
      length,
      cipher,
      raw.subarray(magic + 8),
    ]);
    await expect(
      client.request("github.setSshKey", {
        privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${encrypted.toString("base64")}\n-----END OPENSSH PRIVATE KEY-----`,
      }),
    ).rejects.toThrow(/passphrase/);

    expect(
      await client.request("github.setIdentity", { name: "Pi Bot", email: "bot@example.com" }),
    ).toEqual({ saved: true, restartRequired: true });
    const toml = await readFile(configPath, "utf8");
    expect(toml).toContain("# my settings");
    expect(parseToml(toml).git).toEqual({ user_name: "Pi Bot", user_email: "bot@example.com" });
    expect(await client.request("github.get")).toMatchObject({
      identity: { name: "Pi Bot", email: "bot@example.com" },
    });
    await expect(
      client.request("github.setIdentity", { name: "Pi Bot", email: "not-an-email" }),
    ).rejects.toThrow();
  });
});
