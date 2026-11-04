import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GITHUB_KNOWN_HOSTS } from "./github-hosts.ts";

/** Only a personal-key success greeting identifies a user; deploy keys identify owner/repo. */
export function githubLogin(greeting: string): string | undefined {
  return /^Hi ([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)! You've successfully authenticated, but GitHub does not provide shell access\.$/im.exec(
    greeting,
  )?.[1];
}

async function probe(privateKey: string): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), "pi-bot-github-"));
  try {
    const key = join(dir, "key");
    const hosts = join(dir, "known_hosts");
    await writeFile(key, `${privateKey.trim()}\n`, { mode: 0o600 });
    await writeFile(hosts, `${GITHUB_KNOWN_HOSTS.join("\n")}\n`, { mode: 0o600 });
    return await new Promise((resolve) => {
      execFile(
        "ssh",
        [
          "-F",
          "/dev/null",
          "-T",
          "-i",
          key,
          "-o",
          "IdentitiesOnly=yes",
          "-o",
          "IdentityAgent=none",
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          `UserKnownHostsFile=${hosts}`,
          "-o",
          "GlobalKnownHostsFile=/dev/null",
          "-o",
          "ConnectTimeout=5",
          "git@github.com",
        ],
        { timeout: 10_000, maxBuffer: 16_384, env: { ...process.env, LC_ALL: "C" } },
        (error, stdout, stderr) => {
          // GitHub's successful test exits 1. Never log errors: they contain command details.
          resolve(!error || error.code === 1 ? githubLogin(`${stdout}\n${stderr}`) : undefined);
        },
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function lookup(login: string): Promise<string | undefined> {
  const response = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "pi-bot" },
    signal: AbortSignal.timeout(5_000),
    redirect: "error",
  });
  if (!response.ok) return undefined;
  const user = (await response.json()) as { id?: unknown; login?: unknown; type?: unknown };
  if (
    user.type !== "User" ||
    typeof user.login !== "string" ||
    user.login.toLowerCase() !== login.toLowerCase() ||
    !Number.isSafeInteger(user.id) ||
    Number(user.id) <= 0
  )
    return undefined;
  return `${user.id}+${user.login}@users.noreply.github.com`;
}

/** Single-entry cache deduplicates container syncs; rotation never reuses another key's identity. */
export class GitHubEmailResolver {
  #cache: { fingerprint: string; expires: number; result: Promise<string | undefined> } | undefined;
  private readonly identify: typeof probe;
  private readonly emailForLogin: typeof lookup;
  private readonly now: () => number;
  constructor(identify = probe, emailForLogin = lookup, now = Date.now) {
    this.identify = identify;
    this.emailForLogin = emailForLogin;
    this.now = now;
  }

  resolve(privateKey: string): Promise<string | undefined> {
    const fingerprint = createHash("sha256").update(privateKey).digest("hex");
    if (this.#cache?.fingerprint === fingerprint && this.#cache.expires > this.now())
      return this.#cache.result;
    const entry = {
      fingerprint,
      expires: Number.POSITIVE_INFINITY,
      result: Promise.resolve<string | undefined>(undefined),
    };
    entry.result = (async () => {
      try {
        const login = await this.identify(privateKey);
        const email = login ? await this.emailForLogin(login) : undefined;
        entry.expires = this.now() + (email ? 600_000 : 30_000);
        return email;
      } catch {
        entry.expires = this.now() + 30_000;
        return undefined;
      }
    })();
    this.#cache = entry;
    return entry.result;
  }
}
