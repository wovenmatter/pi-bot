/**
 * Hash routes: `#/` (no bot), `#/<botId>` (main), `#/<botId>/<conversationId>` (thread) and
 * `#/settings[/<section>]` (Settings; Bots is the only place deleted bots are listed and restored).
 */
export const SETTINGS_SECTIONS = [
  "accounts",
  "profiles",
  "bots",
  "search",
  "github",
  "config",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Retired tabs and where their content lives now, so old links keep working. */
const MOVED_SECTIONS = new Map<string, SettingsSection>([
  // The title model (the old Models tab) lives under Profiles.
  ["models", "profiles"],
]);

export type Route = {
  botId?: string;
  conversationId?: number;
  settings?: true;
  /** Settings tab; absent means the first one (Accounts). */
  section?: SettingsSection;
};

export function parseRoute(hash: string): Route {
  const [botId, conversation] = hash.replace(/^#\/?/, "").split("/");
  if (!botId) return {};
  if (botId === "settings") {
    const section =
      SETTINGS_SECTIONS.find((item) => item === conversation) ??
      MOVED_SECTIONS.get(conversation ?? "");
    return section && section !== "accounts" ? { settings: true, section } : { settings: true };
  }
  const conversationId = conversation ? Number(conversation) : undefined;
  return conversationId !== undefined && Number.isInteger(conversationId) && conversationId >= 0
    ? { botId, conversationId }
    : { botId };
}

export function routeHref(route: Route): string {
  if (route.settings) {
    return route.section && route.section !== "accounts"
      ? `#/settings/${route.section}`
      : "#/settings";
  }
  if (!route.botId) return "#/";
  return route.conversationId === undefined
    ? `#/${route.botId}`
    : `#/${route.botId}/${route.conversationId}`;
}
