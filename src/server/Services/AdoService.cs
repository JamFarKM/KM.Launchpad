using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using PipelineLaunchpad.Server.Models;

namespace PipelineLaunchpad.Server.Services;

/// <summary>
/// Thin typed wrapper over the Azure DevOps REST API (v7.1). Reads the org/PAT from
/// <see cref="AdoContext"/> unless explicit credentials are supplied (used at connect time).
/// </summary>
public class AdoService(IHttpClientFactory httpFactory, AdoContext ctx)
{
    private const string ApiVersion = "7.1";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public sealed class AdoException(int status, string message) : Exception(message)
    {
        public int Status { get; } = status;
    }

    // ---------------------------------------------------------------- auth

    /// <summary>Validates a PAT against an org and returns the authenticated identity.</summary>
    public async Task<UserDto> ValidateAsync(string org, string pat, CancellationToken ct)
    {
        using var doc = await SendJsonAsync(
            HttpMethod.Get,
            $"https://dev.azure.com/{org}/_apis/connectionData?api-version={ApiVersion}-preview",
            org, pat, null, ct);

        var user = doc.RootElement.GetProperty("authenticatedUser");
        var id = user.GetProperty("id").GetString() ?? "";
        var display = user.TryGetProperty("providerDisplayName", out var d) ? d.GetString() ?? "" : "";
        var unique = "";
        if (user.TryGetProperty("properties", out var props) &&
            props.TryGetProperty("Account", out var acct) &&
            acct.TryGetProperty("$value", out var av))
            unique = av.GetString() ?? "";

        if (string.IsNullOrEmpty(id))
            throw new AdoException(401, "Could not resolve an identity from this PAT.");

        return new UserDto(id, display, unique, org);
    }

    // ---------------------------------------------------------- discovery

