import type {
  Branch,
  LogContent,
  LogEntry,
  Pipeline,
  PipelineDetail,
  Project,
  Run,
  RunRequest,
  SavedView,
  User,
  ViewItem,
} from "../types";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "same-origin",
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const message = body?.error ?? res.statusText ?? "Request failed";
    throw new ApiError(res.status, message);
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
  createView: (name: string, sortOrder: number, items: ViewItem[]) =>
    req<SavedView>("/api/views", {
      method: "POST",
      body: JSON.stringify({ name, sortOrder, items }),
    }),
  updateView: (id: string, name: string, sortOrder: number, items: ViewItem[]) =>
    req<SavedView>(`/api/views/${id}`, {
      method: "PUT",
      body: JSON.stringify({ name, sortOrder, items }),
    }),
  deleteView: (id: string) =>
    req<void>(`/api/views/${id}`, { method: "DELETE" }),
};
