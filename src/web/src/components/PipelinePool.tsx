import { useMemo, useState } from "react";
import type { Pipeline, Project, Sequence } from "../types";

interface Props {
  projects: Project[];
  activeProject: string;
  onProject: (p: string) => void;
  pipelines: Pipeline[];
  loading: boolean;
  search: string;
  onSearch: (s: string) => void;
  pinnedIds: Set<number>;
  onAdd: (p: Pipeline) => void;
  onDragStart: (p: Pipeline) => void;
  // sequences
  sequences: Sequence[];
  pinnedSequenceIds: Set<string>;
  onAddSequence: (s: Sequence) => void;
  onDragStartSequence: (s: Sequence) => void;
  onEditSequence: (id: string) => void;
  onNewSequence: () => void;
  /** Stays mounted while collapsed so the panel can slide out instead of popping. */
  collapsed?: boolean;
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11.2 2.6l2.2 2.2L6 12.2l-3 .8.8-3z" />
    </svg>
  );
}

/**
 * The library drawer (SEQUENCES §4). Not pipelines-only: a pipeline and a sequence are both
 * "a thing you put on a shelf", so both lists live here and both are draggable. The search
 * field filters whichever tab is active.
 */
export function PipelinePool({
  projects, activeProject, onProject, pipelines, loading, search, onSearch,
  pinnedIds, onAdd, onDragStart,
  sequences, pinnedSequenceIds, onAddSequence, onDragStartSequence,
  onEditSequence, onNewSequence, collapsed,
}: Props) {
  const [source, setSource] = useState<"pipelines" | "sequences">("pipelines");

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? pipelines.filter((p) => p.name.toLowerCase().includes(q) || (p.folder ?? "").toLowerCase().includes(q))
      : pipelines;
    const groups = new Map<string, Pipeline[]>();
    for (const p of filtered) {
      const key = p.folder || "(root)";
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(p);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [pipelines, search]);

  const filteredSeqs = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? sequences.filter((s) => s.name.toLowerCase().includes(q)) : sequences;
  }, [sequences, search]);

  return (
    <aside className={`sidebar ${collapsed ? "is-collapsed" : ""}`} aria-hidden={collapsed}>
      {/* Counts are on the tabs so you can see there are sequences at all without switching. */}
      <div className="dtabs" role="tablist">
        <button
          className={`dtab ${source === "pipelines" ? "on" : ""}`}
          role="tab" aria-selected={source === "pipelines"}
          onClick={() => setSource("pipelines")}
        >
          Pipelines <span className="n">{pipelines.length}</span>
        </button>
        <button
          className={`dtab ${source === "sequences" ? "on" : ""}`}
          role="tab" aria-selected={source === "sequences"}
          onClick={() => setSource("sequences")}
        >
          Sequences <span className="n">{sequences.length}</span>
        </button>
      </div>

      <div className="pool-head">
        {source === "pipelines" && (
          <select className="select" value={activeProject} onChange={(e) => onProject(e.target.value)}>
            {projects.length === 0 && <option value="">No projects</option>}
            {projects.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
          </select>
        )}
        <input className="input" placeholder={`Search ${source}…`} value={search} onChange={(e) => onSearch(e.target.value)} />
      </div>

      <div className="pool-list">
        {source === "pipelines" && (
          <>
            {loading && <div className="center-note"><span className="spin" /> Loading pipelines…</div>}
            {!loading && pipelines.length === 0 && <div className="center-note">No pipelines in this project.</div>}
            {!loading && grouped.map(([folder, items]) => (
              <div className="pool-group" key={folder}>
                <div className="pool-group-title">{folder}</div>
                {items.map((p) => (
                  <div
                    key={p.id}
                    className={`pool-item ${p.enabled ? "" : "disabled"}`}
                    draggable
                    onDragStart={(e) => { e.dataTransfer.effectAllowed = "copy"; onDragStart(p); }}
                    title={p.enabled ? "Drag into a shelf, or click +" : "Disabled pipeline"}
                  >
                    <span className="name">{p.name}</span>
                    <button className="btn ghost small" disabled={pinnedIds.has(p.id)} onClick={() => onAdd(p)}
                      title={pinnedIds.has(p.id) ? "Already in this view" : "Add to current shelf"}>
                      {pinnedIds.has(p.id) ? "✓" : "+"}
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </>
        )}

        {source === "sequences" && (
          <div className="pool-group">
            {filteredSeqs.length === 0 && sequences.length === 0 && (
              <div className="center-note">No sequences yet. Create one below.</div>
            )}
            {filteredSeqs.length === 0 && sequences.length > 0 && (
              <div className="center-note">No sequences match.</div>
            )}
            {filteredSeqs.map((s) => (
              <div
                key={s.id}
                className="pool-item seq-row"
                draggable
                onDragStart={(e) => { e.dataTransfer.effectAllowed = "copy"; onDragStartSequence(s); }}
                onClick={() => onEditSequence(s.id)}
                title="Click to edit, drag onto a shelf, or click +"
              >
                <span className="grab" aria-hidden="true">⠿</span>
                <button className="name" onClick={() => onEditSequence(s.id)}>{s.name}</button>
                <span className="steps" title={`${s.steps.length} step${s.steps.length === 1 ? "" : "s"}`}>
                  {s.steps.length}
                </span>
                <button
                  className="pencil"
                  title="Edit sequence"
                  aria-label={`Edit ${s.name}`}
                  onClick={(e) => { e.stopPropagation(); onEditSequence(s.id); }}
                >
                  <PencilIcon />
                </button>
                <button className="btn ghost small" disabled={pinnedSequenceIds.has(s.id)}
                  onClick={(e) => { e.stopPropagation(); onAddSequence(s); }}
                  title={pinnedSequenceIds.has(s.id) ? "Already in this view" : "Add to current shelf"}>
                  {pinnedSequenceIds.has(s.id) ? "✓" : "+"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer button belongs to the Sequences tab only — there's no "new pipeline" here. */}
      {source === "sequences" && (
        <div className="pool-foot">
          <button className="btn outline wide" onClick={onNewSequence}>+ New sequence</button>
        </div>
      )}
    </aside>
  );
}
