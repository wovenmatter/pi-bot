import { randomBytes } from "node:crypto";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import {
  EncryptedSqliteCredentialStore,
  KeychainCredentialStore,
  loadOrCreateKeyFile,
  openCredentialStore,
} from "../src/credentials/index.ts";
import { checkModelRoles, createPiBotModels } from "../src/models.ts";
import { openSharedDatabase } from "../src/storage/database.ts";
import { tempDir } from "./helpers.ts";

// Obviously fake; tests never use real keys.
const FAKE_KEY = "sk-test-not-a-real-key-0123456789";

describe("credentials", () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(async () => {
    await dir.cleanup();
  });

  async function openStore(name = "pi-bot.sqlite", keyName = "credentials.key") {
    const dbPath = join(dir.path, name);
    const db = await openSharedDatabase(dbPath);
    const keyFile = join(dir.path, "keys", keyName);
    const store = await EncryptedSqliteCredentialStore.open(db, keyFile);
    return { db, dbPath, keyFile, store };
  }

  it("round-trips API keys and OAuth credentials", async () => {
    const { db, store } = await openStore();
    try {
      expect(await store.read("openai")).toBeUndefined();
      await store.modify("openai", async () => ({ type: "api_key", key: FAKE_KEY }));
      const oauth = { type: "oauth" as const, refresh: "r-1", access: "a-1", expires: 123 };
      await store.modify("openai-codex", async () => oauth);
      await store.modify("exa", async () => ({ type: "api_key", key: "exa-test" }));

      expect(await store.read("openai")).toEqual({ type: "api_key", key: FAKE_KEY });
      expect(await store.read("openai-codex")).toEqual(oauth);
      expect(await store.list()).toEqual([
        { providerId: "exa", type: "api_key" },
        { providerId: "openai", type: "api_key" },
        { providerId: "openai-codex", type: "oauth" },
      ]);

      // undefined leaves the entry unchanged and returns the current value.
      expect(await store.modify("openai", async () => undefined)).toEqual({
        type: "api_key",
        key: FAKE_KEY,
      });
      await store.delete("openai");
      expect(await store.read("openai")).toBeUndefined();
    } finally {
      await db.close();
    }
  });

  it("encrypts at rest with a 0600 key file outside the database", async () => {
    const { db, dbPath, keyFile, store } = await openStore();
    try {
      await store.modify("openai", async () => ({ type: "api_key", key: FAKE_KEY }));
      expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
      expect((await readFile(keyFile)).length).toBe(32);
      await db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const raw = await readFile(dbPath);
      expect(raw.includes(Buffer.from(FAKE_KEY))).toBe(false);
      expect(raw.includes(await readFile(keyFile))).toBe(false);
    } finally {
      await db.close();
    }
  });

  it("persists across reopen and fails closed with the wrong key", async () => {
    const first = await openStore();
    await first.store.modify("openai", async () => ({ type: "api_key", key: FAKE_KEY }));
    await first.db.close();

    const second = await openStore();
    try {
      expect(await second.store.read("openai")).toEqual({ type: "api_key", key: FAKE_KEY });
      const wrong = await EncryptedSqliteCredentialStore.withKey(second.db, randomBytes(32));
      const failure = await wrong.read("openai").catch((error: Error) => error.message);
      expect(failure).toMatch(/cannot decrypt/);
      expect(String(failure)).not.toContain(FAKE_KEY);
    } finally {
      await second.db.close();
    }
  });

  it("binds ciphertext to its provider id", async () => {
    const { db, store } = await openStore();
    try {
      await store.modify("openai", async () => ({ type: "api_key", key: FAKE_KEY }));
      await db.run(
        "INSERT INTO pibot_credentials SELECT 'anthropic', type, version, nonce, ciphertext, tag, updated_at FROM pibot_credentials WHERE provider_id = 'openai'",
      );
      await expect(store.read("anthropic")).rejects.toThrow(/cannot decrypt/);
    } finally {
      await db.close();
    }
  });

  it("serializes concurrent modify calls per provider", async () => {
    const { db, store } = await openStore();
    try {
      const bump = () =>
        store.modify("counter", async (current) => {
          const n = current?.type === "api_key" ? Number(current.key) : 0;
          await new Promise((resolve) => setTimeout(resolve, 1));
          return { type: "api_key", key: String(n + 1) };
        });
      await Promise.all(Array.from({ length: 10 }, bump));
      expect(await store.read("counter")).toEqual({ type: "api_key", key: "10" });
    } finally {
      await db.close();
    }
  });

  it("refuses a key file readable by group or others", async () => {
    const keyFile = join(dir.path, "loose.key");
    await writeFile(keyFile, randomBytes(32));
    await chmod(keyFile, 0o644);
    await expect(loadOrCreateKeyFile(keyFile)).rejects.toThrow(/chmod 600/);
  });

  it("selects the backend per platform; the Keychain store is a stub", async () => {
    const config = parseConfig(
      `[models]\norchestrator = "openai/gpt-6-sol"\nbackground = "openai/gpt-6-luna"\n[storage]\ndata_dir = "${dir.path}"\n`,
    );
    const db = await openSharedDatabase(config.paths.database);
    try {
      expect((await openCredentialStore(config, db, "linux")).backend).toBe("encrypted-sqlite");
      const mac = await openCredentialStore(config, db, "darwin");
      expect(mac.backend).toBe("encrypted-sqlite");
      expect(mac.note).toMatch(/stub/);
      await expect(new KeychainCredentialStore().read("openai")).rejects.toThrow(/not implemented/);
    } finally {
      await db.close();
    }
  });

  it("resolves model auth from the store", async () => {
    const { db, store } = await openStore();
    try {
      await store.modify("openai", async () => ({ type: "api_key", key: FAKE_KEY }));
      const models = createPiBotModels(store);
      const auth = await models.getAuth("openai");
      expect(auth?.auth.apiKey).toBe(FAKE_KEY);
      expect(
        checkModelRoles(models, { orchestrator: { provider: "openai", modelId: "gpt-6-sol" } }),
      ).toEqual([]);
      expect(checkModelRoles(models, { background: { provider: "nope", modelId: "x" } })).toEqual([
        'models.background: unknown provider "nope"',
      ]);
    } finally {
      await db.close();
    }
  });
});
