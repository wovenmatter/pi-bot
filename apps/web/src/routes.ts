/**
 * Hash routes: `#/` (no bot), `#/<botId>` (main), `#/<botId>/<conversationId>` (thread) and
 * `#/settings` (Settings, the only place deleted bots are listed and restored).
 */
export type Route = { botId?: string; conversationId?: number; settings?: true };

export function parseRoute(hash: string): Route {
  const [botId, conversation] = hash.replace(/^#\/?/, "").split("/");
  if (!botId) return {};
  if (botId === "settings") return { settings: true };
  const conversationId = conversation ? Number(conversation) : undefined;
  return conversationId !== undefined && Number.isInteger(conversationId) && conversationId >= 0
    ? { botId, conversationId }
    : { botId };
}

export function routeHref(route: Route): string {
  if (route.settings) return "#/settings";
  if (!route.botId) return "#/";
  return route.conversationId === undefined
    ? `#/${route.botId}`
    : `#/${route.botId}/${route.conversationId}`;
}
