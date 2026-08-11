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
    public List<SequenceInputDto> Inputs { get; set; } = new();
    public List<SequenceStepDto> Steps { get; set; } = new();
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
