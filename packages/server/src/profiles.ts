import { dirname } from "node:path";
import {
  type PiBotConfig,
  type PoolModel,
  PROFILE_ID,
  type Profile,
  type ProfileSet,
  parseConfig,
  parseModelRef,
} from "./config.ts";
import { updateConfigFile } from "./settings/config-file.ts";
import { setTomlValues } from "./settings/toml-edit.ts";

export class ProfileError extends Error {}

/**
 * A live profile change that would overwrite an edit saved straight to config.toml (raw editor or
 * `config.update`) that only applies after a restart.
 */
export class ProfileConflictError extends ProfileError {
  override name = "ProfileConflictError";
}

/** The most main-model fallbacks a profile may list. */
export const MAX_FALLBACKS = 5;

/** What a client or Admin Bot sends to create or replace a profile. */
export type ProfileInput = {
  readonly id: string;
  readonly name: string;
  readonly main: string;
  /** Ordered main-model fallbacks for usage limits, at most 5. */
  readonly fallbacks?: readonly string[];
  /** Memory extraction model; omitted, null or "": the active main model. */
  readonly memoryModel?: string | null;
  /** Model preferences: free text for choosing subagent models. */
  readonly guidance?: string;
  /** Additional subagent models with optional notes. */
  readonly pool?: readonly { model: string; useFor?: string }[];
};

/** What `ProfileStore` persists: the new set, and the set it replaces (only the change is written). */
export type ProfileWrite = ProfileSet & { readonly previous?: ProfileSet };

export type ProfileStoreOptions = {
  /** Writes the profiles to config.toml; omitted (tests, no config file): memory only. */
  readonly persist?: (set: ProfileWrite) => Promise<void>;
  /** Throws for a model this server does not know (Settings' model check). */
  readonly checkModel?: (ref: string) => void;
};

/**
 * The live model profiles. Changes apply without a restart: they are written to config.toml
 * (`[profiles.<id>]`, `[models] default_profile`) and listeners re-apply the main model to the
 * affected bots, which takes effect from their next request.
 */
