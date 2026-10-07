import "@github/markdown-toolbar-element";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { MarkdownView } from "./MarkdownView";

/**
 * A textarea for writing a PR comment, with a formatting toolbar and a Write / Preview switch.
 *
 * The toolbar is GitHub's `<markdown-toolbar>`: it owns the hard part — wrapping and unwrapping a
 * selection, prefixing every line of a multi-line one — and leaves the buttons to us, so they are
 * ordinary app buttons rather than a widget with its own look. Preview draws with MarkdownView, the
 * same renderer the posted comment will get in the thread, so what the reviewer previews is what
 * the thread shows.
 */

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "markdown-toolbar": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & { for: string };
    }
  }
}

/* The toolbar finds its textarea by document id. React's useId can't be used for it: every thread
   in the diff is its own React root, and separate roots hand out the same ids. */
let nextId = 0;

const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

/** `data-md-button` value → what the button shows, its name and its shortcut key, if any. */
const TOOLS: { style: string; label: string; face: ReactNode; key?: string }[] = [
  { style: "header-3", label: "Heading", face: <b>H</b> },
  { style: "bold", label: "Bold", face: <b>B</b>, key: "b" },
  { style: "italic", label: "Italic", face: <i>I</i>, key: "i" },
  { style: "strikethrough", label: "Strikethrough", face: <s>S</s> },
  { style: "code", label: "Code", face: <Glyph d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" />, key: "e" },
  { style: "link", label: "Link", face: "Link", key: "k" },
  { style: "quote", label: "Quote", face: <Glyph d="M3 3.5v9M6.5 5h7M6.5 8h7M6.5 11h5" /> },
  { style: "unordered-list", label: "Bulleted list", face: <Glyph d="M6 4.5h8M6 8h8M6 11.5h8" dots /> },
  { style: "ordered-list", label: "Numbered list", face: <Glyph d="M6 4.5h8M6 8h8M6 11.5h8M2.5 3.5h1v2.5M2.5 10h1.5l-1.5 2.5H4" /> },
  { style: "task-list", label: "Task list", face: <Glyph d="M2 3h4v4H2zM8 5h6M8 11h6M2.5 11l1 1 2-2.5" /> },
];

function Glyph({ d, dots }: { d: string; dots?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
      {dots && [4.5, 8, 11.5].map((y) => <circle key={y} cx="2.75" cy={y} r="0.9" fill="currentColor" stroke="none" />)}
    </svg>
  );
}

export function MarkdownInput({ value, onChange, onKeyDown, placeholder, autoFocus, minRows = 3 }: {
  value: string;
  onChange: (value: string) => void;
  /** Runs after the formatting shortcuts, for the host's own keys (post, dismiss). */
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  autoFocus?: boolean;
  minRows?: number;
}) {
  const [id] = useState(() => `md-input-${++nextId}`);
  const [preview, setPreview] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const toolbarRef = useRef<HTMLElement>(null);

  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  /* When the browser refuses execCommand, the toolbar falls back to assigning `value` and firing a
     synthetic `input`. React's change tracking sees that assignment as its own and drops the event,
     so the edit would show on screen and vanish on the next render. Listening natively catches it. */
  useEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    const sync = () => changeRef.current(el.value);
    el.addEventListener("input", sync);
    return () => el.removeEventListener("input", sync);
  }, [preview]);

  function showWrite() {
    setPreview(false);
    requestAnimationFrame(() => fieldRef.current?.focus());
  }

  function keyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      const tool = TOOLS.find((t) => t.key === e.key.toLowerCase());
      if (tool) {
        e.preventDefault();
        toolbarRef.current?.querySelector<HTMLElement>(`[data-md-button="${tool.style}"]`)?.click();
        return;
      }
    }
    onKeyDown?.(e);
  }

  return (
    <div className="md-input">
      <div className="md-input-bar">
        <div className="seg" role="tablist" aria-label="Comment editor mode">
          <button type="button" role="tab" aria-selected={!preview}
            className={`seg-opt ${!preview ? "active" : ""}`} onClick={showWrite}>Write</button>
          <button type="button" role="tab" aria-selected={preview}
            className={`seg-opt ${preview ? "active" : ""}`} onClick={() => setPreview(true)}>Preview</button>
        </div>
        {/* Hidden rather than unmounted in Preview, so the shortcut lookup above always has buttons.
            `undefined`, never `false`: React 18 stringifies booleans on a custom element, and
            `hidden="false"` is still the hidden attribute — the toolbar vanished in Write mode too. */}
        <markdown-toolbar for={id} ref={toolbarRef} hidden={preview || undefined}>
          <span className="md-tools">
            {TOOLS.map((t) => {
              const name = t.key ? `${t.label} (${MOD}${t.key.toUpperCase()})` : t.label;
              return (
                <button key={t.style} type="button" className="md-tool" data-md-button={t.style}
                  title={name} aria-label={name} tabIndex={-1}>
                  {t.face}
                </button>
              );
            })}
          </span>
        </markdown-toolbar>
      </div>

      {preview ? (
        <div className="md-input-preview">
          {value.trim()
            ? <MarkdownView text={value} headingShift={3} compact />
            : <span className="faint">Nothing to preview yet — write something first.</span>}
        </div>
      ) : (
        <textarea
          id={id}
          ref={fieldRef}
          className="md-input-field"
          rows={minRows}
          autoFocus={autoFocus}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={keyDown}
        />
      )}
    </div>
  );
}
