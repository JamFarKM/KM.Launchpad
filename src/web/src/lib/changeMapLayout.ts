import type { ChangeMapEdge, ChangeMapGroup } from "../types";

/**
 * The change map's layout engine (DESIGN_SPEC_CHANGE_MAP.md §6).
 *
 * Pure functions over plain data — rectangles in, SVG paths out — with no dependency on React or the
 * DOM. That separation is not tidiness: this engine was hand-ported from `change-map-v1.html` and
 * shipped two geometry bugs that no amount of looking at the app would have localised (a card width
 * that let bands wrap through the routing strip, and a lane picker calling the vertical
 * overlap-checks for horizontal runs). Both are the kind of thing a test over fixed rectangles
 * catches immediately, which is why it lives here with one.
 */

// ---------------------------------------------------------------------------------------------
// Layout engine — ported from change-map-v1.html. Pure functions over plain data, so this half of
// the file has no dependency on React and could be lifted verbatim if the diagram ever needed a
// different host.
// ---------------------------------------------------------------------------------------------

export interface Rect { left: number; top: number; right: number; bottom: number; cx: number; cy: number; }
export interface EdgeLayout { from: string; to: string; label: string; d: string; lx: number; ly: number; anchor: string; flowarrow?: boolean; }

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

export function segmentBlocked(
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
export function makeLanes() {
  const vert: { x: number; y1: number; y2: number }[] = [];
  const horz: { y: number; x1: number; x2: number }[] = [];
  const exits = new Map<string, number>();
  const overlaps = (a1: number, a2: number, b1: number, b2: number) =>
    Math.max(a1, a2) > Math.min(b1, b2) - 4 && Math.min(a1, a2) < Math.max(b1, b2) + 4;
  const within = (v: number, a: number, b: number) => v > Math.min(a, b) - 3 && v < Math.max(a, b) + 3;
  return {
    // Four, in two pairs: V for a vertical run at x spanning y1..y2, H for a horizontal run at y
    // spanning x1..x2. The port originally carried only the V pair, so pickGutter — which places
    // horizontal runs — was calling collinearV with a y in the x argument. It compared a height
    // against a set of x coordinates, matched nothing, reported every lane equally free, and handed
    // every horizontal run the same one. That is the stack of overlapping edges.
    collinearV: (x: number, y1: number, y2: number) => vert.some((s) => Math.abs(s.x - x) < 9 && overlaps(y1, y2, s.y1, s.y2)),
    collinearH: (y: number, x1: number, x2: number) => horz.some((s) => Math.abs(s.y - y) < 9 && overlaps(x1, x2, s.x1, s.x2)),
    crossV: (x: number, y1: number, y2: number) => horz.filter((s) => within(x, s.x1, s.x2) && within(s.y, y1, y2)).length,
    crossH: (y: number, x1: number, x2: number) => vert.filter((s) => within(y, s.y1, s.y2) && within(s.x, x1, x2)).length,
    boxHits: (x1: number, x2: number, y1: number, y2: number) => {
      const pad = 2;
      return vert.filter((s) => s.x > x1 - pad && s.x < x2 + pad && Math.max(s.y1, s.y2) > y1 - pad && Math.min(s.y1, s.y2) < y2 + pad).length
        + horz.filter((s) => s.y > y1 - pad && s.y < y2 + pad && Math.max(s.x1, s.x2) > x1 - pad && Math.min(s.x1, s.x2) < x2 + pad).length;
    },
    /* Which drop-slot along a card's edge this connection gets.
       Two edges leaving one card toward the same side clamp to the same exit x, so their vertical
       drops land on the same line and stack — the horizontal lanes were being separated correctly
       while the verticals feeding them were not. A running count per card spreads them. */
    slot: (id: string) => { const n = exits.get(id) ?? 0; exits.set(id, n + 1); return n; },
    add: (pts: { x: number; y: number }[]) => {
      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i], q = pts[i + 1];
        if (Math.abs(p.x - q.x) < 0.5) vert.push({ x: p.x, y1: p.y, y2: q.y });
        else horz.push({ y: p.y, x1: p.x, x2: q.x });
      }
    },
  };
}

