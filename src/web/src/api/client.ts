import type {
  AgentThread,
  Connector,
  ConnectorProvider,
  ProbeResult,
  AzureCredential,
  Branch,
  ConfigRegistry,
  ConfigSettings,
  VaultRegistry,
  VaultSecretValue,
  LogContent,
  LogEntry,
  Pipeline,
  PipelineDetail,
  Project,
  PrChange,
  PrComment,
  PrFileDiff,
  PrThread,
  PullRequest,
  Repo,
  RepoFavourite,
  Run,
  RunRequest,
  GridPos,
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

const prUrl = (project: string, repoId: string, prId: number) =>
  `/api/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repoId)}/pullrequests/${prId}`;

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

  // pull requests
  repos: (project: string) =>
    req<Repo[]>(`/api/projects/${encodeURIComponent(project)}/repos`),
  pullRequests: (project: string, repoId: string, status = "active", top = 30) =>
    req<PullRequest[]>(
      `/api/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repoId)}/pullrequests?status=${status}&top=${top}`,
    ),
  prChanges: (project: string, repoId: string, prId: number) =>
    req<PrChange[]>(
      `/api/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repoId)}/pullrequests/${prId}/changes`,
    ),
  prFileDiff: (project: string, repoId: string, path: string, beforeCommit: string, afterCommit: string) =>
    req<PrFileDiff>(
      `/api/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repoId)}/filediff` +
        `?path=${encodeURIComponent(path)}&beforeCommit=${encodeURIComponent(beforeCommit)}&afterCommit=${encodeURIComponent(afterCommit)}`,
    ),

  // PR comment threads (writes need a PAT with Code: Read & Write)
  prThreads: (project: string, repoId: string, prId: number) =>
    req<PrThread[]>(`${prUrl(project, repoId, prId)}/threads`),
  prCreateThread: (project: string, repoId: string, prId: number,
                   body: { filePath: string; line: number; content: string; onLeft: boolean }) =>
    req<PrThread>(`${prUrl(project, repoId, prId)}/threads`, { method: "POST", body: JSON.stringify(body) }),
  prReply: (project: string, repoId: string, prId: number, threadId: number, content: string) =>
    req<PrComment>(`${prUrl(project, repoId, prId)}/threads/${threadId}/comments`,
      { method: "POST", body: JSON.stringify({ content }) }),
  prSetThreadStatus: (project: string, repoId: string, prId: number, threadId: number, status: string) =>
    req<PrThread>(`${prUrl(project, repoId, prId)}/threads/${threadId}`,
      { method: "PATCH", body: JSON.stringify({ status }) }),

  prVote: (project: string, repoId: string, prId: number, vote: number) =>
    req<{ vote: number }>(`${prUrl(project, repoId, prId)}/vote`,
      { method: "PUT", body: JSON.stringify({ vote }) }),

  // starred project+repo combos
  repoFavourites: () => req<RepoFavourite[]>("/api/repo-favourites"),
  addRepoFavourite: (project: string, repoId: string, repoName: string) =>
    req<RepoFavourite>("/api/repo-favourites", {
      method: "POST",
      body: JSON.stringify({ project, repoId, repoName }),
    }),
  removeRepoFavourite: (id: string) =>
    req<void>(`/api/repo-favourites/${id}`, { method: "DELETE" }),

  // views
  views: () => req<SavedView[]>("/api/views"),
  createView: (name: string, sortOrder: number, shelves: string[], shelfColors: Record<string, string>, shelfLayout: Record<string, GridPos>, items: ViewItem[]) =>
    req<SavedView>("/api/views", {
      method: "POST",
      body: JSON.stringify({ name, sortOrder, shelves, shelfColors, shelfLayout, items }),
    }),
  updateView: (id: string, name: string, sortOrder: number, shelves: string[], shelfColors: Record<string, string>, shelfLayout: Record<string, GridPos>, items: ViewItem[]) =>
    req<SavedView>(`/api/views/${id}`, {
      method: "PUT",
      body: JSON.stringify({ name, sortOrder, shelves, shelfColors, shelfLayout, items }),
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
    req<ConfigSettings>(`/api/config-registries/${id}/settings`),

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

  // Azure service principal (Key Vault + endpoint-URL App Config)
  azureCredential: () => req<AzureCredential>("/api/azure-credential"),
  setAzureCredential: (tenantId: string, clientId: string, clientSecret: string) =>
    req<AzureCredential>("/api/azure-credential", {
      method: "PUT",
      body: JSON.stringify({ tenantId, clientId, clientSecret }),
    }),
  clearAzureCredential: () => req<void>("/api/azure-credential", { method: "DELETE" }),

  // ----- connectors (DESIGN_SPEC_CONNECTORS.md §2.1) -----
  connectorProviders: () => req<ConnectorProvider[]>("/api/connector-providers"),
  connectors: () => req<Connector[]>("/api/connectors"),

  /** The credential is sent once, in a body, and is never returned by anything (§3.3). */
  addConnector: (body: {
    provider: string; name?: string; baseUrl?: string; model?: string;
    token?: string; capabilities?: string[];
  }) => req<Connector>("/api/connectors", { method: "POST", body: JSON.stringify(body) }),

  /** Omit a field to leave it alone — omitting `token` keeps the stored credential. */
  patchConnector: (id: string, body: {
    name?: string; baseUrl?: string; model?: string; token?: string; capabilities?: string[];
  }) => req<Connector>(`/api/connectors/${id}`, { method: "PATCH", body: JSON.stringify(body) }),

  deleteConnector: (id: string) => req<void>(`/api/connectors/${id}`, { method: "DELETE" }),

  /** Pre-save test — the only way "Save is disabled until green" can hold for a new connector. */
  testConnector: (body: { provider: string; baseUrl?: string; token: string }) =>
    req<ProbeResult>("/api/connectors/test", { method: "POST", body: JSON.stringify(body) }),

  testSavedConnector: (id: string) =>
    req<ProbeResult>(`/api/connectors/${id}/test`, { method: "POST" }),

  // ----- agent conversations -----
  agentThread: (project: string, repoId: string, prId: number) =>
    req<AgentThread>(`/api/review/${encodeURIComponent(project)}/${encodeURIComponent(repoId)}`
      + `/pulls/${prId}/thread`),
};
