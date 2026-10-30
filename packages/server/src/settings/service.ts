import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AuthPrompt, CredentialStore, Models } from "@earendil-works/pi-ai";
import { ConfigError, type PiBotConfig, parseConfig, parseModelRef } from "../config.ts";
import { TITLE_REASONING } from "../titles.ts";
import { ACCOUNTS, type AccountSpec, findAccount, SEARCH_PROVIDERS } from "./catalog.ts";
import {
  generateEd25519Key,
  parseOpenSshPrivateKey,
  SshKeyError,
  type SshPublicKey,
} from "./ssh-key.ts";
import { setTomlValues, type TomlEdit } from "./toml-edit.ts";

/** Credential-store slot for the GitHub SSH private key (stored as an api_key credential). */
export const GITHUB_SSH_SLOT = "github-ssh";

export type GitHubStatus = {
  sshKey?: SshPublicKey;
  identity: { name?: string; email?: string };
};

export type AccountStatus = Omit<AccountSpec, "prefix"> & {
  readonly configured: boolean;
  /** Masked summary: never more than the last four characters of a key. */
  readonly detail?: string;
  /** True when the credential comes from the environment rather than the store. */
  readonly ambient?: boolean;
};

export type LoginPromptView =
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
  | {
      type: "select";
      message: string;
      options: { id: string; label: string; description?: string }[];
    };

/** Pushed to the connection that started a login. */
export type LoginEvent =
  | { kind: "auth_url"; url: string; instructions?: string }
  | {
      kind: "device_code";
      userCode: string;
      verificationUri: string;
      expiresInSeconds?: number;
    }
  | { kind: "prompt"; promptId: string; prompt: LoginPromptView }
  | { kind: "prompt_closed"; promptId: string }
  | { kind: "info" | "progress"; message: string; links?: { url: string; label?: string }[] }
  | { kind: "done" }
  | { kind: "error"; message: string };

export type ModelOption = {
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly contextWindow: number;
};
export type ProviderModels = { readonly id: string; readonly name: string; models: ModelOption[] };

/** The global model settings (the title model) Settings → Profiles → Thread titles edits; bots' models are in profiles. */
export type Roles = {
  titles: string;
  titlesReasoning: string;
};

export class SettingsError extends Error {}

const MAX_KEY_LENGTH = 8192;

function maskKey(key: string | undefined): string {
  if (!key) return "Key set";
  return key.length >= 12 ? `Key ••••${key.slice(-4)}` : "Key set";
}

function expiryText(expires: number): string {
  if (!Number.isFinite(expires) || expires <= 0) return "Signed in";
  const date = new Date(expires).toISOString().replace("T", " ").slice(0, 16);
  return expires < Date.now()
    ? `Signed in · token expired ${date} UTC (refreshes on use)`
    : `Signed in · token valid until ${date} UTC`;
}

function promptView(prompt: AuthPrompt): LoginPromptView {
  if (prompt.type === "select") {
    return {
      type: "select",
      message: prompt.message,
      options: prompt.options.map((option) => ({
        id: option.id,
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      })),
    };
  }
  return {
    type: prompt.type,
    message: prompt.message,
    ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
  };
}

type PendingPrompt = {
  readonly resolve: (value: string) => void;
  readonly reject: (error: Error) => void;
  readonly options?: readonly string[];
};

class LoginSession {
  readonly id = randomUUID();
  readonly abort = new AbortController();
  readonly prompts = new Map<string, PendingPrompt>();
  done = false;

  readonly accountId: string;
  readonly owner: object;
  readonly emit: (event: LoginEvent) => void;
  /** Answer for the provider's method picker, chosen up front (see `AccountSpec.loginMethods`). */
  method: string | undefined;

  constructor(
    accountId: string,
    owner: object,
    emit: (event: LoginEvent) => void,
    method: string | undefined,
  ) {
    this.accountId = accountId;
    this.owner = owner;
    this.emit = emit;
    this.method = method;
  }

