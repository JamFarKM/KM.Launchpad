import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import type { PipelineDetail, RunRequest, ViewItem } from "../types";

interface Props {
  item: ViewItem;
  onClose: () => void;
  onLaunched: (project: string, buildId: number) => void;
}

interface Kv {
  key: string;
  value: string;
}

export function RunDialog({ item, onClose, onLaunched }: Props) {
  const detailQ = useQuery<PipelineDetail>({
    queryKey: ["detail", item.project, item.pipelineId],
    queryFn: () => api.pipelineDetail(item.project, item.pipelineId),
  });

  const [branch, setBranch] = useState<string>("");
  const [vars, setVars] = useState<Record<string, string>>({});
  const [params, setParams] = useState<Kv[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detail = detailQ.data;

  // Initialise branch + overridable variables once the detail arrives.
  const initialBranch = useMemo(() => {
    if (!detail) return "";
    return detail.branches.find((b) => b.isDefault)?.name ?? detail.branches[0]?.name ?? "";
  }, [detail]);

  const effectiveBranch = branch || initialBranch;
  const overridable = detail?.parameters.filter((p) => p.allowOverride) ?? [];

  async function launch() {
    if (!effectiveBranch) {
      setError("Pick a branch to run against.");
      return;
    }
    setBusy(true);
    setError(null);
    const body: RunRequest = { branch: effectiveBranch };
    const varEntries = Object.entries(vars).filter(([, v]) => v !== "");
    if (varEntries.length) body.variables = Object.fromEntries(varEntries);
    const paramEntries = params.filter((p) => p.key.trim() !== "");
    if (paramEntries.length)
      body.templateParameters = Object.fromEntries(paramEntries.map((p) => [p.key.trim(), p.value]));

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
                <select
                  className="select"
                  value={effectiveBranch}
                  onChange={(e) => setBranch(e.target.value)}
                >
                  {detail.branches.length === 0 && <option value="">(no branches found)</option>}
                  {detail.branches.map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.name}
                      {b.isDefault ? "  (default)" : ""}
                    </option>
                  ))}
                </select>
              </div>

              {overridable.length > 0 && (
                <div className="field">
                  <label className="label">Variables (overridable)</label>
                  {overridable.map((p) => (
                    <div className="field" key={p.name} style={{ marginBottom: 8 }}>
                      <label className="label" style={{ color: "var(--text)" }}>{p.name}</label>
                      <input
                        className="input"
                        defaultValue={p.defaultValue ?? ""}
                        placeholder={p.defaultValue ?? ""}
                        onChange={(e) => setVars((v) => ({ ...v, [p.name]: e.target.value }))}
                      />
                    </div>
                  ))}
                </div>
              )}

              <div className="field">
                <label className="label">
                  Template parameters{" "}
                  <span className="faint">(optional — for YAML pipeline parameters)</span>
                </label>
                {params.map((kv, i) => (
                  <div className="row" key={i} style={{ marginBottom: 6 }}>
                    <input
                      className="input"
                      placeholder="name"
                      value={kv.key}
                      onChange={(e) =>
                        setParams((ps) => ps.map((p, j) => (j === i ? { ...p, key: e.target.value } : p)))
                      }
                    />
                    <input
                      className="input"
                      placeholder="value"
                      value={kv.value}
                      onChange={(e) =>
                        setParams((ps) => ps.map((p, j) => (j === i ? { ...p, value: e.target.value } : p)))
                      }
                    />
                    <button
                      className="btn ghost small"
                      onClick={() => setParams((ps) => ps.filter((_, j) => j !== i))}
                    >✕</button>
                  </div>
                ))}
                <button
                  className="btn small"
                  onClick={() => setParams((ps) => [...ps, { key: "", value: "" }])}
                >
                  + Add parameter
                </button>
              </div>
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
