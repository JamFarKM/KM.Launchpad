import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { askAgent } from "../lib/askAgent";
import { Markdown, PostSheet, Segment } from "./AgentPanel";
import type { AgentSegment, AgentTurn, Annotation } from "../types";

/**
 * A place on the diff the agent said something about.
 *
 * <b>A stop exists before an annotation does.</b> Every cited line is one, so the reviewer can page
 * through everything the agent flagged without leaving a trail of empty conversations behind — the row
 * is only written when they actually say or resolve something, which is what `ensure` is for.
 */
export interface CycleStop {
  path: string;
  line: number;
  severity: string;
  /** The claim that cited this line: the card's opening turn, in the agent's own words. */
  seed: string | null;
  /** Null until the reviewer has engaged with it. */
  annotation: Annotation | null;
}

interface Props {
  stop: CycleStop;
  project: string;
  repoId: string;
  prId: number;
  /** The PR's head commit, for the staleness note. */
  headCommit?: string | null;
  connectorName?: string | null;
  /** Persist this stop if it isn't persisted yet, and give back its id. */
  ensure: () => Promise<string | null>;
  /** Pixel offset of the anchor line within the editor's viewport. */
  top: number;
  /** Left edge of the pane the line belongs to, so the card sits over the right side. */
  left: number;
  onClose: () => void;
  /** Refetch the annotation list — a new turn or a status change changed it. */
  onChanged: () => void;
  onCite: (path: string, line: number) => void;
}

/**
 * An annotation on one line of the diff (DESIGN_SPEC_CONNECTORS.md §7.6).
 *
 * <b>A citation already <em>is</em> a candidate inline comment.</b> The agent said something about
 * that exact spot; the only thing missing was somewhere to leave it instead of letting it scroll past
 * in the conversation. So this is not a new kind of content — it is a second, persistent place for
 * content the agent was already producing.
 *
 * It reuses the PR comment composer's treatment — elevated surface, rotated-square pointer, a scrim
 * over the lines it covers — so the interaction feels native to the diff rather than bolted onto it.
 * The one deliberate visual difference is the dashed border and the `NOT POSTED` tag: this must never
 * be mistaken for a comment that is already live on the pull request.
 */
