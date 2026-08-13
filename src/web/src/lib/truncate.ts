/**
 * Text fitting (POLISH §1).
 *
 * The app truncates roughly two thirds of its visible text, and tail truncation destroys the
 * distinguishing part of an identifier. Four rows of `acca-bonus-lad…` carry no information;
 * `acca-…er-switch` and `acca-…r-rollback` do.
 *
 * The part that is easy to get wrong: the budget must be **measured**, not guessed. A guessed
 * character count leaves CSS `text-overflow: ellipsis` to clip the result a second time and you
 * get `acca-bon…r-sw…`, which is worse than where you started. Anything fitted here must
 * therefore also switch to `text-overflow: clip` — that is what the `is-fitted` class is for.
 *
 * Only pure functions live here. The upstream utility also shipped `fitElement`/`autoFit`, which
 * write `textContent` and mutate classes imperatively; React overwrites both on its next render
 * and StrictMode's double render makes it intermittent. The measuring and the ResizeObserver live
 * in the `Truncated` component instead — see components/Truncated.tsx.
 */

export const ELLIPSIS = "…";

/** Share of the budget given to the head. Biased to the tail: that is where identifiers differ. */
export const HEAD_RATIO = 0.34;
/** For names whose head carries real meaning too, e.g. `SB.OfferIntegration…` in the drawer. */
export const HEAD_RATIO_BALANCED = 0.5;

let ctx: CanvasRenderingContext2D | null = null;
function measurer(): CanvasRenderingContext2D {
  if (!ctx) ctx = document.createElement("canvas").getContext("2d")!;
  return ctx;
}

/** Canvas font shorthand for an element's computed style. */
export function fontOf(el: Element): string {
  const cs = getComputedStyle(el);
  return `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} / ${cs.lineHeight} ${cs.fontFamily}`;
}

/** What the element will actually render, which is not always what you passed it. */
export function transformed(text: string, transform: string): string {
  if (transform.startsWith("uppercase")) return text.toUpperCase();
  if (transform.startsWith("lowercase")) return text.toLowerCase();
  if (transform.startsWith("capitalize")) return text.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  return text;
}

/**
 * Width of `text` in px, as it would render inside `el`.
 *
 * Canvas `measureText` honours the font but **not** `text-transform` or `letter-spacing`, so a
 * naive measurement under-reports both — an uppercase, letter-spaced heading measured as fitting
 * when it visibly did not, and CSS then tail-clipped the path we had just declined to truncate.
 * Both are applied here so the budget matches what lands on screen.
 */
export function textWidth(text: string, el: Element): number {
  const cs = getComputedStyle(el);
  const shown = transformed(text, cs.textTransform);
  const m = measurer();
  m.font = fontOf(el);
  const base = m.measureText(shown).width;
  const spacing = parseFloat(cs.letterSpacing);
  // Applied per character, including a trailing one — which is how browsers lay it out.
  return Number.isFinite(spacing) ? base + spacing * shown.length : base;
}

/**
 * Middle-truncate `text` to fit `availablePx`, binary-searching the largest budget that fits.
 *
 * `measure` is injected so this stays testable without a DOM — the component passes a canvas
 * measurement, the tests pass a fixed width per character.
 */
export function middleTruncate(
  text: string,
  availablePx: number,
  measure: (s: string) => number,
  headRatio: number = HEAD_RATIO,
): string {
  if (!text) return "";
  if (availablePx <= 0) return text;
  if (measure(text) <= availablePx) return text;

  let lo = 1;
  let hi = text.length;
  let best = ELLIPSIS;
  while (lo <= hi) {
    const total = (lo + hi) >> 1;
    const keep = total - 1; // one character spent on the ellipsis
    const head = Math.max(1, Math.round(keep * headRatio));
    const tail = Math.max(1, keep - head);
    if (head + tail >= text.length) { lo = total + 1; continue; }
    const candidate = text.slice(0, head) + ELLIPSIS + text.slice(text.length - tail);
    if (measure(candidate) <= availablePx) { best = candidate; lo = total + 1; }
    else { hi = total - 1; }
  }
  return best;
}

/**
 * Collapse consecutive runs sharing a key, so a branch that doesn't change between runs is
 * stated once (§1.3).
 *
 * Only *consecutive* runs group: run history is chronological, and merging non-adjacent groups
 * would misrepresent the timeline.
 */
export function groupConsecutive<T>(items: T[], keyOf: (item: T) => string): { key: string; items: T[] }[] {
  const out: { key: string; items: T[] }[] = [];
  for (const item of items) {
    const key = keyOf(item);
    const last = out[out.length - 1];
    if (last && last.key === key) last.items.push(item);
    else out.push({ key, items: [item] });
  }
  return out;
}
