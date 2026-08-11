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
const SHELF_COLOR_FAMILIES = ["red", "orange", "amber", "green", "teal", "blue", "violet", "pink"];

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

  // --- mutations ---
  const createView = useMutation({
    mutationFn: (name: string) => api.createView(name, views.length, [DEFAULT_SHELF], {}, {}, []),
    onSuccess: (v) => { qc.invalidateQueries({ queryKey: ["views"] }); setActiveViewId(v.id); },
  });
  const saveLayout = useMutation({
    mutationFn: (a: { view: SavedView; shelves: string[]; items: ViewItem[]; shelfWidths: Record<string, number>; shelfColors: Record<string, string> }) =>
      api.updateView(a.view.id, a.view.name, a.view.sortOrder, a.shelves, a.shelfWidths, a.shelfColors, a.items),
    onError: () => qc.invalidateQueries({ queryKey: ["views"] }),
  });
  const renameView = useMutation({
    mutationFn: (a: { view: SavedView; name: string }) =>
      api.updateView(a.view.id, a.name, a.view.sortOrder, a.view.shelves, a.view.shelfWidths ?? {}, a.view.shelfColors ?? {}, a.view.items),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["views"] }),
  });
  const deleteView = useMutation({
    mutationFn: (id: string) => api.deleteView(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["views"] }); setActiveViewId(null); },
  });

  const freshest = (id: string): SavedView | undefined =>
    (qc.getQueryData<SavedView[]>(["views"]) ?? []).find((v) => v.id === id);

  function commit(view: SavedView, shelves: string[], items: ViewItem[], shelfWidths?: Record<string, number>, shelfColors?: Record<string, string>) {
    const widths = shelfWidths ?? view.shelfWidths ?? {};
    const colors = shelfColors ?? view.shelfColors ?? {};
    qc.setQueryData<SavedView[]>(["views"], (prev) =>
      (prev ?? []).map((v) => (v.id === view.id ? { ...v, shelves, items, shelfWidths: widths, shelfColors: colors } : v)));
    saveLayout.mutate({ view, shelves, items, shelfWidths: widths, shelfColors: colors });
  }

  async function ensureView(): Promise<SavedView> {
    if (activeView) return activeView;
    const created = await api.createView("My pipelines", views.length, [DEFAULT_SHELF], {}, {}, []);
    await qc.invalidateQueries({ queryKey: ["views"] });
    setActiveViewId(created.id);
    return created;
  }

  function targetShelf(view: SavedView, shelf?: string): string {
    return shelf ?? shelvesOf(view)[0];
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

  // Reorder a dragged card to sit before `target` (landing on target's shelf).
  function reorderItem(dragged: ViewItem, target: ViewItem) {
    if (!activeView || sameItem(dragged, target)) return;
    const view = freshest(activeView.id) ?? activeView;
    const without = view.items.filter((i) => !sameItem(i, dragged));
    const ti = without.findIndex((i) => sameItem(i, target));
    if (ti < 0) return;
    without.splice(ti, 0, { ...dragged, shelf: shelfOfItem(view, target) });
    commit(view, shelvesOf(view), without);
  }

  function addShelf() {
    if (!activeView) return;
    const name = window.prompt("New shelf name", "New shelf");
    if (!name || !name.trim()) return;
    const view = freshest(activeView.id) ?? activeView;
    const shelves = shelvesOf(view);
    if (shelves.includes(name.trim())) return;
    commit(view, [...shelves, name.trim()], view.items);
  }

  function renameShelf(oldName: string) {
    if (!activeView) return;
    const name = window.prompt("Rename shelf", oldName);
    if (!name || !name.trim() || name.trim() === oldName) return;
    const view = freshest(activeView.id) ?? activeView;
    const nn = name.trim();
    const widths = { ...(view.shelfWidths ?? {}) };
    if (oldName in widths) { widths[nn] = widths[oldName]; delete widths[oldName]; }
    const colors = { ...(view.shelfColors ?? {}) };
    if (oldName in colors) { colors[nn] = colors[oldName]; delete colors[oldName]; }
    commit(view,
      shelvesOf(view).map((s) => (s === oldName ? nn : s)),
      view.items.map((i) => (shelfOfItem(view, i) === oldName ? { ...i, shelf: nn } : i)),
      widths, colors);
  }

  function deleteShelf(name: string) {
    if (!activeView) return;
    const view = freshest(activeView.id) ?? activeView;
    const shelves = shelvesOf(view);
    if (shelves.length <= 1) return;
    const remaining = shelves.filter((s) => s !== name);
    const widths = { ...(view.shelfWidths ?? {}) };
    delete widths[name];
    const colors = { ...(view.shelfColors ?? {}) };
    delete colors[name];
    commit(view, remaining,
      view.items.map((i) => (shelfOfItem(view, i) === name ? { ...i, shelf: remaining[0] } : i)),
      widths, colors);
  }

  // Drag a shelf to sit before `target` — combined with widths, lets shelves sit side by side.
  function reorderShelves(dragged: string, target: string) {
    if (!activeView || dragged === target) return;
    const view = freshest(activeView.id) ?? activeView;
    const shelves = shelvesOf(view).filter((s) => s !== dragged);
    const ti = shelves.indexOf(target);
    if (ti < 0) return;
    shelves.splice(ti, 0, dragged);
    commit(view, shelves, view.items);
  }

  // Per-shelf width in card-width units (0 = full width).
  const shelfUnits = (view: SavedView, name: string): number => view.shelfWidths?.[name] ?? 0;

  function setShelfWidth(name: string, units: number) {
    if (!activeView) return;
    const view = freshest(activeView.id) ?? activeView;
    const widths = { ...(view.shelfWidths ?? {}) };
    if (units <= 0) delete widths[name]; else widths[name] = units;
    commit(view, shelvesOf(view), view.items, widths);
  }

  // Per-shelf colour family ("" = none).
  const shelfColor = (view: SavedView, name: string): string => view.shelfColors?.[name] ?? "";

  function setShelfColor(name: string, family: string) {
    if (!activeView) return;
    const view = freshest(activeView.id) ?? activeView;
    const colors = { ...(view.shelfColors ?? {}) };
    if (!family) delete colors[name]; else colors[name] = family;
    commit(view, shelvesOf(view), view.items, view.shelfWidths ?? {}, colors);
  }

  const [colorMenu, setColorMenu] = useState<string | null>(null);

  // Live drag-resize: snap the shelf width to the nearest whole card-width.
  const CARD_W = 320, CARD_GAP = 12, SHELF_PAD = 26;
  const shelfPx = (units: number) => units * CARD_W + (units - 1) * CARD_GAP + SHELF_PAD;
  const [resizing, setResizing] = useState<{ name: string; units: number } | null>(null);

  function startResize(e: React.PointerEvent, name: string) {
    e.preventDefault();
    e.stopPropagation();
    const shelfEl = (e.currentTarget as HTMLElement).closest(".shelf") as HTMLElement | null;
    if (!shelfEl) return;
    const left = shelfEl.getBoundingClientRect().left;
    const unitsAt = (clientX: number) =>
      Math.max(1, Math.min(8, Math.round((clientX - left - SHELF_PAD + CARD_GAP) / (CARD_W + CARD_GAP))));
    const onMove = (ev: PointerEvent) => setResizing({ name, units: unitsAt(ev.clientX) });
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const units = unitsAt(ev.clientX);
      setResizing(null);
      setShelfWidth(name, units);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // --- drag & drop ---
  const poolDrag = useRef<Pipeline | null>(null);
  const seqDrag = useRef<Sequence | null>(null);
  const cardDrag = useRef<ViewItem | null>(null);
  const shelfDrag = useRef<string | null>(null);
  const [hintShelf, setHintShelf] = useState<string | null>(null);

  // Any drag ending (drop, cancel, or a card-to-card drop that stopped propagation)
  // must clear the shelf drop-outline and drag state.
  useEffect(() => {
    const clear = () => {
      setHintShelf(null);
      poolDrag.current = null;
      seqDrag.current = null;
      cardDrag.current = null;
    };
    window.addEventListener("dragend", clear);
    return () => window.removeEventListener("dragend", clear);
  }, []);

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
              <button className="btn ghost small icon-btn" title="Delete this view" onClick={() => {
                if (window.confirm(`Delete view "${activeView.name}"?`)) deleteView.mutate(activeView.id);
              }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </button>
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

            {activeView && (
              <div className="shelves-wrap">
                {shelvesOf(activeView).map((shelf) => {
                  const items = activeView.items.filter((i) => shelfOfItem(activeView, i) === shelf);
                  const canDelete = shelvesOf(activeView).length > 1;
                  const units = resizing?.name === shelf ? resizing.units : shelfUnits(activeView, shelf);
                  const style: React.CSSProperties = units > 0 ? { width: shelfPx(units), flex: "0 0 auto" } : { width: "100%" };
                  return (
                    <section
                      key={shelf}
                      className="shelf"
                      style={style}
                      data-color={shelfColor(activeView, shelf) || undefined}
                      onDragOver={(e) => { e.preventDefault(); if (!shelfDrag.current) setHintShelf(shelf); }}
                      onDragLeave={(e) => { if (e.currentTarget === e.target) setHintShelf(null); }}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (shelfDrag.current) { reorderShelves(shelfDrag.current, shelf); shelfDrag.current = null; }
                        else handleShelfDrop(shelf);
                      }}
                    >
                      <div
                        className="shelf-head"
                        draggable
                        title="Drag to reorder / place shelves side by side"
                        onDragStart={(e) => { shelfDrag.current = shelf; poolDrag.current = null; seqDrag.current = null; cardDrag.current = null; e.dataTransfer.effectAllowed = "move"; }}
                      >
                        <span className="shelf-grip">⠿</span>
                        <span className="shelf-title">{shelf}</span>
                        <span className="shelf-count">{items.length}</span>
                        <span style={{ flex: 1 }} />
                        <div className="shelf-color-wrap">
                          <button className="btn ghost small icon-btn" title="Shelf colour" onClick={() => setColorMenu(colorMenu === shelf ? null : shelf)}>
                            <span className="shelf-color-dot" data-color={shelfColor(activeView, shelf) || undefined} />
                          </button>
                          {colorMenu === shelf && (
                            <div className="color-menu" onMouseLeave={() => setColorMenu(null)}>
                              <button className="swatch swatch-none" title="none" onClick={() => { setShelfColor(shelf, ""); setColorMenu(null); }} />
                              {SHELF_COLOR_FAMILIES.map((f) => (
                                <button key={f} className="swatch" data-color={f} title={f} onClick={() => { setShelfColor(shelf, f); setColorMenu(null); }} />
                              ))}
                            </div>
                          )}
                        </div>
                        <button className="btn ghost small" onClick={() => renameShelf(shelf)}>rename</button>
                        {units > 0 && <button className="btn ghost small" title="Reset to full width" onClick={() => setShelfWidth(shelf, 0)}>full</button>}
                        {canDelete && <button className="btn ghost small" onClick={() => deleteShelf(shelf)}>remove</button>}
                      </div>

                      <div className={`shelf-cards ${hintShelf === shelf ? "drop-hint" : ""}`}>
                        {items.length === 0 && (
                          <div className="shelf-empty">Drop pipelines or sequences here from the left.</div>
                        )}
                        {items.map((item) =>
                          item.kind === "sequence" ? (
                            <SequenceCard
                              key={itemKey(item)}
                              item={item}
                              sequence={sequences.find((s) => s.id === item.sequenceId)}
                              onRemove={removeItem}
                              onRename={renameItem}
                              onOpenRun={(project, buildId) => setRunDetail({ project, buildId })}
                              onDragCard={(i) => { cardDrag.current = i; poolDrag.current = null; seqDrag.current = null; }}
                              onReorder={(target) => { if (cardDrag.current) { reorderItem(cardDrag.current, target); cardDrag.current = null; } }}
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
                              onReorder={(target) => { if (cardDrag.current) { reorderItem(cardDrag.current, target); cardDrag.current = null; } }}
                            />
                          ),
                        )}
                      </div>

                      <div className="shelf-resize" title="Drag to resize (snaps to card widths)" onPointerDown={(e) => startResize(e, shelf)} />
                    </section>
                  );
                })}
              </div>
            )}

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
