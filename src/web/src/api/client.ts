import type {
  Branch,
  ConfigRegistry,
  ConfigSetting,
  VaultRegistry,
  VaultSecretValue,
  LogContent,
  LogEntry,
  Pipeline,
  PipelineDetail,
  Project,
  Run,
  RunRequest,
  SavedView,
  Sequence,
  SequenceInput,
  SequenceRun,
  SequenceStep,
  User,
  ViewItem,
} from "../types";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      credentials: "same-origin",
    });
  } catch {
    // fetch only rejects on network-level failures (server down, DNS, refused).
    throw new ApiError(0, "Can't reach the server. Is the backend running?");
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let body: any;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON — surface the raw response so the real cause is visible.
      throw new ApiError(res.status, text.slice(0, 300) || res.statusText);
    }
  }
  if (!res.ok) {
    // A 401 on any endpoint other than the auth probes means the session lapsed;
    // signal the app to send the user back to the connect screen.
    if (res.status === 401 && !path.startsWith("/api/auth/")) {
      window.dispatchEvent(new Event("pl-unauthorized"));
    }
    throw new ApiError(res.status, body?.error ?? res.statusText ?? "Request failed");
  }
  return body as T;
}

export const api = {
  // config + auth
  config: () => req<{ defaultOrg: string }>("/api/config"),
  me: () => req<User>("/api/auth/me"),
  connect: (pat: string, org?: string) =>
    req<User>("/api/auth/connect", {
      method: "POST",
      body: JSON.stringify({ pat, org }),
    }),
  disconnect: () => req<void>("/api/auth/disconnect", { method: "POST" }),

  // discovery
  projects: () => req<Project[]>("/api/projects"),
  pipelines: (project: string) =>
    req<Pipeline[]>(`/api/projects/${encodeURIComponent(project)}/pipelines`),
  pipelineDetail: (project: string, id: number) =>
    req<PipelineDetail>(
      `/api/projects/${encodeURIComponent(project)}/pipelines/${id}`,
    ),
  branches: (project: string, id: number) =>
    req<Branch[]>(
      `/api/projects/${encodeURIComponent(project)}/pipelines/${id}`,
    ).then((d: unknown) => (d as PipelineDetail).branches),

  // runs
  run: (project: string, id: number, body: RunRequest) =>
    req<Run>(
      `/api/projects/${encodeURIComponent(project)}/pipelines/${id}/run`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  runs: (project: string, id: number, top = 15) =>
    req<Run[]>(
      `/api/projects/${encodeURIComponent(project)}/pipelines/${id}/runs?top=${top}`,
    ),
  resourceRuns: (project: string, name: string, top = 15) =>
    req<Run[]>(
      `/api/projects/${encodeURIComponent(project)}/resource-runs?name=${encodeURIComponent(name)}&top=${top}`,
    ),
  runDetail: (project: string, buildId: number) =>
    req<Run>(`/api/projects/${encodeURIComponent(project)}/runs/${buildId}`),
  runLogs: (project: string, buildId: number) =>
    req<LogEntry[]>(
      `/api/projects/${encodeURIComponent(project)}/runs/${buildId}/logs`,
    ),
  logContent: (project: string, buildId: number, logId: number) =>
    req<LogContent>(
      `/api/projects/${encodeURIComponent(project)}/runs/${buildId}/logs/${logId}`,
    ),

  // views
  views: () => req<SavedView[]>("/api/views"),
  createView: (name: string, sortOrder: number, shelves: string[], items: ViewItem[]) =>
    req<SavedView>("/api/views", {
      method: "POST",
      body: JSON.stringify({ name, sortOrder, shelves, items }),
    }),
  updateView: (id: string, name: string, sortOrder: number, shelves: string[], items: ViewItem[]) =>
    req<SavedView>(`/api/views/${id}`, {
      method: "PUT",
      body: JSON.stringify({ name, sortOrder, shelves, items }),
    }),
  deleteView: (id: string) =>
    req<void>(`/api/views/${id}`, { method: "DELETE" }),

  // sequences
  sequences: () => req<Sequence[]>("/api/sequences"),
  createSequence: (name: string, inputs: SequenceInput[], steps: SequenceStep[]) =>
    req<Sequence>("/api/sequences", { method: "POST", body: JSON.stringify({ name, inputs, steps }) }),
  updateSequence: (id: string, name: string, inputs: SequenceInput[], steps: SequenceStep[]) =>
    req<Sequence>(`/api/sequences/${id}`, { method: "PUT", body: JSON.stringify({ name, inputs, steps }) }),
  deleteSequence: (id: string) =>
    req<void>(`/api/sequences/${id}`, { method: "DELETE" }),
  runSequence: (id: string, inputs?: Record<string, string>) =>
    req<SequenceRun>(`/api/sequences/${id}/run`, { method: "POST", body: JSON.stringify({ inputs: inputs ?? {} }) }),
  sequenceRuns: (id: string, top = 1) =>
    req<SequenceRun[]>(`/api/sequences/${id}/runs?top=${top}`),
  sequenceRun: (runId: string) =>
    req<SequenceRun>(`/api/sequence-runs/${runId}`),
  cancelSequenceRun: (runId: string) =>
    req<void>(`/api/sequence-runs/${runId}/cancel`, { method: "POST" }),

  // config import / export
  importConfig: async (text: string, format: string) => {
    const res = await fetch(`/api/import?format=${encodeURIComponent(format)}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      credentials: "same-origin",
      body: text,
    });
    const raw = await res.text();
    const body = raw ? JSON.parse(raw) : undefined;
    if (!res.ok) throw new ApiError(res.status, body?.error ?? res.statusText);
    return body as { sequences: number; views: number };
  },
  exportConfig: async () => {
    const res = await fetch("/api/export", { credentials: "same-origin" });
    if (!res.ok) throw new ApiError(res.status, res.statusText);
    return res.text();
  },

  // Azure App Configuration registries
  configRegistries: () => req<ConfigRegistry[]>("/api/config-registries"),
  addConfigRegistry: (name: string, connection: string) =>
    req<ConfigRegistry>("/api/config-registries", {
      method: "POST",
      body: JSON.stringify({ name, connection }),
    }),
  deleteConfigRegistry: (id: string) =>
    req<void>(`/api/config-registries/${id}`, { method: "DELETE" }),
  configSettings: (id: string) =>
    req<ConfigSetting[]>(`/api/config-registries/${id}/settings`),

  // Azure Key Vault registries
  vaultRegistries: () => req<VaultRegistry[]>("/api/vault-registries"),
  addVaultRegistry: (name: string, vaultUri: string) =>
    req<VaultRegistry>("/api/vault-registries", {
      method: "POST",
      body: JSON.stringify({ name, vaultUri }),
    }),
  deleteVaultRegistry: (id: string) =>
    req<void>(`/api/vault-registries/${id}`, { method: "DELETE" }),
  vaultSecrets: (id: string) =>
    req<string[]>(`/api/vault-registries/${id}/secrets`),
  vaultSecret: (id: string, name: string) =>
    req<VaultSecretValue>(`/api/vault-registries/${id}/secrets/${encodeURIComponent(name)}`),
};
