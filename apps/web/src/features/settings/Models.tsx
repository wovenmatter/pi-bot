import { type FormEvent, useState } from "react";
import { Loading } from "../../components/ui.tsx";
import type { ProviderModels, Roles } from "../../protocol.ts";
import { ModelSelect } from "./Profiles.tsx";

/**
 * Settings → Profiles → Thread titles: the one global model role (`[models.titles]`). Bots' own
 * models come from their profiles.
 */
export function TitleModelSettings({
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
        aria-labelledby="titles-heading"
        onSubmit={(e) => void submit(e)}
      >
        <h3 id="titles-heading">Thread titles</h3>
        <p className="muted">Names threads from their first message. One model for every bot.</p>
        <div className="title-model-fields">
          <ModelSelect
            providers={providers}
            value={value.titles}
            label="Title model"
            disabled={disabled || saving}
            onChange={(titles) => setDraft({ ...value, titles })}
          />
          <select
            aria-label="Title reasoning"
            title="Reasoning effort"
            value={value.titlesReasoning}
            disabled={disabled || saving}
            onChange={(event) => setDraft({ ...value, titlesReasoning: event.target.value })}
          >
            {reasoningLevels.map((level) => (
              <option key={level} value={level}>
                {level} reasoning
              </option>
            ))}
          </select>
        </div>
        {changed ? (
          <div className="settings-actions">
            <button type="submit" className="primary" disabled={disabled || saving}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button type="button" className="text-button" onClick={() => setDraft(undefined)}>
              Reset
            </button>
          </div>
        ) : null}
      </form>
      <AvailableModels providers={providers} />
    </>
  );
}

/** What each signed-in provider offers, folded per provider. */
function AvailableModels({ providers }: { providers: readonly ProviderModels[] }) {
  return (
    <section className="settings-section" aria-labelledby="available-heading">
      <h3 id="available-heading">Available models</h3>
      {providers.length === 0 ? (
        <p className="settings-empty muted">No providers signed in. Add one under Accounts.</p>
      ) : (
        <div className="disclosure-list">
          {providers.map((provider) => (
            <details key={provider.id} className="disclosure">
              <summary>
                <span>{provider.name}</span>
                <small className="muted">{provider.models.length} models</small>
              </summary>
              <ul className="settings-list">
                {provider.models.map((model) => (
                  <li key={model.id} className="settings-row compact">
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
          ))}
        </div>
      )}
    </section>
  );
}
