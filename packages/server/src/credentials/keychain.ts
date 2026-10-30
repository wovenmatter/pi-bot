import { spawn } from "node:child_process";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

export class KeychainUnavailableError extends Error {
  override name = "KeychainUnavailableError";
}

export type SecurityResult = { code: number; stdout: string; stderr: string };

/** Runs `/usr/bin/security` with `args`, writing `input` to its stdin. Injectable for tests. */
export type SecurityRunner = (args: readonly string[], input?: string) => Promise<SecurityResult>;

export const runSecurityCli: SecurityRunner = (args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });

/** `security` exits with errSecItemNotFound (44) for a missing item. */
const NOT_FOUND = 44;
/** Holds the stored provider ids and types (no secrets). Not a valid provider id, so no clash. */
const INDEX_ACCOUNT = "_index";
/**
 * `security -i` reads one command per line; stay well under its line buffer. Longer values
 * (large OAuth tokens) go on argv instead, where other local processes could briefly see them.
 */
const MAX_STDIN_LINE = 4000;

function validProviderId(providerId: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(providerId)) {
    throw new Error(`invalid provider id ${JSON.stringify(providerId)}`);
  }
  return providerId;
}

/** JSON with every non-ASCII character escaped, so `find-generic-password -w` prints it as is. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.slice(0, 200) ?? "";
}

/**
 * macOS Keychain credential store over the `security` CLI (no native modules). Each credential is
 * a generic password: service `io.wovenmatter.pi-bot`, account = provider id, value = the
 * credential JSON. The item `_index` lists the stored provider ids and types so `list` needs no
 * secrets. Items are per macOS user, so two Pi Bot instances under one user share them.
 *
 * Secrets never go on argv when they fit one `security -i` line: the write is sent on stdin
 * as hex (`-X`), then read back to confirm, because `security -i` may exit 0 when a command
 * fails. Writes are serialized per provider id within this process, like the SQLite store.
 *
 * Untested on a real Mac: the unit tests drive a fake `security` runner.
 */
export class KeychainCredentialStore implements CredentialStore {
  static readonly service = "io.wovenmatter.pi-bot";

  readonly #run: SecurityRunner;
  readonly #service: string;
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(options: { run?: SecurityRunner; service?: string } = {}) {
    this.#run = options.run ?? runSecurityCli;
    this.#service = options.service ?? KeychainCredentialStore.service;
  }

  /** True when `security` runs and a default keychain exists. */
  static async available(run: SecurityRunner = runSecurityCli): Promise<boolean> {
    try {
      return (await run(["default-keychain"])).code === 0;
    } catch {
      return false;
    }
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const id = validProviderId(providerId);
    const raw = await this.#get(id);
    if (raw === undefined) return undefined;
    try {
      const credential = JSON.parse(raw) as Credential;
      if (credential.type === "api_key" || credential.type === "oauth") return credential;
    } catch {}
    // Never echo the item's content.
    throw new Error(`keychain item for ${id} is not a valid credential`);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return [...(await this.#readIndex())].sort((a, b) =>
      a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0,
    );
  }

  /** Whether this store has ever been written (its index item exists). */
  async hasIndex(): Promise<boolean> {
    return (await this.#get(INDEX_ACCOUNT)) !== undefined;
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const id = validProviderId(providerId);
    return this.#serialized(id, async () => {
      const current = await this.read(id);
      const next = await fn(current);
      if (next === undefined) return current;
      if (next.type !== "api_key" && next.type !== "oauth") {
        throw new Error("unsupported credential type");
      }
      await this.#set(id, asciiJson(next));
      await this.#updateIndex((index) => [
        ...index.filter((item) => item.providerId !== id),
        { providerId: id, type: next.type },
      ]);
      return next;
    });
  }

  delete(providerId: string): Promise<void> {
    const id = validProviderId(providerId);
    return this.#serialized(id, async () => {
      const result = await this.#run(["delete-generic-password", ...this.#item(id)]);
      if (result.code !== 0 && result.code !== NOT_FOUND) {
        throw new Error(`keychain delete for ${id} failed: ${firstLine(result.stderr)}`);
      }
      await this.#updateIndex((index) => index.filter((item) => item.providerId !== id));
    });
  }

  #item(account: string): string[] {
    return ["-s", this.#service, "-a", account];
  }

  async #get(account: string): Promise<string | undefined> {
    const result = await this.#run(["find-generic-password", ...this.#item(account), "-w"]);
    if (result.code === NOT_FOUND) return undefined;
    if (result.code !== 0) {
      throw new Error(`keychain read for ${account} failed: ${firstLine(result.stderr)}`);
    }
    return result.stdout.replace(/\r?\n$/, "");
  }

  async #set(account: string, value: string): Promise<void> {
    const args = ["add-generic-password", "-U", ...this.#item(account), "-X"];
    const hex = Buffer.from(value, "utf8").toString("hex");
    const line = `${[...args, hex].join(" ")}\n`;
    const result =
      line.length <= MAX_STDIN_LINE
        ? await this.#run(["-i"], line)
        : await this.#run([...args, hex]);
    // stderr may echo the command, so it never goes into the message.
    if (result.code !== 0 || (await this.#get(account)) !== value) {
      throw new Error(`keychain write for ${account} failed (security exit ${result.code})`);
    }
  }

  async #readIndex(): Promise<CredentialInfo[]> {
    const raw = await this.#get(INDEX_ACCOUNT);
    if (raw === undefined) return [];
    try {
      const items = JSON.parse(raw) as CredentialInfo[];
      if (Array.isArray(items)) {
        return items.filter(
          (item) =>
            typeof item?.providerId === "string" &&
            (item.type === "api_key" || item.type === "oauth"),
        );
      }
    } catch {}
    throw new Error("keychain credential index is corrupt");
  }

  #updateIndex(change: (index: CredentialInfo[]) => CredentialInfo[]): Promise<void> {
    return this.#serialized(INDEX_ACCOUNT, async () => {
      const next = change(await this.#readIndex());
      await this.#set(INDEX_ACCOUNT, asciiJson(next));
    });
  }

  #serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.catch(() => {});
    this.#locks.set(key, settled);
    void settled.then(() => {
      if (this.#locks.get(key) === settled) this.#locks.delete(key);
    });
    return run;
  }
}
