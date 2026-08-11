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

export interface PipelineDetail {
  pipeline: Pipeline;
  branches: Branch[];
  parameters: PipelineParam[];
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
}

// ----- sequences -----
export type LinkMode = "none" | "resource" | "parameter" | "variable";

export interface StepLink {
  mode: LinkMode;
  key?: string | null;
}

export interface SequenceStep {
  project: string;
  pipelineId: number;
  name: string;
  branch?: string | null;
  templateParameters?: Record<string, string> | null;
  variables?: Record<string, string> | null;
  link?: StepLink | null;
}

export interface Sequence {
  id: string;
  name: string;
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

export interface SavedView {
  id: string;
  name: string;
  sortOrder: number;
  shelves: string[];
  items: ViewItem[];
}

export interface RunRequest {
  branch: string;
  templateParameters?: Record<string, string>;
  variables?: Record<string, string>;
}
