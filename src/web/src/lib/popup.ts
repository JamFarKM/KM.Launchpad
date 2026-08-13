/**
 * Where to put a popup anchored to a control, given that the control may be anywhere on screen.
 *
 * Anchoring at `anchor.bottom + 4` and stopping there puts the popup off the bottom of the window
 * whenever the control sits low, and an internal `max-height` does not rescue it, because the box
 * itself starts below the fold.
 *
 * Placing above is expressed as a `bottom` offset rather than a computed `top`, so the popup grows
 * upward from the control and a short list stays attached to it. Deriving `top` from an assumed
 * height would leave a short popup floating above its own anchor.
 */
export interface PopupPlacement {
  /** Set when placed below the anchor. */
  top?: number;
  /** Set when placed above the anchor — CSS `bottom`, measured from the viewport floor. */
  bottom?: number;
  maxHeight: number;
  above: boolean;
}

export function placePopup(
  anchor: { top: number; bottom: number },
  desiredHeight: number,
  viewportHeight: number = window.innerHeight,
  gap = 4,
  margin = 8,
): PopupPlacement {
  const roomBelow = viewportHeight - anchor.bottom - gap - margin;
  const roomAbove = anchor.top - gap - margin;

  // Stay below unless it genuinely doesn't fit and above is roomier.
  const goAbove = desiredHeight > roomBelow && roomAbove > roomBelow;

  return goAbove
    ? { bottom: viewportHeight - anchor.top + gap, maxHeight: Math.max(120, roomAbove), above: true }
    : { top: anchor.bottom + gap, maxHeight: Math.max(120, roomBelow), above: false };
}
