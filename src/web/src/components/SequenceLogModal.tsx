import type { SequenceRun, SequenceRunStep } from "../types";
import { timeAgo } from "../lib/format";

function statusTone(status: string): string {
  switch (status) {
    case "succeeded": return "success";
    case "failed": return "failed";
    case "running": return "running";
    case "canceled": return "canceled";
    default: return "idle";
  }
}

function stepTone(s: SequenceRunStep): string {
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

function stepLabel(s: SequenceRunStep): string {
  if (s.state === "pending") return "pending";
  if (s.state === "skipped") return "skipped";
  if (s.state === "running" || s.state === "inProgress" || s.state === "notStarted") return "running";
  return s.result ?? s.state;
}

export function SequenceLogModal({ run, sequenceName, onClose, onOpenRun }: {
  run: SequenceRun;
  sequenceName: string;
  onClose: () => void;
  onOpenRun: (project: string, buildId: number) => void;
}) {
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide">
        <div className="modal-head">
          <div className="title">Sequence run · {sequenceName}</div>
          <span className={`badge ${statusTone(run.status)}`}><span className="dot" />{run.status}</span>
          <button className="btn ghost small" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="row" style={{ gap: 16, marginBottom: 14, flexWrap: "wrap" }}>
            <span className="muted">started {timeAgo(run.startedAt)}</span>
            {run.finishedAt && <span className="muted">finished {timeAgo(run.finishedAt)}</span>}
            <span className="muted">{run.steps.length} step(s)</span>
          </div>

          <div className="seq-log-steps">
            {run.steps.map((s) => (
              <div className="seq-log-step" key={s.index}>
                <div className="seq-log-step-head">
                  <span className="seq-step-num">{s.index + 1}</span>
                  <strong>{s.name}</strong>
                  <span className={`badge ${stepTone(s)}`}><span className="dot" />{stepLabel(s)}</span>
                  <span style={{ flex: 1 }} />
                  {s.startedAt && <span className="faint" style={{ fontSize: 12 }}>{timeAgo(s.finishedAt ?? s.startedAt)}</span>}
                  {s.buildId && (
                    <button className="btn ghost small" onClick={() => onOpenRun(s.project, s.buildId!)}>
                      Pipeline logs ↗
                    </button>
                  )}
                </div>
                {s.message && <pre className="seq-log-message">{s.message}</pre>}
                {!s.message && s.state === "skipped" && (
                  <div className="faint" style={{ fontSize: 12, paddingLeft: 30 }}>Skipped — an earlier step did not succeed.</div>
                )}
                {!s.message && s.result === "failed" && s.buildId && (
                  <div className="faint" style={{ fontSize: 12, paddingLeft: 30 }}>
                    The pipeline ran but did not succeed — open its logs for details.
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
