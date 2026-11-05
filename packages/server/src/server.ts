import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationView, ConversationWatch, LiveState } from "@earendil-works/pi-durable";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import type { BotManager, ModelStatus } from "./bots.ts";
import { NotFoundError } from "./bots.ts";
import { isAllowedBindHost } from "./config.ts";
import { CAPABILITIES, PROTOCOL } from "./identity.ts";
import { entryId as toEntryId } from "./ids.ts";
import { editFacts, type MemoryEdit } from "./memory.ts";
import { describeProfile, type ProfileStore } from "./profiles.ts";
import {
  type BotSummary,
  type ConversationSnapshot,
  type OnboardingStatus,
  type ProfilesList,
  type Request,
  requestSchema,
  type ServerMessage,
  type StreamEvent,
  type ThreadSummary,
} from "./protocol.ts";
import type { SettingsService } from "./settings/service.ts";
import type { BotRecord, ThreadRecord } from "./storage/registry.ts";
import { ACCOUNT_NOTES } from "./tools.ts";
import { assistantText, type DisplayEntry, displayEntry } from "./transcript.ts";
import { VERSION } from "./version.ts";
import type { WovenMCP } from "./woven-mcp.ts";

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
  /** Settings backend; without it the settings requests fail. */
  readonly settings?: SettingsService;
  readonly woven?: WovenMCP;
  /**
   * Schedules a graceful restart (Settings → Config → Restart Pi Bot, or Restart and apply). Resolves once the restart is
   * accepted, before this server closes; rejects (and nothing stops) when it cannot happen.
   */
  readonly restart?: () => Promise<RestartAccepted>;
};

export type RestartAccepted = {
  /** Live runs the old process waits for (bounded); the rest resume in the new one. */
  readonly activeWork: number;
  /** "reload": this process starts again in place. "exit": it exits for its supervisor. */
  readonly mode: "reload" | "exit";
};

export type PiBotServer = {
  readonly url: string;
  readonly port: number;
  /** Tell every client the bot list changed. */
  botsChanged(): void;
  groupsChanged(): void;
  /** Tell every client a bot's thread list changed (a thread was titled). */
  threadsChanged(botId: string): void;
  /** Tell every client a bot's memory changed (an extraction added facts). */
  memoryChanged(botId: string): void;
  close(): Promise<void>;
};

/** How clients see a bot: its profile's name, and model names only in a usage-limit status. */
const botSummary = (
  record: BotRecord,
  profiles: ProfileStore | undefined,
  status?: ModelStatus,
): BotSummary => {
  const profile = profiles?.resolve(record.profile);
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    kind: record.kind,
    manager: record.manager,
    ...(record.managerId ? { managerId: record.managerId } : {}),
    orchestrator: record.orchestrator,
    ...(record.groupId ? { groupId: record.groupId } : {}),
    profileId: profile?.id ?? record.profile ?? "",
    profileName: profile?.name ?? "",
    defaultProfile: !record.profile || !profiles?.get(record.profile),
    ...(status
      ? {
          modelStatus: {
            kind: status.kind,
            at: status.at,
            primary: status.primary,
            active: status.active,
            limits: status.limits.map((limit) => ({
              model: limit.model,
              account: limit.account,
              kind: limit.kind,
              ...(limit.resetsAt !== undefined ? { resetsAt: limit.resetsAt } : {}),
              retryAt: limit.retryAt,
            })),
          },
        }
      : {}),
  };
};

