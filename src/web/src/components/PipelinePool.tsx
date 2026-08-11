import { useMemo } from "react";
import type { Pipeline, Project } from "../types";

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
}

export function PipelinePool({
  projects,
  activeProject,
  onProject,
  pipelines,
  loading,
  search,
  onSearch,
  pinnedIds,
  onAdd,
  onDragStart,
}: Props) {
  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? pipelines.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            (p.folder ?? "").toLowerCase().includes(q),
        )
      : pipelines;

    const groups = new Map<string, Pipeline[]>();
    for (const p of filtered) {
      const key = p.folder || "(root)";
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(p);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [pipelines, search]);

  return (
    <aside className="sidebar">
      <div className="pool-head">
        <select
          className="select"
          value={activeProject}
          onChange={(e) => onProject(e.target.value)}
        >
          {projects.length === 0 && <option value="">No projects</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        <input
          className="input"
          placeholder="Search pipelines…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
      </div>

      <div className="pool-list">
        {loading && (
          <div className="center-note">
            <span className="spin" /> Loading pipelines…
          </div>
        )}
        {!loading && pipelines.length === 0 && (
          <div className="center-note">No pipelines in this project.</div>
        )}
        {!loading &&
          grouped.map(([folder, items]) => (
            <div className="pool-group" key={folder}>
              <div className="pool-group-title">{folder}</div>
              {items.map((p) => (
                <div
                  key={p.id}
                  className={`pool-item ${p.enabled ? "" : "disabled"}`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "copy";
                    onDragStart(p);
                  }}
                  title={p.enabled ? "Drag into a view, or click +" : "Disabled pipeline"}
                >
                  <span className="name">{p.name}</span>
                  <button
                    className="btn ghost small"
                    disabled={pinnedIds.has(p.id)}
                    onClick={() => onAdd(p)}
                    title={pinnedIds.has(p.id) ? "Already in this view" : "Add to current view"}
                  >
                    {pinnedIds.has(p.id) ? "✓" : "+"}
                  </button>
                </div>
              ))}
            </div>
          ))}
      </div>
    </aside>
  );
}
