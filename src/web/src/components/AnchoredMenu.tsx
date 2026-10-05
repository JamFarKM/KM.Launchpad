import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

interface Props {
  /** The control the menu hangs from. The menu's right edge lines up with its right edge. */
  anchor: RefObject<HTMLElement | null>;
  /** Which side of the anchor to open on when both have room. */
  prefer: "above" | "below";
  className: string;
  onClose: () => void;
  children: ReactNode;
}

const GAP = 6;
const MARGIN = 8;

/**
 * A small options menu rendered in a portal with fixed positioning.
 *
 * Shelves clip their contents (`overflow: hidden`, for the card hairlines — DESIGN_SPEC §4), so a
 * menu positioned inside one was cut off whenever it was wider than the shelf: on a one-card shelf
 * the accent swatches and half of `Rename…` vanished past the left edge. Escaping to the body is
 * the only fix that doesn't give up the clip.
 */
export function AnchoredMenu({ anchor, prefer, className, onClose, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ right: number; top?: number; bottom?: number; maxWidth: number } | null>(null);

  function place() {
    const a = anchor.current;
    if (!a) return;
    const r = a.getBoundingClientRect();
    const h = ref.current?.offsetHeight ?? 0;
    const roomAbove = r.top - GAP - MARGIN;
    const roomBelow = window.innerHeight - r.bottom - GAP - MARGIN;
    const above = prefer === "above" ? h <= roomAbove || roomAbove > roomBelow : h > roomBelow && roomAbove > roomBelow;
    setPos({
      right: Math.max(MARGIN, window.innerWidth - r.right),
      maxWidth: r.right - MARGIN,
      ...(above ? { bottom: window.innerHeight - r.top + GAP } : { top: r.bottom + GAP }),
    });
  }

  // The menu is already in the DOM (hidden) when this runs, so its height is measurable and the
  // first painted frame is on the right side of the anchor — no visible jump.
  useLayoutEffect(place, []);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  });

  return createPortal(
    <div
      ref={ref}
      className={className}
      style={{ position: "fixed", ...pos, visibility: pos ? undefined : "hidden" }}
      onMouseLeave={onClose}
    >
      {children}
    </div>,
    document.body,
  );
}
