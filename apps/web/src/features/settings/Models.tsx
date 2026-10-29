import { type FormEvent, useState } from "react";
import { Loading } from "../../components/ui.tsx";
import type { ProviderModels, Roles } from "../../protocol.ts";

const ROLES = [
  {
    key: "orchestrator",
    label: "Bots",
    help: "Default chat model for every bot except Admin Bot (set Admin Bot's under Bots).",
  },
  { key: "background", label: "Background", help: "Memory extraction and other quiet jobs." },
  { key: "titles", label: "Titles", help: "Names threads and conversations." },
] as const;

/** Whether a ref is offered by a signed-in provider (otherwise it's shown as "not signed in"). */
function isKnown(providers: readonly ProviderModels[], ref: string): boolean {
  return providers.some((p) => p.models.some((m) => `${p.id}/${m.id}` === ref));
}

/** Models from signed-in providers and the role → model assignments in config.toml. */
export function ModelSettings({
  providers,
  roles,
  reasoningLevels,
  disabled,
  onSave,
}: {
  providers: readonly ProviderModels[] | undefined;
  roles: Roles | undefined;
  reasoningLevels: readonly string[];
  disabled?: boolean;
  onSave: (roles: Roles) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Roles>();
  const [saving, setSaving] = useState(false);
  if (!providers || !roles) return <Loading />;
  const value = draft ?? roles;
  const changed = (Object.keys(value) as (keyof Roles)[]).some((key) => value[key] !== roles[key]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave(value);
      setDraft(undefined);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <form
        className="settings-section"
        aria-labelledby="roles-heading"
        onSubmit={(e) => void submit(e)}
      >
        <h3 id="roles-heading">Roles</h3>
        <p className="muted">Which model does what. Saved to config.toml.</p>
        <div className="settings-fields">
          {ROLES.map((role) => {
            const known = isKnown(providers, value[role.key]);
            return (
              <label key={role.key} className="settings-field">
                <span>
                  {role.label}
                  <small className="muted">{role.help}</small>
                </span>
                <select
                  value={value[role.key]}
                  disabled={disabled || saving}
                  onChange={(event) => setDraft({ ...value, [role.key]: event.target.value })}
                >
                  {known ? null : (
                    <option value={value[role.key]}>{value[role.key]} (not signed in)</option>
                  )}
                  {providers.map((provider) => (
                    <optgroup key={provider.id} label={provider.name}>
                      {provider.models.map((model) => (
                        <option key={model.id} value={`${provider.id}/${model.id}`}>
                          {model.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
            );
          })}
          <label className="settings-field">
            <span>
              Title reasoning
              <small className="muted">Thinking effort for title generation.</small>
            </span>
            <select
              value={value.titlesReasoning}
              disabled={disabled || saving}
              onChange={(event) => setDraft({ ...value, titlesReasoning: event.target.value })}
            >
              {reasoningLevels.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="settings-actions">
          <button type="submit" className="primary" disabled={disabled || saving || !changed}>
            {saving ? "Saving…" : "Save roles"}
          </button>
          {changed ? (
            <button type="button" className="text-button" onClick={() => setDraft(undefined)}>
              Reset
            </button>
          ) : null}
        </div>
      </form>
      <section className="settings-section" aria-labelledby="available-heading">
        <h3 id="available-heading">Available models</h3>
        {providers.length === 0 ? (
          <p className="settings-empty muted">
            No providers signed in. Add one under Account &amp; sign-ins.
          </p>
        ) : (
          providers.map((provider) => (
            <details key={provider.id} className="model-group">
              <summary>
                {provider.name} <small className="muted">{provider.models.length} models</small>
              </summary>
              <ul className="settings-list">
                {provider.models.map((model) => (
                  <li key={model.id} className="settings-row">
                    <div className="settings-row-text">
                      <strong>{model.name}</strong>
                      <small className="muted">
                        <code>
                          {provider.id}/{model.id}
                        </code>
                        {model.contextWindow
                          ? ` · ${Math.round(model.contextWindow / 1000)}k context`
                          : ""}
                        {model.reasoning ? " · reasoning" : ""}
                      </small>
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          ))
        )}
      </section>
    </>
  );
}
