import { useCallback, useState } from "react";

/** The WovenMatter desktop DashboardTheme cases, in the app's order. */
export const THEMES = [
  { id: "green", label: "Green" },
  { id: "cognac", label: "Cognac" },
  { id: "dark", label: "Dark" },
] as const;

export type Theme = (typeof THEMES)[number]["id"];

/** Same key as the desktop app's DashboardTheme.storageKey. */
export const THEME_STORAGE_KEY = "wovenmatter.dashboard.theme";

const META_COLORS: Record<Theme, string> = {
  green: "#004225",
  cognac: "#f7f6f3",
  dark: "#1b1d1a",
};

function isTheme(value: unknown): value is Theme {
  return THEMES.some((theme) => theme.id === value);
}

export function storedTheme(): Theme {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(value) ? value : "green";
  } catch {
    return "green";
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", META_COLORS[theme]);
}

export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(storedTheme);
  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    applyTheme(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable (private mode); the theme still applies for this session.
    }
  }, []);
  return [theme, setTheme];
}
