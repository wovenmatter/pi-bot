import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AgentEventStream, watchEvents } from "@earendil-works/pi-durable";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import type { BotManager } from "./bots.ts";
import { NotFoundError } from "./bots.ts";
import { isAllowedBindHost } from "./config.ts";
import { conversationId as toConversationId } from "./ids.ts";
import {
  type BotSummary,
  type ConversationSnapshot,
  type Request,
  requestSchema,
  type ServerMessage,
  type StreamEvent,
  type ThreadSummary,
} from "./protocol.ts";
import type { BotRecord, ThreadRecord } from "./storage/registry.ts";
import { assistantText, type DisplayEntry, displayEntry } from "./transcript.ts";
import { VERSION } from "./version.ts";

const ctx = BACKGROUND_CONTEXT;
const HISTORY_LIMIT = 200;

export type PiBotServerOptions = {
  readonly manager: BotManager;
  readonly host: string;
  /** 0 picks a free port (tests). */
  readonly port: number;
  /** Built web client to serve at `/`, if any. */
  readonly webDir?: string;
  readonly log?: (message: string) => void;
};

export type PiBotServer = {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
};

const bot = (record: BotRecord): BotSummary => ({
  id: record.id,
  name: record.name,
  createdAt: record.createdAt,
});

const thread = (record: ThreadRecord): ThreadSummary => ({
  conversationId: record.conversationId,
  parentConversationId: record.parentConversationId,
  forkedAt: record.forkedAt,
  ...(record.title ? { title: record.title } : {}),
  createdAt: record.createdAt,
});

/** Hostnames a browser may use to reach us: loopback, the tailnet, MagicDNS names. */
export function isLocalHostname(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return isAllowedBindHost(bare) || bare.endsWith(".ts.net");
}

function hostnameOf(value: string | undefined, scheme = "http://"): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value.includes("://") ? value : `${scheme}${value}`).hostname;
  } catch {
    return undefined;
  }
}

/** Reject cross-site and DNS-rebinding upgrades: Host and Origin must both be local. */
export function isTrustedUpgrade(request: IncomingMessage): boolean {
  const host = hostnameOf(request.headers.host);
  if (!host || !isLocalHostname(host)) return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true; // Non-browser clients (CLI, tests).
  const originHost = hostnameOf(origin);
  return originHost !== undefined && isLocalHostname(originHost);
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

async function serveStatic(webDir: string, url: URL, response: ServerResponse): Promise<boolean> {
  const root = resolve(webDir);
  let path = normalize(join(root, decodeURIComponent(url.pathname)));
  if (path !== root && !path.startsWith(root + sep)) return false;
  let info = await stat(path).catch(() => undefined);
  if (info?.isDirectory()) {
    path = join(path, "index.html");
    info = await stat(path).catch(() => undefined);
  }
  if (!info?.isFile()) {
    if (extname(url.pathname)) return false;
    path = join(root, "index.html"); // Client-side routes.
    info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) return false;
  }
  response.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream",
    "x-content-type-options": "nosniff",
  });
  createReadStream(path).pipe(response);
  return true;
}

/** Translate harness events for one conversation into client stream events. */
export function streamEvents(events: readonly { type: string }[]): StreamEvent[] {
  const out: StreamEvent[] = [];
  for (const raw of events) {
    const event = raw as Parameters<Parameters<AgentEventStream["start"]>[0]>[0][number];
    switch (event.type) {
      case "run_start":
        out.push({ kind: "run", state: "start" });
        break;
      case "run_end":
        out.push({ kind: "run", state: "end" });
        break;
      case "message_start":
        // Fast generations can arrive with their content already in place.
        if (event.message.role === "assistant") {
          out.push({ kind: "assistant_start", text: assistantText(event.message) });
        }
        break;
      case "message_update":
        for (const change of event.changes) {
          if (change.type === "text_delta") out.push({ kind: "delta", text: change.delta });
        }
        break;
      case "message_end":
      case "entry_appended": {
        const entry = displayEntry(event.entry);
        if (entry) out.push({ kind: "entry", entry });
        break;
      }
      case "auto_retry_start":
        out.push({ kind: "error", message: `retrying: ${event.errorMessage}` });
        break;
      case "task_failed":
        out.push({ kind: "error", message: event.message });
        break;
    }
  }
  return out;
}

class Connection {
  readonly #socket: WebSocket;
  readonly #server: Server;
  readonly #subscriptions = new Map<string, AgentEventStream>();

