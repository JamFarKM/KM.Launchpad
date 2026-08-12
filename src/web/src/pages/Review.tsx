import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { branchShort, timeAgo } from "../lib/format";
import { Combobox } from "../components/Combobox";
import type { DiffStats } from "../components/MonacoDiff";
import type { PrChange, Project, PullRequest, Repo } from "../types";

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

export function ReviewPage() {
  const projectsQ = useQuery<Project[]>({ queryKey: ["projects"], queryFn: api.projects });
  const [project, setProject] = useState("");
  const [repoId, setRepoId] = useState("");
  const [prId, setPrId] = useState<number | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [inline, setInline] = useState(false);
  const [stats, setStats] = useState<DiffStats | null>(null);
  const onStats = useCallback((s: DiffStats) => setStats(s), []);

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

  const prs = prsQ.data ?? [];
  const pr = prs.find((p) => p.id === prId) ?? null;

  // Reset the file selection and its stats whenever the PR changes.
  useEffect(() => { setPath(null); setStats(null); }, [prId]);
  useEffect(() => { setStats(null); }, [path]);

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

  return (
    <div className="body">
      <div className={`review ${prId ? "has-files" : ""}`}>
        {/* ---------- pull requests ---------- */}
        <div className="cfg-col">
          <div className="cfg-head">
            {/* Same searchable pickers as the Sequences page, not bare selects. */}
            <div className="review-pickers">
              <Combobox
                value={project}
                options={(projectsQ.data ?? []).map((p) => ({ value: p.name, label: p.name }))}
                loading={projectsQ.isLoading}
                placeholder="— project —"
                onChange={(v) => { setProject(v); setRepoId(""); setPrId(null); }}
              />
              <Combobox
                value={repoId}
                options={(reposQ.data ?? []).map((r) => ({ value: r.id, label: r.name }))}
                disabled={!project}
                loading={reposQ.isLoading}
                placeholder="— repository —"
                onChange={(v) => { setRepoId(v); setPrId(null); }}
              />
            </div>
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
                  {p.isDraft && <span className="pr-draft">draft</span>}
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

        {/* ---------- changed files ---------- */}
        <div className="cfg-col review-files">
          <div className="keys-head">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="keys-title">{pr ? `!${pr.id}` : "Files"}</div>
              <div className="keys-sub">
                {changes.length} file{changes.length === 1 ? "" : "s"} changed
              </div>
            </div>
          </div>
          <div className="cfg-scroll">
            {changesQ.isLoading && <div className="center-note"><span className="spin" /> loading…</div>}
            {!prId && <div className="faint cfg-note">Pick a pull request.</div>}
            {changes.map((c) => {
              const cl = changeLabel(c.changeType);
              return (
                <button key={c.path} className={`file-item ${c.path === path ? "active" : ""}`}
                  onClick={() => setPath(c.path)} title={c.path}>
                  <span className={`file-badge ch-${cl.key}`}>{cl.text[0]}</span>
                  <span className="file-text">
                    <span className="file-name">{fileName(c.path)}</span>
                    <span className="file-dir">{fileDir(c.path)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* ---------- diff ---------- */}
        <div className="cfg-col review-diff">
          <div className="detail-head">
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
            <div className="seg">
              <button className={`seg-opt ${!inline ? "active" : ""}`} onClick={() => setInline(false)}>Side by side</button>
              <button className={`seg-opt ${inline ? "active" : ""}`} onClick={() => setInline(true)}>Inline</button>
            </div>
          </div>

          <div className="diff-body">
            {!path && (
              <div className="empty">
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
                  inline={inline}
                  stale={isStale}
                  onStats={onStats}
                />
              </Suspense>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
