import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import type { PipelineDetail, PipelineParam, PipelineResource, Run, RunRequest, ViewItem } from "../types";
import { Combobox } from "./Combobox";
import { timeAgo } from "../lib/format";

interface Props {
  item: ViewItem;
  onClose: () => void;
  onLaunched: (project: string, buildId: number) => void;
}

interface Kv {
  key: string;
  value: string;
}

const paramKey = (p: PipelineParam) => `${p.kind}:${p.name}`;

export function RunDialog({ item, onClose, onLaunched }: Props) {
  const detailQ = useQuery<PipelineDetail>({
    queryKey: ["detail", item.project, item.pipelineId],
    queryFn: () => api.pipelineDetail(item.project, item.pipelineId),
  });

  const [branch, setBranch] = useState<string>("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [resourceVersions, setResourceVersions] = useState<Record<string, string>>({});
  const [extra, setExtra] = useState<Kv[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detail = detailQ.data;

  const initialBranch = useMemo(() => {
    if (!detail) return "";
    // Prefer the branch the user most recently worked on (branches are returned
    // yours-first, most-recent-first), then the pipeline default, then anything.
    return (
      detail.branches.find((b) => b.mine)?.name ??
      detail.branches.find((b) => b.isDefault)?.name ??
      detail.branches[0]?.name ??
      ""
    );
  }, [detail]);

  const effectiveBranch = branch || initialBranch;
  const autoPickedYours = !branch && !!detail?.branches.find((b) => b.mine && b.name === effectiveBranch);

  const templateParams = detail?.parameters.filter((p) => p.kind === "parameter") ?? [];
  const variableParams = detail?.parameters.filter((p) => p.kind === "variable" && p.allowOverride) ?? [];

  function valueOf(p: PipelineParam): string {
    const k = paramKey(p);
    if (k in values) return values[k];
    return p.defaultValue ?? (p.type === "boolean" ? "false" : "");
  }
  function setValue(p: PipelineParam, v: string) {
    setValues((prev) => ({ ...prev, [paramKey(p)]: v }));
  }

  async function launch() {
    if (!effectiveBranch) {
      setError("Pick a branch to run against.");
      return;
    }
    setBusy(true);
    setError(null);

    const body: RunRequest = { branch: effectiveBranch };

    const tp: Record<string, string> = {};
    for (const p of templateParams) {
      const v = valueOf(p);
      if (v !== "") tp[p.name] = v;
    }
    for (const kv of extra) if (kv.key.trim() !== "") tp[kv.key.trim()] = kv.value;
    if (Object.keys(tp).length) body.templateParameters = tp;

    const vars: Record<string, string> = {};
    for (const p of variableParams) {
      const k = paramKey(p);
      if (k in values && values[k] !== "") vars[p.name] = values[k];
    }
    if (Object.keys(vars).length) body.variables = vars;

    const resources: Record<string, string> = {};
    for (const [alias, ver] of Object.entries(resourceVersions)) if (ver) resources[alias] = ver;
    if (Object.keys(resources).length) body.pipelineResources = resources;

    try {
      const run = await api.run(item.project, item.pipelineId, body);
      onLaunched(item.project, run.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to trigger the pipeline.");
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <div className="title">Run · {item.name}</div>
          <button className="btn ghost small" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {detailQ.isLoading && (
            <div className="center-note"><span className="spin" /> Loading pipeline…</div>
          )}
          {detailQ.error && (
            <div className="error">
              {detailQ.error instanceof ApiError ? detailQ.error.message : "Could not load pipeline."}
            </div>
          )}

          {detail && (
            <>
              {error && <div className="error" style={{ marginBottom: 14 }}>{error}</div>}

              <div className="field">
                <label className="label">Branch</label>
                <select className="select" value={effectiveBranch} onChange={(e) => setBranch(e.target.value)}>
                  {detail.branches.length === 0 && <option value="">(no branches found)</option>}
                  {detail.branches.map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.name}
                      {b.mine ? "  — yours" : ""}
                      {b.isDefault ? "  (default)" : ""}
                    </option>
                  ))}
                </select>
                {autoPickedYours && (
                  <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>
                    Defaulted to your most recently updated branch.
                  </div>
                )}
              </div>

              {templateParams.length > 0 && (
                <div className="field">
                  <label className="label">Parameters</label>
                  {templateParams.map((p) => (
                    <ParamInput key={paramKey(p)} p={p} value={valueOf(p)} onChange={(v) => setValue(p, v)} />
                  ))}
                </div>
              )}

              {variableParams.length > 0 && (
                <div className="field">
                  <label className="label">Variables (overridable)</label>
                  {variableParams.map((p) => (
                    <ParamInput key={paramKey(p)} p={p} value={valueOf(p)} onChange={(v) => setValue(p, v)} />
                  ))}
                </div>
              )}

              {detail.resources.length > 0 && (
                <div className="field">
                  <label className="label">
                    Pipeline resources <span className="faint">(which upstream artifact to use)</span>
                  </label>
                  {detail.resources.map((r) => (
                    <ResourcePicker
                      key={r.alias}
                      resource={r}
                      fallbackProject={item.project}
                      value={resourceVersions[r.alias] ?? ""}
                      onChange={(v) => setResourceVersions((s) => ({ ...s, [r.alias]: v }))}
                    />
                  ))}
                </div>
              )}

              <details className="field">
                <summary className="label" style={{ cursor: "pointer" }}>
                  Advanced — extra template parameters
                </summary>
                <div style={{ marginTop: 8 }}>
                  {extra.map((kv, i) => (
                    <div className="row" key={i} style={{ marginBottom: 6 }}>
                      <input className="input" placeholder="name" value={kv.key}
                        onChange={(e) => setExtra((ps) => ps.map((p, j) => (j === i ? { ...p, key: e.target.value } : p)))} />
                      <input className="input" placeholder="value" value={kv.value}
                        onChange={(e) => setExtra((ps) => ps.map((p, j) => (j === i ? { ...p, value: e.target.value } : p)))} />
                      <button className="btn ghost small" onClick={() => setExtra((ps) => ps.filter((_, j) => j !== i))}>✕</button>
                    </div>
                  ))}
                  <button className="btn small" onClick={() => setExtra((ps) => [...ps, { key: "", value: "" }])}>
                    + Add parameter
                  </button>
                </div>
              </details>
            </>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={launch} disabled={busy || !detail}>
            {busy ? <><span className="spin" /> Triggering…</> : "▶ Run pipeline"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ResourcePicker({ resource, fallbackProject, value, onChange }: {
  resource: PipelineResource;
  fallbackProject: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const source = resource.source ?? "";
  const project = resource.project || fallbackProject;
  const runsQ = useQuery<Run[]>({
    queryKey: ["resourceRuns", project, source],
    queryFn: () => api.resourceRuns(project, source, 15),
    enabled: !!source,
  });

  const options = [
    { value: "", label: "latest (default)" },
    ...(runsQ.data ?? []).map((r) => ({
      value: r.buildNumber ?? String(r.id),
      label: r.buildNumber ?? String(r.id),
      hint: `${r.branch ?? ""} · ${r.result ?? r.state} · ${timeAgo(r.finishTime ?? r.startTime ?? r.queueTime)}`,
    })),
  ];

  return (
    <div className="field" style={{ marginBottom: 10 }}>
      <label className="label" style={{ color: "var(--text)" }}>
        {resource.alias} {source && <span className="faint">· {source}</span>}
      </label>
      {source ? (
        <Combobox value={value} options={options} loading={runsQ.isLoading} onChange={onChange} />
      ) : (
        <div className="faint" style={{ fontSize: 12 }}>No source pipeline declared in YAML — ADO will use its default.</div>
      )}
    </div>
  );
}

function ParamInput({ p, value, onChange }: { p: PipelineParam; value: string; onChange: (v: string) => void }) {
  return (
    <div className="field" style={{ marginBottom: 10 }}>
      <label className="label" style={{ color: "var(--text)" }}>
        {p.name} <span className="faint">· {p.type}</span>
      </label>
      {p.type === "enum" && p.allowedValues ? (
        <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
          {p.allowedValues.map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
      ) : p.type === "boolean" ? (
        <select className="select" value={value || "false"} onChange={(e) => onChange(e.target.value)}>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : (
        <input
          className="input"
          type={p.type === "number" ? "number" : "text"}
          value={value}
          placeholder={p.defaultValue ?? ""}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}
