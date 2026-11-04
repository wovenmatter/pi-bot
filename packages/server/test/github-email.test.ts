import { describe, expect, it, vi } from "vitest";
import { GitHubEmailResolver, githubLogin } from "../src/settings/github-email.ts";

describe("automatic GitHub email", () => {
  it("uses the verified public account ID and refuses mismatched or invalid accounts", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      for (const [user, expected] of [
        [{ id: 123, login: "Fixture", type: "User" }, "123+Fixture@users.noreply.github.com"],
        [{ id: 123, login: "someone-else", type: "User" }, undefined],
        [{ id: -1, login: "fixture", type: "User" }, undefined],
        [{ id: 123, login: "fixture", type: "Organization" }, undefined],
      ] as const) {
        fetch.mockResolvedValue(new Response(JSON.stringify(user)));
        const resolver = new GitHubEmailResolver(async () => "fixture");
        expect(await resolver.resolve("fake-key")).toBe(expected);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("accepts personal key greetings and rejects deploy keys and failures", () => {
    expect(
      githubLogin(
        "Hi example-user! You've successfully authenticated, but GitHub does not provide shell access.\n",
      ),
    ).toBe("example-user");
    expect(
      githubLogin(
        "Hi owner/repo! You've successfully authenticated, but GitHub does not provide shell access.",
      ),
    ).toBeUndefined();
    expect(githubLogin("Permission denied (publickey).")).toBeUndefined();
  });
  it("deduplicates concurrent lookups, expires results, and follows key rotation", async () => {
    let now = 0;
    const identify = vi.fn(async (key: string) => key);
    const email = vi.fn(async (login: string) => `123+${login}@users.noreply.github.com`);
    const resolver = new GitHubEmailResolver(identify, email, () => now);
    expect(await Promise.all([resolver.resolve("first"), resolver.resolve("first")])).toEqual([
      "123+first@users.noreply.github.com",
      "123+first@users.noreply.github.com",
    ]);
    expect(identify).toHaveBeenCalledTimes(1);
    expect(await resolver.resolve("second")).toBe("123+second@users.noreply.github.com");
    now = 600_001;
    await resolver.resolve("second");
    expect(identify).toHaveBeenCalledTimes(3);
  });
  it("contains failures and retries without retaining another key's address", async () => {
    let now = 0;
    const identify = vi
      .fn()
      .mockResolvedValueOnce("first")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue("second");
    const resolver = new GitHubEmailResolver(
      identify,
      async (login) => `${login}@example.com`,
      () => now,
    );
    expect(await resolver.resolve("one")).toBe("first@example.com");
    expect(await resolver.resolve("two")).toBeUndefined();
    expect(await resolver.resolve("two")).toBeUndefined();
    now = 30_001;
    expect(await resolver.resolve("two")).toBe("second@example.com");
  });
});
