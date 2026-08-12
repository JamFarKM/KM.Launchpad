import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import type { ConfigRegistry, ConfigSetting, ConfigSettings } from "../types";

/**
 * Three panes: namespaces → keys → detail (§2.4). One scroll context per pane, no modal,
 * and the detail pane slides in beside the key list rather than covering it, so you never
 * lose your place in the list you were comparing against.
 */

// ---- value typing: identity, not status (so the hues exclude green and red, per A2) ----
type ValueType = "JSON" | "BOOL" | "INT" | "STR";

function valueType(raw?: string | null): ValueType {
  const s = (raw ?? "").trim();
  if (!s) return "STR";
  if (s === "true" || s === "false") return "BOOL";
  if (/^-?\d+(\.\d+)?$/.test(s)) return "INT";
  if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
    try { JSON.parse(s); return "JSON"; } catch { /* not valid JSON after all */ }
  }
  return "STR";
}

/** A short, readable one-liner for the value column. */
function preview(raw?: string | null): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  if (valueType(s) === "JSON") {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return `[ ${parsed.length} item${parsed.length === 1 ? "" : "s"} ]`;
      const keys = Object.keys(parsed as object);
      return keys.length ? `{ ${keys.join(", ")} }` : "{ }";
    } catch { /* fall through */ }
  }
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

/** A key as shown in the table: the setting plus the portion of its name still worth showing. */
interface KeyRow {
  setting: ConfigSetting;
  label: string;
}

/** Key-count badge doubles as a magnitude cue — one hue, four steps. */
const countStep = (n: number) => (n < 20 ? 1 : n < 80 ? 2 : n < 200 ? 3 : 4);

/**
 * Environment identity. Registries are user-named, so the hue is inferred from the name —
 * "which environment am I about to touch?" then becomes answerable peripherally. Prod is
 * orange rather than red: red belongs to failure alone (A2).
 */
function envOf(name: string): "dev" | "test" | "prod" | "none" {
  const n = name.toLowerCase();
  if (/\b(prod|live|prd)\b/.test(n) || n.includes("prod")) return "prod";
  if (/\b(test|qa|stage|staging|uat|gli)\b/.test(n) || n.includes("test")) return "test";
  if (/\b(dev|int|local)\b/.test(n) || n.includes("dev")) return "dev";
  return "none";
}

// ---- namespaces: the first segment of a key, split on ":" or "/" ----
const NS_ROOT = "(root)";
const namespaceOf = (key: string): string => {
  const seg = key.split(/[:/]/).filter(Boolean)[0];
  return seg && seg !== key ? seg : NS_ROOT;
};
/** The part of the key below its namespace — the namespace is already the pane you're in. */
const keyLeaf = (key: string): string => {
  const ns = namespaceOf(key);
  return ns === NS_ROOT ? key : key.slice(ns.length).replace(/^[:/]+/, "") || key;
};

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

  if (registriesQ.isLoading) {
    return <div className="body"><div className="center-note"><span className="spin" /> Loading registries…</div></div>;
  }

  if (registries.length === 0) {
    return (
      <div className="body">
        <div className="empty">
          <h3>No configuration registries yet</h3>
          <p>Add Azure App Configuration stores in <b>Settings ⚙️</b>. Each store appears here as an environment.</p>
        </div>
      </div>
    );
  }

  return (
    <ConfigBrowser
      key={active?.id}
      registries={registries}
      active={active}
      onPickRegistry={setActiveId}
    />
  );
}

