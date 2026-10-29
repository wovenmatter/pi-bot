// Wire types for the Pi Bot WebSocket API. Mirrors packages/server/src/protocol.ts; the web
// client keeps its own copy so it never imports server code into the browser bundle.

export type DisplayEntry = {
  readonly id: number;
  /** The conversation that owns the entry; differs from the viewed one for inherited entries. */
  readonly conversationId: number;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly error?: string;
};

export type BotSummary = {
  id: string;
  name: string;
  createdAt: string;
  /** Exactly one bot is "admin": it manages accounts and config and is never on a team. */
  kind: "admin" | "bot";
  /** Leads a team (one level: managers have no manager). */
  manager: boolean;
  managerId?: string;
  /** Admin's own model (`provider/modelId`); other bots use the default model role. */
  model?: string;
};
export type DeletedBotSummary = BotSummary & { deletedAt: string };

/** First run: sign in to a provider, then pick Admin's model. */
export type OnboardingStatus = {
  adminId: string;
  adminModel?: string;
  signedIn: boolean;
  needed: boolean;
};

export type ThreadSummary = {
  conversationId: number;
  parentConversationId: number;
  forkedAt: number;
  createdAt: string;
};

export type ConversationSnapshot = {
  botId: string;
  conversationId: number;
  mainConversationId: number;
  entries: DisplayEntry[];
  running: boolean;
  streaming?: string;
};

export type StreamEvent =
  | { kind: "run"; state: "start" | "end" }
  | { kind: "assistant_start"; text: string }
  | { kind: "delta"; text: string }
  | { kind: "entry"; entry: DisplayEntry }
  | { kind: "error"; message: string };

export type EventMessage = {
  type: "event";
  botId: string;
  conversationId: number;
  event: StreamEvent;
};

export type AccountMethod = "oauth" | "api_key" | "token";

/** One sign-in slot. Keys are write-only: `detail` shows at most the last four characters. */
export type AccountStatus = {
  id: string;
  provider: string;
  group: string;
  label: string;
  method: AccountMethod;
  help: string;
  link?: string;
  /** Sign-in variants; the first is the default. */
  loginMethods?: { id: string; label: string }[];
  configured: boolean;
  detail?: string;
  ambient?: boolean;
};

export type SearchProviderId = "exa" | "brave" | "firecrawl";

export type LoginPrompt =
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
  | {
      type: "select";
      message: string;
      options: { id: string; label: string; description?: string }[];
    };

export type LoginEvent =
  | { kind: "auth_url"; url: string; instructions?: string }
  | { kind: "device_code"; userCode: string; verificationUri: string; expiresInSeconds?: number }
  | { kind: "prompt"; promptId: string; prompt: LoginPrompt }
  | { kind: "prompt_closed"; promptId: string }
  | { kind: "info" | "progress"; message: string; links?: { url: string; label?: string }[] }
  | { kind: "done" }
  | { kind: "error"; message: string };

export type LoginMessage = { type: "login"; loginId: string; event: LoginEvent };

export type ModelOption = { id: string; name: string; reasoning: boolean; contextWindow: number };
export type ProviderModels = { id: string; name: string; models: ModelOption[] };
export type Roles = {
  orchestrator: string;
  background: string;
  titles: string;
  titlesReasoning: string;
};

export type EffectiveConfig = {
  bot_to_bot: { max_rounds_per_request: number; max_messages_per_hour_per_pair: number };
  extraction: { schedule: string; timezone: string };
  search: { provider: SearchProviderId };
  git: { user_name?: string; user_email?: string };
};

export type SshPublicKey = {
  type: string;
  publicKey: string;
  fingerprint: string;
  comment?: string;
};
export type GitHubStatus = { sshKey?: SshPublicKey; identity: { name?: string; email?: string } };

export type ConfigEdit = { path: string[]; value: string | number | boolean };

