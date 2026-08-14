import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { AgentPanel } from "../components/AgentPanel";
import { RailResizer, useRailWidth } from "../components/RailResizer";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { branchShort, timeAgo } from "../lib/format";
import { Combobox } from "../components/Combobox";
import type { DiffStats } from "../components/MonacoDiff";
import type { Connector, PrChange, Project, PrThread, PullRequest, Repo, RepoFavourite } from "../types";

/** ADO's vote scale, as review actions. */
/* Approve is the only solid fill: "approve" genuinely is a good/bad axis and it's a single
   button, not a palette, so A2 allows it. Reject tints red on hover only — a permanently red
   destructive button in the primary position invites misclicks (§1). Each gets a 12px icon so
   the row is scannable without reading. "Approve with suggestions" shortens, since the row is
   already the widest thing on the page (§5). */
const VOTES: { vote: number; label: string; tone: string; icon: JSX.Element }[] = [
  {
    vote: 10, label: "Approve", tone: "ok",
    icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 8.5l3 3 6-7" /></svg>,
  },
  {
    vote: 5, label: "With suggestions", tone: "ok-soft",
    icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8.5l2.5 2.5 5-6" /><path d="M9.5 12.5h4" /></svg>,
  },
  {
    vote: -5, label: "Waiting for author", tone: "warn",
    icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><circle cx="8" cy="8" r="5.5" /><path d="M8 5.2v3.2l2.2 1.3" /></svg>,
  },
  {
    vote: -10, label: "Reject", tone: "bad",
    icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>,
  },
];
const voteLabel = (v: number) => VOTES.find((x) => x.vote === v)?.label ?? "No vote";

/**
 * A first pass at PR review: pull requests → changed files → diff.
 *
 * Monaco is ~2MB, so it's lazy-loaded — nothing else in the app pays for it, and the cost is
 * only taken when you actually open a diff. If this becomes a plugin, the host would expose
 * Monaco as a shared runtime module instead so several plugins can share one copy.
 */
const MonacoDiff = lazy(() =>
  import("../components/MonacoDiff").then((m) => ({ default: m.MonacoDiff })),
);

const CHANGE_TONE: Record<string, string> = {
  add: "add", edit: "edit", delete: "del", rename: "ren",
};

/** ADO reports composites like "edit, rename" — take the most meaningful one. */
function changeLabel(t: string): { key: string; text: string } {
  const parts = t.split(",").map((s) => s.trim().toLowerCase());
  for (const k of ["add", "delete", "rename", "edit"]) {
    if (parts.includes(k)) return { key: CHANGE_TONE[k] ?? "edit", text: k.toUpperCase() };
  }
  return { key: "edit", text: (parts[0] || "edit").toUpperCase() };
}

