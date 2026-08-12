import { Fragment, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Pipeline, PipelineDetail, Project, Sequence, SequenceInput, SequenceStep } from "../types";
import { STEP_OUTPUTS } from "../types";
import { Combobox, type ComboOption } from "./Combobox";
import { commonPrefix, stepShort } from "../lib/format";
import { applyParams, paramsOf, remapAfterReorder, resolve, type Param, type Src } from "../lib/bindings";
import { placePopup } from "../lib/popup";
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
  /** For the per-step project picker. */
  projects: Project[];
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

function WarnIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M8 2.5l6 11H2z" strokeLinejoin="round" />
      <path d="M8 6.5v3.2M8 11.4v.1" strokeLinecap="round" />
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

const SMART_BRANCH = "__smart__";

/** What a link passes along. `tag` composes the image tag a build does: <lastBranchSeg>.<buildNumber>. */
const LINK_SOURCES: ComboOption[] = [
  { value: "buildNumber", label: "build number" },
  { value: "runId", label: "run id" },
  { value: "tag", label: "image tag", hint: "branch.buildNumber" },
  { value: "branch", label: "branch" },
];

/**
 * Which pipeline a step runs, and on which branch. Its own component so each step queries only
 * its own project's pipelines and its own pipeline's branches, rather than the panel fetching
 * every combination up front.
 */
