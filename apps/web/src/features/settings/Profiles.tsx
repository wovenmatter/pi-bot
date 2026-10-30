import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Icon } from "../../components/Icon.tsx";
import { Loading } from "../../components/ui.tsx";
import type { BotSummary, ProfileInput, ProfileSummary, ProviderModels } from "../../protocol.ts";

const isKnown = (providers: readonly ProviderModels[], ref: string) =>
  providers.some((p) => p.models.some((m) => `${p.id}/${m.id}` === ref));

/** A model from the signed-in providers; a ref no provider offers shows as "not signed in". */
export function ModelSelect({
  providers,
  value,
  label,
  disabled,
  onChange,
}: {
  providers: readonly ProviderModels[];
  value: string;
  label: string;
  disabled?: boolean;
  onChange: (model: string) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      {value === "" ? <option value="">Pick a model…</option> : null}
      {value && !isKnown(providers, value) ? (
        <option value={value}>{value} (not signed in)</option>
      ) : null}
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
  );
}

/** Onboarding: pick the main model of Admin Bot's profile from signed-in providers. */
export function MainModelPicker({
  providers,
  current,
  disabled,
  submitLabel = "Save",
  onSave,
}: {
  providers: readonly ProviderModels[] | undefined;
  current?: string;
  disabled?: boolean;
  submitLabel?: string;
  onSave: (model: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  if (!providers) return <Loading />;
  if (providers.length === 0) {
    return <p className="settings-empty muted">Sign in to a model provider first.</p>;
  }
  const first = providers[0]?.models[0];
  const fallback = first ? `${providers[0]?.id}/${first.id}` : "";
  const value = draft ?? (current && isKnown(providers, current) ? current : fallback);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!value) return;
    setSaving(true);
    try {
      await onSave(value);
      setDraft(undefined);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="main-model-picker" onSubmit={(event) => void submit(event)}>
      <ModelSelect
        providers={providers}
        value={value}
        label="Main model"
        disabled={disabled || saving}
        onChange={setDraft}
      />
      <button
        type="submit"
        className="primary"
        disabled={disabled || saving || !isKnown(providers, value)}
      >
        {saving ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}

type Draft = {
  id: string;
  name: string;
  main: string;
  fallbacks: { key: number; model: string }[];
  guidance: string;
  pool: { key: number; model: string; useFor: string; background: boolean }[];
};

let poolKeys = 0;

/** Ordered main-model fallbacks a profile may have. Mirrors the server's MAX_FALLBACKS. */
export const MAX_FALLBACKS = 5;

const toDraft = (profile?: ProfileSummary): Draft => ({
  id: profile?.id ?? "",
  name: profile?.name ?? "",
  main: profile?.main ?? "",
  fallbacks: (profile?.fallbacks ?? []).map((model) => ({ key: poolKeys++, model })),
  guidance: profile?.guidance ?? "",
  pool: (profile?.pool ?? []).map((entry) => ({
    key: poolKeys++,
    model: entry.model,
    useFor: entry.useFor,
    background: entry.background === true,
  })),
});

const toInput = (draft: Draft): ProfileInput => ({
  id: draft.id.trim(),
  name: draft.name.trim(),
  main: draft.main,
  fallbacks: draft.fallbacks.map((entry) => entry.model).filter(Boolean),
  ...(draft.guidance.trim() ? { guidance: draft.guidance.trim() } : {}),
  pool: draft.pool
    .filter((entry) => entry.model)
    .map((entry) => ({
      model: entry.model,
      useFor: entry.useFor.trim(),
      ...(entry.background ? { background: true } : {}),
    })),
});

/** Create or edit one profile: name, main model, pool (with "use it for" notes) and guidance. */
export function ProfileEditor({
  profile,
  providers,
  disabled,
  onSave,
  onCancel,
}: {
  /** Absent: a new profile. */
  profile?: ProfileSummary;
  providers: readonly ProviderModels[];
  disabled?: boolean;
  onSave: (input: ProfileInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => toDraft(profile));
  const [saving, setSaving] = useState(false);
  const isNew = profile === undefined;
  const busy = disabled || saving;
  const setPool = (index: number, change: Partial<Draft["pool"][number]>) =>
    setDraft((current) => ({
      ...current,
      pool: current.pool.map((entry, at) =>
        at === index
          ? { ...entry, ...change }
          : change.background
            ? { ...entry, background: false }
            : entry,
      ),
    }));

  const fallbackModels = draft.fallbacks.map((entry) => entry.model).filter(Boolean);
  const fallbackProblem = fallbackModels.includes(draft.main)
    ? "A fallback can't be the main model."
    : new Set(fallbackModels).size < fallbackModels.length
      ? "Each fallback can appear only once."
      : undefined;
  const setFallbacks = (fallbacks: Draft["fallbacks"]) =>
    setDraft((current) => ({ ...current, fallbacks }));
  const moveFallback = (index: number, by: number) => {
    const next = [...draft.fallbacks];
    const [moved] = next.splice(index, 1);
    if (moved) next.splice(index + by, 0, moved);
    setFallbacks(next);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave(toInput(draft));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="settings-fields profile-editor" onSubmit={(event) => void submit(event)}>
      {isNew ? (
        <label className="settings-field">
          <span>
            Id
            <small className="muted">Lowercase letters, digits, - and _. Can't be changed.</small>
          </span>
          <input
            value={draft.id}
            disabled={busy}
            placeholder="e.g. coding"
            onChange={(event) => setDraft({ ...draft, id: event.target.value })}
          />
        </label>
      ) : null}
      <label className="settings-field">
        <span>Name</span>
        <input
          value={draft.name}
          disabled={busy}
          placeholder="e.g. Coding"
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </label>
      <div className="settings-field">
        <span>
          Main model
          <small className="muted">Runs the main channel and every thread.</small>
        </span>
        <ModelSelect
          providers={providers}
          value={draft.main}
          label="Main model"
          disabled={busy}
          onChange={(main) => setDraft({ ...draft, main })}
        />
      </div>
      <div className="settings-field profile-pool">
        <span>
          Fallbacks
          <small className="muted">
            Up to {MAX_FALLBACKS}, tried in order when the main model hits a usage limit or runs out
            of credits. The bot switches back once the main model resets. None: the bot pauses.
          </small>
        </span>
        <div className="profile-pool-rows">
          {draft.fallbacks.map((entry, index) => (
            <div key={entry.key} className="profile-pool-row profile-fallback-row">
              <small className="muted">{index + 1}.</small>
              <ModelSelect
                providers={providers}
                value={entry.model}
                label={`Fallback ${index + 1}`}
                disabled={busy}
                onChange={(model) =>
                  setFallbacks(
                    draft.fallbacks.map((item, at) => (at === index ? { ...item, model } : item)),
                  )
                }
              />
              <button
                type="button"
                className="text-button"
                aria-label={`Move fallback ${index + 1} up`}
                disabled={busy || index === 0}
                onClick={() => moveFallback(index, -1)}
              >
                <Icon icon={ArrowUp} size={13} />
              </button>
              <button
                type="button"
                className="text-button"
                aria-label={`Move fallback ${index + 1} down`}
                disabled={busy || index === draft.fallbacks.length - 1}
                onClick={() => moveFallback(index, 1)}
              >
                <Icon icon={ArrowDown} size={13} />
              </button>
              <button
                type="button"
                className="text-button danger"
                aria-label={`Remove fallback ${index + 1}`}
                disabled={busy}
                onClick={() => setFallbacks(draft.fallbacks.filter((_, at) => at !== index))}
              >
                <Icon icon={Trash2} size={13} />
              </button>
            </div>
          ))}
          {fallbackProblem ? (
            <small className="profile-fallback-error" role="alert">
              {fallbackProblem}
            </small>
          ) : null}
          {draft.fallbacks.length < MAX_FALLBACKS ? (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setFallbacks([...draft.fallbacks, { key: poolKeys++, model: "" }])}
            >
              <Icon icon={Plus} size={13} weight="control" />
              Add fallback
            </button>
          ) : null}
        </div>
      </div>
      <div className="settings-field profile-pool">
        <span>
          Pool
          <small className="muted">
            Models the main model can hand tasks to. The background one also does background work
            (else the main model does).
          </small>
        </span>
        <div className="profile-pool-rows">
          {draft.pool.map((entry, index) => (
            <div key={entry.key} className="profile-pool-row">
              <ModelSelect
                providers={providers}
                value={entry.model}
                label={`Pool model ${index + 1}`}
                disabled={busy}
                onChange={(model) => setPool(index, { model })}
              />
              <input
                aria-label={`Use pool model ${index + 1} for`}
                value={entry.useFor}
                disabled={busy}
                placeholder="Use it for…"
                onChange={(event) => setPool(index, { useFor: event.target.value })}
              />
              <label className="profile-background">
                <input
                  type="checkbox"
                  checked={entry.background}
                  disabled={busy}
                  onChange={(event) => setPool(index, { background: event.target.checked })}
                />
                Background
              </label>
              <button
                type="button"
                className="text-button danger"
                aria-label={`Remove pool model ${index + 1}`}
                disabled={busy}
                onClick={() =>
                  setDraft({ ...draft, pool: draft.pool.filter((_, at) => at !== index) })
                }
              >
                <Icon icon={Trash2} size={13} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() =>
              setDraft({
                ...draft,
                pool: [
                  ...draft.pool,
                  { key: poolKeys++, model: "", useFor: "", background: false },
                ],
              })
            }
          >
            <Icon icon={Plus} size={13} weight="control" />
            Add pool model
          </button>
        </div>
      </div>
      <label className="settings-field">
        <span>
          Guidance
          <small className="muted">Optional notes for the main model on using the pool.</small>
        </span>
        <textarea
          rows={3}
          value={draft.guidance}
          disabled={busy}
          onChange={(event) => setDraft({ ...draft, guidance: event.target.value })}
        />
      </label>
      <div className="settings-actions">
        <button
          type="submit"
          className="primary"
          disabled={
            busy ||
            !draft.name.trim() ||
            !draft.main ||
            (isNew && !draft.id.trim()) ||
            fallbackProblem !== undefined
          }
        >
          {saving ? "Saving…" : isNew ? "Create profile" : "Save profile"}
        </button>
        <button type="button" className="text-button" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Settings → Profiles: the model profiles, which one is the default, and how many bots run each. */
export function ProfilesPanel({
  profiles,
  bots,
  providers,
  disabled,
  onSave,
  onDelete,
  onSetDefault,
}: {
  profiles: readonly ProfileSummary[] | undefined;
  bots: readonly BotSummary[] | undefined;
  providers: readonly ProviderModels[] | undefined;
  disabled?: boolean;
  onSave: (input: ProfileInput, create: boolean) => Promise<void>;
  onDelete: (profile: ProfileSummary) => void;
  onSetDefault: (profile: ProfileSummary) => void;
}) {
  /** The profile id being edited, or "" for a new one. */
  const [editing, setEditing] = useState<string>();
  if (!profiles || !providers) return <Loading />;
  const users = (profile: ProfileSummary) =>
    bots?.filter((bot) => bot.profileId === profile.id).map((bot) => bot.name) ?? [];
  const save = async (input: ProfileInput, create: boolean) => {
    await onSave(input, create);
    setEditing(undefined);
  };
  return (
    <section className="settings-section" aria-labelledby="profiles-heading">
      <h3 id="profiles-heading">Profiles</h3>
      <p className="muted">
        Every bot runs one profile: a main model for its channel and threads, plus a pool of models
        it can hand self-contained tasks to. New bots get the default profile. Changes apply from
        each bot's next reply. Admin Bot can set these up with you.
      </p>
      <ul className="settings-list">
        {profiles.map((profile) => {
          const using = users(profile);
          return (
            <li key={profile.id} className="settings-row profile-row">
              {editing === profile.id ? (
                <ProfileEditor
                  profile={profile}
                  providers={providers}
                  {...(disabled ? { disabled } : {})}
                  onSave={(input) => save(input, false)}
                  onCancel={() => setEditing(undefined)}
                />
              ) : (
                <>
                  <div className="settings-row-text">
                    <strong>
                      {profile.name}
                      {profile.default ? <small className="muted"> · default</small> : null}
                    </strong>
                    <small className="muted">
                      Main <code>{profile.main}</code>
                      {profile.fallbacks?.length
                        ? ` · fallbacks: ${profile.fallbacks.join(" → ")}`
                        : " · no fallbacks"}
                      {profile.pool.length
                        ? ` · pool: ${profile.pool.map((entry) => `${entry.model}${entry.background ? " (background)" : ""}`).join(", ")}`
                        : " · no pool"}
                    </small>
                    <small className="muted">
                      {using.length ? `Used by ${using.join(", ")}` : "No bots"}
                    </small>
                  </div>
                  <span className="team-controls">
                    <button
                      type="button"
                      className="secondary"
                      disabled={disabled || editing !== undefined}
                      onClick={() => setEditing(profile.id)}
                    >
                      Edit
                    </button>
                    {profile.default ? null : (
                      <>
                        <button
                          type="button"
                          className="text-button"
                          disabled={disabled}
                          onClick={() => onSetDefault(profile)}
                        >
                          Make default
                        </button>
                        <button
                          type="button"
                          className="text-button danger"
                          aria-label={`Delete profile ${profile.name}`}
                          disabled={disabled}
                          onClick={() => onDelete(profile)}
                        >
                          <Icon icon={Trash2} size={13} />
                        </button>
                      </>
                    )}
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {editing === "" ? (
        <ProfileEditor
          providers={providers}
          {...(disabled ? { disabled } : {})}
          onSave={(input) => save(input, true)}
          onCancel={() => setEditing(undefined)}
        />
      ) : (
        <div className="settings-actions">
          <button
            type="button"
            className="secondary"
            disabled={disabled || editing !== undefined}
            onClick={() => setEditing("")}
          >
            <Icon icon={Plus} size={13} weight="control" />
            New profile
          </button>
        </div>
      )}
    </section>
  );
}

/** Settings → Bots: which profile each bot runs ("" = the default profile). */
export function BotProfilesPanel({
  bots,
  profiles,
  disabled,
  onSet,
}: {
  bots: readonly BotSummary[] | undefined;
  profiles: readonly ProfileSummary[] | undefined;
  disabled?: boolean;
  onSet: (bot: BotSummary, profileId: string | null) => void;
}) {
  const fallback = profiles?.find((profile) => profile.default);
  return (
    <section className="settings-section" aria-labelledby="bot-profiles-heading">
      <h3 id="bot-profiles-heading">Model profiles</h3>
      <p className="muted">Which profile each bot runs. Edit profiles under Profiles.</p>
      {bots === undefined || profiles === undefined ? (
        <Loading />
      ) : (
        <div className="settings-fields">
          {bots.map((bot) => (
            <label key={bot.id} className="settings-field">
              <span>
                <strong>{bot.name}</strong>
              </span>
              <select
                aria-label={`Profile for ${bot.name}`}
                value={bot.defaultProfile ? "" : bot.profileId}
                disabled={disabled}
                onChange={(event) => onSet(bot, event.target.value || null)}
              >
                <option value="">Default ({fallback?.name ?? "none"})</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}
    </section>
  );
}

/** Account notes: plans, tiers, keys and rough monthly comfort spend. Guidance for Admin Bot. */
export function AccountNotes({
  notes,
  disabled,
  onSave,
}: {
  notes: string | undefined;
  disabled?: boolean;
  onSave: (notes: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  if (notes === undefined) return <Loading />;
  const value = draft ?? notes;
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
    <form
      className="settings-section"
      aria-labelledby="account-notes-heading"
      onSubmit={(event) => void submit(event)}
    >
      <h3 id="account-notes-heading">Account notes</h3>
      <p className="muted">
        Your subscriptions, tiers, API keys and roughly what you're comfortable spending each month.
        Admin Bot reads these when it picks models. Guidance, not hard limits. Never put keys here:
        add them under Account &amp; sign-ins.
      </p>
      <textarea
        aria-label="Account notes"
        rows={5}
        value={value}
        disabled={disabled || saving}
        placeholder="e.g. ChatGPT Pro ($200/mo), Claude Max ($100/mo), OpenRouter key: ~$50/month is fine"
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="settings-actions">
        <button type="submit" className="primary" disabled={disabled || saving || value === notes}>
          {saving ? "Saving…" : "Save notes"}
        </button>
      </div>
    </form>
  );
}
