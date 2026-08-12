import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import GridLayout, { type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { api } from "../api/client";
import { runTone } from "../lib/format";
import { isCleared, onCleared } from "../lib/seqDismiss";
import type { GridPos, Pipeline, Project, Run, SavedView, Sequence, SequenceRun, ViewItem } from "../types";
import { PipelinePool } from "../components/PipelinePool";
import { PipelineCard } from "../components/PipelineCard";
import { SequenceCard } from "../components/SequenceCard";
import { SequenceEditor } from "../components/SequenceEditor";
import { SequenceRunDialog } from "../components/SequenceRunDialog";
import { RunDialog } from "../components/RunDialog";
import { RunDetailModal } from "../components/RunDetailModal";
import { ensureNotifyPermission } from "../lib/notify";

const DEFAULT_SHELF = "Pipelines";

// Shelf accent hues (§2.2). No green and no red — a themed shelf must never be
// mistakable for a passing or failing one (invariant A2).
const SHELF_COLOR_FAMILIES = ["blue", "violet", "aqua", "orange", "magenta", "slate"];

// Colours stored before the redesign mapped onto the new palette; green and red are
// deliberately retired rather than carried over.
const LEGACY_COLORS: Record<string, string> = {
  red: "magenta", pink: "magenta", green: "aqua", teal: "aqua", amber: "orange",
};

// Grid geometry: a cell is exactly one SQUARE card. The column COUNT scales to the monitor
// width, so the card side is screen-derived and constant — it never depends on a shelf's span
// or live size, which is what keeps cards from resizing mid-drag. A shelf is a user-sized
// rectangle of w×h cells. --gutter (20px) is the ONE gutter: it separates shelves from each
// other; cards inside a shelf have none, they're divided by hairlines (A3).
const TARGET_CARD = 224;           // preferred square card side; actual side is fitted per screen
const MARGIN = 20;
const DEF_W = 2, DEF_H = 1, MIN_W = 1, MIN_H = 1;
const HEAD_H = 42;                 // .shelf-head height

const shelvesOf = (v: SavedView): string[] => (v.shelves.length ? v.shelves : [DEFAULT_SHELF]);
const shelfOfItem = (v: SavedView, i: ViewItem): string => {
  const ss = shelvesOf(v);
  return i.shelf && ss.includes(i.shelf) ? i.shelf : ss[0];
};
const itemKey = (i: ViewItem): string =>
  i.kind === "sequence" ? `seq:${i.sequenceId}` : `pipe:${i.project}:${i.pipelineId}`;
const sameItem = (a: ViewItem, b: ViewItem) => itemKey(a) === itemKey(b);

// Merge stored shelf placements with auto-placement for any shelf that has none yet.
// Placements saved under an earlier fine-grained (30px) row model are scaled back to whole
// card-rows so old dashboards don't explode to enormous heights after this change.
function buildRglLayout(view: SavedView, cols: number): Layout[] {
  const stored = view.shelfLayout ?? {};
  const shelves = shelvesOf(view);
  const legacy = Object.values(stored).some((p) => p.h > 4); // old fine rows were 8, 21, …
  const f = legacy ? 30 / 300 : 1; // scale legacy y/h down to card-rows
  const defW = Math.min(cols, DEF_W);
  const conv = (p: GridPos) => ({ y: Math.round(p.y * f), h: Math.max(MIN_H, Math.round(p.h * f)) });
  let maxBottom = 0;
  for (const s of shelves) { const p = stored[s]; if (p) { const c = conv(p); maxBottom = Math.max(maxBottom, c.y + c.h); } }
  let ax = 0, ay = maxBottom;
  return shelves.map((s) => {
    const p = stored[s];
    if (p) {
      const w = Math.max(MIN_W, Math.min(p.w, cols));
      const { y, h } = conv(p);
      return { i: s, x: Math.max(0, Math.min(p.x, cols - w)), y, w, h, minW: MIN_W, minH: MIN_H };
    }
    if (ax + defW > cols) { ax = 0; ay += DEF_H; }
    const item = { i: s, x: ax, y: ay, w: defW, h: DEF_H, minW: MIN_W, minH: MIN_H };
    ax += defW;
    return item;
  });
}

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

  /* ---- sequence editor (SEQUENCES §5) ----
     The draft lives here, not in the panel, because the board is the panel's preview: the cards
     have to render from the draft so a renamed step moves before you save. */
  const [editDraft, setEditDraft] = useState<Sequence | null>(null);
  const [editDirty, setEditDirty] = useState(false);

  function openEditor(id: string) {
    const seq = (sequencesQ.data ?? []).find((s) => s.id === id);
    if (!seq) return;
    // Both attributes in the same commit, so drawer-out and panel-in read as one transition
    // rather than two things fighting (§5). Drawer + board + editor is one pane too many.
    setPoolCollapsed(true);
    setEditDraft(structuredClone(seq));
    setEditDirty(false);
  }
  /* A new sequence is an unsaved draft with no id, not a record created up front — cancelling
     out of it should leave nothing behind. Save routes to create rather than update. */
  function newSequence() {
    setPoolCollapsed(true);
    setEditDraft({ id: "", name: "", inputs: [], steps: [] });
    setEditDirty(true);
  }
  function closeEditor() { setEditDraft(null); setEditDirty(false); }

  /* Running from the editor goes through the same dialog the card uses, so pre-run inputs are
     collected the same way rather than a second time in a second style. */
  const [editorRunSeq, setEditorRunSeq] = useState<Sequence | null>(null);
  const runFromEditor = useMutation({
    mutationFn: ({ id, inputs }: { id: string; inputs: Record<string, string> }) =>
      api.runSequence(id, inputs),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["seq-latest"] });
      setEditorRunSeq(null);
    },
  });

  const saveEdit = useMutation({
    mutationFn: (d: Sequence) =>
      d.id ? api.updateSequence(d.id, d.name, d.inputs, d.steps)
           : api.createSequence(d.name, d.inputs, d.steps),
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["sequences"] });
      setEditDraft(structuredClone(saved));
      setEditDirty(false);
    },
  });

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
    mutationFn: (a: { view: SavedView; shelves: string[]; items: ViewItem[]; shelfColors: Record<string, string>; shelfLayout: Record<string, GridPos> }) =>
      api.updateView(a.view.id, a.view.name, a.view.sortOrder, a.shelves, a.shelfColors, a.shelfLayout, a.items),
    onError: () => qc.invalidateQueries({ queryKey: ["views"] }),
  });
  const renameView = useMutation({
    mutationFn: (a: { view: SavedView; name: string }) =>
      api.updateView(a.view.id, a.name, a.view.sortOrder, a.view.shelves, a.view.shelfColors ?? {}, a.view.shelfLayout ?? {}, a.view.items),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["views"] }),
  });
  const deleteView = useMutation({
    mutationFn: (id: string) => api.deleteView(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["views"] }); setActiveViewId(null); },
  });

  const freshest = (id: string): SavedView | undefined =>
    (qc.getQueryData<SavedView[]>(["views"]) ?? []).find((v) => v.id === id);

  function commit(view: SavedView, shelves: string[], items: ViewItem[], shelfColors?: Record<string, string>, shelfLayout?: Record<string, GridPos>) {
    const colors = shelfColors ?? view.shelfColors ?? {};
    const layout = shelfLayout ?? view.shelfLayout ?? {};
    qc.setQueryData<SavedView[]>(["views"], (prev) =>
      (prev ?? []).map((v) => (v.id === view.id ? { ...v, shelves, items, shelfColors: colors, shelfLayout: layout } : v)));
    saveLayout.mutate({ view, shelves, items, shelfColors: colors, shelfLayout: layout });
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

  // Per-card "Show project label" opt-in, persisted in the view (§2.3).
  function toggleItemLabel(item: ViewItem, showLabel: boolean) {
    if (!activeView) return;
    const view = freshest(activeView.id) ?? activeView;
    commit(view, shelvesOf(view), view.items.map((i) => (sameItem(i, item) ? { ...i, showLabel } : i)));
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
    const colors = { ...(view.shelfColors ?? {}) };
    if (oldName in colors) { colors[nn] = colors[oldName]; delete colors[oldName]; }
    const layout = { ...(view.shelfLayout ?? {}) };
    if (oldName in layout) { layout[nn] = layout[oldName]; delete layout[oldName]; }
    commit(view,
      shelvesOf(view).map((s) => (s === oldName ? nn : s)),
      view.items.map((i) => (shelfOfItem(view, i) === oldName ? { ...i, shelf: nn } : i)),
      colors, layout);
  }

  function deleteShelf(name: string) {
    if (!activeView) return;
    const view = freshest(activeView.id) ?? activeView;
    const shelves = shelvesOf(view);
    if (shelves.length <= 1) return;
    const remaining = shelves.filter((s) => s !== name);
    const colors = { ...(view.shelfColors ?? {}) };
    delete colors[name];
    const layout = { ...(view.shelfLayout ?? {}) };
    delete layout[name];
    commit(view, remaining,
      view.items.map((i) => (shelfOfItem(view, i) === name ? { ...i, shelf: remaining[0] } : i)),
      colors, layout);
  }

  // Persist the grid whenever the user finishes dragging or resizing a shelf.
  function persistLayout(rgl: Layout[]) {
    if (!activeView) return;
    const view = freshest(activeView.id) ?? activeView;
    const map: Record<string, GridPos> = {};
    for (const l of rgl) map[l.i] = { x: l.x, y: l.y, w: l.w, h: l.h };
    commit(view, shelvesOf(view), view.items, undefined, map);
  }

  // Per-shelf colour family ("" = none), migrating any pre-redesign value (A2).
  const shelfColor = (view: SavedView, name: string): string => {
    const raw = view.shelfColors?.[name] ?? "";
    return LEGACY_COLORS[raw] ?? raw;
  };

  function setShelfColor(name: string, family: string) {
    if (!activeView) return;
    const view = freshest(activeView.id) ?? activeView;
    const colors = { ...(view.shelfColors ?? {}) };
    if (!family) delete colors[name]; else colors[name] = family;
    commit(view, shelvesOf(view), view.items, colors);
  }

  const [colorMenu, setColorMenu] = useState<string | null>(null);

  // --- grid width measurement (drives the column count so cells stay ~card-sized) ---
  const gridRef = useRef<HTMLDivElement>(null);
  const [gridW, setGridW] = useState(0);
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setGridW(entries[0].contentRect.width));
    ro.observe(el);
    setGridW(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  // Pick the column count that best fills the monitor (round, not floor, so we don't leave a
  // near-empty strip on the right), then divide the width evenly between those columns.
  const cols = Math.max(1, Math.round((gridW + MARGIN) / (TARGET_CARD + MARGIN)));
  const baseCol = Math.max(160, Math.floor((gridW - MARGIN * (cols - 1)) / cols));
  // Row pitch = one card + the header band, so a 1-tall shelf fits its card exactly.
  const rowHeight = baseCol + HEAD_H;

  // --- drag & drop (pool → shelf, card → shelf) ---
  const poolDrag = useRef<Pipeline | null>(null);
  const seqDrag = useRef<Sequence | null>(null);
  const cardDrag = useRef<ViewItem | null>(null);
  const [hintShelf, setHintShelf] = useState<string | null>(null);

  useEffect(() => {
    const clear = () => {
      setHintShelf(null);
      poolDrag.current = null;
      seqDrag.current = null;
      cardDrag.current = null;
    };
    // "drop" as well as "dragend": dropping a card onto another shelf re-renders it, so the
    // dragged node can be gone before its own dragend fires and the outline would stick.
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);

  function handleShelfDrop(shelf: string) {
    setHintShelf(null);
    if (poolDrag.current) { addPipeline(poolDrag.current, shelf); poolDrag.current = null; }
    else if (seqDrag.current) { addSequence(seqDrag.current, shelf); seqDrag.current = null; }
    else if (cardDrag.current) { moveItemToShelf(cardDrag.current, shelf); cardDrag.current = null; }
  }

  // --- shelf health (§2.2) ---
  // These reuse the exact query keys the cards use, so they share one cache entry and
  // add no extra requests; they exist only to make the header pill reactive.
  const items = activeView?.items ?? [];
  const pipeItems = items.filter((i) => i.kind !== "sequence");
  const seqItems = items.filter((i) => i.kind === "sequence" && i.sequenceId);

  const pipeStatuses = useQueries({
    queries: pipeItems.map((i) => ({
      queryKey: ["runs", i.project, i.pipelineId],
      queryFn: () => api.runs(i.project, i.pipelineId, 4),
    })),
  });
  const seqStatuses = useQueries({
    queries: seqItems.map((i) => ({
      queryKey: ["seq-latest", i.sequenceId],
      queryFn: () => api.sequenceRuns(i.sequenceId!, 1).then((r) => r[0] ?? null),
    })),
  });

  /* Cards read through the draft, which is what makes the board the editor's live preview.
     Nothing else changes: the card still receives a Sequence and doesn't know it's a draft. */
  const sequenceFor = (id?: string | null) =>
    (editDraft && editDraft.id === id ? editDraft : sequences.find((s) => s.id === id));

  /* §8.3: usedIn is derived by scanning views for references, never stored on the sequence —
     a stored copy drifts the moment someone removes a card. */
  const usedIn = useMemo(() => {
    if (!editDraft) return [];
    return (viewsQ.data ?? [])
      .filter((v) => v.items.some((i) => i.kind === "sequence" && i.sequenceId === editDraft.id))
      .map((v) => v.name);
  }, [viewsQ.data, editDraft]);

  // Dismissals live in localStorage, so the board has to be told when one happens.
  const [, bumpCleared] = useState(0);
  useEffect(() => onCleared(() => bumpCleared((n) => n + 1)), []);

  // shelf name → non-passing counts. An all-green shelf gets no pill at all.
  const health: Record<string, { failing: number; running: number }> = {};
  const bump = (shelf: string, key: "failing" | "running") => {
    health[shelf] ??= { failing: 0, running: 0 };
    health[shelf][key]++;
  };
  if (activeView) {
    pipeItems.forEach((it, idx) => {
      const latest = (pipeStatuses[idx]?.data as Run[] | undefined)?.[0];
      const tone = runTone(latest);
      if (tone === "failed") bump(shelfOfItem(activeView, it), "failing");
      else if (tone === "running") bump(shelfOfItem(activeView, it), "running");
    });
    seqItems.forEach((it, idx) => {
      const run = seqStatuses[idx]?.data as SequenceRun | null | undefined;
      // A result cleared from the card's menu must not keep colouring the shelf pill — that
      // disagreement is exactly what "clear last result" exists to resolve.
      if (isCleared(it.sequenceId!, run?.id)) return;
      if (run?.status === "failed") bump(shelfOfItem(activeView, it), "failing");
      else if (run?.status === "running") bump(shelfOfItem(activeView, it), "running");
    });
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
        {/* Always mounted so it can slide out; see .sidebar.is-collapsed. */}
        <PipelinePool
            collapsed={poolCollapsed}
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
            onEditSequence={openEditor}
            onNewSequence={newSequence}
        />

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
            {activeView && (
              <button className="btn ghost small" title="Add a shelf to this view" onClick={addShelf}>+ Add shelf</button>
            )}
          </div>

          <div className="view-area board">
            {viewsQ.isLoading && <div className="center-note"><span className="spin" /> Loading views…</div>}

            {!viewsQ.isLoading && views.length === 0 && (
              <div className="empty">
                <h3>No views yet</h3>
                <p>Create a view, then drag pipelines (or sequences) in from the left. Views are saved to your account.</p>
                <button className="btn primary" onClick={() => createView.mutate("My pipelines")}>Create your first view</button>
              </div>
            )}

            <div className="grid-canvas-wrap" ref={gridRef}>
              {activeView && (() => {
                if (gridW <= 0) return null;
                const layout = buildRglLayout(activeView, cols);
                const spans: Record<string, { w: number; h: number }> =
                  Object.fromEntries(layout.map((l) => [l.i, { w: l.w, h: l.h }]));
                /* The grid is authoritative for SHELVES, and the cards take up the slack.
                   A shelf spanning w×h cells also swallows the gutters between them (and, going
                   down, its one header band), so its cards share that out and tile it exactly —
                   no shoulder on the right, no blank strip along the bottom.

                   The cost is a little size variation between shelves of different spans: cards
                   are square on a 1-tall shelf and up to ~40px taller on a 3-tall one. Within any
                   one shelf they're identical, so rows and columns still line up. Both are derived
                   from the INTEGER span, so a card only resizes on a snap, never mid-drag. */
                const cardW = (w: number) => (baseCol * w + MARGIN * (w - 1)) / w;
                const cardH = (h: number) => (rowHeight * h + MARGIN * (h - 1) - HEAD_H) / h;
                return (
                <GridLayout
                  className="grid-canvas"
                  cols={cols}
                  rowHeight={rowHeight}
                  width={gridW}
                  margin={[MARGIN, MARGIN]}
                  containerPadding={[0, 0]}
                  layout={layout}
                  draggableHandle=".shelf-head"
                  draggableCancel=".btn,button,.shelf-menu,.shelf-menu-wrap"
                  onDragStop={persistLayout}
                  onResizeStop={persistLayout}
                  compactType={null}
                  preventCollision
                  allowOverlap={false}
                  isBounded={false}
                  resizeHandles={["se"]}
                >
                  {shelvesOf(activeView).map((shelf) => {
                    const all = activeView.items.filter((i) => shelfOfItem(activeView, i) === shelf);
                    const canDelete = shelvesOf(activeView).length > 1;
                    const hp = health[shelf];
                    const sw = spans[shelf]?.w ?? DEF_W;
                    const sh = spans[shelf]?.h ?? DEF_H;
                    // Only render what the shelf actually has cells for. Anything beyond that is
                    // reported in the header rather than half-drawn, spilling past the bottom edge.
                    const items = all.slice(0, Math.max(1, sw * sh));
                    const hiddenCount = all.length - items.length;
                    return (
                      <div
                        className="shelf-slot"
                        key={shelf}
                      >
                      <section
                        className="shelf"
                        data-color={shelfColor(activeView, shelf) || undefined}
                        onDragOver={(e) => { e.preventDefault(); setHintShelf(shelf); }}
                        onDragLeave={(e) => { if (e.currentTarget === e.target) setHintShelf(null); }}
                        onDrop={(e) => { e.preventDefault(); handleShelfDrop(shelf); }}
                      >
                        <div className="shelf-head" title="Drag to move this shelf around the grid">
                          <span className="shelf-grip">⠿</span>
                          <span className="shelf-title" title={shelf}>{shelf}</span>
                          {/* The health pill lives in the first card's footer, not here — on a
                              one-card shelf it left the title almost no room. */}
                          {hiddenCount > 0 && (
                            <span
                              className="shelf-hidden"
                              title={`${hiddenCount} card${hiddenCount === 1 ? "" : "s"} don't fit — make the shelf bigger to show them`}
                            >
                              +{hiddenCount}
                            </span>
                          )}
                          <span style={{ flex: 1 }} />
                          <div className="shelf-menu-wrap">
                            <button className="btn ghost small icon-btn" title="Shelf options" onClick={() => setColorMenu(colorMenu === shelf ? null : shelf)}>⋯</button>
                            {colorMenu === shelf && (
                              <div className="shelf-menu" onMouseLeave={() => setColorMenu(null)}>
                                <button className="menu-item" onClick={() => { setColorMenu(null); renameShelf(shelf); }}>Rename…</button>
                                <div className="menu-sep" />
                                <div className="menu-colors">
                                  <button className="swatch swatch-none" title="No colour" onClick={() => { setShelfColor(shelf, ""); setColorMenu(null); }} />
                                  {SHELF_COLOR_FAMILIES.map((f) => (
                                    <button key={f} className="swatch" data-color={f} title={f} onClick={() => { setShelfColor(shelf, f); setColorMenu(null); }} />
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                          {canDelete && (
                            <button className="btn ghost small icon-btn" title="Remove shelf" onClick={() => deleteShelf(shelf)}>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                            </button>
                          )}
                        </div>

                        <div
                          className="shelf-body"
                          style={{
                            ["--card-w" as string]: `${cardW(sw)}px`,
                            ["--card-h" as string]: `${cardH(sh)}px`,
                            ["--rows" as string]: String(sh),
                          }}
                        >
                          <div className={`shelf-cards ${hintShelf === shelf ? "drop-hint" : ""}`}>
                            {items.map((item, i) => {
                              // A card draws a divider against any neighbour inside the shelf,
                              // card or empty slot alike — only empty-to-empty seams stay open,
                              // so the hatched area reads as one continuous region.
                              const divRight = (i + 1) % sw !== 0;
                              const divBottom = i + sw < sw * sh;
                              return (
                                <div
                                  className="card-cell"
                                  key={itemKey(item)}
                                  data-div-right={divRight ? "" : undefined}
                                  data-div-bottom={divBottom ? "" : undefined}
                                >
                                  {item.kind === "sequence" ? (
                                    <SequenceCard
                                      item={item}
                                      sequence={sequenceFor(item.sequenceId)}
                                      /* §5: accent the card the panel is pointed at, so which
                                         sequence is under edit is never ambiguous. */
                                      editing={editDraft?.id === item.sequenceId}
                                      onEdit={() => openEditor(item.sequenceId!)}
                                      onRemove={removeItem}
                                      onRename={renameItem}
                                      onToggleLabel={toggleItemLabel}
                                      shelfHealth={i === 0 ? hp : undefined}
                                      onOpenRun={(project, buildId) => setRunDetail({ project, buildId })}
                                      onDragCard={(x) => { cardDrag.current = x; poolDrag.current = null; seqDrag.current = null; }}
                                      onReorder={(target) => { if (cardDrag.current) { reorderItem(cardDrag.current, target); cardDrag.current = null; } }}
                                    />
                                  ) : (
                                    <PipelineCard
                                      item={item}
                                      onRun={setRunItem}
                                      onOpenRun={(project, buildId) => setRunDetail({ project, buildId })}
                                      onRemove={removeItem}
                                      onRename={renameItem}
                                      onToggleLabel={toggleItemLabel}
                                      shelfHealth={i === 0 ? hp : undefined}
                                      onDragCard={(x) => { cardDrag.current = x; poolDrag.current = null; seqDrag.current = null; }}
                                      onReorder={(target) => { if (cardDrag.current) { reorderItem(cardDrag.current, target); cardDrag.current = null; } }}
                                    />
                                  )}
                                </div>
                              );
                            })}

                            {/* Unused cells are hatched, so it's obvious at a glance which slots
                                are free to drop into and how much room the shelf still has. */}
                            {Array.from({ length: Math.max(0, sw * sh - items.length) }, (_, k) => (
                              <div
                                key={`empty-${items.length + k}`}
                                className="card-cell is-empty"
                                title="Empty slot — drop a pipeline or sequence here"
                              />
                            ))}
                          </div>
                        </div>
                      </section>
                      </div>
                    );
                  })}
                </GridLayout>
                );
              })()}
            </div>
          </div>
        </div>

        {/* Third column of the same row as drawer and board (§2), so opening it narrows the
            board rather than covering it — the board is this panel's preview. */}
        {editDraft && (
          <SequenceEditor
            draft={editDraft}
            usedIn={usedIn}
            dirty={editDirty}
            saving={saveEdit.isPending}
            onChange={(next) => { setEditDraft(next); setEditDirty(true); }}
            onSave={() => saveEdit.mutate(editDraft)}
            onDiscard={() => { if (editDraft.id) openEditor(editDraft.id); else closeEditor(); }}
            onClose={closeEditor}
            onRun={() => {
              if (editDraft.inputs.length > 0) setEditorRunSeq(editDraft);
              else runFromEditor.mutate({ id: editDraft.id, inputs: {} });
            }}
            onGoToView={(name) => {
              const v = views.find((x) => x.name === name);
              if (v) setActiveViewId(v.id);
            }}
          />
        )}
      </div>

      {editorRunSeq && (
        <SequenceRunDialog
          sequence={editorRunSeq}
          busy={runFromEditor.isPending}
          onClose={() => setEditorRunSeq(null)}
          onRun={(inputs) => runFromEditor.mutate({ id: editorRunSeq.id, inputs })}
        />
      )}

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
