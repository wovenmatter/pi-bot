import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { BotManager } from "./bots.ts";
import { describeProfile, type ProfileStore } from "./profiles.ts";
import type { RestartAccepted } from "./server.ts";
import type { SettingsService } from "./settings/service.ts";
import type { BotRecord } from "./storage/registry.ts";

/**
 * What bot tools reach: the bot manager, and (for Admin Bot) settings and restart. Late-bound,
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
        "List every bot on this Pi Bot: id, name, whether it is Admin Bot or a team manager, and its manager.",
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

/** Non-Admin Bots: start a team under themselves and add or remove members. */
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

/** Admin Bot only: teams on the user's behalf, model profiles, and account/config management. */
function adminTools(platform: BotPlatform) {
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
        "Read the current setup: which provider accounts and search keys are configured (never the secrets), the title model, available models, GitHub key and identity, and whether a restart is pending. Model profiles: list_profiles.",
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
            titles: { model: catalog.roles.titles, reasoning: catalog.roles.titlesReasoning },
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
        'Set values in config.toml, e.g. path ["models","titles","model"]. Use the profile tools for model profiles. Validated before saving; applies after restart_server. Confirm with the user first unless they asked for this change.',
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
    ...profileTools(platform, settings),
  ];
}

const poolEntry = Type.Object({
  model: Type.String({ description: "provider/model-id" }),
  useFor: Type.String({ description: "What this model is good for, shown to the main model" }),
  background: Type.Optional(
    Type.Boolean({ description: "Use it for background work (at most one per profile)" }),
  ),
});

/** Admin Bot: model profiles, which bot runs which, and the user's account notes. */
function profileTools(platform: BotPlatform, settings: () => SettingsService) {
  const store = (): ProfileStore => {
    const found = platform.manager().profiles;
    if (!found) throw new Error("model profiles are not available on this server");
    return found;
  };
  const confirm = "Confirm with the user first unless they asked for this change.";
  return [
    defineTool({
      name: "list_profiles",
      description:
        "List the model profiles (main model, its ordered fallbacks, pool models with their use-for notes, guidance), which is the default, and which profile each bot runs.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: () =>
        run(async () => {
          const profiles = store();
          const manager = platform.manager();
          return {
            defaultProfile: profiles.defaultId,
            profiles: profiles.list().map((p) => describeProfile(p, profiles.defaultId)),
            bots: (await manager.list()).map((bot) => ({
              id: bot.id,
              name: bot.name,
              profile: profiles.resolve(bot.profile).id,
              ...(bot.profile ? {} : { usesDefault: true }),
            })),
          };
        }),
    }),
    defineTool({
      name: "save_profile",
      description: `Create (create: true) or replace a model profile. main runs the main channel and threads of every bot on it; fallbacks (optional, ordered, at most 5) are main models to switch to when main hits a usage limit or runs out of credits (none: the bot pauses until the limit resets); pool lists the models the main model may hand work to with run_subagent. Models must be listed by settings_status. Changes apply from each bot's next reply. ${confirm}`,
      parameters: Type.Object({
        id: Type.String({ description: "lowercase letters, digits, - and _" }),
        name: Type.String(),
        main: Type.String({ description: "provider/model-id" }),
        fallbacks: Type.Optional(
          Type.Array(Type.String({ description: "provider/model-id" }), {
            maxItems: 5,
            description: "Ordered main-model fallbacks for usage limits; omit or [] for none",
          }),
        ),
        pool: Type.Array(poolEntry),
        guidance: Type.Optional(
          Type.String({ description: "When to use which pool model or reasoning level" }),
        ),
        create: Type.Optional(Type.Boolean()),
      }),
      execute: (args) =>
        run(async () => {
          const service = settings();
          service.checkModel(args.main);
          for (const ref of args.fallbacks ?? []) service.checkModel(ref);
          for (const entry of args.pool) service.checkModel(entry.model);
          const profiles = store();
          const saved = await profiles.save(
            {
              id: args.id,
              name: args.name,
              main: args.main,
              ...(args.fallbacks ? { fallbacks: args.fallbacks } : {}),
              pool: args.pool,
              ...(args.guidance !== undefined ? { guidance: args.guidance } : {}),
            },
            { create: args.create === true },
          );
          return describeProfile(saved, profiles.defaultId);
        }),
    }),
    defineTool({
      name: "delete_profile",
      description: `Delete a model profile (not the default). Bots on it go back to the default profile. ${confirm}`,
      parameters: Type.Object({ id: Type.String() }),
      execute: (args) =>
        run(async () => {
          await store().remove(args.id);
          return `Deleted profile "${args.id}".`;
        }),
    }),
    defineTool({
      name: "set_default_profile",
      description: `Make a profile the default: every bot without its own profile, and every new bot, runs it. ${confirm}`,
      parameters: Type.Object({ id: Type.String() }),
      execute: (args) =>
        run(async () => {
          await store().setDefault(args.id);
          return `"${args.id}" is now the default profile.`;
        }),
    }),
    defineTool({
      name: "set_bot_profile",
      description: `Choose which profile a bot runs (bot ids from list_bots); omit profileId for the default. Applies from the bot's next reply. ${confirm}`,
      parameters: Type.Object({
        botId: Type.String(),
        profileId: Type.Optional(Type.String()),
      }),
      execute: (args) =>
        run(async () => {
          const record = await platform.manager().setProfile(args.botId, args.profileId);
          return `${record.name} now runs profile "${store().resolve(record.profile).id}".`;
        }),
    }),
    defineTool({
      name: "read_account_notes",
      description:
        "Read the account notes: the user's subscriptions and tiers, API keys, and rough monthly comfort spend (guidance for model choices, not hard caps).",
      parameters: Type.Object({}),
      replay: "safe",
      execute: () =>
        run(async () => {
          const note = await platform.manager().registry.note(ACCOUNT_NOTES);
          return note ? { notes: note.text, updatedAt: note.updatedAt } : "No account notes yet.";
        }),
    }),
    defineTool({
      name: "write_account_notes",
      description:
        "Replace the account notes with the full text (plans and tiers, API keys by name only, comfort spend). Never include secrets.",
      parameters: Type.Object({ notes: Type.String() }),
      execute: (args) =>
        run(async () => {
          if (args.notes.length > 8000) throw new Error("account notes are too long (max 8000)");
          await platform.manager().registry.setNote(ACCOUNT_NOTES, args.notes);
          return "Saved the account notes.";
        }),
    }),
  ];
}

/** The account notes record (`pibot_notes`). */
export const ACCOUNT_NOTES = "account";

/** The `pi-bot-tools` extension for one bot. */
export function botTools(record: BotRecord, platform: BotPlatform): Extension {
  return defineExtension({
    name: "pi-bot-tools",
    tools: [
      ...commonTools(record.id, platform),
      ...(record.kind === "admin" ? adminTools(platform) : teamTools(record.id, platform)),
    ],
  });
}
