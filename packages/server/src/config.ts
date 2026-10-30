import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { TITLE_REASONING } from "./titles.ts";

/** `provider/model-id`, e.g. `openai/gpt-6-sol`. The model id may contain further slashes. */
export type ModelRef = { readonly provider: string; readonly modelId: string };

const MODEL_REF = /^([a-z0-9][a-z0-9._-]*)\/(\S+)$/;

export function parseModelRef(value: string): ModelRef {
  const match = MODEL_REF.exec(value);
  if (!match?.[1] || !match[2]) throw new Error(`invalid model reference: ${value}`);
  return { provider: match[1], modelId: match[2] };
}

function ipv4ToInt(address: string): number {
  return address.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inIpv4Cidr(address: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(address) & mask) === (ipv4ToInt(base) & mask);
}

/**
 * Pi Bot must never listen on the public internet: only loopback or the Tailscale tailnet
 * (CGNAT 100.64.0.0/10 and the tailnet ULA fd7a:115c:a1e0::/48) are accepted.
 */
export function isAllowedBindHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  if (value === "localhost") return true;
  const bare = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  const family = isIP(bare);
  if (family === 4) return inIpv4Cidr(bare, "127.0.0.0", 8) || inIpv4Cidr(bare, "100.64.0.0", 10);
  if (family === 6) {
    if (bare === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
    if (mapped?.[1]) return isAllowedBindHost(mapped[1]);
    return /^fd7a:115c:a1e0:/.test(bare);
  }
  return false;
}

const CRON_FIELD = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/;

