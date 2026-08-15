using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace PipelineLaunchpad.Server.Services.Agents;

/// <summary>Where reads are pinned. Nothing outside this repo, at this commit, is reachable.</summary>
public record RepoScope(string Project, string RepoId, string Commit);

/// <summary>
/// The read-only tools the server services for an agent.
///
/// Modelled on what Microsoft's Azure DevOps MCP server exposes, but called directly rather than
/// through it: the container is a single .NET process, `AdoService` already reads files at a commit,
/// and the MCP surface includes write tools — thread comments, pipeline runs — that §7.4 exists
/// specifically to keep away from the agent. Withholding a tool you never defined is safer than
/// policing one you did.
///
/// Every failure is returned <em>to the model</em> rather than thrown. An agent told "that file
/// doesn't exist" can adjust; an agent whose answer died on a 404 just failed.
/// </summary>
public class RepoTools(AdoService ado)
{
    /// <summary>Paths the agent read, in order, for the panel to show (an answer's basis, visible).</summary>
    public List<string> Reads { get; } = [];

    public static IReadOnlyList<AgentToolDefinition> Definitions =>
    [
        new("read_file",
            "Read a file from the repository at the pull request's head commit. Use this to see code "
            + "the diff does not include — the previous version of a changed file, a caller, an "
            + "interface, or a test. Returns the file with line numbers.",
            new JsonObject
            {
                ["type"] = "object",
                ["additionalProperties"] = false,
                ["required"] = new JsonArray("path"),
                ["properties"] = new JsonObject
                {
                    ["path"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = "Repository path, e.g. src/Users/UserService.cs",
                    },
                    ["start_line"] = new JsonObject
                    {
                        ["type"] = "integer",
                        ["description"] = "1-based line to start from. Omit to read from the top.",
                    },
                },
            }),

        new("list_files",
            "List the files and folders in a repository directory. Use this to find where something "
            + "lives before reading it, rather than guessing at a path.",
            new JsonObject
            {
                ["type"] = "object",
                ["additionalProperties"] = false,
                ["required"] = new JsonArray("path"),
                ["properties"] = new JsonObject
                {
                    ["path"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = "Directory path. Use \"/\" for the repository root.",
                    },
                },
            }),

        new("search_code",
            "Search the repository's code for a string. Use this to answer questions the diff cannot "
            + "— whether a procedure is still called, whether a test covers something, where a "
            + "constant is defined.",
            new JsonObject
            {
                ["type"] = "object",
                ["additionalProperties"] = false,
                ["required"] = new JsonArray("query"),
                ["properties"] = new JsonObject
                {
                    ["query"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = "Text to search for, e.g. SearchUsersByEmail",
                    },
                },
            }),
    ];

    public async Task<AgentToolResult> ExecuteAsync(
        AgentToolCall call, RepoScope scope, AgentBudget budget, CancellationToken ct)
    {
        try
        {
            return call.Name switch
            {
                "read_file" => await ReadFileAsync(call, scope, budget, ct),
                "list_files" => await ListFilesAsync(call, scope, budget, ct),
                "search_code" => await SearchAsync(call, scope, budget, ct),
                _ => Error(call, $"There is no tool called {call.Name}."),
            };
        }
        catch (AdoService.AdoException ex)
        {
            // Azure DevOps said no. The model is told, so it can try a different path or answer
            // without that file.
            return Error(call, $"Azure DevOps refused that request: {ex.Message}");
        }
        catch (JsonException)
        {
            return Error(call, "Those arguments were not valid JSON.");
        }
    }

    private async Task<AgentToolResult> ReadFileAsync(
        AgentToolCall call, RepoScope scope, AgentBudget budget, CancellationToken ct)
    {
        var args = Parse(call);
        var path = Normalise(Str(args, "path"));
        if (path is null) return Error(call, "A path is required.");

        var start = Math.Max(1, Int(args, "start_line") ?? 1);

        var text = await ado.GetFileAtCommitAsync(scope.Project, scope.RepoId, path, scope.Commit, ct);
        if (text is null)
            return Error(call, $"{path} does not exist at this commit. Use list_files to find it.");

        var lines = text.Replace("\r\n", "\n").Split('\n');
        if (start > lines.Length)
            return Error(call, $"{path} has {lines.Length} lines, so line {start} is past its end.");

        var slice = lines.Skip(start - 1).Take(AgentBudget.MaxLinesPerRead).ToList();
        var truncated = start - 1 + slice.Count < lines.Length;

        // Numbered, so a citation the agent makes from a read file lands on the right line — the
        // whole point of citations is that they are checkable.
        var body = new StringBuilder();
        body.Append("File: ").Append(path).Append(" (").Append(lines.Length).AppendLine(" lines)");
        if (start > 1 || truncated)
            body.Append("Showing lines ").Append(start).Append('-').Append(start - 1 + slice.Count).AppendLine(".");
        body.AppendLine();
        for (var i = 0; i < slice.Count; i++)
            body.Append(start + i).Append('\t').AppendLine(slice[i]);
        if (truncated)
            body.AppendLine().Append("… truncated at ").Append(AgentBudget.MaxLinesPerRead)
                .AppendLine(" lines. Call read_file again with start_line to continue.");

        var content = body.ToString();
        if (!budget.TrySpend(Encoding.UTF8.GetByteCount(content)))
            return Error(call, TooLarge(path, budget));

        Reads.Add(path);
        return new AgentToolResult(call.Id, content);
    }