const thread = (record: ThreadRecord): ThreadSummary => ({
  conversationId: record.conversationId,
  parentConversationId: record.parentConversationId,
  forkedAt: record.forkedAt,
  ...(record.title ? { title: record.title } : {}),
  createdAt: record.createdAt,
  ...(record.pinned ? { pinned: true as const } : {}),
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

/** Translate conversation revisions into the existing client protocol. */
export function streamEvents(
  previous: Pick<ConversationView, "entries" | "docs">,
  current: Pick<ConversationView, "entries" | "docs">,
): StreamEvent[] {
  const before = previous.docs["pi.live"] as LiveState | undefined;
  const live = current.docs["pi.live"] as LiveState | undefined;
  const out: StreamEvent[] = [];
  if (live?.run && !before?.run) out.push({ kind: "run", state: "start" });
  const oldEntries = new Map(previous.entries.map((entry) => [entry.id, entry]));
  for (const entry of current.entries) {
    if (JSON.stringify(oldEntries.get(entry.id)) === JSON.stringify(entry)) continue;
    const display = displayEntry(entry);
    if (display) out.push({ kind: "entry", entry: display });
  }
  const finishedAssistant = out.some(
    (event) => event.kind === "entry" && event.entry.role === "assistant",
  );
  const sameGeneration =
    !finishedAssistant &&
    live?.run?.taskId === before?.run?.taskId &&
    live?.generation?.attempt === before?.generation?.attempt;
  const text = assistantText(live?.generation?.message);
  const oldText = assistantText(before?.generation?.message);
  if (live?.generation && (text !== oldText || !before?.generation || !sameGeneration)) {
    if (before?.generation && sameGeneration && text.startsWith(oldText)) {
      out.push({ kind: "delta", text: text.slice(oldText.length) });
    } else out.push({ kind: "assistant_start", text });
  }
  if (
    live?.generation?.retry &&
    JSON.stringify(live.generation.retry) !== JSON.stringify(before?.generation?.retry)
  ) {
    out.push({ kind: "error", message: `retrying: ${live.generation.retry.error}` });
  }
  if (live?.runFailure && JSON.stringify(live.runFailure) !== JSON.stringify(before?.runFailure)) {
    out.push({ kind: "error", message: live.runFailure.detail ?? live.runFailure.reason });
  }
  if (!live?.run) out.push({ kind: "run", state: "end" });
  return out;
}

class Connection {
  readonly #socket: WebSocket;
  readonly #server: Server;
  readonly #subscriptions = new Map<string, ConversationWatch>();
  readonly #subscriptionIds = new Map<string, string | number>();

  constructor(socket: WebSocket, server: Server) {
    this.#socket = socket;
    this.#server = server;
    socket.on("message", (data, isBinary) => void this.#onMessage(data, isBinary));
    socket.on("close", () => void this.dispose());
    this.send({ type: "hello", version: VERSION, ...server.identity });
  }

  send(message: ServerMessage): void {
    if (this.#socket.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message));
  }

  async dispose(): Promise<void> {
    const streams = [...this.#subscriptions.values()];
    this.#subscriptions.clear();
    this.#subscriptionIds.clear();
    this.#server.connections.delete(this);
    this.#server.settings?.dropOwner(this);
    await Promise.all(streams.map((stream) => stream.stop().catch(() => {})));
  }

  async unsubscribeBot(botId: string): Promise<void> {
    for (const [key, stream] of this.#subscriptions) {
      if (!key.startsWith(`${botId}:`)) continue;
      this.#subscriptions.delete(key);
      this.#subscriptionIds.delete(key);
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
      const afterReply: (() => void)[] = [];
      const result = await this.#handle(parsed.data, afterReply);
      this.send({ type: "result", id: parsed.data.id, data: result });
      for (const start of afterReply) start();
    } catch (error) {
      const message =
        error instanceof NotFoundError || error instanceof Error ? error.message : String(error);
      this.send({ type: "error", ...(id === undefined ? {} : { id }), message });
    }
  }

  #settings(): SettingsService {
    const settings = this.#server.settings;
    if (!settings) throw new Error("settings are not available on this server");
    return settings;
  }

  async #handle(request: Request, afterReply: (() => void)[]): Promise<unknown> {
    const manager = this.#server.manager;
    const bot = (record: BotRecord) =>
      botSummary(record, manager.profiles, manager.modelStatus(record.id));
    const profiles = () => {
      const store = manager.profiles;
      if (!store) throw new Error("model profiles are not available on this server");
      return store;
    };
    const listProfiles = (): ProfilesList => {
      const store = profiles();
      return {
        defaultId: store.defaultId,
        profiles: store.list().map((profile) => describeProfile(profile, store.defaultId)),
      };
    };
    switch (request.type) {
      case "groups.list":
        return { groups: await manager.listGroups() };
      case "groups.create":
        return { group: await manager.createGroup(request.name) };
      case "groups.rename":
        return { group: await manager.renameGroup(request.groupId, request.name) };
      case "groups.delete":
        await manager.deleteGroup(request.groupId);
        return { deleted: true };
      case "groups.reorder":
        return { groups: await manager.reorderGroups(request.groupIds) };
      case "bots.setGroup":
        return { bot: bot(await manager.setGroup(request.botId, request.groupId)) };
      case "woven.status":
        return this.#server.woven?.status() ?? { state: "disconnected", toolCount: 0 };
      case "woven.connect": {
        if (!this.#server.woven) throw new Error("Woven MCP is not available");
        return this.#server.woven.connect(request.endpointURL, request.bearerToken);
      }
      case "woven.disconnect":
        return this.#server.woven?.disconnect() ?? { state: "disconnected", toolCount: 0 };

      case "bots.list":
        return { bots: (await manager.list()).map(bot) };
      case "bots.create":
        return {
          bot: bot(
            await manager.create(
              request.name,
              request.managerId ? { managerId: request.managerId } : {},
            ),
          ),
        };
      case "bots.delete": {
        if ((await manager.record(request.botId)).kind === "admin")
          throw new Error("the Admin Bot cannot be deleted");
        for (const connection of this.#server.connections) {
          await connection.unsubscribeBot(request.botId);
        }
        return { deleted: await manager.delete(request.botId) };
      }
      case "bots.listDeleted":
        return {
          bots: (await manager.listDeleted()).map((record) => ({
            ...bot(record),
            deletedAt: record.deletedAt,
          })),
        };
      case "bots.restore": {
        const restored = await manager.restore(request.botId);
        return restored ? { restored: true, bot: bot(restored) } : { restored: false };
      }
      case "bots.purge":
        return { purged: true, ...(await manager.purge(request.botId)) };
      case "bots.rename":
        return { bot: bot(await manager.rename(request.botId, request.name)) };
      case "bots.setManager":
        return { bot: bot(await manager.setManager(request.botId, request.manager)) };
      case "bots.setTeam":
        return { bot: bot(await manager.setTeam(request.botId, request.managerId ?? undefined)) };
      case "bots.replaceManager":
        return { bot: bot(await manager.replaceManager(request.managerId, request.newManagerId)) };
      case "bots.setOrchestrator": {
        const orchestrator = await manager.setOrchestrator(request.botId ?? undefined);
        return { bot: orchestrator ? bot(orchestrator) : null };
      }
      case "onboarding.status": {
        const admin = await manager.admin();
        if (!admin) throw new Error("this server has no Admin Bot");
        const settings = this.#settings();
        const signedIn = await settings.signedIn();
        const profile = profiles().resolve(manager.assignedProfile(admin.id));
        const mainModelAvailable = await settings.modelAvailable(profile.main);
        const status: OnboardingStatus = {
          adminId: admin.id,
          profileId: profile.id,
          mainModel: profile.main,
          mainModelAvailable,
          signedIn,
          needed: !signedIn || !mainModelAvailable,
        };
        return status;
      }
      case "onboarding.setMainModel": {
        const admin = await manager.admin();
        if (!admin) throw new Error("this server has no Admin Bot");
        this.#settings().checkModel(request.model);
        const store = profiles();
        const profile = store.resolve(manager.assignedProfile(admin.id));
        const saved = await store.save({ ...profile, main: request.model });
        return { profile: describeProfile(saved, store.defaultId) };
      }
      case "profiles.list":
        return listProfiles();
      case "profiles.save": {
        const store = profiles();
        const { profile, create } = request;
        await store.save(
          {
            id: profile.id,
            name: profile.name,
            main: profile.main,
            ...(profile.fallbacks ? { fallbacks: profile.fallbacks } : {}),
            ...(profile.memoryModel ? { memoryModel: profile.memoryModel } : {}),
            pool: profile.pool,
            ...(profile.guidance !== undefined ? { guidance: profile.guidance } : {}),
          },
          { create: create === true },
        );
        return listProfiles();
      }
      case "profiles.delete":
        await profiles().remove(request.profileId);
        return listProfiles();
      case "profiles.setDefault":
        await profiles().setDefault(request.profileId);
        return listProfiles();
      case "bots.setProfile":
        return {
          bot: bot(await manager.setProfile(request.botId, request.profileId ?? undefined)),
        };
      case "memory.list":
        await manager.record(request.botId);
        return { facts: (await manager.registry.memory(request.botId)).facts };
      case "memory.add":
      case "memory.update":
      case "memory.delete": {
        await manager.record(request.botId);
        const edit: MemoryEdit =
          request.type === "memory.add"
            ? { kind: "add", text: request.text }
            : request.type === "memory.update"
              ? { kind: "update", fact: request.fact, text: request.text }
              : { kind: "delete", fact: request.fact };
        const saved = await manager.registry.updateMemory(request.botId, (memory) => ({
          facts: editFacts(memory.facts, edit),
          checkpoint: memory.checkpoint,
        }));
        this.#server.memoryChanged(request.botId);
        return { facts: saved.facts };
      }
      case "account.notes": {
        const note = await manager.registry.note(ACCOUNT_NOTES);
        return note ? { notes: note.text, updatedAt: note.updatedAt } : { notes: "" };
      }
      case "account.setNotes":
        await manager.registry.setNote(ACCOUNT_NOTES, request.notes);
        return { saved: true };
      case "settings.accounts":
        return this.#settings().accounts();
      case "credentials.set":
        await this.#settings().setKey(request.accountId, request.key);
        return { saved: true };
      case "credentials.remove":
        await this.#settings().remove(request.accountId);
        return { removed: true };
      case "login.start": {
        // Events can precede this result; the client buffers them by loginId.
        const loginId = this.#settings().startLogin(
          request.accountId,
          this,
          (id, event) => this.send({ type: "login", loginId: id, event }),
          request.method,
        );
        return { loginId };
      }
      case "login.respond":
        this.#settings().respondLogin(request.loginId, this, request.promptId, request.value);
        return { ok: true };
      case "login.cancel":
        this.#settings().cancelLogin(request.loginId, this);
        return { ok: true };
      case "models.catalog":
        return this.#settings().modelCatalog();
      case "models.setRoles": {
        const { id: _id, type: _type, ...roles } = request;
        return { roles: await this.#settings().setRoles(roles), restartRequired: true };
      }
      case "config.get":
        return this.#settings().readConfig();
      case "config.validate":
        return this.#settings().validateConfig(request.text);
      case "config.save":
        await this.#settings().saveConfig(request.text, { baseRevision: request.baseRevision });
        return { saved: true, restartRequired: true };
      case "config.update":
        await this.#settings().updateConfig(request.edits);
        return { saved: true, restartRequired: true };
      case "github.get":
        return this.#settings().github();
      case "github.setSshKey":
        return { sshKey: await this.#settings().setSshKey(request.privateKey) };
      case "github.generateSshKey":
        return { sshKey: await this.#settings().generateSshKey(request.comment) };
      case "github.removeSshKey":
        await this.#settings().removeSshKey();
        return { removed: true };
      case "github.setIdentity":
        await this.#settings().setGitIdentity(request);
        return { saved: true, restartRequired: true };
      case "server.restart": {
        const restart = this.#server.restart;
        if (!restart) throw new Error("this server was not started with restart support");
        return { restarting: true, ...(await restart()) };
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
        this.#server.threadsChanged(request.botId);
        return { thread: thread(record) };
      }
      case "thread.setPinned": {
        await manager.get(request.botId);
        const record = await manager.registry.setThreadPinned(
          request.botId,
          request.conversationId,
          request.pinned,
        );
        this.#server.threadsChanged(request.botId);
        return { thread: thread(record) };
      }
      case "message.send": {
        const target = await manager.get(request.botId);
        if (request.deliveryId && !(await manager.registry.claimDelivery(request.deliveryId))) {
          return { duplicate: true };
        }
        try {
          const { conversation, submission } = await target.send(
            request.text,
            request.conversationId,
            0,
            request.context,
          );
          if (request.deliveryId) await manager.registry.acceptDelivery(request.deliveryId);
          return { conversationId: conversation.id, submissionId: submission.id };
        } catch (error) {
          if (request.deliveryId) await manager.registry.releaseDelivery(request.deliveryId);
          throw error;
        }
      }
      case "conversation.abort": {
        const target = await manager.get(request.botId);
        const conversation = await target.abort(request.conversationId);
        return { conversationId: conversation.id, stopped: true };
      }
      case "conversation.close": {
        const key = `${request.botId}:${request.conversationId}`;
        if (
          request.subscriptionId !== undefined &&
          this.#subscriptionIds.get(key) !== request.subscriptionId
        )
          return { closed: false };
        const stream = this.#subscriptions.get(key);
        this.#subscriptions.delete(key);
        this.#subscriptionIds.delete(key);
        await stream?.stop();
        return { closed: stream !== undefined };
      }
      case "conversation.open":
        return this.#open(request.botId, request.conversationId, afterReply, request.id);
    }
  }

  async #open(
    botId: string,
    requested: number | undefined,
    afterReply: (() => void)[],
    subscriptionId: string | number,
  ): Promise<ConversationSnapshot> {
    const target = await this.#server.manager.get(botId);
    const main = await target.main();
    const conversation = await target.conversation(requested);
    const key = `${botId}:${conversation.id}`;

    // Watch first, then read history: events after the snapshot are never missed, and the
    // client de-duplicates entries by id.
    const stream = await conversation.watch(ctx, { min: HISTORY_LIMIT, max: HISTORY_LIMIT * 2 });
    if (this.#socket.readyState !== WebSocket.OPEN) {
      await stream.stop();
      throw new Error("connection closed");
    }
    const prior = this.#subscriptions.get(key);
    this.#subscriptions.set(key, stream);
    this.#subscriptionIds.set(key, subscriptionId);
    await prior?.stop();
    const { page, origin } = await Promise.all([
      conversation.entries({}, HISTORY_LIMIT, undefined, ctx),
      conversation.id === main.id
        ? undefined
        : this.#server.manager.registry.getThread(botId, conversation.id),
    ])
      .then(async ([page, record]) => {
        let origin = record ? page.items.find((entry) => entry.id === record.forkedAt) : undefined;
        if (record && !origin) {
          origin = (
            await conversation.entries(
              { minEntryId: toEntryId(record.forkedAt), maxEntryId: toEntryId(record.forkedAt) },
              1,
              undefined,
              ctx,
            )
          ).items[0];
        }
        return { page, origin: origin ? displayEntry(origin) : undefined };
      })
      .catch(async (error) => {
        await stream.stop();
        if (this.#subscriptions.get(key) === stream) {
          this.#subscriptions.delete(key);
          this.#subscriptionIds.delete(key);
        }
        throw error;
      });
    const entries = page.items
      .map(displayEntry)
      .filter((entry): entry is DisplayEntry => entry !== undefined)
      .reverse();

    const conversationId = conversation.id;
    let previous = stream.value;
    afterReply.push(() => {
      if (this.#subscriptions.get(key) !== stream) return;
      stream.start(async (call) => {
        if (this.#subscriptions.get(key) !== stream) return;
        if (call.kind === "failed") {
          this.send({
            type: "event",
            botId,
            conversationId,
            event: { kind: "error", message: "Conversation updates temporarily unavailable" },
          });
          return;
        }
        let current = call.value;
        const last = previous.entries.at(-1)?.id;
        // Recover entries skipped when a slow listener falls behind the window.
        if (current.before !== undefined && (last === undefined || current.before > last)) {
          const recovered = [];
          let cursor: import("@earendil-works/pi-durable").Cursor | undefined;
          do {
            const page = await conversation.entries(
              {
                ...(last === undefined ? {} : { minEntryId: last }),
                maxEntryId: current.before,
                order: "ascending",
              },
              HISTORY_LIMIT,
              cursor,
              ctx,
            );
            recovered.push(...page.items);
            cursor = page.next;
          } while (cursor !== undefined);
          current = { ...current, entries: [...recovered, ...current.entries] };
        }
        for (const event of streamEvents(previous, current)) {
          this.send({ type: "event", botId, conversationId, event });
        }
        previous = call.value;
      });
    });
    void stream.closed.then((end) => {
      if (this.#subscriptions.get(key) !== stream) return;
      this.#subscriptions.delete(key);
      this.#subscriptionIds.delete(key);
      // Reconnect reloads both the snapshot and its subscription after a failed watch.
      if (end.kind !== "stopped" && this.#socket.readyState === WebSocket.OPEN)
        this.#socket.close(1012, "Conversation subscription ended");
    });

    const streaming = assistantText(
      (stream.value.docs["pi.live"] as LiveState | undefined)?.generation?.message,
    );
    return {
      botId,
      conversationId,
      subscriptionId,
      mainConversationId: main.id,
      ...(origin ? { threadOrigin: origin } : {}),
      entries,
      running: (stream.value.docs["pi.live"] as LiveState | undefined)?.run !== undefined,
      ...(streaming ? { streaming } : {}),
    };
  }
}

class Server {
  readonly manager: BotManager;
  readonly settings: SettingsService | undefined;
  readonly restart: (() => Promise<RestartAccepted>) | undefined;
  readonly connections = new Set<Connection>();
  readonly identity: { protocol: number; installationId: string; capabilities: string[] };
  readonly woven: WovenMCP | undefined;

  constructor(
    manager: BotManager,
    installationId: string,
    woven: WovenMCP | undefined,
    settings?: SettingsService,
    restart?: () => Promise<RestartAccepted>,
  ) {
    this.manager = manager;
    this.identity = { protocol: PROTOCOL, installationId, capabilities: [...CAPABILITIES] };
    this.woven = woven;
    this.settings = settings;
    this.restart = restart;
  }

  threadsChanged(botId: string): void {
    for (const connection of this.connections) connection.send({ type: "threads.changed", botId });
  }

  memoryChanged(botId: string): void {
    for (const connection of this.connections) connection.send({ type: "memory.changed", botId });
  }
}

export async function startServer(options: PiBotServerOptions): Promise<PiBotServer> {
  if (!isAllowedBindHost(options.host)) {
    throw new Error(`refusing to bind ${options.host}: use loopback or a tailnet address`);
  }
  const state = new Server(
    options.manager,
    await options.manager.registry.installationId(),
    options.woven,
    options.settings,
    options.restart,
  );
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
        response.end(JSON.stringify({ ok: true, version: VERSION, ...state.identity }));
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
    botsChanged() {
      for (const connection of state.connections) connection.send({ type: "bots.changed" });
    },
    groupsChanged() {
      for (const connection of state.connections) connection.send({ type: "groups.changed" });
    },
    threadsChanged: (botId) => state.threadsChanged(botId),
    memoryChanged: (botId) => state.memoryChanged(botId),
    async close() {
      await Promise.all([...state.connections].map((connection) => connection.dispose()));
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((done) => http.close(() => done()));
    },
  };
}
