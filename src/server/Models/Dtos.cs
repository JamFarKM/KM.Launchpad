namespace PipelineLaunchpad.Server.Models;

// ----- auth -----
public record ConnectRequest(string Pat, string? Org);
public record UserDto(string Id, string DisplayName, string UniqueName, string Org);

// ----- discovery -----
public record ProjectDto(string Id, string Name, string? Description);

public record PipelineDto(
    int Id,
    string Name,
    string Project,
    string? Folder,
    string? RepositoryName,
    string? DefaultBranch,
    bool Enabled);

public record BranchDto(string Name, bool IsDefault, bool Mine, DateTime? LastCommit);

public record PipelineParamDto(
    string Name,
    string Kind,              // "parameter" (YAML templateParameter) | "variable"
    string Type,              // "string" | "boolean" | "number" | "enum"
    string? DefaultValue,
    bool AllowOverride,
    IReadOnlyList<string>? AllowedValues);

/// <summary>A pipeline resource declared in a pipeline's YAML (an upstream artifact source).</summary>
public record PipelineResourceDto(string Alias, string? Source, string? Project);

public record PipelineDetailDto(
    PipelineDto Pipeline,
    IReadOnlyList<BranchDto> Branches,
    IReadOnlyList<PipelineParamDto> Parameters,
    IReadOnlyList<PipelineResourceDto> Resources);

// ----- runs -----
public record RunRequest(
    string Branch,
    Dictionary<string, string>? TemplateParameters,
    Dictionary<string, string>? Variables,
    Dictionary<string, string>? PipelineResources);

public record RunDto(
    int Id,
    int PipelineId,
    string? BuildNumber,
    string State,             // notStarted | inProgress | completed | ...
    string? Result,           // succeeded | failed | canceled | null
    string? Branch,
    string? RequestedFor,
    DateTime? QueueTime,
    DateTime? StartTime,
    DateTime? FinishTime,
    string WebUrl);

public record LogEntryDto(
    int Id, string Name, string State, string? Result, int? LineCount,
    string? Group,      // the Job the step ran in
    string? Stage);     // the Stage that job ran in, when the pipeline has stages
public record LogContentDto(int Id, string Name, string Content);

// ----- pull requests (code review) -----
public record RepoDto(string Id, string Name, string? DefaultBranch);

public record PullRequestDto(
    int Id,
    string Title,
    string? Author,
    string? SourceRef,
    string? TargetRef,
    string? Status,
    bool IsDraft,
    DateTime? CreatedAt,
    string? SourceCommit,   // the PR's head — the "after" side of a diff
    string? TargetCommit,   // the branch it merges into — the "before" side
    int MyVote,             // 10 approved · 5 with suggestions · 0 none · -5 waiting · -10 rejected
    string? MergeStatus);   // "conflicts" when the branch no longer merges cleanly

public record VoteRequest(int Vote);

public record RepoFavouriteDto(string Id, string Project, string RepoId, string RepoName);
public record AddRepoFavouriteRequest(string Project, string RepoId, string RepoName);

public record PrChangeDto(string Path, string ChangeType, string? OriginalPath);

/// <summary>Both sides of one file, ready to hand to a diff editor. Null = absent at that commit.</summary>
public record PrFileDiffDto(string Path, string? Before, string? After);

public record PrCommentDto(
    int Id, int ParentId, string? Author, string Content,
    DateTime? PublishedAt, string? CommentType, bool IsDeleted);

/// <summary>A comment thread. FilePath/RightLine are null for ADO's own system threads.</summary>
public record PrThreadDto(
    int Id, string? Status, string? FilePath,
    int? RightLine, int? LeftLine, bool IsDeleted, List<PrCommentDto> Comments);

public record NewThreadRequest(string FilePath, int Line, string Content, bool OnLeft);
public record ReplyRequest(string Content);
public record ThreadStatusRequest(string Status);

// ----- sequences -----

/// <summary>How a step injects the previous step's run into its own trigger.</summary>
public record StepLinkDto(
    string Mode,      // "none" | "resource" | "parameter" | "variable"
    string? Key,      // resource alias, or template-parameter / variable name
    string? Source);  // value to pass (parameter/variable): "runId" | "buildNumber" | "tag" | "branch"

/// <summary>
/// Binds a step's template parameter / variable to exactly one source (SEQUENCES §6).
///
/// Originally this could only name a pre-run input, and step-to-step values went through
/// <see cref="StepLinkDto"/> — one link per step, always reading the immediately previous one.
/// Kind/Ref generalises that: a binding can now name any earlier step, per parameter.
///
/// Kind is null on bindings written before this change, which are input bindings by definition;
/// the runner falls back to InputId there rather than needing a migration.
/// </summary>
public record ParamBindingDto(
    string Target,    // "parameter" | "variable"
    string Name,      // the parameter / variable name on the pipeline
    string? InputId,  // legacy input binding (Kind == null)
    string? Kind,     // "input" | "step" | "literal"
    string? Ref);     // input id | "<stepIndex>.<output>" | the literal value