  prompt(prompt: AuthPrompt): Promise<string> {
    const method = this.method;
    if (
      method &&
      prompt.type === "select" &&
      prompt.options.some((option) => option.id === method)
    ) {
      this.method = undefined;
      return Promise.resolve(method);
    }
    const promptId = randomUUID();
    return new Promise<string>((resolve, reject) => {
      const close = () => {
        if (!this.prompts.delete(promptId)) return;
        if (!this.done) this.emit({ kind: "prompt_closed", promptId });
      };
      const cancelled = () => {
        close();
        reject(new Error("prompt cancelled"));
      };
      if (prompt.signal?.aborted || this.abort.signal.aborted) {
        reject(new Error("prompt cancelled"));
        return;
      }
      prompt.signal?.addEventListener("abort", cancelled, { once: true });
      this.abort.signal.addEventListener("abort", cancelled, { once: true });
      this.prompts.set(promptId, {
        resolve: (value) => {
          prompt.signal?.removeEventListener("abort", cancelled);
          this.abort.signal.removeEventListener("abort", cancelled);
          close();
          resolve(value);
        },
        reject,
        ...(prompt.type === "select" ? { options: prompt.options.map((option) => option.id) } : {}),
      });
      this.emit({ kind: "prompt", promptId, prompt: promptView(prompt) });
    });
  }
}

export type SettingsOptions = {
  readonly credentials: CredentialStore;
  /** Real provider catalog (sign-in flows and the model list). */
  readonly models: Models;
  /** The config the server is running with; `source` is the file Settings edits. */
  readonly config: PiBotConfig;
  /** The SSH key or git identity changed (bot containers rewrite theirs). */
  readonly onGitChanged?: () => void;
};

/**
 * Backs Settings: credential status and writes, provider sign-in sessions, the model catalog,
 * and validated config.toml edits. Secrets are write-only from the UI's point of view.
 * Config edits apply on the next restart.
 */
export class SettingsService {
  readonly #credentials: CredentialStore;
  readonly #models: Models;
  readonly #config: PiBotConfig;
  readonly #logins = new Map<string, LoginSession>();
  #configChanged = false;

  readonly #onGitChanged: (() => void) | undefined;

  constructor(options: SettingsOptions) {
    this.#onGitChanged = options.onGitChanged;
    this.#credentials = options.credentials;
    this.#models = options.models;
    this.#config = options.config;
  }

  get configPath(): string | undefined {
    return this.#config.source;
  }

  /** True once config.toml was written by this process: the running server is stale. */
  get restartRequired(): boolean {
    return this.#configChanged;
  }

