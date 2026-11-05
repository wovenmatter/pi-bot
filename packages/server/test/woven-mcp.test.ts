import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PiBotApp, startPiBot } from "../src/app.ts";
import { CLAUDE_SUBSCRIPTION_PROVIDER } from "../src/claude/provider.ts";
import { parseConfig } from "../src/config.ts";
import { EncryptedSqliteCredentialStore } from "../src/credentials/encrypted-sqlite.ts";
import { createPiBotModels } from "../src/models.ts";
import { openSharedDatabase } from "../src/storage/database.ts";
import { BotRegistry } from "../src/storage/registry.ts";
import {
  validateWovenEndpoint,
  WOVEN_CREDENTIAL_SLOT,
  WovenMCP,
  type WovenTool,
} from "../src/woven-mcp.ts";
import { FakeProviders, MemoryCredentials } from "./fake-providers.ts";
import { tempDir } from "./helpers.ts";
import { Client } from "./ws-client.ts";

const TOKEN = "fixture-woven-bearer";
const identity = { id: "00000000-0000-4000-8000-000000000000", name: "Bot / café" };
const tools: WovenTool[] = [
  {
    name: "woven_sessions_list",
    description: "List sessions",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "woven_sessions_create",
    description: "Create session",
    inputSchema: { type: "object", properties: {} },
    annotations: { idempotentHint: true },
  },
  {
    name: "woven_browser_use",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true, idempotentHint: false },
  },
];
const ctx = BACKGROUND_CONTEXT;

