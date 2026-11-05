import { randomUUID } from "node:crypto";
import type { JsonValue } from "@earendil-works/chord";
import type { CredentialStore, ToolResultMessage } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, section } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { BotRegistry } from "./storage/registry.ts";

export const WOVEN_CREDENTIAL_SLOT = "woven-mcp";
const CONNECTION_NOTE = "woven.mcp.connection";
const CACHE_NOTE = "woven.mcp.tools";
const UNAVAILABLE = "Woven Matter is unavailable. Check its MCP connection and try again.";
/** Browser, computer and session tools can legitimately run for minutes. */
const TOOL_CALL_TIMEOUT_MS = 15 * 60_000;
export type WovenStatus = {
  state: "disconnected" | "connecting" | "ready" | "unavailable";
  endpointURL?: string;
  toolCount: number;
  error?: string;
};
type BotIdentity = { id: string; name: string };
export type WovenTool = {
  name: string;
  description?: string;
  inputSchema: { type: "object"; [key: string]: unknown };
  annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean };
};
type ToolResult = {
  content?: ToolResultMessage["content"];
  isError?: boolean;
  structuredContent?: JsonValue;
};
type Connection = { endpointURL: string; bearerToken: string };

export function validateWovenEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid Woven MCP endpoint.");
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))
  ) {
    throw new Error("Woven MCP requires HTTPS or a loopback HTTP endpoint.");
  }
  return url.href;
}

function validateTools(value: unknown): WovenTool[] {
  if (!Array.isArray(value) || value.length > 512) throw new Error(UNAVAILABLE);
  const names = new Set<string>();
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      !/^woven_[a-z0-9_]+$/.test(item.name) ||
      names.has(item.name) ||
      item.inputSchema?.type !== "object"
    )
      throw new Error(UNAVAILABLE);
    names.add(item.name);
  }
  return value;
}

