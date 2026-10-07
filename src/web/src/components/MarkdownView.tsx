import { Fragment, useMemo } from "react";
import { parseBlocks, parseInline, type Block } from "../lib/markdown";

/**
 * Markdown a person wrote in Azure DevOps — a PR description or a comment thread — rendered as React
 * nodes. Never dangerouslySetInnerHTML: the parse in `lib/markdown.ts` is the only thing that decides
 * what becomes markup.
 *
 * `headingShift` pushes the author's `#` down the outline so it sits below whatever heading the host
 * already has: the description's title is an h2, so its `#` is an h3.
 */
export function MarkdownView({ text, headingShift, compact }: {
  text: string;
  headingShift: number;
  /** Tighter type and spacing, for text that sits inside a diff rather than owning a page. */
  compact?: boolean;
}) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div className={compact ? "md md-compact" : "md"}>
      {blocks.map((b, i) => <MdBlock key={i} block={b} headingShift={headingShift} />)}
    </div>
  );
}

function MdBlock({ block, headingShift }: { block: Block; headingShift: number }) {
  switch (block.kind) {
    case "heading": {
      const Tag = `h${Math.min(6, block.level + headingShift)}` as "h3";
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
