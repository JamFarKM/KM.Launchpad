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

public record LogEntryDto(int Id, string Name, string State, string? Result, int? LineCount, string? Group);
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

/// <summary>Binds a step's template parameter / variable to a pre-run input's value.</summary>
public record ParamBindingDto(
    string Target,   // "parameter" | "variable"
    string Name,     // the parameter / variable name on the pipeline
    string InputId); // which pre-run input supplies the value

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
