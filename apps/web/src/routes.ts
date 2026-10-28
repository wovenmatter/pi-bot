/** Hash routes: `#/` (no bot), `#/<botId>` (main) and `#/<botId>/<conversationId>` (thread). */
export type Route = { botId?: string; conversationId?: number };

export function parseRoute(hash: string): Route {
  const [botId, conversation] = hash.replace(/^#\/?/, "").split("/");
  if (!botId) return {};
  const conversationId = conversation ? Number(conversation) : undefined;
  return conversationId !== undefined && Number.isInteger(conversationId) && conversationId >= 0
    ? { botId, conversationId }
    : { botId };
}

export function routeHref(route: Route): string {
  if (!route.botId) return "#/";
  return route.conversationId === undefined
    ? `#/${route.botId}`
    : `#/${route.botId}/${route.conversationId}`;
}
