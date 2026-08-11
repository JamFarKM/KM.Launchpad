import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import type { LogEntry, Run } from "../types";
import { RunBadge } from "./Badge";
import { duration, timeAgo } from "../lib/format";

interface Props {
  project: string;
  buildId: number;
  onClose: () => void;
}

export function RunDetailModal({ project, buildId, onClose }: Props) {
  const runQ = useQuery<Run>({
    queryKey: ["run", project, buildId],
    queryFn: () => api.runDetail(project, buildId),
    refetchInterval: (q) => (q.state.data && q.state.data.state !== "completed" ? 4000 : false),
  });

  const logsQ = useQuery<LogEntry[]>({
    queryKey: ["run-logs", project, buildId],
    queryFn: () => api.runLogs(project, buildId),
    refetchInterval: runQ.data && runQ.data.state !== "completed" ? 5000 : false,
  });

  const [activeLog, setActiveLog] = useState<number | null>(null);

  const logs = logsQ.data ?? [];

  // Default to the last step with a log once logs arrive.
  useEffect(() => {
    if (activeLog === null && logs.length > 0) setActiveLog(logs[logs.length - 1].id);
  }, [logs, activeLog]);

  const contentQ = useQuery({
    queryKey: ["log", project, buildId, activeLog],
    queryFn: () => api.logContent(project, buildId, activeLog!),
    enabled: activeLog !== null,
    refetchInterval: runQ.data && runQ.data.state !== "completed" ? 5000 : false,
  });

  const run = runQ.data;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide">
        <div className="modal-head">
          <div className="title">
            Run #{run?.buildNumber ?? buildId}
          </div>
          <RunBadge run={run} />
          <button className="btn ghost small" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {run && (
            <div className="row" style={{ gap: 16, marginBottom: 14, flexWrap: "wrap" }}>
              <span className="muted">branch <b style={{ color: "var(--text)" }}>{run.branch ?? "—"}</b></span>
              <span className="muted">by <b style={{ color: "var(--text)" }}>{run.requestedFor ?? "—"}</b></span>
              <span className="muted">started {timeAgo(run.startTime ?? run.queueTime)}</span>
              {run.state === "completed" && <span className="muted">took {duration(run)}</span>}
              <span style={{ flex: 1 }} />
              <a className="btn small" href={run.webUrl} target="_blank" rel="noreferrer">
                Open in Azure DevOps ↗
              </a>
            </div>
          )}

          {runQ.error && (
            <div className="error">
              {runQ.error instanceof ApiError ? runQ.error.message : "Could not load run."}
            </div>
          )}

          <div className="log-layout">
            <div className="log-steps">
              {logsQ.isLoading && <div className="faint"><span className="spin" /> loading…</div>}
              {!logsQ.isLoading && logs.length === 0 && (
                <div className="faint" style={{ fontSize: 13 }}>No step logs yet.</div>
              )}
              {logs.map((l) => (
                <div
                  key={l.id}
                  className={`log-step ${activeLog === l.id ? "active" : ""}`}
                  onClick={() => setActiveLog(l.id)}
                >
                  <span className={`badge ${stepTone(l)}`}><span className="dot" /></span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {l.name || `Log ${l.id}`}
                  </span>
                </div>
              ))}
            </div>

            <div className="log-content">
              {activeLog === null && <span className="faint">Select a step to view its log.</span>}
              {activeLog !== null && contentQ.isLoading && <span className="faint">loading log…</span>}
              {activeLog !== null && contentQ.data && (contentQ.data.content || "(empty log)")}
              {contentQ.error && (
                <span className="faint">
                  {contentQ.error instanceof ApiError ? contentQ.error.message : "Could not load log."}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function stepTone(l: LogEntry): string {
  if (l.state !== "completed") return "running";
  switch (l.result) {
    case "succeeded":
      return "success";
    case "failed":
      return "failed";
    case "canceled":
    case "skipped":
      return "canceled";
    default:
      return "idle";
  }
}
