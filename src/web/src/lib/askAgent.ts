import type { AgentSegment, AgentTurn, ChangeMap } from "../types";

/**
 * Reads Launchpad's own SSE shape (DESIGN_SPEC_CONNECTORS.md §6).
 *
 * The browser only ever sees this one format — never a provider's. Normalising that away is the
 * adapter's job on the server, which is why there is nothing provider-specific in this file and
 * nothing here needs to change when a provider is added.
 *
 * `fetch` rather than `EventSource`, because the request is a POST and `EventSource` can only GET.
 */
export interface AskHandlers {
  /** Assembled context, before the agent is called — carries the truncation warning (§5.1). */
  onContext?: (info: { truncated: boolean; omitted: string[]; diffBytes: number }) => void;
  /** The agent asked for a file, a listing or a search. Surfaced live so a pause has a reason. */
  onReading?: (info: { tool: string; detail: string }) => void;
  /**
   * One claim closed — the streaming unit (§5.2).
   *
   * Arrives complete, with its badge and its citations, so it renders as a finished card while the
   * next one is still being written. Segments never arrive twice, so append rather than replace.
   */
  onSegment: (segment: AgentSegment) => void;
  /**
   * Unlabelled prose, from a connector that can't produce structure at all (§5.4 mode 3). Fragments
   * concatenate. Kept separate from `onSegment` because nobody vouched for this text — showing it
   * under a provenance badge would be the lie the badge exists to prevent.
   */
  onDelta: (text: string) => void;
  /** The finished, validated turn as the server recorded it. Terminal. */
  onComplete: (turn: AgentTurn) => void;
  /** A typed §4 failure. Terminal. Any prose already delivered stays on screen. */
  onError: (error: { code: string; detail?: string | null; httpStatus?: number | null }) => void;
}

/**
 * Reads one SSE response body, dispatching each record to the matching handler. Shared by
 * {@link askAgent} and {@link askReview} so the two event vocabularies can't drift on the framing
 * — only on which event names they choose to listen for.
 */
async function readSse(
  resp: Response,
  onEvent: (event: string, payload: unknown) => void,
): Promise<void> {
  if (!resp.body) return;

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE records are separated by a blank line. Anything after the last separator is a partial
    // record and stays in the buffer — splitting on every newline instead would deliver half a
    // JSON payload and throw.
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const record = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      const event = /^event: (.+)$/m.exec(record)?.[1];
      const data = /^data: (.+)$/m.exec(record)?.[1];
      if (!event || !data) continue;

      let payload: unknown;
      try { payload = JSON.parse(data); } catch { continue; }

      onEvent(event, payload);
    }
  }
}

/**
 * @param annotationId When set, the question is scoped to one inline annotation (§7.6) — the same
 * stream shape, against that annotation's own turns rather than the main conversation's.
 */
export async function askAgent(
  project: string,
  repoId: string,
  prId: number,
  question: string,
  handlers: AskHandlers,
  signal: AbortSignal,
  annotationId?: string,
): Promise<void> {
  const base = `/api/review/${encodeURIComponent(project)}/${encodeURIComponent(repoId)}`
    + `/pulls/${prId}`;
  const url = annotationId
    ? `${base}/annotations/${encodeURIComponent(annotationId)}/ask`
    : `${base}/ask`;

  const resp = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
    signal,
  });

  if (!resp.ok || !resp.body) {
    // A non-stream failure never reached the agent — say so rather than reporting it as one.
    let detail: string | null = null;
    try { detail = (await resp.json())?.error ?? null; } catch { /* not json */ }
    handlers.onError({ code: "upstream", httpStatus: resp.status, detail });
    return;
  }

  await readSse(resp, (event, payload) => {
    switch (event) {
      case "context": handlers.onContext?.(payload as never); break;
      case "reading": handlers.onReading?.(payload as never); break;
      case "segment": handlers.onSegment(payload as AgentSegment); break;
      case "delta": handlers.onDelta((payload as { text: string }).text); break;
      case "complete": handlers.onComplete(payload as AgentTurn); break;
      case "error": handlers.onError(payload as never); break;
      // `turn` carries the thread id and how much history was replayed. Useful for debugging,
      // not something the panel renders.
    }
  });
}

export interface ReviewHandlers {
  onReading?: (info: { tool: string; detail: string }) => void;
  /** One claim of the review closed — same shape and same meaning as an ordinary answer's. */
  onSegment: (segment: AgentSegment) => void;
  /** Finished: a normal turn, appended to the thread exactly like a typed question. */
  onComplete: (turn: AgentTurn) => void;
  onError: (error: { code: string; detail?: string | null; httpStatus?: number | null }) => void;
}

/**
 * The Review button (DESIGN_SPEC_CHANGE_MAP.md §4.1) — a fixed question down the same path a typed
 * one takes, so what comes back is a turn in the thread rather than a parallel kind of thing.
 *
 * It no longer produces the map. The two shared a call while there was one button; the wizard owns
 * the walkthrough now, and tying them meant every review paid for a map nobody had asked to see.
 */
export async function askReview(
  project: string,
  repoId: string,
  prId: number,
  handlers: ReviewHandlers,
  signal: AbortSignal,
): Promise<void> {
  const url = `/api/review/${encodeURIComponent(project)}/${encodeURIComponent(repoId)}/pulls/${prId}/review`;

  const resp = await fetch(url, { method: "POST", credentials: "same-origin", signal });

  if (!resp.ok || !resp.body) {
    let detail: string | null = null;
    try { detail = (await resp.json())?.error ?? null; } catch { /* not json */ }
    handlers.onError({ code: "upstream", httpStatus: resp.status, detail });
    return;
  }

  await readSse(resp, (event, payload) => {
    switch (event) {
      case "reading": handlers.onReading?.(payload as never); break;
      case "segment": handlers.onSegment(payload as AgentSegment); break;
      case "complete": handlers.onComplete(payload as AgentTurn); break;
      case "error": handlers.onError(payload as never); break;
    }
  });
}

export interface MapHandlers {
  /** What the agent is reading while it works out the shape. */
  onReading?: (info: { tool: string; detail: string }) => void;
  /** The map, which is also the wizard's script: `flow[].detail` is what the slides read. */
  onMap: (map: ChangeMap) => void;
  onError: (detail: string | null) => void;
}

/**
 * The Wizard's one call (§8): the change map, which is both the diagram and the walkthrough.
 *
 * Stored on the thread server-side, so reopening the wizard afterwards costs nothing and re-running
 * it is a deliberate act rather than a side effect of pressing something else.
 */
export async function askMap(
  project: string,
  repoId: string,
  prId: number,
  handlers: MapHandlers,
  signal: AbortSignal,
): Promise<void> {
  const url = `/api/review/${encodeURIComponent(project)}/${encodeURIComponent(repoId)}/pulls/${prId}/map`;

  const resp = await fetch(url, { method: "POST", credentials: "same-origin", signal });

  if (!resp.ok || !resp.body) {
    let detail: string | null = null;
    try { detail = (await resp.json())?.error ?? null; } catch { /* not json */ }
    handlers.onError(detail);
    return;
  }

  await readSse(resp, (event, payload) => {
    switch (event) {
      case "reading": handlers.onReading?.(payload as never); break;
      case "map": handlers.onMap(payload as ChangeMap); break;
      case "map_error": handlers.onError((payload as { detail: string | null }).detail); break;
    }
  });
}