export class ProfileStore {
  #set: ProfileSet;
  readonly #options: ProfileStoreOptions;
  readonly #listeners = new Set<(previous: ProfileSet) => void | Promise<void>>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(set: ProfileSet, options: ProfileStoreOptions = {}) {
    this.#set = set;
    this.#options = options;
  }

  get defaultId(): string {
    return this.#set.defaultId;
  }

  list(): readonly Profile[] {
    return this.#set.profiles;
  }

  snapshot(): ProfileSet {
    return this.#set;
  }

  get(id: string): Profile | undefined {
    return this.#set.profiles.find((profile) => profile.id === id);
  }

  /** The profile a bot runs: its assigned one, or the default (also for a missing id). */
  resolve(id: string | undefined): Profile {
    const found = (id ? this.get(id) : undefined) ?? this.get(this.#set.defaultId);
    if (!found) throw new ProfileError("no default profile");
    return found;
  }

  /** Called after every change with the set before it. */
  onChange(listener: (previous: ProfileSet) => void | Promise<void>): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Create (`create: true`, the id must be new) or replace a profile. */
  save(input: ProfileInput, options: { readonly create?: boolean } = {}): Promise<Profile> {
    return this.#change((set) => {
      const profile = this.#validate(input);
      const exists = set.profiles.some((entry) => entry.id === profile.id);
      if (options.create && exists)
        throw new ProfileError(`profile "${profile.id}" already exists`);
      if (!options.create && !exists) throw new ProfileError(`no profile "${profile.id}"`);
      const profiles = exists
        ? set.profiles.map((entry) => (entry.id === profile.id ? profile : entry))
        : [...set.profiles, profile];
      return { next: { ...set, profiles }, result: profile };
    });
  }

  /** Delete a profile. The default cannot be deleted; bots on it fall back to the default. */
  remove(id: string): Promise<void> {
    return this.#change((set) => {
      if (id === set.defaultId) throw new ProfileError("the default profile cannot be deleted");
      if (!set.profiles.some((entry) => entry.id === id))
        throw new ProfileError(`no profile "${id}"`);
      return {
        next: { ...set, profiles: set.profiles.filter((entry) => entry.id !== id) },
        result: undefined,
      };
    });
  }

  setDefault(id: string): Promise<void> {
    return this.#change((set) => {
      if (!set.profiles.some((entry) => entry.id === id))
        throw new ProfileError(`no profile "${id}"`);
      return { next: { ...set, defaultId: id }, result: undefined };
    });
  }

  #validate(input: ProfileInput): Profile {
    const id = input.id.trim();
    if (!PROFILE_ID.test(id)) {
      throw new ProfileError(
        `invalid profile id "${id}": lowercase letters, digits, - and _ (max 40)`,
      );
    }
    const name = input.name.trim();
    if (!name || name.length > 80) throw new ProfileError("profile name is required (max 80)");
    const check = (ref: string) => {
      try {
        parseModelRef(ref);
      } catch {
        throw new ProfileError(`invalid model "${ref}": expected provider/model-id`);
      }
      this.#options.checkModel?.(ref);
    };
    check(input.main);
    const fallbacks: string[] = [];
    for (const ref of input.fallbacks ?? []) {
      check(ref);
      if (ref === input.main) throw new ProfileError(`${ref} is the main model, not a fallback`);
      if (fallbacks.includes(ref)) throw new ProfileError(`fallbacks list ${ref} twice`);
      fallbacks.push(ref);
    }
    if (fallbacks.length > MAX_FALLBACKS) {
      throw new ProfileError(`at most ${MAX_FALLBACKS} fallback models`);
    }
    const pool: PoolModel[] = [];
    for (const entry of input.pool ?? []) {
      check(entry.model);
      if (pool.some((existing) => existing.model === entry.model)) {
        throw new ProfileError(`pool lists ${entry.model} twice`);
      }
      pool.push({ model: entry.model, useFor: (entry.useFor ?? "").trim().slice(0, 500) });
    }
    const memoryModel = input.memoryModel?.trim() || undefined;
    if (memoryModel) check(memoryModel);
    const guidance = input.guidance?.trim();
    if (guidance && guidance.length > 4000)
      throw new ProfileError("model preferences are too long (max 4000)");
    return {
      id,
      name,
      main: input.main,
      ...(fallbacks.length ? { fallbacks } : {}),
      ...(memoryModel ? { memoryModel } : {}),
      ...(guidance ? { guidance } : {}),
      pool,
    };
  }

  /** Serialize changes: compute, persist, swap, notify. */
  #change<T>(compute: (set: ProfileSet) => { next: ProfileSet; result: T }): Promise<T> {
    const run = this.#queue.then(async () => {
      const previous = this.#set;
      const { next, result } = compute(previous);
      await this.#options.persist?.({ ...next, previous });
      this.#set = next;
      for (const listener of this.#listeners) await listener(previous);
      return result;
    });
    this.#queue = run.catch(() => {});
    return run;
  }
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const key = (value: string) => (BARE_KEY.test(value) ? value : JSON.stringify(value));

/** `[profiles.<id>]` tables for config.toml. */
export function renderProfiles(set: ProfileSet): string {
  const blocks: string[] = [];
  for (const profile of set.profiles) {
    const lines = [
      `[profiles.${key(profile.id)}]`,
      `name = ${JSON.stringify(profile.name)}`,
      `main = ${JSON.stringify(profile.main)}`,
    ];
    if (profile.fallbacks?.length) {
      lines.push(`fallbacks = [${profile.fallbacks.map((ref) => JSON.stringify(ref)).join(", ")}]`);
    }
    if (profile.memoryModel) lines.push(`memory_model = ${JSON.stringify(profile.memoryModel)}`);
    if (profile.guidance) lines.push(`guidance = ${JSON.stringify(profile.guidance)}`);
    blocks.push(lines.join("\n"));
    for (const entry of profile.pool) {
      blocks.push(
        [
          `[profiles.${key(profile.id)}.pool.${JSON.stringify(entry.model)}]`,
          `use_for = ${JSON.stringify(entry.useFor)}`,
        ].join("\n"),
      );
    }
  }
  return `${blocks.join("\n\n")}\n`;
}

