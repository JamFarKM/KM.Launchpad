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
  project: string;
  pipelineId: number;
  name: string;
  shelf?: string | null;
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
