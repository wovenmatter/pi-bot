import { Bot } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type ConnectionState, defaultSocketUrl, errorMessage, PiBotClient } from "./api.ts";
import { Empty, ErrorNotice } from "./components/ui.tsx";
import { Conversation } from "./features/Conversation.tsx";
import { Onboarding } from "./features/Onboarding.tsx";
import { Settings } from "./features/Settings.tsx";
import type { BotSummary, OnboardingStatus, ThreadSummary } from "./protocol.ts";
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
  const [onboarding, setOnboarding] = useState<OnboardingStatus>();
  const [theme, setTheme] = useTheme();
  const route = useRoute();
  const bot = bots?.find((item) => item.id === route.botId);
  const onboardingNeeded = onboarding?.needed === true && !route.settings;

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
    const load = () =>
      client
        .request("bots.list", {})
        .then(({ bots }) => setBots(bots))
        .catch((e: unknown) => setError(errorMessage(e)));
    void load();
    client
      .request("onboarding.status", {})
      .then(setOnboarding)
      .catch((e: unknown) => setError(errorMessage(e)));
    // Bots create bots and change teams: refetch when the server says so.
    return client.onBotsChanged(() => void load());
  }, [client, connection]);

  // Default to Admin Bot; drop routes to bots that no longer exist.
  useEffect(() => {
    if (!bots || route.settings) return;
    const fallback = bots.find((item) => item.kind === "admin") ?? bots[0];
    if (route.botId && !bots.some((item) => item.id === route.botId)) navigate({});
    else if (!route.botId && fallback) navigate({ botId: fallback.id });
  }, [bots, route.botId, route.settings]);

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

  // Opening a thread picks up titles generated since the list was loaded.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on each thread switch
  useEffect(() => {
    if (connection === "open" && route.botId && route.conversationId !== undefined) {
      void refreshThreads(route.botId);
    }
  }, [route.conversationId]);

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
    if (!window.confirm(`Delete ${target.name}? You can restore it from Settings.`)) return;
    setError(undefined);
    try {
      await client.request("bots.delete", { botId: target.id });
      setBots((current) => current?.filter((item) => item.id !== target.id));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const onRestored = useCallback((restored: BotSummary) => {
    setBots((current) =>
      [...(current ?? []).filter((item) => item.id !== restored.id), restored].sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      ),
    );
  }, []);

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
          threads={threads}
          settings={route.settings}
          connection={connection}
          theme={theme}
          onTheme={setTheme}
          onCreate={createBot}
          onDelete={(target) => void deleteBot(target)}
        />
        <main
          id="main"
          className={
            route.settings || onboardingNeeded ? "main-content" : "main-content conversation-page"
          }
        >
          <ErrorNotice message={error} onDismiss={() => setError(undefined)} />
          {onboarding && onboardingNeeded ? (
            <Onboarding
              client={client}
              connected={connection === "open"}
              status={onboarding}
              onStatus={(status) => {
                setOnboarding(status);
                if (!status.needed) navigate({ botId: status.adminId });
              }}
            />
          ) : route.settings ? (
            <Settings
              client={client}
              connected={connection === "open"}
              section={route.section ?? "accounts"}
              onRestored={onRestored}
            />
          ) : bot ? (
            <Conversation
              key={bot.id}
              client={client}
              connected={connection === "open"}
              bot={bot}
              conversationId={route.conversationId}
              threads={threads}
              onMainConversation={setMainConversationId}
              onForked={onForked}
              onRunEnd={() => void refreshThreads(bot.id)}
            />
          ) : bots ? (
            <Empty icon={Bot} title="Create a bot">
              Use the + in the sidebar. Each bot has one main conversation; threads fork off any
              message.
            </Empty>
          ) : (
            <Empty title={connection === "open" ? "Loading bots…" : "Connecting to Pi Bot…"} />
          )}
        </main>
      </div>
    </div>
  );
}
