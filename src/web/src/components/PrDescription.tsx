import { Fragment, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { parseBlocks, parseInline, type Block } from "../lib/markdown";
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
  const blocks = useMemo(() => parseBlocks(text), [text]);

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
        {text && <div className="md">{blocks.map((b, i) => <MdBlock key={i} block={b} />)}</div>}
      </article>
    </div>
  );
}

function MdBlock({ block }: { block: Block }) {
  switch (block.kind) {
    case "heading": {
      // Shifted down one: the PR title above is the page's h2, so the author's `#` is an h3.
      const Tag = `h${Math.min(6, block.level + 2)}` as "h3";
      return <Tag className={`md-h md-h${block.level}`}>{inline(block.text)}</Tag>;
    }
    case "paragraph":
      return (
        <p>
          {block.lines.map((l, i) => <Fragment key={i}>{i > 0 && <br />}{inline(l)}</Fragment>)}
        </p>
      );
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag className="md-list">
          {block.items.map((it, i) => (
            <li
              key={i}
              className={it.checked !== null ? "md-task" : undefined}
              style={it.depth ? { marginLeft: `${it.depth * 18}px` } : undefined}
            >
              {it.checked !== null && (
                <input type="checkbox" checked={it.checked} disabled readOnly
                  aria-label={it.checked ? "Done" : "Not done"} />
              )}
              <span>{inline(it.text)}</span>
            </li>
          ))}
        </Tag>
      );
    }
    case "code":
      return <pre className="md-code"><code>{block.text}</code></pre>;
    case "quote":
      return (
        <blockquote className="md-quote">
          {block.lines.map((l, i) => <Fragment key={i}>{i > 0 && <br />}{inline(l)}</Fragment>)}
        </blockquote>
      );
    case "table":
      return (
        <div className="md-table-wrap">
          <table className="md-table">
            <thead><tr>{block.header.map((h, i) => <th key={i}>{inline(h)}</th>)}</tr></thead>
            <tbody>
              {block.rows.map((r, i) => (
                <tr key={i}>{block.header.map((_, j) => <td key={j}>{inline(r[j] ?? "")}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "rule":
      return <hr className="md-rule" />;
  }
}

/** Inline markup as React nodes — never dangerouslySetInnerHTML. */
function inline(text: string) {
  return parseInline(text).map((n, i) => {
    switch (n.kind) {
      case "code": return <code key={i}>{n.text}</code>;
      case "bold": return <b key={i}>{n.text}</b>;
      case "italic": return <i key={i}>{n.text}</i>;
      case "strike": return <s key={i}>{n.text}</s>;
      case "link": return <a key={i} href={n.href} target="_blank" rel="noreferrer noopener" title={n.href}>{n.text}</a>;
      default: return <Fragment key={i}>{n.text}</Fragment>;
    }
  });
}
