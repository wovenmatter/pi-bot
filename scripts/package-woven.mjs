import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out" || !args[1]) {
  throw new Error("usage: pnpm package:woven --out <file>");
}
const out = resolve(args[1]);
execFileSync("pnpm", ["build"], {
  cwd: root,
  env: { ...process.env, NODE_ENV: "production", PI_BOT_PACKAGE_WOVEN: "1" },
  stdio: "inherit",
});
const manifest = {
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  version: JSON.parse(await readFile(resolve(root, "packages/server/package.json"), "utf8"))
    .version,
  protocol: 1,
  lockSha256: createHash("sha256")
    .update(await readFile(resolve(root, "pnpm-lock.yaml")))
    .digest("hex"),
};
const files = new Map([
  ["manifest.json", { data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), mode: 0o644 }],
]);
async function collect(path) {
  const full = resolve(root, path);
  const info = await lstat(full);
  if (info.isDirectory()) {
    for (const name of (await readdir(full)).sort()) await collect(`${path}/${name}`);
  } else if (info.isFile()) {
    files.set(path, { data: await readFile(full), mode: info.mode & 0o111 ? 0o755 : 0o644 });
  } else throw new Error(`Unsupported bundle entry: ${path}`);
}
for (const path of [
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "LICENSE",
  "packages/server/package.json",
  "packages/server/dist",
  "packages/server/docker",
  "apps/web/package.json",
  "apps/web/dist",
])
  await collect(path);

const chunks = [];
for (const path of [...files.keys()].sort()) {
  const { data, mode } = files.get(path);
  const header = Buffer.alloc(512);
  if (Buffer.byteLength(path) > 100) throw new Error(`Bundle path too long: ${path}`);
  const field = (value, offset, length) => header.write(value, offset, length, "ascii");
  const octal = (value, offset, length) =>
    field(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length);
  field(path, 0, 100);
  octal(mode, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(data.length, 124, 12);
  octal(0, 136, 12);
  field("        ", 148, 8);
  field("0", 156, 1);
  field("ustar\0", 257, 6);
  field("00", 263, 2);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  field(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  chunks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
}
chunks.push(Buffer.alloc(1024));
await writeFile(out, gzipSync(Buffer.concat(chunks), { level: 9 }));
console.log(`Wrote ${out} (${manifest.commit})`);