  async accounts(): Promise<{
    accounts: AccountStatus[];
    search: { provider: string; providers: AccountStatus[] };
  }> {
    const stored = new Map(
      (await this.#credentials.list()).map((info) => [info.providerId, info.type]),
    );
    const status = async (spec: AccountSpec): Promise<AccountStatus> => {
      const { prefix: _prefix, ...base } = spec;
      const wantType = spec.method === "oauth" ? "oauth" : "api_key";
      const type = stored.get(spec.provider);
      if (type === wantType) {
        const credential = await this.#credentials.read(spec.provider);
        const detail =
          credential?.type === "oauth"
            ? expiryText(credential.expires)
            : maskKey(credential?.type === "api_key" ? credential.key : undefined);
        return { ...base, configured: true, detail };
      }
      if (type === undefined && this.#models.getProvider(spec.provider)) {
        try {
          const check = await this.#models.checkAuth(spec.provider);
          if (check && check.type === wantType) {
            return {
              ...base,
              configured: true,
              ambient: true,
              detail: `From ${check.source ?? "the environment"}`,
            };
          }
        } catch {
          // Unconfigured or broken ambient auth reads as "not set".
        }
      }
      return { ...base, configured: false };
    };
    return {
      accounts: await Promise.all(ACCOUNTS.map(status)),
      search: {
        provider: this.#config.search.provider,
        providers: await Promise.all(SEARCH_PROVIDERS.map(status)),
      },
    };
  }

  /** True once any model provider account (not a search key) is configured. */
  async signedIn(): Promise<boolean> {
    return (await this.accounts()).accounts.some((account) => account.configured);
  }

  /** Whether `ref` is a model of a provider with working auth (signed in or keyed). */
  async modelAvailable(ref: string): Promise<boolean> {
    let parsed: ReturnType<typeof parseModelRef>;
    try {
      parsed = parseModelRef(ref);
    } catch {
      return false;
    }
    return (await this.#models.getAvailable()).some(
      (model) => model.provider === parsed.provider && model.id === parsed.modelId,
    );
  }

  /** Throws unless `ref` (`provider/modelId`) is a known model. */
  checkModel(ref: string): void {
    let parsed: ReturnType<typeof parseModelRef>;
    try {
      parsed = parseModelRef(ref);
    } catch {
      throw new SettingsError(`invalid model "${ref}": expected provider/modelId`);
    }
    if (!this.#models.getModel(parsed.provider, parsed.modelId)) {
      throw new SettingsError(`unknown model "${ref}"`);
    }
  }

  async setKey(accountId: string, rawKey: string): Promise<void> {
    const spec = findAccount(accountId);
    if (!spec || spec.method === "oauth") throw new SettingsError(`no key slot "${accountId}"`);
    const key = rawKey.trim();
    if (!key || /\s/.test(key) || key.length > MAX_KEY_LENGTH) {
      throw new SettingsError("keys are a single token without spaces");
    }
    if (spec.prefix && !key.startsWith(spec.prefix)) {
      throw new SettingsError(`expected a token starting with ${spec.prefix}`);
    }
    await this.#credentials.modify(spec.provider, async () => ({ type: "api_key", key }));
  }

  async remove(accountId: string): Promise<void> {
    const spec = findAccount(accountId);
    if (!spec) throw new SettingsError(`unknown account "${accountId}"`);
    const current = await this.#credentials.read(spec.provider);
    const wantType = spec.method === "oauth" ? "oauth" : "api_key";
    // xAI's sign-in and key share a slot: only remove what this entry owns.
    if (current && current.type === wantType) await this.#credentials.delete(spec.provider);
  }

  /**
   * Start a provider sign-in. Events (URL, device code, prompts) go to `emit`. `method` picks one
   * of the entry's `loginMethods` (default: the first), so no picker is shown.
   */
  startLogin(
    accountId: string,
    owner: object,
    emit: (loginId: string, event: LoginEvent) => void,
    method?: string,
  ): string {
    const spec = findAccount(accountId);
    if (spec?.method !== "oauth") throw new SettingsError(`no sign-in for "${accountId}"`);
    const methods = spec.loginMethods ?? [];
    if (method !== undefined && !methods.some((entry) => entry.id === method)) {
      throw new SettingsError(`unknown sign-in method "${method}"`);
    }
    if (!this.#models.getProvider(spec.provider)) {
      throw new SettingsError(`provider "${spec.provider}" is not available`);
    }
    for (const session of this.#logins.values()) {
      if (session.accountId === accountId)
        this.#finish(session, { kind: "error", message: "Replaced by a new sign-in" });
    }
    const session = new LoginSession(
      accountId,
      owner,
      (event) => emit(session.id, event),
      method ?? methods[0]?.id,
    );
    this.#logins.set(session.id, session);
    void this.#models
      .login(
        spec.provider,
        "oauth",
        {
          signal: session.abort.signal,
          prompt: (prompt) => session.prompt(prompt),
          notify: (event) => {
            if (session.done) return;
            if (event.type === "auth_url") {
              session.emit({
                kind: "auth_url",
                url: event.url,
                ...(event.instructions ? { instructions: event.instructions } : {}),
              });
            } else if (event.type === "device_code") {
              session.emit({
                kind: "device_code",
                userCode: event.userCode,
                verificationUri: event.verificationUri,
                ...(event.expiresInSeconds ? { expiresInSeconds: event.expiresInSeconds } : {}),
              });
            } else {
              session.emit({
                kind: event.type,
                message: event.message,
                ...(event.type === "info" && event.links ? { links: [...event.links] } : {}),
              });
            }
          },
        },
        { agentName: "pi-bot" },
      )
      .then(
        () => this.#finish(session, { kind: "done" }),
        (error: unknown) =>
          this.#finish(session, {
            kind: "error",
            message: session.abort.signal.aborted
              ? "Sign-in cancelled"
              : error instanceof Error
                ? error.message
                : String(error),
          }),
      );
    return session.id;
  }

  respondLogin(loginId: string, owner: object, promptId: string, value: string): void {
    const session = this.#session(loginId, owner);
    const pending = session.prompts.get(promptId);
    if (!pending) throw new SettingsError("that prompt is no longer open");
    if (pending.options && !pending.options.includes(value)) {
      throw new SettingsError("choose one of the listed options");
    }
    pending.resolve(value.trim());
  }

  cancelLogin(loginId: string, owner: object): void {
    this.#finish(this.#session(loginId, owner), { kind: "error", message: "Sign-in cancelled" });
  }

  /** Cancel every login a disconnected client started. */
  dropOwner(owner: object): void {
    for (const session of [...this.#logins.values()]) {
      if (session.owner === owner) this.#finish(session, undefined);
    }
  }

  #session(loginId: string, owner: object): LoginSession {
    const session = this.#logins.get(loginId);
    if (!session || session.owner !== owner) throw new SettingsError("unknown sign-in");
    return session;
  }

  #finish(session: LoginSession, event: LoginEvent | undefined): void {
    if (session.done) return;
    session.done = true;
    this.#logins.delete(session.id);
    session.abort.abort();
    for (const pending of session.prompts.values()) pending.reject(new Error("sign-in ended"));
    session.prompts.clear();
    if (event) session.emit(event);
  }

  /** Models for providers with working auth, and the configured roles. */
  async modelCatalog(): Promise<{
    providers: ProviderModels[];
    roles: Roles;
    reasoningLevels: readonly string[];
  }> {
    const available = await this.#models.getAvailable();
    const byProvider = new Map<string, ProviderModels>();
    for (const model of available) {
      let entry = byProvider.get(model.provider);
      if (!entry) {
        entry = {
          id: model.provider,
          name: this.#models.getProvider(model.provider)?.name ?? model.provider,
          models: [],
        };
        byProvider.set(model.provider, entry);
      }
      entry.models.push({
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        contextWindow: model.contextWindow,
      });
    }
    return {
      providers: [...byProvider.values()],
      roles: await this.#currentRoles(),
      reasoningLevels: TITLE_REASONING,
    };
  }

  async #currentRoles(): Promise<Roles> {
    // Prefer the file (it may have been edited since startup), fall back to the running config.
    let config = this.#config;
    if (config.source) {
      try {
        config = parseConfig(
          await readFile(config.source, "utf8"),
          dirname(config.source),
          config.source,
        );
      } catch {
        config = this.#config;
      }
    }
    return {
      titles: config.models.titles.model,
      titlesReasoning: config.models.titles.reasoning,
    };
  }

  async setRoles(roles: Partial<Roles>): Promise<Roles> {
    const edits: TomlEdit[] = [];
    const ref = (name: string, value: string | undefined, path: string[]) => {
      if (value === undefined) return;
      const parsed = parseModelRef(value);
      if (!this.#models.getModel(parsed.provider, parsed.modelId)) {
        throw new SettingsError(`${name}: unknown model "${value}"`);
      }
      edits.push({ path, value });
    };
    ref("titles", roles.titles, ["models", "titles", "model"]);
    if (roles.titlesReasoning !== undefined) {
      edits.push({ path: ["models", "titles", "reasoning"], value: roles.titlesReasoning });
    }
    await this.updateConfig(edits);
    return this.#currentRoles();
  }

  async readConfig(): Promise<{
    path?: string;
    text: string;
    exists: boolean;
    restartRequired: boolean;
    /** Values the structured forms edit: from the file when it parses, else the running config. */
    effective: Pick<PiBotConfig, "bot_to_bot" | "extraction" | "search" | "git">;
  }> {
    const path = this.#config.source;
    const restartRequired = this.#configChanged;
    const effective = (config: PiBotConfig) => ({
      bot_to_bot: config.bot_to_bot,
      extraction: config.extraction,
      search: config.search,
      git: config.git,
    });
    if (!path)
      return { text: "", exists: false, restartRequired, effective: effective(this.#config) };
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { path, text: "", exists: false, restartRequired, effective: effective(this.#config) };
    }
    let parsed = this.#config;
    try {
      parsed = parseConfig(text, dirname(path), path);
    } catch {
      parsed = this.#config;
    }
    return { path, text, exists: true, restartRequired, effective: effective(parsed) };
  }

  /** Validate config text with the same parser the server starts with. */
  validateConfig(text: string): { ok: true } | { ok: false; error: string } {
    const path = this.#config.source;
    try {
      parseConfig(text, path ? dirname(path) : process.cwd(), path);
      return { ok: true };
    } catch (error) {
      if (error instanceof ConfigError) return { ok: false, error: error.message };
      throw error;
    }
  }

  async saveConfig(text: string): Promise<void> {
    const path = this.#config.source;
    if (!path) throw new SettingsError("Pi Bot was started without a config file; nothing to edit");
    const result = this.validateConfig(text);
    if (!result.ok) throw new SettingsError(result.error);
    let mode = 0o600;
    try {
      mode = (await stat(path)).mode & 0o777;
    } catch {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    }
    const temp = join(dirname(path), `.config.toml.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temp, text, { mode });
    await chmod(temp, mode);
    await rename(temp, path);
    this.#configChanged = true;
  }

  /** Apply scalar edits to config.toml (comments kept where possible), validate, save. */
  /** GitHub SSH key (public half only) and git identity. */
  async github(): Promise<GitHubStatus> {
    const { effective } = await this.readConfig();
    const identity = {
      ...(effective.git.user_name ? { name: effective.git.user_name } : {}),
      ...(effective.git.user_email ? { email: effective.git.user_email } : {}),
    };
    const stored = await this.#credentials.read(GITHUB_SSH_SLOT);
    if (stored?.type !== "api_key" || !stored.key) return { identity };
    try {
      return { sshKey: parseOpenSshPrivateKey(stored.key).info, identity };
    } catch {
      return { identity };
    }
  }

  async setSshKey(privateKey: string): Promise<SshPublicKey> {
    let parsed: ReturnType<typeof parseOpenSshPrivateKey>;
    try {
      parsed = parseOpenSshPrivateKey(privateKey);
    } catch (error) {
      if (error instanceof SshKeyError) throw new SettingsError(error.message);
      throw error;
    }
    await this.#credentials.modify(GITHUB_SSH_SLOT, async () => ({
      type: "api_key",
      key: parsed.pem,
    }));
    this.#onGitChanged?.();
    return parsed.info;
  }

  /** Generate a key here so the private half never crosses the network. */
  async generateSshKey(comment: string): Promise<SshPublicKey> {
    const generated = generateEd25519Key(comment);
    await this.#credentials.modify(GITHUB_SSH_SLOT, async () => ({
      type: "api_key",
      key: generated.pem,
    }));
    this.#onGitChanged?.();
    return generated.info;
  }

  async removeSshKey(): Promise<void> {
    await this.#credentials.delete(GITHUB_SSH_SLOT);
    this.#onGitChanged?.();
  }

  /**
   * Server-internal: the SSH private key and identity written into bot containers. Never sent to
   * the UI (`github()` returns only the public half).
   */
  async gitMaterial(): Promise<{
    privateKey?: string;
    publicKey?: string;
    name?: string;
    email?: string;
  }> {
    const { effective } = await this.readConfig();
    const stored = await this.#credentials.read(GITHUB_SSH_SLOT);
    let key: { privateKey: string; publicKey: string } | undefined;
    if (stored?.type === "api_key" && stored.key) {
      try {
        key = {
          privateKey: stored.key,
          publicKey: parseOpenSshPrivateKey(stored.key).info.publicKey,
        };
      } catch {
        key = undefined;
      }
    }
    return {
      ...(key ?? {}),
      ...(effective.git.user_name ? { name: effective.git.user_name } : {}),
      ...(effective.git.user_email ? { email: effective.git.user_email } : {}),
    };
  }

  async setGitIdentity(identity: { name: string; email: string }): Promise<void> {
    await this.updateConfig([
      { path: ["git", "user_name"], value: identity.name.trim() },
      { path: ["git", "user_email"], value: identity.email.trim() },
    ]);
    this.#onGitChanged?.();
  }

  async updateConfig(edits: readonly TomlEdit[]): Promise<void> {
    if (edits.length === 0) return;
    const { text } = await this.readConfig();
    let next: string;
    try {
      next = setTomlValues(text, edits);
    } catch (error) {
      throw new SettingsError(`config.toml: ${(error as Error).message}`);
    }
    await this.saveConfig(next);
  }
}
