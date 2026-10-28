import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

export const KEY_BYTES = 32;

/**
 * Load the AES-256 key, creating it (32 random bytes, mode 0600, directory 0700) on first use.
 * Refuses a key file that group or others can access, or one of the wrong size.
 */
export async function loadOrCreateKeyFile(path: string): Promise<Buffer> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(randomBytes(KEY_BYTES));
    } finally {
      await handle.close();
    }
    await chmod(path, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`credential key ${path} is not a file`);
  if ((info.mode & 0o077) !== 0) {
    throw new Error(
      `credential key ${path} is accessible by group/others (mode ${(info.mode & 0o777).toString(8)}); chmod 600 it`,
    );
  }
  const key = await readFile(path);
  if (key.length !== KEY_BYTES)
    throw new Error(`credential key ${path} must be ${KEY_BYTES} bytes`);
  return key;
}
