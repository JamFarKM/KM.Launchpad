import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The two resizable edges on the Review page: the file rail's left edge and the agent dock's top
 * edge.
 *
 * They share this file because they share every hard part — clamping against the window, persisting
 * across reloads, re-clamping when the window shrinks, and being operable from the keyboard. What
 * differs is one axis and one arithmetic line, so the alternative was two copies of the same bugs.
 */

interface Axis {
  min: number;
  max: number;
  fallback: number;
  key: string;
  /** How much of the window the pane may take at most. Guards against a value saved on a bigger screen. */
  ceiling: () => number;
}

/** The rail. Never more than half the window: past that the diff becomes the smaller pane. */
const RAIL: Axis = {
  min: 320,
  max: 900,
  fallback: 380,
  key: "pl-review-rail-w",
  ceiling: () => Math.round(window.innerWidth / 2),
};

/**
 * The dock. Its minimum is what fits the composer plus one visible turn; below that a drag is
 * treated as a collapse by the page, rather than leaving a dock too short to use.
 */
const DOCK: Axis = {
  min: 180,
  max: 720,
  fallback: 340,
  key: "pl-review-dock-h",
  // Two thirds rather than a half: the dock competes with the diff for height, and a diff squeezed
  // to a third of the window is still readable in a way a third-width diff is not.
  ceiling: () => Math.round(window.innerHeight * 0.66),
};

const STEP = 24;

function clamp(axis: Axis, value: number): number {
  const ceiling = Math.min(axis.max, Math.max(axis.min, axis.ceiling()));
  return Math.min(ceiling, Math.max(axis.min, Math.round(value)));
}

function usePaneSize(axis: Axis): [number, (v: number) => void] {
  const [size, setSize] = useState(() => {
    const stored = Number(localStorage.getItem(axis.key));
    return Number.isFinite(stored) && stored > 0 ? clamp(axis, stored) : axis.fallback;
  });

  const set = useCallback((v: number) => {
    const next = clamp(axis, v);
    setSize(next);
    localStorage.setItem(axis.key, String(next));
  }, [axis]);

  // Re-clamp when the window shrinks, so moving to a smaller screen can't leave a pane bigger than
  // the space available.
  useEffect(() => {
    const onResize = () => setSize((v) => clamp(axis, v));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [axis]);

  return [size, set];
}

/** The width the review page's right rail should use, persisted across reloads. */
export function useRailWidth() { return usePaneSize(RAIL); }

/**
 * The agent dock's expanded height, persisted across reloads.
 *
 * `DESIGN_SPEC_REVIEW.md` §5 asks for "remembered for the session" as the minimum bar and §12 leans
 * towards persisting. Persisted, on the same reasoning as the model `<select>`: how much of the
 * window a reviewer wants given to conversation is a preference, not a per-visit accident, and
 * re-dragging it every morning is the annoying half of the choice.
 */
export function useDockHeight() { return usePaneSize(DOCK); }

/** Below this a drag is a collapse rather than a very short dock (§5). */
export const DOCK_COLLAPSE_AT = DOCK.min;

interface ResizerProps {
  size: number;
  onSize: (v: number) => void;
  /** Called when a drag goes below the minimum — the dock treats that as "collapse me". */
  onUndershoot?: () => void;
}

/**
 * A drag handle on an edge.
 *
 * Keyboard-operable as well as draggable: a separator that only responds to a mouse is unusable for
 * anyone who doesn't use one, and arrow keys are the documented interaction for `role="separator"`.
 * `aria-valuenow` is in px because that is genuinely what is being set.
 */
function Resizer({
  axis, orientation, className, label, size, onSize, onUndershoot, measure,
}: ResizerProps & {
  axis: Axis;
  orientation: "vertical" | "horizontal";
  className: string;
  label: string;
  measure: (e: React.PointerEvent<HTMLDivElement>) => number;
}) {
  const dragging = useRef(false);
  const body = orientation === "vertical" ? "is-col-resizing" : "is-row-resizing";

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragging.current = true;
    // Capture on the handle so the drag survives the pointer crossing the diff, which would
    // otherwise swallow the move events.
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add(body);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const raw = measure(e);
    // The undershoot is reported from the raw measurement, before clamping — clamping first would
    // pin the value at the minimum and the intent to collapse would never be visible.
    if (raw < axis.min && onUndershoot) onUndershoot();
    else onSize(raw);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    document.body.classList.remove(body);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // The key matches the direction the handle travels, not the direction the number goes: for both
    // panes, moving the handle "back" (left, or up) makes the pane bigger.
    const grow = orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
    const shrink = orientation === "vertical" ? "ArrowRight" : "ArrowDown";

    if (e.key === grow) { e.preventDefault(); onSize(size + STEP); }
    else if (e.key === shrink) { e.preventDefault(); onSize(size - STEP); }
    else if (e.key === "Home") { e.preventDefault(); onSize(axis.min); }
    else if (e.key === "End") { e.preventDefault(); onSize(axis.max); }
  };

  return (
    <div
      className={className}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={size}
      aria-valuemin={axis.min}
      aria-valuemax={axis.max}
      tabIndex={0}
      // Double-click restores the default, which is the standard escape from a size you have dragged
      // somewhere unhelpful.
      onDoubleClick={() => onSize(axis.fallback)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    />
  );
}

/** The file rail's left edge. */
export function RailResizer({ width, onWidth }: { width: number; onWidth: (w: number) => void }) {
  return (
    <Resizer
      axis={RAIL}
      orientation="vertical"
      className="rail-resizer"
      label="Resize the file list"
      size={width}
      onSize={onWidth}
      // The rail is right-anchored, so its width is the distance from the pointer to the window's
      // right edge — not the pointer's x.
      measure={(e) => window.innerWidth - e.clientX}
    />
  );
}

/** The agent dock's top edge. */
export function DockResizer({ height, onHeight, onCollapse }: {
  height: number;
  onHeight: (h: number) => void;
  onCollapse: () => void;
}) {
  return (
    <Resizer
      axis={DOCK}
      orientation="horizontal"
      className="dock-resizer"
      label="Resize the agent panel"
      size={height}
      onSize={onHeight}
      onUndershoot={onCollapse}
      // Bottom-anchored, so the height is the distance from the pointer to the window's bottom edge.
      measure={(e) => window.innerHeight - e.clientY}
    />
  );
}
