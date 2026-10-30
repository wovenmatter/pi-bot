import { type FormEvent, useState } from "react";
import { Loading } from "../../components/ui.tsx";
import type { BotSummary, ProfileSummary } from "../../protocol.ts";

/** What a bot does, separate from its name. */
export type Role = "Admin" | "Orchestrator" | "Manager" | "Bot";

export const roleOf = (bot: BotSummary): Role =>
  bot.kind === "admin"
    ? "Admin"
    : bot.orchestrator
      ? "Orchestrator"
      : bot.manager
        ? "Manager"
        : "Bot";

/** A bot's place: "none" (no team), "manager" (leads a team) or the id of its manager. */
export type Placement = "none" | "manager" | string;

export const placementOf = (bot: BotSummary): Placement =>
  bot.manager ? "manager" : (bot.managerId ?? "none");

/**
 * Settings → Bots: one row per bot with its profile ("" = the default profile) and its team.
 * Teams are one level; Admin Bot is never on one. One bot may optionally be the orchestrator: listed
 * first, above every team, never on a team itself (it may lead its own).
 */
export function BotsPanel({
  bots,
  profiles,
  disabled,
  onSetProfile,
  onPlace,
  onReplaceManager,
  onSetOrchestrator,
  onRename,
}: {
  bots: readonly BotSummary[] | undefined;
  profiles: readonly ProfileSummary[] | undefined;
  disabled?: boolean;
  onSetProfile: (bot: BotSummary, profileId: string | null) => void;
  onPlace: (bot: BotSummary, placement: Placement) => void;
  onReplaceManager: (manager: BotSummary, newManagerId: string) => void;
  /** Make a bot the orchestrator (replacing any other), or clear the slot with null. */
  onSetOrchestrator: (botId: string | null) => void;
  /** Rename a bot (never Admin Bot, whose name is fixed). */
  onRename: (bot: BotSummary, name: string) => void;
}) {
  if (bots === undefined || profiles === undefined) return <Loading />;
  const fallback = profiles.find((profile) => profile.default);
  const managers = bots.filter((bot) => bot.kind !== "admin" && bot.manager);
  const candidates = bots.filter((bot) => bot.kind !== "admin");
  const orchestrator = candidates.find((bot) => bot.orchestrator);
  const rank = (bot: BotSummary) => (bot.kind === "admin" ? 0 : bot.orchestrator ? 1 : 2);
  const rows = [...bots].sort((a, b) => rank(a) - rank(b));
  return (
    <section className="settings-section" aria-labelledby="bots-heading">
      <h3 id="bots-heading">Bots</h3>
      <p className="muted">
        Each bot's name, role, profile and team. Teams are optional and one level deep: a manager
        hands work to the bots on its team. An orchestrator is optional and oversees every bot and
        team. Admin Bot's name is fixed; rename any other bot here or by asking it or Admin Bot.
      </p>
      <div className="settings-fields">
        <label className="settings-field">
          <span>
            Orchestrator
            <small className="muted">Optional. Sits above every team; Admin Bot stays apart.</small>
          </span>
          <select
            aria-label="Orchestrator"
            value={orchestrator?.id ?? ""}
            disabled={disabled}
            onChange={(event) => onSetOrchestrator(event.target.value || null)}
          >
            <option value="">None</option>
            {candidates.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="bots-table">
        <div className="bots-table-head" aria-hidden="true">
          <span>Bot</span>
          <span>Profile</span>
          <span>Team</span>
        </div>
        <ul className="settings-list">
          {rows.map((bot) => {
            const admin = bot.kind === "admin";
            const members = bots.filter((other) => other.managerId === bot.id);
            return (
              <li key={bot.id} className="bot-row">
                <BotName
                  bot={bot}
                  disabled={disabled}
                  onRename={onRename}
                  note={
                    admin
                      ? "Accounts and config"
                      : bot.orchestrator && !(bot.manager && members.length)
                        ? "Oversees every bot and team"
                        : bot.manager
                          ? members.length
                            ? `Team: ${members.map((member) => member.name).join(", ")}`
                            : "No members yet"
                          : undefined
                  }
                />
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
                    <option value="manager">Manager</option>
                    {managers
                      .filter((manager) => manager.id !== bot.id && !bot.orchestrator)
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

/** A bot's name, role and note; any bot but Admin Bot can be renamed in place. */
function BotName({
  bot,
  note,
  disabled,
  onRename,
}: {
  bot: BotSummary;
  note: string | undefined;
  disabled: boolean | undefined;
  onRename: (bot: BotSummary, name: string) => void;
}) {
  const [draft, setDraft] = useState<string>();
  const admin = bot.kind === "admin";
  if (draft !== undefined && !admin) {
    const name = draft.trim();
    const submit = (event: FormEvent) => {
      event.preventDefault();
      if (name && name !== bot.name) onRename(bot, name);
      setDraft(undefined);
    };
    return (
      <form className="bot-rename" onSubmit={submit}>
        <input
          aria-label={`New name for ${bot.name}`}
          value={draft}
          maxLength={80}
          // biome-ignore lint/a11y/noAutofocus: the user just asked to rename this bot.
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setDraft(undefined);
          }}
        />
        <button type="submit" className="secondary" disabled={disabled || !name}>
          Save
        </button>
        <button type="button" className="text-button" onClick={() => setDraft(undefined)}>
          Cancel
        </button>
      </form>
    );
  }
  return (
    <div className="settings-row-text">
      <strong>
        {bot.name}
        <span className="badge">{roleOf(bot)}</span>
      </strong>
      <small className="muted">
        {note}
        {note && !admin ? " · " : null}
        {admin ? null : (
          <button
            type="button"
            className="link-button"
            aria-label={`Rename ${bot.name}`}
            disabled={disabled}
            onClick={() => setDraft(bot.name)}
          >
            Rename
          </button>
        )}
      </small>
    </div>
  );
}
