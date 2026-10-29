import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { BotManager } from "./bots.ts";
import type { RestartAccepted } from "./server.ts";
import type { SettingsService } from "./settings/service.ts";
import type { BotRecord } from "./storage/registry.ts";

/**
 * What bot tools reach: the bot manager, and (for Admin) settings and restart. Late-bound,
 * because the app opens the manager before settings and the server exist.
 */
export type BotPlatform = {
  readonly manager: () => BotManager;
  readonly settings?: () => SettingsService | undefined;
  readonly restart?: () => Promise<RestartAccepted>;
  /** `[bot_to_bot] max_messages_per_hour_per_pair`: a guard against runaway bot loops. */
  readonly maxMessagesPerHourPerPair?: number;
};

type Result = { output: { type: "text"; text: string }[]; isError?: boolean };

const text = (value: unknown): Result => ({
  output: [
    { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
  ],
});

async function run(body: () => Promise<unknown>): Promise<Result> {
  try {
    return text(await body());
  } catch (error) {
    return { ...text(error instanceof Error ? error.message : String(error)), isError: true };
  }
}

/** How a bot appears to other bots. */
export function describeBot(record: BotRecord) {
  return {
    id: record.id,
    name: record.name,
    ...(record.kind === "admin" ? { admin: true } : {}),
    ...(record.manager ? { manager: true } : {}),
    ...(record.managerId ? { managerId: record.managerId } : {}),
  };
}

/** Sliding one-hour window of bot-to-bot messages per (sender, target) pair. */
export class MessageLimiter {
  readonly #sent = new Map<string, number[]>();
  readonly #limit: number;
  readonly #now: () => number;

  constructor(limit: number, now: () => number = Date.now) {
    this.#limit = limit;
    this.#now = now;
  }

  take(from: string, to: string): boolean {
    const key = `${from}>${to}`;
    const now = this.#now();
    const recent = (this.#sent.get(key) ?? []).filter((at) => now - at < 3_600_000);
    if (recent.length >= this.#limit) {
      this.#sent.set(key, recent);
      return false;
    }
    recent.push(now);
    this.#sent.set(key, recent);
    return true;
  }
}

const limiters = new WeakMap<BotPlatform, MessageLimiter>();

function limiter(platform: BotPlatform): MessageLimiter {
  let found = limiters.get(platform);
  if (!found) {
    found = new MessageLimiter(platform.maxMessagesPerHourPerPair ?? 30);
    limiters.set(platform, found);
  }
  return found;
}

/** Tools every bot has: list bots, create a bot, message a bot. */
function commonTools(botId: string, platform: BotPlatform) {
  return [
    defineTool({
      name: "list_bots",
      description:
        "List every bot on this Pi Bot: id, name, whether it is Admin or a team manager, and its manager.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: () => run(async () => (await platform.manager().list()).map(describeBot)),
    }),
    defineTool({
      name: "create_bot",
      description:
        "Create a new bot when the user asks for one. A bot created by a team manager or a team member joins that team automatically.",
      parameters: Type.Object({
        name: Type.String({ description: "Name of the new bot (1-80 characters)" }),
      }),
      execute: (args) =>
        run(async () =>
          describeBot(await platform.manager().create(args.name, { createdBy: botId })),
        ),
    }),
    defineTool({
      name: "message_bot",
      description:
        "Send a message to another bot's main channel. It is queued if that bot is busy and does not wait for a reply; the other bot can answer with message_bot.",
      parameters: Type.Object({
        botId: Type.String({ description: "Target bot id (from list_bots)" }),
        text: Type.String({ description: "The message" }),
      }),
      execute: (args) =>
        run(async () => {
          if (args.botId === botId) throw new Error("a bot cannot message itself");
          const manager = platform.manager();
          const sender = await manager.record(botId);
          const target = await manager.get(args.botId);
          if (!limiter(platform).take(botId, args.botId)) {
            throw new Error(
              `message limit reached: at most ${platform.maxMessagesPerHourPerPair ?? 30} messages per hour to ${target.record.name}`,
            );
          }
          await target.send(`[Message from bot "${sender.name}" (id ${sender.id})]\n${args.text}`);
          return `Delivered to ${target.record.name}.`;
        }),
    }),
  ];
}

/** Non-Admin bots: start a team under themselves and add or remove members. */
function teamTools(botId: string, platform: BotPlatform) {
  return [
    defineTool({
      name: "my_team",
      description:
        "Manage your own team when the user asks. start: become a team manager (you leave any team you are on). add/remove: put another bot on or off your team (you must be a manager). stop: stop managing (your team is ungrouped).",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("start"),
          Type.Literal("add"),
          Type.Literal("remove"),
          Type.Literal("stop"),
        ]),
        botId: Type.Optional(Type.String({ description: "The bot to add or remove" })),
      }),
      execute: (args) =>
        run(async () => {
          const manager = platform.manager();
          if (args.action === "start") return describeBot(await manager.setManager(botId, true));
          if (args.action === "stop") return describeBot(await manager.setManager(botId, false));
          if (!args.botId) throw new Error("botId is required");
          const self = await manager.record(botId);
          if (!self.manager) throw new Error("you are not a team manager; start a team first");
          if (args.action === "add") return describeBot(await manager.setTeam(args.botId, botId));
          const member = await manager.record(args.botId);
          if (member.managerId !== botId) throw new Error(`${member.name} is not on your team`);
          return describeBot(await manager.setTeam(args.botId, undefined));
        }),
    }),
  ];
}

