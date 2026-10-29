import type { EventMessage, LoginEvent, Requests, ServerMessage } from "./protocol.ts";

export type ConnectionState = "connecting" | "open" | "closed";

type Pending = { resolve: (data: unknown) => void; reject: (error: Error) => void };

const REQUEST_TIMEOUT_MS = 30_000;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One WebSocket to the Pi Bot server, with request/response correlation and reconnects. */
export class PiBotClient {
  readonly #url: string;
  #socket: WebSocket | undefined;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #events = new Set<(message: EventMessage) => void>();
  #states = new Set<(state: ConnectionState) => void>();
  #botsChanged = new Set<() => void>();
  #state: ConnectionState = "closed";
  #attempt = 0;
  #reconnect: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;
  /** Set by `expectRestart`: retry every 500 ms until the server is back. */
  #restarting = false;
  #logins = new Map<string, (event: LoginEvent) => void>();
  /** Sign-in events that arrived before their `login.start` result. */
  #loginBacklog = new Map<string, LoginEvent[]>();

  constructor(url: string) {
    this.#url = url;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  connect(): void {
    this.#stopped = false;
    if (this.#socket) return;
    this.#setState("connecting");
    const socket = new WebSocket(this.#url);
    this.#socket = socket;
    socket.addEventListener("open", () => {
      this.#attempt = 0;
      this.#restarting = false;
      this.#setState("open");
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") this.#receive(event.data);
    });
    socket.addEventListener("close", () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      for (const pending of this.#pending.values()) pending.reject(new Error("Connection lost"));
      this.#pending.clear();
      this.#setState("closed");
      if (!this.#stopped) {
        const delay = this.#restarting ? 500 : Math.min(500 * 2 ** this.#attempt, 10_000);
        this.#attempt += 1;
        this.#reconnect = setTimeout(() => this.connect(), delay);
      }
    });
  }

  /** The server is restarting: reconnect quickly instead of backing off. */
  expectRestart(): void {
    this.#restarting = true;
    this.#attempt = 0;
  }

  close(): void {
    this.#stopped = true;
    clearTimeout(this.#reconnect);
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close();
    this.#setState("closed");
  }

  request<T extends keyof Requests>(
    type: T,
    body: Requests[T]["body"],
  ): Promise<Requests[T]["result"]> {
    const socket = this.#socket;
    if (!socket || this.#state !== "open") return Promise.reject(new Error("Not connected"));
    const id = this.#nextId++;
    return new Promise<Requests[T]["result"]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${type} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, {
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data as Requests[T]["result"]);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ ...body, id, type }));
    });
  }

  onEvent(listener: (message: EventMessage) => void): () => void {
    this.#events.add(listener);
    return () => this.#events.delete(listener);
  }

  /** Follow one sign-in; replays events that arrived before the listener. */
  onLogin(loginId: string, listener: (event: LoginEvent) => void): () => void {
    this.#logins.set(loginId, listener);
    const backlog = this.#loginBacklog.get(loginId) ?? [];
    this.#loginBacklog.delete(loginId);
    for (const event of backlog) listener(event);
    return () => {
      if (this.#logins.get(loginId) === listener) this.#logins.delete(loginId);
    };
  }

  /** The server's bot list changed (created by a bot, a team change, ...). */
  onBotsChanged(listener: () => void): () => void {
    this.#botsChanged.add(listener);
    return () => this.#botsChanged.delete(listener);
  }

  onState(listener: (state: ConnectionState) => void): () => void {
    this.#states.add(listener);
    return () => this.#states.delete(listener);
  }

  #setState(state: ConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of this.#states) listener(state);
  }

  #receive(raw: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    if (message.type === "login") {
      const listener = this.#logins.get(message.loginId);
      if (listener) listener(message.event);
      else {
        const backlog = this.#loginBacklog.get(message.loginId) ?? [];
        backlog.push(message.event);
        this.#loginBacklog.set(message.loginId, backlog);
        // Bound memory if a client never subscribes.
        if (this.#loginBacklog.size > 20) {
          const oldest = this.#loginBacklog.keys().next().value;
          if (oldest !== undefined) this.#loginBacklog.delete(oldest);
        }
      }
      return;
    }
    if (message.type === "event") {
      for (const listener of this.#events) listener(message);
      return;
    }
    if (message.type === "bots.changed") {
      for (const listener of this.#botsChanged) listener();
      return;
    }
    if (message.type === "result" || message.type === "error") {
      const id = typeof message.id === "number" ? message.id : Number(message.id);
      const pending = this.#pending.get(id);
      if (!pending) {
        if (message.type === "error") console.error(`pi-bot: ${message.message}`);
        return;
      }
      this.#pending.delete(id);
      if (message.type === "result") pending.resolve(message.data);
      else pending.reject(new Error(message.message));
    }
  }
}

export function defaultSocketUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/ws`;
}
