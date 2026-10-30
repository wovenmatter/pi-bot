import { RotateCcw } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Icon } from "../../components/Icon.tsx";

/** The running server keeps its startup config until it restarts. */
export type RestartState =
  | { phase: "idle" }
  | { phase: "restarting"; activeWork: number; mode: "reload" | "exit"; dropped: boolean }
  | { phase: "back" }
  | { phase: "failed"; message: string };

/** How long the page waits for the server to come back before reporting it. */
export const RESTART_TIMEOUT_MS = 90_000;

/**
 * Restart status and the "Restart and apply" button, pinned above every Settings tab while
 * config.toml has unapplied changes (`show`), and while a restart is running or just finished.
 * Config → Restart offers a restart at any time.
 */
export function RestartNotice({
  show,
  state,
  disabled,
  onRestart,
}: {
  show: boolean;
  state: RestartState;
  disabled?: boolean;
  onRestart: () => void;
}) {
  if (state.phase === "restarting") {
    const waiting = state.activeWork
      ? ` Letting ${state.activeWork} running turn${state.activeWork === 1 ? "" : "s"} finish (up to 15 s); anything still running resumes after the restart.`
      : "";
    return (
      <div className="notice info restart-notice" role="status">
        <Icon icon={RotateCcw} size={16} className="spin" />
        <span>
          Restarting Pi Bot…{waiting} This page reconnects on its own.
          {state.mode === "exit" ? " Waiting for the service manager to start it again." : ""}
        </span>
      </div>
    );
  }
  if (state.phase === "back") {
    return (
      <div className="notice success restart-notice" role="status">
        <Icon icon={RotateCcw} size={16} />
        <span>Pi Bot is back and running with the saved config.</span>
      </div>
    );
  }
  if (!show && state.phase !== "failed") return null;
  return (
    <div
      className={`notice ${state.phase === "failed" ? "error" : "warning"} restart-notice`}
      role="status"
    >
      <Icon icon={RotateCcw} size={16} />
      <span>{state.phase === "failed" ? state.message : "Saved. Restart Pi Bot to apply."}</span>
      <button type="button" className="primary" disabled={disabled} onClick={onRestart}>
        Restart and apply
      </button>
    </div>
  );
}

/** Write-only secret field: the stored value is never shown or prefilled. */
export function KeyForm({
  label,
  placeholder = "Paste key",
  disabled,
  onSave,
}: {
  label: string;
  placeholder?: string;
  disabled?: boolean;
  onSave: (key: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!value.trim()) return;
    setSaving(true);
    try {
      if (await onSave(value)) setValue("");
    } finally {
      setSaving(false);
    }
  }
  return (
    <form className="settings-inline-form" onSubmit={(event) => void submit(event)}>
      <input
        type="password"
        aria-label={label}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        value={value}
        disabled={disabled || saving}
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit" className="secondary" disabled={disabled || saving || !value.trim()}>
        {saving ? "Saving…" : "Save"}
      </button>
    </form>
  );
}