describe("stateless Woven MCP", () => {
  let db: Awaited<ReturnType<typeof openSharedDatabase>>;
  let registry: BotRegistry;
  let credentials: EncryptedSqliteCredentialStore;
  beforeEach(async () => {
    db = await openSharedDatabase(":memory:");
    registry = new BotRegistry(db);
    await registry.migrate();
    credentials = await EncryptedSqliteCredentialStore.withKey(db, Buffer.alloc(32, 3));
  });
  afterEach(async () => {
    await db.close();
  });

  it.each([
    "http://example.com/mcp",
    "http://127.1.2.3/mcp",
    "ftp://localhost/mcp",
    "https://user:pass@example.com/mcp",
    "https://example.com/mcp#fragment",
    "garbage",
  ])("rejects endpoint %s", (url) => {
    expect(() => validateWovenEndpoint(url)).toThrow();
  });
  it.each([
    "https://example.com/mcp",
    "http://localhost/mcp",
    "http://127.0.0.1/mcp",
    "http://[::1]/mcp",
  ])("allows endpoint %s", (url) => {
    expect(validateWovenEndpoint(url)).toBe(url);
  });

  it("pages discovery, attributes every POST, refuses redirects and preserves rich tool results without credentials", async () => {
    const seen: { headers: Headers; body: { method: string; params: Record<string, unknown> } }[] =
      [];
    const rich = {
      content: [
        { type: "text", text: TOKEN },
        { type: "image", mimeType: "image/png", data: "cG5n" },
      ],
      isError: true,
      structuredContent: { requestID: "kept", value: 42 },
    };
    const fetcher: typeof fetch = async (_url, init) => {
      expect(init?.redirect).toBe("error");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      const headers = new Headers(init?.headers);
      seen.push({ headers, body });
      const result =
        body.method === "tools/list"
          ? body.params.cursor
            ? { tools: tools.slice(1) }
            : { tools: tools.slice(0, 1), nextCursor: "page2" }
          : rich;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result }).replaceAll(
          TOKEN,
          "\\u0066ixture-woven-bearer",
        ),
      );
    };
    const woven = new WovenMCP(registry, credentials, async () => identity, fetcher);
    expect(await woven.connect("http://localhost/mcp", TOKEN)).toEqual({
      state: "ready",
      endpointURL: "http://localhost/mcp",
      toolCount: 3,
    });
    for (const { headers } of seen) {
      expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(headers.get("x-woven-bot-id")).toBe(identity.id);
      expect(headers.get("x-woven-bot-name")).toBe(encodeURIComponent(identity.name));
      expect(headers.has("origin")).toBe(false);
    }
    const result = await woven.callTool(
      identity,
      "woven_sessions_list",
      { requestID: "kept" },
      new AbortController().signal,
    );
    expect(result).toEqual({
      ...rich,
      content: [{ type: "text", text: "[redacted]" }, rich.content[1]],
    });
    expect(JSON.stringify(woven.status())).not.toContain(TOKEN);
    expect(JSON.stringify(await db.all("SELECT * FROM pibot_notes"))).not.toContain(TOKEN);
    const encrypted = await db.get<{ ciphertext: Uint8Array }>(
      "SELECT ciphertext FROM pibot_credentials WHERE provider_id = ?",
      WOVEN_CREDENTIAL_SLOT,
    );
    expect(Buffer.from(encrypted?.ciphertext ?? []).includes(Buffer.from(TOKEN))).toBe(false);
    const extension = woven.extension(async () => identity);
    expect(extension.tools?.map((tool) => tool.replay)).toEqual(["safe", "unsafe", "unsafe"]);
    let memo: string | undefined;
    const api = {
      memo: async (_name: string, candidate: string) => (memo ??= candidate),
    } as unknown as ToolExecutionApi;
    const tool = extension.tools?.[0];
    if (!tool) throw new Error("missing tool");
    await tool.execute({}, api, ctx);
    await tool.execute({}, api, ctx);
    const stable = seen
      .slice(-2)
      .map((item) => (item.body.params.arguments as { requestID: string }).requestID);
    expect(stable[0]).toMatch(/^[a-f0-9-]{36}$/);
    expect(stable[1]).toBe(stable[0]);

    const unavailable = vi.fn<typeof fetch>().mockRejectedValue(new Error(`network ${TOKEN}`));
    const restored = new WovenMCP(registry, credentials, async () => identity, unavailable);
    await restored.load();
    expect(unavailable).not.toHaveBeenCalled();
    expect(restored.status()).toMatchObject({ state: "unavailable", toolCount: 3 });
    expect(restored.extension(async () => identity).tools).toHaveLength(3);
    expect(
      await restored.callTool(identity, "woven_sessions_list", {}, new AbortController().signal),
    ).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("unavailable") }] });
    expect(JSON.stringify(restored.status())).not.toContain(TOKEN);
    expect(await restored.disconnect()).toEqual({ state: "disconnected", toolCount: 0 });
    expect(await credentials.read(WOVEN_CREDENTIAL_SLOT)).toBeUndefined();
    expect(restored.extension(async () => identity).tools).toEqual([]);
  });

  it("rejects duplicate tools and repeated cursors while retaining the last good list", async () => {
    let mode = "good";
    const woven = new WovenMCP(
      registry,
      credentials,
      async () => identity,
      async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools:
              mode === "duplicate"
                ? [tools[0], tools[0]]
                : mode === "cursor" && body.params.cursor
                  ? []
                  : tools,
            ...(mode === "cursor" ? { nextCursor: "again" } : {}),
          },
        });
      },
    );
    await woven.connect("http://localhost/mcp", TOKEN);
    for (mode of ["duplicate", "cursor"])
      expect(await woven.connect("http://localhost/mcp", TOKEN)).toMatchObject({
        state: "unavailable",
        toolCount: 3,
      });
    expect(() => woven.connect("http://localhost/mcp", "bad\r\nheader")).toThrow();
  });

  it.each(["woven_browser_use", "woven_computer_use", "woven_html_preview"])(
    "forwards cancellation for %s using the original requestID and authority",
    async (name) => {
      const calls: { name: string; arguments: Record<string, unknown> }[] = [];
      const controller = new AbortController();
      const woven = new WovenMCP(
        registry,
        credentials,
        async () => identity,
        async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          if (body.method === "tools/list")
            return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools } });
          calls.push(body.params);
          if (body.params.name === name) {
            controller.abort();
            throw new Error("cancelled");
          }
          return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [] } });
        },
      );
      await woven.connect("http://localhost/mcp", TOKEN);
      await woven.callTool(identity, name, {}, controller.signal);
      const id = calls[0]?.arguments.requestID;
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(calls[1]).toEqual({
        name: name === "woven_html_preview" ? "woven_html_cancel" : `${name}_cancel`,
        arguments: { id },
      });
    },
  );

  it("keeps Woven tools in Claude's real inventory and decodes their calls back to Pi", async () => {
    const woven = new WovenMCP(
      registry,
      credentials,
      async () => identity,
      async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools } });
      },
    );
    await woven.connect("http://localhost/mcp", TOKEN);
    const fake = new FakeProviders();
    fake.options = {
      claudeReply: () => [
        { type: "tool_use", id: "toolu_woven", name: "mcp__pibot__woven_sessions_list", input: {} },
      ],
    };
    const dir = await tempDir();
    let inventory: Promise<unknown> | undefined;
    try {
      const all = createPiBotModels(
        new MemoryCredentials({
          [CLAUDE_SUBSCRIPTION_PROVIDER]: { type: "api_key", key: "fixture-claude" },
        }),
        {
          claude: {
            directory: join(dir.path, "claude"),
            query: (params) => {
              const servers = params.options.mcpServers as { pibot: { args: string[] } };
              inventory = readFile(servers.pibot.args[1] ?? "", "utf8").then(JSON.parse);
              return fake.claudeQuery(params);
            },
          },
        },
      );
      const model = all.getModel(CLAUDE_SUBSCRIPTION_PROVIDER, "claude-haiku-4-5");
      if (!model) throw new Error("missing model");
      const result = await all
        .stream(model, {
          messages: [{ role: "user", content: "list sessions", timestamp: 1 }],
          tools: [...(woven.extension(async () => identity).tools ?? [])],
        })
        .result();
      expect(result.stopReason).toBe("toolUse");
      expect(result.content).toEqual([
        { type: "toolCall", id: "toolu_woven", name: "woven_sessions_list", arguments: {} },
      ]);
      expect(await inventory).toEqual(
        tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema,
        })),
      );
    } finally {
      await dir.cleanup();
    }
  });
});

