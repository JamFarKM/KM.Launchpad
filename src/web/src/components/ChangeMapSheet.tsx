import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeMap } from "../types";
import { computeLayout, optimizeOrder, type EdgeLayout, type Rect } from "../lib/changeMapLayout";

interface Props {
  map: ChangeMap;
  connectorName: string;
  onCite: (path: string, line: number) => void;
  onClose: () => void;
}

/**
 * The change map sheet (DESIGN_SPEC_CHANGE_MAP.md).
 *
 * Ported from the design's `change-map-v1.html` mockup, where the routing, the label placement and
 * the crossing-minimising order were all worked out and verified against real data shapes — this
 * file is that engine reading the server's actual graph instead of a fixed fixture, plus the sheet
 * chrome around it. The geometry rules below are load-bearing, not decoration:
 *
 * - Edges are orthogonal, never curved (§6.1) — a curve leaves a card at a slant, which is what
 *   makes a reader hunt for where an edge came from.
 * - No edge may cross a card it doesn't belong to, and no edge may run along another edge's line —
 *   both are runtime obstacle checks against the actual laid-out geometry, not assumptions.
 * - Groups are ordered within their band by an exhaustive (or, past the group cap, hill-climbing)
 *   search over arrangements, scored by crossings first and column alignment second (§6.3).
 * - A label appears only on the edge being pointed at, searched into whichever of that edge's own
 *   segments — or the strip above/below its two cards — lands on the fewest cards and lines.
 */
