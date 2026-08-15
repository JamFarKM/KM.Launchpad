using System.Text.Json;
using PipelineLaunchpad.Server.Services.Agents;

namespace PipelineLaunchpad.Server.Tests;

/// <summary>
/// Exercises DESIGN_SPEC_CHANGE_MAP.md §2's validation: a group survives entire or is dropped
/// entire, an edge or flow step referencing a dropped group is dropped with it, and a map with
/// nothing left is a parse failure, not an empty diagram (§7).
/// </summary>
public class ChangeMapParserTests
{
    private static readonly string[] Known = ["CouponSnapshot.cs", "MyBoost.cs", "CouponPlacementOrchestrator.cs"];

    private static string Payload(object body) => JsonSerializer.Serialize(body);

    [Fact]
    public void A_well_formed_map_parses_in_full()
    {
        var json = Payload(new
        {
            style = "clean",
            style_basis = "inferred",
            groups = new object[]
            {
                new { id = "core", name = "Snapshot model", depth = 0, summary = "The record itself.",
                      files = new[] { new { path = "CouponSnapshot.cs", added = 6, removed = 1 } } },
                new { id = "app", name = "Orchestration", depth = 1, summary = "Builds the snapshot.",
                      files = new[] { new { path = "CouponPlacementOrchestrator.cs", added = 31, removed = 12 } } },
            },
            edges = new[] { new { from = "app", to = "core", label = "builds snapshot" } },
            flow = new[] { new { step = 1, group = "app", action = "Snapshot built" } },
        });

        var map = ChangeMapParser.Parse(json, Known);

        Assert.NotNull(map);
        Assert.Equal(ArchitectureStyle.Clean, map!.Style);
        Assert.Equal(StyleBasis.Inferred, map.StyleBasis);
        Assert.Equal(2, map.Groups.Count);
        Assert.Single(map.Edges);
        Assert.Single(map.Flow);
    }

    [Fact]
    public void A_group_whose_every_file_is_unknown_is_dropped_whole()
    {
        // The one hard rule: a citation to a file nobody showed the agent is invented (§5.2), and
        // that applies to a group's evidence exactly as it does to a segment's.
        var json = Payload(new
        {
            style = "unknown",
            style_basis = "inferred",
            groups = new object[]
            {
                new { id = "real", name = "Real area", depth = 0, summary = "…",
                      files = new[] { new { path = "CouponSnapshot.cs", added = 1, removed = 0 } } },
                new { id = "invented", name = "Invented area", depth = 0, summary = "…",
                      files = new[] { new { path = "DoesNotExist.cs", added = 1, removed = 0 } } },
            },
            edges = Array.Empty<object>(),
            flow = Array.Empty<object>(),
        });

        var map = ChangeMapParser.Parse(json, Known);

        Assert.NotNull(map);
        var group = Assert.Single(map!.Groups);
        Assert.Equal("real", group.Id);
    }

    [Fact]
    public void An_edge_to_a_dropped_group_is_dropped_with_it()
    {
        var json = Payload(new
        {
            style = "layers",
            style_basis = "structure",
            groups = new object[]
            {
                new { id = "real", name = "Real", depth = 0, summary = "…",
                      files = new[] { new { path = "CouponSnapshot.cs", added = 1, removed = 0 } } },
                new { id = "ghost", name = "Ghost", depth = 1, summary = "…",
                      files = new[] { new { path = "Nowhere.cs", added = 1, removed = 0 } } },
            },
            edges = new[] { new { from = "ghost", to = "real", label = "calls" } },
            flow = new[] { new { step = 1, group = "ghost", action = "…" } },
        });

        var map = ChangeMapParser.Parse(json, Known);

        Assert.NotNull(map);
        Assert.Empty(map!.Edges);
        Assert.Empty(map.Flow);
    }