export function AnnotationCard({
  stop, project, repoId, prId, headCommit, connectorName,
  ensure, top, left, onClose, onChanged, onCite,
}: Props) {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<AgentTurn[]>(stop.annotation?.turns ?? []);
  /* The question currently being answered, kept out of `turns` because the server has not recorded it
     yet. Shown the instant it is sent: typing something, watching it vanish, and seeing it reappear
     thirty seconds later above an answer reads as having lost the message. */
  const [pending, setPending] = useState<string | null>(null);
  const [streamedSegments, setStreamedSegments] = useState<AgentSegment[]>([]);
  const [streamed, setStreamed] = useState("");
  const [reading, setReading] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [posting, setPosting] = useState<AgentSegment | null>(null);
  const [busy, setBusy] = useState(false);

  const abort = useRef<AbortController | null>(null);
  const body = useRef<HTMLDivElement>(null);

  const key = `${stop.path}:${stop.line}`;

  // Reset everything when the card moves to another line — a part-typed follow-up about line 22 must
  // not be sitting in the box when the card reopens on line 108.
  useEffect(() => {
    setQuestion("");
    setPending(null);
    setStreamedSegments([]);
    setStreamed("");
    setFailure(null);
  }, [key]);

  useEffect(() => { setTurns(stop.annotation?.turns ?? []); }, [stop.annotation?.turns]);
  useEffect(() => () => abort.current?.abort(), []);

  // Keep the newest turn in view as the answer grows.
  useEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [turns.length, pending, streamedSegments.length, streamed]);

  // Esc dismisses, matching the composer this card is modelled on.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const resolved = stop.annotation?.status === "resolved";
  const streaming = pending !== null;

  /* The cited line was recorded against a commit the PR head has since moved past, so it may have
     moved or stopped existing. §7.6 leaves re-anchoring open, and guessing an answer that hasn't been
     thought through would be worse than saying so — this is the flag, not the fix. */
  const staleSha = stop.annotation?.commitSha;
  const stale = !!staleSha && !!headCommit && staleSha !== headCommit;

  async function ask(text: string) {
    const q = text.trim();
    if (!q || streaming) return;

    // Cleared and shown as a pending turn in the same tick, so the message never appears to be lost.
    setQuestion("");
    setPending(q);
    setStreamedSegments([]);
    setStreamed("");
    setReading(null);
    setFailure(null);

    const controller = new AbortController();
    abort.current = controller;

    try {
      const id = await ensure();
      if (!id) { setFailure("This annotation could not be saved."); return; }

      await askAgent(project, repoId, prId, q, {
        onReading: (info) => setReading(info.detail || info.tool),
        onSegment: (s) => setStreamedSegments((prev) => [...prev, s]),
        onDelta: (t) => setStreamed((prev) => prev + t),
        onComplete: (turn) => {
          setTurns((prev) => [...prev, turn]);
          setStreamedSegments([]);
          setStreamed("");
        },
        onError: (e) => setFailure(e.detail ?? e.code),
        // The only difference from a main-thread question: the history replayed is this
        // annotation's own, and the prompt is told which line the conversation is about.
      }, controller.signal, id);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setFailure("The request could not be completed.");
      }
    } finally {
      setPending(null);
      abort.current = null;
      onChanged();
    }
  }

  async function setStatus(status: string) {
    setBusy(true);
    try {
      const id = await ensure();
      if (id) await api.setAnnotationStatus(project, repoId, prId, id, status);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* Dims the lines the card covers, so they read as deliberately obscured rather than as a
          rendering fault. */}
      <div className="diff-scrim" style={{ top: top - 4 }} />

      {/* Same geometry as the PR comment composer: `left` is the anchored pane's offset plus a gutter
          allowance, so side by side the card sits over the modified pane rather than the original. */}
      <div className="ann-card" data-sev={stop.severity} style={{ top: top + 6, left: left + 52 }}>
        <div className="ann-head">
          {/* Never mistakable for a live comment: this is the whole reason for the dashed border. */}
          <span className="ann-tag">Not posted</span>
          <span className="ann-where">line {stop.line}</span>
          {resolved && <span className="ann-tag resolved">Resolved</span>}
          <span style={{ flex: 1 }} />
          <button className="ag-mini" onClick={onClose} title="Close (Esc)">✕</button>
        </div>

        {stale && (
          <div className="ann-stale">
            Based on an earlier commit (<code>{staleSha!.slice(0, 7)}</code>), so this line may have
            moved since.
          </div>
        )}

        <div className="ann-body" ref={body}>
          {/* The claim that opened this. Plain prose, deliberately unbadged: the provenance belongs to
              the segment back in the conversation, and stamping a badge here would be this card
              asserting something on the agent's behalf — which is exactly what §5.2.1 forbids. */}
          {stop.seed && (
            <div className="ann-seed">
              <div className="ann-who">{(connectorName ?? "Agent").toUpperCase()} said</div>
              <Markdown text={stop.seed} />
            </div>
          )}

          {turns.map((t) => (
            <div className="ann-turn" key={t.id}>
              <div className="ag-you"><div className="ag-bubble">{t.question}</div></div>
              {t.errorCode && (
                <p className="ag-failed">That answer failed — <code>{t.errorCode}</code>.</p>
              )}
              {t.segments.map((s, i) => (
                <Segment
                  key={i}
                  segment={s}
                  onCite={onCite}
                  onPost={t.postable ? () => setPosting(s) : undefined}
                />
              ))}
            </div>
          ))}

          {pending !== null && (
            <div className="ann-turn">
              {/* The reviewer's own words, on screen from the moment they press Ask. */}
              <div className="ag-you"><div className="ag-bubble">{pending}</div></div>

              {streamedSegments.map((s, i) => <Segment key={i} segment={s} onCite={onCite} />)}
              {streamed && <Markdown text={streamed} />}

              <div className="ag-pending">
                <span className="spin" aria-hidden="true" />
                <span className="ag-thinking">
                  {reading ? <>reading <code>{reading}</code>…</> : "thinking…"}
                </span>
              </div>
            </div>
          )}

          {failure && <p className="ag-failed">{failure}</p>}
        </div>

        <div className="ann-foot">
          <textarea
            className="input"
            rows={2}
            value={question}
            disabled={streaming}
            placeholder="Ask about this line…"
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(question); }
            }}
          />
          <div className="ann-actions">
            {/* Resolving dims the marker and drops it from the cycle; it never deletes, on the same
                principle as §7.5 — a record of what was asked survives. */}
            <button className="ag-mini" disabled={busy} onClick={() => setStatus(resolved ? "open" : "resolved")}>
              {resolved ? "Reopen" : "Resolve"}
            </button>
            <span style={{ flex: 1 }} />
            {streaming
              ? <button className="ag-mini" onClick={() => abort.current?.abort()}>Stop</button>
              : (
                <button className="btn small primary" disabled={!question.trim()} onClick={() => ask(question)}>
                  Ask
                </button>
              )}
          </div>
          <div className="ann-fine">Private to you. Nothing here is on the pull request.</div>
        </div>
      </div>

      {posting && (
        <PostSheet
          segment={posting}
          connectorName={connectorName}
          project={project}
          repoId={repoId}
          prId={prId}
          onClose={() => setPosting(null)}
        />
      )}
    </>
  );
}
