import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type PoolModel,
  PROFILE_ID,
  type Profile,
  type ProfileSet,
  parseConfig,
  parseModelRef,
} from "./config.ts";
import { setTomlValues } from "./settings/toml-edit.ts";

export class ProfileError extends Error {}

/** What a client or Admin Bot sends to create or replace a profile. */
export type ProfileInput = {
  readonly id: string;
  readonly name: string;
  readonly main: string;
  readonly guidance?: string;
  readonly pool?: readonly { model: string; useFor?: string; background?: boolean }[];
};

export type ProfileStoreOptions = {
  /** Writes the profiles to config.toml; omitted (tests, no config file): memory only. */
  readonly persist?: (set: ProfileSet) => Promise<void>;
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
    const pool: PoolModel[] = [];
    for (const entry of input.pool ?? []) {
      check(entry.model);
      if (pool.some((existing) => existing.model === entry.model)) {
        throw new ProfileError(`pool lists ${entry.model} twice`);
      }
      pool.push({
        model: entry.model,
        useFor: (entry.useFor ?? "").trim().slice(0, 500),
        background: entry.background === true,
      });
    }
    if (pool.filter((entry) => entry.background).length > 1) {
      throw new ProfileError("flag at most one pool model for background work");
    }
    const guidance = input.guidance?.trim();
    if (guidance && guidance.length > 4000)
      throw new ProfileError("guidance is too long (max 4000)");
    return { id, name, main: input.main, ...(guidance ? { guidance } : {}), pool };
  }

  /** Serialize changes: compute, persist, swap, notify. */
  #change<T>(compute: (set: ProfileSet) => { next: ProfileSet; result: T }): Promise<T> {
    const run = this.#queue.then(async () => {
      const previous = this.#set;
      const { next, result } = compute(previous);
      await this.#options.persist?.(next);
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
    if (profile.guidance) lines.push(`guidance = ${JSON.stringify(profile.guidance)}`);
    blocks.push(lines.join("\n"));
    for (const entry of profile.pool) {
      const pool = [
        `[profiles.${key(profile.id)}.pool.${JSON.stringify(entry.model)}]`,
        `use_for = ${JSON.stringify(entry.useFor)}`,
      ];
      if (entry.background) pool.push("background = true");
      blocks.push(pool.join("\n"));
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

/** Persist profiles into the config file at `path` (validated, atomic, mode kept). */
export async function persistProfiles(path: string, set: ProfileSet): Promise<void> {
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const next = writeProfilesToml(text, set);
  try {
    parseConfig(next, dirname(path), path);
  } catch (error) {
    throw new ProfileError((error as Error).message);
  }
  let mode = 0o600;
  try {
    mode = (await stat(path)).mode & 0o777;
  } catch {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  }
  const temp = join(dirname(path), `.config.toml.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temp, next, { mode });
  await chmod(temp, mode);
  await rename(temp, path);
}

/** A profile as tools and clients see it. */
export function describeProfile(profile: Profile, defaultId: string) {
  return {
    id: profile.id,
    name: profile.name,
    main: profile.main,
    ...(profile.guidance ? { guidance: profile.guidance } : {}),
    pool: profile.pool.map((entry) => ({
      model: entry.model,
      useFor: entry.useFor,
      ...(entry.background ? { background: true } : {}),
    })),
    ...(profile.id === defaultId ? { default: true } : {}),
  };
}
