import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { branchShort, timeAgo } from "../lib/format";
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

  // Reset the file selection whenever the PR changes.
  useEffect(() => { setPath(null); }, [prId]);

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
  });

  return (
    <div className="body">
      <div className={`review ${prId ? "has-files" : ""}`}>
        {/* ---------- pull requests ---------- */}
        <div className="cfg-col">
          <div className="cfg-head">
            <div className="review-pickers">
              <select className="select" value={project} onChange={(e) => { setProject(e.target.value); setRepoId(""); setPrId(null); }}>
                {(projectsQ.data ?? []).map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
              </select>
              <select className="select" value={repoId} onChange={(e) => { setRepoId(e.target.value); setPrId(null); }}
                disabled={!reposQ.data?.length}>
                {(reposQ.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
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
            <span className="detail-title" title={path ?? ""}>{path ?? "No file selected"}</span>
            <div className="seg">
              <button className={`seg-opt ${!inline ? "active" : ""}`} onClick={() => setInline(false)}>Side by side</button>
              <button className={`seg-opt ${inline ? "active" : ""}`} onClick={() => setInline(true)}>Inline</button>
            </div>
          </div>

          <div className="diff-body">
            {!path && <div className="faint cfg-note">Select a file to see its diff.</div>}
            {path && diffQ.isLoading && <div className="center-note"><span className="spin" /> loading diff…</div>}
            {path && diffQ.error && (
              <div className="error cfg-note">
                {diffQ.error instanceof ApiError ? diffQ.error.message : "Could not load this file."}
              </div>
            )}
            {path && diffQ.data && (
              <Suspense fallback={<div className="center-note"><span className="spin" /> loading editor…</div>}>
                <MonacoDiff
                  path={path}
                  before={diffQ.data.before ?? ""}
                  after={diffQ.data.after ?? ""}
                  inline={inline}
                />
              </Suspense>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
