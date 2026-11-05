import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { PROTOCOL } from "../src/identity.ts";
import { tempDir } from "./helpers.ts";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");
it("packages identical bytes twice without advancing the preview build counter", async () => {
  const dir = await tempDir();
  const counter = () =>
    readFile(join(root, ".preview-build-number"), "utf8").catch(() => undefined);
  const before = await counter();
  try {
    const a = join(dir.path, "a.tar.gz"),
      b = join(dir.path, "b.tar.gz");
    for (const out of [a, b]) await exec("pnpm", ["package:woven", "--out", out], { cwd: root });
    const bytes = await readFile(a);
    const other = await readFile(b);
    const firstEntries = unpack(bytes),
      secondEntries = unpack(other);
    const changed = [...new Set([...firstEntries.keys(), ...secondEntries.keys()])].filter(
      (path) => !firstEntries.get(path)?.equals(secondEntries.get(path) ?? Buffer.alloc(0)),
    );
    expect(other.equals(bytes), `Changed bundle entries: ${changed.join(", ")}`).toBe(true);
    expect(await counter()).toBe(before);
    const entries = firstEntries;
    const manifest = JSON.parse(entries.get("manifest.json")?.toString() ?? "{}");
    expect(manifest).toEqual({
      commit: (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim(),
      version: "0.1.0",
      protocol: PROTOCOL,
      lockSha256: createHash("sha256")
        .update(await readFile(join(root, "pnpm-lock.yaml")))
        .digest("hex"),
    });
    for (const path of [
      "package.json",
      "pnpm-workspace.yaml",
      "pnpm-lock.yaml",
      "LICENSE",
      "packages/server/package.json",
      "packages/server/dist/cli.js",
      "packages/server/docker/agent.mjs",
      "apps/web/package.json",
      "apps/web/dist/index.html",
    ])
      expect(entries.has(path), path).toBe(true);
    expect(
      [...entries.keys()].some((path) => /node_modules|\.sqlite|config\.toml|\.key$/.test(path)),
    ).toBe(false);
  } finally {
    await dir.cleanup();
  }
}, 120_000);

function unpack(bytes: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(bytes);
  const entries = new Map<string, Buffer>();
  for (let offset = 0; offset < tar.length - 512; ) {
    const name = tar
      .subarray(offset, offset + 100)
      .toString()
      .replace(/\0.*$/s, "");
    if (!name) break;
    const size = Number.parseInt(tar.subarray(offset + 124, offset + 136).toString(), 8);
    entries.set(name, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }

  return entries;
}
