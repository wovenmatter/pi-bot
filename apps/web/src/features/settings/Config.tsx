import { Check } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Icon } from "../../components/Icon.tsx";
import { Loading } from "../../components/ui.tsx";
import type { ConfigEdit, EffectiveConfig } from "../../protocol.ts";

type Limits = {
  maxRounds: string;
  maxMessages: string;
  schedule: string;
  timezone: string;
};

function limitsOf(config: EffectiveConfig): Limits {
  return {
    maxRounds: String(config.bot_to_bot.max_rounds_per_request),
    maxMessages: String(config.bot_to_bot.max_messages_per_hour_per_pair),
    schedule: config.extraction.schedule,
    timezone: config.extraction.timezone,
  };
}

/** Edits for the changed fields; numbers that don't parse are sent as text so the server rejects them. */
export function limitEdits(before: Limits, after: Limits): ConfigEdit[] {
  const number = (text: string) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : text);
  const edits: ConfigEdit[] = [];
  if (after.maxRounds !== before.maxRounds)
    edits.push({ path: ["bot_to_bot", "max_rounds_per_request"], value: number(after.maxRounds) });
  if (after.maxMessages !== before.maxMessages)
    edits.push({
      path: ["bot_to_bot", "max_messages_per_hour_per_pair"],
      value: number(after.maxMessages),
    });
  if (after.schedule !== before.schedule)
    edits.push({ path: ["extraction", "schedule"], value: after.schedule.trim() });
  if (after.timezone !== before.timezone)
    edits.push({ path: ["extraction", "timezone"], value: after.timezone.trim() });
  return edits;
}

/** Bot-to-bot limits and the memory extraction schedule, written into config.toml in place. */
export function LimitsForm({
  effective,
  disabled,
  onSave,
}: {
  effective: EffectiveConfig;
  disabled?: boolean;
  onSave: (edits: ConfigEdit[]) => Promise<boolean>;
}) {
  const initial = limitsOf(effective);
  const [draft, setDraft] = useState<Limits>();
  const [saving, setSaving] = useState(false);
  const value = draft ?? initial;
  const edits = limitEdits(initial, value);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (edits.length === 0) return;
    setSaving(true);
    try {
      if (await onSave(edits)) setDraft(undefined);
    } finally {
      setSaving(false);
    }
  }

  const field = (key: keyof Limits, label: string, help: string, numeric = false) => (
    <label className="settings-field">
      <span>
        {label}
        <small className="muted">{help}</small>
      </span>
      <input
        type="text"
        inputMode={numeric ? "numeric" : undefined}
        spellCheck={false}
        value={value[key]}
        disabled={disabled || saving}
        onChange={(event) => setDraft({ ...value, [key]: event.target.value })}
      />
    </label>
  );

  return (
    <form
      className="settings-section"
      aria-labelledby="limits-heading"
      onSubmit={(e) => void submit(e)}
    >
      <h3 id="limits-heading">Limits &amp; schedule</h3>
      <div className="settings-fields">
        {field(
          "maxRounds",
          "Bot-to-bot rounds per request",
          "1–100 replies in one exchange.",
          true,
        )}
        {field("maxMessages", "Bot-to-bot messages per hour", "Per pair of bots, 1–10000.", true)}
        {field("schedule", "Memory extraction schedule", "5-field cron, e.g. 0 3 * * *.")}
        {field("timezone", "Extraction time zone", "IANA name, e.g. America/New_York.")}
      </div>
      <div className="settings-actions">
        <button
          type="submit"
          className="primary"
          disabled={disabled || saving || edits.length === 0}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {edits.length > 0 ? (
          <button type="button" className="text-button" onClick={() => setDraft(undefined)}>
            Reset
          </button>
        ) : null}
      </div>
    </form>
  );
}

export type ValidationState = { ok: true } | { ok: false; error: string } | undefined;

/** Raw config.toml editor; the server validates with the same schema it starts with. */
export function ConfigEditor({
  path,
  text,
  validation,
  disabled,
  onChange,
  onValidate,
  onSave,
}: {
  path?: string;
  text: string | undefined;
  validation: ValidationState;
  disabled?: boolean;
  onChange: (text: string) => void;
  onValidate: () => void;
  onSave: () => void;
}) {
  if (text === undefined) return <Loading />;
  return (
    <section className="settings-section" aria-labelledby="config-heading">
      <h3 id="config-heading">config.toml</h3>
      {path ? (
        <p className="muted">
          <code>{path}</code>
        </p>
      ) : (
        <p className="muted">
          Pi Bot was started without a config file, so it can't be edited here.
        </p>
      )}
      <textarea
        className="config-editor"
        aria-label="config.toml"
        spellCheck={false}
        value={text}
        disabled={disabled || !path}
        onChange={(event) => onChange(event.target.value)}
      />
      {validation?.ok === false ? (
        <pre className="config-error" role="alert">
          {validation.error}
        </pre>
      ) : null}
      {validation?.ok ? (
        <p className="config-ok" role="status">
          <Icon icon={Check} size={13} weight="control" /> Valid
        </p>
      ) : null}
      <div className="settings-actions">
        <button
          type="button"
          className="secondary"
          disabled={disabled || !path}
          onClick={onValidate}
        >
          Validate
        </button>
        <button type="button" className="primary" disabled={disabled || !path} onClick={onSave}>
          Save
        </button>
      </div>
    </section>
  );
}