function isCronExpression(value: string): boolean {
  const fields = value.trim().split(/\s+/);
  return fields.length === 5 && fields.every((field) => CRON_FIELD.test(field));
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** `[profiles.<id>]` keys. */
export const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

const modelRef = z
  .string()
  .regex(MODEL_REF, "expected provider/model-id, e.g. openai/gpt-6-sol")
  .describe("provider/model-id");

export const configSchema = z.strictObject({
  server: z
    .strictObject({
      host: z
        .string()
        .default("127.0.0.1")
        .refine(isAllowedBindHost, "must be a loopback or tailnet address, never public"),
      port: z.number().int().min(0).max(65535).default(4317),
      /** Built web client to serve; defaults to apps/web/dist next to the server package. */
      web_dir: z.string().optional(),
    })
    .prefault({}),
  storage: z
    .strictObject({
      data_dir: z.string().min(1).default("~/.local/share/pi-bot"),
    })
    .prefault({}),
  /** Global model settings. Bots get their models from `[profiles]`; there is no per-message picker. */
  models: z
    .strictObject({
      /** The profile every bot runs unless it is assigned another (`[profiles.<id>]`). */
      default_profile: z.string().regex(PROFILE_ID).optional(),
      /** Legacy: before profiles, the bots' model. Read as the main model of a synthesized default profile. */
      orchestrator: modelRef.optional(),
      /** Legacy: the old background role. Read as that profile's pool model for background work. */
      background: modelRef.optional(),
      /** Thread titles (metadata for listing and search), generated from a thread's first message. */
      titles: z
        .strictObject({
          model: modelRef.default("openai-codex/gpt-6-luna"),
          reasoning: z.enum(TITLE_REASONING).default("high"),
        })
        .prefault({}),
    })
    .prefault({}),
  /**
   * Model profiles: a main model for a bot's main channel and threads, plus a pool of models the
   * main model may hand work to (`run_subagent`). Pool keys are `provider/model-id`.
   */
  profiles: z
    .record(
      z.string().regex(PROFILE_ID, "profile ids are lowercase letters, digits, - and _"),
      z.strictObject({
        name: z.string().trim().min(1).max(80),
        main: modelRef,
        /**
         * Ordered main-model fallbacks (at most 5). When the main model hits a usage limit or runs
         * out of credits, the bot switches to the first available one and back once it resets.
         */
        fallbacks: z.array(modelRef).max(5, "at most 5 fallbacks").default([]),
        /** Free text for the main model: when to use which pool model or reasoning level. */
        guidance: z.string().max(4000).optional(),
        pool: z
          .record(
            modelRef,
            z.strictObject({
              /** What this model is good for, shown to the main model. */
              use_for: z.string().max(500).default(""),
              /** Background work (memory extraction and the like) uses this model. */
              background: z.boolean().default(false),
            }),
          )
          .default({}),
      }),
    )
    .default({}),
  extraction: z
    .strictObject({
      schedule: z
        .string()
        .default("0 3 * * *")
        .refine(isCronExpression, "expected a 5-field cron expression"),
      timezone: z.string().default("UTC").refine(isTimeZone, "unknown IANA time zone"),
    })
    .prefault({}),
  bot_to_bot: z
    .strictObject({
      max_rounds_per_request: z.number().int().min(1).max(100).default(5),
      max_messages_per_hour_per_pair: z.number().int().min(1).max(10_000).default(30),
    })
    .prefault({}),
  /** Automatic compaction of the main channel and every thread (one implementation for both). */
  compaction: z
    .strictObject({
      enabled: z.boolean().default(true),
      /** Tokens kept free for the reply; compaction starts when the context exceeds window - reserve. */
      reserve_tokens: z.number().int().min(0).default(16_384),
      /** Recent context kept verbatim after the head marker. */
      keep_recent_tokens: z.number().int().min(0).default(20_000),
      /** Compact in the background once the context passes this size; 0 disables (as Woven does). */
      background_tokens: z.number().int().min(0).default(0),
      /** `auto`: provider-native compaction where the provider has it, Pi Durable otherwise. */
      native: z.enum(["auto", "off"]).default("auto"),
      /** Per-model overrides keyed `provider/model-id`. */
      models: z
        .record(
          modelRef,
          z.strictObject({
            enabled: z.boolean().optional(),
            reserve_tokens: z.number().int().min(0).optional(),
            keep_recent_tokens: z.number().int().min(0).optional(),
            background_tokens: z.number().int().min(0).optional(),
          }),
        )
        .default({}),
    })
    .prefault({}),
  search: z
    .strictObject({
      /** Default web search provider; its API key lives in the credential store. */
      provider: z.enum(["exa", "brave", "firecrawl"]).default("exa"),
    })
    .prefault({}),
  /** Git identity for commits a bot makes. The GitHub SSH key lives in the credential store. */
  git: z
    .strictObject({
      user_name: z.string().trim().min(1).max(200).optional(),
      user_email: z.email().max(320).optional(),
    })
    .prefault({}),
  /** Where a bot's tools run: `docker` gives each bot its own container; `none` gives no tools. */
  environment: z
    .strictObject({
      backend: z.enum(["none", "docker"]).default("none"),
      /** Image override; by default `pi-bot-env:<hash>` is built from packages/server/docker. */
      image: z.string().min(1).optional(),
    })
    .prefault({}),
  credentials: z
    .strictObject({
      /**
       * `auto`: encrypted SQLite everywhere for now (on macOS it would pick the Keychain, but that
       * store is a stub, so it falls back). `keychain` throws while the store is a stub.
       */
      backend: z.enum(["auto", "encrypted-sqlite", "keychain"]).default("auto"),
      /** AES-256-GCM key file, mode 0600, outside the database. Defaults to `<data_dir>/credentials.key`. */
      key_file: z.string().optional(),
    })
    .prefault({}),
});

export type RawConfig = z.infer<typeof configSchema>;

export type PiBotConfig = RawConfig & {
  /** Absolute path of the loaded file, if any. */
  readonly source?: string;
  readonly paths: {
    readonly dataDir: string;
    readonly database: string;
    readonly keyFile: string;
    readonly webDir?: string;
  };
  readonly roles: {
    readonly titles: ModelRef;
  };
  /** `[profiles]` normalized; legacy `[models] orchestrator`/`background` become a default profile. */
  readonly modelProfiles: ProfileSet;
};

/** One pool model the main model may delegate to. */
export type PoolModel = {
  readonly model: string;
  readonly useFor: string;
  readonly background: boolean;
};

export type Profile = {
  readonly id: string;
  readonly name: string;
  /** `provider/model-id` of the main channel and every thread. */
  readonly main: string;
  /** Ordered main-model fallbacks for usage limits (0–5); none: the bot pauses at a limit. */
  readonly fallbacks?: readonly string[];
  readonly guidance?: string;
  readonly pool: readonly PoolModel[];
};

export type ProfileSet = {
  readonly defaultId: string;
  readonly profiles: readonly Profile[];
};

function checkFallbacks(id: string, main: string, fallbacks: readonly string[]): string[] {
  const seen = new Set<string>([main]);
  for (const ref of fallbacks) {
    if (seen.has(ref)) {
      throw new Error(`profiles.${id}.fallbacks: ${ref} is listed twice or is the main model`);
    }
    seen.add(ref);
  }
  return [...fallbacks];
}

/** Profiles from the raw config, synthesizing one from the legacy model roles when there are none. */
export function normalizeProfiles(raw: RawConfig): ProfileSet {
  let profiles: Profile[] = Object.entries(raw.profiles).map(([id, value]) => ({
    id,
    name: value.name,
    main: value.main,
    ...(value.fallbacks.length
      ? { fallbacks: checkFallbacks(id, value.main, value.fallbacks) }
      : {}),
    ...(value.guidance?.trim() ? { guidance: value.guidance.trim() } : {}),
    pool: Object.entries(value.pool).map(([model, entry]) => ({
      model,
      useFor: entry.use_for,
      background: entry.background,
    })),
  }));
  if (profiles.length === 0) {
    const { orchestrator, background } = raw.models;
    if (!orchestrator) {
      throw new Error(
        'define a model profile: [profiles.default] with name = "Default" and main = "provider/model-id"',
      );
    }
    profiles = [
      {
        id: "default",
        name: "Default",
        main: orchestrator,
        pool:
          background && background !== orchestrator
            ? [{ model: background, useFor: "Background work", background: true }]
            : [],
      },
    ];
  }
  const defaultId = raw.models.default_profile ?? profiles[0]?.id ?? "default";
  if (!profiles.some((profile) => profile.id === defaultId)) {
    throw new Error(`models.default_profile: no profile "${defaultId}"`);
  }
  return { defaultId, profiles };
}

/** The model background work of a profile uses: its pool model flagged `background`, else its main model. */
export function backgroundModel(profile: Profile): string {
  return profile.pool.find((entry) => entry.background)?.model ?? profile.main;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

function expandPath(value: string, baseDir: string): string {
  const expanded = value === "~" || value.startsWith("~/") ? homedir() + value.slice(1) : value;
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

/** Validate an already-parsed TOML document. Relative paths resolve against `baseDir`. */
export function validateConfig(
  input: unknown,
  baseDir = process.cwd(),
  source?: string,
): PiBotConfig {
  const result = configSchema.safeParse(input);
  if (!result.success) {
    throw new ConfigError(
      `invalid config${source ? ` ${source}` : ""}:\n${z.prettifyError(result.error)}`,
    );
  }
  const raw = result.data;
  let modelProfiles: ProfileSet;
  try {
    modelProfiles = normalizeProfiles(raw);
  } catch (error) {
    throw new ConfigError(
      `invalid config${source ? ` ${source}` : ""}: ${(error as Error).message}`,
    );
  }
  const dataDir = expandPath(raw.storage.data_dir, baseDir);
  return {
    ...raw,
    ...(source ? { source } : {}),
    paths: {
      dataDir,
      database: resolve(dataDir, "pi-bot.sqlite"),
      keyFile: raw.credentials.key_file
        ? expandPath(raw.credentials.key_file, baseDir)
        : resolve(dataDir, "credentials.key"),
      ...(raw.server.web_dir ? { webDir: expandPath(raw.server.web_dir, baseDir) } : {}),
    },
    roles: { titles: parseModelRef(raw.models.titles.model) },
    modelProfiles,
  };
}

export function parseConfig(text: string, baseDir = process.cwd(), source?: string): PiBotConfig {
  let doc: unknown;
  try {
    doc = parseToml(text);
  } catch (error) {
    throw new ConfigError(
      `invalid TOML${source ? ` in ${source}` : ""}: ${(error as Error).message}`,
    );
  }
  return validateConfig(doc, baseDir, source);
}

export function defaultConfigPath(): string {
  return process.env.PI_BOT_CONFIG ?? resolve(homedir(), ".config/pi-bot/config.toml");
}

export async function loadConfig(path = defaultConfigPath()): Promise<PiBotConfig> {
  const absolute = resolve(path);
  let text: string;
  try {
    text = await readFile(absolute, "utf8");
  } catch (error) {
    throw new ConfigError(`cannot read config ${absolute}: ${(error as Error).message}`);
  }
  return parseConfig(text, dirname(absolute), absolute);
}
