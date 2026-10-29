import type { BotSummary } from "../protocol.ts";

export type BotGroups = {
  admin?: BotSummary;
  /** Managers in list order, each with its members. */
  teams: { manager: BotSummary; members: BotSummary[] }[];
  /** Bots on no team (and members whose manager is missing). */
  ungrouped: BotSummary[];
};

/** Sidebar order: Admin pinned first, then each team under its manager, then the rest. */
export function groupBots(bots: readonly BotSummary[]): BotGroups {
  const admin = bots.find((bot) => bot.kind === "admin");
  const managers = bots.filter((bot) => bot.kind !== "admin" && bot.manager);
  const ids = new Set(managers.map((bot) => bot.id));
  return {
    ...(admin ? { admin } : {}),
    teams: managers.map((manager) => ({
      manager,
      members: bots.filter((bot) => bot.managerId === manager.id && !bot.manager),
    })),
    ungrouped: bots.filter(
      (bot) => bot.kind !== "admin" && !bot.manager && !(bot.managerId && ids.has(bot.managerId)),
    ),
  };
}
