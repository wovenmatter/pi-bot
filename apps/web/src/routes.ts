/**
 * Hash routes: `#/` (no bot), `#/<botId>` (main), `#/<botId>/<conversationId>` (thread) and
 * `#/settings[/<section>]` (Settings; Bots is the only place deleted bots are listed and restored).
 */
export const SETTINGS_SECTIONS = [
  "accounts",
  "models",
  "search",
  "github",
  "bots",
  "config",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export type Route = {
  botId?: string;
  conversationId?: number;
  settings?: true;
  /** Settings tab; absent means the first one (Account & sign-ins). */
  section?: SettingsSection;
};

export function parseRoute(hash: string): Route {
  const [botId, conversation] = hash.replace(/^#\/?/, "").split("/");
  if (!botId) return {};
  if (botId === "settings") {
    const section = SETTINGS_SECTIONS.find((item) => item === conversation);
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