/// <summary>
/// What an earlier step can supply. These are properties of its run, not named pipeline outputs:
/// ADO exposes no queryable output contract, so there is nothing else that could be resolved.
/// </summary>
public static class StepOutputs
{
    public const string RunId = "runId";
    public const string BuildNumber = "buildNumber";
    public const string Tag = "tag";
    public const string Branch = "branch";
    public static readonly string[] All = [RunId, BuildNumber, Tag, Branch];
}

/// <summary>A value collected before the sequence runs (branch, environment, …).</summary>
public class SequenceInputDto
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Kind { get; set; } = "value";   // "branch" | "value" | "environment"
    public string? Default { get; set; }
    public string? SourceProject { get; set; }     // branch/environment: pipeline to smart-fill from
    public int? SourcePipelineId { get; set; }
    public string? SourceParameter { get; set; }   // environment: template parameter whose values to offer
}

public class SequenceStepDto
{
    public string Id { get; set; } = "";
    public string Project { get; set; } = "";
    public int PipelineId { get; set; }
    public string Name { get; set; } = "";
    public string? Alias { get; set; }            // short label shown on the dashboard card (falls back to Name)
    public string? Branch { get; set; }
    public string? BranchInputId { get; set; }     // if set, branch comes from this pre-run input
    public Dictionary<string, string>? TemplateParameters { get; set; }
    public Dictionary<string, string>? Variables { get; set; }
    public List<ParamBindingDto>? Bindings { get; set; }
    public StepLinkDto? Link { get; set; }
}

public record SequenceDto(string Id, string Name, List<SequenceInputDto> Inputs, List<SequenceStepDto> Steps);
public record UpsertSequenceRequest(string Name, List<SequenceInputDto> Inputs, List<SequenceStepDto> Steps);
public record RunSequenceRequest(Dictionary<string, string>? Inputs);

public record SequenceRunStepDto(
    int Index,
    string Project,
    int PipelineId,
    string Name,
    int? BuildId,
    string State,          // pending | running | completed | skipped
    string? Result,        // succeeded | failed | canceled | null
    string? WebUrl,
    DateTime? StartedAt,
    DateTime? FinishedAt,
    string? Message);

public record SequenceRunDto(
    string Id,
    string SequenceId,
    string Status,         // running | succeeded | failed | canceled
    List<SequenceRunStepDto> Steps,
    DateTime StartedAt,
    DateTime? FinishedAt);

// ----- configurations (Azure App Configuration) -----
public record ConfigRegistryDto(string Id, string Name, string Endpoint);
public record UpsertConfigRegistryRequest(string Name, string Connection);
public record ConfigSettingDto(string Key, string? Value, string? Label, string? ContentType, DateTimeOffset? LastModified);
/// <summary>Wraps the list so a capped read can say so rather than looking like a complete one.</summary>
public record ConfigSettingsDto(List<ConfigSettingDto> Settings, bool Truncated, int Limit);

// ----- azure service principal (for Key Vault + endpoint-URL App Config) -----
public record AzureCredentialDto(bool Configured, string? TenantId, string? ClientId);
public record UpsertAzureCredentialRequest(string TenantId, string ClientId, string ClientSecret);

// ----- key vault -----
public record VaultRegistryDto(string Id, string Name, string Endpoint);
public record UpsertVaultRegistryRequest(string Name, string VaultUri);
public record VaultSecretValueDto(string Name, string? Value);

// ----- views -----
public record ViewItemDto(string? Kind, string Project, int PipelineId, string? SequenceId, string Name, string? Shelf, bool? ShowLabel = null);
/// <summary>A shelf's placement on the dashboard grid, in grid cells (Grafana-style).</summary>
public record GridPosDto(int X, int Y, int W, int H);
public record SavedViewDto(string Id, string Name, int SortOrder, List<string> Shelves, Dictionary<string, string> ShelfColors, Dictionary<string, GridPosDto> ShelfLayout, List<ViewItemDto> Items);
public record UpsertViewRequest(string Name, int SortOrder, List<string> Shelves, Dictionary<string, string>? ShelfColors, Dictionary<string, GridPosDto>? ShelfLayout, List<ViewItemDto> Items);

// ----- connectors (DESIGN_SPEC_CONNECTORS.md §2.1) -----

/// <summary>
/// A connector as the browser is allowed to see it.
///
/// There is no credential field, of any shape, deliberately: §2.1 requires that GET never returns
/// key or OAuth material "in any field, under any flag, including for the owner". Enforcing that
/// by omission from the type — rather than by remembering to null something out per endpoint —
/// makes the rule structural, so a future endpoint cannot leak it by forgetting.
/// </summary>
/// <param name="Status">connected | unreachable | not_tested | connecting — see §3.1.</param>
/// <param name="Capabilities">Capability keys this connector currently answers.</param>
public record ConnectorDto(
    string Id,
    string Provider,
    string Name,
    string? BaseUrl,
    string? Model,
    string AuthType,
    string? TokenLast4,
    DateTime? TokenSetAt,
    string? OauthLogin,
    string? OauthScope,
    string Status,
    DateTime? LastOkAt,
    string? LastErrorCode,
    DateTime? LastErrorAt,
    List<string> Capabilities);

