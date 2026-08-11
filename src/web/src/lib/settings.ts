export type Theme = "system" | "light" | "dark";

export interface Settings {
  theme: Theme;
  notifications: boolean;
}

const KEY = "pl-settings";
const DEFAULTS: Settings = { theme: "system", notifications: true };

export function getSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return DEFAULTS;
  }
}

export function setSettings(next: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(next));
  applyTheme(next.theme);
  window.dispatchEvent(new Event("pl-settings"));
}

function resolve(theme: Theme): "light" | "dark" {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return theme;
}

let mql: MediaQueryList | null = null;

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", resolve(theme));
  // Keep "system" in sync with OS changes.
  if (mql) mql.onchange = null;
  if (theme === "system") {
    mql = window.matchMedia("(prefers-color-scheme: light)");
    mql.onchange = () => document.documentElement.setAttribute("data-theme", resolve("system"));
  }
}

export function notificationsEnabled(): boolean {
  return getSettings().notifications;
}
