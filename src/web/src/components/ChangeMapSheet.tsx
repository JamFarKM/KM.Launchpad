import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeMap, ChangeMapEdge, ChangeMapGroup } from "../types";

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
      const edgeList: { from: string; to: string; label: string; flowarrow?: boolean }[] = flowOn
        ? map.flow.slice(0, -1).map((s, i) => ({ from: s.group, to: map.flow[i + 1].group, label: String(i + 1), flowarrow: true }))
        : map.edges;
      setLayout(computeLayout(edgeList, rects, byId, container.clientWidth));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    return () => ro.disconnect();
  }, [map, order, flowOn, byId, depths]);

  const group = selected ? byId.get(selected) : null;
  const flowIndex = useMemo(() => new Map(map.flow.map((s) => [s.group, s.step])), [map.flow]);
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
            {depths.length > 1 && <div className="map-axis">{bandLabel(depths[0])}&nbsp;→&nbsp;{bandLabel(depths[depths.length - 1])}</div>}

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
                        className="map-node"
                        aria-pressed={selected === id}
                        onClick={() => setSelected((s) => (s === id ? null : id))}
                      >
                        {flowOn && flowIndex.has(id) && <span className="map-step">{flowIndex.get(id)}</span>}
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
              <>
                <h3>{map.groups.length} area{map.groups.length === 1 ? "" : "s"} changed</h3>
                <p className="map-rail-sum">Select an area to see its files and the agent's read of what changed there.</p>
              </>
            ) : (
              <>
                <h3>{group.name}</h3>
                <p className="map-rail-sum">{group.summary}</p>
                {group.files.map((f) => (
                  <button key={f.path} className="map-file" onClick={() => onCite(f.path, 1)}>
                    {f.path.split("/").pop()}
                    <span className="map-file-counts">
                      {f.added > 0 && <span className="add">+{f.added}</span>}{" "}
                      {f.removed > 0 && <span className="del">−{f.removed}</span>}
                    </span>
                  </button>
                ))}
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
          Point at an edge to see what it does. A <b>dashed amber</b> edge points outward, against
          this architecture's own rule — arithmetic on the graph, not the model grading itself.
          Grouping by <b>{connectorName}</b>; not a build-system fact.
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

// ---------------------------------------------------------------------------------------------
// Layout engine — ported from change-map-v1.html. Pure functions over plain data, so this half of
// the file has no dependency on React and could be lifted verbatim if the diagram ever needed a
// different host.
// ---------------------------------------------------------------------------------------------

interface Rect { left: number; top: number; right: number; bottom: number; cx: number; cy: number; }
interface EdgeLayout { from: string; to: string; label: string; d: string; lx: number; ly: number; anchor: string; flowarrow?: boolean; }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Orthogonal path through axis-aligned waypoints, with rounded corners (§6.1). */
function orthPath(pts: { x: number; y: number }[]): string {
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i], prev = pts[i - 1], next = pts[i + 1];
    const inLen = Math.hypot(p.x - prev.x, p.y - prev.y);
    const outLen = Math.hypot(next.x - p.x, next.y - p.y);
    const r = Math.min(9, inLen / 2, outLen / 2);
    const ai = { x: p.x - Math.sign(p.x - prev.x) * r, y: p.y - Math.sign(p.y - prev.y) * r };
    const bo = { x: p.x + Math.sign(next.x - p.x) * r, y: p.y + Math.sign(next.y - p.y) * r };
    d += ` L ${ai.x} ${ai.y} Q ${p.x} ${p.y} ${bo.x} ${bo.y}`;
  }
  const last = pts[pts.length - 1];
  return d + ` L ${last.x} ${last.y}`;
}

function segmentBlocked(
  pts: { x: number; y: number }[], exclude: string[], rects: Record<string, Rect>,
): boolean {
  const pad = 5;
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i], q = pts[i + 1];
    const vertical = Math.abs(p.x - q.x) < 0.5;
    for (const [id, r] of Object.entries(rects)) {
      if (exclude.includes(id)) continue;
      const L = r.left - pad, R = r.right + pad, T = r.top - pad, B = r.bottom + pad;
      const hit = vertical
        ? p.x > L && p.x < R && Math.max(p.y, q.y) > T && Math.min(p.y, q.y) < B
        : p.y > T && p.y < B && Math.max(p.x, q.x) > L && Math.min(p.x, q.x) < R;
      if (hit) return true;
    }
  }
  return false;
}