export function ChangeMapSheet({ map, connectorName, onCite, onClose }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [flowOn, setFlowOn] = useState(false);
  const mapRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const byId = useMemo(() => new Map(map.groups.map((g) => [g.id, g])), [map.groups]);
  const depths = useMemo(
    () => [...new Set(map.groups.map((g) => g.depth))].sort((a, b) => b - a),
    [map.groups],
  );

  // Only edges spanning one band or staying inside one feed the ordering (§6.3) — a skip edge is
  // already routed around the bands between it, so letting it pull groups in a band it merely
  // passes through would trade a real crossing for an imaginary one.
  const shortEdges = useMemo(
    () => map.edges.filter((e) => {
      const a = byId.get(e.from)?.depth, b = byId.get(e.to)?.depth;
      return a !== undefined && b !== undefined && Math.abs(a - b) <= 1;
    }),
    [map.edges, byId],
  );

  const order = useMemo(() => optimizeOrder(map.groups, shortEdges, depths), [map.groups, shortEdges, depths]);

  const bandLabel = depthLabel(depths, map.layers ?? []);

  const [layout, setLayout] = useState<EdgeLayout[]>([]);

  // Re-measure whenever the data changes, the window resizes, or a selection changes which edges
  // are drawn as flow arrows — node positions don't move for that last one, but re-running is cheap
  // at this node count and keeps one code path.
  useLayoutEffect(() => {
    const container = mapRef.current;
    if (!container) return;

    const measure = () => {
      /* One shared card width, sized so the busiest band fits on a single row — the mockup's
         fitNodes(). Not decoration: the router treats the strip between bands as empty, so a band
         that wrapped would put cards where edges are routed. Past the floor the row scrolls instead
         of wrapping, which keeps the geometry honest. */
      const widest = Math.max(1, ...depths.map((d) => (order[d] ?? []).length));
      const row = container.querySelector<HTMLElement>(".map-nodes");
      const avail = row?.clientWidth ?? 0;
      if (avail > 0) {
        const w = Math.max(118, Math.min(196, Math.floor((avail - 22 * (widest - 1)) / widest)));
        container.style.setProperty("--map-node-w", `${w}px`);
      }

      const rects: Record<string, Rect> = {};
      const cRect = container.getBoundingClientRect();
      for (const [id, el] of nodeRefs.current) {
        const r = el.getBoundingClientRect();
        const left = r.left - cRect.left, top = r.top - cRect.top;
        rects[id] = { left, top, right: left + r.width, bottom: top + r.height,
                      cx: left + r.width / 2, cy: top + r.height / 2 };
      }
      /* Consecutive steps often land in the same group — a flow can return to the orchestrator
         twice — and an arrow from a card to itself has no route: the router would draw a backwards
         line from its right edge to its left. The step chips already carry the sequence, so those
         are simply not drawn. */
      const edgeList: { from: string; to: string; label: string; flowarrow?: boolean }[] = flowOn
        ? map.flow.slice(0, -1)
            .map((s, i) => ({ from: s.group, to: map.flow[i + 1].group, label: String(i + 1), flowarrow: true }))
            .filter((e) => e.from !== e.to)
        : map.edges;
      setLayout(computeLayout(edgeList, rects, byId, container.clientWidth));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    return () => ro.disconnect();
  }, [map, order, flowOn, byId, depths]);

  /* The dependency-rule overlay's own count (§5) — client-side arithmetic on the emitted graph, the
     same test the renderer uses to decide which edges draw dashed. */
  const violations = useMemo(
    () => map.edges.filter((e) => (byId.get(e.from)?.depth ?? 0) < (byId.get(e.to)?.depth ?? 0)).length,
    [map.edges, byId],
  );

  const group = selected ? byId.get(selected) : null;

  /* File names in the rail, shortened to the basename — except where two files in the selected group
     share one. A test project and its stub folder can both hold a `StubVoucherClient.cs`, and the
     list rendered them as two identical rows with different line counts and no way to tell which was
     which. Those get their parent directory back. The full path is on the tooltip either way. */
  const label = useMemo(() => {
    const seen = new Map<string, number>();
    for (const f of group?.files ?? []) {
      const base = f.path.split("/").pop() ?? f.path;
      seen.set(base, (seen.get(base) ?? 0) + 1);
    }
    return (path: string) => {
      const parts = path.split("/");
      const base = parts.pop() ?? path;
      return (seen.get(base) ?? 0) > 1 && parts.length ? `${parts[parts.length - 1]}/${base}` : base;
    };
  }, [group]);
  /* Every step number a group holds, not just one.
     This was a Map<group, step>, which silently kept only a group's *last* step: a flow that comes
     back to the orchestrator at 3 and 5, or enters and leaves through the edge layer at 1 and 6,
     lost the earlier number entirely — so the sequence on screen started at 2 and skipped 3. A group
     can be visited more than once, and the chip has to be able to say so. */
  const flowSteps = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const s of map.flow) m.set(s.group, [...(m.get(s.group) ?? []), s.step]);
    return m;
  }, [map.flow]);
  const litGroups = useMemo(() => {
    if (flowOn) return new Set(map.flow.map((s) => s.group));
    if (!selected) return null;
    const s = new Set([selected]);
    for (const e of map.edges) if (e.from === selected || e.to === selected) { s.add(e.from); s.add(e.to); }
    return s;
  }, [flowOn, selected, map.flow, map.edges]);

  return (
    <div className="map-overlay" onClick={onClose}>
      <div className="map-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="map-sheet-head">
          <span className="map-sheet-title">Change map</span>
          <span
            className={`map-pill ${map.styleBasis === "structure" ? "structure" : "inferred"}`}
            title={map.styleBasis === "structure"
              ? "The folders, projects or a checked-in doc say so outright."
              : "The agent's read of this repo's shape — not a build-system fact."}
          >
            {map.styleBasis === "structure" ? "FROM STRUCTURE" : "INFERRED"} · {styleName(map.style)}
          </span>
          {map.commitSha && <span className="map-commit">{map.commitSha.slice(0, 7)}</span>}
          <span style={{ flex: 1 }} />
          {map.flow.length > 0 && (
            <button className="ag-mini" aria-pressed={flowOn} onClick={() => setFlowOn((v) => !v)}>
              {flowOn ? "Hide user flow" : "Show user flow"}
            </button>
          )}
          <button className="ag-mini" onClick={onClose} title="Close (Esc)">✕</button>
        </div>

        <div className="map-sheet-main">
          <div className="map-diagram" ref={mapRef} data-mode={flowOn ? "flow" : selected ? "sel" : undefined}>
            {/* The axis names the *direction*, not the bands — those have their own labels. Feeding
                band names in here rendered "Infrastructure, config & tests → Core.Domain" sideways
                down a 13px strip, on top of everything else. */}
            {depths.length > 1 && <div className="map-axis">outer&nbsp;→&nbsp;core</div>}

            <svg className="map-edges" style={{ width: "100%", height: "100%" }}>
              <defs>
                <marker id="cm-arr" viewBox="0 0 8 8" refX="7.5" refY="4" markerWidth="8" markerHeight="8"
                  markerUnits="userSpaceOnUse" orient="auto-start-reverse">
                  <path d="M0.5 0.5 L7.5 4 L0.5 7.5 z" fill="context-stroke" />
                </marker>
              </defs>
              {layout.map((e, i) => {
                const isViol = !e.flowarrow && (byId.get(e.from)?.depth ?? 0) < (byId.get(e.to)?.depth ?? 0);
                const lit = e.flowarrow || (!!litGroups && litGroups.has(e.from) && litGroups.has(e.to));
                return (
                  <g key={i} className={`map-edge ${e.flowarrow ? "flowarrow lit" : isViol ? "viol" : ""} ${lit ? "lit" : ""}`}>
                    <path className="hit" d={e.d} />
                    <path className="line" d={e.d} markerEnd="url(#cm-arr)" />
                    {!e.flowarrow && (
                      <text className={e.anchor} x={e.lx} y={e.ly}>{e.label}</text>
                    )}
                  </g>
                );
              })}
            </svg>

            {depths.map((depth) => (
              <div className="map-band" key={depth}>
                {/* Always rendered, even when unnamed: the grid's first column is what keeps every
                    band's cards in the same columns, which is what lets a dependency be a straight
                    vertical line. */}
                <div className="map-band-label">{depths.length > 1 ? bandLabel(depth) : ""}</div>
                <div className="map-nodes">
                  {(order[depth] ?? []).map((id) => {
                    const g = byId.get(id);
                    if (!g) return null;
                    const added = g.files.reduce((n, f) => n + f.added, 0);
                    const removed = g.files.reduce((n, f) => n + f.removed, 0);
                    return (
                      <button
                        key={id}
                        id={id}
                        ref={(el) => { if (el) nodeRefs.current.set(id, el); else nodeRefs.current.delete(id); }}
                        /* `lit` is what the dimming reads. Computing litGroups and never applying it
                           left every card at 0.28 opacity the moment anything was selected or the
                           flow was shown — the whole diagram greyed out with nothing standing up. */
                        className={`map-node${litGroups?.has(id) ? " lit" : ""}`}
                        aria-pressed={selected === id}
                        onClick={() => setSelected((s) => (s === id ? null : id))}
                      >
                        {flowOn && flowSteps.has(id) && (
                          <span className="map-step">{flowSteps.get(id)!.join("·")}</span>
                        )}
                        <div className="map-node-name">{g.name}</div>
                        <div className="map-node-meta">
                          <span>{g.files.length} file{g.files.length === 1 ? "" : "s"}</span>
                          {added > 0 && <span className="add">+{added}</span>}
                          {removed > 0 && <span className="del">−{removed}</span>}
                        </div>
                        {g.findingCount > 0 && <div className="map-node-find">{g.findingCount} review finding{g.findingCount === 1 ? "" : "s"}</div>}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="map-rail">
            {!group ? (
              <div className="map-rail-head">
                <h3>{map.groups.length} area{map.groups.length === 1 ? "" : "s"} changed</h3>
                <p className="map-rail-sum">Select an area to see its files and the agent's read of what changed there.</p>
              </div>
            ) : (
              <>
                <div className="map-rail-head">
                  <h3>{group.name}</h3>
                  <p className="map-rail-sum">{group.summary}</p>
                </div>
                <div className="map-rail-files">
                  {group.files.map((f) => (
                    <button key={f.path} className="map-file" title={f.path} onClick={() => onCite(f.path, 1)}>
                      {label(f.path)}
                      <span className="map-file-counts">
                        {f.added > 0 && <span className="add">+{f.added}</span>}{" "}
                        {f.removed > 0 && <span className="del">−{f.removed}</span>}
                      </span>
                    </button>
                  ))}
                </div>
                <p className="map-rail-hint">Jumps the diff to that file and closes the map.</p>
              </>
            )}
          </div>
        </div>

        {flowOn && (
          <div className="map-flow-sentence">
            {map.flow.map((s, i) => (
              <span key={s.step}>
                {i > 0 && " → "}
                <b>{s.step}</b> {s.action}
              </span>
            ))}
          </div>
        )}

        <div className="map-sheet-foot">
          {violations > 0 ? (
            <>
              <b>{violations} of {map.edges.length} edges point outward</b>, against this
              architecture's own rule — drawn dashed amber. That is arithmetic on the graph, not the
              model grading itself.{" "}
            </>
          ) : (
            <>No edge points outward: every dependency here runs toward the core.{" "}</>
          )}
          Point at an edge to see what it does. Grouping by <b>{connectorName}</b>; not a
          build-system fact.
        </div>
      </div>
    </div>
  );
}

function styleName(style: string): string {
  switch (style) {
    case "clean": return "clean architecture";
    case "layers": return "layered";
    case "modules": return "modules";
    case "pipeline": return "pipeline";
    default: return "unclassified";
  }
}

/**
 * depth → a readable band name, from the agent's own `layers` when it supplied one.
 *
 * The fallback names only the two extremes, because those are the two the axis itself establishes.
 * An earlier version numbered the rest — producing band labels reading "DEPTH 2", which names a
 * position on the axis and says nothing about what lives there. A blank is more honest than that:
 * the group cards in the row already say what is in it.
 */
function depthLabel(depths: number[], layers: { depth: number; name: string }[]): (d: number) => string {
  const named = new Map(layers.map((l) => [l.depth, l.name]));
  const min = Math.min(...depths), max = Math.max(...depths);
  return (d: number) => {
    const own = named.get(d);
    if (own) return own;
    if (depths.length === 1) return "Areas changed";
    if (d === min) return "Core";
    if (d === max) return "Outer";
    return "";
  };
}