    [Fact]
    public void A_map_with_no_surviving_groups_is_a_parse_failure_not_an_empty_diagram()
    {
        var json = Payload(new
        {
            style = "unknown",
            style_basis = "inferred",
            groups = new object[]
            {
                new { id = "g", name = "…", depth = 0, summary = "…",
                      files = new[] { new { path = "Invented.cs", added = 1, removed = 0 } } },
            },
            edges = Array.Empty<object>(),
            flow = Array.Empty<object>(),
        });

        Assert.Null(ChangeMapParser.Parse(json, Known));
    }

    [Fact]
    public void Malformed_json_is_a_parse_failure()
    {
        Assert.Null(ChangeMapParser.Parse("{not json", Known));
        Assert.Null(ChangeMapParser.Parse("", Known));
    }

    [Fact]
    public void Groups_beyond_the_cap_are_dropped()
    {
        var groups = Enumerable.Range(0, ChangeMapSchema.MaxGroups + 3)
            .Select(i => (object)new
            {
                id = $"g{i}", name = $"Group {i}", depth = 0, summary = "…",
                files = new[] { new { path = "CouponSnapshot.cs", added = 1, removed = 0 } },
            })
            .ToArray();

        var json = Payload(new { style = "modules", style_basis = "inferred", groups, edges = Array.Empty<object>(), flow = Array.Empty<object>() });

        var map = ChangeMapParser.Parse(json, Known);

        Assert.NotNull(map);
        Assert.Equal(ChangeMapSchema.MaxGroups, map!.Groups.Count);
    }

    [Fact]
    public void Layer_names_are_kept_for_depths_a_surviving_group_occupies()
    {
        var json = Payload(new
        {
            style = "clean",
            style_basis = "structure",
            layers = new[]
            {
                new { depth = 0, name = "Domain core" },
                new { depth = 1, name = "Application" },
                // A name for a depth no group sits at would render an empty band.
                new { depth = 4, name = "Nothing here" },
            },
            groups = new object[]
            {
                new { id = "core", name = "Model", depth = 0, summary = "…",
                      files = new[] { new { path = "CouponSnapshot.cs", added = 1, removed = 0 } } },
                new { id = "app", name = "Orchestration", depth = 1, summary = "…",
                      files = new[] { new { path = "CouponPlacementOrchestrator.cs", added = 1, removed = 0 } } },
            },
            edges = new[] { new { from = "app", to = "core", label = "builds" } },
            flow = Array.Empty<object>(),
        });

        var map = ChangeMapParser.Parse(json, Known);

        Assert.NotNull(map);
        Assert.Equal(2, map!.Layers.Count);
        Assert.Equal("Domain core", map.Layers.Single(l => l.Depth == 0).Name);
        Assert.DoesNotContain(map.Layers, l => l.Depth == 4);
    }

    [Fact]
    public void A_map_without_layers_still_parses()
    {
        // Maps stored before layer names existed, and any provider that omits the array. The sheet
        // falls back to naming the axis extremes rather than refusing to draw.
        var json = Payload(new
        {
            style = "modules",
            style_basis = "inferred",
            groups = new object[]
            {
                new { id = "g", name = "Area", depth = 0, summary = "…",
                      files = new[] { new { path = "MyBoost.cs", added = 1, removed = 0 } } },
            },
            edges = Array.Empty<object>(),
            flow = Array.Empty<object>(),
        });

        var map = ChangeMapParser.Parse(json, Known);

        Assert.NotNull(map);
        Assert.Empty(map!.Layers);
    }

    [Fact]
    public void Leading_slash_does_not_defeat_path_validation()
    {
        // The context block declares paths without one; Azure DevOps hands some back with one.
        // A file should not be dropped over a character the reviewer never sees (same rule as
        // AgentConversation.Normalise for citations).
        var json = Payload(new
        {
            style = "unknown",
            style_basis = "inferred",
            groups = new object[]
            {
                new { id = "g", name = "…", depth = 0, summary = "…",
                      files = new[] { new { path = "/CouponSnapshot.cs", added = 1, removed = 0 } } },
            },
            edges = Array.Empty<object>(),
            flow = Array.Empty<object>(),
        });

        var map = ChangeMapParser.Parse(json, Known);

        Assert.NotNull(map);
        Assert.Single(map!.Groups);
    }
}
