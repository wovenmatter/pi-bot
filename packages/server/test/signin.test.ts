import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { Api, AuthEvent, AuthPrompt, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLAUDE_SUBSCRIPTION_PROVIDER, claudeAgentProvider } from "../src/claude/provider.ts";
import {
  CLAUDE_TERMINAL_STEPS,
  classifyClaudeInput,
  claudeSetupTokenAuth,
  type SetupTokenProcess,
  type SetupTokenSpawn,
  terminalText,
} from "../src/claude/setup-token.ts";
import { EncryptedSqliteCredentialStore } from "../src/credentials/index.ts";
import { createPiBotModels } from "../src/models.ts";
import { openSharedDatabase } from "../src/storage/database.ts";
import { FakeProviders } from "./fake-providers.ts";
import { tempDir } from "./helpers.ts";

/** Sign in with Claude: `claude setup-token` driven in a (fake) PTY. No network, no real token. */

const AUTH_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=x&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&state=abc";
const TOKEN = "sk-ant-oat01-FAKEfakeFAKEfakeFAKEfake_123-xyz";

/** A scripted stand-in for `script -qfec … claude setup-token`. */
class FakeTerminal extends EventEmitter implements SetupTokenProcess {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly written: string[] = [];
  readonly signals: (string | undefined)[] = [];
  readonly stdin = {
    write: (chunk: string) => {
      this.written.push(chunk);
      this.emit("input", chunk);
      return true;
    },
  };
  print(text: string) {
    this.stdout.emit("data", Buffer.from(text));
  }
  kill(signal?: NodeJS.Signals) {
    this.signals.push(signal);
    return true;
  }
}

function fakeSpawn(make: (terminal: FakeTerminal) => void) {
  const runs: { command: string; args: readonly string[]; env: Record<string, string> }[] = [];
  const terminals: FakeTerminal[] = [];
  const spawn: SetupTokenSpawn = (command, args, options) => {
    runs.push({ command, args, env: options.env });
    const terminal = new FakeTerminal();
    terminals.push(terminal);
    queueMicrotask(() => make(terminal));
    return terminal;
  };
  return { spawn, runs, terminals };
}

/** The setup-token screen up to "Paste code here if prompted". */
function showSignIn(terminal: FakeTerminal) {
  terminal.print("\x1b[2J\x1b[?25l Welcome to Claude Code\r\n");
  terminal.print(
    `Browser didn't open? Use the url below to sign in (c to copy)\r\n\r\n${AUTH_URL}\r\n`,
  );
  terminal.print("\x1b[1mPaste code here if prompted >\x1b[22m ");
}

function interaction(answers: string[], controller = new AbortController()) {
  const events: AuthEvent[] = [];
  const prompts: AuthPrompt[] = [];
  return {
    events,
    prompts,
    controller,
    value: {
      signal: controller.signal,
      notify(event: AuthEvent) {
        events.push(event);
      },
      async prompt(prompt: AuthPrompt) {
        prompts.push(prompt);
        const answer = answers.shift();
        if (answer === undefined) return new Promise<string>(() => {});
        return answer;
      },
    },
  };
}

