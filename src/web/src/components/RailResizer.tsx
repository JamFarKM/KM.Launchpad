import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The two resizable edges on the Review page: the left panel's right edge and the file rail's left
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
 * The left panel, which holds the pull request list and the conversation as two tabs.
 *
 * Wider bounds than the rail's, because the conversation shares this column: a PR list is legible at
 * 340px and a conversation is cramped there, so the reviewer needs to be able to push it well past
 * the width the list alone would want.
 */
const LEFT: Axis = {
  min: 280,
  max: 900,
  fallback: 340,
  key: "pl-review-left-w",
  ceiling: () => Math.round(window.innerWidth / 2),
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
 * The left panel's width, persisted across reloads.
 *
 * Persisted rather than remembered for the session, on the same reasoning as the model `<select>`:
 * how much of the window a reviewer gives to the conversation is a preference, not a per-visit
 * accident, and re-dragging it every morning is the annoying half of the choice.
 */
export function useLeftWidth() { return usePaneSize(LEFT); }

interface ResizerProps {
  size: number;
  onSize: (v: number) => void;
}

/**
 * A drag handle on an edge.
 *
 * Keyboard-operable as well as draggable: a separator that only responds to a mouse is unusable for
 * anyone who doesn't use one, and arrow keys are the documented interaction for `role="separator"`.
 * `aria-valuenow` is in px because that is genuinely what is being set.
 */
function Resizer({
  axis, className, label, size, onSize, measure, growTowards,
}: ResizerProps & {
  axis: Axis;
  className: string;
  label: string;
  measure: (e: React.PointerEvent<HTMLDivElement>) => number;
  /**
   * Which way the handle travels to make the pane bigger. `start` for a right-anchored pane (drag it
   * left), `end` for a left-anchored one (drag it right).
   *
   * Passed rather than derived, because the two panes are mirror images and guessing produced a
   * left-panel arrow key that shrank while the handle it named moved the other way.
   */
  growTowards: "start" | "end";
}) {
  const dragging = useRef(false);
  /* Both edges on this page are vertical, so there is one drag cursor. Set on the body rather than the
     handle: without it the pointer flickers between cursors as it crosses the diff, and the answer
     text highlights as though you were selecting it. */
  const body = "is-col-resizing";

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
    onSize(measure(e));
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    document.body.classList.remove(body);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // The key matches the direction the handle travels, not the direction the number goes.
    const towardsStart = "ArrowLeft";
    const towardsEnd = "ArrowRight";
    const grow = growTowards === "start" ? towardsStart : towardsEnd;
    const shrink = growTowards === "start" ? towardsEnd : towardsStart;

    if (e.key === grow) { e.preventDefault(); onSize(size + STEP); }
    else if (e.key === shrink) { e.preventDefault(); onSize(size - STEP); }
    else if (e.key === "Home") { e.preventDefault(); onSize(axis.min); }
    else if (e.key === "End") { e.preventDefault(); onSize(axis.max); }
  };

  return (
    <div
      className={className}
      role="separator"
      aria-orientation="vertical"
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
      className="rail-resizer"
      label="Resize the file list"
      size={width}
      onSize={onWidth}
      growTowards="start"
      // The rail is right-anchored, so its width is the distance from the pointer to the window's
      // right edge — not the pointer's x.
      measure={(e) => window.innerWidth - e.clientX}
    />
  );
}

/** The left panel's right edge. */
export function LeftResizer({ width, onWidth }: { width: number; onWidth: (w: number) => void }) {
  return (
    <Resizer
      axis={LEFT}
      className="left-resizer"
      label="Resize the pull request and conversation panel"
      size={width}
      onSize={onWidth}
      growTowards="end"
      // Left-anchored, so its width is simply the pointer's x — the mirror of the rail's case, which
      // is the whole reason both measurements are passed in rather than assumed.
      measure={(e) => e.clientX}
    />
  );
}
