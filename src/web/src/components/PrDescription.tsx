import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { MarkdownView } from "./MarkdownView";
import { timeAgo } from "../lib/format";
import type { PullRequest } from "../types";

/**
 * The Review page's Description view: what the author said the pull request is for.
 *
 * Fetched only when this view is opened — the PR list drops descriptions on purpose, and fifty of them
 * per repository is dead weight for a panel that shows titles.
 */
export function PrDescription({ project, repoId, pr }: {
  project: string;
  repoId: string;
  pr: PullRequest;
}) {
  const q = useQuery({
    queryKey: ["pr-description", project, repoId, pr.id],
    queryFn: () => api.prDescription(project, repoId, pr.id),
  });

  const text = q.data?.description?.trim() ?? "";

  return (
    <div className="pr-view-scroll">
      <article className="pr-desc">
        <header className="pr-desc-head">
          <h2 className="pr-desc-title">{pr.title}</h2>
          <div className="pr-desc-meta">
            {pr.author && <span>{pr.author}</span>}
            {pr.createdAt && <span title={new Date(pr.createdAt).toLocaleString()}>opened {timeAgo(pr.createdAt)}</span>}
            {pr.isDraft && <span className="pr-flag draft">Draft</span>}
          </div>
        </header>

        {q.isLoading && <div className="center-note"><span className="spin" /> loading description…</div>}
        {q.error && (
          <div className="error cfg-note">
            {q.error instanceof ApiError ? q.error.message : "Could not load the description."}
          </div>
        )}
        {q.isSuccess && !text && (
          <div className="pr-view-empty">
            <h3>No description on !{pr.id}</h3>
            <p>The author didn't write one. The Code view still has every file this pull request changes.</p>
          </div>
        )}
        {/* Shifted down two: the PR title above is the page's h2, so the author's `#` is an h3. */}
        {text && <MarkdownView text={text} headingShift={2} />}
      </article>
    </div>
  );
}