/** Tracks routed segments so the next edge can avoid running along one it doesn't own (§6.1). */
function makeLanes() {
  const vert: { x: number; y1: number; y2: number }[] = [];
  const horz: { y: number; x1: number; x2: number }[] = [];
  const overlaps = (a1: number, a2: number, b1: number, b2: number) =>
    Math.max(a1, a2) > Math.min(b1, b2) - 4 && Math.min(a1, a2) < Math.max(b1, b2) + 4;
  const within = (v: number, a: number, b: number) => v > Math.min(a, b) - 3 && v < Math.max(a, b) + 3;
  return {
    collinearV: (x: number, y1: number, y2: number) => vert.some((s) => Math.abs(s.x - x) < 9 && overlaps(y1, y2, s.y1, s.y2)),
    crossV: (x: number, y1: number, y2: number) => horz.filter((s) => within(x, s.x1, s.x2) && within(s.y, y1, y2)).length,
    boxHits: (x1: number, x2: number, y1: number, y2: number) => {
      const pad = 2;
      return vert.filter((s) => s.x > x1 - pad && s.x < x2 + pad && Math.max(s.y1, s.y2) > y1 - pad && Math.min(s.y1, s.y2) < y2 + pad).length
        + horz.filter((s) => s.y > y1 - pad && s.y < y2 + pad && Math.max(s.x1, s.x2) > x1 - pad && Math.min(s.x1, s.x2) < x2 + pad).length;
    },
    add: (pts: { x: number; y: number }[]) => {
      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i], q = pts[i + 1];
        if (Math.abs(p.x - q.x) < 0.5) vert.push({ x: p.x, y1: p.y, y2: q.y });
        else horz.push({ y: p.y, x1: p.x, x2: q.x });
      }
    },
  };
}

function pickGutter(lanes: ReturnType<typeof makeLanes>, base: number, x1: number, x2: number): number {
  let best = base, bestCost = Infinity;
  for (const off of [0, 9, -9, 18, -18]) {
    const y = base + off;
    const cost = (lanes.collinearV(y, x1, x2) ? 400 : 0) + lanes.crossV(y, x1, x2) * 12 + Math.abs(off);
    if (cost < bestCost) { bestCost = cost; best = y; }
  }
  return best;
}

function corridors(rects: Record<string, Rect>, byBand: Record<number, string[]>): number[] {
  const xs = new Set<number>();
  for (const ids of Object.values(byBand)) {
    const rs = ids.map((id) => rects[id]).filter(Boolean).sort((a, b) => a.left - b.left);
    for (let i = 0; i < rs.length - 1; i++) xs.add((rs[i].right + rs[i + 1].left) / 2);
    if (rs.length) xs.add(rs[rs.length - 1].right + 13);
  }
  return [...xs];
}

function aroundRoute(
  from: string, to: string, rects: Record<string, Rect>, byBand: Record<number, string[]>, lanes: ReturnType<typeof makeLanes>,
): { d: string; pts: { x: number; y: number }[] } {
  const A = rects[from], B = rects[to], gap = 2;
  const down = B.top > A.top;
  const baseA = down ? A.bottom + 15 : A.top - 15;
  const baseB = down ? B.top - 15 : B.bottom + 15;
  const xA = clamp(B.cx, A.left + 16, A.right - 16);
  const xB = clamp(A.cx, B.left + 16, B.right - 16);
  const lo = Math.min(baseA, baseB), hi = Math.max(baseA, baseB);

  const ideal = (A.cx + B.cx) / 2;
  const lane = corridors(rects, byBand)
    .filter((x) => !segmentBlocked([{ x, y: lo }, { x, y: hi }], [from, to], rects))
    .map((x) => ({ x, cost: (lanes.collinearV(x, lo, hi) ? 400 : 0) + lanes.crossV(x, lo, hi) * 25 + Math.abs(x - ideal) }))
    .sort((p, q) => p.cost - q.cost)[0]?.x ?? 0;

  if (Math.abs(lane - xA) < 7 && Math.abs(lane - xB) < 7) {
    const pts = [{ x: lane, y: down ? A.bottom + gap : A.top - gap }, { x: lane, y: down ? B.top - gap : B.bottom + gap }];
    lanes.add(pts);
    return { d: orthPath(pts), pts };
  }

  const yA = pickGutter(lanes, baseA, xA, lane);
  const yB = pickGutter(lanes, baseB, lane, xB);
  const pts = [{ x: xA, y: down ? A.bottom + gap : A.top - gap }, { x: xA, y: yA },
               { x: lane, y: yA }, { x: lane, y: yB }, { x: xB, y: yB },
               { x: xB, y: down ? B.top - gap : B.bottom + gap }];
  lanes.add(pts);
  return { d: orthPath(pts), pts };
}

