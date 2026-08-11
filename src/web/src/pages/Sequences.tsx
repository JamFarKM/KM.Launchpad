import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { LinkMode, Pipeline, Project, Sequence, SequenceStep } from "../types";

type Draft = { id: string | null; name: string; steps: SequenceStep[] };

const emptyStep = (): SequenceStep => ({
  project: "",
  pipelineId: 0,
  name: "",
  branch: "",
  templateParameters: {},
  variables: {},
  link: { mode: "none", key: "" },
});

export function SequencesPage() {
  const qc = useQueryClient();
  const seqsQ = useQuery<Sequence[]>({ queryKey: ["sequences"], queryFn: api.sequences });
  const projectsQ = useQuery<Project[]>({ queryKey: ["projects"], queryFn: api.projects });
  const seqs = seqsQ.data ?? [];

  const [draft, setDraft] = useState<Draft | null>(null);

  function edit(seq: Sequence) {
    setDraft({ id: seq.id, name: seq.name, steps: seq.steps.map((s) => ({ ...s })) });
  }
  function newSequence() {
    setDraft({ id: null, name: "", steps: [emptyStep()] });
  }

  const save = useMutation({
    mutationFn: (d: Draft) =>
      d.id ? api.updateSequence(d.id, d.name, d.steps) : api.createSequence(d.name, d.steps),
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["sequences"] });
      edit(saved);
    },
  });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteSequence(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sequences"] });
      setDraft(null);
    },
  });

  function patchStep(i: number, patch: Partial<SequenceStep>) {
    setDraft((d) => d && { ...d, steps: d.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  }
  function moveStep(i: number, dir: -1 | 1) {
    setDraft((d) => {
      if (!d) return d;
      const j = i + dir;
      if (j < 0 || j >= d.steps.length) return d;
      const steps = [...d.steps];
      [steps[i], steps[j]] = [steps[j], steps[i]];
      return { ...d, steps };
    });
  }
  function removeStep(i: number) {
    setDraft((d) => d && { ...d, steps: d.steps.filter((_, j) => j !== i) });
  }
  function addStep() {
    setDraft((d) => d && { ...d, steps: [...d.steps, emptyStep()] });
  }

  const canSave = !!draft && draft.name.trim() !== "" && draft.steps.every((s) => s.pipelineId > 0);

  return (
    <div className="body">
      <aside className="seq-list">
        <div className="seq-list-head">
          <span className="pool-group-title" style={{ padding: 0 }}>Sequences</span>
          <button className="btn small primary" onClick={newSequence}>+ New</button>
        </div>
        {seqsQ.isLoading && <div className="center-note"><span className="spin" /> loading…</div>}
        {!seqsQ.isLoading && seqs.length === 0 && (
          <div className="faint" style={{ padding: 12, fontSize: 13 }}>No sequences yet. Create one to chain pipelines (build → deploy).</div>
        )}
        {seqs.map((s) => (
          <div
            key={s.id}
            className={`seq-list-item ${draft?.id === s.id ? "active" : ""}`}
            onClick={() => edit(s)}
          >
            <span className="name">{s.name}</span>
            <span className="faint">{s.steps.length}</span>
          </div>
        ))}
      </aside>

      <div className="main">
        <div className="view-area">
          {!draft && (
            <div className="empty">
              <h3>Compose pipelines into a sequence</h3>
              <p>Chain a build → deploy (or any order). Each step waits for the previous to succeed; you choose how each step passes the previous run to the next.</p>
              <button className="btn primary" onClick={newSequence}>+ New sequence</button>
            </div>
          )}

          {draft && (
            <div className="seq-editor">
              <div className="row" style={{ marginBottom: 14 }}>
                <input
                  className="input"
                  style={{ maxWidth: 420, fontSize: 16 }}
                  placeholder="Sequence name (e.g. Placement → INT)"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
                <span style={{ flex: 1 }} />
                {draft.id && (
                  <button className="btn ghost small" onClick={() => {
                    if (window.confirm(`Delete sequence "${draft.name}"?`)) del.mutate(draft.id!);
                  }}>Delete</button>
                )}
                <button className="btn primary" disabled={!canSave || save.isPending} onClick={() => save.mutate(draft)}>
                  {save.isPending ? "Saving…" : "Save sequence"}
                </button>
              </div>
              {!canSave && draft.steps.length > 0 && (
                <div className="faint" style={{ marginBottom: 12, fontSize: 12 }}>
                  Give the sequence a name and pick a pipeline for every step to save.
                </div>
              )}

              {draft.steps.map((step, i) => (
                <StepEditor
                  key={`${draft.id ?? "new"}:${i}`}
                  step={step}
                  index={i}
                  total={draft.steps.length}
                  projects={projectsQ.data ?? []}
                  onChange={(patch) => patchStep(i, patch)}
                  onMove={(dir) => moveStep(i, dir)}
                  onRemove={() => removeStep(i)}
                />
              ))}

              <button className="btn small add-shelf" onClick={addStep}>+ Add step</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StepEditor({
  step, index, total, projects, onChange, onMove, onRemove,
}: {
  step: SequenceStep;
  index: number;
  total: number;
  projects: Project[];
  onChange: (patch: Partial<SequenceStep>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const pipelinesQ = useQuery<Pipeline[]>({
    queryKey: ["pipelines", step.project],
    queryFn: () => api.pipelines(step.project),
    enabled: !!step.project,
  });

  return (
    <div className="seq-step-card">
      <div className="seq-step-head">
        <span className="seq-step-num">{index + 1}</span>
        <strong>{step.name || "Choose a pipeline"}</strong>
        <span style={{ flex: 1 }} />
        <button className="btn ghost small" disabled={index === 0} onClick={() => onMove(-1)}>↑</button>
        <button className="btn ghost small" disabled={index === total - 1} onClick={() => onMove(1)}>↓</button>
        <button className="btn ghost small" onClick={onRemove}>✕</button>
      </div>

      <div className="seq-step-grid">
        <div>
          <label className="label">Project</label>
          <select
            className="select"
            value={step.project}
            onChange={(e) => onChange({ project: e.target.value, pipelineId: 0, name: "" })}
          >
            <option value="">— select —</option>
            {projects.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Pipeline</label>
          <select
            className="select"
            value={step.pipelineId || ""}
            disabled={!step.project || pipelinesQ.isLoading}
            onChange={(e) => {
              const id = Number(e.target.value);
              const p = pipelinesQ.data?.find((x) => x.id === id);
              onChange({ pipelineId: id, name: p?.name ?? "" });
            }}
          >
            <option value="">{pipelinesQ.isLoading ? "loading…" : "— select —"}</option>
            {pipelinesQ.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Branch <span className="faint">(blank = default)</span></label>
          <input
            className="input"
            placeholder="default branch"
            value={step.branch ?? ""}
            onChange={(e) => onChange({ branch: e.target.value })}
          />
        </div>
      </div>

      {index > 0 && (
        <div className="seq-link">
          <label className="label">Link from previous step</label>
          <div className="row">
            <select
              className="select" style={{ maxWidth: 220 }}
              value={step.link?.mode ?? "none"}
              onChange={(e) => onChange({ link: { mode: e.target.value as LinkMode, key: step.link?.key ?? "" } })}
            >
              <option value="none">nothing (just run in order)</option>
              <option value="resource">pipeline resource (previous run version)</option>
              <option value="parameter">template parameter = previous runId</option>
              <option value="variable">variable = previous runId</option>
            </select>
            {step.link && step.link.mode !== "none" && (
              <input
                className="input"
                placeholder={step.link.mode === "resource" ? "resource alias" : "parameter / variable name"}
                value={step.link.key ?? ""}
                onChange={(e) => onChange({ link: { mode: step.link!.mode, key: e.target.value } })}
              />
            )}
          </div>
        </div>
      )}

      <KvEditor label="Template parameters" initial={step.templateParameters ?? {}}
        onChange={(rec) => onChange({ templateParameters: rec })} />
      <KvEditor label="Variables" initial={step.variables ?? {}}
        onChange={(rec) => onChange({ variables: rec })} />
    </div>
  );
}

function KvEditor({ label, initial, onChange }: {
  label: string;
  initial: Record<string, string>;
  onChange: (rec: Record<string, string>) => void;
}) {
  const seed = useMemo(() => Object.entries(initial).map(([k, v]) => ({ k, v })), [initial]);
  const [rows, setRows] = useState(seed);

  useEffect(() => { setRows(seed); }, [seed]);

  function push(next: { k: string; v: string }[]) {
    setRows(next);
    onChange(Object.fromEntries(next.filter((r) => r.k.trim() !== "").map((r) => [r.k.trim(), r.v])));
  }

  return (
    <details className="seq-kv">
      <summary className="label" style={{ cursor: "pointer" }}>
        {label}{rows.filter((r) => r.k).length > 0 ? ` (${rows.filter((r) => r.k).length})` : ""}
      </summary>
      <div style={{ marginTop: 8 }}>
        {rows.map((r, i) => (
          <div className="row" key={i} style={{ marginBottom: 6 }}>
            <input className="input" placeholder="name" value={r.k}
              onChange={(e) => push(rows.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />
            <input className="input" placeholder="value" value={r.v}
              onChange={(e) => push(rows.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
            <button className="btn ghost small" onClick={() => push(rows.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <button className="btn small" onClick={() => push([...rows, { k: "", v: "" }])}>+ Add</button>
      </div>
    </details>
  );
}