  constructor(socket: WebSocket, server: Server) {
    this.#socket = socket;
    this.#server = server;
    socket.on("message", (data, isBinary) => void this.#onMessage(data, isBinary));
    socket.on("close", () => void this.dispose());
    this.send({ type: "hello", version: VERSION });
  }

  send(message: ServerMessage): void {
    if (this.#socket.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message));
  }

  async dispose(): Promise<void> {
    const streams = [...this.#subscriptions.values()];
    this.#subscriptions.clear();
    this.#server.connections.delete(this);
    await Promise.all(streams.map((stream) => stream.stop().catch(() => {})));
  }

  async unsubscribeBot(botId: string): Promise<void> {
    for (const [key, stream] of this.#subscriptions) {
      if (!key.startsWith(`${botId}:`)) continue;
      this.#subscriptions.delete(key);
      await stream.stop().catch(() => {});
    }
  }

  async #onMessage(data: RawData, isBinary: boolean): Promise<void> {
    let id: string | number | undefined;
    try {
      if (isBinary) throw new Error("binary frames are not supported");
      const json: unknown = JSON.parse(data.toString());
      if (json && typeof json === "object" && "id" in json) {
        const candidate = (json as { id: unknown }).id;
        if (typeof candidate === "string" || typeof candidate === "number") id = candidate;
      }
      const parsed = requestSchema.safeParse(json);
      if (!parsed.success) {
        throw new Error(`invalid request: ${parsed.error.issues[0]?.message ?? "malformed"}`);
      }
      const result = await this.#handle(parsed.data);
      this.send({ type: "result", id: parsed.data.id, data: result });
    } catch (error) {
      const message =
        error instanceof NotFoundError || error instanceof Error ? error.message : String(error);
      this.send({ type: "error", ...(id === undefined ? {} : { id }), message });
    }
  }

  async #handle(request: Request): Promise<unknown> {
    const manager = this.#server.manager;
    switch (request.type) {
      case "bots.list":
        return { bots: (await manager.list()).map(bot) };
      case "bots.create":
        return { bot: bot(await manager.create(request.name)) };
      case "bots.delete": {
        for (const connection of this.#server.connections) {
          await connection.unsubscribeBot(request.botId);
        }
        return { deleted: await manager.delete(request.botId) };
      }
      case "threads.list": {
        const target = await manager.get(request.botId);
        return { threads: (await target.threads(request.query)).map(thread) };
      }
      case "thread.fork": {
        const target = await manager.get(request.botId);
        const record = await target.fork({
          ...(request.conversationId === undefined
            ? {}
            : { fromConversationId: request.conversationId }),
          entryId: request.entryId,
        });
        return { thread: thread(record) };
      }
      case "message.send": {
        const target = await manager.get(request.botId);
        const { conversation, submission } = await target.send(
          request.text,
          request.conversationId,
        );
        return { conversationId: conversation.id, submissionId: submission.id };
      }
      case "conversation.close": {
        const key = `${request.botId}:${request.conversationId}`;
        const stream = this.#subscriptions.get(key);
        this.#subscriptions.delete(key);
        await stream?.stop();
        return { closed: stream !== undefined };
      }
      case "conversation.open":
        return this.#open(request.botId, request.conversationId);
    }
  }

  async #open(botId: string, requested?: number): Promise<ConversationSnapshot> {
    const target = await this.#server.manager.get(botId);
    const main = await target.main();
    const conversation = await target.conversation(requested);
    const key = `${botId}:${conversation.id}`;
    await this.#subscriptions.get(key)?.stop();

    // Watch first, then read history: events after the snapshot are never missed, and the
    // client de-duplicates entries by id.
    const stream = await watchEvents(target.harness, toConversationId(conversation.id), ctx);
    this.#subscriptions.set(key, stream);
    const page = await conversation.entries({}, HISTORY_LIMIT, undefined, ctx);
    const entries = page.items
      .map(displayEntry)
      .filter((entry): entry is DisplayEntry => entry !== undefined)
      .reverse();

    const conversationId = conversation.id;
    stream.start(async (events) => {
      for (const event of streamEvents(events)) {
        this.send({ type: "event", botId, conversationId, event });
      }
    });
    void stream.closed.then(() => {
      if (this.#subscriptions.get(key) === stream) this.#subscriptions.delete(key);
    });

    const streaming = assistantText(stream.snapshot.generation?.message);
    return {
      botId,
      conversationId,
      mainConversationId: main.id,
      entries,
      running: stream.snapshot.run !== undefined,
      ...(streaming ? { streaming } : {}),
    };
  }
}

class Server {
  readonly manager: BotManager;
  readonly connections = new Set<Connection>();

  constructor(manager: BotManager) {
    this.manager = manager;
  }
}

export async function startServer(options: PiBotServerOptions): Promise<PiBotServer> {
  if (!isAllowedBindHost(options.host)) {
    throw new Error(`refusing to bind ${options.host}: use loopback or a tailnet address`);
  }
  const state = new Server(options.manager);
  const log = options.log ?? (() => {});

  const http = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!isLocalHostname(hostnameOf(request.headers.host) ?? "")) {
        response.writeHead(421).end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, version: VERSION }));
        return;
      }
      if (request.method === "GET" && options.webDir) {
        if (await serveStatic(options.webDir, url, response)) return;
      }
      response.writeHead(404, { "content-type": "text/plain" }).end("not found");
    })().catch((error: unknown) => {
      log(`http error: ${String(error)}`);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  http.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws" || !isTrustedUpgrade(request)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      state.connections.add(new Connection(ws, state));
    });
  });

  await new Promise<void>((resolvePromise, reject) => {
    http.once("error", reject);
    http.listen(options.port, options.host, () => {
      http.off("error", reject);
      resolvePromise();
    });
  });
  const port = (http.address() as AddressInfo).port;
  const host = options.host.includes(":") ? `[${options.host}]` : options.host;
  const url = `http://${host}:${port}`;
  log(`pi-bot listening on ${url} (ws ${url.replace("http", "ws")}/ws)`);

  return {
    url,
    port,
    async close() {
      await Promise.all([...state.connections].map((connection) => connection.dispose()));
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((done) => http.close(() => done()));
    },
  };
}
