import type { BotSummary } from "../protocol.ts";

export type BotGroups = {
  admin?: BotSummary;
  /** The optional orchestrator, with its own team's members if it leads one. */
  orchestrator?: { bot: BotSummary; members: BotSummary[] };
  /** Managers in list order, each with its members. */
  teams: { manager: BotSummary; members: BotSummary[] }[];
  /** Bots on no team (and members whose manager is missing). */
  ungrouped: BotSummary[];
};

/**
 * Sidebar order: Admin Bot pinned first, then the orchestrator (with its own team, if any), then each
 * team under its manager, then the rest.
 */
export function groupBots(bots: readonly BotSummary[]): BotGroups {
  const admin = bots.find((bot) => bot.kind === "admin");
  const orchestrator = bots.find((bot) => bot.kind !== "admin" && bot.orchestrator);
  const managers = bots.filter((bot) => bot.kind !== "admin" && bot.manager);
  const ids = new Set(managers.map((bot) => bot.id));
  const membersOf = (manager: BotSummary) =>
    bots.filter((bot) => bot.managerId === manager.id && !bot.manager && bot !== orchestrator);
  return {
    ...(admin ? { admin } : {}),
    ...(orchestrator
      ? {
          orchestrator: {
            bot: orchestrator,
            members: orchestrator.manager ? membersOf(orchestrator) : [],
          },
        }
      : {}),
    teams: managers
      .filter((manager) => manager !== orchestrator)
      .map((manager) => ({ manager, members: membersOf(manager) })),
    ungrouped: bots.filter(
      (bot) =>
        bot.kind !== "admin" &&
        bot !== orchestrator &&
        !bot.manager &&
        !(bot.managerId && ids.has(bot.managerId)),
    ),
  };
}
