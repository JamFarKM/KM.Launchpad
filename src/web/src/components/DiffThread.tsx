import { useState } from "react";
import { timeAgo } from "../lib/format";
import type { PrThread } from "../types";

/**
 * A comment thread, rendered inline in the diff via a Monaco view zone. Kept to plain app
 * components so it reads as part of Launchpad rather than as an embedded editor widget.
 */

const RESOLVED = new Set(["fixed", "closed", "wontfix", "bydesign"]);
export const isResolved = (t: PrThread) => RESOLVED.has((t.status ?? "").toLowerCase());

interface Props {
  thread: PrThread;
  busy?: boolean;
  onReply: (threadId: number, content: string) => Promise<void>;
  onSetStatus: (threadId: number, status: string) => Promise<void>;
}

export function DiffThread({ thread, busy, onReply, onSetStatus }: Props) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const resolved = isResolved(thread);

  // ADO keeps deleted comments in the payload; they'd otherwise show as blank rows.
  const comments = thread.comments.filter((c) => !c.isDeleted);
  if (comments.length === 0) return null;

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await onReply(thread.id, text);
      setDraft("");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className={`dthread ${resolved ? "is-resolved" : ""}`}>
      <div className="dthread-head">
        <span className={`dthread-status ${resolved ? "ok" : "open"}`}>
          {resolved ? "Resolved" : "Active"}
        </span>
        <span className="dthread-count">{comments.length} comment{comments.length === 1 ? "" : "s"}</span>
        <span style={{ flex: 1 }} />
        <button
          className="btn ghost small"
          disabled={busy || sending}
          onClick={() => onSetStatus(thread.id, resolved ? "active" : "fixed")}
        >
          {resolved ? "Reopen" : "Resolve"}
        </button>
      </div>

      {comments.map((c) => (
        <div className="dcomment" key={c.id}>
          <div className="dcomment-head">
            <span className="dcomment-author">{c.author ?? "Unknown"}</span>
            {c.publishedAt && <span className="faint">{timeAgo(c.publishedAt)}</span>}
          </div>
          {/* Content is markdown; shown verbatim for now so nothing is silently swallowed. */}
          <div className="dcomment-body">{c.content}</div>
        </div>
      ))}

      <div className="dthread-reply">
        <textarea
          className="input dthread-input"
          rows={2}
          placeholder="Reply…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); send(); }
          }}
        />
        <button className="btn primary small" disabled={!draft.trim() || sending} onClick={send}>
          {sending ? <><span className="spin" /> Sending…</> : "Reply"}
        </button>
      </div>
    </div>
  );
}

/* Windows and Linux users don't have a ⌘ key; showing them one is just wrong. */
const POST_HINT = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘⏎" : "Ctrl+⏎";

/**
 * The composer for a new thread. An overlay floating over the diff rather than a row inserted
 * into it (§6): inserting a row reflows everything below and reads as the page jumping. The
 * elevation, the pointer at its anchor line and the scrim behind it are what make it read as
 * deliberately floating instead of as a rendering fault.
 */
export function DiffComposer({ line, top, left, onCancel, onSubmit }: {
  line: number;
  /** Pixel offset of the anchor line within the editor viewport. */
  top: number;
  /** Left edge of the pane the comment is anchored to — the modified side. */
  left: number;
  onCancel: () => void;
  onSubmit: (content: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try { await onSubmit(text); } finally { setSending(false); }
  }

  return (
    <div className="diff-composer" style={{ top: top + 6, left: left + 52 }}>
      <div className="dc-head">
        <span className="dc-badge">New comment</span>
        <span className="dc-line">line {line}</span>
      </div>
      <textarea
        className="input dc-input"
        autoFocus
        placeholder="Leave a comment…"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); send(); }
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
      />
      <div className="dc-foot">
        <button className="btn primary small" disabled={!draft.trim() || sending} onClick={send}>
          {sending ? <><span className="spin" /> Posting…</> : "Comment"}
        </button>
        <button className="btn outline small" disabled={sending} onClick={onCancel}>Cancel</button>
        <span className="dc-hint">{POST_HINT} to post · Esc to dismiss</span>
      </div>
    </div>
  );
}
