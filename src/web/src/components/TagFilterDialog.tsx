import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ViewItem } from "../types";
import { cleanTags, tagFilterOf, type TagFilter } from "../lib/tagFilter";
import { CloseIcon } from "./StatusGlyph";

/** Edits one pipeline card's run filter (DESIGN_SPEC.md §2.3). */
export function TagFilterDialog({ item, onClose, onSave }: {
  item: ViewItem;
  onClose: () => void;
  onSave: (filter: TagFilter) => void;
}) {
  const initial = tagFilterOf(item);
  const [include, setInclude] = useState(initial.include);
  const [exclude, setExclude] = useState(initial.exclude);
  // Text typed but not yet turned into a chip still counts on Save — losing it would be a trap.
  const [includeDraft, setIncludeDraft] = useState("");
  const [excludeDraft, setExcludeDraft] = useState("");

  // Suggestions only: a tag that's never been used in this project can still be typed.
  const tagsQ = useQuery<string[]>({
    queryKey: ["build-tags", item.project],
    queryFn: () => api.buildTags(item.project),
    staleTime: 60_000,
  });
  const known = tagsQ.data ?? [];

  function save() {
    onSave({
      include: cleanTags([...include, includeDraft]),
      exclude: cleanTags([...exclude, excludeDraft]),
    });
  }

  // Portalled: a shelf's transform would otherwise become the containing block for this overlay.
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal tagfilter-modal">
        <div className="modal-head">
          <div className="title">Filter runs · {item.name}</div>
          <button className="btn ghost small" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">
          <p className="faint" style={{ marginTop: 0 }}>
            Only runs that pass both rules appear on this card and count toward the shelf's health.
          </p>
          <TagListField
            label="Show only runs tagged with all of"
            tags={include} draft={includeDraft} known={known}
            onTags={setInclude} onDraft={setIncludeDraft}
          />
          <TagListField
            label="Hide runs tagged with any of"
            tags={exclude} draft={excludeDraft} known={known}
            onTags={setExclude} onDraft={setExcludeDraft}
          />
          {tagsQ.isSuccess && known.length === 0 && (
            <p className="faint" style={{ margin: 0 }}>
              No runs in {item.project} have tags yet. You can still type one.
            </p>
          )}
        </div>
        <div className="modal-foot">
          {(include.length > 0 || exclude.length > 0) && (
            <button className="btn ghost" style={{ marginRight: "auto" }}
              onClick={() => onSave({ include: [], exclude: [] })}>
              Clear filter
            </button>
          )}
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function TagListField({ label, tags, draft, known, onTags, onDraft }: {
  label: string;
  tags: string[];
  draft: string;
  known: string[];
  onTags: (t: string[]) => void;
  onDraft: (s: string) => void;
}) {
  const listId = useId();
  const inputId = useId();
  const chosen = new Set(tags.map((t) => t.toLowerCase()));

  function commit() {
    if (!draft.trim()) return;
    onTags(cleanTags([...tags, draft]));
    onDraft("");
  }

  return (
    <div className="field">
      <label className="label" htmlFor={inputId}>{label}</label>
      <div className="tagfilter-box">
        {tags.map((t) => (
          <span className="tagfilter-chip" key={t.toLowerCase()} title={t}>
            <span className="tagfilter-chip-text">{t}</span>
            <button
              className="tagfilter-chip-x"
              aria-label={`Remove ${t}`}
              title={`Remove ${t}`}
              onClick={() => onTags(tags.filter((x) => x !== t))}
            >
              <CloseIcon />
            </button>
          </span>
        ))}
        <input
          id={inputId}
          className="tagfilter-input"
          list={listId}
          value={draft}
          placeholder={tags.length ? "" : "Type a tag, then Enter"}
          onChange={(e) => {
            // Picking a datalist suggestion takes it at once. Typing that happens to spell a
            // known tag must not: `prod` would chip before you could finish `production`.
            const v = e.target.value;
            const inputType = (e.nativeEvent as InputEvent).inputType;
            const picked = inputType === undefined || inputType === "insertReplacementText";
            if (picked && known.includes(v)) { onTags(cleanTags([...tags, v])); onDraft(""); }
            else onDraft(v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commit(); }
            else if (e.key === "Backspace" && !draft && tags.length) onTags(tags.slice(0, -1));
          }}
          onBlur={commit}
        />
        <datalist id={listId}>
          {known.filter((t) => !chosen.has(t.toLowerCase())).map((t) => <option key={t} value={t} />)}
        </datalist>
      </div>
    </div>
  );
}
