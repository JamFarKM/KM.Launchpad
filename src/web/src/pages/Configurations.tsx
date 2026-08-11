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
    return { text: raw.length > 60 ? raw.slice(0, 60) + "…" : raw, expandable: false };
  }
  if (Array.isArray(parsed)) return { text: `[ ${parsed.length} item${parsed.length === 1 ? "" : "s"} ]`, expandable: true };
  if (parsed && typeof parsed === "object") {
    const keys = Object.keys(parsed as object);
    return { text: keys.length ? `{ ${keys.join(", ")} }` : "{ }", expandable: true };
  }
  return { text: String(parsed), expandable: false };
}

// ---- key tree (split on ":" and "/") ----
interface TreeNode {
  key: string;      // full prefix path (joined by "/")
  name: string;     // this segment
  children: Map<string, TreeNode>;
  settings: ConfigSetting[]; // settings whose key ends exactly at this node
}

function newNode(key: string, name: string): TreeNode {
  return { key, name, children: new Map(), settings: [] };
}

function buildTree(settings: ConfigSetting[]): TreeNode {
  const root = newNode("", "");
  for (const s of settings) {
    const segs = s.key.split(/[:/]/).filter(Boolean);
    if (segs.length === 0) { root.settings.push(s); continue; }
    let node = root;
    let prefix = "";
    segs.forEach((seg, i) => {
      prefix = prefix ? `${prefix}/${seg}` : seg;
      let child = node.children.get(seg);
      if (!child) { child = newNode(prefix, seg); node.children.set(seg, child); }
      if (i === segs.length - 1) child.settings.push(s);
      else node = child;
    });
  }
  return root;
}

function countLeaves(node: TreeNode): number {
  let n = node.settings.length;
  for (const c of node.children.values()) n += countLeaves(c);
  return n;
}

const sortedChildren = (node: TreeNode) =>
  [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

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

          {active && <RegistryTree key={active.id} registry={active} />}
        </div>
      </div>
    </div>
  );
}

function RegistryTree({ registry }: { registry: ConfigRegistry }) {
  const [q, setQ] = useState("");
  const [viewing, setViewing] = useState<ConfigSetting | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const settingsQ = useQuery<ConfigSetting[]>({
    queryKey: ["config-settings", registry.id],
    queryFn: () => api.configSettings(registry.id),
  });

  const needle = q.trim().toLowerCase();
  const filtered = useMemo(
    () => (settingsQ.data ?? []).filter((s) => !needle || s.key.toLowerCase().includes(needle) || (s.value ?? "").toLowerCase().includes(needle)),
    [settingsQ.data, needle],
  );
  const tree = useMemo(() => buildTree(filtered), [filtered]);

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }
  const forceOpen = needle.length > 0; // expand everything while filtering

  const roots = sortedChildren(tree);

  return (
    <div className="cfg-registry-body">
      <div className="cfg-registry-head">
        <div className="faint" style={{ fontSize: 12 }}>{registry.endpoint}</div>
        <span style={{ flex: 1 }} />
        <button className="btn ghost small icon-btn" title="Refresh" disabled={settingsQ.isFetching} onClick={() => settingsQ.refetch()}>
          <svg className={settingsQ.isFetching ? "spin-svg" : ""} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M23 4v6h-6" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
        <input className="input" style={{ maxWidth: 260 }} placeholder="Filter keys…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {settingsQ.isLoading && <div className="center-note"><span className="spin" /> loading settings…</div>}
      {settingsQ.error && (
        <div className="error">{settingsQ.error instanceof ApiError ? settingsQ.error.message : "Could not read this store."}</div>
      )}

      {settingsQ.data && (
        <div className="cfg-tree-wrap">
          <div className="cfg-tree">
            {roots.length === 0 && <div className="faint" style={{ padding: 12 }}>No matching settings.</div>}
            {tree.settings.map((s, i) => <Leaf key={`root:${i}`} setting={s} name={s.key} depth={0} onView={setViewing} />)}
            {roots.map((node) => (
              <TreeGroupOrLeaf key={node.key} node={node} depth={0} expanded={expanded} forceOpen={forceOpen} toggle={toggle} onView={setViewing} />
            ))}
          </div>
        </div>
      )}

      {viewing && <JsonModal title={viewing.key} raw={viewing.value ?? ""} onClose={() => setViewing(null)} />}
    </div>
  );
}

function TreeGroupOrLeaf({ node, depth, expanded, forceOpen, toggle, onView }: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  forceOpen: boolean;
  toggle: (key: string) => void;
  onView: (s: ConfigSetting) => void;
}) {
  // A pure leaf: no children and exactly one setting at this segment.
  if (node.children.size === 0 && node.settings.length === 1) {
    return <Leaf setting={node.settings[0]} name={node.name} depth={depth} onView={onView} />;
  }

  const open = forceOpen || expanded.has(node.key);
  return (
    <div className="cfg-node">
      <button className="cfg-group" style={{ paddingLeft: depth * 16 + 6 }} onClick={() => toggle(node.key)}>
        <span className="cfg-chevron">{open ? "▾" : "▸"}</span>
        <span className="cfg-group-name">{node.name}</span>
        <span className="cfg-count">{countLeaves(node)}</span>
      </button>
      {open && (
        <>
          {node.settings.map((s, i) => <Leaf key={`self:${i}`} setting={s} name={node.name} depth={depth + 1} onView={onView} />)}
          {sortedChildren(node).map((c) => (
            <TreeGroupOrLeaf key={c.key} node={c} depth={depth + 1} expanded={expanded} forceOpen={forceOpen} toggle={toggle} onView={onView} />
          ))}
        </>
      )}
    </div>
  );
}

function Leaf({ setting, name, depth, onView, muted }: {
  setting: ConfigSetting;
  name: string;
  depth: number;
  onView: (s: ConfigSetting) => void;
  muted?: boolean;
}) {
  const d = digest(setting.value);
  return (
    <div className="cfg-leaf" style={{ paddingLeft: depth * 16 + 22 }} title={setting.key}>
      <span className={`cfg-leaf-name ${muted ? "faint" : ""}`}>{name}</span>
      <span className={`cfg-leaf-label ${setting.label ? "" : "cfg-no-label"}`} title={setting.label ? `label: ${setting.label}` : "no label"}>
        {setting.label || "no label"}
      </span>
      <span className="cfg-leaf-digest">{d.text}</span>
      {d.expandable && <button className="btn ghost small" onClick={() => onView(setting)}>View</button>}
    </div>
  );
}
