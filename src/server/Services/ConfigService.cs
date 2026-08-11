using System.Text.Json;
using System.Xml.Linq;
using Microsoft.EntityFrameworkCore;
using PipelineLaunchpad.Server.Data;
using PipelineLaunchpad.Server.Models;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace PipelineLaunchpad.Server.Services;

/// <summary>Parses shareable config (JSON/YAML/XML) and applies it to a user's data.</summary>
public class ConfigService(AppDbContext db)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public class ConfigException(string message) : Exception(message);

    // -------------------------------------------------------- parsing

    public static ConfigDoc Parse(string text, string? format)
    {
        var trimmed = (text ?? "").TrimStart();
        var fmt = (format ?? "").ToLowerInvariant();
        if (string.IsNullOrEmpty(fmt))
            fmt = trimmed.StartsWith("{") ? "json" : trimmed.StartsWith("<") ? "xml" : "yaml";

        try
        {
            return fmt switch
            {
                "json" => JsonSerializer.Deserialize<ConfigDoc>(text!, Json) ?? new(),
                "yml" or "yaml" => new DeserializerBuilder()
                    .WithNamingConvention(CamelCaseNamingConvention.Instance)
                    .IgnoreUnmatchedProperties()
                    .Build()
                    .Deserialize<ConfigDoc>(text!) ?? new(),
                "xml" => ParseXml(text!),
                _ => throw new ConfigException($"Unsupported format '{fmt}'."),
            };
        }
        catch (ConfigException) { throw; }
        catch (Exception ex) { throw new ConfigException($"Could not parse {fmt}: {ex.Message}"); }
    }

    private static ConfigDoc ParseXml(string text)
    {
        var root = XDocument.Parse(text).Root ?? throw new ConfigException("Empty XML.");
        var doc = new ConfigDoc();

        foreach (var s in root.Element("sequences")?.Elements("sequence") ?? Enumerable.Empty<XElement>())
        {
            var seq = new CfgSequence { Name = Attr(s, "name") };
            foreach (var st in s.Elements("step"))
            {
                seq.Steps.Add(new CfgStep
                {
                    Project = Attr(st, "project"),
                    PipelineId = IntAttr(st, "pipelineId"),
                    Name = Attr(st, "name"),
                    Branch = Attr(st, "branch"),
                    TemplateParameters = KvBag(st.Element("templateParameters")),
                    Variables = KvBag(st.Element("variables")),
                    Link = st.Element("link") is { } l
                        ? new CfgLink { Mode = Attr(l, "mode", "none"), Key = Attr(l, "key") }
                        : null,
                });
            }
            doc.Sequences.Add(seq);
        }

        foreach (var v in root.Element("views")?.Elements("view") ?? Enumerable.Empty<XElement>())
        {
            var view = new CfgView
            {
                Name = Attr(v, "name"),
                Shelves = Attr(v, "shelves").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList(),
            };
            foreach (var it in v.Elements("item"))
            {
                view.Items.Add(new CfgViewItem
                {
                    Kind = Attr(it, "kind", "pipeline"),
                    Project = Attr(it, "project"),
                    PipelineId = IntAttr(it, "pipelineId"),
                    Sequence = Attr(it, "sequence"),
                    Name = Attr(it, "name"),
                    Shelf = Attr(it, "shelf"),
                });
            }
            doc.Views.Add(view);
        }
        return doc;
    }

    private static string Attr(XElement e, string n, string fallback = "") => e.Attribute(n)?.Value ?? fallback;
    private static int IntAttr(XElement e, string n) => int.TryParse(e.Attribute(n)?.Value, out var i) ? i : 0;
    private static Dictionary<string, string> KvBag(XElement? bag) =>
        bag?.Elements("param").ToDictionary(p => Attr(p, "key"), p => p.Value) ?? new();

    // -------------------------------------------------------- apply

    /// <summary>Replaces the user's sequences and views with the config's contents.</summary>
    public async Task<(int sequences, int views)> ReplaceAsync(string userId, ConfigDoc doc, CancellationToken ct)
    {
        await db.Views.Where(v => v.UserId == userId).ExecuteDeleteAsync(ct);
        await db.Sequences.Where(s => s.UserId == userId).ExecuteDeleteAsync(ct);

        var now = DateTime.UtcNow;
        var nameToId = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        foreach (var cs in doc.Sequences)
        {
            var steps = cs.Steps.Select(s => new SequenceStepDto(
                s.Project, s.PipelineId, s.Name, s.Branch,
                s.TemplateParameters, s.Variables,
                s.Link is null ? null : new StepLinkDto(s.Link.Mode, s.Link.Key))).ToList();

            var id = Guid.NewGuid().ToString("N");
            nameToId[cs.Name] = id;
            db.Sequences.Add(new Sequence
            {
                Id = id, UserId = userId, Name = cs.Name,
                StepsJson = JsonSerializer.Serialize(steps, Json), CreatedAt = now, UpdatedAt = now,
            });
        }

        var order = 0;
        foreach (var cv in doc.Views)
        {
            var items = cv.Items.Select(it =>
            {
                var isSeq = string.Equals(it.Kind, "sequence", StringComparison.OrdinalIgnoreCase);
                string? seqId = isSeq && it.Sequence is not null && nameToId.TryGetValue(it.Sequence, out var mapped)
                    ? mapped : null;
                return new ViewItemDto(
                    isSeq ? "sequence" : "pipeline",
                    it.Project, it.PipelineId, seqId,
                    it.Name, it.Shelf);
            }).ToList();

            db.Views.Add(new SavedView
            {
                Id = Guid.NewGuid().ToString("N"), UserId = userId, Name = cv.Name, SortOrder = order++,
                ItemsJson = JsonSerializer.Serialize(new { shelves = cv.Shelves, items }, Json),
                CreatedAt = now, UpdatedAt = now,
            });
        }

        await db.SaveChangesAsync(ct);
        return (doc.Sequences.Count, doc.Views.Count);
    }

    // -------------------------------------------------------- export

    public async Task<ConfigDoc> ExportAsync(string userId, CancellationToken ct)
    {
        var seqs = await db.Sequences.Where(s => s.UserId == userId).ToListAsync(ct);
        var idToName = seqs.ToDictionary(s => s.Id, s => s.Name);
        var views = await db.Views.Where(v => v.UserId == userId).OrderBy(v => v.SortOrder).ToListAsync(ct);

        var doc = new ConfigDoc();

        foreach (var s in seqs)
        {
            var steps = JsonSerializer.Deserialize<List<SequenceStepDto>>(s.StepsJson, Json) ?? new();
            doc.Sequences.Add(new CfgSequence
            {
                Name = s.Name,
                Steps = steps.Select(st => new CfgStep
                {
                    Project = st.Project, PipelineId = st.PipelineId, Name = st.Name, Branch = st.Branch,
                    TemplateParameters = st.TemplateParameters ?? new(),
                    Variables = st.Variables ?? new(),
                    Link = st.Link is null ? null : new CfgLink { Mode = st.Link.Mode, Key = st.Link.Key },
                }).ToList(),
            });
        }

        foreach (var v in views)
        {
            var (shelves, items) = ReadLayout(v.ItemsJson);
            doc.Views.Add(new CfgView
            {
                Name = v.Name,
                Shelves = shelves,
                Items = items.Select(it => new CfgViewItem
                {
                    Kind = it.Kind ?? "pipeline",
                    Project = it.Project,
                    PipelineId = it.PipelineId,
                    Sequence = it.Kind == "sequence" && it.SequenceId is not null && idToName.TryGetValue(it.SequenceId, out var nm) ? nm : null,
                    Name = it.Name,
                    Shelf = it.Shelf,
                }).ToList(),
            });
        }
        return doc;
    }

    private static (List<string>, List<ViewItemDto>) ReadLayout(string json)
    {
        var t = (json ?? "").TrimStart();
        if (t.StartsWith("["))
            return (new(), JsonSerializer.Deserialize<List<ViewItemDto>>(t, Json) ?? new());
        if (t.Length == 0) return (new(), new());
        var layout = JsonSerializer.Deserialize<Layout>(t, Json);
        return (layout?.Shelves ?? new(), layout?.Items ?? new());
    }

    private record Layout(List<string> Shelves, List<ViewItemDto> Items);
}
