import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeMap } from "../types";
import { computeLayout, optimizeOrder, type EdgeLayout, type Rect } from "../lib/changeMapLayout";

interface Props {
  map: ChangeMap;
  /**
   * The group to light, driven from outside — the wizard's current step. When set, it overrides the
   * diagram's own click-selection, because in a walkthrough the slide decides what is being looked
   * at and the diagram follows.
   */
  focusGroup?: string | null;
  /** Clicking a card. The wizard jumps its deck to that group's step. */
  onPick?: (groupId: string) => void;
  /** Draw the flow arrows and the numbered step chips. */
  showFlow?: boolean;
  /** Allow dragging the diagram around — for panes too narrow to hold it (§8). */
  pannable?: boolean;
}

/**
 * The change map's diagram (DESIGN_SPEC_CHANGE_MAP.md §6): bands, group cards, routed edges.
 *
 * Split out of the old standalone sheet so the wizard can hold it in a pane beside the slides and
 * drive which group is lit. The layout engine it calls lives in `lib/changeMapLayout.ts` with its
 * own tests; this file is the DOM and the measuring.
 *
 * Measurement is relative to the panned layer rather than the viewport, so dragging the diagram
 * cannot move the edges relative to the cards — pan is a transform on a container that holds the
 * SVG and the cards together.
 */
export function ChangeMapDiagram({ map, focusGroup, onPick, showFlow, pannable }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ id: number; x: number; y: number; ox: number; oy: number } | null>(null);

  const outerRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());

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
  const bandLabel = useMemo(() => depthLabel(depths, map.layers ?? []), [depths, map.layers]);

  const [layout, setLayout] = useState<EdgeLayout[]>([]);

  useLayoutEffect(() => {
    const plane = panRef.current;
    if (!plane) return;

    const measure = () => {
      /* One shared card width, sized so the busiest band fits a single row. Not decoration: the
         router treats the strip between bands as empty, so a band that wrapped would put cards where
         edges are routed. Past the floor the row overflows and the reviewer pans instead. */
      const widest = Math.max(1, ...depths.map((d) => (order[d] ?? []).length));
      const row = plane.querySelector<HTMLElement>(".map-nodes");
      const avail = row?.clientWidth ?? 0;
      if (avail > 0) {
        const w = Math.max(118, Math.min(196, Math.floor((avail - 22 * (widest - 1)) / widest)));
        plane.style.setProperty("--map-node-w", `${w}px`);
      }

      // Relative to the panned plane, so the pan transform cancels out of every coordinate.
      const rects: Record<string, Rect> = {};
      const origin = plane.getBoundingClientRect();
      for (const [id, el] of nodeRefs.current) {
        const r = el.getBoundingClientRect();
        const left = r.left - origin.left, top = r.top - origin.top;
        rects[id] = { left, top, right: left + r.width, bottom: top + r.height,
                      cx: left + r.width / 2, cy: top + r.height / 2 };
      }

      /* Consecutive steps often land in the same group — a flow can return to the orchestrator
         twice — and an arrow from a card to itself has no route. The step chips carry the sequence,
         so those are simply not drawn. */
      const edgeList = showFlow
        ? map.flow.slice(0, -1)
            .map((s, i) => ({ from: s.group, to: map.flow[i + 1].group, label: String(i + 1), flowarrow: true }))
            .filter((e) => e.from !== e.to)
        : map.edges;
      setLayout(computeLayout(edgeList, rects, byId, plane.clientWidth));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(plane);
    return () => ro.disconnect();
  }, [map, order, showFlow, byId, depths]);

  const flowSteps = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const s of map.flow) m.set(s.group, [...(m.get(s.group) ?? []), s.step]);
    return m;
  }, [map.flow]);

  /* What is lit. A focus from outside wins outright: during a walkthrough the slide is in charge,
     and a stale click-selection competing with it would light two unrelated areas at once. */
  const litGroups = useMemo(() => {
    if (focusGroup) {
      const s = new Set([focusGroup]);
      for (const e of map.edges) if (e.from === focusGroup || e.to === focusGroup) { s.add(e.from); s.add(e.to); }
      return s;
    }
    if (!selected) return null;
    const s = new Set([selected]);
    for (const e of map.edges) if (e.from === selected || e.to === selected) { s.add(e.from); s.add(e.to); }
    return s;
  }, [focusGroup, selected, map.edges]);

  const active = focusGroup ?? selected;

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!pannable || e.button !== 0) return;
    // Never from a card — those are buttons, and a click on one must stay a click.
    if ((e.target as HTMLElement).closest("button")) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: pan.x, oy: pan.y };
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add("is-map-panning");
    e.preventDefault();
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    setPan({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) });
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!drag.current || e.pointerId !== drag.current.id) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    document.body.classList.remove("is-map-panning");
  }

  return (
    <div
      className={`map-diagram${pannable ? " is-pannable" : ""}`}
      ref={outerRef}
      data-mode={litGroups ? (focusGroup ? "flow" : "sel") : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => pannable && setPan({ x: 0, y: 0 })}
      title={pannable ? "Drag to pan; double-click to recentre" : undefined}
    >
      {/* The axis names the direction, not the bands — and stays put while the plane pans. */}
      {depths.length > 1 && <div className="map-axis">outer&nbsp;→&nbsp;core</div>}

      <div className="map-pan" ref={panRef} style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}>
        <svg className="map-edges">
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
                {!e.flowarrow && <text className={e.anchor} x={e.lx} y={e.ly}>{e.label}</text>}
              </g>
            );
          })}
        </svg>

        {depths.map((depth) => (
          <div className="map-band" key={depth}>
            {/* Always rendered, even when unnamed: the grid's first column is what keeps every band's
                cards in the same columns, which is what lets a dependency be a straight vertical. */}
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
                    ref={(el) => { if (el) nodeRefs.current.set(id, el); else nodeRefs.current.delete(id); }}
                    className={`map-node${litGroups?.has(id) ? " lit" : ""}`}
                    aria-pressed={active === id}
                    onClick={() => (onPick ? onPick(id) : setSelected((s) => (s === id ? null : id)))}
                  >
                    {showFlow && flowSteps.has(id) && (
                      <span className="map-step">{flowSteps.get(id)!.join("·")}</span>
                    )}
                    <div className="map-node-name">{g.name}</div>
                    <div className="map-node-meta">
                      <span>{g.files.length} file{g.files.length === 1 ? "" : "s"}</span>
                      {added > 0 && <span className="add">+{added}</span>}
                      {removed > 0 && <span className="del">−{removed}</span>}
                    </div>
                    {g.findingCount > 0 && (
                      <div className="map-node-find">
                        {g.findingCount} review finding{g.findingCount === 1 ? "" : "s"}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function styleName(style: string): string {
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
 * position on the axis and says nothing about what lives there. A blank is more honest: the group
 * cards in the row already say what is in it.
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
