/** Sign-in methods the Settings page offers. Each entry maps to one credential-store slot. */
export type AccountMethod = "oauth" | "api_key" | "token";

export type AccountSpec = {
  /** Stable id used by the UI and the wire protocol. */
  readonly id: string;
  /** Credential-store / pi-ai provider id. Several entries may share one slot. */
  readonly provider: string;
  readonly group: string;
  readonly label: string;
  readonly method: AccountMethod;
  readonly help: string;
  /** Required key prefix, checked before storing. */
  readonly prefix?: string;
  /** Docs or key page. */
  readonly link?: string;
  /**
   * Sign-in variants for an oauth entry whose provider asks to choose one. The first is used
   * unless the user picks another; every variant must work from a browser on another device.
   */
  readonly loginMethods?: readonly { readonly id: string; readonly label: string }[];
};

export const ACCOUNTS: readonly AccountSpec[] = [
  {
    id: "openai-codex",
    provider: "openai-codex",
    group: "OpenAI",
    label: "ChatGPT subscription (Plus/Pro)",
    method: "oauth",
    help: "Device code: open auth.openai.com/codex/device on any device, enter the code shown here, and approve. If your ChatGPT account has device-code sign-in turned off (Settings → Security), use the browser method: sign in, then copy the localhost:1455 address the browser ends on (it will not load) and paste it here.",
    loginMethods: [
      { id: "device_code", label: "Device code" },
      { id: "browser", label: "Browser, then paste the redirect URL" },
    ],
  },
  {
    id: "openai",
    provider: "openai",
    group: "OpenAI",
    label: "OpenAI API key",
    method: "api_key",
    help: "Platform API key (sk-…). Billed per token.",
    link: "https://platform.openai.com/api-keys",
  },
  {
    id: "claude-oauth",
    provider: "claude-subscription",
    group: "Claude",
    label: "Claude account (Pro/Max)",
    method: "oauth",
    help: "Open the sign-in page on any device, approve, then copy the code Claude shows (code#state) and paste it here. Pi Bot keeps the tokens and refreshes them. Shares one slot with the setup-token below.",
  },
  {
    id: "claude-subscription",
    provider: "claude-subscription",
    group: "Claude",
    label: "Claude long-lived token (claude setup-token)",
    method: "token",
    prefix: "sk-ant-oat",
    help: "Fallback: on any computer with Claude Code, run `claude setup-token`, sign in with your Claude Pro/Max account, and paste the token (sk-ant-oat…) here. Replaces a Claude account sign-in.",
  },
  {
    id: "anthropic",
    provider: "anthropic",
    group: "Claude",
    label: "Anthropic API key",
    method: "api_key",
    help: "Console API key (sk-ant-api…). Billed per token.",
    link: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "xai-oauth",
    provider: "xai",
    group: "Grok (xAI)",
    label: "Grok account (SuperGrok or X Premium)",
    method: "oauth",
    help: "Device-code sign-in at auth.x.ai. xAI may refuse some subscription tiers; use an API key if it does. Shares one slot with the xAI API key, so setting one replaces the other.",
  },
  {
    id: "xai",
    provider: "xai",
    group: "Grok (xAI)",
    label: "xAI API key",
    method: "api_key",
    help: "API key from console.x.ai. Replaces a Grok account sign-in.",
    link: "https://console.x.ai",
  },
  {
    id: "openrouter",
    provider: "openrouter",
    group: "OpenRouter",
    label: "OpenRouter API key",
    method: "api_key",
    help: "Key from openrouter.ai/keys.",
    link: "https://openrouter.ai/keys",
  },
  {
    id: "opencode-go",
    provider: "opencode-go",
    group: "OpenCode Go",
    label: "OpenCode Go API key",
    method: "api_key",
    help: "Key from your OpenCode Go subscription (opencode.ai).",
    link: "https://opencode.ai",
  },
];

export type SearchProviderId = "exa" | "brave" | "firecrawl";

export const SEARCH_PROVIDERS: readonly (AccountSpec & { id: SearchProviderId })[] = [
  {
    id: "exa",
    provider: "exa",
    group: "Search",
    label: "Exa",
    method: "api_key",
    help: "Default provider. Key from dashboard.exa.ai.",
    link: "https://dashboard.exa.ai/api-keys",
  },
  {
    id: "brave",
    provider: "brave",
    group: "Search",
    label: "Brave Search",
    method: "api_key",
    help: "Key from the Brave Search API dashboard.",
    link: "https://api-dashboard.search.brave.com",
  },
  {
    id: "firecrawl",
    provider: "firecrawl",
    group: "Search",
    label: "Firecrawl",
    method: "api_key",
    help: "Key from firecrawl.dev.",
    link: "https://www.firecrawl.dev/app/api-keys",
  },
];

export function findAccount(id: string): AccountSpec | undefined {
  return (
    ACCOUNTS.find((entry) => entry.id === id) ?? SEARCH_PROVIDERS.find((entry) => entry.id === id)
  );
}
