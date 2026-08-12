// Mirrors the server DTOs (see src/server/Models/Dtos.cs).

export interface User {
  id: string;
  displayName: string;
  uniqueName: string;
  org: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string | null;
}

export interface Pipeline {
  id: number;
  name: string;
  project: string;
  folder?: string | null;
  repositoryName?: string | null;
  defaultBranch?: string | null;
  enabled: boolean;
}

export interface Branch {
  name: string;
  isDefault: boolean;
  mine: boolean;
  lastCommit?: string | null;
}

export interface PipelineParam {
  name: string;
  kind: "parameter" | "variable";
  type: "string" | "boolean" | "number" | "enum";
  defaultValue?: string | null;
  allowOverride: boolean;
  allowedValues?: string[] | null;
}

export interface PipelineResource {
  alias: string;
  source?: string | null;
  project?: string | null;
}

export interface PipelineDetail {
  pipeline: Pipeline;
  branches: Branch[];
  parameters: PipelineParam[];
  resources: PipelineResource[];
}

export type RunState = "notStarted" | "inProgress" | "completed" | string;
export type RunResult =
  | "succeeded"
  | "failed"
  | "canceled"
  | "partiallySucceeded"
  | null;

export interface Run {
  id: number;
  pipelineId: number;
  buildNumber?: string | null;
  state: RunState;
  result: RunResult;
  branch?: string | null;
  requestedFor?: string | null;
  queueTime?: string | null;
  startTime?: string | null;
  finishTime?: string | null;
  webUrl: string;
}

export interface LogEntry {
  id: number;
  name: string;
  state: string;
  result?: string | null;
  lineCount?: number | null;
  group?: string | null;
}

export interface LogContent {
  id: number;
  name: string;
  content: string;
}

export interface ViewItem {
  kind?: "pipeline" | "sequence"; // default "pipeline" (legacy items)
  project: string; // pipeline only
  pipelineId: number; // pipeline only
  sequenceId?: string | null; // sequence only
  name: string;
  shelf?: string | null;
  showLabel?: boolean | null; // per-card "Show project label" opt-in (§2.3)
}

// ----- pull requests (code review) -----
export interface Repo {
  id: string;
  name: string;
  defaultBranch?: string | null;
}

export interface PullRequest {
  id: number;
  title: string;
  author?: string | null;
  sourceRef?: string | null;
  targetRef?: string | null;
  status?: string | null;
  isDraft: boolean;
  createdAt?: string | null;
  sourceCommit?: string | null;
  targetCommit?: string | null;
  /** ADO's own merge state; "conflicts" is the one worth flagging in the list. */
  mergeStatus?: string | null;
  /** 10 approved · 5 with suggestions · 0 none · -5 waiting for author · -10 rejected. */
  myVote: number;
}

export interface RepoFavourite {
  id: string;
  project: string;
  repoId: string;
  repoName: string;
}

export interface PrChange {
  path: string;
  changeType: string;
  originalPath?: string | null;
}

export interface PrFileDiff {
  path: string;
  before?: string | null;
  after?: string | null;
}

export interface PrComment {
  id: number;
  parentId: number;
  author?: string | null;
  content: string;
  publishedAt?: string | null;
  commentType?: string | null;
  isDeleted: boolean;
}

/** filePath/rightLine are null for ADO's own system threads ("X voted…"). */
export interface PrThread {
  id: number;
  status?: string | null;
  filePath?: string | null;
  rightLine?: number | null;
  leftLine?: number | null;
  isDeleted: boolean;
  comments: PrComment[];
}

// ----- sequences -----
export type LinkMode = "none" | "resource" | "container" | "parameter" | "variable";

export interface StepLink {
  mode: LinkMode;
  key?: string | null;
  source?: string | null; // parameter/variable value: "runId" | "buildNumber" | "tag" | "branch"
}

export interface ParamBinding {
  target: "parameter" | "variable";
  name: string;
  inputId: string;
}

export interface SequenceInput {
  id: string;
  name: string;
  kind: "branch" | "value" | "environment";
  default?: string | null;
  sourceProject?: string | null;
  sourcePipelineId?: number | null;
  sourceParameter?: string | null;
}

export interface SequenceStep {
  id: string;
  project: string;
  pipelineId: number;
  name: string;
  alias?: string | null; // short label shown on the dashboard card (falls back to name)
  branch?: string | null;
  branchInputId?: string | null;
  templateParameters?: Record<string, string> | null;
  variables?: Record<string, string> | null;
  bindings?: ParamBinding[] | null;
  link?: StepLink | null;
}

export interface Sequence {
  id: string;
  name: string;
  inputs: SequenceInput[];
  steps: SequenceStep[];
}

export interface SequenceRunStep {
  index: number;
  project: string;
  pipelineId: number;
  name: string;
  buildId?: number | null;
  state: "pending" | "running" | "completed" | "skipped" | string;
  result?: string | null;
  webUrl?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  message?: string | null;
}

export interface SequenceRun {
  id: string;
  sequenceId: string;
  status: "running" | "succeeded" | "failed" | "canceled" | string;
  steps: SequenceRunStep[];
  startedAt: string;
  finishedAt?: string | null;
}

// A shelf's position/size on the dashboard grid, in grid cells (Grafana-style).
export interface GridPos {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SavedView {
  id: string;
  name: string;
  sortOrder: number;
  shelves: string[];
  shelfColors?: Record<string, string>; // per-shelf colour family (e.g. "red"); absent = none
  shelfLayout?: Record<string, GridPos>; // per-shelf grid placement; absent = auto-placed
  items: ViewItem[];
}

export interface RunRequest {
  branch: string;
  templateParameters?: Record<string, string>;
  variables?: Record<string, string>;
  pipelineResources?: Record<string, string>;
}

// ----- configurations (Azure App Configuration) -----
export interface ConfigRegistry {
  id: string;
  name: string;
  endpoint: string;
}

export interface ConfigSetting {
  key: string;
  value?: string | null;
  label?: string | null;
  contentType?: string | null;
  lastModified?: string | null;
}

export interface VaultRegistry {
  id: string;
  name: string;
  endpoint: string;
}

export interface AzureCredential {
  configured: boolean;
  tenantId?: string | null;
  clientId?: string | null;
}

export interface VaultSecretValue {
  name: string;
  value?: string | null;
}
