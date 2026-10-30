import { spawn as nodeSpawn } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthEvent, AuthPrompt, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";

/**
 * "Sign in with Claude", headless and server-driven: Pi Bot runs Anthropic's own, unmodified
 * `claude setup-token` (the Claude Code binary the Agent SDK bundles) in a pseudo-terminal, shows
 * the sign-in link it prints, types the code the user pastes back into it, and keeps the one-year
 * OAuth token it prints. Claude Code does the OAuth itself (PKCE, token exchange); Pi Bot never
 * talks to Anthropic's OAuth endpoints. The token goes to Claude Code as CLAUDE_CODE_OAUTH_TOKEN,
 * exactly what Anthropic documents it for ("Generate a long-lived token",
 * https://code.claude.com/docs/en/authentication). `setup-token` is an interactive terminal app
 * and prints nothing without a TTY, hence util-linux `script` as the PTY. Without one (or without
 * the binary) the same row falls back to "run `claude setup-token` anywhere and paste the token".
 */

/** A token from `claude setup-token`: what CLAUDE_CODE_OAUTH_TOKEN takes. */
export const CLAUDE_TOKEN_PATTERN = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/;
/** Anthropic's copy-code redirect shows `code#state`. */
const CODE_PATTERN = /^[^#\s]+#[^#\s]+$/;
const AUTH_URL_PATTERN =
  /https:\/\/(?:claude\.ai|claude\.com|platform\.claude\.com)\/(?:cai\/)?oauth\/authorize\?[\w%&=.~:/?+-]+/;
/** Tokens last a year; treat them as expired a day early. */
const TOKEN_LIFETIME_MS = 364 * 24 * 60 * 60 * 1000;
const MAX_OUTPUT = 1 << 20;

export const CLAUDE_SIGN_IN_STEPS = [
  "Open the Claude sign-in link (any browser, any device).",
  "Sign in with your Claude account (Pro, Max, Team or Enterprise) and approve.",
  "Copy the code Claude shows and paste it here.",
] as const;

export const CLAUDE_TERMINAL_STEPS = [
  "On any computer with Claude Code, run `claude setup-token`.",
  "Sign in with your Claude account (Pro, Max, Team or Enterprise) in the browser it opens.",
  "Paste the token it prints (sk-ant-oat…) here.",
] as const;

/** The parts of a child process the flow uses (tests pass a fake). */
export type SetupTokenProcess = {
  readonly stdin: { write(chunk: string): unknown };
  readonly stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  readonly stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
};

export type SetupTokenSpawn = (
  command: string,
  args: readonly string[],
  options: { env: Record<string, string> },
) => SetupTokenProcess;

export type SetupTokenOptions = {
  /** The Claude Code binary; the Agent SDK's bundled one by default, else `claude` on PATH. */
  readonly executable?: string;
  /** Replace process spawning (tests). */
  readonly spawn?: SetupTokenSpawn;
  /** Give up on the whole sign-in after this long. Default 15 minutes. */
  readonly timeoutMs?: number;
  /** No link printed after this long: fall back to the terminal steps. Default 45 s. */
  readonly startTimeoutMs?: number;
};

type Interaction = {
  readonly signal: AbortSignal;
  prompt(prompt: AuthPrompt): Promise<string>;
  notify(event: AuthEvent): void;
};

/** The Claude Code binary the Agent SDK ships for this platform, if installed. */
export function bundledClaudeExecutable(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const sdk = createRequire(require.resolve("@anthropic-ai/claude-agent-sdk"));
    const manifest = sdk.resolve(
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`,
    );
    return join(manifest, "..", "claude");
  } catch {
    return undefined;
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC sequences (titles, hyperlinks).
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: CSI sequences (colours, cursor moves).
const CSI = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: two-byte escapes.
const ESC = /\x1b[78=>cM]/g;

/** Terminal output as plain text: no escape sequences, cursor moves read as spaces. */
export function terminalText(raw: string): string {
  return raw.replace(OSC, "").replace(CSI, " ").replace(ESC, "");
}

function oauthError(text: string): string | undefined {
  const match = /OAuth error:\s*(.+?)(?:\s{2,}|\s*Press\s|\r|\n|$)/.exec(text);
  return match?.[1]?.trim();
}

/** A pasted value: the page's `code#state`, or a finished setup-token. */
export function classifyClaudeInput(raw: string): { code: string } | { token: string } | undefined {
  const value = raw.trim();
  if (value.length > 8192) return undefined;
  const token = CLAUDE_TOKEN_PATTERN.exec(value);
  if (token && token[0] === value) return { token: value };
  return CODE_PATTERN.test(value) ? { code: value } : undefined;
}

export function claudeTokenCredential(token: string, now = Date.now()): OAuthCredential {
  return { type: "oauth", access: token, refresh: "", expires: now + TOKEN_LIFETIME_MS };
}

const defaultSpawn: SetupTokenSpawn = (command, args, options) =>
  nodeSpawn(command, args, { env: options.env, stdio: ["pipe", "pipe", "pipe"] });

function childEnvironment(config: string, executable: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(ANTHROPIC_|CLAUDE_|CLAUDECODE$)/.test(name)) env[name] = value;
  }
  return {
    ...env,
    TERM: "xterm-256color",
    // Never open a browser on the server; the link goes to the user instead.
    BROWSER: "true",
    CLAUDE_CONFIG_DIR: config,
    PIBOT_CLAUDE_BIN: executable,
  };
}

class FallBack extends Error {}

/** Ask for a finished token: the "run it in a terminal" path, still one row. */
async function pasteToken(interaction: Interaction, reason?: string): Promise<string> {
  interaction.notify({
    type: "info",
    message: [
      ...(reason ? [reason] : []),
      ...CLAUDE_TERMINAL_STEPS.map((step, index) => `${index + 1}. ${step}`),
    ].join("\n"),
  });
  let message = "Paste the token from `claude setup-token`";
  for (;;) {
    const answer = await interaction.prompt({
      type: "secret",
      message,
      placeholder: "sk-ant-oat…",
    });
    const input = classifyClaudeInput(answer);
    if (input && "token" in input) return input.token;
    message = "That is not a setup token. Paste the whole sk-ant-oat… token it printed.";
  }
}

/** Run `claude setup-token` in a PTY and walk the user through it. Resolves with the token. */
async function runSetupToken(
  interaction: Interaction,
  options: SetupTokenOptions,
): Promise<string> {
  const executable = options.executable ?? bundledClaudeExecutable() ?? "claude";
  const config = await mkdtemp(join(tmpdir(), "pi-bot-claude-login-"));
  await chmod(config, 0o700);
  const spawn = options.spawn ?? defaultSpawn;
  try {
    return await new Promise<string>((resolve, reject) => {
      const inputs = new AbortController();
      let raw = "";
      let url: string | undefined;
      let codeSent = false;
      let settled = false;
      let child: SetupTokenProcess | undefined;
      const timers: ReturnType<typeof setTimeout>[] = [];
      const stop = () => {
        inputs.abort();
        for (const timer of timers) clearTimeout(timer);
        try {
          child?.kill("SIGTERM");
          const kill = setTimeout(() => child?.kill("SIGKILL"), 1500);
          kill.unref?.();
        } catch {
          // Already gone.
        }
      };
      const settle = (error: Error | undefined, token?: string) => {
        if (settled) return;
        settled = true;
        interaction.signal.removeEventListener("abort", cancelled);
        stop();
        if (error) reject(error);
        else resolve(token as string);
      };
      const cancelled = () => settle(new Error("Sign-in cancelled"));
      if (interaction.signal.aborted) return cancelled();
      interaction.signal.addEventListener("abort", cancelled, { once: true });

      const askForCode = async () => {
        let message = "Paste the code Claude shows";
        try {
          while (!settled) {
            const answer = await interaction.prompt({
              type: "manual_code",
              message,
              placeholder: "code#state (or a sk-ant-oat… token)",
              signal: inputs.signal,
            });
            if (settled) return;
            const input = classifyClaudeInput(answer);
            if (input && "token" in input) return settle(undefined, input.token);
            if (!input) {
              message = "Copy the whole code from the Claude page, including the part after #.";
              continue;
            }
            codeSent = true;
            child?.stdin.write(input.code);
            // A separate Enter, as if typed after pasting.
            const enter = setTimeout(() => {
              if (!settled) child?.stdin.write("\r");
            }, 250);
            timers.push(enter);
            interaction.notify({ type: "progress", message: "Creating your Claude token…" });
            return;
          }
        } catch (error) {
          if (!settled) settle(error instanceof Error ? error : new Error(String(error)));
        }
      };

      const consume = (chunk: Buffer | string) => {
        if (settled) return;
        raw = (raw + chunk.toString()).slice(-MAX_OUTPUT);
        const text = terminalText(raw);
        const token = CLAUDE_TOKEN_PATTERN.exec(text);
        if (token) return settle(undefined, token[0]);
        if (codeSent) {
          const error = oauthError(text);
          if (error) return settle(new Error(`Claude didn't accept the code: ${error}`));
        }
        if (!url) {
          const match = AUTH_URL_PATTERN.exec(text);
          if (match) {
            url = match[0];
            interaction.notify({
              type: "auth_url",
              url,
              instructions: CLAUDE_SIGN_IN_STEPS.map((step, i) => `${i + 1}. ${step}`).join("\n"),
            });
            void askForCode();
          }
        }
      };

      try {
        child = spawn(
          "script",
          [
            "-qfec",
            'stty cols 1000 rows 50 2>/dev/null; exec "$PIBOT_CLAUDE_BIN" setup-token',
            "/dev/null",
          ],
          { env: childEnvironment(config, executable) },
        );
      } catch {
        return settle(new FallBack("Pi Bot couldn't start Claude Code here."));
      }
      child.stdout.on("data", consume);
      child.stderr.on("data", consume);
      child.on("error", () => settle(new FallBack("Pi Bot couldn't start Claude Code here.")));
      child.on("close", () => {
        if (!url) return settle(new FallBack("Claude Code's sign-in didn't start here."));
        settle(new Error("Claude sign-in did not finish. Try again."));
      });
      const start = setTimeout(() => {
        if (!url) settle(new FallBack("Claude Code's sign-in didn't start here."));
      }, options.startTimeoutMs ?? 45_000);
      const overall = setTimeout(
        () => settle(new Error("Claude sign-in timed out. Try again.")),
        options.timeoutMs ?? 15 * 60_000,
      );
      start.unref?.();
      overall.unref?.();
      timers.push(start, overall);
    });
  } finally {
    await rm(config, { recursive: true, force: true });
  }
}

/** Sign in with Claude: the server-driven `claude setup-token` flow, or paste a token. */
export async function claudeSignIn(
  interaction: Interaction,
  options: SetupTokenOptions = {},
): Promise<string> {
  try {
    return await runSetupToken(interaction, options);
  } catch (error) {
    if (!(error instanceof FallBack) || interaction.signal.aborted) throw error;
    return pasteToken(interaction, `${error.message} Do it in a terminal instead:`);
  }
}

/**
 * The `claude-subscription` provider's sign-in. The credential is the setup-token, stored as an
 * oauth credential that expires when the token does; there is no refresh token, so an expired one
 * asks for a new sign-in instead of refreshing.
 */
export function claudeSetupTokenAuth(options: SetupTokenOptions = {}): OAuthAuth {
  return {
    name: "Claude subscription (claude setup-token)",
    isSubscription: true,
    loginLabel: "Sign in with Claude",
    login: async (interaction) => claudeTokenCredential(await claudeSignIn(interaction, options)),
    refresh: async () => {
      throw new Error(
        "Your Claude token has expired. Sign in with Claude again under Settings → Accounts.",
      );
    },
    toAuth: async (credential) => ({ apiKey: credential.access }),
  };
}
