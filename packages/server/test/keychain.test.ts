import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import {
  EncryptedSqliteCredentialStore,
  KeychainCredentialStore,
  openCredentialStore,
  type SecurityResult,
  type SecurityRunner,
} from "../src/credentials/index.ts";
import { openSharedDatabase } from "../src/storage/database.ts";
import { tempDir } from "./helpers.ts";

// Obviously fake; tests never use real keys or the real Keychain.
const FAKE_KEY = "sk-test-not-a-real-key-0123456789";

type FakeSecurity = {
  run: SecurityRunner;
  items: Map<string, string>;
  calls: { args: readonly string[]; input?: string }[];
};

/** In-memory stand-in for `/usr/bin/security`, covering the commands the store uses. */
function fakeSecurity(overrides: { failAdd?: boolean; findCode?: number } = {}): FakeSecurity {
  const items = new Map<string, string>();
  const calls: FakeSecurity["calls"] = [];
  const ok = (stdout = ""): SecurityResult => ({ code: 0, stdout, stderr: "" });
  const missing: SecurityResult = {
    code: 44,
    stdout: "",
    stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found.",
  };
  const opt = (args: readonly string[], flag: string) => args[args.indexOf(flag) + 1] ?? "";
  const key = (args: readonly string[]) => `${opt(args, "-s")}/${opt(args, "-a")}`;
  const exec = async (args: readonly string[]): Promise<SecurityResult> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    switch (args[0]) {
      case "default-keychain":
        return ok('    "/Users/test/Library/Keychains/login.keychain-db"\n');
      case "find-generic-password": {
        if (overrides.findCode) return { code: overrides.findCode, stdout: "", stderr: "boom" };
        const value = items.get(key(args));
        return value === undefined ? missing : ok(`${value}\n`);
      }
      case "add-generic-password": {
        // Echo the command on stderr, as a misbehaving tool might; it must never reach errors.
        if (overrides.failAdd) return { code: 0, stdout: "", stderr: args.join(" ") };
        items.set(key(args), Buffer.from(opt(args, "-X"), "hex").toString("utf8"));
        return ok();
      }
      case "delete-generic-password":
        return items.delete(key(args)) ? ok() : missing;
      default:
        return { code: 1, stdout: "", stderr: `unknown command ${args[0]}` };
    }
  };
  const run: SecurityRunner = async (args, input) => {
    calls.push({ args, ...(input === undefined ? {} : { input }) });
    if (args[0] === "-i") {
      let last = ok();
      for (const line of (input ?? "").split("\n").filter(Boolean))
        last = await exec(line.split(" "));
      return last;
    }
    return exec(args);
  };
  return { run, items, calls };
}

const hex = (text: string) => Buffer.from(text, "utf8").toString("hex");

