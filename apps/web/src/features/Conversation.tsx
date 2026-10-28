import { ArrowDown, ArrowUp, CornerUpLeft, GitBranch, MessageSquareReply } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { errorMessage, type PiBotClient } from "../api.ts";
import { Icon } from "../components/Icon.tsx";
import { RichText } from "../components/RichText.tsx";
import { Empty, ErrorNotice, Loading } from "../components/ui.tsx";
import type { BotSummary, DisplayEntry, ThreadSummary } from "../protocol.ts";
import { routeHref } from "../routes.ts";
import {
  applyStreamEvent,
  type ConversationState,
  emptyConversation,
  mergeEntries,
} from "./conversation-state.ts";

export function Conversation({
  client,
  connected,
  bot,
  conversationId,
  threads,
  onMainConversation,
  onForked,
}: {
  client: PiBotClient;
  connected: boolean;
  bot: BotSummary;
  /** Undefined opens the bot's main conversation. */
  conversationId?: number;
  threads: ThreadSummary[];
  onMainConversation: (id: number) => void;
  onForked: (thread: ThreadSummary) => void;
}) {
  const [state, setState] = useState<ConversationState>(emptyConversation);
  const [viewed, setViewed] = useState<number | undefined>(undefined);
  const [mainId, setMainId] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [following, setFollowing] = useState(true);
  const follow = useRef(true);
  const scroll = useRef<HTMLDivElement>(null);
  const pendingKey = useRef(0);

  // Open (and re-open after a reconnect) the conversation; events stream until closed.
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    let opened: number | undefined;
    setLoading(true);
    setError(undefined);
    setState(emptyConversation);
    const stop = client.onEvent((message) => {
      if (cancelled || message.botId !== bot.id || message.conversationId !== opened) return;
      if (message.event.kind === "error") setError(message.event.message);
      setState((current) => applyStreamEvent(current, message.event));
    });
    client
      .request("conversation.open", {
        botId: bot.id,
        ...(conversationId === undefined ? {} : { conversationId }),
      })
      .then((snapshot) => {
        if (cancelled) return;
        opened = snapshot.conversationId;
        setViewed(snapshot.conversationId);
        setMainId(snapshot.mainConversationId);
        onMainConversation(snapshot.mainConversationId);
        setState((current) => ({
          ...current,
          entries: mergeEntries(snapshot.entries, current.entries),
          running: snapshot.running || current.running,
          streaming: current.streaming ?? snapshot.streaming ?? null,
        }));
        follow.current = true;
        setFollowing(true);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      stop();
      if (opened !== undefined && client.state === "open") {
        void client
          .request("conversation.close", { botId: bot.id, conversationId: opened })
          .catch(() => undefined);
      }
    };
  }, [client, connected, bot.id, conversationId, onMainConversation]);

  // Keep the newest reply in view while the reader is at the bottom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run whenever content grows
  useEffect(() => {
    const element = scroll.current;
    if (element && follow.current) element.scrollTop = element.scrollHeight;
  }, [state]);

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || sending || viewed === undefined) return;
    setSending(true);
    setError(undefined);
    const key = ++pendingKey.current;
    setState((current) => ({ ...current, pending: [...current.pending, { key, text }] }));
    follow.current = true;
    setFollowing(true);
    try {
      await client.request("message.send", { botId: bot.id, conversationId: viewed, text });
      setDraft("");
    } catch (e) {
      setState((current) => ({
        ...current,
        pending: current.pending.filter((item) => item.key !== key),
      }));
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  }

  async function fork(entry: DisplayEntry) {
    if (viewed === undefined) return;
    setError(undefined);
    try {
      const { thread } = await client.request("thread.fork", {
        botId: bot.id,
        conversationId: viewed,
        entryId: entry.id,
      });
      onForked(thread);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const isThread = viewed !== undefined && mainId !== undefined && viewed !== mainId;
  const thread = threads.find((item) => item.conversationId === viewed);
  const fromThread = thread !== undefined && thread.parentConversationId !== mainId;
  // Threads hang off the message they were forked from, like replies; they have no names.
  const repliesTo = (entry: DisplayEntry) =>
    threads.filter(
      (item) =>
        item.parentConversationId === entry.conversationId &&
        item.forkedAt === entry.id &&
        item.conversationId !== viewed,
    );
  let lastInherited = -1;
  if (isThread) {
    state.entries.forEach((entry, index) => {
      if (entry.conversationId !== viewed) lastInherited = index;
    });
  }
  const ready = connected && viewed !== undefined;

  return (
    <div className="conversation-layout">
      <div className="conversation-main">
        <header className="thread-header">
          <h2>{isThread ? "Thread" : bot.name}</h2>
          {isThread ? (
            <span className="thread-subtitle">
              {fromThread ? "reply in a thread" : `reply in ${bot.name}`}
            </span>
          ) : null}
          <div className="thread-header-actions">
            {isThread ? (
              <a className="text-button" href={routeHref({ botId: bot.id })}>
                <Icon icon={CornerUpLeft} size={13} weight="control" />
                Main
              </a>
            ) : null}
          </div>
        </header>
        <ErrorNotice message={error} onDismiss={() => setError(undefined)} />
        <div
          className="transcript"
          ref={scroll}
          onScroll={() => {
            const element = scroll.current;
            if (!element) return;
            follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 90;
            setFollowing(follow.current);
          }}
        >
          {loading && state.entries.length === 0 ? (
            <Loading />
          ) : state.entries.length === 0 && state.pending.length === 0 && !state.running ? (
            <Empty title={isThread ? "New thread" : `Talk to ${bot.name}`}>
              {isThread
                ? "This thread continues from the message you picked."
                : "This is the bot's main conversation. Start a thread from any message."}
            </Empty>
          ) : (
            <>
              {state.entries.map((entry, index) => (
                <Message
                  key={entry.id}
                  entry={entry}
                  botName={bot.name}
                  inherited={index <= lastInherited}
                  divider={index === lastInherited}
                  replies={repliesTo(entry)}
                  botId={bot.id}
                  onFork={ready ? () => void fork(entry) : undefined}
                />
              ))}
              {state.pending.map((item) => (
                <article key={`pending-${item.key}`} className="message message-user pending">
                  <div className="message-content">{item.text}</div>
                </article>
              ))}
              {state.streaming !== null || state.running ? (
                <article className="message message-assistant" aria-live="polite">
                  <div className="message-meta">
                    <strong>{bot.name}</strong>
                  </div>
                  <div className="message-content">
                    {state.streaming ? (
                      <RichText>{state.streaming}</RichText>
                    ) : (
                      <Loading label="Thinking…" />
                    )}
                  </div>
                </article>
              ) : null}
            </>
          )}
        </div>
        <div className="composer-area">
          {!following ? (
            <button
              type="button"
              className="secondary latest-reply"
              onClick={() => {
                follow.current = true;
                setFollowing(true);
                if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
              }}
            >
              <Icon icon={ArrowDown} size={12} weight="send" />
              Latest reply
            </button>
          ) : null}
          <form onSubmit={(event) => void send(event)}>
            <textarea
              aria-label={`Message ${bot.name}`}
              rows={3}
              placeholder={ready ? `Message ${bot.name}…` : "Connecting…"}
              value={draft}
              maxLength={100000}
              disabled={!ready}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <div className="composer-controls">
              <div className="composer-send-actions">
                <button
                  type="submit"
                  className="send-button"
                  aria-label="Send message"
                  disabled={!ready || sending || !draft.trim()}
                >
                  <Icon icon={ArrowUp} size={16} weight="send" />
                </button>
              </div>
            </div>
          </form>
          <div className="composer-status" role="status">
            {state.running ? `${bot.name} is replying…` : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function Message({
  entry,
  botName,
  inherited,
  divider,
  replies,
  botId,
  onFork,
}: {
  entry: DisplayEntry;
  botName: string;
  inherited: boolean;
  divider: boolean;
  replies: ThreadSummary[];
  botId: string;
  onFork?: () => void;
}) {
  return (
    <>
      <article className={`message message-${entry.role}${inherited ? " inherited" : ""}`}>
        {entry.role === "assistant" ? (
          <div className="message-meta">
            <strong>{botName}</strong>
          </div>
        ) : null}
        <div className="message-content">
          {entry.role === "assistant" ? <RichText>{entry.text}</RichText> : entry.text}
        </div>
        {entry.error ? <small className="danger">{entry.error}</small> : null}
        {replies.length > 0 ? (
          <div className="thread-replies">
            {replies.map((reply, index) => (
              <a
                key={reply.conversationId}
                className="thread-reply-link"
                href={routeHref({ botId, conversationId: reply.conversationId })}
              >
                <Icon icon={MessageSquareReply} size={12} weight="control" />
                <span>{replies.length === 1 ? "Thread" : `Thread ${index + 1}`}</span>
              </a>
            ))}
          </div>
        ) : null}
        {onFork ? (
          <div className="response-actions">
            <button type="button" className="utility-button" onClick={onFork}>
              <Icon icon={GitBranch} size={12} weight="control" />
              <span>Start thread</span>
            </button>
          </div>
        ) : null}
      </article>
      {divider ? <div className="fork-divider">Thread starts here</div> : null}
    </>
  );
}
