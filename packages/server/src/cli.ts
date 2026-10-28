#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { ConfigError, defaultConfigPath, loadConfig, type PiBotConfig } from "./config.ts";
import { openCredentialStore } from "./credentials/index.ts";
import { createPiBotModels } from "./models.ts";
import { PiBotProcess, RESTART_EXIT_CODE_ENV, restartExitCode } from "./process.ts";
import { openSharedDatabase } from "./storage/database.ts";
import { VERSION } from "./version.ts";

const USAGE = `pi-bot ${VERSION}

Usage: pi-bot <command> [--config <path>]

Commands:
  serve                     Run the server (WebSocket at /ws, web client at /)
  set-key <provider>        Store an API key (openai, anthropic, openrouter, exa, ...) from hidden input or stdin;
                            claude-subscription takes the token printed by \`claude setup-token\`
  login <provider>          Headless OAuth sign-in: openai-codex (ChatGPT), claude-subscription (Claude
                            Pro/Max, paste code#state), xai (Grok device code)
  logout <provider>         Remove a stored credential
  credentials               List stored credentials (provider and type only)

Config: --config, $PI_BOT_CONFIG, or ~/.config/pi-bot/config.toml
Restart: Settings → Restart and apply reloads in place; set PIBOT_RESTART_EXIT_CODE (e.g. 75)
to exit with that status instead, for a supervisor that restarts on it.`;

/** Read a line without echoing it. Piped stdin is read whole. Never logs the value. */
async function readSecret(message: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let text = "";
    for await (const chunk of stdin) text += chunk;
    return text.trim();
  }
  process.stderr.write(message);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  try {
    return await new Promise<string>((done, fail) => {
      let value = "";
      const onData = (chunk: string) => {
        for (const char of chunk) {
          if (char === "\r" || char === "\n") {
            stdin.off("data", onData);
            process.stderr.write("\n");
            done(value.trim());
            return;
          }
          if (char === "\u0003") {
            stdin.off("data", onData);
            fail(new Error("cancelled"));
            return;
          }
          if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
          else value += char;
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}

async function withCredentials<T>(
  config: PiBotConfig,
  fn: (opened: Awaited<ReturnType<typeof openCredentialStore>>) => Promise<T>,
): Promise<T> {
  const db = await openSharedDatabase(config.paths.database);
  try {
    return await fn(await openCredentialStore(config, db));
  } finally {
    await db.close();
  }
}

function defaultWebDir(): string | undefined {
  const candidate = resolve(import.meta.dirname, "../../../apps/web/dist");
  return existsSync(resolve(candidate, "index.html")) ? candidate : undefined;
}

async function serve(config: PiBotConfig, configPath: string): Promise<void> {
  const webDir = config.paths.webDir ?? defaultWebDir();
  const exitCode = restartExitCode(process.env[RESTART_EXIT_CODE_ENV]);
  // Settings → Restart and apply reloads in place, or exits with `exitCode` for a supervisor.
  const server = new PiBotProcess({
    configPath,
    config,
    startOptions: webDir ? { webDir } : {},
    ...(exitCode === undefined ? {} : { exitCode }),
  });
  await server.start();
  if (!webDir) console.error("web client not built; run `pnpm build` to serve it at /");
  const stop = () => {
    void server.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function login(config: PiBotConfig, provider: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    await withCredentials(config, async ({ store }) => {
      const models = createPiBotModels(store);
      await models.login(provider, "oauth", {
        async prompt(prompt: AuthPrompt) {
          if (prompt.type === "secret") {
            rl.pause();
            try {
              return await readSecret(`${prompt.message}: `);
            } finally {
              rl.resume();
            }
          }
          if (prompt.type === "select") {
            for (const [index, option] of prompt.options.entries()) {
              console.error(`  ${index + 1}. ${option.label}`);
            }
            const answer = await rl.question(`${prompt.message} [1]: `);
            const chosen = prompt.options[Math.max(0, Number(answer || "1") - 1)];
            if (!chosen) throw new Error("invalid choice");
            return chosen.id;
          }
          return rl.question(`${prompt.message}: `);
        },
        notify(event: AuthEvent) {
          if (event.type === "auth_url") {
            console.error(`Open this URL to sign in:\n  ${event.url}`);
            if (event.instructions) console.error(event.instructions);
          } else if (event.type === "device_code") {
            console.error(`Go to ${event.verificationUri} and enter code ${event.userCode}`);
          } else if (event.type === "info") {
            console.error(event.message);
          }
        },
      });
    });
    console.error(`Logged in to ${provider}.`);
  } finally {
    rl.close();
  }
}

async function main(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [command, provider] = positionals;
  if (values.version) return void console.log(VERSION);
  if (values.help || !command) return void console.log(USAGE);

  const configPath = values.config ?? defaultConfigPath();
  const config = await loadConfig(configPath);
  const needProvider = () => {
    if (!provider) throw new Error(`usage: pi-bot ${command} <provider>`);
    return provider;
  };

  switch (command) {
    case "serve":
      return serve(config, configPath);
    case "set-key": {
      const id = needProvider();
      const key = await readSecret(`${id} API key: `);
      if (!key) throw new Error("no key entered");
      await withCredentials(config, ({ store }) =>
        store.modify(id, async () => ({ type: "api_key", key })),
      );
      console.error(`Stored ${id} API key.`);
      return;
    }
    case "login":
      return login(config, needProvider());
    case "logout": {
      const id = needProvider();
      await withCredentials(config, ({ store }) => store.delete(id));
      console.error(`Removed ${id} credential.`);
      return;
    }
    case "credentials": {
      const list = await withCredentials(config, async ({ store, backend }) => ({
        backend,
        items: await store.list(),
      }));
      console.log(`backend: ${list.backend}`);
      for (const item of list.items) console.log(`${item.providerId}\t${item.type}`);
      return;
    }
    default:
      throw new Error(`unknown command ${command}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof ConfigError || error instanceof Error ? error.message : error);
  process.exit(1);
});
