import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import type { ConfigRegistry, ConfigSetting } from "../types";
import { JsonModal } from "../components/JsonModal";

/** A short, readable summary of a (usually JSON) config value. */
function digest(raw?: string | null): { text: string; expandable: boolean } {
  if (raw == null || raw === "") return { text: "", expandable: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { text: raw.length > 80 ? raw.slice(0, 80) + "…" : raw, expandable: false };
  }
  if (Array.isArray(parsed)) return { text: `[ ${parsed.length} item${parsed.length === 1 ? "" : "s"} ]`, expandable: true };
  if (parsed && typeof parsed === "object") {
    const keys = Object.keys(parsed as object);
    return { text: keys.length ? `{ ${keys.join(", ")} }` : "{ }", expandable: true };
  }
  return { text: String(parsed), expandable: false };
}

export function ConfigurationsPage() {
  const registriesQ = useQuery<ConfigRegistry[]>({ queryKey: ["config-registries"], queryFn: api.configRegistries });
  const registries = registriesQ.data ?? [];
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (registries.length > 0 && (!activeId || !registries.some((r) => r.id === activeId))) {
      setActiveId(registries[0].id);
    }
  }, [registries, activeId]);

  const active = registries.find((r) => r.id === activeId) ?? null;

  return (
    <div className="body">
      <div className="main">
        {registries.length > 0 && (
          <div className="tabs">
            {registries.map((r) => (
              <button key={r.id} className={`tab ${r.id === activeId ? "active" : ""}`} onClick={() => setActiveId(r.id)} title={r.endpoint}>
                {r.name}
              </button>
            ))}
          </div>
        )}

        <div className="view-area cfg-area">
          {registriesQ.isLoading && <div className="center-note"><span className="spin" /> Loading registries…</div>}

          {!registriesQ.isLoading && registries.length === 0 && (
            <div className="empty">
              <h3>No configuration registries yet</h3>
              <p>Add Azure App Configuration stores in <b>Settings ⚙️</b> using a connection string. Each store appears here as its own tab.</p>
            </div>
          )}

          {active && <RegistrySettings key={active.id} registry={active} />}
        </div>
      </div>
    </div>
  );
}

function RegistrySettings({ registry }: { registry: ConfigRegistry }) {
  const [q, setQ] = useState("");
  const [viewing, setViewing] = useState<ConfigSetting | null>(null);
  const settingsQ = useQuery<ConfigSetting[]>({
    queryKey: ["config-settings", registry.id],
    queryFn: () => api.configSettings(registry.id),
  });

  const needle = q.trim().toLowerCase();
  const rows = useMemo(
    () => (settingsQ.data ?? []).filter((s) => !needle || s.key.toLowerCase().includes(needle) || (s.value ?? "").toLowerCase().includes(needle)),
    [settingsQ.data, needle],
  );

  return (
    <div className="cfg-registry-body">
      <div className="cfg-registry-head">
        <div className="faint" style={{ fontSize: 12 }}>{registry.endpoint}</div>
        <span style={{ flex: 1 }} />
        <input className="input" style={{ maxWidth: 260 }} placeholder="Filter keys…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {settingsQ.isLoading && <div className="center-note"><span className="spin" /> loading settings…</div>}
      {settingsQ.error && (
        <div className="error">{settingsQ.error instanceof ApiError ? settingsQ.error.message : "Could not read this store."}</div>
      )}

      {settingsQ.data && (
        <div className="cfg-table-wrap">
          <table className="cfg-table">
            <thead>
              <tr><th>Key</th><th>Value</th><th>Label</th><th></th></tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={4} className="faint">No matching settings.</td></tr>}
              {rows.map((s, i) => {
                const d = digest(s.value);
                return (
                  <tr key={`${s.key}:${s.label}:${i}`}>
                    <td className="cfg-key">{s.key}</td>
                    <td className="cfg-digest">{d.text}</td>
                    <td className="faint">{s.label ?? ""}</td>
                    <td className="cfg-actions">
                      {d.expandable && <button className="btn ghost small" onClick={() => setViewing(s)}>View</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {viewing && (
        <JsonModal title={viewing.key} raw={viewing.value ?? ""} onClose={() => setViewing(null)} />
      )}
    </div>
  );
}
