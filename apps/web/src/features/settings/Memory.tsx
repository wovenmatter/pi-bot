import { Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Icon } from "../../components/Icon.tsx";
import { Loading } from "../../components/ui.tsx";
import type { BotSummary } from "../../protocol.ts";

/** Longest fact the server accepts. */
const MAX_FACT_CHARS = 1000;

/** The confirm text for deleting one fact. */
export const deleteFactConfirmText = (fact: string) => `Delete this memory?\n\n${fact}`;

/**
 * Settings → Bots → Memory: the durable facts one bot keeps (extracted from its conversations, or
 * added here) and sees in its prompt. Pick a bot, then edit, delete or add facts.
 */
export function MemoryPanel({
  bots,
  botId,
  facts,
  disabled,
  onSelect,
  onAdd,
  onUpdate,
  onDelete,
}: {
  bots: readonly BotSummary[];
  botId: string | undefined;
  /** The selected bot's facts, oldest first; undefined while loading. */
  facts: readonly string[] | undefined;
  disabled?: boolean;
  onSelect: (botId: string) => void;
  /** Resolve true once saved (the field clears). */
  onAdd: (text: string) => Promise<boolean>;
  onUpdate: (fact: string, text: string) => Promise<boolean>;
  onDelete: (fact: string) => void;
}) {
  const bot = bots.find((candidate) => candidate.id === botId);
  return (
    <section className="settings-section" aria-labelledby="memory-heading">
      <h3 id="memory-heading">Memory</h3>
      <p className="muted">
        Durable facts a bot keeps from its conversations and sees on every turn. Changes here apply
        from its next reply.
      </p>
      <div className="settings-fields">
        <label className="settings-field">
          <span>Bot</span>
          <select
            aria-label="Bot whose memory to show"
            value={botId ?? ""}
            disabled={disabled}
            onChange={(event) => onSelect(event.target.value)}
          >
            {bots.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {bot === undefined ? null : facts === undefined ? (
        <Loading />
      ) : facts.length === 0 ? (
        <p className="settings-empty muted">{bot.name} doesn't remember anything yet.</p>
      ) : (
        <ul className="settings-list" aria-label={`${bot.name}'s memory`}>
          {facts.map((fact) => (
            <FactRow
              key={fact}
              fact={fact}
              disabled={disabled}
              onUpdate={onUpdate}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
      {bot ? <FactForm label="New memory" action="Add" disabled={disabled} onSave={onAdd} /> : null}
    </section>
  );
}

function FactRow({
  fact,
  disabled,
  onUpdate,
  onDelete,
}: {
  fact: string;
  disabled: boolean | undefined;
  onUpdate: (fact: string, text: string) => Promise<boolean>;
  onDelete: (fact: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <li className="settings-row">
      {editing ? (
        <FactForm
          label="Edit memory"
          action="Save"
          initial={fact}
          disabled={disabled}
          onCancel={() => setEditing(false)}
          onSave={async (text) => {
            const saved = text.trim() === fact || (await onUpdate(fact, text));
            if (saved) setEditing(false);
            return saved;
          }}
        />
      ) : (
        <>
          <span className="memory-fact">{fact}</span>
          <div className="account-row-actions">
            <button
              type="button"
              className="text-button"
              aria-label={`Edit memory: ${fact}`}
              disabled={disabled}
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
            <button
              type="button"
              className="text-button danger"
              aria-label={`Delete memory: ${fact}`}
              disabled={disabled}
              onClick={() => onDelete(fact)}
            >
              <Icon icon={Trash2} size={13} />
              Delete
            </button>
          </div>
        </>
      )}
    </li>
  );
}

/** One line of text with a save button (adding a fact, or editing one in place). */
function FactForm({
  label,
  action,
  initial = "",
  disabled,
  onSave,
  onCancel,
}: {
  label: string;
  action: string;
  initial?: string;
  disabled: boolean | undefined;
  onSave: (text: string) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!value.trim()) return;
    setSaving(true);
    try {
      if ((await onSave(value)) && !onCancel) setValue("");
    } finally {
      setSaving(false);
    }
  }
  return (
    <form className="memory-form" onSubmit={(event) => void submit(event)}>
      <input
        aria-label={label}
        placeholder={onCancel ? undefined : "Something this bot should remember"}
        value={value}
        maxLength={MAX_FACT_CHARS}
        disabled={disabled || saving}
        // biome-ignore lint/a11y/noAutofocus: the user just asked to edit this fact.
        autoFocus={onCancel !== undefined}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel?.();
        }}
      />
      <button type="submit" className="secondary" disabled={disabled || saving || !value.trim()}>
        {saving ? "Saving…" : action}
      </button>
      {onCancel ? (
        <button type="button" className="text-button" onClick={onCancel}>
          Cancel
        </button>
      ) : null}
    </form>
  );
}