describe("KeychainCredentialStore", () => {
  it("sets, gets, lists and deletes credentials as generic passwords", async () => {
    const security = fakeSecurity();
    const store = new KeychainCredentialStore({ run: security.run });
    expect(await store.list()).toEqual([]);
    expect(await store.hasIndex()).toBe(false);

    await store.modify("openai", async () => ({ type: "api_key", key: FAKE_KEY }));
    const oauth = { type: "oauth" as const, refresh: "r-1", access: "a-1", expires: 123 };
    await store.modify("openai-codex", async () => oauth);
    await store.modify("exa", async () => ({ type: "api_key", key: "exa-test" }));

    expect(await store.read("openai")).toEqual({ type: "api_key", key: FAKE_KEY });
    expect(await store.read("openai-codex")).toEqual(oauth);
    expect(JSON.parse(security.items.get("io.wovenmatter.pi-bot/openai") ?? "")).toEqual({
      type: "api_key",
      key: FAKE_KEY,
    });
    expect(await store.list()).toEqual([
      { providerId: "exa", type: "api_key" },
      { providerId: "openai", type: "api_key" },
      { providerId: "openai-codex", type: "oauth" },
    ]);
    expect(await store.hasIndex()).toBe(true);

    // undefined leaves the entry unchanged and returns the current value.
    expect(await store.modify("openai", async () => undefined)).toEqual({
      type: "api_key",
      key: FAKE_KEY,
    });
    await store.delete("openai");
    expect(await store.read("openai")).toBeUndefined();
    expect(security.items.has("io.wovenmatter.pi-bot/openai")).toBe(false);
    expect((await store.list()).map((item) => item.providerId)).toEqual(["exa", "openai-codex"]);

    // The secret travels on stdin (as hex), never on argv.
    const argv = security.calls.flatMap((call) => call.args).join(" ");
    expect(argv).not.toContain(FAKE_KEY);
    expect(argv).not.toContain(hex(FAKE_KEY).slice(0, 16));
    expect(security.calls.some((call) => call.input?.includes(hex(FAKE_KEY).slice(0, 16)))).toBe(
      true,
    );
  });

  it("handles missing items and rejects invalid provider ids", async () => {
    const store = new KeychainCredentialStore({ run: fakeSecurity().run });
    expect(await store.read("nope")).toBeUndefined();
    await expect(store.delete("nope")).resolves.toBeUndefined();
    await expect(store.read("_index")).rejects.toThrow(/invalid provider id/);
    await expect(store.read("a b")).rejects.toThrow(/invalid provider id/);
  });

  it("round-trips non-ASCII text and long values", async () => {
    const security = fakeSecurity();
    const store = new KeychainCredentialStore({ run: security.run });
    const unicode = { type: "oauth" as const, refresh: "ré-✓-😀", access: "a", expires: 1 };
    await store.modify("claude", async () => unicode);
    expect(await store.read("claude")).toEqual(unicode);
    expect(security.items.get("io.wovenmatter.pi-bot/claude")).toMatch(/^[\x20-\x7e]+$/);

    const long = { type: "oauth" as const, refresh: "r", access: "x".repeat(5000), expires: 1 };
    await store.modify("openai-codex", async () => long);
    expect(await store.read("openai-codex")).toEqual(long);
  });

  it("serializes concurrent modify calls per provider", async () => {
    const store = new KeychainCredentialStore({ run: fakeSecurity().run });
    const bump = () =>
      store.modify("counter", async (current) => {
        const n = current?.type === "api_key" ? Number(current.key) : 0;
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { type: "api_key", key: String(n + 1) };
      });
    await Promise.all([
      ...Array.from({ length: 10 }, bump),
      store.modify("other", async () => ({ type: "api_key", key: "o" })),
    ]);
    expect(await store.read("counter")).toEqual({ type: "api_key", key: "10" });
    expect(await store.list()).toEqual([
      { providerId: "counter", type: "api_key" },
      { providerId: "other", type: "api_key" },
    ]);
  });

  it("fails with messages that never contain the secret", async () => {
    const failing = new KeychainCredentialStore({ run: fakeSecurity({ failAdd: true }).run });
    const write = await failing
      .modify("openai", async () => ({ type: "api_key", key: FAKE_KEY }))
      .catch((error: Error) => error.message);
    expect(write).toMatch(/keychain write for openai failed/);
    expect(write).not.toContain(FAKE_KEY);
    expect(write).not.toContain(hex(FAKE_KEY).slice(0, 16));

    const locked = new KeychainCredentialStore({ run: fakeSecurity({ findCode: 51 }).run });
    await expect(locked.read("openai")).rejects.toThrow(/keychain read for openai failed: boom/);

    const security = fakeSecurity();
    security.items.set("io.wovenmatter.pi-bot/openai", `not json ${FAKE_KEY}`);
    const garbled = await new KeychainCredentialStore({ run: security.run })
      .read("openai")
      .catch((error: Error) => error.message);
    expect(garbled).toMatch(/not a valid credential/);
    expect(garbled).not.toContain(FAKE_KEY);

    await expect(
      new KeychainCredentialStore({ run: security.run }).modify(
        "x",
        async () => ({ type: "bogus" }) as never,
      ),
    ).rejects.toThrow(/unsupported credential type/);
  });

  it("reports availability from the security tool", async () => {
    expect(await KeychainCredentialStore.available(fakeSecurity().run)).toBe(true);
    expect(
      await KeychainCredentialStore.available(async () => {
        throw Object.assign(new Error("spawn /usr/bin/security ENOENT"), { code: "ENOENT" });
      }),
    ).toBe(false);
    expect(
      await KeychainCredentialStore.available(async () => ({ code: 50, stdout: "", stderr: "" })),
    ).toBe(false);
  });
});

