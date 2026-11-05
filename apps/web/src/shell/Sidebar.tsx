import {
  Bot,
  MessageSquare,
  MessageSquareReply,
  Pin,
  PinOff,
  Plus,
  Settings,
  SlidersHorizontal,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import type { ConnectionState } from "../api.ts";
import { Brand } from "../components/Brand.tsx";
import { Icon } from "../components/Icon.tsx";
import { sortThreads, threadLabel } from "../features/conversation-state.ts";
import type { BotSummary, ThreadSummary } from "../protocol.ts";
import { routeHref } from "../routes.ts";
import { groupBots } from "./bot-groups.ts";

export function Sidebar({
  collapsed = false,
  bots,
  botId,
  conversationId,
  mainConversationId,
  threads = [],
  settings,
  connection,
  onCreate,
  onDelete,
  onPin,
}: {
  collapsed?: boolean;
  bots: BotSummary[];
  botId?: string;
  conversationId?: number;
  mainConversationId?: number;
  /** The selected bot's threads, newest first; listed by their generated titles. */
  threads?: readonly ThreadSummary[];
  settings?: boolean;
  connection: ConnectionState;
  onCreate: (name: string) => Promise<void>;
  onDelete: (bot: BotSummary) => void;
  onPin?: (thread: ThreadSummary, pinned: boolean) => Promise<void>;
}) {
  const [pinBusy, setPinBusy] = useState<number>();
  const [menuThread, setMenuThread] = useState<number>();
  const pinMenu = useRef<HTMLDivElement>(null);
  const menuOpener = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (menuThread === undefined) return;
    pinMenu.current?.querySelector("button")?.focus();
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !pinMenu.current?.contains(event.target))
        setMenuThread(undefined);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuThread(undefined);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeOnEscape);
      if (menuOpener.current?.isConnected) menuOpener.current.focus();
    };
  }, [menuThread]);
  async function togglePin(thread: ThreadSummary) {
    if (!onPin || pinBusy !== undefined) return;
    setMenuThread(undefined);
    setPinBusy(thread.conversationId);
    try {
      await onPin(thread, !thread.pinned);
    } finally {
      setPinBusy(undefined);
    }
  }
  const [creatingOpen, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const creating = creatingOpen || bots.length === 0;
  const selected = settings ? undefined : bots.find((bot) => bot.id === botId);
  const onMain = conversationId === undefined || conversationId === mainConversationId;
  const groups = groupBots(bots);

  function botRow(bot: BotSummary, member = false) {
    const active = !settings && bot.id === botId;
    const icon = bot.kind === "admin" ? SlidersHorizontal : bot.manager ? Users : Bot;
    return (
      <div key={bot.id} className={member ? "rail-row rail-member" : "rail-row"}>
        <a
          href={routeHref({ botId: bot.id })}
          className={`nav-link${active ? " active" : ""}`}
          aria-current={active ? "page" : undefined}
          title={
            bot.kind === "admin"
              ? "Admin Bot · Admin: accounts, models and config"
              : bot.orchestrator
                ? `${bot.name} · Orchestrator: oversees every bot and team`
                : bot.manager
                  ? `${bot.name} · Manager: leads a team`
                  : undefined
          }
        >
          <Icon icon={icon} />
          <span className="rail-title">{bot.name}</span>
          {bot.orchestrator && bot.kind !== "admin" ? (
            <span className="badge">Orchestrator</span>
          ) : null}
          {bot.modelStatus && bot.modelStatus.kind !== "returned" ? (
            <span
              className={`rail-status ${bot.modelStatus.kind}`}
              role="img"
              aria-label={
                bot.modelStatus.kind === "paused"
                  ? "Paused: main model unavailable"
                  : `On fallback ${bot.modelStatus.active}`
              }
              title={
                bot.modelStatus.kind === "paused"
                  ? "Paused: main model unavailable"
                  : `On fallback ${bot.modelStatus.active}`
              }
            />
          ) : null}
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
    <aside id="app-sidebar" className="sidebar" aria-label="Navigation" hidden={collapsed}>
      <div className="sidebar-top">
        <Brand />
      </div>
      <nav>
        <div className="disclosure-heading">
          <span>Bots</span>
          {bots.length === 0 ? null : (
            <button
              type="button"
              className="rail-action"
              aria-label={creating ? "Cancel new bot" : "New bot"}
              title={creating ? "Cancel" : "New bot"}
              aria-expanded={creating}
              onClick={() => setCreating((open) => !open)}
            >
              <Icon icon={creating ? X : Plus} size={14} weight="control" />
            </button>
          )}
        </div>
        {creating ? (
          <form
            className="sidebar-create"
            onSubmit={(event) => void submit(event)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setCreating(false);
            }}
          >
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
          {groups.orchestrator ? (
            <div className="rail-team">
              {botRow(groups.orchestrator.bot)}
              {groups.orchestrator.members.map((member) => botRow(member, true))}
            </div>
          ) : null}
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
              {sortThreads(threads).map((thread) => {
                const active = thread.conversationId === conversationId;
                return (
                  <div key={thread.conversationId} className="rail-row thread-row">
                    <a
                      onContextMenu={
                        onPin
                          ? (event) => {
                              event.preventDefault();
                              menuOpener.current = event.currentTarget;
                              setMenuThread(thread.conversationId);
                            }
                          : undefined
                      }
                      onKeyDown={
                        onPin
                          ? (event) => {
                              if (
                                event.key === "ContextMenu" ||
                                (event.shiftKey && event.key === "F10")
                              ) {
                                event.preventDefault();
                                menuOpener.current = event.currentTarget;
                                setMenuThread(thread.conversationId);
                              }
                            }
                          : undefined
                      }
                      href={routeHref({
                        botId: selected.id,
                        conversationId: thread.conversationId,
                      })}
                      className={`nav-link thread-link${active ? " active" : ""}${thread.title ? "" : " untitled"}`}
                      aria-current={active ? "page" : undefined}
                      title={threadLabel(thread)}
                    >
                      <Icon icon={MessageSquareReply} />
                      <span className="rail-title">{threadLabel(thread)}</span>
                    </a>
                    {onPin ? (
                      <button
                        type="button"
                        className={`rail-action${thread.pinned ? " thread-pin" : " reveal"}`}
                        aria-label={`${thread.pinned ? "Unpin" : "Pin"} ${threadLabel(thread)}`}
                        title={thread.pinned ? "Unpin thread" : "Pin thread"}
                        aria-pressed={Boolean(thread.pinned)}
                        disabled={connection !== "open" || pinBusy !== undefined}
                        onClick={() => void togglePin(thread)}
                      >
                        <Icon icon={Pin} size={11} weight="control" />
                      </button>
                    ) : null}
                    {onPin && menuThread === thread.conversationId ? (
                      <div
                        className="thread-pin-menu"
                        ref={pinMenu}
                        role="menu"
                        aria-label="Thread actions"
                      >
                        <button
                          type="button"
                          role="menuitem"
                          disabled={connection !== "open" || pinBusy !== undefined}
                          onClick={() => void togglePin(thread)}
                        >
                          <Icon icon={thread.pinned ? PinOff : Pin} size={13} />
                          {thread.pinned ? "Unpin thread" : "Pin thread"}
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
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
      </div>
    </aside>
  );
}