export type ServerMessage =
  | { type: "hello"; version: string }
  | { type: "result"; id: string | number; data: unknown }
  | { type: "error"; id?: string | number; message: string }
  /** The bot list changed (a bot created one, a team changed): refetch `bots.list`. */
  | { type: "bots.changed" }
  | EventMessage
  | LoginMessage;

/** Request bodies (without `id`) and the result each one resolves to. */
export type Requests = {
  "bots.list": { body: Record<never, never>; result: { bots: BotSummary[] } };
  "bots.create": { body: { name: string; managerId?: string }; result: { bot: BotSummary } };
  "bots.delete": { body: { botId: string }; result: { deleted: boolean } };
  "bots.listDeleted": { body: Record<never, never>; result: { bots: DeletedBotSummary[] } };
  "bots.restore": {
    body: { botId: string };
    result: { restored: true; bot: BotSummary } | { restored: false };
  };
  "bots.setManager": { body: { botId: string; manager: boolean }; result: { bot: BotSummary } };
  "bots.setTeam": {
    body: { botId: string; managerId: string | null };
    result: { bot: BotSummary };
  };
  "bots.replaceManager": {
    body: { managerId: string; newManagerId: string };
    result: { bot: BotSummary };
  };
  "onboarding.status": { body: Record<never, never>; result: OnboardingStatus };
  "admin.setModel": { body: { model: string }; result: { bot: BotSummary } };
  "conversation.open": {
    body: { botId: string; conversationId?: number };
    result: ConversationSnapshot;
  };
  "conversation.close": {
    body: { botId: string; conversationId: number };
    result: { closed: boolean };
  };
  "message.send": {
    body: { botId: string; conversationId?: number; text: string };
    result: { conversationId: number; submissionId: number };
  };
  "thread.fork": {
    body: { botId: string; conversationId?: number; entryId: number };
    result: { thread: ThreadSummary };
  };
  "threads.list": { body: { botId: string }; result: { threads: ThreadSummary[] } };
  "settings.accounts": {
    body: Record<never, never>;
    result: {
      accounts: AccountStatus[];
      search: { provider: SearchProviderId; providers: AccountStatus[] };
    };
  };
  "credentials.set": { body: { accountId: string; key: string }; result: { saved: true } };
  "credentials.remove": { body: { accountId: string }; result: { removed: true } };
  "login.start": {
    body: { accountId: string; method?: string };
    result: { loginId: string };
  };
  "login.respond": {
    body: { loginId: string; promptId: string; value: string };
    result: { ok: true };
  };
  "login.cancel": { body: { loginId: string }; result: { ok: true } };
  "models.catalog": {
    body: Record<never, never>;
    result: { providers: ProviderModels[]; roles: Roles; reasoningLevels: string[] };
  };
  "models.setRoles": {
    body: Partial<Roles>;
    result: { roles: Roles; restartRequired: true };
  };
  "config.get": {
    body: Record<never, never>;
    result: {
      path?: string;
      text: string;
      exists: boolean;
      restartRequired: boolean;
      effective?: EffectiveConfig;
    };
  };
  "config.validate": {
    body: { text: string };
    result: { ok: true } | { ok: false; error: string };
  };
  "config.save": { body: { text: string }; result: { saved: true; restartRequired: true } };
  "config.update": {
    body: { edits: ConfigEdit[] };
    result: { saved: true; restartRequired: true };
  };
  "github.get": { body: Record<never, never>; result: GitHubStatus };
  "github.setSshKey": { body: { privateKey: string }; result: { sshKey: SshPublicKey } };
  "github.generateSshKey": { body: { comment?: string }; result: { sshKey: SshPublicKey } };
  "github.removeSshKey": { body: Record<never, never>; result: { removed: true } };
  "github.setIdentity": {
    body: { name: string; email: string };
    result: { saved: true; restartRequired: true };
  };
  "server.restart": {
    body: Record<never, never>;
    result: { restarting: true; activeWork: number; mode: "reload" | "exit" };
  };
};