describe("Sign in with Claude (server-driven claude setup-token)", () => {
  it("shows Claude Code's link, types the pasted code into it and keeps the token it prints", async () => {
    const fake = fakeSpawn((terminal) => {
      showSignIn(terminal);
      terminal.on("input", (chunk: string) => {
        if (chunk === "\r") {
          terminal.print(
            "\r\n\x1b[32m✓ Long-lived authentication token created successfully!\x1b[39m\r\n",
          );
          terminal.print(`Your OAuth token (valid for 1 year):\r\n\r\n${TOKEN}\r\n`);
        }
      });
    });
    const run = interaction(["not a code", "the-code#abc"]);
    const before = Date.now();
    const credential = await claudeSetupTokenAuth({
      executable: "/opt/claude",
      spawn: fake.spawn,
    }).login(run.value, {});

    // Claude Code's own binary, in a PTY, running setup-token with a throwaway config dir.
    expect(fake.runs).toHaveLength(1);
    const [spawned] = fake.runs;
    expect(spawned?.command).toBe("script");
    expect(spawned?.args.join(" ")).toContain('exec "$PIBOT_CLAUDE_BIN" setup-token');
    expect(spawned?.env.PIBOT_CLAUDE_BIN).toBe("/opt/claude");
    expect(spawned?.env.BROWSER).toBe("true");
    expect(spawned?.env.CLAUDE_CONFIG_DIR).toMatch(/pi-bot-claude-login-/);
    expect(Object.keys(spawned?.env ?? {}).filter((name) => name.startsWith("ANTHROPIC_"))).toEqual(
      [],
    );

    const authUrl = run.events.find((event) => event.type === "auth_url");
    expect(authUrl).toMatchObject({ type: "auth_url", url: AUTH_URL });
    expect(authUrl?.type === "auth_url" && authUrl.instructions).toMatch(/^1\. .*\n2\. .*\n3\. /);
    // A bad paste asks again; the good one goes to Claude Code, then Enter.
    expect(run.prompts.map((prompt) => prompt.type)).toEqual(["manual_code", "manual_code"]);
    expect(run.prompts[1]?.message).toMatch(/including the part after #/);
    expect(fake.terminals[0]?.written).toEqual(["the-code#abc", "\r"]);
    expect(credential).toMatchObject({ type: "oauth", access: TOKEN, refresh: "" });
    expect(credential.expires).toBeGreaterThan(before + 360 * 24 * 3600 * 1000);
    expect(fake.terminals[0]?.signals).toContain("SIGTERM");
  });

  it("takes an already-made sk-ant-oat token pasted into the same field", async () => {
    const fake = fakeSpawn(showSignIn);
    const run = interaction([` ${TOKEN} `]);
    const credential = await claudeSetupTokenAuth({ spawn: fake.spawn }).login(run.value, {});
    expect(credential).toMatchObject({ access: TOKEN });
    expect(fake.terminals[0]?.written).toEqual([]);
  });

  it("reports Claude's own error for a rejected code", async () => {
    const fake = fakeSpawn((terminal) => {
      showSignIn(terminal);
      terminal.on("input", (chunk: string) => {
        if (chunk === "\r") {
          terminal.print(
            "\r\nOAuth error: That code wasn't accepted. It may be incomplete, expired, already used.\r\n\r\nPress Enter to retry.",
          );
        }
      });
    });
    const run = interaction(["stale#abc"]);
    await expect(claudeSetupTokenAuth({ spawn: fake.spawn }).login(run.value, {})).rejects.toThrow(
      "Claude didn't accept the code: That code wasn't accepted. It may be incomplete, expired, already used.",
    );
  });

  it("falls back to numbered terminal steps and a token paste when Claude Code can't run here", async () => {
    const fake = fakeSpawn((terminal) => terminal.emit("close", 127));
    const run = interaction(["nope", TOKEN]);
    const credential = await claudeSetupTokenAuth({ spawn: fake.spawn }).login(run.value, {});
    const info = run.events.find((event) => event.type === "info");
    expect(info?.type === "info" && info.message).toContain(`1. ${CLAUDE_TERMINAL_STEPS[0]}`);
    expect(run.prompts.map((prompt) => prompt.type)).toEqual(["secret", "secret"]);
    expect(credential).toMatchObject({ access: TOKEN });
  });

  it("cancels: kills Claude Code and rejects", async () => {
    const fake = fakeSpawn(showSignIn);
    const run = interaction([]);
    const login = claudeSetupTokenAuth({ spawn: fake.spawn }).login(run.value, {});
    await new Promise((done) => setTimeout(done, 10));
    run.controller.abort();
    await expect(login).rejects.toThrow("Sign-in cancelled");
    expect(fake.terminals[0]?.signals).toContain("SIGTERM");
  });

  it("reads terminal output and pasted values", () => {
    expect(terminalText("\x1b]0;title\x07a\x1b[1Cb\x1b[0m")).toBe("a b ");
    expect(classifyClaudeInput("abc#def")).toEqual({ code: "abc#def" });
    expect(classifyClaudeInput(TOKEN)).toEqual({ token: TOKEN });
    expect(classifyClaudeInput("abc")).toBeUndefined();
  });

  it("is the claude-subscription provider's sign-in", () => {
    const provider = claudeAgentProvider({ directory: "/tmp/x" });
    expect(provider.auth.oauth?.loginLabel).toBe("Sign in with Claude");
  });
});

describe("an expired Claude token", () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(async () => {
    await dir.cleanup();
  });

  it("asks for a new sign-in instead of refreshing, and a valid one reaches Claude Code", async () => {
    const db = await openSharedDatabase(join(dir.path, "pi-bot.sqlite"));
    try {
      const store = await EncryptedSqliteCredentialStore.open(
        db,
        join(dir.path, "credentials.key"),
      );
      const fake = new FakeProviders();
      const models = createPiBotModels(store, {
        claude: { directory: join(dir.path, "claude"), query: fake.claudeQuery },
      });
      const model = models.getModel(CLAUDE_SUBSCRIPTION_PROVIDER, "claude-haiku-4-5") as Model<Api>;
      const turn = async () => {
        const stream = models.stream(model, {
          messages: [{ role: "user", content: "hi", timestamp: 1 }],
        });
        for await (const _event of stream) {
          // drain
        }
        return stream.result();
      };
      await store.modify(CLAUDE_SUBSCRIPTION_PROVIDER, async () => ({
        type: "oauth",
        access: TOKEN,
        refresh: "",
        expires: Date.now() + 24 * 3600_000,
      }));
      const first = await turn();
      expect(first.errorMessage).toBeUndefined();
      expect(first.stopReason).toBe("stop");
      expect(fake.requests.at(-1)?.body.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);

      await store.modify(CLAUDE_SUBSCRIPTION_PROVIDER, async () => ({
        type: "oauth",
        access: TOKEN,
        refresh: "",
        expires: Date.now() - 1000,
      }));
      const expired = await turn();
      expect(expired.stopReason).toBe("error");
      expect(expired.errorMessage).toMatch(/Sign in with Claude again/);
    } finally {
      await db.close();
    }
  });
});
