import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ConnectionState, defaultSocketUrl, errorMessage, PiBotClient } from "./api.ts";
import { Empty, ErrorNotice } from "./components/ui.tsx";
import { ConversationWorkspace } from "./features/ConversationWorkspace.tsx";
import { ConversationDrafts } from "./features/conversation-drafts.ts";
import { sortThreads } from "./features/conversation-state.ts";
import { Onboarding } from "./features/Onboarding.tsx";
import { Settings } from "./features/Settings.tsx";
import { installHostBridge, isWovenHost, postHost } from "./host.ts";
import type { BotSummary, OnboardingStatus, ThreadSummary } from "./protocol.ts";
import { parseRoute, type Route, routeHref } from "./routes.ts";
import { Sidebar } from "./shell/Sidebar.tsx";
import { SidebarToggle, useSidebarCollapsed } from "./shell/SidebarToggle.tsx";
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
  const host = isWovenHost();
  const [drafts] = useState(() => new ConversationDrafts());
  const [sidebarCollapsed, toggleSidebar] = useSidebarCollapsed();
  const client = useMemo(() => new PiBotClient(defaultSocketUrl()), []);
  const [connection, setConnection] = useState<ConnectionState>(client.state);
  const [bots, setBots] = useState<BotSummary[]>();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [mainConversationId, setMainConversationId] = useState<number>();
  const [error, setError] = useState<string>();
  const [onboarding, setOnboarding] = useState<OnboardingStatus>();
  const [theme, setTheme] = useTheme();
  const route = useRoute();
  const selectedBot = useRef(route.botId);
  selectedBot.current = route.botId;
  const bot = bots?.find((item) => item.id === route.botId);
  const onboardingNeeded = onboarding?.needed === true && !route.settings;

  useEffect(() => installHostBridge(setTheme), [setTheme]);
  useEffect(() => {
    postHost({ kind: "connection", state: connection });
  }, [connection]);
  useEffect(() => {
    postHost({ kind: "route", hash: window.location.hash, ...route });
  }, [route]);

  useEffect(() => {
    const stopHello = client.onHello((hello) => {
      if (hello.protocol && hello.installationId)
        postHost({ kind: "ready", protocol: hello.protocol, installationId: hello.installationId });
    });
    const stop = client.onState(setConnection);
    client.connect();
    return () => {
      stop();
      stopHello();
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

  useEffect(() => {
    if (connection !== "open" || route.settings) return;
    let cancelled = false;
    void client
      .request("onboarding.status", {})
      .then((status) => {
        if (!cancelled) setOnboarding(status);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [client, connection, route.settings]);

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
        .then(({ threads }) => {
          if (selectedBot.current === botId) setThreads(threads);
        })
        .catch((e: unknown) => setError(errorMessage(e))),
    [client],
  );

  useEffect(() => {
    setThreads([]);
    setMainConversationId(undefined);
    if (connection === "open" && route.botId) void refreshThreads(route.botId);
  }, [connection, route.botId, refreshThreads]);

  // A title was generated: refresh the sidebar, thread header and reply links for this bot.
  useEffect(() => {
    const botId = route.botId;
    if (connection !== "open" || !botId) return;
    return client.onThreadsChanged((changed) => {
      if (changed === botId) void refreshThreads(botId);
    });
  }, [client, connection, route.botId, refreshThreads]);

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
      setBots((current) => [...(current ?? []).filter((bot) => bot.id !== created.id), created]);
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
      setThreads((current) =>
        sortThreads([
          ...current.filter((item) => item.conversationId !== thread.conversationId),
          thread,
        ]),
      );
      if (route.botId)
        navigate({
          botId: route.botId,
          conversationId: thread.conversationId,
          threadView: "split",
        });
    },
    [route.botId],
  );

  async function pinThread(thread: ThreadSummary, pinned: boolean) {
    const botId = route.botId;
    if (!botId) return;
    try {
      await client.request("thread.setPinned", {
        botId,
        conversationId: thread.conversationId,
        pinned,
      });
      await refreshThreads(botId);
    } catch (error) {
      setError(errorMessage(error));
    }
  }

  return (
    <div className="app-shell">
      <div
        className={`shell-body${host ? " woven-host" : sidebarCollapsed ? " sidebar-collapsed" : ""}`}
      >
        {host ? null : (
          <>
            <SidebarToggle collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
            <Sidebar
              collapsed={sidebarCollapsed}
              bots={bots ?? []}
              botId={route.botId}
              conversationId={route.conversationId}
              mainConversationId={mainConversationId}
              threads={threads}
              settings={route.settings}
              connection={connection}
              onCreate={createBot}
              onDelete={(target) => void deleteBot(target)}
              onPin={pinThread}
            />
          </>
        )}
        <main
          id="main"
          className={
            route.settings || onboardingNeeded ? "main-content" : "main-content conversation-page"
          }
        >
          <ErrorNotice message={error} onDismiss={() => setError(undefined)} />
          {onboarding && onboardingNeeded ? (
            <Onboarding
              host={host}
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
              host={host}
              section={route.section ?? "general"}
              theme={theme}
              onTheme={setTheme}
              onRestored={onRestored}
            />
          ) : bot ? (
            <ConversationWorkspace
              key={bot.id}
              drafts={drafts}
              client={client}
              connected={connection === "open"}
              bot={bot}
              conversationId={route.conversationId}
              threadView={route.threadView}
              threads={threads}
              onMainConversation={setMainConversationId}
              onForked={onForked}
            />
          ) : bots ? (
            <Empty title="Create a bot">
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
