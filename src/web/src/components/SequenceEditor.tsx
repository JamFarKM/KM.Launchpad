import { useMemo, useState } from "react";
import type { Sequence, SequenceInput, SequenceStep } from "../types";
import { commonPrefix, stepShort } from "../lib/format";
import { PlayIcon } from "./StatusGlyph";

/**
 * The sequence editor (SEQUENCES §5). A right-hand panel rather than a page or a card: Views
 * *consumes* sequences and the editor *authors* them, which are different tasks with different
 * information needs, and an editor does not fit in a 236px card.
 *
 * Edits are held as a draft and reported upward on every keystroke, because the board is the
 * preview — renaming a step has to move the shelf card before you save, not after.
 */

interface Props {
  /** The draft under edit. Owned by the board so the cards can render from it. */
  draft: Sequence;
  /** Names of the views whose shelves reference this sequence (§7). */
  usedIn: string[];
  dirty: boolean;
  saving: boolean;
  onChange: (next: Sequence) => void;
  onSave: () => void;
  onDiscard: () => void;
  onClose: () => void;
  onRun: () => void;
  onGoToView: (name: string) => void;
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M3 4.5L6 7.5l3-3" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" aria-hidden="true">
      <path d="M6 2.5v7M2.5 6h7" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5.2v.1M8 7.4v3.4" strokeLinecap="round" />
    </svg>
  );
}

/** Which pre-run input, if any, feeds this step's branch — the one binding the model already has. */
function branchSummary(step: SequenceStep, seq: Sequence): string {
  if (step.branchInputId) {
    const input = seq.inputs.find((i) => i.id === step.branchInputId);
    return input ? `input: ${input.name}` : "input: (missing)";
  }
  return step.branch?.trim() || "default branch";
}

