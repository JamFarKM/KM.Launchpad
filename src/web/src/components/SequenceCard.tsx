import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import type { Sequence, SequenceRun, SequenceRunStep, ViewItem } from "../types";
import { notify } from "../lib/notify";
import { commonPrefix, stepShort, timeAgo } from "../lib/format";
import { clearLastResult, isCleared, onCleared } from "../lib/seqDismiss";
import { SequenceRunDialog } from "./SequenceRunDialog";
import { SequenceLogModal } from "./SequenceLogModal";
import { CloseIcon, PlayIcon, ShelfHealthPill, StatusGlyph } from "./StatusGlyph";
import type { StatusTone } from "../lib/format";

interface Props {
  item: ViewItem;
  sequence?: Sequence;
  onRemove: (item: ViewItem) => void;
  onRename: (item: ViewItem, name: string) => void;
  onToggleLabel: (item: ViewItem, show: boolean) => void;
  /** Shelf-level health, shown in the footer of the shelf's first card only. */
  shelfHealth?: { failing: number; running: number };
  /** This card's sequence is the one the editor panel is pointed at (§5). */
  editing?: boolean;
  onEdit: () => void;
  onOpenRun: (project: string, buildId: number) => void;
  onDragCard: (item: ViewItem) => void;
  onReorder: (target: ViewItem) => void;
}

const VISIBLE_STEPS = 4; // collapse past this so a long sequence can't drive its neighbours' height

function seqStatusTone(status?: string | null): StatusTone {
  return status === "succeeded" ? "success"
    : status === "failed" ? "failed"
    : status === "running" ? "running"
    : status === "canceled" ? "canceled"
    : "idle";
}

function stepTone(s: SequenceRunStep): StatusTone {
  if (s.state === "running" || s.state === "inProgress" || s.state === "notStarted") return "running";
  if (s.state === "pending") return "idle";
  if (s.state === "skipped") return "canceled";
  switch (s.result) {
    case "succeeded": return "success";
    case "failed": return "failed";
    case "canceled": return "canceled";
    default: return "idle";
  }
}

const isTerminal = (r?: SequenceRun | null) =>
  !!r && (r.status === "succeeded" || r.status === "failed" || r.status === "canceled");