describe("live bot Woven connection", () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let server: Server;
  let app: PiBotApp;
  let client: Client;
  let endpoint: string;
  const requests: Record<string, unknown>[] = [];
  const contexts: string[] = [];
  let script: "reply" | "child" | "tool" = "reply";
  let called = false;
  const open = async () => {
    const faux = fauxProvider({ tokensPerSecond: 5000 });
    faux.setResponses(
      Array.from({ length: 50 }, () => (context) => {
        const json = JSON.stringify(context);
        contexts.push(json);
        if (
          script === "child" &&
          !json.includes("You are a subagent") &&
          !json.includes('"toolName":"run_subagent"')
        )
          return fauxAssistantMessage(
            [fauxToolCall("run_subagent", { model: "self", task: "say hi" })],
            { stopReason: "toolUse" },
          );
        if (script === "tool" && !called) {
          called = true;
          return fauxAssistantMessage([fauxToolCall("woven_sessions_list", {})], {
            stopReason: "toolUse",
          });
        }
        return fauxAssistantMessage([fauxText("done")]);
      }),
    );
    const models = createModels();
    models.setProvider(faux.provider);
    app = await startPiBot(
      parseConfig(
        `[models]\norchestrator = "faux/faux-1"\n[models.titles]\nmodel = "faux/faux-1"\n[storage]\ndata_dir = "${dir.path}"\n[credentials]\nbackend = "encrypted-sqlite"\n[environment]\nbackend = "none"\n[extraction]\nenabled = false\n`,
      ),
      { models, port: 0, log: () => {} },
    );
    client = await Client.open(`${app.server.url.replace("http", "ws")}/ws`);
  };
  beforeEach(async () => {
    dir = await tempDir();
    requests.length = 0;
    contexts.length = 0;
    script = "reply";
    called = false;
    server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      requests.push({ headers: request.headers, ...body });
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result:
            body.method === "tools/list"
              ? { tools }
              : {
                  content: [{ type: "text", text: "session result" }],
                  structuredContent: { value: 42 },
                },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    await open();
  });
  afterEach(async () => {
    client.close();
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await dir.cleanup();
  });

  it("refreshes existing bots and threads, excludes subagents, survives restart and disconnects live", async () => {
    const bot = await app.manager.get((await app.manager.create("Worker")).id);
    await (await bot.send("before")).submission.wait(ctx);
    expect(contexts.at(-1)).not.toContain("woven_sessions_list");
    const main = await bot.main();
    const entries = await main.entries({}, 100, undefined, ctx);
    const entry = entries.items.find((entry) =>
      entry.model?.some((message) => message.role === "user"),
    );
    if (!entry) throw new Error("missing user");
    const thread = await bot.fork({ entryId: entry.id });
    expect(
      await client.request("woven.connect", { endpointURL: endpoint, bearerToken: TOKEN }),
    ).toMatchObject({ state: "ready", toolCount: 3 });
    script = "tool";
    await app.manager.rename(bot.id, "Renamed café");
    await (await bot.send("use tool")).submission.wait(ctx);
    const call = requests.find((request) => request.method === "tools/call");
    expect(call).toMatchObject({
      headers: { "x-woven-bot-id": bot.id, "x-woven-bot-name": encodeURIComponent("Renamed café") },
      params: { arguments: { requestID: expect.any(String) } },
    });
    const history = JSON.stringify(await main.context(ctx));
    expect(history).toContain("structuredContent");
    expect(history).toContain("session result");
    expect(history).not.toContain(TOKEN);
    script = "reply";
    await (await bot.send("thread", thread.conversationId)).submission.wait(ctx);
    expect(contexts.at(-1)).toContain("woven_sessions_list");
    const admin = await app.manager.admin();
    if (!admin) throw new Error("no admin");
    await (await (await app.manager.get(admin.id)).send("admin")).submission.wait(ctx);
    expect(contexts.at(-1)).toContain("woven_sessions_list");
    const childBot = await app.manager.get((await app.manager.create("Parent")).id);
    script = "child";
    await (await childBot.send("delegate")).submission.wait(ctx);
    const child = contexts.find((context) => context.includes("You are a subagent"));
    expect(child).toBeDefined();
    expect(child).not.toContain("woven_sessions_list");
    expect(child).not.toContain("Woven Matter tools are available");
    expect(JSON.stringify(await client.request("settings.accounts"))).not.toContain(
      WOVEN_CREDENTIAL_SLOT,
    );
    await expect(
      client.request("credentials.set", { accountId: WOVEN_CREDENTIAL_SLOT, key: "fixture" }),
    ).rejects.toThrow();
    const count = requests.length;
    client.close();
    await app.close();
    await open();
    expect(requests).toHaveLength(count);
    expect(await client.request("woven.status")).toMatchObject({
      toolCount: 3,
      endpointURL: endpoint,
    });
    const reopened = await app.manager.get(bot.id);
    script = "reply";
    await (await reopened.send("after restart")).submission.wait(ctx);
    expect(contexts.at(-1)).toContain("woven_sessions_list");
    expect(await client.request("woven.disconnect")).toEqual({
      state: "disconnected",
      toolCount: 0,
    });
    await (await reopened.send("after disconnect")).submission.wait(ctx);
    const current = await (await reopened.main()).agent(ctx);
    expect(current.tools.some((tool) => tool.name.startsWith("woven_"))).toBe(false);
  });
});
