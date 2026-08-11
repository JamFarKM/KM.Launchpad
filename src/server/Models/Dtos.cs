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

public record BranchDto(string Name, bool IsDefault);

public record PipelineParamDto(
    string Name,
    string Kind,              // "parameter" | "variable"
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

// ----- views -----
public record ViewItemDto(string Project, int PipelineId, string Name);
public record SavedViewDto(string Id, string Name, int SortOrder, List<ViewItemDto> Items);
public record UpsertViewRequest(string Name, int SortOrder, List<ViewItemDto> Items);
