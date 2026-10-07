using System.Text.Json;
using PipelineLaunchpad.Server.Services;

namespace PipelineLaunchpad.Server.Tests;

public class PrChangeEntriesTests
{
    private static List<PipelineLaunchpad.Server.Models.PrChangeDto> Read(string json)
    {
        using var doc = JsonDocument.Parse(json);
        return AdoService.ReadChangeEntries(doc.RootElement);
    }

    [Fact]
    public void A_deleted_file_is_read_from_the_entrys_original_path()
    {
        // Verbatim shape of a real delete entry: item.path is null and the file is named only on the entry.
        var changes = Read("""
            { "changeEntries": [
              { "changeType": "delete",
                "item": { "originalObjectId": "5EB0F86E", "path": null },
                "originalPath": "/src/Core.Domain/DomainMetrics.cs" } ] }
            """);

        var c = Assert.Single(changes);
        Assert.Equal("/src/Core.Domain/DomainMetrics.cs", c.Path);
        Assert.Equal("delete", c.ChangeType);
        Assert.Null(c.OriginalPath);
    }

    [Fact]
    public void A_rename_keeps_its_new_path_and_reports_the_old_one()
    {
        var c = Assert.Single(Read("""
            { "changeEntries": [
              { "changeType": "rename",
                "item": { "path": "/src/New.cs" },
                "originalPath": "/src/Old.cs" } ] }
            """));

        Assert.Equal("/src/New.cs", c.Path);
        Assert.Equal("/src/Old.cs", c.OriginalPath);
    }

    [Fact]
    public void Edits_and_deletions_are_listed_together_and_folders_are_not()
    {
        var changes = Read("""
            { "changeEntries": [
              { "changeType": "edit", "item": { "path": "/b.cs" } },
              { "changeType": "delete", "item": { "path": null }, "originalPath": "/a.cs" },
              { "changeType": "delete", "item": { "path": "/dir", "isFolder": true } } ] }
            """);

        Assert.Equal(["/a.cs", "/b.cs"], changes.Select(c => c.Path));
    }
}
