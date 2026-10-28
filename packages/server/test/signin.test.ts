import { join } from "node:path";
import type { Api, AuthEvent, AuthPrompt, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_SUBSCRIPTION_PROVIDER, claudeAccountOAuth } from "../src/claude/provider.ts";
import { EncryptedSqliteCredentialStore } from "../src/credentials/index.ts";
import { createPiBotModels } from "../src/models.ts";
import { openSharedDatabase } from "../src/storage/database.ts";
import { FakeProviders } from "./fake-providers.ts";
import { tempDir } from "./helpers.ts";

/** Claude account sign-in and refresh against a stubbed token endpoint: no network, no real token. */

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const COPY_CODE_REDIRECT = "https://platform.claude.com/oauth/code/callback";

type TokenCall = {
  grant_type: string;
  redirect_uri?: string;
  code?: string;
  refresh_token?: string;
};

function stubTokenEndpoint(reply: (body: TokenCall, n: number) => object) {
  const calls: TokenCall[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    if (String(url) !== TOKEN_URL) throw new Error(`unexpected fetch ${String(url)}`);
    const body = JSON.parse(String(init?.body)) as TokenCall;
    calls.push(body);
    await new Promise((done) => setTimeout(done, 20));
    return new Response(JSON.stringify(reply(body, calls.length)), { status: 200 });
  });
  return calls;
}

function interaction(answer: (prompt: AuthPrompt, url: URL | undefined) => string) {
  const events: AuthEvent[] = [];
  let authUrl: URL | undefined;
  const prompts: AuthPrompt[] = [];
  return {
    events,
    prompts,
    value: {
      signal: new AbortController().signal,
      notify(event: AuthEvent) {
        events.push(event);
        if (event.type === "auth_url") authUrl = new URL(event.url);
      },
      async prompt(prompt: AuthPrompt) {
        prompts.push(prompt);
        return answer(prompt, authUrl);
      },
    },
  };
}

describe("Claude account sign-in (copy-code, headless)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows claude.ai's authorize URL, takes the pasted code#state and exchanges it", async () => {
    const calls = stubTokenEndpoint(() => ({
      access_token: "sk-ant-oat01-fake-access",
      refresh_token: "sk-ant-ort01-fake-refresh",
      expires_in: 3600,
    }));
    const run = interaction((prompt, url) => {
      if (prompt.type === "select") throw new Error("the method picker must not reach the user");
      return `fake-code#${url?.searchParams.get("state") ?? ""}`;
    });
    const credential = await claudeAccountOAuth().login(run.value, { agentName: "Pi Bot" });

    const authUrl = run.events.find((event) => event.type === "auth_url");
    if (authUrl?.type !== "auth_url") throw new Error("no auth URL");
    const url = new URL(authUrl.url);
    expect(`${url.origin}${url.pathname}`).toBe("https://claude.ai/oauth/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe(COPY_CODE_REDIRECT);
    expect(url.searchParams.get("code")).toBe("true");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(run.prompts).toEqual([expect.objectContaining({ type: "manual_code" })]);
    expect(calls).toEqual([
      expect.objectContaining({
        grant_type: "authorization_code",
        code: "fake-code",
        redirect_uri: COPY_CODE_REDIRECT,
      }),
    ]);
    expect(credential).toMatchObject({ type: "oauth", access: "sk-ant-oat01-fake-access" });
  });

  it("rejects a code from another sign-in", async () => {
    const calls = stubTokenEndpoint(() => ({}));
    const run = interaction(() => "fake-code#not-this-state");
    await expect(claudeAccountOAuth().login(run.value, {})).rejects.toThrow(/state mismatch/);
    expect(calls).toEqual([]);
  });
});

describe("one serialized refresher per credential slot", () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await dir.cleanup();
  });

  it("refreshes a rotating Claude token once for concurrent turns and hands Claude Code the new one", async () => {
    const db = await openSharedDatabase(join(dir.path, "pi-bot.sqlite"));
    try {
      const store = await EncryptedSqliteCredentialStore.open(
        db,
        join(dir.path, "credentials.key"),
      );
      await store.modify(CLAUDE_SUBSCRIPTION_PROVIDER, async () => ({
        type: "oauth",
        access: "sk-ant-oat01-old",
        refresh: "refresh-1",
        expires: Date.now() - 1000,
      }));
      // Rotating refresh tokens: refresh-1 is single-use, like xAI and Anthropic.
      const calls = stubTokenEndpoint((body, n) => {
        if (body.refresh_token !== "refresh-1") throw new Error("refresh token reused");
        return {
          access_token: `sk-ant-oat01-new-${n}`,
          refresh_token: `refresh-${n + 1}`,
          expires_in: 3600,
        };
      });
      const fake = new FakeProviders();
      const models = createPiBotModels(store, {
        claude: { directory: join(dir.path, "claude"), query: fake.claudeQuery },
      });
      const model = models.getModel(CLAUDE_SUBSCRIPTION_PROVIDER, "claude-haiku-4-5") as Model<Api>;
      const turn = async () => {
        const stream = models.stream(model, {
          messages: [{ role: "user", content: "hi", timestamp: 1 }],
        });
        for await (const _event of stream) {
          // drain
        }
        return stream.result();
      };
      const results = await Promise.all([turn(), turn(), turn()]);
      expect(results.map((result) => result.stopReason)).toEqual(["stop", "stop", "stop"]);
      expect(calls.filter((call) => call.grant_type === "refresh_token")).toHaveLength(1);
      expect(fake.requests.map((request) => request.body.env.CLAUDE_CODE_OAUTH_TOKEN)).toEqual([
        "sk-ant-oat01-new-1",
        "sk-ant-oat01-new-1",
        "sk-ant-oat01-new-1",
      ]);
      expect(await store.read(CLAUDE_SUBSCRIPTION_PROVIDER)).toMatchObject({
        type: "oauth",
        refresh: "refresh-2",
      });
    } finally {
      await db.close();
    }
  });
});
