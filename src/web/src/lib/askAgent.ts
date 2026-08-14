import type { AgentSegment, AgentTurn } from "../types";

/**
 * Reads Launchpad's own SSE shape (DESIGN_SPEC_CONNECTORS.md §6).
 *
 * The browser only ever sees this one format — never a provider's. Normalising that away is the
 * adapter's job on the server, which is why there is nothing provider-specific in this file and
 * nothing here needs to change when a provider is added.
 *
 * `fetch` rather than `EventSource`, because the request is a POST carrying the question and
 * `EventSource` can only GET.
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

export async function askAgent(
  project: string,
  repoId: string,
  prId: number,
  question: string,
  handlers: AskHandlers,
  signal: AbortSignal,
): Promise<void> {
  const url = `/api/review/${encodeURIComponent(project)}/${encodeURIComponent(repoId)}`
    + `/pulls/${prId}/ask`;

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
    }
  }
}
