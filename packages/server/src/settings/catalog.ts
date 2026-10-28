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
};

export const ACCOUNTS: readonly AccountSpec[] = [
  {
    id: "openai-codex",
    provider: "openai-codex",
    group: "OpenAI",
    label: "ChatGPT subscription (Plus/Pro)",
    method: "oauth",
    help: "Choose device-code login, or browser login and paste the final redirect URL back here (it points at localhost:1455, which fails to load on a remote browser; copy it from the address bar).",
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
    id: "claude-subscription",
    provider: "claude-subscription",
    group: "Claude",
    label: "Claude subscription (Claude Agent SDK)",
    method: "token",
    prefix: "sk-ant-oat",
    help: "On any computer with Claude Code, run `claude setup-token`, sign in with your Claude Pro/Max account, and paste the long-lived token (sk-ant-oat…) here.",
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
