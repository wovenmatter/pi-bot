import { useState } from "react";
import { Loading } from "../../components/ui.tsx";
import type { BotSummary, OrchestratorStatus } from "../../protocol.ts";

/**
 * Settings → Bots: the orchestrator bot. One bot is its own orchestrator; with two or more, the
 * first-created bot is the default until the user confirms it or picks another.
 */
export function OrchestratorPanel({
  bots,
  status,
  saving,
  disabled,
  onConfirm,
}: {
  bots: readonly BotSummary[] | undefined;
  status: OrchestratorStatus | undefined;
  saving?: boolean;
  disabled?: boolean;
  onConfirm: (botId: string) => void;
}) {
  const [choice, setChoice] = useState<string>();
  if (!bots || !status) {
    return (
      <section className="settings-section" aria-labelledby="orchestrator-heading">
        <h3 id="orchestrator-heading">Orchestrator</h3>
        <Loading />
      </section>
    );
  }
  const current = bots.find((bot) => bot.id === status.botId);
  const selected = choice ?? status.botId ?? "";
  return (
    <section className="settings-section" aria-labelledby="orchestrator-heading">
      <h3 id="orchestrator-heading">Orchestrator</h3>
      {status.source === "none" || !current ? (
        <p className="settings-empty muted">No bots yet.</p>
      ) : status.source === "single" ? (
        <p className="muted">
          <strong>{current.name}</strong> is your only bot, so it is its own orchestrator.
        </p>
      ) : (
        <>
          {status.needsConfirmation ? (
            <p className="orchestrator-prompt" role="status">
              With more than one bot, <strong>{current.name}</strong> (created first) is the
              orchestrator by default. Confirm it or choose another bot.
            </p>
          ) : (
            <p className="muted">
              <strong>{current.name}</strong> orchestrates your other bots.
            </p>
          )}
          <div className="settings-row">
            <label className="settings-row-text">
              <span>Orchestrator bot</span>
              <select
                value={selected}
                disabled={disabled || saving}
                onChange={(event) => setChoice(event.target.value)}
              >
                {bots.map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    {bot.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={
                disabled ||
                saving ||
                !selected ||
                (!status.needsConfirmation && selected === status.botId)
              }
              onClick={() => onConfirm(selected)}
            >
              {saving ? "Saving…" : status.needsConfirmation ? "Confirm" : "Use this bot"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
