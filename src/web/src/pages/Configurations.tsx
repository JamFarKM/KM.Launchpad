import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import type { ConfigRegistry, ConfigSetting } from "../types";

export function ConfigurationsPage() {
  const registriesQ = useQuery<ConfigRegistry[]>({ queryKey: ["config-registries"], queryFn: api.configRegistries });
  const registries = registriesQ.data ?? [];

  return (
    <div className="body">
      <div className="main">
        <div className="view-area">
          {registriesQ.isLoading && <div className="center-note"><span className="spin" /> Loading registries…</div>}

          {!registriesQ.isLoading && registries.length === 0 && (
            <div className="empty">
              <h3>No configuration registries yet</h3>
              <p>
                Add one or more Azure App Configuration stores in <b>Settings ⚙️</b> (paste a connection
                string, or an endpoint URL to use your Azure login). Their key/values show here, grouped by store.
              </p>
            </div>
          )}

          {registries.map((r) => (
            <RegistrySection key={r.id} registry={r} />
          ))}
        </div>
      </div>
    </div>
  );
}

function RegistrySection({ registry }: { registry: ConfigRegistry }) {
  const [q, setQ] = useState("");
  const settingsQ = useQuery<ConfigSetting[]>({
    queryKey: ["config-settings", registry.id],
    queryFn: () => api.configSettings(registry.id),
  });

  const needle = q.trim().toLowerCase();
  const rows = (settingsQ.data ?? []).filter(
    (s) => !needle || s.key.toLowerCase().includes(needle) || (s.value ?? "").toLowerCase().includes(needle),
  );

  return (
    <section className="cfg-registry">
      <div className="cfg-registry-head">
        <div>
          <div className="cfg-registry-name">{registry.name}</div>
          <div className="faint" style={{ fontSize: 12 }}>{registry.endpoint}</div>
        </div>
        <span style={{ flex: 1 }} />
        <input className="input" style={{ maxWidth: 240 }} placeholder="Filter keys…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {settingsQ.isLoading && <div className="center-note"><span className="spin" /> loading settings…</div>}
      {settingsQ.error && (
        <div className="error">{settingsQ.error instanceof ApiError ? settingsQ.error.message : "Could not read this store."}</div>
      )}

      {settingsQ.data && (
        <div className="cfg-table-wrap">
          <table className="cfg-table">
            <thead>
              <tr><th>Key</th><th>Value</th><th>Label</th></tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={3} className="faint">No matching settings.</td></tr>}
              {rows.map((s, i) => (
                <tr key={`${s.key}:${s.label}:${i}`}>
                  <td className="cfg-key">{s.key}</td>
                  <td className="cfg-val">{s.value}</td>
                  <td className="faint">{s.label ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