function headerName(line: string): string | undefined {
  const match = /^\s*\[\[?([^[\]]+)\]\]?\s*(#.*)?$/.exec(line);
  if (!match?.[1]) return undefined;
  return match[1]
    .split(/\.(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((part) => part.trim().replace(/^"(.*)"$/, "$1"))
    .join(".");
}

/**
 * Replace every `[profiles...]` table with `set`, set `[models] default_profile`, and drop the
 * legacy `[models] orchestrator`/`background` keys. Other tables keep their comments and layout.
 */
export function writeProfilesToml(text: string, set: ProfileSet): string {
  const kept: string[] = [];
  let skipping = false;
  let section = "";
  for (const line of text.split("\n")) {
    const name = headerName(line);
    if (name !== undefined) {
      section = name;
      skipping = name === "profiles" || name.startsWith("profiles.");
    }
    if (skipping) continue;
    if (section === "models" && /^\s*(orchestrator|background)\s*=/.test(line)) continue;
    kept.push(line);
  }
  let next = kept.join("\n").replace(/\n{3,}/g, "\n\n");
  next = setTomlValues(next, [{ path: ["models", "default_profile"], value: set.defaultId }]);
  return `${next.replace(/\s*$/, "")}\n\n${renderProfiles(set)}`;
}

/** A profile's content, for comparing what the file holds with what runs. */
function canonical(profile: Profile | undefined): string | undefined {
  if (!profile) return undefined;
  return JSON.stringify({
    name: profile.name,
    main: profile.main,
    fallbacks: profile.fallbacks ?? [],
    memoryModel: profile.memoryModel ?? "",
    guidance: profile.guidance ?? "",
    pool: profile.pool.map((entry) => ({ model: entry.model, useFor: entry.useFor })),
  });
}

const sameProfile = (a: Profile | undefined, b: Profile | undefined) =>
  canonical(a) === canonical(b);

/** Whether a table header belongs to profile `id` (`[profiles.<id>]` or one of its sub-tables). */
const ownedBy = (name: string, id: string) =>
  name === `profiles.${id}` || name.startsWith(`profiles.${id}.`);

/**
 * Write only what changed from `previous` to `next` into `text`, whose profiles are `file`: each
 * changed profile's tables are replaced where they are (removed ones dropped, new ones appended) and
 * `default_profile` is set if the default changed. Everything else, other profiles included, stays
 * as the file has it, so edits saved to the file that wait for a restart survive a live change to
 * another profile. Throws `ProfileConflictError` when a changed profile (or the default) has such a
 * pending edit: the live change was made against what runs, not against what the file now says.
 */
export function patchProfilesToml(
  text: string,
  file: ProfileSet,
  previous: ProfileSet,
  next: ProfileSet,
): string {
  const before = new Map(previous.profiles.map((profile) => [profile.id, profile]));
  const after = new Map(next.profiles.map((profile) => [profile.id, profile]));
  const inFile = new Map(file.profiles.map((profile) => [profile.id, profile]));
  const changed: string[] = [];
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    if (sameProfile(before.get(id), after.get(id))) continue;
    // Removing a profile the file already dropped is fine; anything else must match what runs.
    const pending = after.has(id)
      ? !sameProfile(inFile.get(id), before.get(id))
      : inFile.has(id) && !sameProfile(inFile.get(id), before.get(id));
    if (pending) {
      throw new ProfileConflictError(
        `profile "${id}" has edits saved in config.toml that apply after a restart; restart Pi Bot first, or make this change in the file`,
      );
    }
    changed.push(id);
  }
  const defaultChanged = next.defaultId !== previous.defaultId;
  if (defaultChanged && file.defaultId !== previous.defaultId) {
    throw new ProfileConflictError(
      "the default profile was changed in config.toml and applies after a restart; restart Pi Bot first, or make this change in the file",
    );
  }
  if (changed.length === 0 && !defaultChanged) return text;

  const render = (id: string) => {
    const profile = after.get(id);
    return profile ? renderProfiles({ defaultId: next.defaultId, profiles: [profile] }) : "";
  };
  const kept: string[] = [];
  const placed = new Set<string>();
  let skipping = false;
  /** Comments at the end of a replaced table introduce the next one: they stay with it. */
  let trailing: string[] = [];
  for (const line of text.split("\n")) {
    const name = headerName(line);
    if (name !== undefined) {
      const owner = changed.find((id) => ownedBy(name, id));
      if (skipping && owner === undefined) kept.push(...trailing);
      trailing = [];
      skipping = owner !== undefined;
      if (owner !== undefined && !placed.has(owner)) {
        placed.add(owner);
        const block = render(owner);
        if (block) kept.push(block);
      }
    }
    if (!skipping) kept.push(line);
    else if (name === undefined) trailing = /^\s*#/.test(line) ? [...trailing, line] : [];
  }
  let out = kept.join("\n").replace(/\n{3,}/g, "\n\n");
  const added = changed.filter((id) => !placed.has(id) && after.has(id)).map(render);
  if (added.length) out = `${out.replace(/\s*$/, "")}\n\n${added.join("\n")}`;
  if (defaultChanged) {
    out = setTomlValues(out, [{ path: ["models", "default_profile"], value: next.defaultId }]);
  }
  return out.endsWith("\n") ? out : `${out}\n`;
}

function parseOrThrow(text: string, path: string): PiBotConfig {
  try {
    return parseConfig(text, dirname(path), path);
  } catch (error) {
    throw new ProfileError((error as Error).message);
  }
}

/**
 * Persist profiles into the config file at `path` (validated, atomic, mode kept), serialized with
 * every other config.toml write (`updateConfigFile`). With `set.previous` only the change is written
 * (`patchProfilesToml`); without it, or while the file has no `[profiles]` yet (legacy roles), every
 * profile table is rewritten (`writeProfilesToml`).
 */
export async function persistProfiles(path: string, set: ProfileWrite): Promise<void> {
  const next: ProfileSet = { defaultId: set.defaultId, profiles: set.profiles };
  await updateConfigFile(path, ({ text }) => {
    let written: string | undefined;
    if (set.previous && text.trim()) {
      const current = parseOrThrow(text, path);
      if (Object.keys(current.profiles).length > 0) {
        written = patchProfilesToml(text, current.modelProfiles, set.previous, next);
      }
    }
    written ??= writeProfilesToml(text, next);
    parseOrThrow(written, path);
    return written;
  });
}

/** A profile as tools and clients see it. */
export function describeProfile(profile: Profile, defaultId: string) {
  return {
    id: profile.id,
    name: profile.name,
    main: profile.main,
    ...(profile.fallbacks?.length ? { fallbacks: [...profile.fallbacks] } : {}),
    ...(profile.memoryModel ? { memoryModel: profile.memoryModel } : {}),
    ...(profile.guidance ? { guidance: profile.guidance } : {}),
    pool: profile.pool.map((entry) => ({ model: entry.model, useFor: entry.useFor })),
    ...(profile.id === defaultId ? { default: true } : {}),
  };
}

const LEGACY_BACKGROUND = /^\s*(?:background|"background")\s*=/;

/**
 * Rewrite the legacy pool `background` flags of `text` in place: each flagged profile without a
 * `memory_model` gets `memory_model = "<that pool model>"` in its own table, and every pool
 * `background = …` line is dropped. Line-level, so comments and layout stay. Returns undefined
 * when there is nothing to rewrite, or when the rewrite would change any profile as parsed (a
 * profile defined in a form these line edits can't reach): then the file is left as it is and
 * the flags keep being read as the memory model.
 */
export function migrateLegacyBackground(text: string, path?: string): string | undefined {
  let before: PiBotConfig;
  try {
    before = parseConfig(text, path ? dirname(path) : undefined, path);
  } catch {
    return undefined;
  }
  const flagged = Object.entries(before.profiles).filter(([, profile]) =>
    Object.values(profile.pool).some((entry) => entry.background !== undefined),
  );
  if (flagged.length === 0) return undefined;
  const lines = text.split("\n");
  const kept: string[] = [];
  let section = "";
  for (const line of lines) {
    const name = headerName(line);
    if (name !== undefined) section = name;
    if (/^profiles\.[^.]+\.pool\./.test(section) && LEGACY_BACKGROUND.test(line)) continue;
    kept.push(line);
  }
  let next = kept.join("\n");
  for (const [id, profile] of flagged) {
    if (profile.memory_model) continue;
    const memory = Object.entries(profile.pool).find(([, entry]) => entry.background === true)?.[0];
    if (!memory) continue;
    const header = kept.findIndex((line) => headerName(line) === `profiles.${id}`);
    if (header < 0) return undefined;
    next = setTomlValues(next, [{ path: ["profiles", id, "memory_model"], value: memory }]);
  }
  try {
    const after = parseConfig(next, path ? dirname(path) : undefined, path);
    const same = (a: ProfileSet, b: ProfileSet) =>
      a.defaultId === b.defaultId &&
      a.profiles.length === b.profiles.length &&
      a.profiles.every((profile, index) => sameProfile(profile, b.profiles[index]));
    if (!same(before.modelProfiles, after.modelProfiles)) return undefined;
    const leftover = Object.values(after.profiles).some((profile) =>
      Object.values(profile.pool).some((entry) => entry.background !== undefined),
    );
    if (leftover) return undefined;
  } catch {
    return undefined;
  }
  return next;
}

/**
 * On start: rewrite legacy pool `background` flags in the config file at `path` as
 * `memory_model` (`migrateLegacyBackground`), serialized with every other config.toml write.
 * Returns whether the file changed.
 */
export async function migrateLegacyBackgroundFile(path: string): Promise<boolean> {
  let changed = false;
  await updateConfigFile(path, ({ text }) => {
    const next = migrateLegacyBackground(text, path);
    if (next === undefined || next === text) return text;
    changed = true;
    return next;
  });
  return changed;
}
