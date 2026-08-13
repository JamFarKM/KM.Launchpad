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

/** Horizontal placement: which edge the popup hangs from, and how wide it may get. */
export interface PopupWidth {
  /** Set when the popup opens rightward from the anchor's left edge. */
  left?: number;
  /** Set when it would run off the right edge, so it opens leftward instead. */
  right?: number;
  /** A floor — the popup is never narrower than the control that opened it. */
  minWidth: number;
  maxWidth: number;
}

/**
 * How wide a popup may be, and which edge it hangs from.
 *
 * The anchor's width is a FLOOR, not the width. Pinning a popup to its control looks tidy on a
 * full-width field and falls apart on a short one: the Review page's project picker is sized to the
 * word "Account", so a popup locked to it rendered every option as `Acq…` — four characters, no
 * more use than no label at all.
 *
 * Near the right edge there is no room to grow rightward, so the popup hangs from its right edge
 * and opens leftward instead. Decided arithmetically rather than by measuring the rendered popup,
 * so it is right on the first frame — measure-then-correct would paint it in the wrong place and
 * visibly jump.
 */
export function placePopupWidth(
  anchor: { left: number; right: number; width: number },
  viewportWidth: number = window.innerWidth,
  preferred = 420,
  margin = 8,
): PopupWidth {
  const roomRight = viewportWidth - anchor.left - margin;
  const roomLeft = anchor.right - margin;
  // What this popup would need to be worth opening rightward at all.
  const usable = Math.min(preferred, Math.max(anchor.width, 240));

  if (roomRight < usable && roomLeft > roomRight) {
    return {
      right: Math.max(margin, viewportWidth - anchor.right),
      minWidth: anchor.width,
      maxWidth: Math.min(preferred, roomLeft),
    };
  }
  return { left: anchor.left, minWidth: anchor.width, maxWidth: Math.min(preferred, roomRight) };
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
