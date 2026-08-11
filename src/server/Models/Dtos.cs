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

public record PipelineDetailDto(
    PipelineDto Pipeline,
    IReadOnlyList<BranchDto> Branches,
    IReadOnlyList<PipelineParamDto> Parameters);

// ----- runs -----
public record RunRequest(
    string Branch,
    Dictionary<string, string>? TemplateParameters,
    Dictionary<string, string>? Variables);

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

public record LogEntryDto(int Id, string Name, string State, string? Result, int? LineCount);
public record LogContentDto(int Id, string Name, string Content);

// ----- sequences -----

/// <summary>How a step injects the previous step's run into its own trigger.</summary>
public record StepLinkDto(
    string Mode,   // "none" | "resource" | "parameter" | "variable"
    string? Key);  // resource alias, or template-parameter / variable name

public record SequenceStepDto(
    string Project,
    int PipelineId,
    string Name,
    string? Branch,
    Dictionary<string, string>? TemplateParameters,
    Dictionary<string, string>? Variables,
    StepLinkDto? Link);

public record SequenceDto(string Id, string Name, List<SequenceStepDto> Steps);
public record UpsertSequenceRequest(string Name, List<SequenceStepDto> Steps);

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

// ----- views -----
public record ViewItemDto(string? Kind, string Project, int PipelineId, string? SequenceId, string Name, string? Shelf);
public record SavedViewDto(string Id, string Name, int SortOrder, List<string> Shelves, List<ViewItemDto> Items);
public record UpsertViewRequest(string Name, int SortOrder, List<string> Shelves, List<ViewItemDto> Items);
