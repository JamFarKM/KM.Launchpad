/**
 * "Clear last result" for sequence cards.
 *
 * A dismissal has to outlive a refetch, so it can't just be `setQueryData(null)` — the next poll
 * would bring the run straight back. It records the run id that was cleared; anything newer than
 * that shows normally, so clearing is a one-shot acknowledgement rather than a mute.
 *
 * Both the card and the board's shelf-health pill read this, which is the point: they have to
 * agree about what the last result is.
 */

const KEY = (seqId: string) => `pl-seq-cleared:${seqId}`;
const EVENT = "pl-seq-cleared";

export function clearedRunId(seqId: string): string | null {
  try { return localStorage.getItem(KEY(seqId)); } catch { return null; }
}

export function clearLastResult(seqId: string, runId: string) {
  try { localStorage.setItem(KEY(seqId), runId); } catch { /* private mode */ }
  window.dispatchEvent(new Event(EVENT));
}

/** True when this run has been cleared and should not be reported anywhere. */
export function isCleared(seqId: string, runId: string | null | undefined): boolean {
  return !!runId && clearedRunId(seqId) === runId;
}

/** Re-render both readers when a dismissal happens in either of them. */
export function onCleared(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