/// <summary>What the picker grid needs to render, straight from §3.0's table.</summary>
public record ProviderDto(
    string Key,
    string DisplayName,
    string Auth,
    string? FixedBaseUrl,
    string CredentialLabel,
    bool UrlEditable);

/// <param name="Token">
/// Write-only. Present on create and on a deliberate replace; never echoed back by any response.
/// </param>
public record CreateConnectorRequest(
    string Provider,
    string? Name,
    string? BaseUrl,
    string? Model,
    string? Token,
    List<string>? Capabilities);

/// <summary>
/// Every field optional: absent means "leave alone", which is what lets the editor save a renamed
/// connector without resubmitting a credential it was never given in the first place.
/// </summary>
public record PatchConnectorRequest(
    string? Name,
    string? BaseUrl,
    string? Model,
    string? Token,
    List<string>? Capabilities);

/// <summary>Pre-save connection test (§4). The credential is used once and never stored by this call.</summary>
public record TestConnectorRequest(string Provider, string? BaseUrl, string? Token);

/// <param name="ErrorCode">One of the §4 codes, never free text.</param>
public record ProbeResultDto(
    bool Ok,
    long LatencyMs,
    List<string> Models,
    string? ErrorCode,
    int? HttpStatus,
    string? Detail,
    int? RetryAfterSeconds);

/// <summary>
/// A question. No history field: 7.5 makes Launchpad the owner of the conversation, so the server
/// replays the thread it already has rather than trusting whatever a client sends — which also means
/// a reopened panel cannot silently lose the earlier turns.
/// </summary>
public record AskRequest(string Question);

// ----- agent conversations (§7.5) -----

public record CitationDto(string Path, int Line, int? EndLine);

/// <summary>
/// One claim, with its own badge and its own citations (§5.2).
///
/// <paramref name="Provenance"/> is null only when the agent asserted nothing for this segment — the
/// badge then reads SOURCE NOT STATED. It is never derived from whether citations are present.
/// </summary>
/// <param name="Severity">
/// info | warning | error. A separate axis from <paramref name="Provenance"/>: one says how much this
/// should worry the reviewer, the other says how much the agent knows. Neither implies the other.
/// </param>
public record AgentSegmentDto(
    string Text,
    string? Provenance,
    string Severity,
    List<CitationDto> Citations,
    string? InferenceNote);

/// <param name="Answer">
/// The segments' prose, joined. For "Copy all" only — nothing renders from it, or the badge and the
/// citations would go back to being pooled under a whole answer.
/// </param>
/// <param name="ConnectorName">
/// Recorded on the turn rather than looked up, so attribution still renders after the connector
/// that produced it has been removed (§7.5).
/// </param>
/// <param name="Postable">
/// Whether "Post as comment…" appears at all. Stopped, failed and mode-3 answers are not postable,
/// and the button is absent rather than disabled — there is nothing the reviewer could do (§7.4).
/// </param>
public record AgentTurnDto(
    string Id,
    int Ordinal,
    string Question,
    string Answer,
    List<AgentSegmentDto> Segments,
    string Mode,
    string? ConnectorName,
    string? Model,
    string? CommitSha,
    bool Stopped,
    string? ErrorCode,
    bool Postable,
    DateTime CreatedAt);

/// <param name="Id">Null when the reviewer has never asked anything about this pull request.</param>
public record ThreadDto(string? Id, List<AgentTurnDto> Turns);

// ----- inline annotations (§7.6) -----

/// <summary>
/// A citation the reviewer left on the diff, plus whatever they went on to ask about it.
/// </summary>
/// <param name="Seed">The claim that opened it — the card's first turn, and the agent's own words.</param>
/// <param name="CommitSha">
/// The commit the citation was made against. Drives the "based on an earlier commit" note when the PR
/// head has moved: the cited line may have shifted or stopped existing, and pointing confidently at
/// the wrong line is worse than admitting the anchor is old.
/// </param>
/// <param name="Status">
/// <c>open</c> or <c>resolved</c>. Resolving dims the marker and drops it from the cycle count; it
/// never deletes, so `Show resolved` can bring it back.
/// </param>
public record AnnotationDto(
    string Id,
    string Path,
    int Line,
    int? EndLine,
    string? CommitSha,
    string? Seed,
    string Status,
    List<AgentTurnDto> Turns,
    DateTime CreatedAt,
    DateTime UpdatedAt);

public record CreateAnnotationRequest(
    string Path, int Line, int? EndLine, string? CommitSha, string? Seed);

public record AnnotationStatusRequest(string Status);