export function SequenceCard({
  item, sequence, onRemove, onRename, onToggleLabel, shelfHealth, editing, onEdit,
  onOpenRun, onDragCard, onReorder,
}: Props) {
  const seqId = item.sequenceId!;
  const qc = useQueryClient();
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showRunDialog, setShowRunDialog] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [menu, setMenu] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const latestQ = useQuery<SequenceRun | null>({
    queryKey: ["seq-latest", seqId],
    queryFn: () => api.sequenceRuns(seqId, 1).then((r) => r[0] ?? null),
    enabled: !activeRunId,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 3000 : false),
  });

  const runQ = useQuery<SequenceRun>({
    queryKey: ["seq-run", activeRunId],
    queryFn: () => api.sequenceRun(activeRunId!),
    enabled: !!activeRunId,
    refetchInterval: (q) => (isTerminal(q.state.data) ? false : 3000),
  });

  const latest = (activeRunId ? runQ.data : latestQ.data) ?? null;

  /* A cleared result must survive a refetch, so it's recorded by run id rather than by wiping
     the cache. Re-render on the event so a second card for the same sequence — on another shelf
     or another view — clears at the same moment. */
  const [, bumpCleared] = useState(0);
  useEffect(() => onCleared(() => bumpCleared((n) => n + 1)), []);
  const run = isCleared(seqId, latest?.id) ? null : latest;

  /* Running from this card switches it to ["seq-run", activeRunId] and disables ["seq-latest"],
     which is what the board's shelf-health pill reads. That left the pill holding the previous
     run indefinitely: the card could show green while the pill still said "1 failing".
     Invalidating on the start and on each status change keeps both readers on the same run. */
  useEffect(() => {
    if (!activeRunId) return;
    qc.invalidateQueries({ queryKey: ["seq-latest", seqId] });
  }, [activeRunId, runQ.data?.status, seqId, qc]);

  // Notify once when the active run reaches a terminal state.
  const notified = useRef<string | null>(null);
  useEffect(() => {
    if (run && isTerminal(run) && notified.current !== run.id) {
      notified.current = run.id;
      notify(`${sequence?.name ?? "Sequence"} — ${run.status}`, `${run.steps.length} step(s)`, `seq-${run.id}`);
    }
  }, [run, sequence?.name]);

  function start() {
    // If the sequence has pre-run inputs, collect them first; otherwise run now.
    if (sequence && sequence.inputs.length > 0) setShowRunDialog(true);
    else runNow({});
  }

  async function runNow(inputs: Record<string, string>) {
    setBusy(true);
    setError(null);
    try {
      const started = await api.runSequence(seqId, inputs);
      setActiveRunId(started.id);
      notified.current = null;
      setShowRunDialog(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to start the sequence.");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (activeRunId) { try { await api.cancelSequenceRun(activeRunId); } catch { /* ignore */ } }
  }

  const steps = run?.steps ?? sequence?.steps.map((s, i) => ({
    index: i, project: s.project, pipelineId: s.pipelineId, name: s.name,
    state: "pending", result: null,
  } as SequenceRunStep)) ?? [];

  // Short step labels: the author's per-step alias wins; otherwise strip the prefix
  // shared by every step in the sequence so the verbose ADO name fits the card.
  const prefix = useMemo(() => commonPrefix(steps.map((s) => s.name)), [steps]);
  const labelFor = (s: SequenceRunStep, i: number) =>
    sequence?.steps[i]?.alias?.trim() || stepShort(s.name, prefix);

  const hidden = Math.max(0, steps.length - VISIBLE_STEPS);
  const shown = expanded ? steps : steps.slice(0, VISIBLE_STEPS);

  const running = run?.status === "running";
  const missing = !sequence;

  return (
    <>
    <div className={`card seq-card ${item.showLabel ? "show-label" : ""} ${editing ? "is-editing" : ""}`} draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; onDragCard(item); }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onReorder(item); }}>
      <div className="card-head">
        <div className="title">
          <span className="seq-badge">SEQ</span>
          <span
            className="card-title-text"
            title="Double-click to rename"
            onDoubleClick={() => {
              const n = window.prompt("Rename card", item.name);
              if (n && n.trim()) onRename(item, n.trim());
            }}
          >
            {item.name}
          </span>
        </div>
        <div className="card-head-right">
          {/* No glyph until the sequence has actually run — see PipelineCard. */}
          {seqStatusTone(run?.status) !== "idle" && (
            <StatusGlyph
              tone={seqStatusTone(run?.status)}
              label={missing ? "sequence not found" : run?.status ?? "no runs"}
            />
          )}
          <button className="card-close" title="Remove from view" onClick={() => onRemove(item)}>
            <CloseIcon />
          </button>
        </div>
      </div>

      <div className="sub">{missing ? "sequence not found" : `${sequence!.steps.length} steps`}</div>

      {error && <div className="error" style={{ fontSize: 12 }}>{error}</div>}

      <div className="seq-flow">
        {shown.map((s, i) => (
          <div className="seq-step" key={i} title={s.message ?? s.name}>
            <span className={`seq-step-dot ${stepTone(s)}`} />
            <button
              className="seq-step-name linklike"
              disabled={!s.buildId}
              title={s.buildId ? `${s.name} — view logs` : s.name}
              onClick={() => s.buildId && onOpenRun(s.project, s.buildId)}
            >
              {labelFor(s, i)}
            </button>
          </div>
        ))}
        {hidden > 0 && (
          <button className="seq-more" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "show fewer" : `+${hidden} more`}
          </button>
        )}
      </div>

      {run?.startedAt && (
        <div className="card-meta">
          {running ? "started" : "last run"} {timeAgo(run.finishedAt ?? run.startedAt)}
        </div>
      )}

      <div className="actions">
        <button className="run-btn solid" title="Run sequence" onClick={start} disabled={busy || running || missing}>
          {busy ? <span className="spin" /> : <PlayIcon />}
        </button>
        {running && <button className="btn small" onClick={cancel}>Cancel</button>}
        {/* Same word as the pipeline card's (POLISH §2) — it was the same unreadable glyph. */}
        {run && (
          <button className="btn small logs-btn" title="View this sequence run's logs"
            aria-label="View logs" onClick={() => setShowLog(true)}>
            LOGS
          </button>
        )}
        {shelfHealth && <ShelfHealthPill health={shelfHealth} />}
        <div className="card-menu-wrap">
          <button className="card-menu-btn" title="Card options" onClick={() => setMenu((m) => !m)}>⋯</button>
          {menu && (
            <div className="card-menu" onMouseLeave={() => setMenu(false)}>
              {/* First item (§5): the panel is where a sequence is authored, and this is the
                  path you take when you're looking at the card rather than the library. */}
              <button className="card-menu-item" onClick={() => { onEdit(); setMenu(false); }}>
                Edit sequence…
              </button>
              <label>
                <input
                  type="checkbox"
                  checked={!!item.showLabel}
                  onChange={(e) => onToggleLabel(item, e.target.checked)}
                />
                Show project label
              </label>
              {/* Acknowledges a result you've dealt with, so a stale failure stops colouring the
                  card and the shelf pill. Only the run in hand is cleared — the next one shows
                  normally. Nothing is deleted; the run stays in the logs. */}
              {run && isTerminal(run) && (
                <button
                  className="card-menu-item"
                  onClick={() => { clearLastResult(seqId, run.id); setActiveRunId(null); setMenu(false); }}
                >
                  Clear last result
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>

    {showRunDialog && sequence && (
      <SequenceRunDialog
        sequence={sequence}
        busy={busy}
        onClose={() => setShowRunDialog(false)}
        onRun={(inputs) => runNow(inputs)}
      />
    )}

    {showLog && run && (
      <SequenceLogModal
        run={run}
        sequenceName={sequence?.name ?? item.name}
        onClose={() => setShowLog(false)}
        /* Drilling into a step's pipeline log replaces this modal rather than stacking beneath it.
           Both use the same overlay z-index and this one is portalled to the body, so it painted
           over the run modal that had just opened. Two full-screen overlays also leave the
           backdrop click and Escape acting on the wrong one. */
        onOpenRun={(project, buildId) => { setShowLog(false); onOpenRun(project, buildId); }}
      />
    )}
    </>
  );
}
