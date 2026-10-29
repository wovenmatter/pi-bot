import { Bot, MessageSquare, Plus, Settings, ShieldCheck, Trash2, Users } from "lucide-react";
import { type FormEvent, useState } from "react";
import type { ConnectionState } from "../api.ts";
import { Brand } from "../components/Brand.tsx";
import { Icon } from "../components/Icon.tsx";
import type { BotSummary } from "../protocol.ts";
import { routeHref } from "../routes.ts";
import { THEMES, type Theme } from "../theme.ts";
import { groupBots } from "./bot-groups.ts";

export function Sidebar({
  bots,
  botId,
  conversationId,
  mainConversationId,
  settings,
  connection,
  theme,
  onTheme,
  onCreate,
  onDelete,
}: {
  bots: BotSummary[];
  botId?: string;
  conversationId?: number;
  mainConversationId?: number;
  settings?: boolean;
  connection: ConnectionState;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  onCreate: (name: string) => Promise<void>;
  onDelete: (bot: BotSummary) => void;
}) {
  const [creatingOpen, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const creating = creatingOpen || bots.length === 0;
  const selected = settings ? undefined : bots.find((bot) => bot.id === botId);
  const onMain = conversationId === undefined || conversationId === mainConversationId;
  const groups = groupBots(bots);

  function botRow(bot: BotSummary, member = false) {
    const active = !settings && bot.id === botId;
    const icon = bot.kind === "admin" ? ShieldCheck : bot.manager ? Users : Bot;
    return (
      <div key={bot.id} className={member ? "rail-row rail-member" : "rail-row"}>
        <a
          href={routeHref({ botId: bot.id })}
          className={`nav-link${active ? " active" : ""}`}
          aria-current={active ? "page" : undefined}
          title={bot.kind === "admin" ? "Admin: accounts, models and config" : undefined}
        >
          <Icon icon={icon} />
          <span className="rail-title">{bot.name}</span>
        </a>
        {bot.kind === "admin" ? null : (
          <button
            type="button"
            className="rail-action reveal"
            aria-label={`Delete ${bot.name}`}
            title="Delete bot"
            onClick={() => onDelete(bot)}
          >
            <Icon icon={Trash2} size={13} weight="control" />
          </button>
        )}
      </div>
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await onCreate(trimmed);
      setName("");
      setCreating(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="sidebar" aria-label="Navigation">
      <div className="sidebar-top">
        <Brand />
      </div>
      <nav>
        <div className="disclosure-heading">
          <span>Bots</span>
          <button
            type="button"
            className="rail-action"
            aria-label="New bot"
            title="New bot"
            aria-expanded={creating}
            onClick={() => setCreating((open) => !open)}
          >
            <Icon icon={Plus} size={14} weight="control" />
          </button>
        </div>
        {creating ? (
          <form className="sidebar-create" onSubmit={(event) => void submit(event)}>
            <input
              aria-label="Bot name"
              placeholder="Bot name"
              value={name}
              maxLength={80}
              disabled={busy || connection !== "open"}
              onChange={(event) => setName(event.target.value)}
            />
            <button
              type="submit"
              className="primary"
              disabled={!name.trim() || busy || connection !== "open"}
            >
              Create
            </button>
          </form>
        ) : null}
        <div className="rail-group">
          {groups.admin ? botRow(groups.admin) : null}
          {groups.teams.map(({ manager, members }) => (
            <div key={manager.id} className="rail-team">
              {botRow(manager)}
              {members.map((member) => botRow(member, true))}
            </div>
          ))}
          {groups.ungrouped.map((bot) => botRow(bot))}
          {bots.length === 0 && !creating ? <p className="rail-empty muted">No bots yet.</p> : null}
        </div>
        {selected ? (
          <>
            <div className="disclosure-heading">
              <span>{selected.name}</span>
            </div>
            <div className="rail-group">
              <a
                href={routeHref({ botId: selected.id })}
                className={`nav-link${onMain ? " active" : ""}`}
                aria-current={onMain ? "page" : undefined}
              >
                <Icon icon={MessageSquare} />
                <span className="rail-title">Main</span>
              </a>
            </div>
          </>
        ) : null}
      </nav>
      {connection !== "open" ? (
        <div className="connection-state" role="status">
          {connection === "connecting" ? "Connecting…" : "Disconnected. Reconnecting…"}
        </div>
      ) : null}
      <div className="sidebar-footer">
        <a
          href={routeHref({ settings: true })}
          className={`nav-link${settings ? " active" : ""}`}
          aria-current={settings ? "page" : undefined}
        >
          <Icon icon={Settings} />
          <span className="rail-title">Settings</span>
        </a>
        <div className="tabs" role="radiogroup" aria-label="Theme">
          {THEMES.map((option) => (
            // biome-ignore lint/a11y/useSemanticElements: segmented control, as in Enterprise
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={theme === option.id}
              className={theme === option.id ? "active" : undefined}
              onClick={() => onTheme(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
