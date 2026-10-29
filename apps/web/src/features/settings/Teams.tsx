import { Loading } from "../../components/ui.tsx";
import type { BotSummary } from "../../protocol.ts";

/** A bot's place: "none" (no team), "manager" (leads a team) or the id of its manager. */
export type Placement = "none" | "manager" | string;

export const placementOf = (bot: BotSummary): Placement =>
  bot.manager ? "manager" : (bot.managerId ?? "none");

/** Settings → Bots: one-level teams. Admin Bot is never on a team, so it is not listed. */
export function TeamsPanel({
  bots,
  disabled,
  onPlace,
  onReplaceManager,
}: {
  bots: readonly BotSummary[] | undefined;
  disabled?: boolean;
  onPlace: (bot: BotSummary, placement: Placement) => void;
  onReplaceManager: (manager: BotSummary, newManagerId: string) => void;
}) {
  const teamable = bots?.filter((bot) => bot.kind !== "admin");
  const managers = teamable?.filter((bot) => bot.manager) ?? [];
  return (
    <section className="settings-section" aria-labelledby="teams-heading">
      <h3 id="teams-heading">Teams</h3>
      <p className="muted">
        Optional, one level: a manager assigns work to the bots on its team. Bots a manager or team
        member creates join that team. You can also ask Admin Bot or a bot to set this up.
      </p>
      {teamable === undefined ? (
        <Loading />
      ) : teamable.length === 0 ? (
        <p className="settings-empty muted">No bots yet. Create one, or ask Admin Bot.</p>
      ) : (
        <div className="settings-fields">
          {teamable.map((bot) => {
            const members = teamable.filter((other) => other.managerId === bot.id);
            return (
              <div key={bot.id} className="settings-field">
                <span>
                  <strong>{bot.name}</strong>
                  {bot.manager ? (
                    <small className="muted">
                      {members.length
                        ? `Team: ${members.map((member) => member.name).join(", ")}`
                        : "No members yet"}
                    </small>
                  ) : null}
                </span>
                <span className="team-controls">
                  <select
                    aria-label={`Team for ${bot.name}`}
                    value={placementOf(bot)}
                    disabled={disabled}
                    onChange={(event) => onPlace(bot, event.target.value)}
                  >
                    <option value="none">No team</option>
                    <option value="manager">Manages a team</option>
                    {managers
                      .filter((manager) => manager.id !== bot.id)
                      .map((manager) => (
                        <option key={manager.id} value={manager.id}>
                          On {manager.name}'s team
                        </option>
                      ))}
                  </select>
                  {bot.manager && members.length ? (
                    <select
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
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
