import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ComboOption {
  value: string;
  label: string;
  hint?: string;
}

interface Props {
  value: string;
  options: ComboOption[];
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  loading?: boolean;
  /** Let the typed text be committed as the value, for lists that can't be exhaustive. */
  allowCustom?: boolean;
}

/**
 * A searchable single-select dropdown for long lists. The popup renders in a portal
 * with fixed positioning so it is never clipped by a scrolling modal or overflow parent.
 */
export function Combobox({ value, options, onChange, placeholder, disabled, loading, allowCustom }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);

  function reposition() {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setRect({ left: r.left, top: r.bottom + 4, width: r.width });
  }

  useLayoutEffect(() => { if (open) reposition(); }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onMove() { reposition(); }
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open]);

  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? options.filter((o) => o.label.toLowerCase().includes(needle) || (o.hint ?? "").toLowerCase().includes(needle))
    : options;

  // A value the options don't cover still has to show. Falling through to the placeholder made a
  // set value read as empty whenever its list hadn't loaded or no longer contained it.
  const display = selected ? selected.label : value || (placeholder ?? "— select —");
  const title = selected
    ? (selected.hint ? `${selected.label} · ${selected.hint}` : selected.label)
    : value || undefined;

  const custom = allowCustom && needle && !options.some((o) => o.value === q.trim());

  return (
    <div className={`combo ${disabled ? "disabled" : ""}`} ref={wrapRef}>
      <button
        type="button"
        className="combo-input"
        disabled={disabled}
        title={title}
        onClick={() => { if (!disabled) { setOpen((o) => !o); setQ(""); } }}
      >
        <span className={selected || value ? "" : "faint"}>
          {loading ? "loading…" : display}
        </span>
        <span className="combo-caret">▾</span>
      </button>

      {open && !disabled && rect && createPortal(
        <div
          className="combo-pop"
          ref={popRef}
          style={{ position: "fixed", left: rect.left, top: rect.top, width: rect.width }}
        >
          <input
            className="input combo-search"
            autoFocus
            placeholder="Type to filter…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="combo-list">
            {custom && (
              <div
                className="combo-opt combo-custom"
                title={`Use ${q.trim()}`}
                onClick={() => { onChange(q.trim()); setOpen(false); }}
              >
                <span className="combo-opt-label">Use “{q.trim()}”</span>
              </div>
            )}
            {filtered.length === 0 && !custom && <div className="combo-empty">No matches</div>}
            {filtered.map((o) => (
              <div
                key={o.value}
                className={`combo-opt ${o.value === value ? "active" : ""}`}
                title={o.hint ? `${o.label} · ${o.hint}` : o.label}
                onClick={() => { onChange(o.value); setOpen(false); }}
              >
                <span className="combo-opt-label">{o.label}</span>
              </div>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
