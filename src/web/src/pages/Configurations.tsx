import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import type { ConfigRegistry, ConfigSetting, ConfigSettings } from "../types";
import {
  canonical, commonLines, groupByKey, isCompact, markLines, preview, NO_LABEL,
  type KeyGroup, type LabelValue,
} from "../lib/configLabels";

/**
 * Three panes: namespaces → keys → detail (§2.4, as amended by CONFIG_LABELS).
 *
 * The key list is one row per *key*, not per key+label: a key carrying three labels used to be
 * three rows, which padded the list with repeats and left "does this differ between labels?" to
 * be answered by eye. Collapsing the rows both shortens the list and creates somewhere to put
 * the answer — the DIFFERS marker in §5, and the stacked sections in §6.
 */

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

/**
 * A quiet dot, not a caution sign. Environments holding different values is what a config store
 * is for — it wants pointing at, not warning about.
 */
function DiffDot() {
  return <span className="diffdot" aria-hidden="true" />;
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M3 4.5L6 7.5l3-3" strokeLinecap="round" />
    </svg>
  );
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

/** A key as shown in the table: its grouped labels plus the portion of the name worth showing. */
interface KeyRow {
  group: KeyGroup;
  label: string;
}

function ConfigBrowser({ registries, active, onPickRegistry }: {
  registries: ConfigRegistry[];
  active: ConfigRegistry | null;
  onPickRegistry: (id: string) => void;
}) {
  const [nsFilter, setNsFilter] = useState("");
  const [keyFilter, setKeyFilter] = useState("");
  const [activeNs, setActiveNs] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const settingsQ = useQuery<ConfigSettings>({
    queryKey: ["config-settings", active?.id],
    queryFn: () => api.configSettings(active!.id),
    enabled: !!active,
  });

  const settings = useMemo(() => settingsQ.data?.settings ?? [], [settingsQ.data]);

  /* One fetch already returns every key *and* every label, which is exactly what computing drift
     needs — so this is a reshape of data in hand, not a second read. There is deliberately no
     per-row request here: Placement holds 290 keys (§7). */
  const namespaces = useMemo(() => {
    const m = new Map<string, ConfigSetting[]>();
    for (const s of settings) {
      const ns = namespaceOf(s.key);
      const list = m.get(ns);
      if (list) list.push(s); else m.set(ns, [s]);
    }
    return [...m.entries()]
      .map(([ns, items]) => ({ ns, items, groups: groupByKey(items) }))
      .sort((a, b) => a.ns.localeCompare(b.ns, undefined, { sensitivity: "base" }));
  }, [settings]);

  useEffect(() => {
    if (namespaces.length > 0 && (!activeNs || !namespaces.some((n) => n.ns === activeNs))) {
      setActiveNs(namespaces[0].ns);
    }
  }, [namespaces, activeNs]);

  const nsNeedle = nsFilter.trim().toLowerCase();
  const shownNamespaces = namespaces.filter((n) => !nsNeedle || n.ns.toLowerCase().includes(nsNeedle));

  const current = namespaces.find((n) => n.ns === activeNs);
  const keyNeedle = keyFilter.trim().toLowerCase();

  const keyGroups = useMemo(() => {
    const all = current?.groups ?? [];
    if (!keyNeedle) return all;
    return all.filter((g) =>
      g.key.toLowerCase().includes(keyNeedle) ||
      g.labels.some((l) => l.raw.toLowerCase().includes(keyNeedle) || l.label.toLowerCase().includes(keyNeedle)));
  }, [current, keyNeedle]);

  /** Total label values behind the rows, so the compression is legible (§5). */
  const labelValueCount = useMemo(
    () => keyGroups.reduce((n, g) => n + g.labels.length, 0), [keyGroups]);

  /**
   * Within a namespace, keys are grouped by their next segment — so Importer:Endpoints:Primary
   * and Importer:Endpoints:Secondary sit together under "Endpoints", each row showing only the
   * part below it. Keys with nothing left to split are listed first, ungrouped.
   */
  const grouped = useMemo(() => {
    const bare: KeyRow[] = [];
    const byGroup = new Map<string, KeyRow[]>();
    for (const g of keyGroups) {
      const leaf = keyLeaf(g.key);
      const cut = leaf.search(/[:/]/);
      if (cut < 0) {
        bare.push({ group: g, label: leaf });
      } else {
        const name = leaf.slice(0, cut);
        const rest = leaf.slice(cut + 1) || leaf;
        const rows = byGroup.get(name);
        if (rows) rows.push({ group: g, label: rest });
        else byGroup.set(name, [{ group: g, label: rest }]);
      }
    }
    const out: { name: string | null; rows: KeyRow[] }[] = [];
    if (bare.length) out.push({ name: null, rows: bare });
    for (const [name, rows] of [...byGroup.entries()].sort((a, b) =>
      a[0].localeCompare(b[0], undefined, { sensitivity: "base" }))) {
      out.push({ name, rows });
    }
    return out;
  }, [keyGroups]);

  const selected = keyGroups.find((g) => g.key === selectedKey) ?? null;
  const env = active ? envOf(active.name) : "none";

  return (
    <div
      className={`cfg ${selected ? "is-detail-open" : ""}`}
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
                  onClick={() => { onPickRegistry(r.id); setSelectedKey(null); }}
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
          {shownNamespaces.map(({ ns, groups }) => (
            <button
              key={ns}
              className={`ns-item ${ns === activeNs ? "active" : ""}`}
              onClick={() => { setActiveNs(ns); setSelectedKey(null); }}
            >
              <span className="nm" title={ns}>{ns}</span>
              <span className={`ns-count sz${countStep(groups.length)}`}>{groups.length}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ---------------- keys ---------------- */}
      <div className="cfg-col">
        <div className="keys-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="keys-title">{activeNs ?? "—"}</div>
            {/* Says both numbers, so collapsing the rows never hides the underlying volume. */}
            <div className="keys-sub">
              {keyGroups.length} key{keyGroups.length === 1 ? "" : "s"}
              {" · "}{labelValueCount} label value{labelValueCount === 1 ? "" : "s"}
              {active ? ` · ${active.name}` : ""}
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
            <span>Key</span><span>Labels</span><span>Value (shared)</span>
            <span style={{ textAlign: "center" }}>Type</span>
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
            <div className="notice-warn cfg-note">
              Only the first {settingsQ.data.limit.toLocaleString()} settings were read, in key
              order — keys later in the alphabet are missing from this page.
            </div>
          )}
          {/* POLISH §6: name the term and the scope. The likely fix here is a different
              namespace, and a bare "No matching keys" doesn't say which one you're in. */}
          {!settingsQ.isLoading && !settingsQ.error && keyGroups.length === 0 && (
            <div className="pool-empty">
              {keyNeedle
                ? <>
                    <b>No keys match “{keyFilter.trim()}”</b>
                    <span>in namespace <b>{activeNs}</b></span>
                    <button className="pool-empty-act" onClick={() => setKeyFilter("")}>Clear the filter</button>
                    <span className="pool-empty-hint">or pick another namespace on the left</span>
                  </>
                : <b>No keys in this namespace.</b>}
            </div>
          )}

          {grouped.map((group) => (
            <div className="key-group" key={group.name ?? "(ungrouped)"}>
              {group.name && (
                <div className="key-group-head">
                  <span className="kg-name">{group.name}</span>
                  <span className="kg-count">{group.rows.length}</span>
                </div>
              )}
              {group.rows.map(({ group: g, label }) => (
                <div
                  key={g.key}
                  className={`key-row ${group.name ? "in-group" : ""} ${selectedKey === g.key ? "sel" : ""}`}
                  onClick={() => setSelectedKey(g.key)}
                >
                  <span className="key-name" title={g.key}>{label}</span>
                  <span className="key-labels">
                    <span className="lblcount">{g.labels.length} label{g.labels.length === 1 ? "" : "s"}</span>
                    {/* Dot *and* word, never colour alone (A4). Reads across the labels, so it
                        marks keys with no no-label value too. */}
                    {g.drift.length > 0 && (
                      <span
                        className="diffmark"
                        title={g.allDistinct
                          ? `All ${g.labels.length} values differ from each other`
                          : `${g.drift.join(", ")} differ from the other ${g.labels.length - g.drift.length}`}
                      >
                        <DiffDot />{g.allDistinct ? "all differ" : `${g.drift.length} differ`}
                      </span>
                    )}
                  </span>
                  {/* The baseline: whichever value most labels agree on. When they all differ
                      there is no majority, so the no-label value stands in if there is one and
                      the cell says as much rather than picking a winner. */}
                  <span
                    className={`key-preview ${g.baseline ? "" : "is-nobase"}`}
                    title={g.baseline
                      ? `Shared by ${g.labels.length - g.drift.length} of ${g.labels.length} labels`
                      : `All ${g.labels.length} values differ, so there is no baseline`}
                  >
                    {g.baseline
                      ? preview(g.baseline.raw)
                      : g.noLabel ? preview(g.noLabel.raw) : <span className="faint">all differ</span>}
                  </span>
                  <span className={`key-type ty-${g.type}`}>{g.type}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* ---------------- detail ---------------- */}
      <div className="cfg-col cfg-detail">
        {selected && <DetailPane group={selected} onClose={() => setSelectedKey(null)} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- detail pane

function DetailPane({ group, onClose }: { group: KeyGroup; onClose: () => void }) {
  /**
   * §6: the pane opens on exactly what needs looking at — baseline expanded, labels that match
   * collapsed, labels that differ expanded. Keyed off the key so selecting another one resets.
   */
  const initialOpen = useMemo(() => {
    const open = new Set<string>();
    for (const l of group.labels) {
      // Open what needs looking at: the shared value once for reference, plus every label that
      // departs from it. Labels that agree stay collapsed.
      if (l.label === NO_LABEL || l === group.baseline || group.drift.includes(l.label)) open.add(l.label);
    }
    return open;
  }, [group]);

  const [open, setOpen] = useState<Set<string>>(initialOpen);
  useEffect(() => setOpen(initialOpen), [initialOpen]);

  const sectionRefs = useRef(new Map<string, HTMLDivElement>());
  const compact = isCompact(group);

  /* The lines every label holds. Everything outside it is what varies between environments —
     computed once for the key and handed to each section, so all of them mark the same lines. */
  const shared = useMemo(() => commonLines(group.labels.map((l) => l.raw)), [group]);

  const jumpTo = (label: string) => {
    setOpen((s) => new Set(s).add(label));
    // After the section has had a frame to expand, or it scrolls to its collapsed position.
    requestAnimationFrame(() =>
      sectionRefs.current.get(label)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };

  return (
    <>
      <div className="detail-head">
        <span className="detail-title" title={group.key}>{group.key}</span>
        <button className="btn ghost small icon-btn" title="Close" onClick={onClose}>✕</button>
      </div>

      {/* summary strip — how much these labels disagree, and which are the odd ones out */}
      {group.drift.length === 0 ? (
        <div className="lbl-summary">
          All {group.labels.length} value{group.labels.length === 1 ? "" : "s"} identical.
        </div>
      ) : group.allDistinct ? (
        <div className="lbl-summary has-diff">
          <DiffDot />
          <span>All <b>{group.labels.length}</b> values differ from each other.</span>
        </div>
      ) : (
        <div className="lbl-summary has-diff">
          <DiffDot />
          <span>
            <b>{group.drift.length}</b> of {group.labels.length} differ from the rest
          </span>
          <span className="jumps">
            {group.drift.map((l) => (
              <button key={l} className="jumpchip" onClick={() => jumpTo(l)}
                title={`Go to ${l || "no label"}`}>{l || "no label"}</button>
            ))}
          </span>
        </div>
      )}

      <div className="lbl-scroll">
        {compact
          ? <CompactValues
              group={group}
              register={(label, el) => { if (el) sectionRefs.current.set(label, el); }}
            />
          : group.labels.map((lv) => (
            <LabelSection
              key={lv.label}
              lv={lv}
              group={group}
              shared={shared}
              open={open.has(lv.label)}
              onToggle={() => setOpen((s) => {
                const n = new Set(s);
                n.has(lv.label) ? n.delete(lv.label) : n.add(lv.label);
                return n;
              })}
              register={(el) => { if (el) sectionRefs.current.set(lv.label, el); }}
            />
          ))}
      </div>
    </>
  );
}

/**
 * The tag a label's section carries. Measured against what the other labels hold, so it means the
 * same thing whether or not the key has a no-label value.
 */
function statusOf(lv: LabelValue, group: KeyGroup) {
  if (group.drift.length === 0) return { kind: "same" as const };
  if (!group.drift.includes(lv.label)) return { kind: "baseline" as const };
  return { kind: "differs" as const };
}

function LabelChip({ label }: { label: string }) {
  const isBase = label === NO_LABEL;
  return (
    <span className={`lblchip ${isBase ? "is-base" : "is-named"}`}>
      <span className="dot" />{isBase ? "no label" : label}
    </span>
  );
}

/**
 * §10: every value here is a short one-liner, so stacked sections would be two collapsible
 * panels and two code blocks to show two numbers. One row each instead.
 */
function CompactValues({ group, register }: {
  group: KeyGroup;
  /** Registered so the summary strip's jump chips reach a compact row too, not just a section. */
  register: (label: string, el: HTMLDivElement | null) => void;
}) {
  return (
    <div className="lbl-compact">
      {group.labels.map((lv) => {
        const st = statusOf(lv, group);
        return (
          <div className="lc-row" key={lv.label} ref={(el) => register(lv.label, el)}>
            <LabelChip label={lv.label} />
            <NoLabelMark lv={lv} />
            <StatusTag kind={st.kind} />
            <code className="lc-val">{canonical(lv.raw)}</code>
            <CopyButton value={lv.raw} />
          </div>
        );
      })}
    </div>
  );
}

function StatusTag({ kind }: { kind: "same" | "baseline" | "differs" }) {
  if (kind === "same") return <span className="lbl-tag is-same">SAME</span>;
  // Muted and not a pill: it names the value the others are measured against, not a verdict.
  if (kind === "baseline") return <span className="lbl-tag is-baseline">BASELINE</span>;
  // Dot plus word, so it survives greyscale (A4) without reading as a caution.
  return <span className="lbl-tag is-differs"><DiffDot />DIFFERS</span>;
}

/** The value the app resolves when no label is asked for — identity, separate from the baseline. */
function NoLabelMark({ lv }: { lv: LabelValue }) {
  return lv.label === NO_LABEL
    ? <span className="lbl-tag is-nolabel" title="What resolves when no label is requested">DEFAULT</span>
    : null;
}

function LabelSection({ lv, group, shared, open, onToggle, register }: {
  lv: LabelValue;
  group: KeyGroup;
  /** Lines every label holds; anything else is what varies between them. */
  shared: Map<string, number>;
  open: boolean;
  onToggle: () => void;
  register: (el: HTMLDivElement | null) => void;
}) {
  const st = statusOf(lv, group);
  /* Every section is marked, not just the departing ones: seeing which lines vary is as useful
     from the shared value's side as from an outlier's. When all labels agree, nothing marks. */
  const lines = useMemo(() => markLines(lv.raw, shared), [lv.raw, shared]);

  return (
    <div className={`lbl-sect ${open ? "open" : ""}`} ref={register}>
      <div className="lbl-head">
        <button className="lbl-chev" onClick={onToggle} aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${lv.label || "no label"}`}>
          <ChevronIcon />
        </button>
        <LabelChip label={lv.label} />
        <NoLabelMark lv={lv} />
        <StatusTag kind={st.kind} />
        <span className="sp" />
        <CopyButton value={lv.raw} />
      </div>
      {open && (
        <pre className="lbl-body">
          {/* Each line is its own block span and they are joined with NO newline — a newline
              between block spans renders an extra blank row per line. */}
          {lines.map((l, i) => (
            <span key={i} className={`cline ${l.changed ? "is-drift" : ""}`}>
              <Colourised text={l.text} />
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn ghost small"
      title="Copy this value"
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch { /* clipboard blocked */ }
      }}
    >
      {done ? "Copied ✓" : "Copy"}
    </button>
  );
}

/** JSON tokens coloured separately; anything else verbatim. Applied per line. */
function Colourised({ text }: { text: string }) {
  const parts = text.split(/("(?:\\.|[^"\\])*"\s*:?|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b)/g);
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
