import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { getSettings, setSettings, type Theme } from "../lib/settings";
import { ensureNotifyPermission } from "../lib/notify";
import type { ConfigRegistry } from "../types";

const THEMES: Theme[] = ["system", "light", "dark"];

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState(getSettings());

  function update(next: typeof s) {
    setS(next);
    setSettings(next);
  }

  const denied = "Notification" in window && Notification.permission === "denied";

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 560 }}>
        <div className="modal-head">
          <div className="title">Settings</div>
          <button className="btn ghost small" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label className="label">Theme</label>
            <div className="row">
              {THEMES.map((t) => (
                <button key={t} className={`btn small ${s.theme === t ? "primary" : ""}`}
                  style={{ textTransform: "capitalize", flex: 1 }} onClick={() => update({ ...s, theme: t })}>
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label className="label">Desktop notifications</label>
            <label className="row" style={{ gap: 8, cursor: "pointer" }}>
              <input type="checkbox" checked={s.notifications}
                onChange={(e) => { const on = e.target.checked; update({ ...s, notifications: on }); if (on) ensureNotifyPermission(); }} />
              <span>Notify me when a run or sequence finishes</span>
            </label>
            {s.notifications && denied && (
              <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>
                Your browser is blocking notifications for this site — enable them in the browser’s site settings.
              </div>
            )}
          </div>

          <ConfigRegistriesSection />
        </div>
      </div>
    </div>
  );
}

function ConfigRegistriesSection() {
  const qc = useQueryClient();
  const registriesQ = useQuery<ConfigRegistry[]>({ queryKey: ["config-registries"], queryFn: api.configRegistries });
  const [name, setName] = useState("");
  const [connection, setConnection] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () => api.addConfigRegistry(name.trim(), connection.trim()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["config-registries"] });
      setName(""); setConnection(""); setError(null);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not add registry."),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteConfigRegistry(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["config-registries"] }),
  });

  const registries = registriesQ.data ?? [];

  return (
    <div className="field">
      <label className="label">Azure App Configuration registries</label>
      <div className="faint" style={{ fontSize: 12, marginBottom: 8 }}>
        Paste a connection string, or an endpoint URL (e.g. <code>https://myapp.azconfig.io</code>) to use your Azure login.
        Stored encrypted; shown on the Configurations tab.
      </div>

      {registries.map((r) => (
        <div className="row" key={r.id} style={{ marginBottom: 6 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</div>
            <div className="faint" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.endpoint}</div>
          </div>
          <button className="btn ghost small" onClick={() => remove.mutate(r.id)}>Remove</button>
        </div>
      ))}

      {error && <div className="error" style={{ fontSize: 12, margin: "8px 0" }}>{error}</div>}

      <div style={{ marginTop: 8 }}>
        <input className="input" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} style={{ marginBottom: 6 }} />
        <input className="input" placeholder="Connection string or endpoint URL" value={connection} onChange={(e) => setConnection(e.target.value)} style={{ marginBottom: 6 }} />
        <button className="btn small primary" disabled={!connection.trim() || add.isPending} onClick={() => add.mutate()}>
          {add.isPending ? "Validating…" : "+ Add registry"}
        </button>
      </div>
    </div>
  );
}
