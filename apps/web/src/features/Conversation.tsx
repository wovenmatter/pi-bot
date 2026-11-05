import {
  ArrowDown,
  ArrowUp,
  GitBranch,
  MessageSquareReply,
  Mic,
  Plus,
  Square,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { errorMessage, type PiBotClient } from "../api.ts";
import { Icon } from "../components/Icon.tsx";
import { ModelStatusBanner } from "../components/ModelStatusBanner.tsx";
import { RichText } from "../components/RichText.tsx";
import { Empty, ErrorNotice, Loading, MessageError } from "../components/ui.tsx";
import type { BotSummary, DisplayEntry, ThreadSummary } from "../protocol.ts";
import { routeHref } from "../routes.ts";
import { type ConversationDrafts, useConversationDrafts } from "./conversation-drafts.ts";
import {
  applyStreamEvent,
  type ConversationState,
  emptyConversation,
  mergeEntries,
  threadLabel,
} from "./conversation-state.ts";
import { useDictation } from "./use-dictation.ts";

export function Conversation({
  client,
  connected,
  bot,
  conversationId,
  threads,
  onMainConversation,
  onForked,
  onRunEnd,
  headerActions,
  visible = true,
  drafts,
}: {
  client: PiBotClient;
  connected: boolean;
  bot: BotSummary;
  /** Undefined opens the bot's main conversation. */
  conversationId?: number;
  threads: ThreadSummary[];
  onMainConversation: (id: number) => void;
  onForked: (thread: ThreadSummary) => void;
  /** A reply finished: thread titles may have been generated meanwhile. */
  onRunEnd?: () => void;
  headerActions?: ReactNode;
  visible?: boolean;
  drafts?: ConversationDrafts;
}) {
  const runEnd = useRef(onRunEnd);
  runEnd.current = onRunEnd;
  const [state, setState] = useState<ConversationState>(emptyConversation);
  const [origin, setOrigin] = useState<DisplayEntry>();
  const [viewed, setViewed] = useState<number | undefined>(undefined);
  const [mainId, setMainId] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [{ text: draft, attachments }, setDraft, setAttachments, nextAttachmentId] =
    useConversationDrafts(drafts, conversationId);
  const editor = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [readingFiles, setReadingFiles] = useState(false);
  const dictation = useDictation(
    (text) => setDraft((value) => `${value}${value && !/\s$/.test(value) ? " " : ""}${text}`),
    setError,
  );

  // Like the native composer's click-away monitor, release focus on blank transcript clicks.
  useEffect(() => {
    const clickAway = (event: PointerEvent) => {
      const form = editor.current?.form;
      const active = document.activeElement;
      if (
        form &&
        event.target instanceof Node &&
        !form.contains(event.target) &&
        active instanceof HTMLElement &&
        form.contains(active)
      )
        active.blur();
    };
    document.addEventListener("pointerdown", clickAway);
    return () => document.removeEventListener("pointerdown", clickAway);
  }, []);

  // Resize on typing, dictation, clearing, and viewport changes, without a layout toggle.
  useLayoutEffect(() => {
    const element = editor.current;
    if (!element) return;
    const resize = () => {
      element.style.height = "0px";
      element.style.height = `${Math.min(element.scrollHeight, 154)}px`;
    };
    resize();
    const observer = new ResizeObserver(resize);
    const parent = element.parentElement;
    if (parent) observer.observe(parent, { box: "content-box" });
    return () => observer.disconnect();
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: draft changes require measuring the editor
  useLayoutEffect(() => {
    const element = editor.current;
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${Math.min(element.scrollHeight, 154)}px`;
  }, [draft]);

  async function attachFiles(files: File[]) {
    setReadingFiles(true);
    setError(undefined);
    try {
      const added: { id: number; name: string; text: string }[] = [];
      for (const file of files) {
        if (file.size > 80_000) throw new Error("Attach text files smaller than 80 KB.");
        if (
          !file.type.startsWith("text/") &&
          !/\.(txt|md|csv|json|log|xml|yaml|yml|ts|tsx|js|jsx|py|html|css|sh)$/i.test(file.name)
        ) {
          throw new Error(
            "Attachments currently support text, code, and CSV files. Images and binary documents are not supported yet.",
          );
        }
        const text = await file.text();
        if (text.includes("\0"))
          throw new Error("This file contains binary data. Choose a text file.");
        added.push({ id: nextAttachmentId(), name: file.name, text });
      }
      setAttachments((current) => [...current, ...added]);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setReadingFiles(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [following, setFollowing] = useState(true);
  const follow = useRef(true);
  const scroll = useRef<HTMLDivElement>(null);
  const savedScroll = useRef(0);
  useLayoutEffect(() => {
    if (visible && scroll.current)
      scroll.current.scrollTop = follow.current ? scroll.current.scrollHeight : savedScroll.current;
  }, [visible]);
  const pendingKey = useRef(0);
  /** Model-status notices the reader dismissed, by bot and change time. */
  const [dismissed, setDismissed] = useState<string>();
  const status = bot.modelStatus;
  const statusKey = status ? `${bot.id}:${status.kind}:${status.at}` : undefined;

  // Open (and re-open after a reconnect) the conversation; events stream until closed.
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    let opened: number | undefined;
    let subscriptionId: string | number | undefined;
    setLoading(true);
    setError(undefined);
    setState(emptyConversation);
    setOrigin(undefined);
    const stop = client.onEvent((message) => {
      if (cancelled || message.botId !== bot.id || message.conversationId !== opened) return;
      if (message.event.kind === "error") setError(message.event.message);
      if (message.event.kind === "run" && message.event.state === "end") runEnd.current?.();
      setState((current) => applyStreamEvent(current, message.event));
    });
    client
      .request("conversation.open", {
        botId: bot.id,
        ...(conversationId === undefined ? {} : { conversationId }),
      })
      .then((snapshot) => {
        opened = snapshot.conversationId;
        subscriptionId = snapshot.subscriptionId;
        if (cancelled) {
          void client
            .request("conversation.close", {
              botId: bot.id,
              conversationId: opened,
              subscriptionId,
            })
            .catch(() => undefined);
          return;
        }
        setOrigin(snapshot.threadOrigin);
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
          .request("conversation.close", { botId: bot.id, conversationId: opened, subscriptionId })
          .catch(() => undefined);
      }
    };
  }, [client, connected, bot.id, conversationId, onMainConversation]);

  // Keep the newest reply in view while the reader is at the bottom.
  useEffect(() => {
    const element = scroll.current;
    if (visible && element && follow.current) {
      const newThread =
        viewed !== undefined &&
        mainId !== undefined &&
        viewed !== mainId &&
        !state.entries.some((entry) => entry.conversationId === viewed) &&
        state.pending.length === 0 &&
        !state.running &&
        state.streaming === null;
      element.scrollTop = newThread ? 0 : element.scrollHeight;
    }
  }, [state, visible, viewed, mainId]);

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const draftText = draft.trim();
    const sentAttachments = attachments;
    const text = [
      draftText,
      ...attachments.map((file) => `Attached text file: ${file.name}\n\n${file.text}`),
    ]
      .filter(Boolean)
      .join("\n\n");
    if (!text || sending || readingFiles || dictation.listening || !ready || viewed === undefined)
      return;
    if (text.length > 100_000) {
      setError("Message and attachments must total fewer than 100,000 characters.");
      return;
    }
    setSending(true);
    setError(undefined);
    const key = ++pendingKey.current;
    setState((current) => ({ ...current, pending: [...current.pending, { key, text }] }));
    follow.current = true;
    setFollowing(true);
    try {
      await client.request("message.send", { botId: bot.id, conversationId: viewed, text });
      setDraft((current) => (current.trim() === draftText ? "" : current));
      setAttachments((current) => current.filter((file) => !sentAttachments.includes(file)));
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

  async function stop() {
    if (stopping || viewed === undefined) return;
    setStopping(true);
    setError(undefined);
    try {
      await stopReply(client, bot.id, viewed);
      // Queued follow-ups were dropped with the reply: they never become entries.
      setState((current) => ({ ...current, pending: [] }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStopping(false);
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
  // Threads hang off the message they were forked from, like replies, under their generated
  // (read-only) titles.
  const repliesTo = (entry: DisplayEntry) =>
    threads.filter(
      (item) =>
        (item.parentConversationId === viewed ||
          item.parentConversationId === entry.conversationId) &&
        item.forkedAt === entry.id &&
        item.conversationId !== viewed,
    );
  const entries = isThread
    ? state.entries.filter((entry) => entry.conversationId === viewed)
    : state.entries;
  const startingMessage =
    origin ?? (thread ? state.entries.find((entry) => entry.id === thread.forkedAt) : undefined);
  const ready =
    connected &&
    !loading &&
    viewed !== undefined &&
    (conversationId === undefined ? viewed === mainId : viewed === conversationId);

  return (
    <div className="conversation-layout">
      <div className="conversation-main">
        <header className="thread-header">
          <h2 className={isThread && !thread?.title ? "untitled" : undefined}>
            {isThread ? threadLabel(thread) : bot.name}
          </h2>
          {isThread ? (
            <span className="thread-subtitle">{fromThread ? "in a thread" : `in ${bot.name}`}</span>
          ) : null}
          <div className="thread-header-actions">
            <span className="thread-subtitle" title="Profile">
              {bot.profileName}
            </span>
            {headerActions}
          </div>
        </header>
        <ModelStatusBanner
          status={statusKey !== undefined && statusKey !== dismissed ? status : undefined}
          botName={bot.name}
          onDismiss={() => setDismissed(statusKey)}
        />
        <ErrorNotice message={error} onDismiss={() => setError(undefined)} />
        <div
          className="transcript"
          ref={scroll}
          onScroll={() => {
            const element = scroll.current;
            if (!element || !visible) return;
            savedScroll.current = element.scrollTop;
            follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 90;
            setFollowing(follow.current);
          }}
        >
          {isThread && startingMessage ? (
            <div className="thread-origin">
              <div className="thread-origin-label">Started from</div>
              <Message entry={startingMessage} botName={bot.name} replies={[]} botId={bot.id} />
            </div>
          ) : null}
          {loading && entries.length === 0 ? (
            <Loading />
          ) : entries.length === 0 && state.pending.length === 0 && !state.running ? (
            <Empty title={isThread ? "New thread" : `Say hello to ${bot.name}`}>
              {isThread
                ? "It picks up from the message you chose."
                : "This is its main conversation. Start a thread from any message."}
            </Empty>
          ) : (
            <>
              {entries.map((entry) => (
                <Message
                  key={entry.id}
                  entry={entry}
                  botName={bot.name}
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
                <article className="message message-assistant" aria-busy="true">
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
          <form
            onSubmit={(event) => void send(event)}
            onPointerDown={(event) => {
              if (
                event.target instanceof Element &&
                !event.target.closest("button, input, textarea, a")
              ) {
                event.preventDefault();
                editor.current?.focus();
              }
            }}
          >
            {attachments.length ? (
              <div className="composer-attachments">
                {attachments.map((file) => (
                  <span className="composer-attachment" key={file.id}>
                    <span>{file.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${file.name}`}
                      onClick={() =>
                        setAttachments((current) => current.filter((item) => item.id !== file.id))
                      }
                    >
                      <Icon icon={X} size={12} />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <div className="composer-row">
              <input
                ref={fileInput}
                type="file"
                hidden
                multiple
                accept="text/*,.md,.csv,.json,.log,.xml,.yaml,.yml,.ts,.tsx,.js,.jsx,.py,.html,.css,.sh"
                onChange={(event) => void attachFiles(Array.from(event.target.files ?? []))}
              />
              <button
                type="button"
                className="composer-icon"
                aria-label="Attach files"
                title="Attach text or code files"
                disabled={!ready || readingFiles || sending}
                onClick={() => fileInput.current?.click()}
              >
                <Icon icon={Plus} size={18} weight="control" />
              </button>
              <textarea
                ref={editor}
                aria-label={isThread ? `Reply in ${threadLabel(thread)}` : `Message ${bot.name}`}
                rows={1}
                placeholder={
                  ready ? (isThread ? "Reply in thread…" : `Message ${bot.name}…`) : "Connecting…"
                }
                value={draft}
                maxLength={100000}
                disabled={!ready}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void send();
                  } else if (event.key === "Escape" && state.running) {
                    event.preventDefault();
                    void stop();
                  }
                }}
              />
              <div className="composer-controls">
                <button
                  type="button"
                  className={`composer-icon${dictation.listening ? " recording" : ""}`}
                  aria-label={dictation.listening ? "Stop dictation" : "Start dictation"}
                  aria-pressed={dictation.listening}
                  title={
                    dictation.supported
                      ? "Dictate a message"
                      : "Dictation is unavailable in this browser; use your device’s keyboard dictation"
                  }
                  disabled={!ready || !dictation.supported || sending}
                  onClick={dictation.toggle}
                >
                  <Icon icon={Mic} size={18} weight="control" />
                </button>
                <ComposerActions
                  running={state.running}
                  stopping={stopping}
                  canSend={
                    ready &&
                    !sending &&
                    !readingFiles &&
                    !dictation.listening &&
                    (draft.trim() !== "" || attachments.length > 0)
                  }
                  canStop={ready}
                  onStop={() => void stop()}
                />
              </div>
            </div>
          </form>
          <div className="composer-status" role="status" aria-live="polite">
            {dictation.listening
              ? "Listening…"
              : readingFiles
                ? "Reading files…"
                : state.running
                  ? `${bot.name} is replying…`
                  : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Ask the server to stop the conversation's running reply (and drop its queued follow-ups). */
export function stopReply(
  client: Pick<PiBotClient, "request">,
  botId: string,
  conversationId: number,
) {
  return client.request("conversation.abort", { botId, conversationId });
}

/** One trailing action: Stop while replying, or Send when a draft is ready. */
export function ComposerActions({
  running,
  stopping,
  canSend,
  canStop,
  onStop,
}: {
  running: boolean;
  stopping: boolean;
  canSend: boolean;
  canStop: boolean;
  onStop: () => void;
}) {
  return (
    <div className="composer-send-actions">
      {running && !canSend ? (
        <button
          type="button"
          className="stop-button"
          aria-label="Stop reply"
          title="Stop reply (Esc)"
          disabled={!canStop || stopping}
          onClick={onStop}
        >
          <Icon icon={Square} size={12} weight="send" />
        </button>
      ) : (
        <button type="submit" className="send-button" aria-label="Send message" disabled={!canSend}>
          <Icon icon={ArrowUp} size={16} weight="send" />
        </button>
      )}
    </div>
  );
}

function Message({
  entry,
  botName,
  replies,
  botId,
  onFork,
}: {
  entry: DisplayEntry;
  botName: string;
  replies: ThreadSummary[];
  botId: string;
  onFork?: () => void;
}) {
  return (
    <article className={`message message-${entry.role}`}>
      {entry.role === "assistant" ? (
        <div className="message-meta">
          <strong>{botName}</strong>
        </div>
      ) : null}
      {entry.text ? (
        <div className="message-content">
          {entry.role === "assistant" ? <RichText>{entry.text}</RichText> : entry.text}
        </div>
      ) : null}
      {entry.stopped ? <small className="muted">Stopped</small> : null}
      {entry.error ? <MessageError message={entry.error} /> : null}
      {replies.length > 0 ? (
        <div className="thread-replies">
          {replies.map((reply) => (
            <a
              key={reply.conversationId}
              className={`thread-reply-link${reply.title ? "" : " untitled"}`}
              href={routeHref({
                botId,
                conversationId: reply.conversationId,
                threadView: "split",
              })}
            >
              <Icon icon={MessageSquareReply} size={12} weight="control" />
              <span>{threadLabel(reply)}</span>
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
  );
}
