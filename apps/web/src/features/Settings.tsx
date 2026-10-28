import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { errorMessage, type PiBotClient } from "../api.ts";
import { Icon } from "../components/Icon.tsx";
import { ErrorNotice, Loading } from "../components/ui.tsx";
import type { BotSummary, DeletedBotSummary } from "../protocol.ts";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function formatDeletedAt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateFormat.format(date);
}

/** Presentational list of deleted bots; the only place a bot can be restored from. */
export function DeletedBotsList({
  bots,
  restoring,
  disabled,
  onRestore,
}: {
  bots: readonly DeletedBotSummary[] | undefined;
  restoring?: string;
  disabled?: boolean;
  onRestore: (bot: DeletedBotSummary) => void;
}) {
  return (
    <section className="settings-section" aria-labelledby="deleted-bots-heading">
      <h3 id="deleted-bots-heading">Deleted bots</h3>
      <p className="muted">
        Deleted bots keep their conversations and threads. Restore one to bring it back.
      </p>
      {bots === undefined ? (
        <Loading />
      ) : bots.length === 0 ? (
        <p className="settings-empty muted">No deleted bots.</p>
      ) : (
        <ul className="settings-list">
          {bots.map((bot) => (
            <li key={bot.id} className="settings-row">
              <div className="settings-row-text">
                <strong>{bot.name}</strong>
                <small className="muted">
                  Deleted <time dateTime={bot.deletedAt}>{formatDeletedAt(bot.deletedAt)}</time>
                </small>
              </div>
              <button
                type="button"
                className="secondary"
                aria-label={`Restore ${bot.name}`}
                disabled={disabled || restoring !== undefined}
                onClick={() => onRestore(bot)}
              >
                <Icon icon={RotateCcw} size={13} weight="control" />
                {restoring === bot.id ? "Restoring…" : "Restore"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Settings page. Deleted bots are listed here only, never in the sidebar. */
export function Settings({
  client,
  connected,
  onRestored,
}: {
  client: PiBotClient;
  connected: boolean;
  onRestored: (bot: BotSummary) => void;
}) {
  const [deleted, setDeleted] = useState<DeletedBotSummary[]>();
  const [restoring, setRestoring] = useState<string>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(
    () =>
      client
        .request("bots.listDeleted", {})
        .then(({ bots }) => setDeleted(bots))
        .catch((e: unknown) => setError(errorMessage(e))),
    [client],
  );

  useEffect(() => {
    if (connected) void refresh();
  }, [connected, refresh]);

  async function restore(target: DeletedBotSummary) {
    setError(undefined);
    setRestoring(target.id);
    try {
      const result = await client.request("bots.restore", { botId: target.id });
      if (result.restored) onRestored(result.bot);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRestoring(undefined);
    }
  }

  return (
    <div className="settings-page">
      <h2>Settings</h2>
      <ErrorNotice message={error} onDismiss={() => setError(undefined)} />
      <DeletedBotsList
        bots={deleted}
        restoring={restoring}
        disabled={!connected}
        onRestore={(bot) => void restore(bot)}
      />
    </div>
  );
}