const fileName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const fileDir = (p: string) => {
  const segs = p.replace(/^\//, "").split("/");
  segs.pop();
  return segs.join("/");
};

/**
 * A path with a break opportunity after each separator (POLISH §1.5).
 *
 * Without these the CSS had to break anywhere to fit, which split segments mid-word —
 * `SA.Phase1.Migratio` / `ns/Scripts`. A `<wbr>` per slash means a wrap lands on a boundary that
 * means something, and nowhere else.
 */
const breakOnSeparators = (path: string) =>
  path.split("/").map((seg, i, all) => (
    <Fragment key={i}>
      {seg}{i < all.length - 1 && <>/<wbr /></>}
    </Fragment>
  ));

/** Full word for the badge tooltip, so the letter isn't the only carrier. */
const CHANGE_WORD: Record<string, string> = {
  add: "Added", del: "Deleted", edit: "Modified", ren: "Renamed",
};

/**
 * Viewed state is keyed by (PR, source commit) so it clears when the author pushes —
 * §12's open question, resolved: sourceCommit is already on the PR payload.
 */
const viewedKey = (prId: number, sourceCommit?: string | null) =>
  `pl-viewed:${prId}:${sourceCommit ?? "head"}`;

export function ReviewPage() {
  const qc = useQueryClient();
  const projectsQ = useQuery<Project[]>({ queryKey: ["projects"], queryFn: api.projects });
  const [project, setProject] = useState("");
  const [repoId, setRepoId] = useState("");
  const [prId, setPrId] = useState<number | null>(null);
  const [prFilter, setPrFilter] = useState("");
  const [path, setPath] = useState<string | null>(null);
  const [inline, setInline] = useState(false);
  const [stats, setStats] = useState<DiffStats | null>(null);
  const onStats = useCallback((s: DiffStats) => setStats(s), []);
  /* Set the moment the user touches the view toggle: from then on their choice wins and
     auto-selection stops. Reset when the selected file changes (§4). */
  const [viewLocked, setViewLocked] = useState(false);

  /* Toolbar view options (§5). Panels collapse so a wide side-by-side diff can use the whole
     window; wrap and code size are persisted so they survive file selection and reloads. */
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [viewMenu, setViewMenu] = useState(false);
  const [wrap, setWrap] = useState(() => localStorage.getItem("pl-diff-wrap") === "1");
  const [codeSize, setCodeSize] = useState(() => Number(localStorage.getItem("pl-code-size")) || 12);

  useEffect(() => { localStorage.setItem("pl-diff-wrap", wrap ? "1" : "0"); }, [wrap]);
  useEffect(() => {
    localStorage.setItem("pl-code-size", String(codeSize));
    // --code-size is the token of record, even though Monaco is driven by the option.
    document.documentElement.style.setProperty("--code-size", `${codeSize}px`);
  }, [codeSize]);

  useEffect(() => {
    if (!project && projectsQ.data?.length) setProject(projectsQ.data[0].name);
  }, [projectsQ.data, project]);

  const reposQ = useQuery<Repo[]>({
    queryKey: ["repos", project],
    queryFn: () => api.repos(project),
    enabled: !!project,
  });

  useEffect(() => {
    const repos = reposQ.data ?? [];
    if (repos.length && !repos.some((r) => r.id === repoId)) setRepoId(repos[0].id);
  }, [reposQ.data, repoId]);

  const prsQ = useQuery<PullRequest[]>({
    queryKey: ["prs", project, repoId],
    queryFn: () => api.pullRequests(project, repoId),
    enabled: !!project && !!repoId,
  });

  const all = prsQ.data ?? [];
  const prs = useMemo(() => {
    const q = prFilter.trim().toLowerCase();
    if (!q) return all;
    return all.filter((p) =>
      String(p.id).includes(q) ||
      p.title.toLowerCase().includes(q) ||
      (p.author ?? "").toLowerCase().includes(q));
  }, [all, prFilter]);
  // Look the selected PR up in the unfiltered list — filtering it out of the rail shouldn't
  // tear down the diff you're reading.
  const pr = all.find((p) => p.id === prId) ?? null;

  // Reset the file selection and its stats whenever the PR changes.
  useEffect(() => { setPath(null); setStats(null); }, [prId]);
  useEffect(() => { setStats(null); setViewLocked(false); }, [path]);

  const changesQ = useQuery<PrChange[]>({
    queryKey: ["pr-changes", project, repoId, prId],
    queryFn: () => api.prChanges(project, repoId, prId!),
    enabled: !!project && !!repoId && !!prId,
  });

  const changes = useMemo(() => changesQ.data ?? [], [changesQ.data]);

  useEffect(() => {
    if (changes.length && !changes.some((c) => c.path === path)) setPath(changes[0].path);
  }, [changes, path]);

  const diffQ = useQuery({
    queryKey: ["pr-diff", project, repoId, path, pr?.targetCommit, pr?.sourceCommit],
    queryFn: () => api.prFileDiff(project, repoId, path!, pr!.targetCommit!, pr!.sourceCommit!),
    enabled: !!project && !!repoId && !!path && !!pr?.targetCommit && !!pr?.sourceCommit,
    // Hold the previous file on screen while the next loads. Without this the editor is
    // swapped for a spinner, which tears down and rebuilds the whole Monaco instance on
    // every file click — expensive, and the source of the jitter.
    placeholderData: (prev) => prev,
  });

  // The editor always renders the diff it actually has; the header follows the selection,
  // so the two only disagree for the moment a new file is in flight (and it's dimmed).
  const shown = diffQ.data;
  const isStale = !!shown && shown.path !== path;

  /* Auto-inline (§4). A file that is 100% additions or 100% deletions leaves one pane empty
     and squeezes the code into half the width, so it opens Inline instead.

     Monaco's line counts only arrive once it has diffed, which would show a visible flip, so
     the one-sided case is also derived from the payload: a missing side means the file was
     added or deleted outright. Stats take over when present, which covers the subtler case of
     an edit whose every changed line is an addition. */
  const oneSided: "add" | "del" | null = (() => {
    if (!shown) return null;
    /* A missing side is authoritative: the file was added or deleted outright. This has to be
       checked BEFORE the line counts, because Monaco diffs an added file against an empty
       string — one empty line — and so reports a phantom single deletion. Trusting the counts
       first meant a genuinely added file came back +N/-1 and never qualified. */
    if (shown.before == null && shown.after != null) return "add";
    if (shown.after == null && shown.before != null) return "del";
    // Counts cover the subtler case: an edit whose every changed line is an addition.
    if (stats && !isStale) {
      if (stats.added > 0 && stats.removed === 0) return "add";
      if (stats.removed > 0 && stats.added === 0) return "del";
    }
    return null;
  })();

  const autoInline = !viewLocked && oneSided !== null;
  const effectiveInline = autoInline ? true : inline;

  // ---- comment threads ----
  const threadsQ = useQuery<PrThread[]>({
    queryKey: ["pr-threads", project, repoId, prId],
    queryFn: () => api.prThreads(project, repoId, prId!),
    enabled: !!project && !!repoId && !!prId,
  });

  const refreshThreads = () => qc.invalidateQueries({ queryKey: ["pr-threads", project, repoId, prId] });

  // System threads ("X voted…") have no file context; only anchored ones belong in the diff.
  const fileThreads = useMemo(
    () => (threadsQ.data ?? []).filter((t) => t.filePath === shown?.path && (t.rightLine ?? 0) > 0),
    [threadsQ.data, shown?.path],
  );

  const onReply = useCallback(async (threadId: number, content: string) => {
    await api.prReply(project, repoId, prId!, threadId, content);
    await refreshThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, repoId, prId]);

  const onSetStatus = useCallback(async (threadId: number, status: string) => {
    await api.prSetThreadStatus(project, repoId, prId!, threadId, status);
    await refreshThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, repoId, prId]);

  const onNewThread = useCallback(async (line: number, content: string) => {
    await api.prCreateThread(project, repoId, prId!, {
      filePath: shown!.path, line, content, onLeft: false,
    });
    await refreshThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, repoId, prId, shown?.path]);

  /* ---- file tree (§7) ---- */

  // Files grouped by folder. This is what disambiguates two files with the same name — they
  // sit under visibly different headers — and it means filenames rarely need truncating.
  const fileGroups = useMemo(() => {
    const m = new Map<string, PrChange[]>();
    for (const c of changes) {
      const dir = fileDir(c.path) || "(root)";
      const list = m.get(dir);
      if (list) list.push(c); else m.set(dir, [c]);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: "base" }));
  }, [changes]);

  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());

  // Which rail tab is showing, and the citation the diff should reveal.
  const [rail, setRail] = useState<"files" | "agent">("files");
  const [cite, setCite] = useState<{ line: number; nonce: number } | null>(null);
  const [agentPrefill, setAgentPrefill] = useState<string | null>(null);

  /* The rail's width, dragged by the reviewer and persisted. A long answer beside a wide diff is a
     genuine tension, and which one deserves the space changes by the minute — so it is theirs to
     decide rather than ours to fix at one number. */
  const [railWidth, setRailWidth] = useRailWidth();

  /**
   * The tab is named by whichever connector holds the capability — never a literal (§7.1). With
   * nothing assigned it reads `Agent` and stays neutral, because there is no identity to name yet.
   */
  const connectorsQ = useQuery<Connector[]>({ queryKey: ["connectors"], queryFn: api.connectors });
  const agentTabLabel =
    connectorsQ.data?.find((c) => c.capabilities.includes("pr.questions"))?.name ?? "Agent";
  const [viewed, setViewed] = useState<Set<string>>(new Set());

  // Reload viewed state whenever the PR or its head commit changes.
  useEffect(() => {
    if (!prId) { setViewed(new Set()); return; }
    try {
      const raw = localStorage.getItem(viewedKey(prId, pr?.sourceCommit));
      setViewed(new Set<string>(raw ? JSON.parse(raw) : []));
    } catch { setViewed(new Set()); }
  }, [prId, pr?.sourceCommit]);

  function toggleViewed(path: string) {
    if (!prId) return;
    setViewed((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      localStorage.setItem(viewedKey(prId, pr?.sourceCommit), JSON.stringify([...next]));
      return next;
    });
  }

  const viewedCount = changes.filter((c) => viewed.has(c.path)).length;

  // ---- starred repos ----
  const favouritesQ = useQuery<RepoFavourite[]>({ queryKey: ["repo-favourites"], queryFn: api.repoFavourites });
  const favourites = favouritesQ.data ?? [];
  const currentFavourite = favourites.find((f) => f.project === project && f.repoId === repoId);
  const repoName = (reposQ.data ?? []).find((r) => r.id === repoId)?.name ?? "";

  const toggleFavourite = useMutation({
    mutationFn: async () => {
      if (currentFavourite) await api.removeRepoFavourite(currentFavourite.id);
      else await api.addRepoFavourite(project, repoId, repoName);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["repo-favourites"] }),
  });

  // ---- review vote ----
  const vote = useMutation({
    mutationFn: (v: number) => api.prVote(project, repoId, prId!, v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["prs", project, repoId] }),
  });

  return (
    <div className="body review-wrap">
      {/* Context bar: pickers, star, then the starred chips on the same row — the STARRED row
          previously spent a full row on one chip (§5). It spans the window rather than sitting
          in the PR panel's header, so the chips have somewhere to go and the whole row survives
          collapsing the left panel. The PROJ/REPO prefixes cost nothing and remove the
          ambiguity when two names collide. */}
      <div className="ctxbar">
        <span className="picker-wrap" title="Azure DevOps project">
          <span className="picker-tag">Proj</span>
          <Combobox
            value={project}
            options={(projectsQ.data ?? []).map((p) => ({ value: p.name, label: p.name }))}
            loading={projectsQ.isLoading}
            placeholder="— project —"
            onChange={(v) => { setProject(v); setRepoId(""); setPrId(null); }}
          />
        </span>
        <span className="picker-wrap" title="Repository">
          <span className="picker-tag">Repo</span>
          <Combobox
            value={repoId}
            options={(reposQ.data ?? []).map((r) => ({ value: r.id, label: r.name }))}
            disabled={!project}
            loading={reposQ.isLoading}
            placeholder="— repository —"
            onChange={(v) => { setRepoId(v); setPrId(null); }}
          />
        </span>
        <button
          className={`star-btn ${currentFavourite ? "on" : ""}`}
          disabled={!repoId || toggleFavourite.isPending}
          title={currentFavourite ? "Remove from starred" : "Star this repository"}
          aria-pressed={!!currentFavourite}
          onClick={() => toggleFavourite.mutate()}
        >
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"
            fill={currentFavourite ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.4"
            strokeLinejoin="round">
            <path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" />
          </svg>
        </button>

        {favourites.length > 0 && (
          <>
            <span className="ctx-divider" />
            <span className="ql-label">Starred</span>
            <span className="quicklinks">
              {favourites.map((f) => (
                <button
                  key={f.id}
                  className={`ql-chip ${f.project === project && f.repoId === repoId ? "active" : ""}`}
                  title={`${f.project} / ${f.repoName}`}
                  onClick={() => { setProject(f.project); setRepoId(f.repoId); setPrId(null); }}
                >
                  {/* Wrapped so the chip can centre the pair as one block while the two labels
                      keep their shared baseline — centring them individually sags the smaller
                      project label about 1.5px below the repo name. */}
                  <span className="ql-chip-text">
                    <b>{f.repoName}</b>
                    <span>{f.project}</span>
                  </span>
                </button>
              ))}
            </span>
          </>
        )}
      </div>

      {/* PR-level actions live here, above the panes, because they apply to the whole PR. */}
      {pr && (
        <div className="pr-bar">
          <span className="pr-bar-id">!{pr.id}</span>
          <span className="pr-bar-title" title={pr.title}>{pr.title}</span>
          <span className="pr-bar-refs">
            {branchShort(pr.sourceRef)} <span className="pr-arrow">→</span> {branchShort(pr.targetRef)}
          </span>
          <span style={{ flex: 1 }} />
          {pr.myVote !== 0 && (
            <span className={`pr-vote-state v${pr.myVote > 0 ? "pos" : "neg"}`}>{voteLabel(pr.myVote)}</span>
          )}
          <div className="pr-votes">
            {VOTES.map((v) => (
              <Fragment key={v.vote}>
                {/* Reject is separated from the three non-destructive votes so it can't be
                    hit on the way to "Waiting for author". */}
                {v.vote === -10 && <span className="vote-divider" />}
                <button
                  className={`vote-btn ${v.tone} ${pr.myVote === v.vote ? "active" : ""}`}
                  disabled={vote.isPending}
                  title={v.label}
                  onClick={() => vote.mutate(v.vote)}
                >
                  <span className="vote-ico">{v.icon}</span>
                  {v.label}
                </button>
              </Fragment>
            ))}
            {pr.myVote !== 0 && (
              <button className="btn ghost small" disabled={vote.isPending} onClick={() => vote.mutate(0)}>
                Reset
              </button>
            )}
          </div>
        </div>
      )}

      {/* The grid already read --w-right, so resizing only has to set a variable — no layout
          rewrite, and the collapse toggles keep working because they override the same one. */}
      <div
        className="review"
        data-left={leftOpen ? "on" : "off"}
        data-right={prId && rightOpen ? "on" : "off"}
        style={{ "--w-right": `${railWidth}px` } as React.CSSProperties}
      >
        {/* ---------- pull requests ---------- */}
        <div className="cfg-col">
          {/* An active repo can carry dozens of PRs; scanning for "the one about sport ids"
              shouldn't mean scrolling. Matches id, title or author (§8). */}
          <div className="cfg-head">
            <input
              className="input pr-search"
              type="search"
              placeholder="Filter pull requests…"
              value={prFilter}
              onChange={(e) => setPrFilter(e.target.value)}
            />
          </div>

          <div className="cfg-scroll">
            {(prsQ.isLoading || reposQ.isLoading) && <div className="center-note"><span className="spin" /> loading…</div>}
            {prsQ.error && (
              <div className="error cfg-note">
                {prsQ.error instanceof ApiError ? prsQ.error.message : "Could not load pull requests."}
              </div>
            )}
            {!prsQ.isLoading && !prsQ.error && prs.length === 0 && (
              <div className="faint cfg-note">No active pull requests in this repository.</div>
            )}
            {prs.map((p) => (
              <button key={p.id} className={`pr-item ${p.id === prId ? "active" : ""}`} onClick={() => setPrId(p.id)}>
                <div className="pr-top">
                  <span className="pr-id">!{p.id}</span>
                  {/* Both flags change whether the PR is worth opening at all, so they sit on
                      the title line. Draft is slate — it's a state, not a problem (§8). */}
                  {p.isDraft && <span className="pr-flag draft">Draft</span>}
                  {p.mergeStatus === "conflicts" && (
                    <span className="pr-flag conflicts" title="Merge conflicts with the target branch">
                      Conflicts
                    </span>
                  )}
                  <span className="pr-title" title={p.title}>{p.title}</span>
                </div>
                <div className="pr-sub">
                  <span title={p.sourceRef ?? ""}>{branchShort(p.sourceRef)}</span>
                  <span className="pr-arrow">→</span>
                  <span title={p.targetRef ?? ""}>{branchShort(p.targetRef)}</span>
                  <span className="pr-spacer" />
                  {p.author && <span className="pr-author">{p.author}</span>}
                  {p.createdAt && <span className="faint">{timeAgo(p.createdAt)}</span>}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* ---------- changed files (right-hand rail, so the diff stays centred) ---------- */}
        <div className="cfg-col review-files" style={{ order: 3 }}>
          {/* On the rail's left edge, so it sits on the boundary it moves. Hidden when the rail is
              collapsed — there is no edge to drag then. */}
          {prId && rightOpen && <RailResizer width={railWidth} onWidth={setRailWidth} />}
          {/* A tab on the existing rail, not a fourth column: you never need the file tree and an
              answer at once, and the diff stays centred — which matters, because answers cite lines
              in it. The tab is named by the connector, never by a literal (§7.1). */}
          {pr && (
            <div className="ag-tabs">
              <button className={`ag-tab ${rail === "files" ? "on" : ""}`} onClick={() => setRail("files")}>
                Files <span className="ag-tabn">{changes.length}</span>
              </button>
              <button className={`ag-tab bot ${rail === "agent" ? "on" : ""}`} onClick={() => setRail("agent")}>
                {agentTabLabel}
              </button>
            </div>
          )}

          <div className="keys-head rail-head" style={{ display: rail === "files" ? undefined : "none" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="keys-title">{pr ? `!${pr.id}` : "Files"}</div>
              <div className="keys-sub">
                {changes.length} file{changes.length === 1 ? "" : "s"} changed
                {changes.length > 0 && <> · {viewedCount} of {changes.length} viewed</>}
              </div>
              {/* The main mechanism for keeping your place in a multi-file review (§7). */}
              {changes.length > 0 && (
                <div className="rail-progress" role="progressbar"
                  aria-valuenow={viewedCount} aria-valuemin={0} aria-valuemax={changes.length}>
                  <span style={{ width: `${(viewedCount / changes.length) * 100}%` }} />
                </div>
              )}
            </div>
          </div>
          {/* The agent pane is a sibling rather than a wrapper, so the file tree's own scroll
              position survives switching tabs and coming back. */}
          {pr && rail === "agent" && (
            <div className="ag-pane">
              <AgentPanel
                project={project}
                repoId={repoId}
                pr={pr}
                prefill={agentPrefill}
                onPrefillConsumed={() => setAgentPrefill(null)}
                onCite={(citedPath, line) => {
                  /* Resolve against the real file list rather than trusting the two strings to
                     match. The context block declares paths without a leading slash and Azure
                     DevOps hands them back with one, so a plain equality check set a path that
                     matched no file and the chip silently scrolled nowhere — which §5.2 calls out
                     as worse than having no chip. Compared on the normalised form, so a citation in
                     either shape resolves to the file the page actually keys on. */
                  const norm = (p: string) => p.replace(/^\//, "");
                  const match = changes.find((c) => norm(c.path) === norm(citedPath));
                  if (!match) return;
                  if (match.path !== path) setPath(match.path);
                  // The nonce makes a repeat click on the same chip a fresh instruction.
                  setCite({ line, nonce: Date.now() });
                }}
              />
            </div>
          )}

          <div className="cfg-scroll" style={{ display: rail === "files" ? undefined : "none" }}>
            {changesQ.isLoading && <div className="center-note"><span className="spin" /> loading…</div>}
            {fileGroups.map(([dir, files]) => {
              const collapsed = collapsedDirs.has(dir);
              return (
                <div className="file-group" key={dir}>
                  <button
                    className="file-group-head"
                    onClick={() => setCollapsedDirs((prev) => {
                      const next = new Set(prev);
                      next.has(dir) ? next.delete(dir) : next.add(dir);
                      return next;
                    })}
                  >
                    <span className="fg-chevron">{collapsed ? "▸" : "▾"}</span>
                    {/* Folder paths truncate at the START — the tail is what distinguishes
                        them — and may wrap to two lines. Filenames truncate at the end.
                        POLISH §1.5: break opportunities sit after each separator, so a wrap can
                        never split a segment mid-word ("Migratio" / "ns"). */}
                    <span className="fg-path" title={dir}>{breakOnSeparators(dir)}</span>
                    <span className="fg-count">{files.length}</span>
                  </button>

                  {!collapsed && files.map((c) => {
                    const cl = changeLabel(c.changeType);
                    const n = (threadsQ.data ?? []).filter((t) => t.filePath === c.path && (t.rightLine ?? 0) > 0).length;
                    const isViewed = viewed.has(c.path);
                    return (
                      <div key={c.path} className={`file-item ${c.path === path ? "active" : ""} ${isViewed ? "is-viewed" : ""}`}>
                        <input
                          type="checkbox"
                          className="file-viewed"
                          checked={isViewed}
                          title={isViewed ? "Mark as not viewed" : "Mark as viewed"}
                          aria-label={`Mark ${fileName(c.path)} as viewed`}
                          onChange={() => toggleViewed(c.path)}
                        />
                        <button className="file-open" onClick={() => setPath(c.path)} title={c.path}>
                          <span className={`file-badge ch-${cl.key}`} title={CHANGE_WORD[cl.key] ?? cl.text}>
                            {cl.text[0]}
                          </span>
                          <span className="file-name">{fileName(c.path)}</span>
                          {n > 0 && <span className="file-threads" title={`${n} comment thread${n === 1 ? "" : "s"}`}>{n}</span>}
                        </button>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

        {/* ---------- diff ---------- */}
        <div className="cfg-col review-diff" style={{ order: 2 }}>
          {/* §9: the toolbar is hidden entirely when there's no PR, so the empty state below is
              the only message on screen. */}
          {pr && (
          <div className="detail-head">
            {/* Both collapse toggles live in the toolbar, left-most and right-most, so they stay
                reachable no matter which panel is hidden (§5). */}
            <button
              className={`iconbtn ${leftOpen ? "on" : ""}`}
              title={leftOpen ? "Hide pull request list" : "Show pull request list"}
              aria-pressed={leftOpen}
              onClick={() => setLeftOpen((v) => !v)}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3">
                <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
                <path d="M6 2.5v11" />
              </svg>
            </button>

            <span className="detail-title" title={path ?? ""}>
              {path ? fileName(path) : "No file selected"}
              {path && <span className="detail-dir">{fileDir(path)}</span>}
            </span>
            {path && isStale && <span className="spin" title="Loading…" />}
            {stats && path && !isStale && (
              <span className="diff-stats" title={`${stats.added} added, ${stats.removed} removed`}>
                <span className="st-add">+{stats.added}</span>
                <span className="st-del">−{stats.removed}</span>
              </span>
            )}
            {/* Never silently change a mode the user can see a control for: say why, and say
                that the toggle overrides. Rendered only while the auto-choice is in effect. */}
            {autoInline && (
              <span
                className="auto-chip"
                title={`This file is ${oneSided === "add" ? "entirely additions" : "entirely deletions"}, so side-by-side would leave one pane empty. Opened inline — use the toggle to override.`}
              >
                {oneSided === "add" ? "all additions" : "all deletions"} · inline
              </span>
            )}
            <div className="seg">
              <button
                className={`seg-opt ${!effectiveInline ? "active" : ""}`}
                onClick={() => { setViewLocked(true); setInline(false); }}
              >
                Side by side
              </button>
              <button
                className={`seg-opt ${effectiveInline ? "active" : ""}`}
                onClick={() => { setViewLocked(true); setInline(true); }}
              >
                Inline
              </button>
            </div>

            {/* View options: wrap and code size. Long lines clipped with no indication that
                anything was missing, which is what wrap fixes (§5). */}
            <div className="menu-anchor">
              <button
                className={`iconbtn ${viewMenu ? "on" : ""}`}
                title="View options"
                onClick={() => setViewMenu((v) => !v)}
              >
                ⋯
              </button>
              {viewMenu && (
                <div className="dropdown" onMouseLeave={() => setViewMenu(false)}>
                  <label className="menu-check">
                    <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />
                    Wrap long lines
                  </label>
                  <div className="dropdown-sep" />
                  <div className="dropdown-label">Code size</div>
                  <div className="theme-switch">
                    {[11, 12, 13].map((n) => (
                      <button
                        key={n}
                        className={`theme-opt ${codeSize === n ? "active" : ""}`}
                        onClick={() => setCodeSize(n)}
                      >
                        {n}px
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <button
              className={`iconbtn ${rightOpen ? "on" : ""}`}
              title={rightOpen ? "Hide file list" : "Show file list"}
              aria-pressed={rightOpen}
              onClick={() => setRightOpen((v) => !v)}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3">
                <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
                <path d="M10 2.5v11" />
              </svg>
            </button>
          </div>
          )}

          <div className="diff-body">
            {/* §9: exactly one message. With no PR the toolbar, vote bar and right rail are all
                hidden, so this is the only thing on screen; the PR list stays, since that's what
                the user needs to act on. */}
            {!path && (
              <div className="empty review-empty">
                <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor"
                  strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
                  <path d="M8 3.5h9.2a1.8 1.8 0 0 1 1.8 1.8v13.4a1.8 1.8 0 0 1-1.8 1.8H8" />
                  <path d="M4.5 7.5v9" />
                  <path d="M9.5 9h6M9.5 13h4" />
                </svg>
                <h3>{prId ? "No file selected" : "No pull request selected"}</h3>
                <p>{prId
                  ? "Pick a file from the list to see what changed in it."
                  : "Choose a pull request on the left to review the files it touches."}</p>
              </div>
            )}
            {path && !shown && diffQ.isFetching && (
              <div className="center-note"><span className="spin" /> loading diff…</div>
            )}
            {path && diffQ.error && !shown && (
              <div className="error cfg-note">
                {diffQ.error instanceof ApiError ? diffQ.error.message : "Could not load this file."}
              </div>
            )}
            {path && shown && (
              <Suspense fallback={<div className="center-note"><span className="spin" /> loading editor…</div>}>
                <MonacoDiff
                  path={shown.path}
                  before={shown.before ?? ""}
                  after={shown.after ?? ""}
                  inline={effectiveInline}
                  stale={isStale}
                  wrap={wrap}
                  fontSize={codeSize}
                  onStats={onStats}
                  cite={cite}
                  threads={fileThreads}
                  onReply={onReply}
                  onSetStatus={onSetStatus}
                  onNewThread={onNewThread}
                />
              </Suspense>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
