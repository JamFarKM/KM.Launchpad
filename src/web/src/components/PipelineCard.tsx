import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Run, ViewItem } from "../types";
import { branchShort, duration, runLabel, runTone, timeAgo, timeAgoShort } from "../lib/format";
import { groupConsecutive } from "../lib/truncate";
import { notify } from "../lib/notify";
import { describeTagFilter, isTagFilterEmpty, runsQuery, runTagsSuffix, tagFilterOf, type TagFilter } from "../lib/tagFilter";
import { CloseIcon, PlayIcon, ShelfHealthPill, StatusGlyph } from "./StatusGlyph";
import { TagFilterDialog } from "./TagFilterDialog";
import { Truncated } from "./Truncated";

interface Props {
  item: ViewItem;
  onRun: (item: ViewItem) => void;
  onOpenRun: (project: string, buildId: number) => void;
  onRemove: (item: ViewItem) => void;
  onRename: (item: ViewItem, name: string) => void;
  onToggleLabel: (item: ViewItem, show: boolean) => void;
  onSetTagFilter: (item: ViewItem, filter: TagFilter) => void;
  /** Shelf-level health, shown in the footer of the shelf's first card only. */
  shelfHealth?: { failing: number; running: number };
  onDragCard: (item: ViewItem) => void;
  onReorder: (target: ViewItem) => void;
}

export function PipelineCard({
  item, onRun, onOpenRun, onRemove, onRename, onToggleLabel, onSetTagFilter, shelfHealth, onDragCard, onReorder,
}: Props) {
  const [menu, setMenu] = useState(false);
  const [editingFilter, setEditingFilter] = useState(false);
  const filter = tagFilterOf(item);
  const filtered = !isTagFilterEmpty(filter);
  const filterText = describeTagFilter(filter);

  const runsQ = useQuery<Run[]>({
    ...runsQuery(item),
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

      {/* A filtered card shows a subset of runs; saying so on the card itself is what stops
          "why is the latest run missing?" (§2.3). Click to edit, same as the ⋯ menu entry. */}
      {filtered && (
        <button className="card-filter" onClick={() => setEditingFilter(true)} aria-label={`Run filter: ${filterText}. Edit`}>
          <Truncated className="card-filter-text" text={filterText} title={`Run filter: ${filterText}`} />
        </button>
      )}

      <div className="runs">
        {runsQ.isLoading && (
          <div className="faint" style={{ fontSize: 12 }}><span className="spin" /> loading runs…</div>
        )}
        {!runsQ.isLoading && runs.length === 0 && !filtered && (
          <div className="faint" style={{ fontSize: 12 }}>No runs yet.</div>
        )}
        {/* Name the scope and offer the way out: the filter is the likely reason it's empty. */}
        {!runsQ.isLoading && runs.length === 0 && filtered && (
          <div className="faint card-filter-empty">
            No recent runs {filterText}.{" "}
            <button className="card-filter-edit" onClick={() => setEditingFilter(true)}>Edit filter</button>
          </div>
        )}
        {/* POLISH §1.3: consecutive runs on one branch state it once. On real data all four runs
            on a card usually share a branch, so repeating it four times spent the whole row on
            nothing and left the timings cramped. Consecutive only — run history is chronological,
            and merging non-adjacent groups would misrepresent it. */}
        {groupConsecutive(runs, (r) => r.branch ?? "—").map((group) => (
          <div className="run-group" key={`${group.key}:${group.items[0].id}`}>
            <div className="rg-head">
              {/* Full branch name at full card width; only middle-truncated if it still overflows. */}
              <Truncated
                className="rg-branch"
                text={branchShort(group.key)}
                title={group.key}
              />
              {/* A single-run group still gets a count, per §1.3 — consistency beats compactness. */}
              <span className="rg-count">×{group.items.length}</span>
            </div>
            {group.items.map((r) => (
              <div
                className="run-line"
                key={r.id}
                onClick={() => onOpenRun(item.project, r.id)}
                title={`${r.branch ?? "—"} — ${timeAgo(r.startTime ?? r.queueTime)}${runTagsSuffix(r)}`}
              >
                <span className={`rl-dot ${runTone(r)}`} />
                <span className="rl-dur">
                  {r.state === "completed" ? duration(r) : r.state === "inProgress" ? "running" : "queued"}
                </span>
                <span className="rl-when">{timeAgoShort(r.startTime ?? r.queueTime)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="actions">
        <button className="run-btn ghost" title="Run" onClick={() => onRun(item)}>
          <PlayIcon />
        </button>
        {/* POLISH §2: the word, not a glyph. Detail dies below ~16px and two enclosed circles
            with an internal gap is past that limit — the binoculars rendered as `6d`. It sits on
            every card, so it was the most-repeated unclear element in the product. */}
        {latest && (
          <button className="btn small logs-btn" title="View logs" aria-label="View logs"
            onClick={() => onOpenRun(item.project, latest.id)}>
            LOGS
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
              <button className="card-menu-item" onClick={() => { setMenu(false); setEditingFilter(true); }}>
                {filtered ? "Edit run filter…" : "Filter runs by tag…"}
              </button>
            </div>
          )}
        </div>
      </div>

      {editingFilter && (
        <TagFilterDialog
          item={item}
          onClose={() => setEditingFilter(false)}
          onSave={(f) => { setEditingFilter(false); onSetTagFilter(item, f); }}
        />
      )}
    </div>
  );
}
