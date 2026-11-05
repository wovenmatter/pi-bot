/**
 * Hash routes: `#/` (no bot), `#/<botId>` (main), `#/<botId>/<conversationId>` (thread) and
 * `#/settings[/<section>]` (Settings; Bots is the only place deleted bots are listed and restored).
 */
export const SETTINGS_SECTIONS = [
  "general",
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
  threadView?: "split";
  settings?: true;
  /** Settings tab; absent means the first one (General). */
  section?: SettingsSection;
};

export function parseRoute(hash: string): Route {
  const [path, query] = hash.replace(/^#\/?/, "").split("?");
  const [botId, conversation] = (path ?? "").split("/");
  if (!botId) return {};
  if (botId === "settings") {
    const section =
      SETTINGS_SECTIONS.find((item) => item === conversation) ??
      MOVED_SECTIONS.get(conversation ?? "");
    return section && section !== "general" ? { settings: true, section } : { settings: true };
  }
  const conversationId = conversation ? Number(conversation) : undefined;
  return conversationId !== undefined && Number.isInteger(conversationId) && conversationId >= 0
    ? {
        botId,
        conversationId,
        ...(new URLSearchParams(query).get("view") === "split"
          ? { threadView: "split" as const }
          : {}),
      }
    : { botId };
}

export function routeHref(route: Route): string {
  if (route.settings) {
    return route.section && route.section !== "general"
      ? `#/settings/${route.section}`
      : "#/settings";
  }
  if (!route.botId) return "#/";
  return route.conversationId === undefined
    ? `#/${route.botId}`
    : `#/${route.botId}/${route.conversationId}${route.threadView === "split" ? "?view=split" : ""}`;
}