function routeFor(
  from: string, to: string, byId: Map<string, ChangeMapGroup>, rects: Record<string, Rect>,
  byBand: Record<number, string[]>, lanes: ReturnType<typeof makeLanes>,
): { d: string; pts: { x: number; y: number }[] } {
  const A = rects[from], B = rects[to], gap = 2;
  const dA = byId.get(from)?.depth ?? 0, dB = byId.get(to)?.depth ?? 0;

  if (Math.abs(dA - dB) >= 2) return aroundRoute(from, to, rects, byBand, lanes);

  if (dA === dB && Math.abs(A.cy - B.cy) < 4) {
    const fromLeft = A.cx <= B.cx;
    const y = A.cy;
    const pts = [{ x: fromLeft ? A.right + gap : A.left - gap, y }, { x: fromLeft ? B.left - gap : B.right + gap, y }];
    if (segmentBlocked(pts, [from, to], rects)) return aroundRoute(from, to, rects, byBand, lanes);
    lanes.add(pts);
    return { d: orthPath(pts), pts };
  }

  const down = B.top > A.top;
  const y1 = down ? A.bottom + gap : A.top - gap;
  const y2 = down ? B.top - gap : B.bottom + gap;
  const x1 = clamp(B.cx, A.left + 16, A.right - 16);
  const x2 = clamp(A.cx, B.left + 16, B.right - 16);

  if (Math.abs(x1 - x2) < 7) {
    const x = (x1 + x2) / 2;
    const pts = [{ x, y: y1 }, { x, y: y2 }];
    if (segmentBlocked(pts, [from, to], rects)) return aroundRoute(from, to, rects, byBand, lanes);
    lanes.add(pts);
    return { d: orthPath(pts), pts };
  }

  const my = pickGutter(lanes, (y1 + y2) / 2, x1, x2);
  const pts = [{ x: x1, y: y1 }, { x: x1, y: my }, { x: x2, y: my }, { x: x2, y: y2 }];
  if (segmentBlocked(pts, [from, to], rects)) return aroundRoute(from, to, rects, byBand, lanes);
  lanes.add(pts);
  return { d: orthPath(pts), pts };
}

/** Candidate label spots along an edge's own path: every segment, longest first. */
function labelAnchors(pts: { x: number; y: number }[]): { x: number; y: number; anchor: string; len: number }[] {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i], q = pts[i + 1];
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    if (len < 16) continue;
    if (Math.abs(p.x - q.x) < 0.5) out.push({ x: p.x + 8, y: (p.y + q.y) / 2, anchor: "", len });
    else out.push({ x: (p.x + q.x) / 2, y: Math.min(p.y, q.y) - 5, anchor: "mid", len });
  }
  return out.sort((a, b) => b.len - a.len);
}

/** Where a label can actually be read: searched against the finished picture, not derived (§4). */
function placeLabel(
  lanes: ReturnType<typeof makeLanes>, pts: { x: number; y: number }[], label: string,
  A: Rect, B: Rect, mapWidth: number,
): { x: number; y: number; anchor: string } {
  const w = label.length * 5.8;
  const anchors = labelAnchors(pts);
  const midX = (A.cx + B.cx) / 2;
  anchors.push({ x: midX, y: Math.max(A.bottom, B.bottom) + 13, anchor: "mid", len: 0 });
  anchors.push({ x: midX, y: Math.min(A.top, B.top) - 7, anchor: "mid", len: 0 });

  let best: { x: number; y: number; anchor: string; cost: number } | null = null;
  for (const a of anchors) {
    for (const dy of [0, -13, 13, -26, 26]) {
      const y = a.y + dy, top = y - 9;
      const x1 = a.anchor === "mid" ? a.x - w / 2 : a.x;
      if (x1 < 2 || x1 + w > mapWidth - 2) continue;
      const cost = lanes.boxHits(x1, x1 + w, top, y) * 10 + Math.abs(dy);
      if (!best || cost < best.cost) best = { x: a.x, y, anchor: a.anchor, cost };
      if (cost === 0) break;
    }
    if (best?.cost === 0) break;
  }
  return best ?? { x: pts[0].x, y: pts[0].y - 8, anchor: "mid" };
}

