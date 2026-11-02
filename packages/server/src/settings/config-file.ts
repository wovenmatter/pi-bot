import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** config.toml as read now, with the revision a later write can be checked against. */
export type ConfigFileSnapshot = {
  readonly text: string;
  readonly exists: boolean;
  /** Content hash of `text` ("missing" without a file). config.toml holds no secrets. */
  readonly revision: string;
};

/** A write based on a revision the file no longer has: someone else changed it meanwhile. */
export class ConfigConflictError extends Error {
  override name = "ConfigConflictError";
}

export const MISSING_REVISION = "missing";

export function configRevision(text: string | undefined): string {
  if (text === undefined) return MISSING_REVISION;
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/** Every write to one config file in this process goes through its queue, in order. */
const queues = new Map<string, Promise<unknown>>();

export async function readConfigFile(path: string): Promise<ConfigFileSnapshot> {
  try {
    const text = await readFile(path, "utf8");
    return { text, exists: true, revision: configRevision(text) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { text: "", exists: false, revision: MISSING_REVISION };
  }
}

export type ConfigWriteOptions = {
  /** Refuse the write (`ConfigConflictError`) unless the file still has this revision. */
  readonly expectedRevision?: string;
};

/**
 * Read, change and write config.toml as one step, serialized with every other write to the same
 * path in this process (Settings, the raw editor, Admin Bot's tools and live profile saves).
 * `change` gets the file as it is now and returns the new text (or throws to write nothing); it
 * validates. The write is atomic (temp file and rename) and keeps the file's mode (0600 when new).
 * Resolves with the file as written.
 */
export function updateConfigFile(
  path: string,
  change: (current: ConfigFileSnapshot) => string | Promise<string>,
  options: ConfigWriteOptions = {},
): Promise<ConfigFileSnapshot> {
  const key = resolve(path);
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(async () => {
    const current = await readConfigFile(key);
    if (options.expectedRevision !== undefined && options.expectedRevision !== current.revision) {
      throw new ConfigConflictError(
        "config.toml changed since it was loaded (another edit was saved meanwhile); reload it and apply your change again",
      );
    }
    const text = await change(current);
    if (current.exists && text === current.text) return current;
    await atomicWrite(key, text);
    return { text, exists: true, revision: configRevision(text) };
  });
  const settled = run.catch(() => {});
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return run;
}

async function atomicWrite(path: string, text: string): Promise<void> {
  let mode = 0o600;
  try {
    mode = (await stat(path)).mode & 0o777;
  } catch {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  }
  const temp = join(dirname(path), `.config.toml.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, text, { mode });
    await chmod(temp, mode);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}
