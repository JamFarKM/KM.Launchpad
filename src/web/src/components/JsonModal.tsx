import { useState } from "react";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Pretty-print + lightweight syntax highlight of a JSON string (falls back to raw text). */
function highlight(raw: string): { html: string; pretty: string } {
  let pretty = raw;
  try {
    pretty = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return { html: escapeHtml(raw), pretty: raw };
  }
  const html = escapeHtml(pretty).replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (m) => {
      let cls = "j-num";
      if (/^"/.test(m)) cls = /:$/.test(m) ? "j-key" : "j-str";
      else if (/true|false/.test(m)) cls = "j-bool";
      else if (/null/.test(m)) cls = "j-null";
      return `<span class="${cls}">${m}</span>`;
    },
  );
  return { html, pretty };
}

export function JsonModal({ title, raw, onClose }: { title: string; raw: string; onClose: () => void }) {
  const { html, pretty } = highlight(raw);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(pretty);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard may be blocked */ }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide">
        <div className="modal-head">
          <div className="title cfg-key" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
          <button className="btn ghost small" onClick={copy}>{copied ? "Copied ✓" : "Copy"}</button>
          <button className="btn ghost small" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <pre className="json-view" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      </div>
    </div>
  );
}
