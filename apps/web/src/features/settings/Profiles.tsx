import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { Icon } from "../../components/Icon.tsx";
import { Loading } from "../../components/ui.tsx";
import type {
  BotSummary,
  ModelPricing,
  PriceRates,
  ProfileInput,
  ProfileSummary,
  ProviderModels,
} from "../../protocol.ts";

const isKnown = (providers: readonly ProviderModels[], ref: string) =>
  providers.some((p) => p.models.some((m) => `${p.id}/${m.id}` === ref));

/** A model from the signed-in providers; a ref no provider offers shows as "not signed in". */
export function ModelSelect({
  providers,
  value,
  label,
  disabled,
  emptyLabel,
  onChange,
}: {
  providers: readonly ProviderModels[];
  value: string;
  label: string;
  disabled?: boolean;
  /** An always-offered first choice with the value "" (e.g. "Use active main model"). */
  emptyLabel?: string;
  onChange: (model: string) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      {emptyLabel !== undefined ? (
        <option value="">{emptyLabel}</option>
      ) : value === "" ? (
        <option value="">Pick a model…</option>
      ) : null}
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
  /** "" = use the active main model. */
  memoryModel: string;
  guidance: string;
  pool: { key: number; model: string; useFor: string }[];
};

let poolKeys = 0;

/** Ordered main-model fallbacks a profile may have. Mirrors the server's MAX_FALLBACKS. */
export const MAX_FALLBACKS = 5;

/** The memory model choice that means "whatever main model the bot runs at that moment". */
export const ACTIVE_MAIN_MODEL = "Use active main model";

export const toDraft = (profile?: ProfileSummary): Draft => ({
  id: profile?.id ?? "",
  name: profile?.name ?? "",
  main: profile?.main ?? "",
  fallbacks: (profile?.fallbacks ?? []).map((model) => ({ key: poolKeys++, model })),
  memoryModel: profile?.memoryModel ?? "",
  guidance: profile?.guidance ?? "",
  pool: (profile?.pool ?? []).map((entry) => ({
    key: poolKeys++,
    model: entry.model,
    useFor: entry.useFor,
  })),
});

export const toInput = (draft: Draft): ProfileInput => ({
  id: draft.id.trim(),
  name: draft.name.trim(),
  main: draft.main,
  fallbacks: draft.fallbacks.map((entry) => entry.model).filter(Boolean),
  ...(draft.memoryModel ? { memoryModel: draft.memoryModel } : {}),
  ...(draft.guidance.trim() ? { guidance: draft.guidance.trim() } : {}),
  pool: draft.pool
    .filter((entry) => entry.model)
    .map((entry) => ({ model: entry.model, useFor: entry.useFor.trim() })),
});

const findModel = (providers: readonly ProviderModels[], ref: string) => {
  for (const provider of providers) {
    const model = provider.models.find((entry) => `${provider.id}/${entry.id}` === ref);
    if (model) return { provider, model };
  }
  return undefined;
};

/**
 * Catalog values as given, never rounded to $0: `$2.5`, `$0.125`, `$0.000001`. Only float noise past
 * 10 significant digits is dropped.
 */
export const usd = (value: number) =>
  `$${Number(value.toPrecision(10)).toLocaleString("en-US", {
    useGrouping: false,
    maximumFractionDigits: 20,
  })}`;
const tokens = (value: number) =>
  value >= 1_000_000 && value % 1_000_000 === 0
    ? `${value / 1_000_000}M`
    : value >= 1000
      ? `${Math.round(value / 1000)}k`
      : String(value);

/** A model's raw API list price as shown in the editor. */
export function priceText(pricing: ModelPricing | undefined): string {
  if (!pricing || pricing.status === "unknown") return "API price unknown";
  if (pricing.status === "zero") return "API price listed as $0 (free or unpriced)";
  const tiered = pricing.tiers?.length ? " (other rates above set input sizes)" : "";
  return `${ratesText(pricing.rates)} per 1M tokens${tiered}`;
}

const ratesText = (rates: PriceRates) =>
  `${usd(rates.input)} in · ${usd(rates.output)} out · ${usd(rates.cacheRead)} cache read · ${usd(rates.cacheWrite)} cache write`;

/** Every price tier, as listed: no assumption that a tier costs more. */
export function priceTierTexts(pricing: ModelPricing | undefined): string[] {
  if (pricing?.status !== "listed") return [];
  return (pricing.tiers ?? []).map(
    (tier) =>
      `Above ${tokens(tier.inputTokensAbove)} input tokens: ${ratesText(tier)} per 1M tokens`,
  );
}

/** A model's catalog facts, with its price tiers (if any) in an expandable list. */
function ModelFacts({ providers, model }: { providers: readonly ProviderModels[]; model: string }) {
  const tiers = priceTierTexts(findModel(providers, model)?.model.pricing);
  return (
    <div className="profile-model-facts">
      <small className="muted">{modelFactsText(providers, model)}</small>
      {tiers.length ? (
        <details className="profile-price-tiers">
          <summary>Price tiers by input size</summary>
          <ul>
            {tiers.map((tier) => (
              <li key={tier}>
                <small className="muted">{tier}</small>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/** Price, capabilities, access and limit state of one model, from the server's catalog. */
export function modelFactsText(providers: readonly ProviderModels[], ref: string): string {
  const found = findModel(providers, ref);
  if (!found) return "Not signed in: no catalog details";
  const { provider, model } = found;
  const parts = [priceText(model.pricing)];
  if (model.contextWindow) parts.push(`${tokens(model.contextWindow)} context`);
  if (model.maxTokens) parts.push(`${tokens(model.maxTokens)} max output`);
  if (model.input?.length) parts.push(model.input.join(", "));
  if (model.reasoning) parts.push("reasoning");
  if (provider.access && provider.access.kind !== "unknown") parts.push(provider.access.label);
  if (model.limit) {
    const reset = model.limit.resetsAt
      ? `resets ${new Date(model.limit.resetsAt).toISOString().replace("T", " ").slice(0, 16)} UTC`
      : "reset unknown";
    parts.push(`${model.limit.label}, ${reset}`);
  }
  return parts.join(" · ");
}

/** Where the shown prices come from, once for the section. */
function pricingSources(providers: readonly ProviderModels[], refs: readonly string[]): string[] {
  const sources = new Set<string>();
  for (const ref of refs) {
    const pricing = findModel(providers, ref)?.model.pricing;
    if (pricing && pricing.status !== "unknown") sources.add(pricing.source);
  }
  return [...sources];
}

/** One folding part of the profile editor; its summary line keeps the editor scannable. */
function EditorSection({
  title,
  summary,
  problem,
  open = false,
  children,
}: {
  title: string;
  summary: string;
  problem?: string | undefined;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="profile-section" open={open}>
      <summary>
        <span className="profile-section-title">{title}</span>
        <span className={problem ? "profile-section-summary danger" : "profile-section-summary"}>
          {problem ?? summary}
        </span>
      </summary>
      <div className="profile-section-body">{children}</div>
    </details>
  );
}

/**
 * Create or edit one profile: name, main model, fallbacks, memory extraction model, model pool
 * (with optional notes and each model's catalog facts) and model preferences.
 */
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
      pool: current.pool.map((entry, at) => (at === index ? { ...entry, ...change } : entry)),
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

  const poolModels = draft.pool.filter((entry) => entry.model);
  const sources = pricingSources(providers, [
    ...(draft.main ? [draft.main] : []),
    ...poolModels.map((entry) => entry.model),
  ]);
  return (
    <form
      className="profile-editor"
      aria-label={isNew ? "New profile" : `Edit ${profile.name}`}
      onSubmit={(event) => void submit(event)}
    >
      <div className="profile-editor-head">
        <label className="profile-editor-field">
          <span>Name</span>
          <input
            value={draft.name}
            disabled={busy}
            placeholder="e.g. Coding"
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </label>
        {isNew ? (
          <label className="profile-editor-field">
            <span>
              Id{" "}
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
      </div>
      <EditorSection title="Main model" summary={draft.main || "Not set"} open>
        <p className="muted">Runs the main channel and every thread.</p>
        <ModelSelect
          providers={providers}
          value={draft.main}
          label="Main model"
          disabled={busy}
          onChange={(main) => setDraft({ ...draft, main })}
        />
      </EditorSection>
      <EditorSection
        title="Fallbacks"
        summary={fallbackModels.length ? fallbackModels.join(" → ") : "None, the bot pauses"}
        problem={fallbackProblem}
        open={fallbackProblem !== undefined}
      >
        <p className="muted">
          Up to {MAX_FALLBACKS}, tried in order when the main model hits a usage limit or runs out
          of credits. The bot switches back once it resets.
        </p>
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
      </EditorSection>
      <EditorSection title="Memory extraction" summary={draft.memoryModel || ACTIVE_MAIN_MODEL}>
        <p className="muted">
          Reviews new conversation messages and saves useful facts into the bot's memory, on the
          extraction schedule and when the bot goes idle, if memory extraction is enabled. Doesn't
          affect chat or subagents.
        </p>
        <ModelSelect
          providers={providers}
          value={draft.memoryModel}
          label="Memory extraction model"
          emptyLabel={ACTIVE_MAIN_MODEL}
          disabled={busy}
          onChange={(memoryModel) => setDraft({ ...draft, memoryModel })}
        />
        {draft.memoryModel ? <ModelFacts providers={providers} model={draft.memoryModel} /> : null}
      </EditorSection>
      <EditorSection
        title="Model pool"
        summary={
          poolModels.length
            ? `Main model + ${poolModels.map((entry) => entry.model).join(", ")}`
            : "Main model only"
        }
      >
        <p className="muted">
          Additional models available for subagents. The main model can always spawn subagents using
          itself, even when this list is empty.
        </p>
        <div className="profile-pool-rows">
          {draft.main ? (
            <div className="profile-pool-row profile-pool-self">
              <span className="profile-pool-self-label">
                Main model <code>{draft.main}</code>
              </span>
              <ModelFacts providers={providers} model={draft.main} />
            </div>
          ) : null}
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
                aria-label={`Notes on pool model ${index + 1}`}
                value={entry.useFor}
                disabled={busy}
                placeholder="Notes (optional)"
                onChange={(event) => setPool(index, { useFor: event.target.value })}
              />
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
              {entry.model ? <ModelFacts providers={providers} model={entry.model} /> : null}
            </div>
          ))}
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() =>
              setDraft({
                ...draft,
                pool: [...draft.pool, { key: poolKeys++, model: "", useFor: "" }],
              })
            }
          >
            <Icon icon={Plus} size={13} weight="control" />
            Add pool model
          </button>
          <small className="muted profile-pricing-note">
            Prices are raw API list prices in USD: a relative cost signal, also for subscription
            models, not an exact measure of a subscription's allowance or charges.
            {sources.length ? ` Source: ${sources.join("; ")}.` : ""}
          </small>
        </div>
      </EditorSection>
      <EditorSection title="Model preferences" summary={draft.guidance.trim() || "None"}>
        <p className="muted">
          Describe your preferences and experiences with these models. The main model uses this
          guidance when choosing models for subagents.
        </p>
        <textarea
          aria-label="Model preferences"
          rows={3}
          value={draft.guidance}
          disabled={busy}
          placeholder="e.g. Opus writes nicer code. Sol is thorough. Check Astra's work."
          onChange={(event) => setDraft({ ...draft, guidance: event.target.value })}
        />
      </EditorSection>
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
        A profile is a main model for a bot's channel and threads, which can run subagents on itself
        or on the models in its pool. New bots get the default. Changes apply from each bot's next
        reply.
      </p>
      <ul className="settings-list">
        {profiles.map((profile) => {
          const using = users(profile);
          return editing === profile.id ? (
            <li key={profile.id} className="profile-editing">
              <ProfileEditor
                profile={profile}
                providers={providers}
                {...(disabled ? { disabled } : {})}
                onSave={(input) => save(input, false)}
                onCancel={() => setEditing(undefined)}
              />
            </li>
          ) : (
            <li key={profile.id} className="settings-row profile-row">
              <div className="settings-row-text">
                <strong>
                  {profile.name}
                  {profile.default ? <span className="badge">Default</span> : null}
                </strong>
                <small className="muted">
                  <code>{profile.main}</code>
                  {profile.fallbacks?.length
                    ? ` → ${profile.fallbacks.join(" → ")}`
                    : " · no fallbacks"}
                </small>
                <small className="muted">
                  {profile.pool.length
                    ? `Model pool: main model + ${profile.pool.map((entry) => entry.model).join(", ")}`
                    : "Model pool: main model only"}
                  {" · "}
                  {`Memory extraction: ${profile.memoryModel ?? "active main model"}`}
                  {" · "}
                  {using.length ? `Used by ${using.join(", ")}` : "No bots"}
                </small>
              </div>
              <span className="profile-actions">
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
                      className="icon-button danger"
                      aria-label={`Delete profile ${profile.name}`}
                      title="Delete profile"
                      disabled={disabled}
                      onClick={() => onDelete(profile)}
                    >
                      <Icon icon={Trash2} size={14} />
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="secondary"
                  disabled={disabled || editing !== undefined}
                  onClick={() => setEditing(profile.id)}
                >
                  Edit
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      {editing === "" ? (
        <div className="profile-editing">
          <ProfileEditor
            providers={providers}
            {...(disabled ? { disabled } : {})}
            onSave={(input) => save(input, true)}
            onCancel={() => setEditing(undefined)}
          />
        </div>
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
