import type { ConnectionState } from "./api.ts";
import type { Route } from "./routes.ts";
import { isTheme, type Theme } from "./theme.ts";

type HostMessage =
  | { kind: "ready"; protocol: number; installationId: string }
  | ({ kind: "route"; hash: string; navigation: number } & Route)
  | { kind: "connection"; state: ConnectionState }
  | { kind: "openExternal"; url: string };
type HostBridge = {
  setTheme(theme: Theme): void;
  /** `token` tells the host which of its requests a later route report follows. */
  navigate(hashRoute: string, token?: number): void;
  setContext(context: string | null): void;
  focusComposer(): void;
  /** Room to leave in conversation headers for native controls floating over them. */
  setHeaderInsets(left: number, right: number): void;
};

declare global {
  interface Window {
    wovenPiBotHost?: HostBridge;
    webkit?: {
      messageHandlers?: { wovenBots?: { postMessage(message: HostMessage & { v: 1 }): void } };
    };
  }
}

let context: string | undefined;
let navigation = 0;
export function hostNavigation(): number {
  return navigation;
}
export function isWovenHost(): boolean {
  return (
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("host") === "woven"
  );
}
export function hostContext(): string | undefined {
  return isWovenHost() ? context : undefined;
}

export function postHost(message: HostMessage): void {
  if (isWovenHost()) window.webkit?.messageHandlers?.wovenBots?.postMessage({ v: 1, ...message });
}

export function installHostBridge(setTheme: (theme: Theme) => void): () => void {
  if (!isWovenHost()) return () => {};
  const bridge: HostBridge = {
    setTheme: (theme) => {
      if (isTheme(theme)) setTheme(theme);
    },
    navigate: (hash, token) => {
      if (typeof hash !== "string" || !hash.startsWith("#/")) return;
      if (Number.isSafeInteger(token)) navigation = token as number;
      window.location.hash = hash;
    },
    setContext: (value) => {
      if (value === null || (typeof value === "string" && value.length <= 4000))
        context = value ?? undefined;
    },
    setHeaderInsets: (left, right) => {
      const root = document.documentElement.style;
      root.setProperty("--woven-inset-left", `${Math.max(0, Math.min(left, 240))}px`);
      root.setProperty("--woven-inset-right", `${Math.max(0, Math.min(right, 240))}px`);
    },
    focusComposer: () => {
      const editors = [
        ...document.querySelectorAll<HTMLTextAreaElement>(".composer-area textarea"),
      ];
      editors
        .reverse()
        .find((editor) => !editor.disabled && editor.getClientRects().length > 0)
        ?.focus();
    },
  };
  window.wovenPiBotHost = bridge;
  return () => {
    if (window.wovenPiBotHost === bridge) delete window.wovenPiBotHost;
    context = undefined;
    navigation = 0;
  };
}

export function openHostExternal(url: string): boolean {
  if (!isWovenHost() || !/^(https?:|\/\/)/i.test(url)) return false;
  let target: URL;
  try {
    target = new URL(url, `${window.location.protocol}//${window.location.host}/`);
  } catch {
    return false;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return false;
  postHost({ kind: "openExternal", url: target.href });
  return true;
}
