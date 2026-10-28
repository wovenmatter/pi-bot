import { useCallback, useEffect, useMemo, useState } from "react";
import { type ConnectionState, defaultSocketUrl, errorMessage, PiBotClient } from "./api.ts";
import { Empty, ErrorNotice } from "./components/ui.tsx";
import { Conversation } from "./features/Conversation.tsx";
import type { BotSummary, ThreadSummary } from "./protocol.ts";
import { parseRoute, type Route, routeHref } from "./routes.ts";
import { Sidebar } from "./shell/Sidebar.tsx";
import { useTheme } from "./theme.ts";

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const update = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return route;
}

function navigate(route: Route) {
  window.location.hash = routeHref(route);
}

export function App() {
  const client = useMemo(() => new PiBotClient(defaultSocketUrl()), []);
  const [connection, setConnection] = useState<ConnectionState>(client.state);
  const [bots, setBots] = useState<BotSummary[]>();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [mainConversationId, setMainConversationId] = useState<number>();
  const [error, setError] = useState<string>();
  const [theme, setTheme] = useTheme();
  const route = useRoute();
  const bot = bots?.find((item) => item.id === route.botId);

  useEffect(() => {
    const stop = client.onState(setConnection);
    client.connect();
    return () => {
      stop();
      client.close();
    };
  }, [client]);

  useEffect(() => {
    if (connection !== "open") return;
    client
      .request("bots.list", {})
      .then(({ bots }) => setBots(bots))
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [client, connection]);

  // Default to the first bot; drop routes to bots that no longer exist.
  useEffect(() => {
    if (!bots) return;
    if (route.botId && !bots.some((item) => item.id === route.botId)) navigate({});
    else if (!route.botId && bots[0]) navigate({ botId: bots[0].id });
  }, [bots, route.botId]);

  const refreshThreads = useCallback(
    (botId: string) =>
      client
        .request("threads.list", { botId })
        .then(({ threads }) => setThreads(threads))
        .catch((e: unknown) => setError(errorMessage(e))),
    [client],
  );

  useEffect(() => {
    setThreads([]);
    setMainConversationId(undefined);
    if (connection === "open" && route.botId) void refreshThreads(route.botId);
  }, [connection, route.botId, refreshThreads]);

  async function createBot(name: string) {
    setError(undefined);
    try {
      const { bot: created } = await client.request("bots.create", { name });
      setBots((current) => [...(current ?? []), created]);
      navigate({ botId: created.id });
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function deleteBot(target: BotSummary) {
    if (!window.confirm(`Delete ${target.name} and all of its conversations?`)) return;
    setError(undefined);
    try {
      await client.request("bots.delete", { botId: target.id });
      setBots((current) => current?.filter((item) => item.id !== target.id));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const onForked = useCallback(
    (thread: ThreadSummary) => {
      setThreads((current) => [...current, thread]);
      if (route.botId) navigate({ botId: route.botId, conversationId: thread.conversationId });
    },
    [route.botId],
  );

  return (
    <div className="app-shell">
      <div className="shell-body">
        <Sidebar
          bots={bots ?? []}
          botId={route.botId}
          conversationId={route.conversationId}
          mainConversationId={mainConversationId}
          connection={connection}
          theme={theme}
          onTheme={setTheme}
          onCreate={createBot}
          onDelete={(target) => void deleteBot(target)}
        />
        <main id="main" className="main-content conversation-page">
          <ErrorNotice message={error} onDismiss={() => setError(undefined)} />
          {bot ? (
            <Conversation
              key={bot.id}
              client={client}
              connected={connection === "open"}
              bot={bot}
              conversationId={route.conversationId}
              threads={threads}
              onMainConversation={setMainConversationId}
              onForked={onForked}
            />
          ) : bots ? (
            <Empty title="Create a bot">
              Each bot has one long-lived main conversation. Threads fork off any message.
            </Empty>
          ) : (
            <Empty title={connection === "open" ? "Loading bots…" : "Connecting to Pi Bot…"} />
          )}
        </main>
      </div>
    </div>
  );
}
