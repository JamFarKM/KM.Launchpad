import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { duration, runLabel, runTone, timeAgoShort } from "../lib/format";
import { groupByPipeline } from "../lib/prRuns";
import { RunDetailModal } from "./RunDetailModal";
import { StatusGlyph } from "./StatusGlyph";
import { Truncated } from "./Truncated";
import type { PullRequest, Run } from "../types";

/** ADO's `reason`, in the words a reviewer uses. Unknown values show as ADO spells them. */
const REASON: Record<string, string> = {
  pullRequest: "PR validation",
  manual: "Manual",
  individualCI: "CI",
  batchedCI: "CI",
  schedule: "Scheduled",
  resourceTrigger: "Pipeline trigger",
  buildCompletion: "Pipeline trigger",
};

/** Shared with the page so the tab's glyph and the view read one request. */
export function usePrRuns(project: string, repoId: string, prId: number | null) {
  return useQuery<Run[]>({
    queryKey: ["pr-runs", project, repoId, prId],
    queryFn: () => api.prRuns(project, repoId, prId!),
    enabled: !!project && !!repoId && !!prId,
    // Polled only while something is in flight; a finished set of runs doesn't change on its own.
    refetchInterval: (q) => (q.state.data?.some((r) => r.state !== "completed") ? 8000 : false),
  });
}

/** The Review page's Runs view: every pipeline run that built this pull request. */
export function PrRuns({ project, repoId, pr }: { project: string; repoId: string; pr: PullRequest }) {
  const q = usePrRuns(project, repoId, pr.id);
  const groups = useMemo(() => groupByPipeline(q.data ?? []), [q.data]);
  const [open, setOpen] = useState<number | null>(null);

  return (
    <div className="pr-view-scroll">
      <div className="pr-runs">
        {q.isLoading && <div className="center-note"><span className="spin" /> loading runs…</div>}
        {q.error && (
          <div className="error cfg-note">
            {q.error instanceof ApiError ? q.error.message : "Could not load pipeline runs."}
          </div>
        )}
        {q.isSuccess && groups.length === 0 && (
          <div className="pr-view-empty">
            <h3>No pipeline runs for !{pr.id}</h3>
            <p>
              Nothing has built this pull request's merge ref (<code>refs/pull/{pr.id}/merge</code>) yet.
              Runs appear here when a build-validation policy queues one, or when someone queues a
              pipeline against the pull request in Azure DevOps.
            </p>
          </div>
        )}

        {groups.map((g) => (
            <section className="prr-group" key={g.pipelineId}>
              <div className="prr-head">
                <Truncated className="prr-name" text={g.name} />
                <span className="prr-count">×{g.runs.length}</span>
              </div>
              {g.runs.map((r) => (
                <div className="prr-row" key={r.id}>
                  <button
                    className="prr-open"
                    onClick={() => setOpen(r.id)}
                    title={`Open run ${r.buildNumber ?? r.id} — ${runLabel(r)}`}
                  >
                    {/* A glyph per run, not a dot: the state has to survive greyscale (A4). */}
                    <StatusGlyph tone={runTone(r)} label={runLabel(r)} />
                    <span className="prr-num">{r.buildNumber ?? `#${r.id}`}</span>
                    {/* Always rendered, so a run with no reason doesn't shift every column after it. */}
                    <span>{r.reason && <span className="prr-reason">{REASON[r.reason] ?? r.reason}</span>}</span>
                    <span className="prr-who">{r.requestedFor ?? ""}</span>
                    <span className="prr-dur">
                      {r.state === "completed" ? duration(r) : r.state === "inProgress" ? "running" : "queued"}
                    </span>
                    <span className="prr-when" title={r.queueTime ? new Date(r.queueTime).toLocaleString() : undefined}>
                      {timeAgoShort(r.startTime ?? r.queueTime)}
                    </span>
                    {/* A word, not the binoculars glyph — two enclosed shapes don't survive 12px. */}
                    <span className="prr-logs">Logs</span>
                  </button>
                  {r.webUrl && (
                    <a className="iconbtn prr-ext" href={r.webUrl} target="_blank" rel="noreferrer noopener"
                      title="Open this run in Azure DevOps" aria-label="Open this run in Azure DevOps">
                      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor"
                        strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />
                      </svg>
                    </a>
                  )}
                </div>
              ))}
            </section>
        ))}
      </div>

      {open !== null && <RunDetailModal project={project} buildId={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