export function SequenceEditor({
  draft, usedIn, dirty, saving, onChange, onSave, onDiscard, onClose, onRun, onGoToView,
}: Props) {
  /* Collapsed by default: you open the one or two steps you're touching, not all of them.
     Held here rather than on the draft — which step is expanded is not part of the sequence. */
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // The display-name default: the pipeline name with the prefix shared by every step stripped,
  // which is what makes "SB.ConfigRegistry.UserTypesMap · Deploy" fit on a card.
  const prefix = useMemo(() => commonPrefix(draft.steps.map((s) => s.name)), [draft.steps]);

  const patchStep = (i: number, patch: Partial<SequenceStep>) =>
    onChange({ ...draft, steps: draft.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });

  const patchInput = (i: number, patch: Partial<SequenceInput>) =>
    onChange({ ...draft, inputs: draft.inputs.map((x, j) => (j === i ? { ...x, ...patch } : x)) });

  const addInput = () =>
    onChange({
      ...draft,
      inputs: [...draft.inputs, { id: crypto.randomUUID(), name: "newInput", kind: "value", default: "" }],
    });

  /* Deleting an input is the destructive edit §7 cares about: any step bound to it breaks. The
     count is named here rather than left for the user to discover after saving. */
  const removeInput = (i: number) => {
    const input = draft.inputs[i];
    const bound = draft.steps.filter(
      (s) => s.branchInputId === input.id || (s.bindings ?? []).some((b) => b.inputId === input.id),
    ).length;
    if (bound > 0) {
      const where = usedIn.length > 0 ? ` This sequence is on: ${usedIn.join(", ")}.` : "";
      const ok = window.confirm(
        `${bound} step${bound === 1 ? "" : "s"} reference "${input.name}". Removing it will leave `
        + `${bound === 1 ? "that binding" : "those bindings"} unresolved.${where}`,
      );
      if (!ok) return;
    }
    onChange({ ...draft, inputs: draft.inputs.filter((_, j) => j !== i) });
  };

  return (
    <aside className="seq-editor" aria-label="Sequence editor">
      <div className="ehead">
        <div className="ehead-t">
          <span className="seq-badge">SEQ</span>
          <input
            className="ename"
            value={draft.name}
            placeholder="Sequence name"
            aria-label="Sequence name"
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
          />
          <button className="iconbtn" title="Close editor" aria-label="Close editor" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* §7: the separate Sequences page told you "this is a shared object" for free. Editing
            in context removes that signal, so it is stated here instead. Neutral at one view —
            that's the common case and a warning tint on it would cry wolf. */}
        {usedIn.length > 0 ? (
          <div className={`usage ${usedIn.length > 1 ? "many" : ""}`}>
            <InfoIcon />
            <div>
              Used by <b>{usedIn.length} view{usedIn.length > 1 ? "s" : ""}</b> — edits apply everywhere.
              <div>
                {usedIn.map((v) => (
                  <button key={v} className="viewchip" onClick={() => onGoToView(v)} title={`Go to ${v}`}>
                    {v}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="sect-note" style={{ margin: "8px 0 0" }}>
            Not on any view yet. Drag it from the library onto a shelf.
          </div>
        )}
      </div>

      <div className="escroll">
        {/* §5 inputs table. Collected once before the run, then referenceable by every step —
            which is why they're authored above the steps rather than inside one. */}
        <div className="sect">
          <div className="sect-h">
            <span className="t">Pre-run inputs</span>
            <button className="minibtn" onClick={addInput}><PlusIcon />Add</button>
          </div>
          <div className="sect-note">Collected once before the run, then available to every step.</div>

          {draft.inputs.length === 0 ? (
            <div className="sect-empty">No inputs.</div>
          ) : (
            <>
              <div className="inrow head"><span>Key</span><span>Type</span><span>Default</span><span /></div>
              {draft.inputs.map((input, i) => (
                <div className="inrow" key={input.id}>
                  <input
                    className="fld" value={input.name} aria-label={`Input ${i + 1} key`}
                    onChange={(e) => patchInput(i, { name: e.target.value })}
                  />
                  {/* The kind drives how the run dialog collects the value, so it's a real
                      choice rather than a static badge. */}
                  <select
                    className="tysel" value={input.kind} aria-label={`Input ${i + 1} type`}
                    onChange={(e) => patchInput(i, { kind: e.target.value as SequenceInput["kind"] })}
                  >
                    <option value="value">VALUE</option>
                    <option value="branch">BRANCH</option>
                    <option value="environment">ENV</option>
                  </select>
                  <input
                    className="fld" value={input.default ?? ""} placeholder="—"
                    aria-label={`Input ${i + 1} default`}
                    onChange={(e) => patchInput(i, { default: e.target.value })}
                  />
                  <button className="xbtn" title="Remove input" aria-label={`Remove input ${input.name}`}
                    onClick={() => removeInput(i)}>✕</button>
                </div>
              ))}
            </>
          )}
        </div>

        <div className="sect">
          <div className="sect-h">
            <span className="t">Steps — run in order</span>
          </div>
          <div className="sect-note">
            Each step waits for the previous to succeed. The <b>display name</b> is what shows on
            the card; the real pipeline name sits underneath.
          </div>

          {draft.steps.length === 0 && (
            <div className="sect-empty">No steps yet.</div>
          )}

          {draft.steps.map((step, i) => {
            const isOpen = open.has(step.id);
            return (
              <div className={`step ${isOpen ? "" : "shut"}`} key={step.id}>
                <div className="step-h" onClick={() => toggle(step.id)}>
                  <span className="grip" title="Drag to reorder" onClick={(e) => e.stopPropagation()}>⠿</span>
                  <span className="idx">{i + 1}</span>
                  <span className="names">
                    <input
                      className="dispname"
                      value={step.alias ?? ""}
                      placeholder={stepShort(step.name, prefix) || "Display name"}
                      aria-label={`Display name for step ${i + 1}`}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => patchStep(i, { alias: e.target.value })}
                    />
                    <div className="realname" title={step.name}>{step.name || "Pick a pipeline…"}</div>
                  </span>
                  <span className="chev"><ChevronIcon /></span>
                </div>

                <div className="step-b">
                  <div className="prow">
                    <span className="pname">project</span>
                    <span className="pval">{step.project || "—"}</span>
                  </div>
                  <div className="prow">
                    <span className="pname">branch</span>
                    <span className="pval">{branchSummary(step, draft)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="efoot">
        <button className="btn primary small" disabled={!dirty || saving} onClick={onSave}>
          {saving ? <><span className="spin" /> Saving…</> : "Save changes"}
        </button>
        <button className="btn outline small" disabled={!dirty || saving} onClick={onDiscard}>
          Discard
        </button>
        <span className="sp" />
        {dirty && <span className="dirty">Unsaved</span>}
        <button className="run-btn solid" title="Run sequence now" aria-label="Run sequence now"
          disabled={dirty} onClick={onRun}>
          <PlayIcon />
        </button>
      </div>
    </aside>
  );
}