function StepConfig({ step, prev, inputs, projects, onChange }: {
  step: SequenceStep;
  /** The immediately previous step, if any — a link can only ever read that one. */
  prev: SequenceStep | null;
  inputs: SequenceInput[];
  projects: Project[];
  onChange: (patch: Partial<SequenceStep>) => void;
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

  // One control for what are three storage fields, because they're mutually exclusive: a branch
  // comes from an input, or a literal ref, or the smart sentinel, or the pipeline's default.
  const branchValue = step.branch === SMART_BRANCH ? "smart"
    : step.branchInputId ? `input:${step.branchInputId}`
    : step.branch ? `branch:${step.branch}` : "";

  const branchOptions: ComboOption[] = [
    { value: "", label: "(default branch)" },
    { value: "smart", label: "smart-detect — your last branch", hint: "auto" },
    ...inputs.filter((i) => i.kind === "branch")
      .map((i) => ({ value: `input:${i.id}`, label: `input: ${i.name || "(unnamed)"}`, hint: "pre-run" })),
    ...(detailQ.data?.branches ?? [])
      .map((b) => ({ value: `branch:${b.name}`, label: b.name, hint: b.isDefault ? "default" : undefined })),
  ];

  const onBranch = (v: string) => {
    if (v === "smart") onChange({ branchInputId: "", branch: SMART_BRANCH });
    else if (v.startsWith("input:")) onChange({ branchInputId: v.slice(6), branch: "" });
    else if (v.startsWith("branch:")) onChange({ branchInputId: "", branch: v.slice(7) });
    else onChange({ branchInputId: "", branch: "" });
  };

  /* Consuming the previous step's build. The runner's link always reads the immediately previous
     step, so a declared `resources: pipelines:` entry naming that step's pipeline is a link the
     app can propose outright rather than making you know the alias and type it. */
  const resources = detailQ.data?.resources ?? [];
  const matches = (r: { source?: string | null; project?: string | null }) => {
    if (!prev?.name || !r.source) return false;
    const a = r.source.toLowerCase(), b = prev.name.toLowerCase();
    return a === b || a.endsWith(b) || b.endsWith(a);
  };

  const linkValue = !step.link || step.link.mode === "none" ? ""
    : step.link.mode === "resource" || step.link.mode === "container"
      ? `${step.link.mode}:${step.link.key ?? ""}`
      : step.link.mode;

  const linkOptions: ComboOption[] = [
    { value: "", label: "not used" },
    ...resources.map((r) => ({
      value: `resource:${r.alias}`,
      label: `as pipeline resource: ${r.alias}`,
      hint: matches(r) ? `matches ${prev?.alias?.trim() || prev?.name}` : r.source ?? "declared",
    })),
    ...(step.link?.mode === "container" && step.link.key
      ? [{ value: `container:${step.link.key}`, label: `as container: ${step.link.key}`, hint: "image tag" }]
      : []),
    { value: "parameter", label: "as a template parameter…", hint: "pick below" },
    { value: "variable", label: "as a variable…", hint: "pick below" },
  ];

  // A declared resource naming the previous step's pipeline is the intended wiring, so it leads.
  linkOptions.sort((a, b) => Number(b.hint?.startsWith("matches") ?? false) - Number(a.hint?.startsWith("matches") ?? false));

  const onLink = (v: string) => {
    if (!v) return onChange({ link: { mode: "none", key: "", source: step.link?.source ?? "buildNumber" } });
    if (v.startsWith("resource:")) return onChange({ link: { mode: "resource", key: v.slice(9), source: "buildNumber" } });
    if (v.startsWith("container:")) return onChange({ link: { mode: "container", key: v.slice(10), source: "tag" } });
    onChange({ link: { mode: v as "parameter" | "variable", key: step.link?.key ?? "", source: step.link?.source ?? "buildNumber" } });
  };

  return (
    <>
      <div className="prow">
        <span className="pname">project</span>
        <span className="pctl">
          <Combobox
            value={step.project}
            options={projects.map((p) => ({ value: p.name, label: p.name }))}
            placeholder="— project —"
            onChange={(v) => onChange({ project: v, pipelineId: 0, name: "" })}
          />
        </span>
      </div>
      <div className="prow">
        <span className="pname">pipeline</span>
        <span className="pctl">
          <Combobox
            value={step.pipelineId ? String(step.pipelineId) : ""}
            options={(pipelinesQ.data ?? []).map((p) => ({ value: String(p.id), label: p.name, hint: p.folder ?? undefined }))}
            disabled={!step.project}
            loading={pipelinesQ.isLoading}
            placeholder="— pipeline —"
            onChange={(v) => {
              const p = pipelinesQ.data?.find((x) => x.id === Number(v));
              onChange({ pipelineId: Number(v), name: p?.name ?? "" });
            }}
          />
        </span>
      </div>
      <div className="prow">
        <span className="pname">branch</span>
        <span className="pctl">
          <Combobox
            value={branchValue}
            options={branchOptions}
            disabled={step.pipelineId <= 0}
            loading={detailQ.isLoading}
            onChange={onBranch}
          />
        </span>
      </div>
      {prev && (
        <div className="prow">
          <span className="pname">previous build</span>
          <span className="pctl">
            <Combobox
              value={linkValue}
              options={linkOptions}
              disabled={step.pipelineId <= 0}
              loading={detailQ.isLoading}
              onChange={onLink}
            />
          </span>
        </div>
      )}
      {/* The alias has to match the YAML exactly, so when the scrape found nothing there is
          nothing to pick from and typing it is the only route left. */}
      {prev && step.pipelineId > 0 && !detailQ.isLoading && resources.length === 0 && (
        <div className="prow">
          <span className="pname" />
          <span className="pctl sect-note" style={{ width: 250 }}>
            This pipeline's YAML declares no pipeline resources.
          </span>
        </div>
      )}
      {prev && (step.link?.mode === "parameter" || step.link?.mode === "variable") && (
        <>
          <div className="prow">
            <span className="pname">…as</span>
            <span className="pctl">
              <Combobox
                value={step.link.key ?? ""}
                options={(detailQ.data?.parameters ?? []).map((p) => ({ value: p.name, label: p.name, hint: p.kind }))}
                placeholder={step.link.mode === "parameter" ? "— parameter —" : "— variable —"}
                allowCustom
                onChange={(v) => onChange({ link: { ...step.link!, key: v } })}
              />
            </span>
          </div>
          <div className="prow">
            <span className="pname">value</span>
            <span className="pctl">
              <Combobox
                value={step.link.source ?? "buildNumber"}
                options={LINK_SOURCES}
                onChange={(v) => onChange({ link: { ...step.link!, source: v } })}
              />
            </span>
          </div>
        </>
      )}
    </>
  );
}

/**
 * A pre-run input's row, plus the source chain that a branch or environment input needs.
 *
 * An environment input offers the allowed values of a YAML template parameter, so it has to name
 * the pipeline those values are scraped from; the run dialog resolves the same three fields when
 * it collects the value. SEQUENCES §5 lists the table as key/type/default/remove and says nothing
 * about the chain, so it hangs off the row as a disclosure rather than widening the table for the
 * two kinds that use it.
 */
function InputRow({ input, index, projects, onPatch, onRemove }: {
  input: SequenceInput;
  index: number;
  projects: Project[];
  onPatch: (patch: Partial<SequenceInput>) => void;
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

  const params = detailQ.data?.parameters ?? [];
  const envValues = params.find((p) => p.name === input.sourceParameter)?.allowedValues ?? [];

  return (
    <>
      <div className="inrow">
        <input
          className="fld" value={input.name} aria-label={`Input ${index + 1} key`}
          onChange={(e) => onPatch({ name: e.target.value })}
        />
        {/* The kind drives how the run dialog collects the value, so it's a real
            choice rather than a static badge. */}
        <select
          className="tysel" value={input.kind} aria-label={`Input ${index + 1} type`}
          onChange={(e) => onPatch({ kind: e.target.value as SequenceInput["kind"] })}
        >
          <option value="value">VALUE</option>
          <option value="branch">BRANCH</option>
          <option value="environment">ENV</option>
        </select>
        {/* Smart-detect was previously only reachable by typing the raw __smart__
            sentinel, so nobody would ever find it. For a branch input it's now an
            offered choice, and the sentinel is never shown as text. */}
        {input.kind === "branch" ? (
          /* A branch is picked, not typed. smart-detect is the first option rather than a
             separate button, so the one control answers "what branch by default?" — and
             allowCustom keeps a branch the source pipeline doesn't list reachable. */
          <Combobox
            value={input.default ?? ""}
            options={[
              { value: SMART_BRANCH, label: "smart-detect — your last branch", hint: "auto" },
              ...(detailQ.data?.branches ?? []).map((b) => ({
                value: b.name,
                label: b.name,
                hint: b.isDefault ? "default" : b.mine ? "yours" : undefined,
              })),
            ]}
            loading={detailQ.isLoading}
            placeholder={input.sourcePipelineId ? "— branch —" : "— branch (pick a pipeline) —"}
            allowCustom
            onChange={(v) => onPatch({ default: v })}
          />
        ) : input.kind === "environment" && envValues.length > 0 ? (
          /* The point of naming a parameter: its allowed values become the choices, so the
             default is picked from what the pipeline actually accepts. */
          <Combobox
            value={input.default ?? ""}
            options={envValues.map((v) => ({ value: v, label: v }))}
            placeholder="— value —"
            onChange={(v) => onPatch({ default: v })}
          />
        ) : (
          <input
            className="fld" value={input.default ?? ""} placeholder="—"
            aria-label={`Input ${index + 1} default`}
            onChange={(e) => onPatch({ default: e.target.value })}
          />
        )}
        <button className="xbtn" title="Remove input" aria-label={`Remove input ${input.name}`}
          onClick={onRemove}>✕</button>
      </div>

      {sourced && (
        <div className="insrc">
          <div className="prow">
            <span className="pname">{input.kind === "branch" ? "branches from" : "values from"}</span>
            <span className="pctl">
              <Combobox
                value={input.sourceProject ?? ""}
                options={projects.map((p) => ({ value: p.name, label: p.name }))}
                placeholder="— project —"
                onChange={(v) => onPatch({ sourceProject: v, sourcePipelineId: null, sourceParameter: "" })}
              />
            </span>
          </div>
          <div className="prow">
            <span className="pname">pipeline</span>
            <span className="pctl">
              <Combobox
                value={input.sourcePipelineId ? String(input.sourcePipelineId) : ""}
                options={(pipelinesQ.data ?? []).map((p) => ({ value: String(p.id), label: p.name, hint: p.folder ?? undefined }))}
                disabled={!input.sourceProject}
                loading={pipelinesQ.isLoading}
                placeholder="— pipeline —"
                onChange={(v) => onPatch({ sourcePipelineId: Number(v), sourceParameter: "" })}
              />
            </span>
          </div>
          {input.kind === "environment" && (
            <div className="prow">
              <span className="pname">parameter</span>
              <span className="pctl">
                <Combobox
                  value={input.sourceParameter ?? ""}
                  options={params.map((p) => ({
                    value: p.name,
                    label: p.name,
                    hint: p.allowedValues?.length ? `${p.allowedValues.length} values` : p.type,
                  }))}
                  disabled={!input.sourcePipelineId}
                  loading={detailQ.isLoading}
                  placeholder="— parameter —"
                  onChange={(v) => onPatch({ sourceParameter: v })}
                />
              </span>
            </div>
          )}
          {input.kind === "environment" && input.sourceParameter && envValues.length === 0 && !detailQ.isLoading && (
            <div className="sect-note">
              That parameter declares no allowed values, so the default stays free text.
            </div>
          )}
        </div>
      )}
    </>
  );
}

export function SequenceEditor({
  draft, usedIn, projects, dirty, saving, onChange, onSave, onDiscard, onClose, onRun, onGoToView,
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

  /** How many steps would break if this input went away. */
  const referenceCount = (inputId: string) =>
    draft.steps.filter((s) =>
      s.branchInputId === inputId
      || (s.bindings ?? []).some((b) => (b.kind ? b.kind === "input" && b.ref === inputId : b.inputId === inputId)),
    ).length;

  /* Deleting an input is the destructive edit §7 cares about: every step bound to it breaks. The
     confirmation is inline rather than a window.confirm — a native modal blocks the whole page,
     and this app has no other native dialogs to match. */
  const [confirmInput, setConfirmInput] = useState<string | null>(null);
  const removeInput = (i: number) => {
    const input = draft.inputs[i];
    if (referenceCount(input.id) > 0 && confirmInput !== input.id) { setConfirmInput(input.id); return; }
    setConfirmInput(null);
    onChange({ ...draft, inputs: draft.inputs.filter((_, j) => j !== i) });
  };

  // ---- parameters + bindings (§6) ----
  const setParams = (i: number, params: Param[]) =>
    patchStep(i, applyParams(draft.steps[i], params));

  const addParam = (i: number) => {
    const params = paramsOf(draft.steps[i]);
    let name = "newParam";
    for (let n = 2; params.some((p) => p.name === name); n++) name = `newParam${n}`;
    setParams(i, [...params, { target: "parameter", name, src: { kind: "literal", ref: "" } }]);
  };

  /** Which chip's picker is open, and where to anchor it. */
  const [picker, setPicker] = useState<
    { step: number; param: number; x: number; top?: number; bottom?: number; maxHeight: number } | null
  >(null);
  /** Draft text for the picker's two inline fields, seeded from the parameter it opened on. */
  const [literal, setLiteral] = useState("");
  const [rename, setRename] = useState("");

  const openPicker = (e: React.MouseEvent, step: number, param: number) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const p = paramsOf(draft.steps[step])[param];
    setLiteral(p?.src.kind === "literal" ? p.src.ref : "");
    setRename(p?.name ?? "");
    // The menu is tall and a step's parameters sit near the panel footer, so anchoring it
    // strictly below put it off the bottom of the window with no way to reach the lower half.
    const { top, bottom, maxHeight } = placePopup(r, 340);
    setPicker({ step, param, x: r.right - 264, top, bottom, maxHeight });
  };
  const setSrc = (src: Src) => {
    if (!picker) return;
    const params = paramsOf(draft.steps[picker.step]);
    setParams(picker.step, params.map((p, j) => (j === picker.param ? { ...p, src } : p)));
    setPicker(null);
  };
  const renameParam = (name: string) => {
    if (!picker || !name.trim()) return;
    const params = paramsOf(draft.steps[picker.step]);
    setParams(picker.step, params.map((p, j) => (j === picker.param ? { ...p, name: name.trim() } : p)));
  };
  const setTarget = (target: "parameter" | "variable") => {
    if (!picker) return;
    const params = paramsOf(draft.steps[picker.step]);
    setParams(picker.step, params.map((p, j) => (j === picker.param ? { ...p, target } : p)));
    setPicker(null);
  };

  /* A new step opens expanded — it has nothing configured, so collapsing it would hide the
     pickers you need. Every other step stays as you left it. */
  const addStep = () => {
    const id = crypto.randomUUID();
    setOpen((s) => new Set(s).add(id));
    onChange({
      ...draft,
      steps: [...draft.steps, {
        id, project: "", pipelineId: 0, name: "", alias: "", branch: "", branchInputId: "",
        templateParameters: {}, variables: {}, bindings: [], link: { mode: "none", key: "" },
      }],
    });
  };

  /* Removing a step shifts every later index, so the same remap the reorder path uses applies
     here: bindings follow the step they meant, and one that would now point at a later step
     reads as broken rather than being quietly redirected. */
  const removeStep = (i: number) => {
    const order = draft.steps.map((_, j) => j).filter((j) => j !== i);
    onChange({ ...draft, steps: remapAfterReorder(draft.steps, order) });
  };

  // ---- reorder (§10) ----
  const dragStep = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  /* Bindings are repointed at the step they always meant, so moving a step never silently
     changes what a parameter reads. A reference that now lands at or after its own step is left
     where it is and shows as broken, rather than being quietly redirected at a different step. */
  const moveStep = (from: number | null, to: number) => {
    if (from === null || from === to) return;
    const order = draft.steps.map((_, i) => i);
    order.splice(to, 0, ...order.splice(from, 1));
    onChange({ ...draft, steps: remapAfterReorder(draft.steps, order) });
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
                <Fragment key={input.id}>
                {/* Names the step count and the views, per §7, without a native dialog. */}
                {confirmInput === input.id && (
                  <div className="inrow-confirm">
                    <WarnIcon />
                    <span>
                      <b>{referenceCount(input.id)}</b> step{referenceCount(input.id) === 1 ? "" : "s"} reference{" "}
                      <b>{input.name}</b> and will break.
                      {usedIn.length > 0 && <> On: {usedIn.join(", ")}.</>}
                    </span>
                    <button className="minibtn is-bad" onClick={() => removeInput(i)}>Remove anyway</button>
                    <button className="minibtn" onClick={() => setConfirmInput(null)}>Keep</button>
                  </div>
                )}
                <InputRow
                  input={input}
                  index={i}
                  projects={projects}
                  onPatch={(patch) => patchInput(i, patch)}
                  onRemove={() => removeInput(i)}
                />
                </Fragment>
              ))}
            </>
          )}
        </div>

        <div className="sect">
          <div className="sect-h">
            <span className="t">Steps — run in order</span>
            <button className="minibtn" onClick={addStep}><PlusIcon />Add step</button>
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
            const params = paramsOf(step);
            const broken = params.some((p) => !resolve(p.src, draft, i).ok);
            return (
              <div
                className={`step ${isOpen ? "" : "shut"} ${broken ? "is-broken" : ""} ${dragOver === i ? "drop-here" : ""}`}
                key={step.id}
                onDragOver={(e) => { if (dragStep.current !== null) { e.preventDefault(); setDragOver(i); } }}
                onDragLeave={() => setDragOver((d) => (d === i ? null : d))}
                onDrop={(e) => { e.preventDefault(); moveStep(dragStep.current, i); dragStep.current = null; setDragOver(null); }}
              >
                <div className="step-h" onClick={() => toggle(step.id)}>
                  <span
                    className="grip"
                    title="Drag to reorder"
                    draggable
                    onClick={(e) => e.stopPropagation()}
                    onDragStart={(e) => { e.stopPropagation(); dragStep.current = i; e.dataTransfer.effectAllowed = "move"; }}
                    onDragEnd={() => { dragStep.current = null; setDragOver(null); }}
                  >⠿</span>
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
                  <button className="xbtn" title="Remove step" aria-label={`Remove step ${i + 1}`}
                    onClick={(e) => { e.stopPropagation(); removeStep(i); }}>✕</button>
                  <span className="chev"><ChevronIcon /></span>
                </div>

                {/* Live, not save-time (§6). Deleting an input breaks every step that referenced
                    it the instant you do it — that immediate feedback is the whole point of the
                    panel over the old form. */}
                {broken && (
                  <div className="warnrow">
                    <WarnIcon />
                    A parameter points at something that no longer exists.
                  </div>
                )}

                <div className="step-b">
                  <StepConfig
                    step={step}
                    prev={i > 0 ? draft.steps[i - 1] : null}
                    inputs={draft.inputs}
                    projects={projects}
                    onChange={(patch) => patchStep(i, patch)}
                  />

                  {params.map((p, pi) => {
                    const r = resolve(p.src, draft, i);
                    return (
                      <div className="prow" key={`${p.target}:${p.name}`}>
                        <span className="pname" title={`${p.name} (${p.target})`}>{p.name}</span>
                        <span className="pactions">
                          <button
                            className={`bind ${r.cls}`}
                            title={r.ok ? r.label : `Unresolved: ${r.label}`}
                            onClick={(e) => openPicker(e, i, pi)}
                          >
                            <span className="kind" />
                            <span className="val">{r.label}</span>
                            <ChevronIcon />
                          </button>
                          <button className="xbtn" title="Remove parameter"
                            aria-label={`Remove parameter ${p.name}`}
                            onClick={() => setParams(i, params.filter((_, j) => j !== pi))}>✕</button>
                        </span>
                      </div>
                    );
                  })}

                  <div className="prow prow-add">
                    <button className="minibtn" onClick={() => addParam(i)}><PlusIcon />Add parameter</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* The picker only ever offers steps strictly earlier than this one. That is the entire
          cycle-prevention mechanism: a cycle is not expressible, so nothing has to validate for
          one afterwards. Do not "helpfully" list all steps here. */}
      {picker && (
        <>
          <div className="bmenu-scrim" onClick={() => setPicker(null)} />
          <div
            className="bmenu"
            style={{
              left: Math.max(8, picker.x),
              top: picker.top, bottom: picker.bottom, maxHeight: picker.maxHeight,
            }}
          >
            <div className="menu-lbl">Pre-run inputs</div>
            {draft.inputs.length === 0 ? (
              <div className="bmi is-none">none defined</div>
            ) : draft.inputs.map((inp) => (
              <button key={inp.id} className="bmi" onClick={() => setSrc({ kind: "input", ref: inp.id })}>
                <span className="kind" style={{ background: "var(--src-input)" }} />
                inputs.{inp.name}
              </button>
            ))}

            <div className="menu-lbl">Outputs from earlier steps</div>
            {picker.step === 0 ? (
              <div className="bmi is-none">this is the first step</div>
            ) : draft.steps.slice(0, picker.step).flatMap((st, si) =>
              STEP_OUTPUTS.map((out) => (
                <button
                  key={`${si}.${out}`}
                  className="bmi"
                  onClick={() => setSrc({ kind: "step", ref: `${si}.${out}` })}
                >
                  <span className="kind" style={{ background: "var(--src-step)" }} />
                  {(st.alias?.trim() || st.name || `step${si + 1}`)}.{out}
                </button>
              )))}

            {/* Typed in place rather than through window.prompt — a native dialog blocks the
                page and this app has none elsewhere. */}
            <div className="menu-lbl">Literal</div>
            <form
              className="bmi-form"
              onSubmit={(e) => { e.preventDefault(); setSrc({ kind: "literal", ref: literal }); }}
            >
              <span className="kind" style={{ background: "var(--src-literal)" }} />
              <input
                className="fld" value={literal} placeholder="type a value…" aria-label="Literal value"
                onChange={(e) => setLiteral(e.target.value)}
              />
              <button className="minibtn" type="submit">Use</button>
            </form>

            <div className="menu-lbl">This parameter</div>
            <form className="bmi-form" onSubmit={(e) => { e.preventDefault(); renameParam(rename); setPicker(null); }}>
              <input
                className="fld" value={rename} placeholder="name on the pipeline" aria-label="Parameter name"
                onChange={(e) => setRename(e.target.value)}
              />
              <button className="minibtn" type="submit">Rename</button>
            </form>
            <button className="bmi is-plain" onClick={() => setTarget("parameter")}>Send as template parameter</button>
            <button className="bmi is-plain" onClick={() => setTarget("variable")}>Send as variable</button>
          </div>
        </>
      )}

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
