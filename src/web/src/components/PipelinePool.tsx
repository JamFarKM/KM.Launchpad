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
}

export function PipelinePool({
  projects, activeProject, onProject, pipelines, loading, search, onSearch,
  pinnedIds, onAdd, onDragStart,
  sequences, pinnedSequenceIds, onAddSequence, onDragStartSequence,
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
    <aside className="sidebar">
      <div className="pool-head">
        <div className="nav" style={{ margin: 0 }}>
          <button className={`nav-btn ${source === "pipelines" ? "active" : ""}`} onClick={() => setSource("pipelines")}>
            Pipelines
          </button>
          <button className={`nav-btn ${source === "sequences" ? "active" : ""}`} onClick={() => setSource("sequences")}>
            Sequences
          </button>
        </div>
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
            {filteredSeqs.length === 0 && (
              <div className="center-note">No sequences. Create them on the Sequences page.</div>
            )}
            {filteredSeqs.map((s) => (
              <div
                key={s.id}
                className="pool-item"
                draggable
                onDragStart={(e) => { e.dataTransfer.effectAllowed = "copy"; onDragStartSequence(s); }}
                title="Drag into a shelf, or click +"
              >
                <span className="seq-badge">SEQ</span>
                <span className="name">{s.name}</span>
                <button className="btn ghost small" disabled={pinnedSequenceIds.has(s.id)} onClick={() => onAddSequence(s)}
                  title={pinnedSequenceIds.has(s.id) ? "Already in this view" : "Add to current shelf"}>
                  {pinnedSequenceIds.has(s.id) ? "✓" : "+"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
