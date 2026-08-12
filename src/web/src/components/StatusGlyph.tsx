import type { StatusTone } from "../lib/format";

/**
 * 17px status glyph (invariant A4): the state word lives in title/aria-label, never
 * on screen, and the glyph SHAPE differs per state so pass/fail/running survive
 * greyscale and colourblindness — colour is never the only carrier.
 *
 *   succeeded → filled green rounded-square + white check
 *   failed    → filled red rounded-square + white cross
 *   running   → outlined amber rounded-square + partial arc
 *   idle      → outlined neutral rounded-square
 */
export function StatusGlyph({ tone, label }: { tone: StatusTone; label: string }) {
  // Fills and strokes are left to CSS (see .status-glyph) so the chip can be dropped in dark
  // mode — there the mark itself carries the status colour instead of sitting on a filled tile.
  return (
    <span className={`status-glyph tone-${tone}`} title={label} aria-label={label} role="img">
      <svg viewBox="0 0 16 16">
        <rect className="glyph-chip" x=".5" y=".5" width="15" height="15" />
        {tone === "success" && (
          <path className="glyph-mark" d="M4.6 8.2l2.2 2.2 4.6-4.9" strokeLinecap="round" strokeLinejoin="round" />
        )}
        {tone === "failed" && (
          <path className="glyph-mark" d="M5.3 5.3l5.4 5.4M10.7 5.3l-5.4 5.4" strokeLinecap="round" />
        )}
        {tone === "running" && (
          <path className="glyph-mark" d="M8 4.2a3.8 3.8 0 1 1-3.8 3.8" strokeLinecap="round" />
        )}
        {tone === "canceled" && (
          <path className="glyph-mark" d="M5 8h6" strokeLinecap="round" />
        )}
      </svg>
    </span>
  );
}

/** The single glyph shared by the play buttons. */
export function PlayIcon() {
  return (
    <svg viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
      <path d="M1 .5v9l8-4.5z" />
    </svg>
  );
}

/**
 * Spectacles — "view the logs". Drawn as an SVG rather than the 👓 emoji so it inherits
 * currentColor (the emoji font can't recolour for dark mode and differs per platform).
 */
export function LogsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <circle cx="6.5" cy="14.5" r="4.2" />
      <circle cx="17.5" cy="14.5" r="4.2" />
      <path d="M10.7 14c.9-.7 1.7-.7 2.6 0" strokeLinecap="round" />
      <path d="M2.4 11.4 5 6.6M21.6 11.4 19 6.6" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Shelf-level health, rendered in the footer of the shelf's first card. It used to sit in the
 * shelf header, where on a one-card shelf it left the title almost no room. Suppressed when
 * everything passes — an all-clear shelf stays quiet.
 */
export function ShelfHealthPill({ health }: { health: { failing: number; running: number } }) {
  if (health.failing > 0) {
    return (
      <span className="shelf-health fail" title={`${health.failing} failing in this shelf`}>
        {health.failing} failing
      </span>
    );
  }
  if (health.running > 0) {
    return (
      <span className="shelf-health running" title={`${health.running} running in this shelf`}>
        {health.running} running
      </span>
    );
  }
  return null;
}

export function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" aria-hidden="true" width="12" height="12">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
