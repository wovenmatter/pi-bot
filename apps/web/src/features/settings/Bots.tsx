import { Loading } from "../../components/ui.tsx";
import type { BotSummary, ProfileSummary } from "../../protocol.ts";

/** A bot's place: "none" (no team), "manager" (leads a team) or the id of its manager. */
export type Placement = "none" | "manager" | string;

export const placementOf = (bot: BotSummary): Placement =>
  bot.manager ? "manager" : (bot.managerId ?? "none");

/**
 * Settings → Bots: one row per bot with its profile ("" = the default profile) and its team.
 * Teams are one level; Admin Bot is never on one.
 */
export function BotsPanel({
  bots,
  profiles,
  disabled,
  onSetProfile,
  onPlace,
  onReplaceManager,
}: {
  bots: readonly BotSummary[] | undefined;
  profiles: readonly ProfileSummary[] | undefined;
  disabled?: boolean;
  onSetProfile: (bot: BotSummary, profileId: string | null) => void;
  onPlace: (bot: BotSummary, placement: Placement) => void;
  onReplaceManager: (manager: BotSummary, newManagerId: string) => void;
}) {
  if (bots === undefined || profiles === undefined) return <Loading />;
  const fallback = profiles.find((profile) => profile.default);
  const managers = bots.filter((bot) => bot.kind !== "admin" && bot.manager);
  return (
    <section className="settings-section" aria-labelledby="bots-heading">
      <h3 id="bots-heading">Bots</h3>
      <p className="muted">
        Each bot's profile and team. Teams are optional and one level deep: a manager hands work to
        the bots on its team.
      </p>
      <div className="bots-table">
        <div className="bots-table-head" aria-hidden="true">
          <span>Bot</span>
          <span>Profile</span>
          <span>Team</span>
        </div>
        <ul className="settings-list">
          {bots.map((bot) => {
            const admin = bot.kind === "admin";
            const members = bots.filter((other) => other.managerId === bot.id);
            return (
              <li key={bot.id} className="bot-row">
                <div className="settings-row-text">
                  <strong>{bot.name}</strong>
                  {admin ? (
                    <small className="muted">Accounts and config</small>
                  ) : bot.manager ? (
                    <small className="muted">
                      {members.length
                        ? `Team: ${members.map((member) => member.name).join(", ")}`
                        : "No members yet"}
                    </small>
                  ) : null}
                </div>
                <select
                  aria-label={`Profile for ${bot.name}`}
                  value={bot.defaultProfile ? "" : bot.profileId}
                  disabled={disabled}
                  onChange={(event) => onSetProfile(bot, event.target.value || null)}
                >
                  <option value="">Default ({fallback?.name ?? "none"})</option>
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
                {admin ? (
                  <span className="bot-row-note muted">Never on a team</span>
                ) : (
                  <select
                    aria-label={`Team for ${bot.name}`}
                    value={placementOf(bot)}
                    disabled={disabled}
                    onChange={(event) => onPlace(bot, event.target.value)}
                  >
                    <option value="none">No team</option>
                    <option value="manager">Leads a team</option>
                    {managers
                      .filter((manager) => manager.id !== bot.id)
                      .map((manager) => (
                        <option key={manager.id} value={manager.id}>
                          On {manager.name}'s team
                        </option>
                      ))}
                  </select>
                )}
                {!admin && bot.manager && members.length ? (
                  <select
                    className="bot-row-handoff"
                    aria-label={`Hand ${bot.name}'s team to`}
                    value=""
                    disabled={disabled}
                    onChange={(event) => {
                      if (event.target.value) onReplaceManager(bot, event.target.value);
                    }}
                  >
                    <option value="">Hand team to…</option>
                    {members.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name}
                      </option>
                    ))}
                  </select>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