/** Admin only: teams on the user's behalf, its own model, and account/config management. */
function adminTools(botId: string, platform: BotPlatform) {
  const settings = () => {
    const found = platform.settings?.();
    if (!found) throw new Error("settings are not available on this server");
    return found;
  };
  return [
    defineTool({
      name: "set_team",
      description:
        "Organize teams for the user. promote/demote: make a bot a team manager or not (demoting ungroups its team). join: put botId on managerId's team. leave: take botId off its team. replace_manager: make botId the new manager of managerId's team (the old manager stays as a member).",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("promote"),
          Type.Literal("demote"),
          Type.Literal("join"),
          Type.Literal("leave"),
          Type.Literal("replace_manager"),
        ]),
        botId: Type.String(),
        managerId: Type.Optional(Type.String()),
      }),
      execute: (args) =>
        run(async () => {
          const manager = platform.manager();
          switch (args.action) {
            case "promote":
              return describeBot(await manager.setManager(args.botId, true));
            case "demote":
              return describeBot(await manager.setManager(args.botId, false));
            case "leave":
              return describeBot(await manager.setTeam(args.botId, undefined));
            case "join":
            case "replace_manager": {
              if (!args.managerId) throw new Error("managerId is required");
              return describeBot(
                args.action === "join"
                  ? await manager.setTeam(args.botId, args.managerId)
                  : await manager.replaceManager(args.managerId, args.botId),
              );
            }
          }
        }),
    }),
    defineTool({
      name: "settings_status",
      description:
        "Read the current setup: which provider accounts and search keys are configured (never the secrets), model roles, available models, GitHub key and identity, and whether a restart is pending.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: () =>
        run(async () => {
          const service = settings();
          const [accounts, catalog, github] = await Promise.all([
            service.accounts(),
            service.modelCatalog(),
            service.github(),
          ]);
          const admin = await platform.manager().record(botId);
          return {
            accounts: accounts.accounts.map((a) => ({
              id: a.id,
              label: a.label,
              configured: a.configured,
            })),
            search: {
              provider: accounts.search.provider,
              configured: accounts.search.providers.filter((p) => p.configured).map((p) => p.id),
            },
            roles: catalog.roles,
            adminModel: admin.model ?? null,
            models: catalog.providers.map((p) => ({
              provider: p.id,
              models: p.models.map((m) => `${p.id}/${m.id}`),
            })),
            github: {
              sshKey: github.sshKey ? "configured" : "none",
              identity: github.identity,
            },
            restartRequired: service.restartRequired,
            configPath: service.configPath ?? null,
          };
        }),
    }),
    defineTool({
      name: "read_config",
      description: "Read config.toml (it holds no secrets).",
      parameters: Type.Object({}),
      replay: "safe",
      execute: () => run(async () => (await settings().readConfig()).text),
    }),
    defineTool({
      name: "update_config",
      description:
        'Set values in config.toml, e.g. path ["models","orchestrator"]. Validated before saving; applies after restart_server. Confirm with the user first unless they asked for this change.',
      parameters: Type.Object({
        edits: Type.Array(
          Type.Object({
            path: Type.Array(Type.String()),
            value: Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
          }),
        ),
      }),
      execute: (args) =>
        run(async () => {
          await settings().updateConfig(args.edits);
          return "Saved config.toml. Restart (restart_server) to apply.";
        }),
    }),
    defineTool({
      name: "restart_server",
      description:
        "Restart Pi Bot so saved config applies (Settings → Restart and apply). Running work resumes after the restart. Confirm with the user first unless they asked for it.",
      parameters: Type.Object({}),
      execute: () =>
        run(async () => {
          if (!platform.restart)
            throw new Error("this server was not started with restart support");
          const accepted = await platform.restart();
          return `Restarting (${accepted.mode}); ${accepted.activeWork} live run(s) resume afterwards.`;
        }),
    }),
    defineTool({
      name: "set_my_model",
      description:
        "Change the model you (Admin) use, as provider/modelId from settings_status. Applies from your next reply.",
      parameters: Type.Object({ model: Type.String() }),
      execute: (args) =>
        run(async () => {
          settings().checkModel(args.model);
          await platform.manager().setModel(botId, args.model);
          return `Admin now uses ${args.model}.`;
        }),
    }),
  ];
}

/** The `pi-bot-tools` extension for one bot. */
export function botTools(record: BotRecord, platform: BotPlatform): Extension {
  return defineExtension({
    name: "pi-bot-tools",
    tools: [
      ...commonTools(record.id, platform),
      ...(record.kind === "admin"
        ? adminTools(record.id, platform)
        : teamTools(record.id, platform)),
    ],
  });
}
