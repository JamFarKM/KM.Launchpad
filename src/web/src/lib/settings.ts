export type Theme = "system" | "light" | "dark";
/** How a shelf's accent hue is presented (§2.2) — both modes ship. */
export type ShelfStyle = "rail" | "tint" | "both" | "none";
/** Canvas dot grid / drop-rail hatch (§7, invariant A5). */
export type Texture = "off" | "dots" | "hatch" | "both";

export interface Settings {
  theme: Theme;
  notifications: boolean;
  shelfStyle: ShelfStyle;
  texture: Texture;
}

const KEY = "pl-settings";
const DEFAULTS: Settings = {
  theme: "system",
  notifications: true,
  shelfStyle: "both",
  texture: "both",
};

export function getSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return DEFAULTS;
  }
}

export function setSettings(next: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(next));
  applyAll(next);
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

/** Presentation preferences ride on <html> so pure CSS can key off them. */
export function applyAll(s: Settings = getSettings()): void {
  applyTheme(s.theme);
  document.documentElement.setAttribute("data-shelfstyle", s.shelfStyle);
  document.documentElement.setAttribute("data-texture", s.texture);
}

export function notificationsEnabled(): boolean {
  return getSettings().notifications;
}
