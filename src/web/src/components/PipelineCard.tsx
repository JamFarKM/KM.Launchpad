import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Run, ViewItem } from "../types";
import { branchShort, duration, runLabel, runTone, timeAgo, timeAgoShort } from "../lib/format";
import { notify } from "../lib/notify";
import { CloseIcon, LogsIcon, PlayIcon, ShelfHealthPill, StatusGlyph } from "./StatusGlyph";

interface Props {
  item: ViewItem;
  onRun: (item: ViewItem) => void;
  onOpenRun: (project: string, buildId: number) => void;
  onRemove: (item: ViewItem) => void;
  onRename: (item: ViewItem, name: string) => void;
  onToggleLabel: (item: ViewItem, show: boolean) => void;
  /** Shelf-level health, shown in the footer of the shelf's first card only. */
  shelfHealth?: { failing: number; running: number };
  onDragCard: (item: ViewItem) => void;
  onReorder: (target: ViewItem) => void;
}

export function PipelineCard({
  item, onRun, onOpenRun, onRemove, onRename, onToggleLabel, shelfHealth, onDragCard, onReorder,
}: Props) {
  const [menu, setMenu] = useState(false);

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
  // No glyph at all until there's something to report — an unrun pipeline shouldn't
  // wear an empty placeholder badge.
  const tone = runTone(latest);
  const showGlyph = tone !== "idle";

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
      className={`card ${item.showLabel ? "show-label" : ""}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        onDragCard(item);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onReorder(item); }}
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
        </div>
        <div className="card-head-right">
          {showGlyph && <StatusGlyph tone={tone} label={runLabel(latest)} />}
          <button className="card-close" title="Remove from view" onClick={() => onRemove(item)}>
            <CloseIcon />
          </button>
        </div>
      </div>

      <div className="sub">{item.project}</div>

      <div className="runs">
        {runsQ.isLoading && (
          <div className="faint" style={{ fontSize: 12 }}><span className="spin" /> loading runs…</div>
        )}
        {!runsQ.isLoading && runs.length === 0 && (
          <div className="faint" style={{ fontSize: 12 }}>No runs yet.</div>
        )}
        {runs.map((r) => (
          <div
            className="run-line"
            key={r.id}
            onClick={() => onOpenRun(item.project, r.id)}
            style={{ cursor: "pointer" }}
            title={`${r.branch ?? "—"} — ${timeAgo(r.startTime ?? r.queueTime)}`}
          >
            <span className={`rl-dot ${runTone(r)}`} />
            <span className="rl-branch">{branchShort(r.branch)}</span>
            <span className="rl-meta">
              {r.state === "completed" ? duration(r) : r.state === "inProgress" ? "running" : "queued"}
              {" · "}
              {timeAgoShort(r.startTime ?? r.queueTime)}
            </span>
          </div>
        ))}
      </div>

      <div className="actions">
        <button className="run-btn ghost" title="Run" onClick={() => onRun(item)}>
          <PlayIcon />
        </button>
        {latest && (
          <button className="btn small icon-only" title="View logs" aria-label="View logs"
            onClick={() => onOpenRun(item.project, latest.id)}>
            <LogsIcon />
          </button>
        )}
        {shelfHealth && <ShelfHealthPill health={shelfHealth} />}
        <div className="card-menu-wrap">
          <button className="card-menu-btn" title="Card options" onClick={() => setMenu((m) => !m)}>⋯</button>
          {menu && (
            <div className="card-menu" onMouseLeave={() => setMenu(false)}>
              <label>
                <input
                  type="checkbox"
                  checked={!!item.showLabel}
                  onChange={(e) => onToggleLabel(item, e.target.checked)}
                />
                Show project label
              </label>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
