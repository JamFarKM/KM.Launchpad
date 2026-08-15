import { describe, expect, it } from "vitest";
import { computeLayout, optimizeOrder, type Rect } from "./changeMapLayout";
import type { ChangeMapEdge, ChangeMapGroup } from "../types";

/**
 * The change map's geometry, over fixed rectangles.
 *
 * Both bugs this file exists to prevent shipped, and neither was findable by looking at the app: the
 * lane picker was calling the vertical overlap-checks for horizontal runs, so every horizontal run
 * was told its lane was free and they stacked; and before that, a hardcoded card width let a band
 * wrap into the strip the router treats as empty. Both are one assertion away over a fixed layout.
 */

/** Cards laid out the way the sheet lays them out: fixed-width, one row per depth, uniform gutters. */
function layout(byDepth: Record<number, string[]>, opts?: { cardW?: number; gap?: number }): Record<string, Rect> {
  const cardW = opts?.cardW ?? 140, gap = opts?.gap ?? 22;
  const cardH = 88, bandTop = 14, bandPitch = 88 + 42;
  const left0 = 130;
  const rects: Record<string, Rect> = {};
  const depths = Object.keys(byDepth).map(Number).sort((a, b) => b - a);
  depths.forEach((d, row) => {
    byDepth[d].forEach((id, col) => {
      const left = left0 + col * (cardW + gap);
      const top = bandTop + row * bandPitch;
      rects[id] = { left, top, right: left + cardW, bottom: top + cardH,
                    cx: left + cardW / 2, cy: top + cardH / 2 };
    });
  });
  return rects;
}

function groups(spec: Record<string, number>): ChangeMapGroup[] {
  return Object.entries(spec).map(([id, depth]) => ({
    id, name: id, depth, summary: "", files: [{ path: `${id}.cs`, added: 1, removed: 0 }], findingCount: 0,
  }));
}

const edge = (from: string, to: string, label = "calls"): ChangeMapEdge => ({ from, to, label });

/** Sample an SVG path into points, so two paths can be compared as drawn rather than as parsed. */
function samplePath(d: string, step = 2): { x: number; y: number }[] {
  // A tiny parser is enough: orthPath only emits M, L and Q, and Q's control point lies on the
  // corner it rounds, so the polyline through every coordinate pair is the path's own shape.
  const nums = d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });

  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.round(len / step));
    for (let k = 0; k <= n; k++) out.push({ x: a.x + (b.x - a.x) * (k / n), y: a.y + (b.y - a.y) * (k / n) });
  }
  return out;
}

/**
 * Millimetres of one path that lie on top of another.
 *
 * Deliberately measures *shared run*, not intersection: two edges crossing at a right angle is
 * ordinary diagram grammar and legible, while two running along the same line read as one edge and
 * are what makes a graph unfollowable. A crossing contributes a couple of samples; a shared run
 * contributes its whole length.
 */
function sharedRun(a: string, b: string): number {
  const pa = samplePath(a), pb = samplePath(b);
  let shared = 0;
  for (const p of pa) {
    if (pb.some((q) => Math.abs(p.x - q.x) < 2 && Math.abs(p.y - q.y) < 2)) shared += 2;
  }
  return shared;
}

describe("edge routing", () => {
  it("gives each horizontal run in one gutter its own lane", () => {
    /* Three edges that all have to cross the same band gutter, between non-adjacent columns so none
       can go straight. This is the flow-mode case from a real PR — the orchestrator at column 0
       reaching out to columns 2 and 3 and back — and the shape that produced a stack of overlapping
       lines when the lane picker was checking the wrong axis. */
    const rects = layout({ 2: ["a", "b", "c", "d"] });
    const byId = new Map(groups({ a: 2, b: 2, c: 2, d: 2 }).map((g) => [g.id, g]));
    const edges = [edge("a", "c"), edge("c", "a"), edge("a", "d")];

    const out = computeLayout(edges, rects, byId, 900);
    expect(out).toHaveLength(3);

    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        // A right-angle crossing is fine; anything beyond a few px of shared travel is two edges
        // drawn on top of each other.
        expect(sharedRun(out[i].d, out[j].d)).toBeLessThan(14);
      }
    }
  });

  it("never routes an edge through a card it does not own", () => {
    const rects = layout({ 3: ["outer"], 2: ["mid1", "mid2", "mid3"], 0: ["core"] });
    const byId = new Map(groups({ outer: 3, mid1: 2, mid2: 2, mid3: 2, core: 0 }).map((g) => [g.id, g]));
    // outer→core skips a band; mid3→outer runs backwards up one.
    const edges = [edge("outer", "core"), edge("mid3", "outer"), edge("mid1", "core")];

    const out = computeLayout(edges, rects, byId, 900);

    for (const e of out) {
      for (const [id, r] of Object.entries(rects)) {
        if (id === e.from || id === e.to) continue;
        const inside = samplePath(e.d).some((p) =>
          p.x > r.left + 2 && p.x < r.right - 2 && p.y > r.top + 2 && p.y < r.bottom - 2);
        expect(inside, `${e.from}->${e.to} passes through ${id}`).toBe(false);
      }
    }
  });

  it("draws a column-aligned dependency as one straight vertical", () => {
    const rects = layout({ 2: ["app"], 1: ["core"] });
    const byId = new Map(groups({ app: 2, core: 1 }).map((g) => [g.id, g]));

    const [only] = computeLayout([edge("app", "core")], rects, byId, 900);

    // Two points, one x: no dog-leg. This is the most legible edge there is, and the ordering pass
    // exists to produce it, so it must survive the router.
    const xs = new Set(samplePath(only.d).map((p) => Math.round(p.x)));
    expect(xs.size).toBe(1);
  });

  it("keeps a label clear of every card", () => {
    const rects = layout({ 2: ["a", "b", "c"] });
    const byId = new Map(groups({ a: 2, b: 2, c: 2 }).map((g) => [g.id, g]));

    const out = computeLayout([edge("a", "c", "a long enough label to be awkward")], rects, byId, 900);

    const w = "a long enough label to be awkward".length * 5.8;
    for (const e of out) {
      const x1 = e.anchor === "mid" ? e.lx - w / 2 : e.lx;
      for (const r of Object.values(rects)) {
        const overlaps = x1 < r.right && x1 + w > r.left && e.ly - 9 < r.bottom && e.ly > r.top;
        expect(overlaps).toBe(false);
      }
    }
  });
});

describe("group ordering", () => {
  it("puts a dependency's two ends in the same column when it can", () => {
    // One edge, two bands, two candidates per band: the arrangement that aligns them scores best.
    const gs = groups({ x: 2, y: 2, p: 1, q: 1 });
    const edges = [edge("y", "q")];

    const order = optimizeOrder(gs, edges, [2, 1]);

    expect(order[2].indexOf("y")).toBe(order[1].indexOf("q"));
  });

  it("chooses the arrangement with fewer crossings", () => {
    /* Two edges that cross in one arrangement and not the other: a→q and b→p cross iff a and b are
       ordered the same way as p and q. */
    const gs = groups({ a: 2, b: 2, p: 1, q: 1 });
    const edges = [edge("a", "q"), edge("b", "p")];

    const order = optimizeOrder(gs, edges, [2, 1]);

    const crossed = (order[2].indexOf("a") - order[2].indexOf("b"))
                  * (order[1].indexOf("q") - order[1].indexOf("p")) < 0;
    expect(crossed).toBe(false);
  });

  it("is stable for a single group per band", () => {
    const gs = groups({ only: 0 });
    expect(optimizeOrder(gs, [], [0])).toEqual({ 0: ["only"] });
  });
});
