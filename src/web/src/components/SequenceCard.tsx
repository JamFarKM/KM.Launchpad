import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import type { Sequence, SequenceRun, SequenceRunStep, ViewItem } from "../types";
import { notify } from "../lib/notify";
import { timeAgo } from "../lib/format";
import { SequenceRunDialog } from "./SequenceRunDialog";
import { SequenceLogModal } from "./SequenceLogModal";

interface Props {
  item: ViewItem;
  sequence?: Sequence;
  onRemove: (item: ViewItem) => void;
  onRename: (item: ViewItem, name: string) => void;
  onOpenRun: (project: string, buildId: number) => void;
  onDragCard: (item: ViewItem) => void;
  onReorder: (target: ViewItem) => void;
}

function stepTone(s: SequenceRunStep): string {
  if (s.state === "running") return "running";
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

export function SequenceCard({ item, sequence, onRemove, onRename, onOpenRun, onDragCard, onReorder }: Props) {
  const seqId = item.sequenceId!;
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showRunDialog, setShowRunDialog] = useState(false);
  const [showLog, setShowLog] = useState(false);

  const latestQ = useQuery<SequenceRun | null>({
    queryKey: ["seq-latest", seqId],
    queryFn: () => api.sequenceRuns(seqId, 1).then((r) => r[0] ?? null),
    enabled: !activeRunId,
  });

  const runQ = useQuery<SequenceRun>({
    queryKey: ["seq-run", activeRunId],
    queryFn: () => api.sequenceRun(activeRunId!),
    enabled: !!activeRunId,
    refetchInterval: (q) => (isTerminal(q.state.data) ? false : 3000),
  });

  const run = (activeRunId ? runQ.data : latestQ.data) ?? null;

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

  const running = run?.status === "running";
  const missing = !sequence;

  // Long sequences widen in whole card-width units instead of growing tall.
  // Keep in sync with .shelf-cards > .card (320px) and the 12px gap.
  const NOMINAL = 320, GAP = 12, STEPS_PER_UNIT = 2, MAX_UNITS = 4;
  const units = Math.min(MAX_UNITS, Math.max(1, Math.ceil(steps.length / STEPS_PER_UNIT)));
  const cardWidth = units * NOMINAL + (units - 1) * GAP;

  return (
    <>
    <div className="card seq-card" draggable
      style={{ flex: "0 0 auto", width: cardWidth, maxWidth: "none" }}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; onDragCard(item); }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onReorder(item); }}>
      <div className="card-head">
        <div className="title">
          <span className="seq-badge">SEQ</span>{" "}
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
          <div className="sub seq-sub">
            <span>{missing ? "sequence not found" : `${sequence!.steps.length} steps`}</span>
            {run && (
              <>
                <span className="seq-sub-sep">·</span>
                <span className={`badge ${run.status === "succeeded" ? "success" : run.status === "failed" ? "failed" : run.status === "running" ? "running" : "canceled"}`}>
                  <span className="dot" />{run.status}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {error && <div className="error" style={{ fontSize: 12 }}>{error}</div>}

      <div className="seq-flow">
        {steps.map((s, i) => (
          <div className="seq-step" key={i} title={s.message ?? s.name}>
            <span className={`badge ${stepTone(s)}`}><span className="dot" /></span>
            <button
              className="seq-step-name linklike"
              disabled={!s.buildId}
              title={s.buildId ? "View logs" : s.name}
              onClick={() => s.buildId && onOpenRun(s.project, s.buildId)}
            >
              {s.name}
            </button>
            {i < steps.length - 1 && <span className="seq-arrow">→</span>}
          </div>
        ))}
      </div>

      {run?.startedAt && (
        <div className="faint" style={{ fontSize: 12 }}>
          {running ? "started" : "last run"} {timeAgo(run.finishedAt ?? run.startedAt)}
        </div>
      )}

      <div className="actions">
        <button className="btn primary small" onClick={start} disabled={busy || running || missing}>
          {busy ? <><span className="spin" /> starting…</> : running ? "running…" : "▶ Run sequence"}
        </button>
        {running && <button className="btn small" onClick={cancel}>Cancel</button>}
        {run && (
          <button className="btn small" title="View this sequence run's logs" onClick={() => setShowLog(true)}>
            Logs
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn ghost small" title="Remove from view" onClick={() => onRemove(item)}>✕</button>
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
        onOpenRun={onOpenRun}
      />
    )}
    </>
  );
}