function ConfigBrowser({ registries, active, onPickRegistry }: {
  registries: ConfigRegistry[];
  active: ConfigRegistry | null;
  onPickRegistry: (id: string) => void;
}) {
  const [nsFilter, setNsFilter] = useState("");
  const [keyFilter, setKeyFilter] = useState("");
  const [activeNs, setActiveNs] = useState<string | null>(null);
  const [selected, setSelected] = useState<ConfigSetting | null>(null);
  const [copied, setCopied] = useState(false);

  const settingsQ = useQuery<ConfigSettings>({
    queryKey: ["config-settings", active?.id],
    queryFn: () => api.configSettings(active!.id),
    enabled: !!active,
  });

  const settings = useMemo(() => settingsQ.data?.settings ?? [], [settingsQ.data]);

  // namespace → settings
  const namespaces = useMemo(() => {
    const m = new Map<string, ConfigSetting[]>();
    for (const s of settings) {
      const ns = namespaceOf(s.key);
      const list = m.get(ns);
      if (list) list.push(s); else m.set(ns, [s]);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: "base" }));
  }, [settings]);

  // Land on the first namespace once the data arrives.
  useEffect(() => {
    if (namespaces.length > 0 && (!activeNs || !namespaces.some(([n]) => n === activeNs))) {
      setActiveNs(namespaces[0][0]);
    }
  }, [namespaces, activeNs]);

  const nsNeedle = nsFilter.trim().toLowerCase();
  const shownNamespaces = namespaces.filter(([n]) => !nsNeedle || n.toLowerCase().includes(nsNeedle));

  const keyNeedle = keyFilter.trim().toLowerCase();
  const keys = useMemo(() => {
    const inNs = namespaces.find(([n]) => n === activeNs)?.[1] ?? [];
    return inNs
      .filter((s) => !keyNeedle || s.key.toLowerCase().includes(keyNeedle) || (s.value ?? "").toLowerCase().includes(keyNeedle))
      .sort((a, b) => a.key.localeCompare(b.key, undefined, { sensitivity: "base" }));
  }, [namespaces, activeNs, keyNeedle]);

  /**
   * Within a namespace, keys are grouped by their next segment — so Importer:Endpoints:Primary
   * and Importer:Endpoints:Secondary sit together under "Endpoints", each row showing only the
   * part below it. Keys with nothing left to split are listed first, ungrouped.
   */
  const grouped = useMemo(() => {
    const bare: KeyRow[] = [];
    const byGroup = new Map<string, KeyRow[]>();
    for (const s of keys) {
      const leaf = keyLeaf(s.key);
      const cut = leaf.search(/[:/]/);
      if (cut < 0) {
        bare.push({ setting: s, label: leaf });
      } else {
        const group = leaf.slice(0, cut);
        const rest = leaf.slice(cut + 1) || leaf;
        const rows = byGroup.get(group);
        if (rows) rows.push({ setting: s, label: rest });
        else byGroup.set(group, [{ setting: s, label: rest }]);
      }
    }
    const out: { name: string | null; rows: KeyRow[] }[] = [];
    if (bare.length) out.push({ name: null, rows: bare });
    for (const [name, rows] of [...byGroup.entries()].sort((a, b) =>
      a[0].localeCompare(b[0], undefined, { sensitivity: "base" }))) {
      out.push({ name, rows });
    }
    return out;
  }, [keys]);

  const env = active ? envOf(active.name) : "none";
  const detailOpen = !!selected;

  async function copyValue() {
    if (!selected?.value) return;
    try {
      await navigator.clipboard.writeText(selected.value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  }

  return (
    <div
      className={`cfg ${detailOpen ? "is-detail-open" : ""}`}
      style={{ ["--env-active" as string]: env === "none" ? "var(--ink-muted)" : `var(--env-${env})` }}
    >
      {/* ---------------- namespaces ---------------- */}
      <div className="cfg-col">
        <div className="cfg-head">
          <div className="cfg-envrow">
            {registries.map((r) => {
              const e = envOf(r.name);
              return (
                <button
                  key={r.id}
                  className={`env-pill ${r.id === active?.id ? "active" : ""}`}
                  style={{ ["--env-c" as string]: e === "none" ? "var(--ink-muted)" : `var(--env-${e})` }}
                  title={r.endpoint}
                  onClick={() => { onPickRegistry(r.id); setSelected(null); }}
                >
                  {r.name}
                </button>
              );
            })}
          </div>
          {active && <div className="cfg-endpoint" title={active.endpoint}>{active.endpoint}</div>}
        </div>

        <div className="cfg-filter">
          <input className="cfg-search" placeholder="Filter namespaces…"
            value={nsFilter} onChange={(e) => setNsFilter(e.target.value)} />
        </div>

        <div className="cfg-scroll">
          {settingsQ.isLoading && <div className="center-note"><span className="spin" /> loading…</div>}
          {!settingsQ.isLoading && shownNamespaces.length === 0 && (
            <div className="faint cfg-note">No matching namespaces.</div>
          )}
          {shownNamespaces.map(([ns, items]) => (
            <button
              key={ns}
              className={`ns-item ${ns === activeNs ? "active" : ""}`}
              onClick={() => { setActiveNs(ns); setSelected(null); }}
            >
              <span className="nm" title={ns}>{ns}</span>
              <span className={`ns-count sz${countStep(items.length)}`}>{items.length}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ---------------- keys ---------------- */}
      <div className="cfg-col">
        <div className="keys-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="keys-title">{activeNs ?? "—"}</div>
            <div className="keys-sub">
              {keys.length} key{keys.length === 1 ? "" : "s"}{active ? ` · ${active.name}` : ""}
            </div>
          </div>
          <input className="cfg-search" style={{ width: 230 }} placeholder="Filter keys…"
            value={keyFilter} onChange={(e) => setKeyFilter(e.target.value)} />
          <button className="btn ghost small icon-btn" title="Refresh"
            disabled={settingsQ.isFetching} onClick={() => settingsQ.refetch()}>
            <svg className={settingsQ.isFetching ? "spin-svg" : ""} width="14" height="14" viewBox="0 0 16 16"
              fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <path d="M13.5 8a5.5 5.5 0 1 1-1.7-4" /><path d="M13.6 1.8v2.6h-2.6" />
            </svg>
          </button>
        </div>

        <div className="keys-table">
          <div className="keys-colhead">
            <span>Key</span><span>Label</span><span>Value</span><span style={{ textAlign: "center" }}>Type</span>
          </div>

          {settingsQ.error && (
            <div className="error cfg-note">
              {settingsQ.error instanceof ApiError ? settingsQ.error.message : "Could not read this store."}
            </div>
          )}
          {/* A capped read has to say so. The store returns settings in key order, so what's
              missing is the tail of the alphabet — which looks identical to a store that simply
              doesn't hold those keys. */}
          {settingsQ.data?.truncated && (
            <div className="warn cfg-note">
              Only the first {settingsQ.data.limit.toLocaleString()} settings were read, in key
              order — keys later in the alphabet are missing from this page.
            </div>
          )}
          {!settingsQ.isLoading && !settingsQ.error && keys.length === 0 && (
            <div className="faint cfg-note">No matching keys.</div>
          )}

          {grouped.map((group) => (
            <div className="key-group" key={group.name ?? "(ungrouped)"}>
              {group.name && (
                <div className="key-group-head">
                  <span className="kg-name">{group.name}</span>
                  <span className="kg-count">{group.rows.length}</span>
                </div>
              )}
              {group.rows.map(({ setting: s, label }) => {
                const t = valueType(s.value);
                return (
                  <div
                    key={`${s.key}|${s.label ?? ""}`}
                    className={`key-row ${group.name ? "in-group" : ""} ${selected?.key === s.key && selected?.label === s.label ? "sel" : ""}`}
                    onClick={() => setSelected(s)}
                  >
                    <span className="key-name" title={s.key}>{label}</span>
                    <span className="key-label">
                      {s.label ? <span className="tag">{s.label}</span> : <span className="faint">—</span>}
                    </span>
                    <span className="key-preview" title={s.value ?? ""}>{preview(s.value)}</span>
                    <span className={`key-type ty-${t}`}>{t}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* ---------------- detail ---------------- */}
      <div className="cfg-col cfg-detail">
        {selected && (
          <>
            <div className="detail-head">
              <span className="detail-title" title={selected.key}>{selected.key}</span>
              <button className="btn small" onClick={copyValue}>{copied ? "Copied ✓" : "Copy"}</button>
              <button className="btn ghost small icon-btn" title="Close" onClick={() => setSelected(null)}>✕</button>
            </div>
            <div className="json-view">
              <JsonBody raw={selected.value ?? ""} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Pretty-prints JSON with keys, numbers and strings coloured separately; other values verbatim. */
function JsonBody({ raw }: { raw: string }) {
  const pretty = useMemo(() => {
    try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return null; }
  }, [raw]);

  if (pretty === null) return <>{raw}</>;

  // Split on JSON tokens so each can be coloured; the separators are kept via the capture group.
  const parts = pretty.split(/("(?:\\.|[^"\\])*"\s*:?|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b)/g);
  return (
    <>
      {parts.map((p, i) => {
        if (!p) return null;
        if (i % 2 === 0) return <span key={i} className="j-punct">{p}</span>;
        if (p.startsWith("\"")) {
          return p.trimEnd().endsWith(":")
            ? <span key={i} className="j-key">{p}</span>
            : <span key={i} className="j-str">{p}</span>;
        }
        if (p === "true" || p === "false") return <span key={i} className="j-bool">{p}</span>;
        if (p === "null") return <span key={i} className="j-null">{p}</span>;
        return <span key={i} className="j-num">{p}</span>;
      })}
    </>
  );
}
