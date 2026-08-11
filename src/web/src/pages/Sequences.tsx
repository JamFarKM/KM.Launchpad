import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type {
  LinkMode, ParamBinding, Pipeline, PipelineDetail, Project,
  Sequence, SequenceInput, SequenceStep,
} from "../types";
import { Combobox, type ComboOption } from "../components/Combobox";

type Draft = { id: string | null; name: string; inputs: SequenceInput[]; steps: SequenceStep[] };

// Must match AdoService.SmartBranch on the server.
const SMART_BRANCH = "__smart__";

const uid = () =>
  (globalThis.crypto?.randomUUID?.() ?? `id${Math.floor(performance.now() * 1000)}${Math.round(Math.random() * 1e6)}`);

const emptyInput = (): SequenceInput => ({ id: uid(), name: "", kind: "value", default: "" });
const emptyStep = (): SequenceStep => ({
  id: uid(), project: "", pipelineId: 0, name: "", branch: "", branchInputId: "",
  templateParameters: {}, variables: {}, bindings: [], link: { mode: "none", key: "" },
});

export function SequencesPage() {
  const qc = useQueryClient();
  const seqsQ = useQuery<Sequence[]>({ queryKey: ["sequences"], queryFn: api.sequences });
  const projectsQ = useQuery<Project[]>({ queryKey: ["projects"], queryFn: api.projects });
  const seqs = seqsQ.data ?? [];
  const [draft, setDraft] = useState<Draft | null>(null);

  function edit(seq: Sequence) {
    setDraft({
      id: seq.id, name: seq.name,
      inputs: seq.inputs.map((i) => ({ ...i })),
      steps: seq.steps.map((s) => ({ ...s })),
    });
  }
  function newSequence() {
    setDraft({ id: null, name: "", inputs: [], steps: [emptyStep()] });
  }

  const save = useMutation({
    mutationFn: (d: Draft) =>
      d.id ? api.updateSequence(d.id, d.name, d.inputs, d.steps) : api.createSequence(d.name, d.inputs, d.steps),
    onSuccess: (saved) => { qc.invalidateQueries({ queryKey: ["sequences"] }); edit(saved); },
  });
  const del = useMutation({
    mutationFn: (id: string) => api.deleteSequence(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["sequences"] }); setDraft(null); },
  });

  // input helpers
  const patchInput = (i: number, patch: Partial<SequenceInput>) =>
    setDraft((d) => d && { ...d, inputs: d.inputs.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const addInput = () => setDraft((d) => d && { ...d, inputs: [...d.inputs, emptyInput()] });
  const removeInput = (i: number) => setDraft((d) => d && { ...d, inputs: d.inputs.filter((_, j) => j !== i) });

  // step helpers
  const patchStep = (i: number, patch: Partial<SequenceStep>) =>
    setDraft((d) => d && { ...d, steps: d.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const moveStep = (i: number, dir: -1 | 1) =>
    setDraft((d) => {
      if (!d) return d;
      const j = i + dir;
      if (j < 0 || j >= d.steps.length) return d;
      const steps = [...d.steps];
      [steps[i], steps[j]] = [steps[j], steps[i]];
      return { ...d, steps };
    });
  const removeStep = (i: number) => setDraft((d) => d && { ...d, steps: d.steps.filter((_, j) => j !== i) });
  const addStep = () => setDraft((d) => d && { ...d, steps: [...d.steps, emptyStep()] });

  const canSave = !!draft && draft.name.trim() !== "" && draft.steps.length > 0 && draft.steps.every((s) => s.pipelineId > 0);

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
          <div key={s.id} className={`seq-list-item ${draft?.id === s.id ? "active" : ""}`} onClick={() => edit(s)}>
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
              <p>Define <b>pre-run</b> inputs (a branch, an environment value…), then the <b>run</b> steps. Each step waits for the previous to succeed and can pull values from your inputs or the previous run.</p>
              <button className="btn primary" onClick={newSequence}>+ New sequence</button>
            </div>
          )}

          {draft && (
            <div className="seq-editor">
              <div className="row" style={{ marginBottom: 10 }}>
                <input
                  className="input" style={{ maxWidth: 420, fontSize: 16 }}
                  placeholder="Sequence name (e.g. Placement → INT)"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
                <span style={{ flex: 1 }} />
                {draft.id && (
                  <button className="btn ghost small" onClick={() => { if (window.confirm(`Delete sequence "${draft.name}"?`)) del.mutate(draft.id!); }}>Delete</button>
                )}
                <button className="btn primary" disabled={!canSave || save.isPending} onClick={() => save.mutate(draft)}>
                  {save.isPending ? "Saving…" : "Save sequence"}
                </button>
              </div>
              {!canSave && (
                <div className="faint" style={{ marginBottom: 12, fontSize: 12 }}>
                  Give the sequence a name and pick a pipeline for every step to save.
                </div>
              )}

              {/* -------- pre-run -------- */}
              <div className="seq-section-title">Pre-run — inputs &amp; variables</div>
              {draft.inputs.length === 0 && (
                <div className="faint" style={{ fontSize: 13, marginBottom: 8 }}>
                  Optional. Add a branch or a value (e.g. <code>environment_suffix</code>) you’ll set before each run and plug into the steps below.
                </div>
              )}
              {draft.inputs.map((input, i) => (
                <InputEditor
                  key={input.id}
                  input={input}
                  projects={projectsQ.data ?? []}
                  onChange={(patch) => patchInput(i, patch)}
                  onRemove={() => removeInput(i)}
                />
              ))}
              <button className="btn small" onClick={addInput}>+ Add input</button>

              {/* -------- run -------- */}
              <div className="seq-section-title">Run — pipeline steps</div>
              {draft.steps.map((step, i) => (
                <StepEditor
                  key={step.id}
                  step={step}
                  index={i}
                  total={draft.steps.length}
                  projects={projectsQ.data ?? []}
                  inputs={draft.inputs}
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

function projectOptions(projects: Project[]): ComboOption[] {
  return projects.map((p) => ({ value: p.name, label: p.name }));
}
function pipelineOptions(pipes: Pipeline[]): ComboOption[] {
  return pipes.map((p) => ({ value: String(p.id), label: p.name, hint: p.folder ?? undefined }));
}

function InputEditor({ input, projects, onChange, onRemove }: {
  input: SequenceInput;
  projects: Project[];
  onChange: (patch: Partial<SequenceInput>) => void;
  onRemove: () => void;
}) {
  const sourced = input.kind === "branch" || input.kind === "environment";
  const pipelinesQ = useQuery<Pipeline[]>({
    queryKey: ["pipelines", input.sourceProject],
    queryFn: () => api.pipelines(input.sourceProject!),
    enabled: sourced && !!input.sourceProject,
  });
  const detailQ = useQuery<PipelineDetail>({
    queryKey: ["detail", input.sourceProject, input.sourcePipelineId],
    queryFn: () => api.pipelineDetail(input.sourceProject!, input.sourcePipelineId!),
    enabled: sourced && !!input.sourceProject && !!input.sourcePipelineId,
  });

  const selectedParam = (detailQ.data?.parameters ?? []).find((p) => p.name === input.sourceParameter);
  const envValues = selectedParam?.allowedValues ?? [];

  return (
    <div className="seq-input-card">
      <div className="row" style={{ marginBottom: 8 }}>
        <input className="input" style={{ maxWidth: 220 }} placeholder="Input name (e.g. branch, environment_suffix)"
          value={input.name} onChange={(e) => onChange({ name: e.target.value })} />
        <select className="select" style={{ maxWidth: 150 }} value={input.kind}
          onChange={(e) => onChange({ kind: e.target.value as SequenceInput["kind"] })}>
          <option value="value">value</option>
          <option value="branch">branch</option>
          <option value="environment">environment</option>
        </select>
        <span style={{ flex: 1 }} />
        <button className="btn ghost small" onClick={onRemove}>✕</button>
      </div>

      {input.kind === "branch" && (
        <div className="seq-step-grid">
          <div>
            <label className="label">Autofill from project</label>
            <Combobox value={input.sourceProject ?? ""} options={projectOptions(projects)} placeholder="— project —"
              onChange={(v) => onChange({ sourceProject: v, sourcePipelineId: null })} />
          </div>
          <div>
            <label className="label">Pipeline</label>
            <Combobox value={input.sourcePipelineId ? String(input.sourcePipelineId) : ""}
              options={pipelineOptions(pipelinesQ.data ?? [])} disabled={!input.sourceProject} loading={pipelinesQ.isLoading}
              placeholder="— pipeline —" onChange={(v) => onChange({ sourcePipelineId: Number(v) })} />
          </div>
          <div>
            <label className="label">Default branch</label>
            <Combobox value={input.default ?? ""}
              options={[
                { value: SMART_BRANCH, label: "🔍 smart-detect — your last branch", hint: "auto" },
                ...(detailQ.data?.branches ?? []).map((b) => ({ value: b.name, label: b.name, hint: b.isDefault ? "default" : undefined })),
              ]}
              disabled={!input.sourcePipelineId} loading={detailQ.isLoading} placeholder="— branch —"
              onChange={(v) => onChange({ default: v })} />
          </div>
        </div>
      )}

      {input.kind === "environment" && (
        <div className="seq-step-grid">
          <div>
            <label className="label">Values from project</label>
            <Combobox value={input.sourceProject ?? ""} options={projectOptions(projects)} placeholder="— project —"
              onChange={(v) => onChange({ sourceProject: v, sourcePipelineId: null, sourceParameter: "" })} />
          </div>
          <div>
            <label className="label">Pipeline</label>
            <Combobox value={input.sourcePipelineId ? String(input.sourcePipelineId) : ""}
              options={pipelineOptions(pipelinesQ.data ?? [])} disabled={!input.sourceProject} loading={pipelinesQ.isLoading}
              placeholder="— pipeline —" onChange={(v) => onChange({ sourcePipelineId: Number(v), sourceParameter: "" })} />
          </div>
          <div>
            <label className="label">Parameter</label>
            <Combobox value={input.sourceParameter ?? ""}
              options={(detailQ.data?.parameters ?? []).map((p) => ({ value: p.name, label: p.name, hint: p.type === "enum" ? `${p.allowedValues?.length ?? 0} values` : p.type }))}
              disabled={!input.sourcePipelineId} loading={detailQ.isLoading} placeholder="— parameter —"
              onChange={(v) => onChange({ sourceParameter: v })} />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label className="label">Default value</label>
            {envValues.length > 0 ? (
              <Combobox value={input.default ?? ""} options={envValues.map((v) => ({ value: v, label: v }))}
                placeholder="— value —" onChange={(v) => onChange({ default: v })} />
            ) : (
              <input className="input" style={{ maxWidth: 260 }} placeholder="e.g. int"
                value={input.default ?? ""} onChange={(e) => onChange({ default: e.target.value })} />
            )}
          </div>
        </div>
      )}

      {input.kind === "value" && (
        <div>
          <label className="label">Default value</label>
          <input className="input" style={{ maxWidth: 260 }} placeholder="e.g. int"
            value={input.default ?? ""} onChange={(e) => onChange({ default: e.target.value })} />
        </div>
      )}
    </div>
  );
}

function StepEditor({ step, index, total, projects, inputs, onChange, onMove, onRemove }: {
  step: SequenceStep;
  index: number;
  total: number;
  projects: Project[];
  inputs: SequenceInput[];
  onChange: (patch: Partial<SequenceStep>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const pipelinesQ = useQuery<Pipeline[]>({
    queryKey: ["pipelines", step.project],
    queryFn: () => api.pipelines(step.project),
    enabled: !!step.project,
  });
  const detailQ = useQuery<PipelineDetail>({
    queryKey: ["detail", step.project, step.pipelineId],
    queryFn: () => api.pipelineDetail(step.project, step.pipelineId),
    enabled: !!step.project && step.pipelineId > 0,
  });
  const detail = detailQ.data;

  const branchInputs = inputs.filter((i) => i.kind === "branch");
  const valueInputs = inputs.filter((i) => i.kind !== "branch"); // value + environment are bindable

  // Branch selector merges: default + smart-detect + branch-inputs + the pipeline's branches.
  const branchValue = step.branch === SMART_BRANCH
    ? "smart"
    : step.branchInputId ? `input:${step.branchInputId}` : step.branch ? `branch:${step.branch}` : "";
  const branchOptions: ComboOption[] = [
    { value: "", label: "(default branch)" },
    { value: "smart", label: "🔍 smart-detect — your last branch", hint: "auto" },
    ...branchInputs.map((i) => ({ value: `input:${i.id}`, label: `input: ${i.name || "(unnamed)"}`, hint: "pre-run" })),
    ...(detail?.branches ?? []).map((b) => ({ value: `branch:${b.name}`, label: b.name, hint: b.isDefault ? "default" : undefined })),
  ];
  function onBranchChange(v: string) {
    if (v === "smart") onChange({ branchInputId: "", branch: SMART_BRANCH });
    else if (v.startsWith("input:")) onChange({ branchInputId: v.slice(6), branch: "" });
    else if (v.startsWith("branch:")) onChange({ branchInputId: "", branch: v.slice(7) });
    else onChange({ branchInputId: "", branch: "" });
  }

  const bindings = step.bindings ?? [];
  const setBindings = (b: ParamBinding[]) => onChange({ bindings: b });
  const paramNames = (detail?.parameters ?? []).map((p) => p.name);
  const linkKeySuggestions = step.link?.mode === "resource"
    ? (detail?.resources ?? []).map((r) => r.alias)
    : paramNames;

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
          <Combobox value={step.project} options={projectOptions(projects)} placeholder="— project —"
            onChange={(v) => onChange({ project: v, pipelineId: 0, name: "" })} />
        </div>
        <div>
          <label className="label">Pipeline</label>
          <Combobox value={step.pipelineId ? String(step.pipelineId) : ""}
            options={pipelineOptions(pipelinesQ.data ?? [])}
            disabled={!step.project} loading={pipelinesQ.isLoading} placeholder="— pipeline —"
            onChange={(v) => {
              const p = pipelinesQ.data?.find((x) => x.id === Number(v));
              onChange({ pipelineId: Number(v), name: p?.name ?? "" });
            }} />
        </div>
        <div>
          <label className="label">Branch</label>
          <Combobox value={branchValue} options={branchOptions}
            disabled={step.pipelineId <= 0} loading={detailQ.isLoading}
            onChange={onBranchChange} />
        </div>
      </div>

      {index > 0 && (
        <div className="seq-link">
          <label className="label">Link from previous step</label>
          <div className="row">
            <select className="select" style={{ maxWidth: 220 }} value={step.link?.mode ?? "none"}
              onChange={(e) => onChange({ link: { mode: e.target.value as LinkMode, key: step.link?.key ?? "", source: step.link?.source ?? "buildNumber" } })}>
              <option value="none">nothing (just run in order)</option>
              <option value="resource">pipeline resource (previous run version)</option>
              <option value="parameter">template parameter =</option>
              <option value="variable">variable =</option>
            </select>
            {step.link && (step.link.mode === "parameter" || step.link.mode === "variable") && (
              <select className="select" style={{ maxWidth: 220 }} value={step.link.source ?? "buildNumber"}
                onChange={(e) => onChange({ link: { ...step.link!, source: e.target.value } })}>
                <option value="buildNumber">previous build number</option>
                <option value="tag">image tag (branch.buildNumber)</option>
                <option value="runId">previous run ID</option>
                <option value="branch">previous source branch</option>
              </select>
            )}
            {step.link && step.link.mode !== "none" && (
              <>
                <input className="input" list={`linkkeys-${step.id}`}
                  placeholder={step.link.mode === "resource" ? "resource alias" : "parameter / variable name"}
                  value={step.link.key ?? ""}
                  onChange={(e) => onChange({ link: { ...step.link!, key: e.target.value } })} />
                <datalist id={`linkkeys-${step.id}`}>
                  {linkKeySuggestions.map((k) => <option key={k} value={k} />)}
                </datalist>
              </>
            )}
          </div>
          {step.link?.mode === "resource" && (detail?.resources?.length ?? 0) === 0 && (
            <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>No pipeline resources declared in this pipeline’s YAML — type the alias if you know it.</div>
          )}
        </div>
      )}

      {/* bind pre-run inputs into this step's params */}
      {valueInputs.length > 0 && (
        <div className="seq-link">
          <label className="label">Plug pre-run inputs into parameters</label>
          {bindings.map((b, bi) => (
            <div className="seq-binding-row" key={bi}>
              <select className="select" value={b.target}
                onChange={(e) => setBindings(bindings.map((x, j) => (j === bi ? { ...x, target: e.target.value as "parameter" | "variable" } : x)))}>
                <option value="parameter">parameter</option>
                <option value="variable">variable</option>
              </select>
              <input className="input" list={`params-${step.id}`} placeholder="name"
                value={b.name} onChange={(e) => setBindings(bindings.map((x, j) => (j === bi ? { ...x, name: e.target.value } : x)))} />
              <select className="select" value={b.inputId}
                onChange={(e) => setBindings(bindings.map((x, j) => (j === bi ? { ...x, inputId: e.target.value } : x)))}>
                <option value="">— input —</option>
                {valueInputs.map((i) => <option key={i.id} value={i.id}>{i.name || "(unnamed)"}</option>)}
              </select>
              <button className="btn ghost small" onClick={() => setBindings(bindings.filter((_, j) => j !== bi))}>✕</button>
            </div>
          ))}
          <datalist id={`params-${step.id}`}>
            {paramNames.map((n) => <option key={n} value={n} />)}
          </datalist>
          <button className="btn small" onClick={() => setBindings([...bindings, { target: "parameter", name: "", inputId: valueInputs[0]?.id ?? "" }])}>
            + Bind an input
          </button>
        </div>
      )}

      <KvEditor label="Static template parameters" initial={step.templateParameters ?? {}} onChange={(rec) => onChange({ templateParameters: rec })} />
      <KvEditor label="Static variables" initial={step.variables ?? {}} onChange={(rec) => onChange({ variables: rec })} />
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