/** Stateless JSON-RPC; credentials never enter the registry or the transcript. */
export class WovenMCP {
  readonly #registry: BotRegistry;
  readonly #credentials: CredentialStore;
  readonly #identity: () => Promise<BotIdentity>;
  readonly #fetch: typeof fetch;
  readonly #listeners = new Set<() => void>();
  #connection: Connection | undefined;
  #tools: WovenTool[] = [];
  #state: WovenStatus["state"] = "disconnected";
  #error: string | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    registry: BotRegistry,
    credentials: CredentialStore,
    identity: () => Promise<BotIdentity>,
    fetcher = fetch,
  ) {
    this.#registry = registry;
    this.#credentials = credentials;
    this.#identity = identity;
    this.#fetch = fetcher;
  }

  /** Restore only local state: an unreachable app must never hold up bot startup. */
  async load(): Promise<void> {
    const stored = await this.#registry.note(CONNECTION_NOTE);
    if (!stored?.text) return;
    try {
      const endpointURL = validateWovenEndpoint(stored.text);
      const credential = await this.#credentials.read(WOVEN_CREDENTIAL_SLOT);
      if (credential?.type !== "api_key" || !credential.key) return;
      this.#connection = { endpointURL, bearerToken: credential.key };
      const cache = await this.#registry.note(CACHE_NOTE);
      this.#tools = cache?.text ? validateTools(JSON.parse(cache.text)) : [];
      this.#state = "unavailable";
      this.#error = "Woven Matter connection restored; tools will reconnect on use.";
    } catch {
      this.#state = "unavailable";
      this.#error = UNAVAILABLE;
    }
  }

  status(): WovenStatus {
    return {
      state: this.#state,
      toolCount: this.#connection ? this.#tools.length : 0,
      ...(this.#connection ? { endpointURL: this.#connection.endpointURL } : {}),
      ...(this.#error ? { error: this.#error } : {}),
    };
  }

  connected(): boolean {
    return this.#connection !== undefined;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }

  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.catch(() => {});
    return run;
  }

  connect(endpoint: string, bearerToken: string): Promise<WovenStatus> {
    const endpointURL = validateWovenEndpoint(endpoint);
    if (!/^[A-Za-z0-9._~+/-]+=*$/.test(bearerToken))
      throw new Error("Invalid Woven MCP credential.");
    return this.#serialize(async () => {
      await this.#credentials.modify(WOVEN_CREDENTIAL_SLOT, async () => ({
        type: "api_key",
        key: bearerToken,
      }));
      await this.#registry.setNote(CONNECTION_NOTE, endpointURL);
      this.#connection = { endpointURL, bearerToken };
      this.#state = "connecting";
      this.#error = undefined;
      this.#changed();
      try {
        const tools: WovenTool[] = [],
          cursors = new Set<string>();
        const identity = await this.#identity();
        const signal = AbortSignal.timeout(30_000);
        let cursor: string | undefined;
        do {
          const page = await this.#rpc<{ tools: WovenTool[]; nextCursor?: string }>(
            this.#connection,
            identity,
            "tools/list",
            cursor ? { cursor } : {},
            signal,
          );
          tools.push(...validateTools(page.tools));
          validateTools(tools);
          cursor = page.nextCursor;
          if (cursor !== undefined && (typeof cursor !== "string" || cursors.has(cursor)))
            throw new Error(UNAVAILABLE);
          if (cursor) cursors.add(cursor);
          if (cursors.size > 512) throw new Error(UNAVAILABLE);
        } while (cursor);
        await this.#registry.setNote(CACHE_NOTE, JSON.stringify(tools));
        this.#tools = tools;
        this.#state = "ready";
      } catch {
        this.#state = "unavailable";
        this.#error = UNAVAILABLE;
      }
      this.#changed();
      return this.status();
    });
  }

  disconnect(): Promise<WovenStatus> {
    return this.#serialize(async () => {
      await this.#registry.setNote(CONNECTION_NOTE, "");
      await this.#credentials.delete(WOVEN_CREDENTIAL_SLOT);
      this.#connection = undefined;
      this.#state = "disconnected";
      this.#error = undefined;
      this.#changed();
      return this.status();
    });
  }

  async #rpc<T>(
    bound: Connection,
    bot: BotIdentity,
    method: string,
    params: object,
    signal: AbortSignal,
  ): Promise<T> {
    const id = randomUUID();
    const response = await this.#fetch(bound.endpointURL, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${bound.bearerToken}`,
        "x-woven-bot-id": bot.id,
        "x-woven-bot-name": encodeURIComponent(bot.name),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (!response.ok) throw new Error(UNAVAILABLE);
    // Even a broken endpoint echoing its authorization must not leak it to a tool result/cache.
    const message = JSON.parse(await response.text());
    if (message.jsonrpc !== "2.0" || message.id !== id || message.error || !message.result)
      throw new Error(UNAVAILABLE);
    return JSON.parse(
      JSON.stringify(message.result).split(bound.bearerToken).join("[redacted]"),
    ) as T;
  }

  async callTool(
    bot: BotIdentity,
    name: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const bound = this.#connection;
    if (!bound)
      return { isError: true, content: [{ type: "text", text: "Woven Matter is disconnected." }] };
    const requestID = input.requestID ?? randomUUID();
    try {
      signal.throwIfAborted();
      const result = await this.#rpc<ToolResult>(
        bound,
        bot,
        "tools/call",
        { name, arguments: { ...input, requestID } },
        AbortSignal.any([signal, AbortSignal.timeout(TOOL_CALL_TIMEOUT_MS)]),
      );
      if (this.#connection === bound) {
        this.#state = "ready";
        this.#error = undefined;
      }
      return result;
    } catch {
      if (
        signal.aborted &&
        ["woven_browser_use", "woven_computer_use", "woven_html_preview"].includes(name)
      ) {
        await this.#rpc(
          bound,
          bot,
          "tools/call",
          {
            name: name === "woven_html_preview" ? "woven_html_cancel" : `${name}_cancel`,
            arguments: { id: requestID },
          },
          AbortSignal.timeout(3000),
        ).catch(() => {});
      }
      if (this.#connection === bound && !signal.aborted) {
        this.#state = "unavailable";
        this.#error = UNAVAILABLE;
      }
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: signal.aborted ? "Woven Matter tool call cancelled." : UNAVAILABLE,
          },
        ],
      };
    }
  }

  extension(bot: () => Promise<BotIdentity>): Extension {
    return defineExtension({
      name: "pi-bot-woven-mcp",
      sections: [
        section("woven_matter", () =>
          this.connected()
            ? "Woven Matter tools are available. You can launch and manage agent sessions in Woven Matter with woven_sessions_* tools, including coding work when you have no container."
            : undefined,
        ),
      ],
      tools: this.connected()
        ? this.#tools.map((definition) =>
            defineTool({
              name: definition.name,
              description: definition.description ?? "",
              parameters: Type.Unsafe<Record<string, unknown>>(definition.inputSchema),
              replay:
                definition.annotations?.readOnlyHint === true &&
                definition.annotations?.idempotentHint !== false
                  ? "safe"
                  : "unsafe",
              execute: async (input, api, ctx) => {
                const requestID =
                  input.requestID ?? (await api.memo("wovenRequestID", randomUUID(), ctx));
                const result = await this.callTool(
                  await bot(),
                  definition.name,
                  { ...input, requestID },
                  ctx.abortSignal ?? new AbortController().signal,
                );
                return {
                  output: result.content ?? [],
                  isError: result.isError === true,
                  ...(result.structuredContent === undefined
                    ? {}
                    : { details: { structuredContent: result.structuredContent } }),
                };
              },
            }),
          )
        : [],
    });
  }
}
