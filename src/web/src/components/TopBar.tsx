import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { canInstall as pwaCanInstall, promptInstall } from "../pwa";
import { SettingsModal } from "./SettingsModal";
import type { User } from "../types";

export type Page = "views" | "sequences" | "configurations";

interface Props {
  user: User;
  page: Page;
  onNav: (p: Page) => void;
  onDisconnect: () => void;
  onImported: () => void;
}

export function TopBar({ user, page, onNav, onDisconnect, onImported }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
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
    <div className="topbar">
      <div className="brand">Pipeline <span>Launchpad</span></div>
      <span className="faint">·</span>
      <span className="muted">{user.org}</span>

      <nav className="nav">
        <button className={`nav-btn ${page === "views" ? "active" : ""}`} onClick={() => onNav("views")}>Views</button>
        <button className={`nav-btn ${page === "sequences" ? "active" : ""}`} onClick={() => onNav("sequences")}>Sequences</button>
        <button className={`nav-btn ${page === "configurations" ? "active" : ""}`} onClick={() => onNav("configurations")}>Configurations</button>
      </nav>

      <div className="spacer" />

      <input
        ref={fileRef}
        type="file"
        accept=".json,.yaml,.yml,.xml,application/json,text/yaml,application/xml"
        style={{ display: "none" }}
        onChange={onFile}
      />
      {canInstall && (
        <button className="btn ghost small" title="Install as an app" onClick={async () => { await promptInstall(); setCanInstall(pwaCanInstall()); }}>
          ⇩ Install
        </button>
      )}
      <button className="btn ghost small" onClick={() => fileRef.current?.click()} disabled={busy} title="Replace your views & sequences from a config file">
        {busy ? <><span className="spin" /> Importing…</> : "Import"}
      </button>
      <button className="btn ghost small" onClick={onExport} title="Download your current views & sequences as a config">Export</button>
      <button className="btn ghost small icon-btn" title="Settings" onClick={() => setShowSettings(true)}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      <span className="who">{user.displayName || user.uniqueName}</span>
      <button className="btn ghost small" onClick={onDisconnect}>Sign out</button>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}