function computeLayout(
  edges: { from: string; to: string; label: string; flowarrow?: boolean }[],
  rects: Record<string, Rect>, byId: Map<string, ChangeMapGroup>, mapWidth: number,
): EdgeLayout[] {
  const byBand: Record<number, string[]> = {};
  for (const [id, g] of byId) (byBand[g.depth] ??= []).push(id);
  for (const ids of Object.values(byBand)) ids.sort((a, b) => (rects[a]?.left ?? 0) - (rects[b]?.left ?? 0));

  const lanes = makeLanes();
  const out: EdgeLayout[] = [];
  for (const e of edges) {
    if (!rects[e.from] || !rects[e.to]) continue;
    const { d, pts } = routeFor(e.from, e.to, byId, rects, byBand, lanes);
    const spot = e.flowarrow
      ? { x: 0, y: 0, anchor: "" }
      : placeLabel(lanes, pts, e.label, rects[e.from], rects[e.to], mapWidth);
    out.push({ from: e.from, to: e.to, label: e.label, d, lx: spot.x, ly: spot.y, anchor: spot.anchor, flowarrow: e.flowarrow });
  }
  return out;
}

/**
 * Group order within each band, searched to minimise how often edges cross (§6.3).
 *
 * Exhaustive within the group cap (§2 caps a map at 8), which beats a heuristic that can stall in a
 * local minimum; past that it falls back to a bounded hill-climb so a raised cap degrades instead
 * of hanging.
 */
function optimizeOrder(
  groups: ChangeMapGroup[], shortEdges: ChangeMapEdge[], depths: number[],
): Record<number, string[]> {
  const byDepth: Record<number, string[]> = {};
  for (const d of depths) byDepth[d] = groups.filter((g) => g.depth === d).map((g) => g.id);
  const depthOf = new Map(groups.map((g) => [g.id, g.depth]));

  function crossings(ord: Record<number, string[]>): number {
    let n = 0;
    for (let i = 0; i < depths.length - 1; i++) {
      const top = depths[i], bot = depths[i + 1];
      const pt = new Map(ord[top].map((id, ix) => [id, ix]));
      const pb = new Map(ord[bot].map((id, ix) => [id, ix]));
      const pairs = shortEdges
        .filter((e) => (depthOf.get(e.from) === top && depthOf.get(e.to) === bot)
                    || (depthOf.get(e.to) === top && depthOf.get(e.from) === bot))
        .map((e) => depthOf.get(e.from) === top ? [pt.get(e.from)!, pb.get(e.to)!] : [pt.get(e.to)!, pb.get(e.from)!]);
      for (let a = 0; a < pairs.length; a++)
        for (let b = a + 1; b < pairs.length; b++)
          if ((pairs[a][0] - pairs[b][0]) * (pairs[a][1] - pairs[b][1]) < 0) n++;
    }
    return n;
  }

  function aligned(ord: Record<number, string[]>): number {
    const pos: Record<string, number> = {};
    for (const ids of Object.values(ord)) ids.forEach((id, ix) => { pos[id] = ix; });
    let n = 0;
    for (const e of shortEdges) if (pos[e.from] === pos[e.to] && depthOf.get(e.from) !== depthOf.get(e.to)) n++;
    return n;
  }

  const score = (ord: Record<number, string[]>) => crossings(ord) * 100 - aligned(ord) * 6;

  const factorial = (n: number): number => (n <= 1 ? 1 : n * factorial(n - 1));
  const total = depths.reduce((acc, d) => acc * factorial(byDepth[d].length), 1);
  const start: Record<number, string[]> = {};
  for (const d of depths) start[d] = [...byDepth[d]];

  if (total <= 50000) {
    const perms = (a: string[]): string[][] => (a.length <= 1 ? [a]
      : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
    const options = depths.map((d) => perms(byDepth[d]));
    let best = start, bestScore = Infinity;
    const walk = (i: number, acc: string[][]) => {
      if (i === depths.length) {
        const ord: Record<number, string[]> = {};
        depths.forEach((d, k) => { ord[d] = acc[k]; });
        const s = score(ord);
        if (s < bestScore) { bestScore = s; best = ord; }
        return;
      }
      for (const p of options[i]) walk(i + 1, [...acc, p]);
    };
    walk(0, []);
    return best;
  }

  let cur = start, curScore = score(cur);
  for (let i = 0; i < 4000; i++) {
    const d = depths[Math.floor(Math.random() * depths.length)];
    if (byDepth[d].length < 2) continue;
    const next: Record<number, string[]> = {};
    for (const k of depths) next[k] = [...cur[k]];
    const a = Math.floor(Math.random() * next[d].length);
    const b = Math.floor(Math.random() * next[d].length);
    [next[d][a], next[d][b]] = [next[d][b], next[d][a]];
    const s = score(next);
    if (s <= curScore) { cur = next; curScore = s; }
  }
  return cur;
}
