import { useEffect, useRef, useState } from "react";

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
}

/** A searchable single-select dropdown for long lists (projects, pipelines, branches). */
export function Combobox({ value, options, onChange, placeholder, disabled, loading }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? options.filter((o) => o.label.toLowerCase().includes(needle) || (o.hint ?? "").toLowerCase().includes(needle))
    : options;

  return (
    <div className={`combo ${disabled ? "disabled" : ""}`} ref={ref}>
      <button
        type="button"
        className="combo-input"
        disabled={disabled}
        onClick={() => { if (!disabled) { setOpen((o) => !o); setQ(""); } }}
      >
        <span className={selected ? "" : "faint"}>
          {loading ? "loading…" : selected ? selected.label : (placeholder ?? "— select —")}
        </span>
        <span className="combo-caret">▾</span>
      </button>
      {open && !disabled && (
        <div className="combo-pop">
          <input
            className="input combo-search"
            autoFocus
            placeholder="Type to filter…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="combo-list">
            {filtered.length === 0 && <div className="combo-empty">No matches</div>}
            {filtered.map((o) => (
              <div
                key={o.value}
                className={`combo-opt ${o.value === value ? "active" : ""}`}
                onClick={() => { onChange(o.value); setOpen(false); }}
              >
                <span className="combo-opt-label">{o.label}</span>
                {o.hint && <span className="faint combo-opt-hint">{o.hint}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
