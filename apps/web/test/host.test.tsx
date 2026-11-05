import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { PiBotClient } from "../src/api.ts";
import { ConversationDrafts, draftKey } from "../src/features/conversation-drafts.ts";
import { Settings } from "../src/features/Settings.tsx";
import { hostContext, installHostBridge, openHostExternal, postHost } from "../src/host.ts";
import { storedTheme } from "../src/theme.ts";

function browser(search = "", hash = "#/settings") {
  const localStorage = { getItem: vi.fn(() => "cognac"), setItem: vi.fn() };
  const postMessage = vi.fn();
  vi.stubGlobal("window", {
    location: { search, hash, protocol: "http:", host: "localhost" },
    localStorage,
    webkit: { messageHandlers: { wovenBots: { postMessage } } },
  });
  vi.stubGlobal("localStorage", localStorage);
  return { localStorage, postMessage };
}
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Woven host mode", () => {
  it("hides the sidebar, toggle and brand while standalone retains them", () => {
    browser("?host=woven&theme=dark");
    const host = renderToStaticMarkup(<App />);
    expect(host).toContain("woven-host");
    expect(host).not.toContain('id="app-sidebar"');
    expect(host).not.toContain("sidebar-toggle");
    expect(host).not.toContain("brand");
    expect(host).not.toContain("settings-tabs");
    expect(host).not.toContain('aria-label="Theme"');
    expect(host).toContain("Development build");
    browser();
    const standalone = renderToStaticMarkup(<App />);
    expect(standalone).toContain('id="app-sidebar"');
    expect(standalone).toContain("sidebar-toggle");
    expect(standalone).toContain("brand");
    expect(standalone).toContain("settings-tabs");
    expect(standalone).toContain('aria-label="Theme"');
  });

  it("renders exactly the selected settings section in host mode", () => {
    browser("?host=woven");
    const html = renderToStaticMarkup(
      <Settings
        host
        client={new PiBotClient("ws://localhost/ws")}
        connected={false}
        section="config"
        theme="green"
        onTheme={() => {}}
        onRestored={() => {}}
      />,
    );
    expect(html).toContain("Restart Pi Bot");
    expect(html).not.toContain("Settings sections");
    expect(html).not.toContain("Plans and budget");
    expect(html).not.toContain('aria-label="Theme"');
  });

  it("uses the host theme without reading localStorage", () => {
    const { localStorage } = browser("?host=woven&theme=dark");
    expect(storedTheme()).toBe("dark");
    expect(localStorage.getItem).not.toHaveBeenCalled();
    browser();
    expect(storedTheme()).toBe("cognac");
  });

  it("installs bounded context, navigation, theme and visible-composer hooks; posts versioned messages safely", () => {
    const { postMessage } = browser("?host=woven");
    const theme = vi.fn();
    const hidden = { disabled: false, getClientRects: () => [], focus: vi.fn() };
    const visible = { disabled: false, getClientRects: () => [{}], focus: vi.fn() };
    vi.stubGlobal("document", { querySelectorAll: () => [visible, hidden] });
    const stop = installHostBridge(theme);
    const host = window.wovenPiBotHost;
    expect(host).toBeDefined();
    host?.setTheme("dark");
    expect(theme).toHaveBeenCalledWith("dark");
    host?.navigate("#/settings/accounts");
    expect(window.location.hash).toBe("#/settings/accounts");
    host?.navigate("https://example.com");
    expect(window.location.hash).toBe("#/settings/accounts");
    host?.setContext("selected file");
    expect(hostContext()).toBe("selected file");
    host?.setContext("x".repeat(4001));
    expect(hostContext()).toBe("selected file");
    host?.setContext(null);
    expect(hostContext()).toBeUndefined();
    host?.focusComposer();
    expect(visible.focus).toHaveBeenCalledOnce();
    expect(hidden.focus).not.toHaveBeenCalled();
    expect(openHostExternal("https://example.com/report")).toBe(true);
    expect(postMessage).toHaveBeenLastCalledWith({
      v: 1,
      kind: "openExternal",
      url: "https://example.com/report",
    });
    expect(openHostExternal("//example.com/protocol-relative")).toBe(true);
    expect(postMessage).toHaveBeenLastCalledWith({
      v: 1,
      kind: "openExternal",
      url: "http://example.com/protocol-relative",
    });
    expect(openHostExternal("#/settings")).toBe(false);
    postHost({ kind: "ready", protocol: 1, installationId: "fixture-installation" });
    expect(postMessage).toHaveBeenLastCalledWith({
      v: 1,
      kind: "ready",
      protocol: 1,
      installationId: "fixture-installation",
    });
    delete window.webkit;
    expect(() => postHost({ kind: "connection", state: "closed" })).not.toThrow();
    stop();
    expect(window.wovenPiBotHost).toBeUndefined();
    browser();
    installHostBridge(theme);
    expect(window.wovenPiBotHost).toBeUndefined();
    expect(openHostExternal("https://example.com")).toBe(false);
  });

  it("retains drafts by bot and conversation across workspace switches", () => {
    const drafts = new ConversationDrafts();
    drafts.update(draftKey("a"), () => ({ text: "A main", attachments: [] }));
    drafts.update(draftKey("a", 7), () => ({ text: "A thread", attachments: [] }));
    drafts.update(draftKey("b", 7), () => ({ text: "B thread", attachments: [] }));
    expect(drafts.read(draftKey("a")).text).toBe("A main");
    expect(drafts.read(draftKey("a", 7)).text).toBe("A thread");
    expect(drafts.read(draftKey("b", 7)).text).toBe("B thread");
    expect(drafts.read(draftKey("b")).text).toBe("");
  });
});
