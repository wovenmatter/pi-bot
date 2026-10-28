import { RotateCcw } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Icon } from "../../components/Icon.tsx";

/** Shown after any config.toml write: the running server keeps its startup config. */
export function RestartNotice({ show }: { show: boolean }) {
  return show ? (
    <div className="notice warning" role="status">
      <Icon icon={RotateCcw} size={16} />
      <span>Saved to config.toml. Restart Pi Bot to apply.</span>
    </div>
  ) : null;
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
