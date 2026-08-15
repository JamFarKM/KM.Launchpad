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
  /** The job the step ran in. */
  group?: string | null;
  /** The stage that job ran in, when the pipeline has stages. */
  stage?: string | null;
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

/** What an earlier step supplies. Run properties, not named pipeline outputs — ADO exposes no
 *  queryable output contract, so there is nothing else that could be resolved. */
export const STEP_OUTPUTS = ["runId", "buildNumber", "tag", "branch"] as const;
export type StepOutput = (typeof STEP_OUTPUTS)[number];

export type BindingKind = "input" | "step" | "literal";

/**
 * One source per step parameter (SEQUENCES §6). `kind` is absent on bindings written before that
 * change, which are input bindings by definition — `inputId` is the source there.
 *
 * Step references are stored by **index**, as `"<stepIndex>.<output>"`, never by display name, so
 * renaming a step cannot break a binding that points at it.
 */
export interface ParamBinding {
  target: "parameter" | "variable";
  name: string;
  inputId?: string | null;
  kind?: BindingKind | null;
  ref?: string | null;
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

export interface ConfigSettings {
  settings: ConfigSetting[];
  /** The read hit its backstop, so keys past this point in key order are missing. */
  truncated: boolean;
  limit: number;
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

// ----- connectors (DESIGN_SPEC_CONNECTORS.md §2.1) -----

/** Note there is no credential field of any shape: the server never returns one. */
export interface Connector {
  id: string;
  provider: string;
  name: string;
  baseUrl?: string | null;
  model?: string | null;
  authType: string;
  /** The only part of a credential the UI is ever shown. */
  tokenLast4?: string | null;
  tokenSetAt?: string | null;
  oauthLogin?: string | null;
  oauthScope?: string | null;
  /** connected | unreachable | not_tested | connecting — each gets its own shape, per A4. */
  status: string;
  lastOkAt?: string | null;
  lastErrorCode?: string | null;
  lastErrorAt?: string | null;
  capabilities: string[];
}

export interface ConnectorProvider {
  key: string;
  displayName: string;
  auth: string;
  fixedBaseUrl?: string | null;
  credentialLabel: string;
  urlEditable: boolean;
}

/** The result of a connection test — one of §4's codes, never free text. */
export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  models: string[];
  errorCode?: string | null;
  httpStatus?: number | null;
  detail?: string | null;
  retryAfterSeconds?: number | null;
}

// ----- agent conversations (§7.5) -----

export interface AgentCitation {
  path: string;
  line: number;
  endLine?: number | null;
}

/**
 * One claim, with its own badge and its own citations (§5.2).
 *
 * `provenance` is null only when the agent asserted nothing for this claim — the badge then reads
 * UNVERIFIED SOURCE. It is never derived from whether citations happen to be present.
 */
export interface AgentSegment {
  text: string;
  /** code | doc | inferred, or null when the agent asserted nothing for this claim. */
  provenance?: string | null;
  /**
   * info | warning | error — how much this should worry the reviewer.
   *
   * A separate axis from `provenance`, and neither implies the other: a claim grounded in the diff
   * can be harmless, and a hypothesis can be the most important thing on the page. Optional on the
   * type because a turn recorded before severity existed has none, and those read as `info`.
   */
  severity?: string | null;
  citations: AgentCitation[];
  inferenceNote?: string | null;
}

export interface AgentTurn {
  id: string;
  ordinal: number;
  question: string;
  /**
   * The segments' prose, joined. For "Copy all" only — rendering is per segment, or the badge and
   * the citations go back to being pooled under a whole answer.
   */
  answer: string;
  segments: AgentSegment[];
  /** structured | fencedjson | unverified. */
  mode: string;
  /** Recorded on the turn, so attribution survives the connector's removal. */
  connectorName?: string | null;
  model?: string | null;
  commitSha?: string | null;
  stopped: boolean;
  errorCode?: string | null;
  /** The sentence behind the code — `upstream` alone says nothing and offers no next step. */
  errorDetail?: string | null;
  /** Whether "Post as comment…" appears at all (§7.4). */
  postable: boolean;
  createdAt: string;
}

/** One changed file cited as a group's evidence (DESIGN_SPEC_CHANGE_MAP.md §2). */
export interface ChangeMapFile {
  path: string;
  added: number;
  removed: number;
}

/**
 * One area of the change. `depth` is 0 at the innermost layer and increases outward — arithmetic
 * the sheet uses to draw the dependency-rule overlay (§5), not a display order.
 */
export interface ChangeMapGroup {
  id: string;
  name: string;
  depth: number;
  summary: string;
  files: ChangeMapFile[];
  /** Review findings (warning/error segments) citing a file in this group, on the map's own commit. */
  findingCount: number;
}

/** `from` depends on / calls `to` — the direction of the dependency, not of the diagram. */
export interface ChangeMapEdge {
  from: string;
  to: string;
  label: string;
}

export interface ChangeMapFlowStep {
  step: number;
  group: string;
  /** Short phrase — the diagram's label for this step. */
  action: string;
  /** The wizard's narration: what happens here, what changed, and how it serves the PR's intention. */
  detail: string;
}

/** A name for one depth on the outer-to-core axis, in the repository's own vocabulary. */
export interface ChangeMapLayer {
  depth: number;
  name: string;
}

/**
 * The whole map (§2). `style` is clean | layers | modules | pipeline | unknown; `styleBasis` is
 * structure | inferred — the same badge vocabulary as a segment's provenance, since a reviewer who
 * has learned one has learned both.
 */
export interface ChangeMap {
  style: string;
  styleBasis: string;
  groups: ChangeMapGroup[];
  edges: ChangeMapEdge[];
  flow: ChangeMapFlowStep[];
  /** Empty on maps stored before layer names existed — the sheet falls back to axis extremes. */
  layers: ChangeMapLayer[];
  commitSha?: string | null;
}

export interface AgentThread {
  id?: string | null;
  turns: AgentTurn[];
  map?: ChangeMap | null;
}

/**
 * A citation the reviewer left on the diff, plus whatever they went on to ask about it (§7.6).
 *
 * Private to the reviewer: never written to Azure DevOps, never shown to anyone else looking at the
 * same pull request, unless they promote one through `Post as comment…`.
 */
export interface Annotation {
  id: string;
  path: string;
  line: number;
  endLine?: number | null;
  /** The commit the citation was made against — drives the "based on an earlier commit" note. */
  commitSha?: string | null;
  /** The claim that opened it: the card's first turn, in the agent's own words. */
  seed?: string | null;
  /** open | resolved. Resolving dims the marker and drops it from the cycle; it never deletes. */
  status: string;
  turns: AgentTurn[];
  createdAt: string;
  updatedAt: string;
}