/**
 * Which track in the band gutter a horizontal run should take.
 *
 * `dir` is the way out of the source card — down for an edge heading to a lower band, up for one
 * heading higher — and the offsets prefer travelling further into the gutter over crossing back
 * toward the card row, which is where the cards themselves are.
 */
function pickGutter(
  lanes: ReturnType<typeof makeLanes>, base: number, x1: number, x2: number, dir: 1 | -1,
): number {
  let best = base, bestCost = Infinity;
  for (const off of [0, 9 * dir, 18 * dir, -9 * dir, 27 * dir]) {
    const y = base + off;
    const cost = (lanes.collinearH(y, x1, x2) ? 400 : 0) + lanes.crossH(y, x1, x2) * 12 + Math.abs(off);
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

  /* Same band, non-adjacent columns: a U through the gutter below the row.
   *
   * No vertical corridor is involved, because the detour is sideways — it leaves the bottom of one
   * card, takes one lane of the gutter, and comes back up into the bottom of the other. The generic
   * path below derives its direction from `B.top > A.top`, which is false when the tops are equal:
   * these were being sent up over the top of one card and in through the bottom of the other,
   * crossing the whole band vertically in order to travel sideways. Keeping both ends on the same
   * side is also what lets the lane picker stack several of them without any two meeting. */
  if (Math.abs(A.top - B.top) < 4) {
    // Each connection takes its own slot along the card's bottom edge, stepping inward from the side
    // that faces the other card. Without that, every edge leaving one card rightward clamped to the
    // same exit x and their vertical drops sat on one line, however well the horizontals were spread.
    const dirA = B.cx > A.cx ? 1 : -1, dirB = A.cx > B.cx ? 1 : -1;
    const xa = clamp((dirA > 0 ? A.right - 16 : A.left + 16) - dirA * lanes.slot(from) * 16,
                     A.left + 14, A.right - 14);
    const xb = clamp((dirB > 0 ? B.right - 16 : B.left + 16) - dirB * lanes.slot(to) * 16,
                     B.left + 14, B.right - 14);
    const y = pickGutter(lanes, Math.max(A.bottom, B.bottom) + 18, xa, xb, 1);
    const pts = [{ x: xa, y: A.bottom + gap }, { x: xa, y }, { x: xb, y }, { x: xb, y: B.bottom + gap }];
    lanes.add(pts);
    return { d: orthPath(pts), pts };
  }

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

  const yA = pickGutter(lanes, baseA, xA, lane, down ? 1 : -1);
  const yB = pickGutter(lanes, baseB, lane, xB, down ? -1 : 1);
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

  // Mid-way between the two bands, so either direction is equally clear of both card rows.
  const my = pickGutter(lanes, (y1 + y2) / 2, x1, x2, down ? 1 : -1);
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

/**
 * Where a label can actually be read: searched against the finished picture, not derived (§4).
 *
 * A card disqualifies a position outright; routed line segments are a cost, since one thin stroke
 * behind a haloed label stays legible and a bundle of them does not. The card term went missing in
 * the port, which left the search happy to print a label straight over a group's name.
 */
function placeLabel(
  lanes: ReturnType<typeof makeLanes>, pts: { x: number; y: number }[], label: string,
  A: Rect, B: Rect, mapWidth: number, rects: Record<string, Rect>,
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
      const onCard = Object.values(rects).some((r) =>
        x1 < r.right + 3 && x1 + w > r.left - 3 && top < r.bottom + 2 && y > r.top - 2);
      const cost = (onCard ? 1000 : 0) + lanes.boxHits(x1, x1 + w, top, y) * 10 + Math.abs(dy);
      if (!best || cost < best.cost) best = { x: a.x, y, anchor: a.anchor, cost };
      if (cost === 0) break;
    }
    if (best?.cost === 0) break;
  }
  return best ?? { x: pts[0].x, y: pts[0].y - 8, anchor: "mid" };
}

export function computeLayout(
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
      : placeLabel(lanes, pts, e.label, rects[e.from], rects[e.to], mapWidth, rects);
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
export function optimizeOrder(
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