    private async Task<AgentToolResult> ListFilesAsync(
        AgentToolCall call, RepoScope scope, AgentBudget budget, CancellationToken ct)
    {
        var args = Parse(call);
        var path = Normalise(Str(args, "path")) ?? "";

        var entries = await ado.ListRepoItemsAsync(scope.Project, scope.RepoId, path, scope.Commit, ct);
        if (entries.Count == 0)
            return Error(call, $"Nothing is listed under {(path.Length == 0 ? "/" : path)} at this commit.");

        var body = new StringBuilder();
        body.Append(path.Length == 0 ? "/" : path).AppendLine(":");
        foreach (var (entryPath, isFolder) in entries)
            body.Append("  ").Append(entryPath).AppendLine(isFolder ? "/" : "");

        var content = body.ToString();
        if (!budget.TrySpend(Encoding.UTF8.GetByteCount(content)))
            return Error(call, TooLarge(path, budget));

        return new AgentToolResult(call.Id, content);
    }

    private async Task<AgentToolResult> SearchAsync(
        AgentToolCall call, RepoScope scope, AgentBudget budget, CancellationToken ct)
    {
        var args = Parse(call);
        var query = Str(args, "query");
        if (string.IsNullOrWhiteSpace(query)) return Error(call, "A query is required.");

        var hits = await ado.SearchCodeAsync(scope.Project, scope.RepoId, query!, ct);

        // Code search is a separate Azure DevOps extension and is not installed everywhere. Saying
        // so plainly beats an empty result the model would read as "nothing matches" — the
        // difference between "not called anywhere" and "I couldn't check" is the whole answer.
        if (hits is null)
            return Error(call, "Code search is not available on this Azure DevOps organization. "
                             + "Use list_files and read_file instead.");

        if (hits.Count == 0)
            return new AgentToolResult(call.Id, $"No matches for \"{query}\" in this repository.");

        var body = new StringBuilder();
        body.Append(hits.Count).Append(" file(s) matching \"").Append(query).AppendLine("\":");
        foreach (var hit in hits) body.Append("  ").AppendLine(hit);

        var content = body.ToString();
        if (!budget.TrySpend(Encoding.UTF8.GetByteCount(content)))
            return Error(call, TooLarge(query!, budget));

        return new AgentToolResult(call.Id, content);
    }

    private static string TooLarge(string what, AgentBudget budget) =>
        $"That would exceed the reading budget for this question ({budget.BytesRemaining} bytes left). "
        + "Answer with what you have, and say what you could not check.";

    /// <summary>
    /// Strips a leading slash and refuses traversal.
    ///
    /// The scope already pins the repo and commit, so this is belt-and-braces rather than the only
    /// guard — but a path containing <c>..</c> has no legitimate reading and is worth refusing
    /// outright rather than hoping the server resolves it harmlessly.
    /// </summary>
    private static string? Normalise(string? path)
    {
        if (path is null) return null;
        var trimmed = path.Trim().Replace('\\', '/').TrimStart('/');
        if (trimmed.Split('/').Any(seg => seg == "..")) return null;
        return trimmed;
    }

    private static AgentToolResult Error(AgentToolCall call, string message) =>
        new(call.Id, message, IsError: true);

    private static JsonObject Parse(AgentToolCall call) =>
        (JsonNode.Parse(string.IsNullOrWhiteSpace(call.ArgumentsJson) ? "{}" : call.ArgumentsJson)
            as JsonObject) ?? new JsonObject();

    /// <summary>
    /// A scalar argument, or null when it is absent or the wrong shape.
    ///
    /// Matched as a <see cref="JsonValue"/> rather than read with <c>GetValue&lt;object&gt;()</c>,
    /// which throws <see cref="InvalidOperationException"/> on an object or an array. That is not a
    /// <see cref="JsonException"/>, so it escaped <see cref="ExecuteAsync"/>'s catches and killed
    /// the answer stream mid-flight — a model that sends <c>"path": {"file": "…"}</c> should be told
    /// its arguments were wrong, like every other bad call, not sever the response.
    /// </summary>
    private static string? Str(JsonObject args, string name) =>
        args[name] is JsonValue v ? v.ToString() : null;

    private static int? Int(JsonObject args, string name) =>
        args[name] is JsonValue v && v.TryGetValue<int>(out var n) ? n : null;
}
