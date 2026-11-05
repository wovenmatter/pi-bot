import { Columns2, Maximize2, X } from "lucide-react";
import { type CSSProperties, type PointerEvent, useLayoutEffect, useRef, useState } from "react";
import type { PiBotClient } from "../api.ts";
import { Icon } from "../components/Icon.tsx";
import type { BotSummary, ThreadSummary } from "../protocol.ts";
import { routeHref } from "../routes.ts";
import { Conversation } from "./Conversation.tsx";
import { ConversationDrafts } from "./conversation-drafts.ts";

export function ConversationWorkspace({
  client,
  drafts: sharedDrafts,
  connected,
  bot,
  conversationId,
  threadView,
  threads,
  onMainConversation,
  onForked,
}: {
  client: PiBotClient;
  drafts?: ConversationDrafts;
  connected: boolean;
  bot: BotSummary;
  conversationId?: number;
  threadView?: "split";
  threads: ThreadSummary[];
  onMainConversation: (id: number) => void;
  onForked: (thread: ThreadSummary) => void;
}) {
  const workspace = useRef<HTMLDivElement>(null);
  const [drafts] = useState(() => sharedDrafts ?? new ConversationDrafts());
  const [availableWidth, setAvailableWidth] = useState(0);
  const wide = availableWidth >= 760;
  const [width, setWidth] = useState(440);
  const [mainId, setMainId] = useState<number>();
  const mainCallback = useRef(onMainConversation);
  mainCallback.current = onMainConversation;
  // Stable callback: toggling a layout must never re-open either stream.
  const [onMain] = useState(() => (id: number) => {
    setMainId(id);
    mainCallback.current(id);
  });
  useLayoutEffect(() => {
    const element = workspace.current;
    if (!element) return;
    const measure = () => setAvailableWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const isThread = conversationId !== undefined && conversationId !== mainId;
  const split = isThread && threadView === "split" && wide;
  const route = { botId: bot.id, conversationId };

  function resize(event: PointerEvent<HTMLElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  function move(event: PointerEvent<HTMLElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId) || !workspace.current) return;
    const bounds = workspace.current.getBoundingClientRect();
    setWidth(Math.max(340, Math.min(bounds.width - 360, bounds.right - event.clientX)));
  }
  return (
    <div
      ref={workspace}
      className={`conversation-workspace${split ? " split" : ""}`}
      style={{ "--thread-width": `${width}px` } as CSSProperties}
    >
      <section
        className="conversation-pane main-pane"
        aria-label="Main chat"
        hidden={isThread && !split}
      >
        <Conversation
          client={client}
          drafts={drafts}
          connected={connected}
          bot={bot}
          threads={threads}
          onMainConversation={onMain}
          onForked={onForked}
          visible={!isThread || split}
        />
      </section>
      {isThread && mainId !== undefined ? (
        <>
          <hr
            className="thread-resizer"
            aria-label="Resize thread pane"
            aria-orientation="vertical"
            aria-valuenow={Math.round(Math.min(width, Math.max(340, availableWidth - 360)))}
            aria-valuemin={340}
            aria-valuemax={Math.max(340, availableWidth - 360)}
            tabIndex={split ? 0 : -1}
            hidden={!split}
            onPointerDown={resize}
            onPointerMove={move}
            onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                setWidth((value) =>
                  Math.max(
                    340,
                    Math.min(
                      (workspace.current?.clientWidth ?? 800) - 360,
                      value + (event.key === "ArrowLeft" ? 24 : -24),
                    ),
                  ),
                );
              }
            }}
          />
          <section className="conversation-pane thread-pane" aria-label="Thread">
            <Conversation
              key={conversationId}
              client={client}
              drafts={drafts}
              connected={connected}
              bot={bot}
              conversationId={conversationId}
              threads={threads}
              onMainConversation={onMain}
              onForked={onForked}
              headerActions={
                <>
                  {wide ? (
                    <a
                      className="icon-button"
                      href={routeHref({
                        ...route,
                        ...(split ? {} : { threadView: "split" as const }),
                      })}
                      aria-label={split ? "Expand thread" : "Show thread beside Main"}
                      title={split ? "Expand thread" : "Show beside Main"}
                    >
                      <Icon icon={split ? Maximize2 : Columns2} size={14} weight="control" />
                    </a>
                  ) : null}
                  <a
                    className="icon-button"
                    href={routeHref({ botId: bot.id })}
                    aria-label="Close thread"
                    title="Back to Main"
                  >
                    <Icon icon={X} size={14} weight="control" />
                  </a>
                </>
              }
            />
          </section>
        </>
      ) : null}
    </div>
  );
}
