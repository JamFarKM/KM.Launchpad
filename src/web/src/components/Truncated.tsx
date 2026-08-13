import { useLayoutEffect, useRef, useState } from "react";
import { HEAD_RATIO, middleTruncate, textWidth } from "../lib/truncate";

/**
 * Text middle-truncated to the width it actually has (POLISH §1.1, §1.2).
 *
 * Measured, not guessed: the budget comes from the element's real `clientWidth` via canvas
 * `measureText`. A guessed character count would leave CSS `text-overflow: ellipsis` to clip the
 * result a second time and produce `acca-bon…r-sw…`, so a fitted element also switches to
 * `text-overflow: clip` — that is what `is-fitted` does.
 *
 * The measurement lives in a component rather than the utility's `fitElement`/`autoFit`, which
 * write `textContent` directly: React overwrites that on its next render, and StrictMode's double
 * render makes the breakage intermittent.
 *
 * A `ResizeObserver` rather than a window listener, because the widths that matter here change
 * without the window changing — a shelf being resized, the drawer collapsing, the editor panel
 * opening.
 */
export function Truncated({ text, headRatio = HEAD_RATIO, className, title }: {
  text: string;
  headRatio?: number;
  className?: string;
  /** Overrides the tooltip. By default the full text is used whenever it had to be cut. */
  title?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(text);

  // Layout effect: measure and set before the browser paints, so no untruncated flash.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const fit = () => {
      const avail = el.clientWidth;
      // 0 before layout, or if a flex parent forgot min-width:0. Showing the full string beats
      // showing a lone ellipsis, and CSS ellipsis still covers it until the next measurement.
      if (!avail) { setShown(text); return; }
      setShown(middleTruncate(text, avail, (s) => textWidth(s, el), headRatio));
    };

    fit();

    if (typeof ResizeObserver === "undefined") return;
    // Debounced to a frame: a panel transition fires a burst of callbacks.
    let queued = false;
    const ro = new ResizeObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; fit(); });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, headRatio]);

  const cut = shown !== text;

  /* The title goes on this element, not the row around it: an ancestor's tooltip would describe
     the wrong thing, and §12 asks that every truncated string carry its own full value. */
  return (
    <span
      ref={ref}
      className={`${className ?? ""} truncated${cut ? " is-fitted" : ""}`.trim()}
      title={title ?? (cut ? text : undefined)}
    >
      {shown}
    </span>
  );
}
