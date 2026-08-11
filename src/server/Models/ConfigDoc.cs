namespace PipelineLaunchpad.Server.Models;

// Portable, shareable configuration of dashboards + sequences. Sequence references
// inside views are by NAME (ids aren't portable across users/machines).
// These are plain settable-property classes so JSON/YAML/XML all deserialize cleanly.

public class ConfigDoc
{
    public int Version { get; set; } = 1;
    public List<CfgSequence> Sequences { get; set; } = new();
    public List<CfgView> Views { get; set; } = new();
}

public class CfgSequence
{
    public string Name { get; set; } = "";
    public List<CfgStep> Steps { get; set; } = new();
}

public class CfgStep
{
    public string Project { get; set; } = "";
    public int PipelineId { get; set; }
    public string Name { get; set; } = "";
    public string? Branch { get; set; }
    public Dictionary<string, string> TemplateParameters { get; set; } = new();
    public Dictionary<string, string> Variables { get; set; } = new();
    public CfgLink? Link { get; set; }
}

public class CfgLink
{
    public string Mode { get; set; } = "none";
    public string? Key { get; set; }
}

public class CfgView
{
    public string Name { get; set; } = "";
    public List<string> Shelves { get; set; } = new();
    public List<CfgViewItem> Items { get; set; } = new();
}

public class CfgViewItem
{
    public string Kind { get; set; } = "pipeline";  // "pipeline" | "sequence"
    public string Project { get; set; } = "";
    public int PipelineId { get; set; }
    public string? Sequence { get; set; }            // sequence name (for kind=sequence)
    public string Name { get; set; } = "";
    public string? Shelf { get; set; }
}
