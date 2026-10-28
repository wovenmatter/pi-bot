import type { CredentialStore } from "@earendil-works/pi-ai";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import type { PiBotConfig } from "../config.ts";
import { EncryptedSqliteCredentialStore } from "./encrypted-sqlite.ts";
import { KeychainCredentialStore } from "./keychain.ts";

export { EncryptedSqliteCredentialStore } from "./encrypted-sqlite.ts";
export { loadOrCreateKeyFile } from "./key-file.ts";
export { KeychainCredentialStore, KeychainUnavailableError } from "./keychain.ts";

export type OpenedCredentialStore = {
  readonly store: CredentialStore;
  readonly backend: "encrypted-sqlite" | "keychain";
  readonly note?: string;
};

/**
 * The one credential store all bots share. `auto` means the Keychain on macOS and encrypted
 * SQLite elsewhere; while the Keychain store is a stub, macOS falls back to encrypted SQLite.
 */
export async function openCredentialStore(
  config: Pick<PiBotConfig, "credentials" | "paths">,
  db: SqliteDatabase,
  platform: NodeJS.Platform = process.platform,
): Promise<OpenedCredentialStore> {
  const wanted =
    config.credentials.backend === "auto"
      ? platform === "darwin"
        ? "keychain"
        : "encrypted-sqlite"
      : config.credentials.backend;
  if (wanted === "keychain") {
    if (KeychainCredentialStore.implemented) {
      return { store: new KeychainCredentialStore(), backend: "keychain" };
    }
    if (config.credentials.backend === "keychain") {
      throw new Error('credentials.backend = "keychain" is not implemented yet; use "auto"');
    }
    return {
      store: await EncryptedSqliteCredentialStore.open(db, config.paths.keyFile),
      backend: "encrypted-sqlite",
      note: "macOS Keychain store is a stub; using encrypted SQLite",
    };
  }
  return {
    store: await EncryptedSqliteCredentialStore.open(db, config.paths.keyFile),
    backend: "encrypted-sqlite",
  };
}
