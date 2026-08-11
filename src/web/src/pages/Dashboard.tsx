import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Pipeline, Project, SavedView, User, ViewItem } from "../types";
import { PipelinePool } from "../components/PipelinePool";
import { PipelineCard } from "../components/PipelineCard";
import { RunDialog } from "../components/RunDialog";
import { RunDetailModal } from "../components/RunDetailModal";

export function Dashboard({ user, onDisconnect }: { user: User; onDisconnect: () => void }) {
  const qc = useQueryClient();

  const projectsQ = useQuery<Project[]>({ queryKey: ["projects"], queryFn: api.projects });
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
  const [activeViewId, setActiveViewId] = useState<string | null>(null);

  useEffect(() => {
    if (views.length > 0 && (!activeViewId || !views.some((v) => v.id === activeViewId))) {
      setActiveViewId(views[0].id);
    }
  }, [views, activeViewId]);

  const activeView = views.find((v) => v.id === activeViewId) ?? null;

  // --- view mutations ---
  const createView = useMutation({
    mutationFn: (name: string) => api.createView(name, views.length, []),
    onSuccess: (v) => {
      qc.invalidateQueries({ queryKey: ["views"] });
      setActiveViewId(v.id);
    },
  });

  const saveItems = useMutation({
    mutationFn: (args: { view: SavedView; items: ViewItem[] }) =>
      api.updateView(args.view.id, args.view.name, args.view.sortOrder, args.items),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["views"] }),
  });

  const renameView = useMutation({
    mutationFn: (args: { view: SavedView; name: string }) =>
      api.updateView(args.view.id, args.name, args.view.sortOrder, args.view.items),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["views"] }),
  });

  const deleteView = useMutation({
    mutationFn: (id: string) => api.deleteView(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["views"] });
      setActiveViewId(null);
    },
  });

  // --- helpers to add/remove pipelines ---
  async function ensureView(): Promise<SavedView> {
    if (activeView) return activeView;
    const created = await api.createView("My pipelines", views.length, []);
    await qc.invalidateQueries({ queryKey: ["views"] });
    setActiveViewId(created.id);
    return created;
  }

  async function addPipeline(p: Pipeline) {
    const view = await ensureView();
    if (view.items.some((i) => i.project === p.project && i.pipelineId === p.id)) return;
    const items = [...view.items, { project: p.project, pipelineId: p.id, name: p.name }];
    saveItems.mutate({ view, items });
  }

  function removeItem(item: ViewItem) {
    if (!activeView) return;
    const items = activeView.items.filter(
      (i) => !(i.project === item.project && i.pipelineId === item.pipelineId),
    );
    saveItems.mutate({ view: activeView, items });
  }

  // --- drag & drop ---
  const dragItem = useRef<Pipeline | null>(null);
  const [dropHint, setDropHint] = useState(false);

  const pinnedIds = useMemo(() => {
    const ids = new Set<number>();
    activeView?.items.forEach((i) => {
      if (i.project === activeProject) ids.add(i.pipelineId);
    });
    return ids;
  }, [activeView, activeProject]);

  // --- modals ---
  const [runItem, setRunItem] = useState<ViewItem | null>(null);
  const [runDetail, setRunDetail] = useState<{ project: string; buildId: number } | null>(null);

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          Pipeline <span>Launchpad</span>
        </div>
        <span className="faint">·</span>
        <span className="muted">{user.org}</span>
        <div className="spacer" />
        <span className="who">{user.displayName || user.uniqueName}</span>
        <button className="btn ghost small" onClick={onDisconnect}>Sign out</button>
      </div>

      <div className="body">
        <PipelinePool
          projects={projectsQ.data ?? []}
          activeProject={activeProject}
          onProject={setActiveProject}
          pipelines={pipelinesQ.data ?? []}
          loading={pipelinesQ.isLoading || projectsQ.isLoading}
          search={search}
          onSearch={setSearch}
          pinnedIds={pinnedIds}
          onAdd={addPipeline}
          onDragStart={(p) => (dragItem.current = p)}
        />

        <div className="main">
          <div className="tabs">
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
            <button
              className="btn ghost small"
              onClick={() => {
                const name = window.prompt("New view name", "My pipelines");
                if (name && name.trim()) createView.mutate(name.trim());
              }}
            >
              + New view
            </button>
            {activeView && (
              <button
                className="btn ghost small"
                title="Delete this view"
                onClick={() => {
                  if (window.confirm(`Delete view "${activeView.name}"?`))
                    deleteView.mutate(activeView.id);
                }}
              >
                🗑
              </button>
            )}
          </div>

          <div
            className={`view-area ${dropHint ? "drop-hint" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              if (!dropHint) setDropHint(true);
            }}
            onDragLeave={(e) => {
              if (e.currentTarget === e.target) setDropHint(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDropHint(false);
              if (dragItem.current) {
                addPipeline(dragItem.current);
                dragItem.current = null;
              }
            }}
          >
            {viewsQ.isLoading && <div className="center-note"><span className="spin" /> Loading views…</div>}

            {!viewsQ.isLoading && views.length === 0 && (
              <div className="empty">
                <h3>No views yet</h3>
                <p>
                  Create a view, then drag pipelines in from the left (or hit the{" "}
                  <b>+</b> next to each). Views are saved to your account.
                </p>
                <button
                  className="btn primary"
                  onClick={() => createView.mutate("My pipelines")}
                >
                  Create your first view
                </button>
              </div>
            )}

            {activeView && activeView.items.length === 0 && (
              <div className="empty">
                <h3>{activeView.name} is empty</h3>
                <p>Drag pipelines here from the left panel, or click the + beside a pipeline.</p>
              </div>
            )}

            {activeView && activeView.items.length > 0 && (
              <div className="cards">
                {activeView.items.map((item) => (
                  <PipelineCard
                    key={`${item.project}:${item.pipelineId}`}
                    item={item}
                    onRun={setRunItem}
                    onOpenRun={(project, buildId) => setRunDetail({ project, buildId })}
                    onRemove={removeItem}
                  />
                ))}
              </div>
            )}
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
    </div>
  );
}
