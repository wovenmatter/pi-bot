import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuthResult, CredentialStore, Provider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PiBotApp, startPiBot } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { ServerMessage } from "../src/protocol.ts";
import type { AccountStatus, LoginEvent } from "../src/settings/service.ts";
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
              { id: "device", label: "Device code" },
            ],
          });
          if (method === "device") {
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
    await expect(
      client.request("credentials.set", { accountId: "claude-subscription", key: "sk-ant-api-x" }),
    ).rejects.toThrow(/sk-ant-oat/);
    await client.request("credentials.set", {
      accountId: "claude-subscription",
      key: "sk-ant-oat01-fake-token",
    });
    expect(await credentials.read("claude-subscription")).toMatchObject({ type: "api_key" });
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

  it("runs a remote OAuth sign-in: choice, auth URL, pasted redirect", async () => {
    const { loginId } = await client.request<{ loginId: string }>("login.start", {
      accountId: "openai-codex",
    });
    const choice = await promptAt(loginId, 0);
    expect(choice.prompt).toMatchObject({ type: "select" });
    await expect(
      client.request("login.respond", { loginId, promptId: choice.promptId, value: "nope" }),
    ).rejects.toThrow(/listed options/);
    await client.request("login.respond", { loginId, promptId: choice.promptId, value: "browser" });

    expect((await waitLogin(loginId, "auth_url")).url).toBe("https://auth.example/authorize?s=1");
    const paste = await promptAt(loginId, 1);
    expect(paste.prompt.type).toBe("manual_code");
    await client.request("login.respond", {
      loginId,
      promptId: paste.promptId,
      value: "http://localhost:1455/auth/callback?code=good&state=s",
    });
    await waitLogin(loginId, "done");
    expect(await credentials.read("openai-codex")).toMatchObject({ type: "oauth", access: ACCESS });
    expect((await account("openai-codex"))?.detail).toMatch(/^Signed in · token valid until/);
    expect(JSON.stringify(client.messages)).not.toContain(ACCESS);
  });

  it("reports failed and cancelled sign-ins", async () => {
    const first = await client.request<{ loginId: string }>("login.start", {
      accountId: "openai-codex",
    });
    const choice = await promptAt(first.loginId, 0);
    await client.request("login.respond", {
      loginId: first.loginId,
      promptId: choice.promptId,
      value: "browser",
    });
    const paste = await promptAt(first.loginId, 1);
    await client.request("login.respond", {
      loginId: first.loginId,
      promptId: paste.promptId,
      value: "garbage",
    });
    expect((await waitLogin(first.loginId, "error")).message).toBe("state mismatch");

    const second = await client.request<{ loginId: string }>("login.start", {
      accountId: "openai-codex",
    });
    const choice2 = await promptAt(second.loginId, 0);
    await client.request("login.respond", {
      loginId: second.loginId,
      promptId: choice2.promptId,
      value: "device",
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

  it("lists models for signed-in providers and writes roles to config.toml", async () => {
    let catalog = await client.request<{
      providers: { id: string; models: { id: string }[] }[];
      roles: Record<string, string>;
    }>("models.catalog");
    expect(catalog.providers.map((provider) => provider.id).sort()).toEqual(["openrouter"]);
    expect(catalog.roles).toMatchObject({ orchestrator: "faux/faux-1", titlesReasoning: "high" });

    await client.request("credentials.set", { accountId: "openai", key: OPENAI_KEY });
    catalog = await client.request("models.catalog");
    expect(catalog.providers.find((provider) => provider.id === "openai")?.models).toEqual([
      expect.objectContaining({ id: "openai-model" }),
    ]);

    await expect(
      client.request("models.setRoles", { orchestrator: "openai/missing" }),
    ).rejects.toThrow(/unknown model/);
    const result = await client.request<{
      roles: Record<string, string>;
      restartRequired: boolean;
    }>("models.setRoles", {
      orchestrator: "openai/openai-model",
      titles: "openai/openai-model",
      titlesReasoning: "low",
    });
    expect(result).toMatchObject({
      restartRequired: true,
      roles: {
        orchestrator: "openai/openai-model",
        titles: "openai/openai-model",
        titlesReasoning: "low",
      },
    });
    const text = await readFile(configPath, "utf8");
    expect(text).toContain('orchestrator = "openai/openai-model"   # main');
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
});
