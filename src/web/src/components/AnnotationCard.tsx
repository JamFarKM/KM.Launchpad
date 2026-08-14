import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { askAgent } from "../lib/askAgent";
import { PostSheet, Segment } from "./AgentPanel";
import type { AgentSegment, AgentTurn, Annotation } from "../types";

interface Props {
  annotation: Annotation;
  project: string;
  repoId: string;
  prId: number;
  /** The PR's head commit, for the staleness note. */
  headCommit?: string | null;
  connectorName?: string | null;
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
  annotation, project, repoId, prId, headCommit, connectorName,
  top, left, onClose, onChanged, onCite,
}: Props) {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<AgentTurn[]>(annotation.turns);
  const [streaming, setStreaming] = useState(false);
  const [streamedSegments, setStreamedSegments] = useState<AgentSegment[]>([]);
  const [streamed, setStreamed] = useState("");
  const [reading, setReading] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [posting, setPosting] = useState<AgentSegment | null>(null);
  const [busy, setBusy] = useState(false);

  const abort = useRef<AbortController | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => { setTurns(annotation.turns); }, [annotation.turns]);
  useEffect(() => () => abort.current?.abort(), []);

  // Esc dismisses, matching the composer this card is modelled on.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const resolved = annotation.status === "resolved";

  /* The cited line was recorded against a commit the PR head has since moved past, so it may have
     moved or stopped existing. §7.6 leaves re-anchoring open, and guessing an answer that hasn't been
     thought through would be worse than saying so — this is the flag, not the fix. */
  const stale = !!annotation.commitSha && !!headCommit && annotation.commitSha !== headCommit;

  async function ask(text: string) {
    const q = text.trim();
    if (!q || streaming) return;

    setQuestion("");
    setStreamedSegments([]);
    setStreamed("");
    setReading(null);
    setFailure(null);
    setStreaming(true);

    const controller = new AbortController();
    abort.current = controller;

    try {
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
      }, controller.signal, annotation.id);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setFailure("The request could not be completed.");
      }
    } finally {
      setStreaming(false);
      abort.current = null;
      onChanged();
    }
  }

  async function setStatus(status: string) {
    setBusy(true);
    try {
      await api.setAnnotationStatus(project, repoId, prId, annotation.id, status);
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
      <div className="ann-card" ref={box} style={{ top: top + 6, left: left + 52 }}>
        <div className="ann-head">
          {/* Never mistakable for a live comment: this is the whole reason for the dashed border. */}
          <span className="ann-tag">Not posted</span>
          <span className="ann-where">line {annotation.line}</span>
          {resolved && <span className="ann-tag resolved">Resolved</span>}
          <span style={{ flex: 1 }} />
          <button className="ag-mini" onClick={onClose} title="Close (Esc)">✕</button>
        </div>

        {stale && (
          <div className="ann-stale">
            Based on an earlier commit (<code>{annotation.commitSha!.slice(0, 7)}</code>), so this line
            may have moved since.
          </div>
        )}

        <div className="ann-body">
          {/* The claim that opened the annotation, in the agent's own words. Not badged: the badge
              belongs to the segment in the conversation, and re-asserting a provenance here would be
              this card claiming something the agent said somewhere else. */}
          {annotation.seed && (
            <div className="ann-seed">
              <div className="ann-who">{(connectorName ?? "Agent").toUpperCase()} said</div>
              <Segment
                segment={{ text: annotation.seed, provenance: null, citations: [] }}
                onCite={onCite}
              />
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

          {streaming && (
            <div className="ann-turn">
              {streamedSegments.map((s, i) => <Segment key={i} segment={s} onCite={onCite} />)}
              {streamed && <Segment segment={{ text: streamed, provenance: null, citations: [] }} onCite={onCite} />}
              <div className="ag-pending">
                <span className="ag-prov pending">CHECKING SOURCES</span>
                {reading && <span className="ag-thinking">reading <code>{reading}</code>…</span>}
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
