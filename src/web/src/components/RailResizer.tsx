import { useCallback, useEffect, useRef, useState } from "react";

/** Bounds for the right rail, in px. */
const MIN = 320;
const MAX = 900;
const DEFAULT = 380;
const KEY = "pl-review-rail-w";
const STEP = 24;

/**
 * The width the review page's right rail should use, persisted across reloads.
 *
 * Lives here rather than in the page so the clamp and the storage key have one home — a width read
 * from storage has to be re-clamped, because a value saved on a wide monitor would otherwise leave
 * the rail wider than a laptop's whole window.
 */
export function useRailWidth(): [number, (w: number) => void] {
  const [width, setWidth] = useState(() => {
    const stored = Number(localStorage.getItem(KEY));
    return Number.isFinite(stored) && stored > 0 ? clamp(stored) : DEFAULT;
  });

  const set = useCallback((w: number) => {
    const next = clamp(w);
    setWidth(next);
    localStorage.setItem(KEY, String(next));
  }, []);

  // Re-clamp when the window shrinks, so moving to a smaller screen can't leave the rail wider
  // than the space available.
  useEffect(() => {
    const onResize = () => setWidth((w) => clamp(w));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return [width, set];
}

function clamp(w: number): number {
  // Never more than half the window: past that the diff — the thing being reviewed — becomes the
  // smaller pane, which is the wrong way round for a review tool.
  const ceiling = Math.min(MAX, Math.max(MIN, Math.round(window.innerWidth / 2)));
  return Math.min(ceiling, Math.max(MIN, Math.round(w)));
}

/**
 * A drag handle on the rail's left edge.
 *
 * Keyboard-operable as well as draggable: a separator that only responds to a mouse is unusable
 * for anyone who doesn't use one, and arrow keys are the documented interaction for
 * `role="separator"`. `aria-valuenow` is in px because that is genuinely what is being set.
 */
export function RailResizer({ width, onWidth }: { width: number; onWidth: (w: number) => void }) {
  const dragging = useRef(false);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragging.current = true;
    // Capture on the handle so the drag survives the pointer crossing the diff, which would
    // otherwise swallow the move events.
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add("is-col-resizing");
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    // The rail is right-anchored, so its width is the distance from the pointer to the window's
    // right edge — not the pointer's x.
    onWidth(window.innerWidth - e.clientX);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    document.body.classList.remove("is-col-resizing");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Left widens: the rail's left edge moving left makes it bigger, so the key matches the
    // direction the handle travels rather than the number going up.
    if (e.key === "ArrowLeft") { e.preventDefault(); onWidth(width + STEP); }
    else if (e.key === "ArrowRight") { e.preventDefault(); onWidth(width - STEP); }
    else if (e.key === "Home") { e.preventDefault(); onWidth(MIN); }
    else if (e.key === "End") { e.preventDefault(); onWidth(MAX); }
  };

  return (
    <div
      className="rail-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the panel"
      aria-valuenow={width}
      aria-valuemin={MIN}
      aria-valuemax={MAX}
      tabIndex={0}
      // Double-click restores the default, which is the standard escape from a width you have
      // dragged somewhere unhelpful.
      onDoubleClick={() => onWidth(DEFAULT)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    />
  );
}
