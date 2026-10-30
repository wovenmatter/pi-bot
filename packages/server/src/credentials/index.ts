import type { CredentialStore } from "@earendil-works/pi-ai";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import type { PiBotConfig } from "../config.ts";
import { CREDENTIALS_TABLE, EncryptedSqliteCredentialStore } from "./encrypted-sqlite.ts";
import {
  KeychainCredentialStore,
  KeychainUnavailableError,
  runSecurityCli,
  type SecurityRunner,
} from "./keychain.ts";

export { EncryptedSqliteCredentialStore } from "./encrypted-sqlite.ts";
export { loadOrCreateKeyFile } from "./key-file.ts";
export {
  KeychainCredentialStore,
  KeychainUnavailableError,
  type SecurityResult,
  type SecurityRunner,
} from "./keychain.ts";

export type OpenedCredentialStore = {
  readonly store: CredentialStore;
  readonly backend: "encrypted-sqlite" | "keychain";
  readonly note?: string;
};

/**
 * The one credential store all bots share. `auto` means the Keychain on macOS when the
 * `security` tool works (else encrypted SQLite) and encrypted SQLite elsewhere.
 */
export async function openCredentialStore(
  config: Pick<PiBotConfig, "credentials" | "paths">,
  db: SqliteDatabase,
  platform: NodeJS.Platform = process.platform,
  runSecurity: SecurityRunner = runSecurityCli,
): Promise<OpenedCredentialStore> {
  const backend = config.credentials.backend;
  const sqlite = async (note?: string): Promise<OpenedCredentialStore> => ({
    store: await EncryptedSqliteCredentialStore.open(db, config.paths.keyFile),
    backend: "encrypted-sqlite",
    ...(note ? { note } : {}),
  });
  if (backend === "encrypted-sqlite" || (backend === "auto" && platform !== "darwin")) {
    return sqlite();
  }
  if (platform !== "darwin") {
    throw new KeychainUnavailableError(
      'credentials.backend = "keychain" needs macOS; use "auto" or "encrypted-sqlite"',
    );
  }
  if (!(await KeychainCredentialStore.available(runSecurity))) {
    if (backend === "keychain") {
      throw new KeychainUnavailableError(
        'credentials.backend = "keychain": the macOS `security` tool or default keychain is unavailable',
      );
    }
    return sqlite("macOS Keychain unavailable; using encrypted SQLite");
  }
  const store = new KeychainCredentialStore({ run: runSecurity });
  const note = await importFromSqlite(store, db, config.paths.keyFile);
  return { store, backend: "keychain", ...(note ? { note } : {}) };
}

/**
 * One-time copy for Macs that used encrypted SQLite before the Keychain store existed: only
 * while the Keychain store has never been written. The SQLite rows are left in place.
 */
async function importFromSqlite(
  keychain: KeychainCredentialStore,
  db: SqliteDatabase,
  keyFile: string,
): Promise<string | undefined> {
  if (await keychain.hasIndex()) return undefined;
  const table = await db.get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    CREDENTIALS_TABLE,
  );
  if (!table || !(await db.get(`SELECT 1 AS found FROM ${CREDENTIALS_TABLE} LIMIT 1`))) {
    return undefined;
  }
  try {
    const source = await EncryptedSqliteCredentialStore.open(db, keyFile);
    const items = await source.list();
    for (const { providerId } of items) {
      const credential = await source.read(providerId);
      if (credential) await keychain.modify(providerId, async () => credential);
    }
    return `copied ${items.length} credential(s) from encrypted SQLite into the macOS Keychain`;
  } catch (error) {
    return `could not copy encrypted SQLite credentials into the macOS Keychain: ${(error as Error).message}`;
  }
}
