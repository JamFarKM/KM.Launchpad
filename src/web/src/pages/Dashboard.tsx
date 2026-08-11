import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Pipeline, Project, SavedView, Sequence, ViewItem } from "../types";
import { PipelinePool } from "../components/PipelinePool";
import { PipelineCard } from "../components/PipelineCard";
import { SequenceCard } from "../components/SequenceCard";
import { RunDialog } from "../components/RunDialog";
import { RunDetailModal } from "../components/RunDetailModal";
import { ensureNotifyPermission } from "../lib/notify";

const DEFAULT_SHELF = "Pipelines";

const shelvesOf = (v: SavedView): string[] => (v.shelves.length ? v.shelves : [DEFAULT_SHELF]);
const shelfOfItem = (v: SavedView, i: ViewItem): string => {
  const ss = shelvesOf(v);
  return i.shelf && ss.includes(i.shelf) ? i.shelf : ss[0];
};
const itemKey = (i: ViewItem): string =>
  i.kind === "sequence" ? `seq:${i.sequenceId}` : `pipe:${i.project}:${i.pipelineId}`;
const sameItem = (a: ViewItem, b: ViewItem) => itemKey(a) === itemKey(b);

export function Dashboard() {
  const qc = useQueryClient();

  useEffect(() => { ensureNotifyPermission(); }, []);

  const [poolCollapsed, setPoolCollapsed] = useState(() => localStorage.getItem("pl-pool-collapsed") === "1");
  function togglePool() {
    setPoolCollapsed((c) => {
      const next = !c;
      localStorage.setItem("pl-pool-collapsed", next ? "1" : "0");
      return next;
    });
  }

  const projectsQ = useQuery<Project[]>({ queryKey: ["projects"], queryFn: api.projects });
  const sequencesQ = useQuery<Sequence[]>({ queryKey: ["sequences"], queryFn: api.sequences });
  const [activeProject, setActiveProject] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!activeProject && projectsQ.data && projectsQ.data.length > 0) {
      setActiveProject(projectsQ.data[0].name);
    }
  }, [projectsQ.data, activeProject]);

  const pipelinesQ = useQuery<Pipeline[]>({
    queryKey: ["pipelines", activeProject],
    queryFn: () => api.pipelines(activeProject),
    enabled: !!activeProject,
  });

  const viewsQ = useQuery<SavedView[]>({ queryKey: ["views"], queryFn: api.views });
  const views = viewsQ.data ?? [];
  const sequences = sequencesQ.data ?? [];
  const [activeViewId, setActiveViewId] = useState<string | null>(null);

  useEffect(() => {
    if (views.length > 0 && (!activeViewId || !views.some((v) => v.id === activeViewId))) {
      setActiveViewId(views[0].id);
    }
  }, [views, activeViewId]);

  const activeView = views.find((v) => v.id === activeViewId) ?? null;

  const [activeShelf, setActiveShelf] = useState<string>(DEFAULT_SHELF);
  useEffect(() => {
    if (activeView) {
      const ss = shelvesOf(activeView);
      if (!ss.includes(activeShelf)) setActiveShelf(ss[0]);
    }
  }, [activeView, activeShelf]);

  // --- mutations ---
  const createView = useMutation({
    mutationFn: (name: string) => api.createView(name, views.length, [DEFAULT_SHELF], []),
    onSuccess: (v) => { qc.invalidateQueries({ queryKey: ["views"] }); setActiveViewId(v.id); },
  });
  const saveLayout = useMutation({
    mutationFn: (a: { view: SavedView; shelves: string[]; items: ViewItem[] }) =>
      api.updateView(a.view.id, a.view.name, a.view.sortOrder, a.shelves, a.items),
    onError: () => qc.invalidateQueries({ queryKey: ["views"] }),
  });
  const renameView = useMutation({
    mutationFn: (a: { view: SavedView; name: string }) =>
      api.updateView(a.view.id, a.name, a.view.sortOrder, a.view.shelves, a.view.items),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["views"] }),
  });
  const deleteView = useMutation({
    mutationFn: (id: string) => api.deleteView(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["views"] }); setActiveViewId(null); },
  });

  const freshest = (id: string): SavedView | undefined =>
    (qc.getQueryData<SavedView[]>(["views"]) ?? []).find((v) => v.id === id);

  function commit(view: SavedView, shelves: string[], items: ViewItem[]) {
    qc.setQueryData<SavedView[]>(["views"], (prev) =>
      (prev ?? []).map((v) => (v.id === view.id ? { ...v, shelves, items } : v)));
    saveLayout.mutate({ view, shelves, items });
  }

  async function ensureView(): Promise<SavedView> {
    if (activeView) return activeView;
    const created = await api.createView("My pipelines", views.length, [DEFAULT_SHELF], []);
    await qc.invalidateQueries({ queryKey: ["views"] });
    setActiveViewId(created.id);
    return created;
  }

  function targetShelf(view: SavedView, shelf?: string): string {
    if (shelf) return shelf;
    return shelvesOf(view).includes(activeShelf) ? activeShelf : shelvesOf(view)[0];
  }

  async function addPipeline(p: Pipeline, shelf?: string) {
    const base = await ensureView();
    const view = freshest(base.id) ?? base;
    if (view.items.some((i) => i.kind !== "sequence" && i.project === p.project && i.pipelineId === p.id)) return;
    commit(view, shelvesOf(view), [
      ...view.items,
      { kind: "pipeline", project: p.project, pipelineId: p.id, name: p.name, shelf: targetShelf(view, shelf) },
    ]);
  }

  async function addSequence(s: Sequence, shelf?: string) {
    const base = await ensureView();
    const view = freshest(base.id) ?? base;
    if (view.items.some((i) => i.kind === "sequence" && i.sequenceId === s.id)) return;
    commit(view, shelvesOf(view), [
      ...view.items,
      { kind: "sequence", project: "", pipelineId: 0, sequenceId: s.id, name: s.name, shelf: targetShelf(view, shelf) },
    ]);
  }

  function removeItem(item: ViewItem) {
    if (!activeView) return;
    const view = freshest(activeView.id) ?? activeView;
    commit(view, shelvesOf(view), view.items.filter((i) => !sameItem(i, item)));
  }

  function moveItemToShelf(item: ViewItem, shelf: string) {
    if (!activeView) return;
    const view = freshest(activeView.id) ?? activeView;
    commit(view, shelvesOf(view), view.items.map((i) => (sameItem(i, item) ? { ...i, shelf } : i)));
  }

  function renameItem(item: ViewItem, name: string) {
    if (!activeView) return;
    const view = freshest(activeView.id) ?? activeView;
    commit(view, shelvesOf(view), view.items.map((i) => (sameItem(i, item) ? { ...i, name } : i)));
  }

  function addShelf() {
    if (!activeView) return;
    const name = window.prompt("New shelf name", "New shelf");
    if (!name || !name.trim()) return;
    const view = freshest(activeView.id) ?? activeView;
    const shelves = shelvesOf(view);
    if (shelves.includes(name.trim())) return;
    commit(view, [...shelves, name.trim()], view.items);
    setActiveShelf(name.trim());
  }

  function renameShelf(oldName: string) {
    if (!activeView) return;
    const name = window.prompt("Rename shelf", oldName);
    if (!name || !name.trim() || name.trim() === oldName) return;
    const view = freshest(activeView.id) ?? activeView;
    commit(view,
      shelvesOf(view).map((s) => (s === oldName ? name.trim() : s)),
      view.items.map((i) => (shelfOfItem(view, i) === oldName ? { ...i, shelf: name.trim() } : i)));
  }

  function deleteShelf(name: string) {
    if (!activeView) return;
    const view = freshest(activeView.id) ?? activeView;
    const shelves = shelvesOf(view);
    if (shelves.length <= 1) return;
    const remaining = shelves.filter((s) => s !== name);
    commit(view, remaining,
      view.items.map((i) => (shelfOfItem(view, i) === name ? { ...i, shelf: remaining[0] } : i)));
  }

  // --- drag & drop ---
  const poolDrag = useRef<Pipeline | null>(null);
  const seqDrag = useRef<Sequence | null>(null);
  const cardDrag = useRef<ViewItem | null>(null);
  const [hintShelf, setHintShelf] = useState<string | null>(null);

  function handleShelfDrop(shelf: string) {
    setHintShelf(null);
    if (poolDrag.current) { addPipeline(poolDrag.current, shelf); poolDrag.current = null; }
    else if (seqDrag.current) { addSequence(seqDrag.current, shelf); seqDrag.current = null; }
    else if (cardDrag.current) { moveItemToShelf(cardDrag.current, shelf); cardDrag.current = null; }
  }

  const pinnedIds = useMemo(() => {
    const ids = new Set<number>();
    activeView?.items.forEach((i) => { if (i.kind !== "sequence" && i.project === activeProject) ids.add(i.pipelineId); });
    return ids;
  }, [activeView, activeProject]);

  const pinnedSequenceIds = useMemo(() => {
    const ids = new Set<string>();
    activeView?.items.forEach((i) => { if (i.kind === "sequence" && i.sequenceId) ids.add(i.sequenceId); });
    return ids;
  }, [activeView]);

  // --- modals ---
  const [runItem, setRunItem] = useState<ViewItem | null>(null);
  const [runDetail, setRunDetail] = useState<{ project: string; buildId: number } | null>(null);

  return (
    <>
      <div className="body">
        {!poolCollapsed && (
          <PipelinePool
            projects={projectsQ.data ?? []}
            activeProject={activeProject}
            onProject={setActiveProject}
            pipelines={pipelinesQ.data ?? []}
            loading={pipelinesQ.isLoading || projectsQ.isLoading}
            search={search}
            onSearch={setSearch}
            pinnedIds={pinnedIds}
            onAdd={(p) => addPipeline(p)}
            onDragStart={(p) => { poolDrag.current = p; seqDrag.current = null; cardDrag.current = null; }}
            sequences={sequences}
            pinnedSequenceIds={pinnedSequenceIds}
            onAddSequence={(s) => addSequence(s)}
            onDragStartSequence={(s) => { seqDrag.current = s; poolDrag.current = null; cardDrag.current = null; }}
          />
        )}

        <div className="main">
          <div className="tabs">
            <button
              className="btn ghost small icon-btn"
              title={poolCollapsed ? "Show pipeline list" : "Hide pipeline list"}
              onClick={togglePool}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <line x1="9" y1="4" x2="9" y2="20" />
              </svg>
            </button>
            {views.map((v) => (
              <button
                key={v.id}
                className={`tab ${v.id === activeViewId ? "active" : ""}`}
                onClick={() => setActiveViewId(v.id)}
                onDoubleClick={() => {
                  const name = window.prompt("Rename view", v.name);
                  if (name && name.trim()) renameView.mutate({ view: v, name: name.trim() });
                }}
                title="Double-click to rename"
              >
                {v.name}
              </button>
            ))}
            <button className="btn ghost small" onClick={() => {
              const name = window.prompt("New view name", "My pipelines");
              if (name && name.trim()) createView.mutate(name.trim());
            }}>+ New view</button>
            {activeView && (
              <button className="btn ghost small" title="Delete this view" onClick={() => {
                if (window.confirm(`Delete view "${activeView.name}"?`)) deleteView.mutate(activeView.id);
              }}>🗑</button>
            )}
          </div>

          <div className="view-area">
            {viewsQ.isLoading && <div className="center-note"><span className="spin" /> Loading views…</div>}

            {!viewsQ.isLoading && views.length === 0 && (
              <div className="empty">
                <h3>No views yet</h3>
                <p>Create a view, then drag pipelines (or sequences) in from the left. Views are saved to your account.</p>
                <button className="btn primary" onClick={() => createView.mutate("My pipelines")}>Create your first view</button>
              </div>
            )}

            {activeView && shelvesOf(activeView).map((shelf) => {
              const items = activeView.items.filter((i) => shelfOfItem(activeView, i) === shelf);
              const canDelete = shelvesOf(activeView).length > 1;
              return (
                <section
                  key={shelf}
                  className={`shelf ${activeShelf === shelf ? "active" : ""}`}
                  onDragOver={(e) => { e.preventDefault(); setHintShelf(shelf); }}
                  onDragLeave={(e) => { if (e.currentTarget === e.target) setHintShelf(null); }}
                  onDrop={(e) => { e.preventDefault(); handleShelfDrop(shelf); }}
                >
                  <div className="shelf-head">
                    <span className="shelf-title">{shelf}</span>
                    <span className="shelf-count">{items.length}</span>
                    <button
                      className={`btn ghost small ${activeShelf === shelf ? "primary" : ""}`}
                      title="Add pipelines/sequences from the left to this shelf"
                      onClick={() => setActiveShelf(shelf)}
                    >
                      {activeShelf === shelf ? "◎ adding here" : "add here"}
                    </button>
                    <span style={{ flex: 1 }} />
                    <button className="btn ghost small" onClick={() => renameShelf(shelf)}>rename</button>
                    {canDelete && <button className="btn ghost small" onClick={() => deleteShelf(shelf)}>remove</button>}
                  </div>

                  <div className={`shelf-cards ${hintShelf === shelf ? "drop-hint" : ""}`}>
                    {items.length === 0 && (
                      <div className="shelf-empty">Drop pipelines or sequences here, or click “add here” then + in the list.</div>
                    )}
                    {items.map((item) =>
                      item.kind === "sequence" ? (
                        <SequenceCard
                          key={itemKey(item)}
                          item={item}
                          sequence={sequences.find((s) => s.id === item.sequenceId)}
                          onRemove={removeItem}
                          onRename={renameItem}
                          onDragCard={(i) => { cardDrag.current = i; poolDrag.current = null; seqDrag.current = null; }}
                        />
                      ) : (
                        <PipelineCard
                          key={itemKey(item)}
                          item={item}
                          onRun={setRunItem}
                          onOpenRun={(project, buildId) => setRunDetail({ project, buildId })}
                          onRemove={removeItem}
                          onRename={renameItem}
                          onDragCard={(i) => { cardDrag.current = i; poolDrag.current = null; seqDrag.current = null; }}
                        />
                      ),
                    )}
                  </div>
                </section>
              );
            })}

            {activeView && <button className="btn small add-shelf" onClick={addShelf}>+ Add shelf</button>}
          </div>
        </div>
      </div>

      {runItem && (
        <RunDialog
          item={runItem}
          onClose={() => setRunItem(null)}
          onLaunched={(project, buildId) => {
            setRunItem(null);
            setRunDetail({ project, buildId });
            qc.invalidateQueries({ queryKey: ["runs", project] });
          }}
        />
      )}

      {runDetail && (
        <RunDetailModal
          project={runDetail.project}
          buildId={runDetail.buildId}
          onClose={() => setRunDetail(null)}
        />
      )}
    </>
  );
}
