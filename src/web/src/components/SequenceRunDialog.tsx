import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { PipelineDetail, Sequence, SequenceInput } from "../types";
import { Combobox } from "./Combobox";

export function SequenceRunDialog({ sequence, busy, onClose, onRun }: {
  sequence: Sequence;
  busy: boolean;
  onClose: () => void;
  onRun: (inputs: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(sequence.inputs.map((i) => [i.id, i.default ?? ""])),
  );

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <div className="title">Run · {sequence.name}</div>
          <button className="btn ghost small" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p className="faint" style={{ marginTop: 0 }}>Set the pre-run inputs, then start the sequence.</p>
          {sequence.inputs.map((i) => (
            <div className="field" key={i.id}>
              <label className="label" style={{ color: "var(--text)" }}>
                {i.name || "(unnamed)"} <span className="faint">· {i.kind}</span>
              </label>
              {i.kind === "branch" ? (
                <BranchInput input={i} value={values[i.id] ?? ""} onChange={(v) => setValues((s) => ({ ...s, [i.id]: v }))} />
              ) : (
                <input className="input" value={values[i.id] ?? ""}
                  onChange={(e) => setValues((s) => ({ ...s, [i.id]: e.target.value }))} />
              )}
            </div>
          ))}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={() => onRun(values)} disabled={busy}>
            {busy ? <><span className="spin" /> Starting…</> : "▶ Run sequence"}
          </button>
        </div>
      </div>
    </div>
  );
}

function BranchInput({ input, value, onChange }: {
  input: SequenceInput;
  value: string;
  onChange: (v: string) => void;
}) {
  const detailQ = useQuery<PipelineDetail>({
    queryKey: ["detail", input.sourceProject, input.sourcePipelineId],
    queryFn: () => api.pipelineDetail(input.sourceProject!, input.sourcePipelineId!),
    enabled: !!input.sourceProject && !!input.sourcePipelineId,
  });

  if (!input.sourcePipelineId) {
    return <input className="input" placeholder="branch" value={value} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <Combobox
      value={value}
      options={(detailQ.data?.branches ?? []).map((b) => ({ value: b.name, label: b.name, hint: b.isDefault ? "default" : undefined }))}
      loading={detailQ.isLoading}
      placeholder="— branch —"
      onChange={onChange}
    />
  );
}
