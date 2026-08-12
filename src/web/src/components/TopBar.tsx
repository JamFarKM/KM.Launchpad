import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { canInstall as pwaCanInstall, promptInstall } from "../pwa";
import { SettingsModal } from "./SettingsModal";
import {
  getSettings, setSettings,
  type ShelfStyle, type Texture, type Theme,
} from "../lib/settings";
import type { User } from "../types";

export type Page = "views" | "sequences" | "review" | "configurations" | "keyvault";

interface Props {
  user: User;
  page: Page;
  /** Pages with nothing behind them: Configurations and Key Vault with no store registered.
   *  An empty page behind a nav tab reads as a broken feature, not an unconfigured one. */
  hidden?: Set<Page>;
  onNav: (p: Page) => void;
  onDisconnect: () => void;
  onImported: () => void;
}

/** 14px monochrome SVGs that inherit currentColor — never emoji (§2.1). */
const NAV: { id: Page; label: string; icon: JSX.Element }[] = [
  {
    id: "views", label: "Views",
    icon: (
      <svg className="nav-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.5" strokeWidth="1.3" />
        <rect x="9" y="1.5" width="5.5" height="5.5" rx="1.5" strokeWidth="1.3" />
        <rect x="1.5" y="9" width="5.5" height="5.5" rx="1.5" strokeWidth="1.3" />
        <rect x="9" y="9" width="5.5" height="5.5" rx="1.5" strokeWidth="1.3" />
      </svg>
    ),
  },
  /* No Sequences tab (SEQUENCES §1): sequences are reached from the library drawer, which is
     where the things you put on shelves live. The `sequences` page id stays in the union — the
     drawer still routes to it — and /sequences keeps returning the app via the server's
     index.html fallback rather than 404-ing, so old bookmarks land on the board. */
  {
    id: "review", label: "Review",
    icon: (
      <svg className="nav-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M5.5 2.5h6.2a1.3 1.3 0 0 1 1.3 1.3v8.4a1.3 1.3 0 0 1-1.3 1.3H5.5" strokeWidth="1.3" strokeLinecap="round" />
        <path d="M3 5.2v5.6" strokeWidth="1.3" strokeLinecap="round" />
        <path d="M6.4 6.4h4M6.4 9.6h2.6" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "configurations", label: "Configurations",
    icon: (
      <svg className="nav-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M2 4h12M2 8h12M2 12h12" strokeWidth="1.3" strokeLinecap="round" />
        <circle cx="5.5" cy="4" r="1.3" fill="currentColor" stroke="none" />
        <circle cx="10.5" cy="8" r="1.3" fill="currentColor" stroke="none" />
        <circle cx="6.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    id: "keyvault", label: "Key Vault",
    icon: (
      <svg className="nav-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="3" y="7" width="10" height="7" rx="1.8" strokeWidth="1.3" />
        <path d="M5.2 7V5a2.8 2.8 0 0 1 5.6 0v2" strokeWidth="1.3" />
      </svg>
    ),
  },
];

const THEMES: Theme[] = ["light", "dark", "system"];
const SHELF_STYLES: ShelfStyle[] = ["rail", "tint", "both", "none"];
const TEXTURES: Texture[] = ["off", "dots", "hatch", "both"];

export function TopBar({ user, page, hidden, onNav, onDisconnect, onImported }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [menu, setMenu] = useState<"transfer" | "settings" | null>(null);
  const [prefs, setPrefs] = useState(getSettings());
  const [canInstall, setCanInstall] = useState(pwaCanInstall());

  useEffect(() => {
    const on = () => setCanInstall(true);
    const off = () => setCanInstall(false);
    window.addEventListener("pl-can-install", on);
    window.addEventListener("pl-installed", off);
    return () => {
      window.removeEventListener("pl-can-install", on);
      window.removeEventListener("pl-installed", off);
    };
  }, []);

  // Close any open dropdown on an outside click.
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menu]);

  function updatePrefs(next: typeof prefs) {
    setPrefs(next);
    setSettings(next);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!window.confirm("Importing will REPLACE all your current views and sequences. Continue?")) return;
    setBusy(true);
    try {
      const text = await file.text();
      const ext = (file.name.split(".").pop() || "").toLowerCase();
      const res = await api.importConfig(text, ext);
      onImported();
      window.alert(`Imported ${res.views} view(s) and ${res.sequences} sequence(s).`);
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  }

  async function onExport() {
    try {
      const json = await api.exportConfig();
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "launchpad-config.json";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : "Export failed.");
    }
  }

  return (
    <div className="topbar" ref={barRef}>
      <div className="brand"><span>Launchpad</span></div>
      <span className="faint">·</span>
      <span className="muted">{user.org}</span>

      <nav className="nav">
        {NAV.filter((n) => !hidden?.has(n.id)).map((n) => (
          <button
            key={n.id}
            className={`nav-btn ${page === n.id ? "active" : ""}`}
            onClick={() => onNav(n.id)}
          >
            {n.icon}
            {n.label}
          </button>
        ))}
      </nav>

      <div className="spacer" />

      <input
        ref={fileRef}
        type="file"
        accept=".json,.yaml,.yml,.xml,application/json,text/yaml,application/xml"
        style={{ display: "none" }}
        onChange={onFile}
      />

      {/* Import + Export merged into one Transfer dropdown (§2.1). */}
      <div className="menu-anchor">
        <button
          className="transfer-btn"
          onClick={() => setMenu(menu === "transfer" ? null : "transfer")}
          disabled={busy}
        >
          {busy ? <><span className="spin" /> Importing…</> : (
            <>
              <svg className="t-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 2.5v7M5.2 6.8L8 9.6l2.8-2.8M2.8 11.5v1.2a.8.8 0 0 0 .8.8h8.8a.8.8 0 0 0 .8-.8v-1.2" />
              </svg>
              Transfer
              <svg className="t-caret" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <path d="M4 6.5L8 10.5l4-4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </>
          )}
        </button>
        {menu === "transfer" && (
          <div className="dropdown">
            <button className="menu-item" onClick={() => { setMenu(null); fileRef.current?.click(); }}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 10.5v-8M5.2 5.3L8 2.5l2.8 2.8M2.8 11.5v1.2a.8.8 0 0 0 .8.8h8.8a.8.8 0 0 0 .8-.8v-1.2" />
              </svg>
              Import configuration…
            </button>
            <button className="menu-item" onClick={() => { setMenu(null); onExport(); }}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 2.5v8M5.2 7.7L8 10.5l2.8-2.8M2.8 11.5v1.2a.8.8 0 0 0 .8.8h8.8a.8.8 0 0 0 .8-.8v-1.2" />
              </svg>
              Export current view
            </button>
            <div className="dropdown-sep" />
            <button className="menu-item" disabled title="Not implemented yet">Export all views</button>
          </div>
        )}
      </div>

      {/* Settings gear: appearance first, then presentation preferences (§2.1). */}
      <div className="menu-anchor">
        <button
          className="btn ghost small icon-btn"
          title="Settings"
          onClick={() => setMenu(menu === "settings" ? null : "settings")}
        >
          <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4">
            <circle cx="10" cy="10" r="2.6" />
            <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.6 4.6l1.4 1.4M14 14l1.4 1.4M4.6 15.4L6 14M14 6l1.4-1.4" strokeLinecap="round" />
          </svg>
        </button>
        {menu === "settings" && (
          <div className="dropdown" style={{ minWidth: 232 }}>
            <div className="dropdown-label">Appearance</div>
            <div className="theme-switch">
              {THEMES.map((t) => (
                <button
                  key={t}
                  className={`theme-opt ${prefs.theme === t ? "active" : ""}`}
                  onClick={() => updatePrefs({ ...prefs, theme: t })}
                >
                  {t === "light" ? "☀ Light" : t === "dark" ? "☾ Dark" : "Auto"}
                </button>
              ))}
            </div>

            <div className="dropdown-label">Shelf accent</div>
            <div className="theme-switch" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
              {SHELF_STYLES.map((v) => (
                <button
                  key={v}
                  className={`theme-opt ${prefs.shelfStyle === v ? "active" : ""}`}
                  style={{ textTransform: "capitalize" }}
                  onClick={() => updatePrefs({ ...prefs, shelfStyle: v })}
                >
                  {v}
                </button>
              ))}
            </div>

            <div className="dropdown-label">Texture</div>
            <div className="theme-switch" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
              {TEXTURES.map((v) => (
                <button
                  key={v}
                  className={`theme-opt ${prefs.texture === v ? "active" : ""}`}
                  style={{ textTransform: "capitalize" }}
                  onClick={() => updatePrefs({ ...prefs, texture: v })}
                >
                  {v}
                </button>
              ))}
            </div>

            <div className="dropdown-sep" />
            {canInstall && (
              <button className="menu-item" onClick={async () => { setMenu(null); await promptInstall(); setCanInstall(pwaCanInstall()); }}>
                ⇩ Install as an app
              </button>
            )}
            <button className="menu-item" onClick={() => { setMenu(null); setShowSettings(true); }}>
              Notifications &amp; stores…
            </button>
          </div>
        )}
      </div>

      <span className="who">{user.displayName || user.uniqueName}</span>
      <button className="btn ghost small" onClick={onDisconnect}>Sign out</button>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}