    public async Task<List<ProjectDto>> GetProjectsAsync(CancellationToken ct)
    {
        using var doc = await SendJsonAsync(
            HttpMethod.Get,
            $"{OrgBase}/_apis/projects?api-version={ApiVersion}&$top=500&stateFilter=wellFormed",
            null, null, null, ct);

        var list = new List<ProjectDto>();
        foreach (var p in doc.RootElement.GetProperty("value").EnumerateArray())
            list.Add(new ProjectDto(
                p.GetProperty("id").GetString()!,
                p.GetProperty("name").GetString()!,
                p.TryGetProperty("description", out var desc) ? desc.GetString() : null));
        return list.OrderBy(p => p.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }

    public async Task<List<PipelineDto>> GetPipelinesAsync(string project, CancellationToken ct)
    {
        using var doc = await SendJsonAsync(
            HttpMethod.Get,
            $"{OrgBase}/{Uri.EscapeDataString(project)}/_apis/build/definitions" +
            $"?api-version={ApiVersion}&$top=1000&queryOrder=definitionNameAscending",
            null, null, null, ct);

        var list = new List<PipelineDto>();
        foreach (var d in doc.RootElement.GetProperty("value").EnumerateArray())
        {
            var queueStatus = d.TryGetProperty("queueStatus", out var qs) ? qs.GetString() : "enabled";
            list.Add(new PipelineDto(
                d.GetProperty("id").GetInt32(),
                d.GetProperty("name").GetString()!,
                project,
                d.TryGetProperty("path", out var path) ? NormalizeFolder(path.GetString()) : null,
                null,
                null,
                !string.Equals(queueStatus, "disabled", StringComparison.OrdinalIgnoreCase)));
        }
        return list;
    }

    public async Task<PipelineDetailDto> GetPipelineDetailAsync(string project, int id, CancellationToken ct)
    {
        using var doc = await SendJsonAsync(
            HttpMethod.Get,
            $"{OrgBase}/{Uri.EscapeDataString(project)}/_apis/build/definitions/{id}?api-version={ApiVersion}",
            null, null, null, ct);
        var root = doc.RootElement;

        string? repoId = null, repoName = null, defaultBranch = null;
        if (root.TryGetProperty("repository", out var repo))
        {
            repoId = repo.TryGetProperty("id", out var ri) ? ri.GetString() : null;
            repoName = repo.TryGetProperty("name", out var rn) ? rn.GetString() : null;
            defaultBranch = repo.TryGetProperty("defaultBranch", out var db) ? db.GetString() : null;
        }
        var queueStatus = root.TryGetProperty("queueStatus", out var qs) ? qs.GetString() : "enabled";

        var pipeline = new PipelineDto(
            id,
            root.GetProperty("name").GetString()!,
            project,
            root.TryGetProperty("path", out var path) ? NormalizeFolder(path.GetString()) : null,
            repoName,
            defaultBranch,
            !string.Equals(queueStatus, "disabled", StringComparison.OrdinalIgnoreCase));

        // overridable variables => surfaced as parameters
        var parameters = new List<PipelineParamDto>();
        if (root.TryGetProperty("variables", out var vars) && vars.ValueKind == JsonValueKind.Object)
        {
            foreach (var v in vars.EnumerateObject())
            {
                var allowOverride = v.Value.TryGetProperty("allowOverride", out var ao) && ao.GetBoolean();
                var val = v.Value.TryGetProperty("value", out var vv) ? vv.GetString() : null;
                var isSecret = v.Value.TryGetProperty("isSecret", out var s) && s.GetBoolean();
                if (isSecret) continue; // never prefill secrets
                parameters.Add(new PipelineParamDto(v.Name, "variable", val, allowOverride, null));
            }
        }

        var branches = repoId is not null
            ? await GetBranchesAsync(project, repoId, defaultBranch, ct)
            : new List<BranchDto>();

        return new PipelineDetailDto(pipeline, branches, parameters);
    }

    public async Task<List<BranchDto>> GetBranchesAsync(string project, string repoId, string? defaultBranch, CancellationToken ct)
    {
        using var doc = await SendJsonAsync(
            HttpMethod.Get,
            $"{OrgBase}/{Uri.EscapeDataString(project)}/_apis/git/repositories/{repoId}/refs" +
            $"?filter=heads/&api-version={ApiVersion}&$top=1000",
            null, null, null, ct);

        var def = defaultBranch?.Replace("refs/heads/", "");
        var list = new List<BranchDto>();
        foreach (var r in doc.RootElement.GetProperty("value").EnumerateArray())
        {
            var name = (r.GetProperty("name").GetString() ?? "").Replace("refs/heads/", "");
            if (name.Length == 0) continue;
            list.Add(new BranchDto(name, name == def));
        }
        return list
            .OrderByDescending(b => b.IsDefault)
            .ThenBy(b => b.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    // --------------------------------------------------------------- runs

    public async Task<RunDto> RunPipelineAsync(string project, int pipelineId, RunRequest req, CancellationToken ct)
    {
        var body = new Dictionary<string, object?>
        {
            ["resources"] = new { repositories = new { self = new { refName = ToRef(req.Branch) } } },
        };
        if (req.TemplateParameters is { Count: > 0 })
            body["templateParameters"] = req.TemplateParameters;
        if (req.Variables is { Count: > 0 })
            body["variables"] = req.Variables.ToDictionary(
                kv => kv.Key, kv => (object)new { value = kv.Value, isSecret = false });

        using var doc = await SendJsonAsync(
            HttpMethod.Post,
            $"{OrgBase}/{Uri.EscapeDataString(project)}/_apis/pipelines/{pipelineId}/runs?api-version={ApiVersion}",
            null, null, body, ct);

        var runId = doc.RootElement.GetProperty("id").GetInt32();
        // pipelines run id == build id; fetch the richer build view
        return await GetRunAsync(project, runId, ct);
    }

    public async Task<List<RunDto>> GetRunsAsync(string project, int pipelineId, int top, CancellationToken ct)
    {
        using var doc = await SendJsonAsync(
            HttpMethod.Get,
            $"{OrgBase}/{Uri.EscapeDataString(project)}/_apis/build/builds" +
            $"?definitions={pipelineId}&$top={top}&queryOrder=queueTimeDescending&api-version={ApiVersion}",
            null, null, null, ct);

        var list = new List<RunDto>();
        foreach (var b in doc.RootElement.GetProperty("value").EnumerateArray())
            list.Add(MapBuild(b, project));
        return list;
    }

    public async Task<RunDto> GetRunAsync(string project, int buildId, CancellationToken ct)
    {
        using var doc = await SendJsonAsync(
            HttpMethod.Get,
            $"{OrgBase}/{Uri.EscapeDataString(project)}/_apis/build/builds/{buildId}?api-version={ApiVersion}",
            null, null, null, ct);
        return MapBuild(doc.RootElement, project);
    }

    public async Task<List<LogEntryDto>> GetRunLogsAsync(string project, int buildId, CancellationToken ct)
    {
        using var doc = await SendJsonAsync(
            HttpMethod.Get,
            $"{OrgBase}/{Uri.EscapeDataString(project)}/_apis/build/builds/{buildId}/timeline?api-version={ApiVersion}",
            null, null, null, ct);

        var list = new List<LogEntryDto>();
        if (doc.RootElement.TryGetProperty("records", out var records))
        {
            foreach (var r in records.EnumerateArray()
                         .OrderBy(r => r.TryGetProperty("order", out var o) && o.ValueKind == JsonValueKind.Number ? o.GetInt32() : 0))
            {
                if (!r.TryGetProperty("log", out var log) || log.ValueKind != JsonValueKind.Object) continue;
                list.Add(new LogEntryDto(
                    log.GetProperty("id").GetInt32(),
                    r.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "",
                    r.TryGetProperty("state", out var st) ? st.GetString() ?? "" : "",
                    r.TryGetProperty("result", out var rs) && rs.ValueKind != JsonValueKind.Null ? rs.GetString() : null,
                    r.TryGetProperty("lineCount", out var lc) && lc.ValueKind == JsonValueKind.Number ? lc.GetInt32() : null));
            }
        }
        return list;
    }

    public async Task<LogContentDto> GetLogContentAsync(string project, int buildId, int logId, CancellationToken ct)
    {
        var text = await SendTextAsync(
            HttpMethod.Get,
            $"{OrgBase}/{Uri.EscapeDataString(project)}/_apis/build/builds/{buildId}/logs/{logId}?api-version={ApiVersion}",
            ct);
        return new LogContentDto(logId, $"Log {logId}", text);
    }

    // ------------------------------------------------------------ helpers

    private string OrgBase => $"https://dev.azure.com/{RequireOrg()}";

    private static RunDto MapBuild(JsonElement b, string project)
    {
        int id = b.GetProperty("id").GetInt32();
        string webUrl =
            b.TryGetProperty("_links", out var links) &&
            links.TryGetProperty("web", out var web) &&
            web.TryGetProperty("href", out var href)
                ? href.GetString() ?? ""
                : "";
        string? requestedFor = null;
        if (b.TryGetProperty("requestedFor", out var rf) && rf.ValueKind == JsonValueKind.Object)
            requestedFor = rf.TryGetProperty("displayName", out var dn) ? dn.GetString() : null;

        return new RunDto(
            id,
            b.TryGetProperty("definition", out var def) && def.TryGetProperty("id", out var did) ? did.GetInt32() : 0,
            b.TryGetProperty("buildNumber", out var bn) ? bn.GetString() : null,
            b.TryGetProperty("status", out var stt) ? stt.GetString() ?? "unknown" : "unknown",
            b.TryGetProperty("result", out var res) && res.ValueKind != JsonValueKind.Null ? res.GetString() : null,
            b.TryGetProperty("sourceBranch", out var sb) ? (sb.GetString() ?? "").Replace("refs/heads/", "") : null,
            requestedFor,
            GetDate(b, "queueTime"),
            GetDate(b, "startTime"),
            GetDate(b, "finishTime"),
            webUrl);
    }

    private static DateTime? GetDate(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String && v.TryGetDateTime(out var dt)
            ? dt
            : null;

    private static string ToRef(string branch) =>
        branch.StartsWith("refs/") ? branch : $"refs/heads/{branch}";

    private static string? NormalizeFolder(string? path)
    {
        if (string.IsNullOrWhiteSpace(path) || path == "\\") return null;
        return path.Replace('\\', '/').Trim('/');
    }

    private string RequireOrg() =>
        ctx.Org ?? throw new AdoException(401, "Not connected to an Azure DevOps organization.");

    private HttpRequestMessage BuildRequest(HttpMethod method, string url, string? org, string? pat, object? jsonBody)
    {
        var effectivePat = pat ?? ctx.Pat
            ?? throw new AdoException(401, "No Azure DevOps credentials on this request.");

        var req = new HttpRequestMessage(method, url);
        var basic = Convert.ToBase64String(Encoding.ASCII.GetBytes($":{effectivePat}"));
        req.Headers.Authorization = new AuthenticationHeaderValue("Basic", basic);
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        if (jsonBody is not null)
            req.Content = new StringContent(JsonSerializer.Serialize(jsonBody, Json), Encoding.UTF8, "application/json");

        return req;
    }

    private async Task<JsonDocument> SendJsonAsync(
        HttpMethod method, string url, string? org, string? pat, object? jsonBody, CancellationToken ct)
    {
        var client = httpFactory.CreateClient("ado");
        using var req = BuildRequest(method, url, org, pat, jsonBody);
        using var resp = await client.SendAsync(req, ct);
        var content = await resp.Content.ReadAsStringAsync(ct);

        if (!resp.IsSuccessStatusCode)
            throw new AdoException((int)resp.StatusCode, ExtractError(content, resp.ReasonPhrase));

        // Azure DevOps returns an HTML sign-in page (200) when a PAT is invalid/expired.
        if (content.TrimStart().StartsWith("<"))
            throw new AdoException(401, "Azure DevOps rejected the credentials (expired or invalid PAT).");

        return JsonDocument.Parse(content);
    }

    private async Task<string> SendTextAsync(HttpMethod method, string url, CancellationToken ct)
    {
        var client = httpFactory.CreateClient("ado");
        using var req = BuildRequest(method, url, null, null, null);
        req.Headers.Accept.Clear();
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/plain"));
        using var resp = await client.SendAsync(req, ct);
        var content = await resp.Content.ReadAsStringAsync(ct);
        if (!resp.IsSuccessStatusCode)
            throw new AdoException((int)resp.StatusCode, ExtractError(content, resp.ReasonPhrase));
        return content;
    }

    private static string ExtractError(string content, string? fallback)
    {
        try
        {
            using var doc = JsonDocument.Parse(content);
            if (doc.RootElement.TryGetProperty("message", out var m))
                return m.GetString() ?? fallback ?? "Azure DevOps request failed.";
        }
        catch { /* not json */ }
        return fallback ?? "Azure DevOps request failed.";
    }
}