describe("openCredentialStore", () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(async () => {
    await dir.cleanup();
  });

  const configWith = (backend?: string) =>
    parseConfig(
      `[models]\norchestrator = "openai/gpt-6-sol"\n[storage]\ndata_dir = "${dir.path}"\n${backend ? `[credentials]\nbackend = "${backend}"\n` : ""}`,
    );
  const unavailable: SecurityRunner = async () => {
    throw new Error("spawn /usr/bin/security ENOENT");
  };

  it("picks the backend per platform and setting", async () => {
    const auto = configWith();
    const db = await openSharedDatabase(auto.paths.database);
    try {
      const security = fakeSecurity();
      const linux = await openCredentialStore(auto, db, "linux", security.run);
      expect(linux.backend).toBe("encrypted-sqlite");
      expect(security.calls).toEqual([]);

      const mac = await openCredentialStore(auto, db, "darwin", security.run);
      expect(mac.backend).toBe("keychain");
      expect(mac.store).toBeInstanceOf(KeychainCredentialStore);
      expect(mac.note).toBeUndefined();

      const noTool = await openCredentialStore(auto, db, "darwin", unavailable);
      expect(noTool.backend).toBe("encrypted-sqlite");
      expect(noTool.note).toMatch(/Keychain unavailable/);

      const sqlite = configWith("encrypted-sqlite");
      expect((await openCredentialStore(sqlite, db, "darwin", unavailable)).backend).toBe(
        "encrypted-sqlite",
      );

      const keychain = configWith("keychain");
      expect((await openCredentialStore(keychain, db, "darwin", security.run)).backend).toBe(
        "keychain",
      );
      await expect(openCredentialStore(keychain, db, "linux", security.run)).rejects.toThrow(
        /needs macOS/,
      );
      await expect(openCredentialStore(keychain, db, "darwin", unavailable)).rejects.toThrow(
        /unavailable/,
      );
    } finally {
      await db.close();
    }
  });

  it("copies existing encrypted SQLite credentials into an unused Keychain once", async () => {
    const config = configWith();
    const db = await openSharedDatabase(config.paths.database);
    try {
      const sqlite = await EncryptedSqliteCredentialStore.open(db, config.paths.keyFile);
      await sqlite.modify("openai", async () => ({ type: "api_key", key: FAKE_KEY }));
      await sqlite.modify("exa", async () => ({ type: "api_key", key: "exa-test" }));

      const security = fakeSecurity();
      const first = await openCredentialStore(config, db, "darwin", security.run);
      expect(first.note).toMatch(/copied 2 credential/);
      expect(first.note).not.toContain(FAKE_KEY);
      expect(await first.store.read("openai")).toEqual({ type: "api_key", key: FAKE_KEY });
      // SQLite rows stay in place.
      expect(await sqlite.read("openai")).toEqual({ type: "api_key", key: FAKE_KEY });

      // A credential removed from the Keychain later is not copied back.
      await first.store.delete("openai");
      const second = await openCredentialStore(config, db, "darwin", security.run);
      expect(second.note).toBeUndefined();
      expect(await second.store.read("openai")).toBeUndefined();
      expect(await second.store.list()).toEqual([{ providerId: "exa", type: "api_key" }]);
    } finally {
      await db.close();
    }
  });
});
