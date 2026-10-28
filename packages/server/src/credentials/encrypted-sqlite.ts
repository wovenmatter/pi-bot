import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { KEY_BYTES, loadOrCreateKeyFile } from "./key-file.ts";

export const CREDENTIALS_TABLE = "pibot_credentials";
const ALGORITHM = "aes-256-gcm";
const VERSION = 1;

type Row = {
  provider_id: string;
  type: string;
  version: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  tag: Uint8Array;
};

const aad = (providerId: string) => Buffer.from(`pibot-credential:v${VERSION}:${providerId}`);

function validProviderId(providerId: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(providerId)) {
    throw new Error(`invalid provider id ${JSON.stringify(providerId)}`);
  }
  return providerId;
}

/**
 * pi-ai `CredentialStore` over the shared SQLite database. Each credential is a JSON document
 * sealed with AES-256-GCM (random 96-bit nonce, provider id bound as AAD); the key lives in a
 * separate 0600 key file, never in the database. Holds OAuth logins and API keys alike,
 * including non-model services such as Exa.
 *
 * Writes are serialized per provider id within this process (Pi Bot is one process).
 */
export class EncryptedSqliteCredentialStore implements CredentialStore {
  readonly #db: SqliteDatabase;
  readonly #key: Buffer;
  readonly #locks = new Map<string, Promise<unknown>>();

  private constructor(db: SqliteDatabase, key: Buffer) {
    this.#db = db;
    this.#key = key;
  }

  static async open(db: SqliteDatabase, keyFile: string): Promise<EncryptedSqliteCredentialStore> {
    return EncryptedSqliteCredentialStore.withKey(db, await loadOrCreateKeyFile(keyFile));
  }

  /** For tests and key rotation tooling. */
  static async withKey(db: SqliteDatabase, key: Buffer): Promise<EncryptedSqliteCredentialStore> {
    if (key.length !== KEY_BYTES) throw new Error(`credential key must be ${KEY_BYTES} bytes`);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS ${CREDENTIALS_TABLE} (
        provider_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        version INTEGER NOT NULL,
        nonce BLOB NOT NULL,
        ciphertext BLOB NOT NULL,
        tag BLOB NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
    return new EncryptedSqliteCredentialStore(db, key);
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const row = await this.#db.get<Row>(
      `SELECT provider_id, type, version, nonce, ciphertext, tag FROM ${CREDENTIALS_TABLE} WHERE provider_id = ?`,
      validProviderId(providerId),
    );
    return row ? this.#open(row) : undefined;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const rows = await this.#db.all<{ provider_id: string; type: string }>(
      `SELECT provider_id, type FROM ${CREDENTIALS_TABLE} ORDER BY provider_id`,
    );
    return rows.map((row) => ({
      providerId: row.provider_id,
      type: row.type === "oauth" ? "oauth" : "api_key",
    }));
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
      await this.#write(id, next);
      return next;
    });
  }

  delete(providerId: string): Promise<void> {
    const id = validProviderId(providerId);
    return this.#serialized(id, async () => {
      await this.#db.run(`DELETE FROM ${CREDENTIALS_TABLE} WHERE provider_id = ?`, id);
    });
  }

  async #write(providerId: string, credential: Credential): Promise<void> {
    if (credential.type !== "api_key" && credential.type !== "oauth") {
      throw new Error("unsupported credential type");
    }
    const nonce = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.#key, nonce);
    cipher.setAAD(aad(providerId));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(credential), "utf8"),
      cipher.final(),
    ]);
    await this.#db.run(
      `INSERT INTO ${CREDENTIALS_TABLE} (provider_id, type, version, nonce, ciphertext, tag, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (provider_id) DO UPDATE SET type = excluded.type, version = excluded.version,
         nonce = excluded.nonce, ciphertext = excluded.ciphertext, tag = excluded.tag,
         updated_at = excluded.updated_at`,
      providerId,
      credential.type,
      VERSION,
      nonce,
      ciphertext,
      cipher.getAuthTag(),
      new Date().toISOString(),
    );
  }

  #open(row: Row): Credential {
    if (row.version !== VERSION) throw new Error(`unsupported credential version ${row.version}`);
    try {
      const decipher = createDecipheriv(ALGORITHM, this.#key, Buffer.from(row.nonce));
      decipher.setAAD(aad(row.provider_id));
      decipher.setAuthTag(Buffer.from(row.tag));
      const plain = Buffer.concat([decipher.update(Buffer.from(row.ciphertext)), decipher.final()]);
      return JSON.parse(plain.toString("utf8")) as Credential;
    } catch {
      // Never echo ciphertext or key material.
      throw new Error(`cannot decrypt credential for ${row.provider_id} (wrong key file?)`);
    }
  }

  #serialized<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(providerId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.catch(() => {});
    this.#locks.set(providerId, settled);
    void settled.then(() => {
      if (this.#locks.get(providerId) === settled) this.#locks.delete(providerId);
    });
    return run;
  }
}
