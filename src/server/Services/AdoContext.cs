namespace PipelineLaunchpad.Server.Services;

/// <summary>Per-request auth context, populated by the session middleware.</summary>
public class AdoContext
{
    public string? UserId { get; set; }
    public string? Org { get; set; }
    public string? Pat { get; set; }
    public bool IsAuthenticated => !string.IsNullOrEmpty(Pat) && !string.IsNullOrEmpty(Org);
}
