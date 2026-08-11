import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Run, ViewItem } from "../types";
import { RunBadge } from "./Badge";
import { duration, runLabel, runTone, timeAgo } from "../lib/format";
import { notify } from "../lib/notify";

interface Props {
  item: ViewItem;
  onRun: (item: ViewItem) => void;
  onOpenRun: (project: string, buildId: number) => void;
  onRemove: (item: ViewItem) => void;
  onRename: (item: ViewItem, name: string) => void;
  onDragCard: (item: ViewItem) => void;
}

export function PipelineCard({ item, onRun, onOpenRun, onRemove, onRename, onDragCard }: Props) {
  const runsQ = useQuery<Run[]>({
    queryKey: ["runs", item.project, item.pipelineId],
    queryFn: () => api.runs(item.project, item.pipelineId, 4),
    refetchInterval: (q) => {
      const data = q.state.data;
      const active = data?.some((r) => r.state !== "completed");
      return active ? 4000 : 15000;
    },
  });

  const runs = runsQ.data ?? [];
  const latest = runs[0];

  // Fire a desktop notification when a run we've seen running turns terminal.
  const seen = useRef<Map<number, string>>(new Map());
  const seeded = useRef(false);
  useEffect(() => {
    if (!runs.length) return;
    for (const r of runs) {
      const prev = seen.current.get(r.id);
      if (seeded.current && prev && prev !== "completed" && r.state === "completed") {
        notify(
          `${item.name} — ${runLabel(r)}`,
          `${r.branch ?? ""} · build ${r.buildNumber ?? r.id}`.trim(),
          `run-${r.id}`,
        );
      }
      seen.current.set(r.id, r.state);
    }
    seeded.current = true;
  }, [runs, item.name]);

  return (
    <div
      className="card"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        onDragCard(item);
      }}
    >
      <div className="card-head">
        <div className="title">
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
          <div className="sub">{item.project}</div>
        </div>
        <RunBadge run={latest} />
      </div>

      <div className="runs">
        {runsQ.isLoading && (
          <div className="faint" style={{ fontSize: 12 }}><span className="spin" /> loading runs…</div>
        )}
        {!runsQ.isLoading && runs.length === 0 && (
          <div className="faint" style={{ fontSize: 12 }}>No runs yet.</div>
        )}
        {runs.map((r) => (
          <div className="run-line" key={r.id} onClick={() => onOpenRun(item.project, r.id)}
            style={{ cursor: "pointer" }} title="View run & logs">
            <span className={`badge ${runTone(r)}`} style={{ minWidth: 0 }}><span className="dot" /></span>
            <span className="rl-branch">{r.branch ?? "—"}</span>
            <span className="rl-spacer" />
            <span className="faint">
              {r.state === "completed" ? duration(r) : r.state === "inProgress" ? "running" : "queued"}
            </span>
            <span className="faint">·</span>
            <span className="faint">{timeAgo(r.startTime ?? r.queueTime)}</span>
          </div>
        ))}
      </div>

      <div className="actions">
        <button className="btn primary small" onClick={() => onRun(item)}>▶ Run</button>
        {latest && (
          <button className="btn small" onClick={() => onOpenRun(item.project, latest.id)}>Logs</button>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn ghost small" title="Remove from view" onClick={() => onRemove(item)}>✕</button>
      </div>
    </div>
  );
}
