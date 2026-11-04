import { useState } from "react";

const STORAGE_KEY = "pi-bot.sidebar-collapsed";

export function useSidebarCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      /* The control still works when browser storage is unavailable. */
    }
  }
  return [collapsed, toggle];
}

/** Woven Matter's rounded sidebar glyph and 36-point control, retained across toggles for focus. */
export function SidebarToggle({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const label = collapsed ? "Show sidebar" : "Hide sidebar";
  const divider = collapsed ? 15.25 : 8.75;
  return (
    <button
      type="button"
      className="icon-button sidebar-toggle"
      aria-label={label}
      title={label}
      aria-expanded={!collapsed}
      aria-controls="app-sidebar"
      onClick={onToggle}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <rect x="3.25" y="4.25" width="17.5" height="15.5" rx="4.5" />
        <line x1={divider} y1="7.25" x2={divider} y2="16.75" />
      </svg>
    </button>
  );
}
