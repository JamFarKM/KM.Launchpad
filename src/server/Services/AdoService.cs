using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using PipelineLaunchpad.Server.Models;
using YamlDotNet.RepresentationModel;

namespace PipelineLaunchpad.Server.Services;

/// <summary>
/// Thin typed wrapper over the Azure DevOps REST API (v7.1). Reads the org/PAT from
/// <see cref="AdoContext"/> unless explicit credentials are supplied (used at connect time).
/// </summary>
public class AdoService(IHttpClientFactory httpFactory, AdoContext ctx)
{
    private const string ApiVersion = "7.1";

    /// <summary>Tag applied to every run this app triggers, so they're easy to spot in Azure DevOps.</summary>
    public const string LaunchpadTag = "🚀 launchpad";

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

        var parameters = new List<PipelineParamDto>();
        var resources = new List<PipelineResourceDto>();

        // 1) YAML template parameters + pipeline resources (scraped from the repo).
        string? yamlFile = null;
        if (root.TryGetProperty("process", out var process))
            yamlFile = process.TryGetProperty("yamlFilename", out var yf) ? yf.GetString() : null;

        if (yamlFile is not null && repoId is not null)
        {
            try
            {
                var (scraped, scrapedResources) = await ScrapeYamlAsync(project, repoId, defaultBranch, yamlFile, ct);
                parameters.AddRange(scraped);
                resources = scrapedResources;
            }
            catch { /* best-effort — fall back to variables + free-form */ }
        }

        // 2) Overridable pipeline variables.
        if (root.TryGetProperty("variables", out var vars) && vars.ValueKind == JsonValueKind.Object)
        {
            foreach (var v in vars.EnumerateObject())
            {
                var allowOverride = v.Value.TryGetProperty("allowOverride", out var ao) && ao.GetBoolean();
                var val = v.Value.TryGetProperty("value", out var vv) ? vv.GetString() : null;
                var isSecret = v.Value.TryGetProperty("isSecret", out var s) && s.GetBoolean();
                if (isSecret) continue; // never prefill secrets
                parameters.Add(new PipelineParamDto(v.Name, "variable", "string", val, allowOverride, null));
            }
        }

        var branches = repoId is not null
            ? await GetBranchesAsync(project, repoId, defaultBranch, ct)
            : new List<BranchDto>();

        return new PipelineDetailDto(pipeline, branches, parameters, resources);
    }

    public async Task<List<BranchDto>> GetBranchesAsync(string project, string repoId, string? defaultBranch, CancellationToken ct)
    {
        var def = defaultBranch?.Replace("refs/heads/", "");
        var me = ctx.UniqueName;

        // Preferred: branch stats give each branch's tip-commit author/date, so we can
        // surface the branches the current user most recently worked on.
        try
        {
            using var doc = await SendJsonAsync(
                HttpMethod.Get,
                $"{OrgBase}/{Uri.EscapeDataString(project)}/_apis/git/repositories/{repoId}/stats/branches" +
                $"?api-version={ApiVersion}",
                null, null, null, ct);

            var list = new List<BranchDto>();
            foreach (var b in doc.RootElement.GetProperty("value").EnumerateArray())
            {
                var name = b.GetProperty("name").GetString() ?? "";
                if (name.Length == 0) continue;

                string? authorEmail = null, committerEmail = null;
                DateTime? date = null;
                if (b.TryGetProperty("commit", out var commit))
                {
                    if (commit.TryGetProperty("author", out var au))
                    {
                        authorEmail = au.TryGetProperty("email", out var ae) ? ae.GetString() : null;
                        date = GetDate(au, "date");
                    }
                    if (commit.TryGetProperty("committer", out var co))
                    {
                        committerEmail = co.TryGetProperty("email", out var ce) ? ce.GetString() : null;
                        date ??= GetDate(co, "date");
                    }
                }

                var mine = me is not null &&
                    (string.Equals(authorEmail, me, StringComparison.OrdinalIgnoreCase) ||
                     string.Equals(committerEmail, me, StringComparison.OrdinalIgnoreCase));

                list.Add(new BranchDto(name, name == def, mine, date));
            }

            if (list.Count > 0)
                return list
                    .OrderByDescending(b => b.Mine)
                    .ThenByDescending(b => b.LastCommit ?? DateTime.MinValue)
                    .ThenByDescending(b => b.IsDefault)
                    .ThenBy(b => b.Name, StringComparer.OrdinalIgnoreCase)
                    .ToList();
        }
        catch (AdoException) { /* fall back to the plain ref list below */ }

        using var refsDoc = await SendJsonAsync(
            HttpMethod.Get,
            $"{OrgBase}/{Uri.EscapeDataString(project)}/_apis/git/repositories/{repoId}/refs" +
            $"?filter=heads/&api-version={ApiVersion}&$top=1000",
            null, null, null, ct);

        var refs = new List<BranchDto>();
        foreach (var r in refsDoc.RootElement.GetProperty("value").EnumerateArray())
        {
            var name = (r.GetProperty("name").GetString() ?? "").Replace("refs/heads/", "");
            if (name.Length == 0) continue;
            refs.Add(new BranchDto(name, name == def, false, null));
        }
        return refs
            .OrderByDescending(b => b.IsDefault)
            .ThenBy(b => b.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    // ------------------------------------------------- yaml parameters

    /// <summary>
    /// Reads the pipeline's YAML from the repo and extracts its declared
    /// <c>parameters:</c>. Follows one level of <c>extends: template:</c> to a
    /// same-repo template if the entry file has no parameters of its own.
    /// </summary>
    private async Task<(List<PipelineParamDto> Parameters, List<PipelineResourceDto> Resources)> ScrapeYamlAsync(
        string project, string repoId, string? defaultBranch, string yamlPath, CancellationToken ct)
    {
        var branch = (defaultBranch ?? "refs/heads/main").Replace("refs/heads/", "");
        var text = await GetRepoFileTextAsync(project, repoId, yamlPath, branch, ct);
        if (text is null) return (new(), new());

        var root = ParseYamlRoot(text);
        if (root is null) return (new(), new());

        var resources = ExtractResources(root);
        var parameters = new List<PipelineParamDto>();

        // Direct parameters on the entry file.
        if (root.Children.TryGetValue(new YamlScalarNode("parameters"), out var pNode)
            && pNode is YamlSequenceNode seq)
        {
            parameters = ParseParamSequence(seq);
        }
        // Otherwise follow a local `extends: template: <path>`.
        else if (root.Children.TryGetValue(new YamlScalarNode("extends"), out var ext)
            && ext is YamlMappingNode extMap
            && extMap.Children.TryGetValue(new YamlScalarNode("template"), out var tmpl)
            && tmpl is YamlScalarNode tmplScalar)
        {
            var templatePath = tmplScalar.Value ?? "";
            var at = templatePath.IndexOf('@');
            var resource = at >= 0 ? templatePath[(at + 1)..] : "self";
            var pathOnly = at >= 0 ? templatePath[..at] : templatePath;
            if (resource == "self" && !string.IsNullOrWhiteSpace(pathOnly))
            {
                var resolved = ResolveRepoPath(yamlPath, pathOnly);
                var ttext = await GetRepoFileTextAsync(project, repoId, resolved, branch, ct);
                var troot = ttext is null ? null : ParseYamlRoot(ttext);
                if (troot is not null)
                {
                    var extra = ExtractResources(troot).Where(r => resources.All(x => x.Alias != r.Alias));
                    resources = resources.Concat(extra).ToList();
                    if (troot.Children.TryGetValue(new YamlScalarNode("parameters"), out var tp)
                        && tp is YamlSequenceNode tseq)
                        parameters = ParseParamSequence(tseq);
                }
            }
        }

        return (parameters, resources);
    }

    /// <summary>Extracts pipeline resources: resources: pipelines: - pipeline: &lt;alias&gt; source: &lt;name&gt; project: &lt;proj&gt;.</summary>
    private static List<PipelineResourceDto> ExtractResources(YamlMappingNode root)
    {
        var list = new List<PipelineResourceDto>();
        if (root.Children.TryGetValue(new YamlScalarNode("resources"), out var res)
            && res is YamlMappingNode resMap
            && resMap.Children.TryGetValue(new YamlScalarNode("pipelines"), out var pl)
            && pl is YamlSequenceNode plSeq)
        {
            foreach (var node in plSeq.Children.OfType<YamlMappingNode>())
            {
                var alias = Scalar(node, "pipeline");
                if (string.IsNullOrWhiteSpace(alias)) continue;
                list.Add(new PipelineResourceDto(alias!, Scalar(node, "source"), Scalar(node, "project")));
            }
        }
        return list;
    }

    // ---------------------------------------------------------------- pull requests

    /// <summary>Optional string property, or null when absent/not a string.</summary>
    private static string? Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    public async Task<List<RepoDto>> GetRepositoriesAsync(string project, CancellationToken ct)
    {
        using var doc = await SendJsonAsync(HttpMethod.Get,
            $"{OrgBase}/{Uri.EscapeDataString(project)}/_apis/git/repositories?api-version={ApiVersion}", null, null, null, ct);
        return doc.RootElement.GetProperty("value").EnumerateArray()
            .Select(r => new RepoDto(
                Str(r, "id") ?? "",
                Str(r, "name") ?? "",
                Str(r, "defaultBranch")))
            .OrderBy(r => r.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    public async Task<List<PullRequestDto>> GetPullRequestsAsync(
        string project, string repoId, string status, int top, CancellationToken ct)
    {
        using var doc = await SendJsonAsync(HttpMethod.Get,
            $"{OrgBase}/{Uri.EscapeDataString(project)}/_apis/git/repositories/{Uri.EscapeDataString(repoId)}/pullrequests" +
            $"?searchCriteria.status={Uri.EscapeDataString(status)}&$top={top}&api-version={ApiVersion}", null, null, null, ct);

        return doc.RootElement.GetProperty("value").EnumerateArray().Select(p =>
        {
            var author = p.TryGetProperty("createdBy", out var cb) ? Str(cb, "displayName") : null;

            // The signed-in user's own vote, so the review controls can show current state.
            // 10 approved · 5 approved with suggestions · 0 none · -5 waiting · -10 rejected.
            var myVote = 0;
            if (p.TryGetProperty("reviewers", out var revs) && revs.ValueKind == JsonValueKind.Array)
            {
                foreach (var r in revs.EnumerateArray())
                {
                    if (!string.Equals(Str(r, "id"), ctx.UserId, StringComparison.OrdinalIgnoreCase)) continue;
                    if (r.TryGetProperty("vote", out var v) && v.TryGetInt32(out var vote)) myVote = vote;
                    break;
                }
            }

            return new PullRequestDto(
                p.TryGetProperty("pullRequestId", out var id) ? id.GetInt32() : 0,
                Str(p, "title") ?? "",
                author,
                Str(p, "sourceRefName"),
                Str(p, "targetRefName"),
                Str(p, "status"),
                p.TryGetProperty("isDraft", out var dr) && dr.ValueKind == JsonValueKind.True,
                p.TryGetProperty("creationDate", out var cd) && cd.TryGetDateTime(out var when) ? when : null,
                p.TryGetProperty("lastMergeSourceCommit", out var sc) ? Str(sc, "commitId") : null,
                p.TryGetProperty("lastMergeTargetCommit", out var tc) ? Str(tc, "commitId") : null,
                myVote,
                Str(p, "mergeStatus"));
        }).ToList();
    }

    /// <summary>
    /// Casts the signed-in user's review vote. The reviewer id is their ADO identity, which is
    /// also this app's user id (both come from connectionData at sign-in). ADO adds the user as
    /// a reviewer implicitly if they weren't one already.
    /// </summary>
    public async Task<int> SetVoteAsync(string project, string repoId, int prId, int vote, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(ctx.UserId))
            throw new AdoException(401, "Not connected to Azure DevOps.");

        using var doc = await SendJsonAsync(HttpMethod.Put,
            $"{PrBase(project, repoId, prId)}/reviewers/{ctx.UserId}?api-version={ApiVersion}",
            null, null, new { vote }, ct);
        return doc.RootElement.TryGetProperty("vote", out var v) && v.TryGetInt32(out var cast) ? cast : vote;
    }

    /// <summary>
    /// Files touched by a PR. Uses the latest iteration's change entries, which is what
    /// reviewers actually mean by "what changed" (ADO recomputes these per push).
    /// </summary>
    public async Task<List<PrChangeDto>> GetPullRequestChangesAsync(
        string project, string repoId, int prId, CancellationToken ct)
    {
        var basePr = $"{OrgBase}/{Uri.EscapeDataString(project)}/_apis/git/repositories/{Uri.EscapeDataString(repoId)}" +
                     $"/pullRequests/{prId}";

        using var iters = await SendJsonAsync(HttpMethod.Get, $"{basePr}/iterations?api-version={ApiVersion}", null, null, null, ct);
        var last = iters.RootElement.GetProperty("value").EnumerateArray().LastOrDefault();
        if (last.ValueKind != JsonValueKind.Object) return new();
        var iterationId = last.TryGetProperty("id", out var iid) ? iid.GetInt32() : 1;

        using var doc = await SendJsonAsync(HttpMethod.Get,
            $"{basePr}/iterations/{iterationId}/changes?api-version={ApiVersion}&$top=1000", null, null, null, ct);

        var list = new List<PrChangeDto>();
        if (!doc.RootElement.TryGetProperty("changeEntries", out var entries)) return list;
        foreach (var e in entries.EnumerateArray())
        {
            if (!e.TryGetProperty("item", out var item)) continue;
            // Folders come through as changes too; only files have content to diff.
            if (item.TryGetProperty("isFolder", out var f) && f.ValueKind == JsonValueKind.True) continue;
            var path = Str(item, "path");
            if (string.IsNullOrWhiteSpace(path)) continue;
            list.Add(new PrChangeDto(path!, Str(e, "changeType") ?? "edit", Str(item, "originalPath")));
        }
        return list.OrderBy(c => c.Path, StringComparer.OrdinalIgnoreCase).ToList();
    }

    // ------------------------------------------------------ pr comment threads

    private string PrBase(string project, string repoId, int prId) =>
        $"{OrgBase}/{Uri.EscapeDataString(project)}/_apis/git/repositories/{Uri.EscapeDataString(repoId)}/pullRequests/{prId}";

    private static PrThreadDto ReadThread(JsonElement t)
    {
        var comments = new List<PrCommentDto>();
        if (t.TryGetProperty("comments", out var cs) && cs.ValueKind == JsonValueKind.Array)
        {
            foreach (var c in cs.EnumerateArray())
            {
                comments.Add(new PrCommentDto(
                    c.TryGetProperty("id", out var cid) ? cid.GetInt32() : 0,
                    c.TryGetProperty("parentCommentId", out var pid) ? pid.GetInt32() : 0,
                    c.TryGetProperty("author", out var a) ? Str(a, "displayName") : null,
                    Str(c, "content") ?? "",
                    c.TryGetProperty("publishedDate", out var pd) && pd.TryGetDateTime(out var when) ? when : null,
                    Str(c, "commentType"),
                    c.TryGetProperty("isDeleted", out var cdel) && cdel.ValueKind == JsonValueKind.True));
            }
        }

        string? filePath = null;
        int? rightLine = null, leftLine = null;
        if (t.TryGetProperty("threadContext", out var tcx) && tcx.ValueKind == JsonValueKind.Object)
        {
            filePath = Str(tcx, "filePath");
            if (tcx.TryGetProperty("rightFileStart", out var rs) && rs.ValueKind == JsonValueKind.Object &&
                rs.TryGetProperty("line", out var rl)) rightLine = rl.GetInt32();
            if (tcx.TryGetProperty("leftFileStart", out var ls) && ls.ValueKind == JsonValueKind.Object &&
                ls.TryGetProperty("line", out var ll)) leftLine = ll.GetInt32();
        }

        return new PrThreadDto(
            t.TryGetProperty("id", out var tid) ? tid.GetInt32() : 0,
            Str(t, "status"),
            filePath,
            rightLine,
            leftLine,
            t.TryGetProperty("isDeleted", out var del) && del.ValueKind == JsonValueKind.True,
            comments);
    }

    /// <summary>
    /// All comment threads on a PR. Includes ADO's own system threads ("X voted…"), which have
    /// no file context — the caller filters those out of the file view.
    /// </summary>
    public async Task<List<PrThreadDto>> GetPullRequestThreadsAsync(
        string project, string repoId, int prId, CancellationToken ct)
    {
        using var doc = await SendJsonAsync(HttpMethod.Get,
            $"{PrBase(project, repoId, prId)}/threads?api-version={ApiVersion}", null, null, null, ct);
        return doc.RootElement.GetProperty("value").EnumerateArray()
            .Select(ReadThread)
            .Where(t => !t.IsDeleted)
            .ToList();
    }

    /// <summary>Starts a thread anchored to a line. Offsets are 1-based columns; ADO needs both
    /// a start and an end, so a whole-line comment spans the same line twice.</summary>
    public async Task<PrThreadDto> CreateThreadAsync(
        string project, string repoId, int prId, NewThreadRequest body, CancellationToken ct)
    {
        var pos = new { line = body.Line, offset = 1 };
        object context = body.OnLeft
            ? new { filePath = body.FilePath, leftFileStart = pos, leftFileEnd = pos }
            : new { filePath = body.FilePath, rightFileStart = pos, rightFileEnd = pos };

        var payload = new
        {
            comments = new[] { new { parentCommentId = 0, content = body.Content, commentType = 1 } },
            status = 1, // active
            threadContext = context,
        };

        using var doc = await SendJsonAsync(HttpMethod.Post,
            $"{PrBase(project, repoId, prId)}/threads?api-version={ApiVersion}", null, null, payload, ct);
        return ReadThread(doc.RootElement);
    }

    public async Task<PrCommentDto> ReplyToThreadAsync(
        string project, string repoId, int prId, int threadId, string content, CancellationToken ct)
    {
        var payload = new { parentCommentId = 1, content, commentType = 1 };
        using var doc = await SendJsonAsync(HttpMethod.Post,
            $"{PrBase(project, repoId, prId)}/threads/{threadId}/comments?api-version={ApiVersion}",
            null, null, payload, ct);
        var c = doc.RootElement;
        return new PrCommentDto(
            c.TryGetProperty("id", out var cid) ? cid.GetInt32() : 0,
            c.TryGetProperty("parentCommentId", out var pid) ? pid.GetInt32() : 0,
            c.TryGetProperty("author", out var a) ? Str(a, "displayName") : null,
            Str(c, "content") ?? content,
            c.TryGetProperty("publishedDate", out var pd) && pd.TryGetDateTime(out var when) ? when : null,
            Str(c, "commentType"),
            false);
    }

    /// <summary>active | fixed | wontFix | closed | byDesign | pending</summary>
    public async Task<PrThreadDto> SetThreadStatusAsync(
        string project, string repoId, int prId, int threadId, string status, CancellationToken ct)
    {
        using var doc = await SendJsonAsync(HttpMethod.Patch,
            $"{PrBase(project, repoId, prId)}/threads/{threadId}?api-version={ApiVersion}",
            null, null, new { status }, ct);
        return ReadThread(doc.RootElement);
    }

    /// <summary>One side of a file at a specific commit. Null when the file doesn't exist there
    /// (an add has no "before", a delete has no "after"), which the diff renders as empty.</summary>
    public async Task<string?> GetFileAtCommitAsync(
        string project, string repoId, string path, string commitId, CancellationToken ct)
    {
        var url = $"{OrgBase}/{Uri.EscapeDataString(project)}/_apis/git/repositories/{Uri.EscapeDataString(repoId)}/items" +
                  $"?path={Uri.EscapeDataString(path)}&versionDescriptor.version={Uri.EscapeDataString(commitId)}" +
                  $"&versionDescriptor.versionType=commit&includeContent=true&$format=text&api-version={ApiVersion}";
        try { return await SendTextAsync(HttpMethod.Get, url, ct); }
        catch (AdoException) { return null; }
    }

    private async Task<string?> GetRepoFileTextAsync(
        string project, string repoId, string path, string branch, CancellationToken ct)
    {
        var url = $"{OrgBase}/{Uri.EscapeDataString(project)}/_apis/git/repositories/{repoId}/items" +
                  $"?path={Uri.EscapeDataString(path)}&versionDescriptor.version={Uri.EscapeDataString(branch)}" +
                  $"&versionDescriptor.versionType=branch&includeContent=true&$format=text&api-version={ApiVersion}";
        try { return await SendTextAsync(HttpMethod.Get, url, ct); }
        catch (AdoException) { return null; }
    }

    private static YamlMappingNode? ParseYamlRoot(string text)
    {
        try
        {
            var stream = new YamlStream();
            using var reader = new StringReader(text);
            stream.Load(reader);
            if (stream.Documents.Count == 0) return null;
            return stream.Documents[0].RootNode as YamlMappingNode;
        }
        catch { return null; }
    }

    private static List<PipelineParamDto> ParseParamSequence(YamlSequenceNode seq)
    {
        var list = new List<PipelineParamDto>();
        foreach (var node in seq.Children.OfType<YamlMappingNode>())
        {
            var name = Scalar(node, "name");
            if (string.IsNullOrEmpty(name)) continue;

            var rawType = Scalar(node, "type") ?? "string";
            var def = Scalar(node, "default");

            List<string>? values = null;
            if (node.Children.TryGetValue(new YamlScalarNode("values"), out var vNode)
                && vNode is YamlSequenceNode vSeq)
                values = vSeq.Children.OfType<YamlScalarNode>().Select(s => s.Value ?? "").ToList();

            var uiType = values is { Count: > 0 }
                ? "enum"
                : rawType switch
                {
                    "boolean" => "boolean",
                    "number" => "number",
                    _ => "string",
                };

            list.Add(new PipelineParamDto(name, "parameter", uiType, def, true, values));
        }
        return list;
    }

    private static string? Scalar(YamlMappingNode node, string key) =>
        node.Children.TryGetValue(new YamlScalarNode(key), out var v) && v is YamlScalarNode s ? s.Value : null;

    /// <summary>Resolve a template path relative to the referencing yaml file.</summary>
    private static string ResolveRepoPath(string fromFile, string templatePath)
    {
        if (templatePath.StartsWith("/")) return templatePath.TrimStart('/');
        var dir = fromFile.Contains('/') ? fromFile[..fromFile.LastIndexOf('/')] : "";
        var combined = string.IsNullOrEmpty(dir) ? templatePath : $"{dir}/{templatePath}";
        // normalise ../ and ./ segments
        var parts = new List<string>();
        foreach (var seg in combined.Split('/', StringSplitOptions.RemoveEmptyEntries))
        {
            if (seg == ".") continue;
            if (seg == "..") { if (parts.Count > 0) parts.RemoveAt(parts.Count - 1); }
            else parts.Add(seg);
        }
        return string.Join('/', parts);
    }

    // --------------------------------------------------------------- runs

    public Task<RunDto> RunPipelineAsync(string project, int pipelineId, RunRequest req, CancellationToken ct) =>
        RunPipelineAsync(project, pipelineId, req.Branch, req.TemplateParameters, req.Variables, req.PipelineResources, null, ct);

    /// <summary>
    /// Triggers a pipeline run. <paramref name="pipelineResources"/> maps a pipeline
    /// resource alias to a version, and <paramref name="containerResources"/> maps a
    /// container resource alias to a tag — used to link a build's image into a deploy.
    /// </summary>
    public async Task<RunDto> RunPipelineAsync(
        string project, int pipelineId, string branch,
        IReadOnlyDictionary<string, string>? templateParameters,
        IReadOnlyDictionary<string, string>? variables,
        IReadOnlyDictionary<string, string>? pipelineResources,
        IReadOnlyDictionary<string, string>? containerResources,
        CancellationToken ct)
    {
        var resources = new Dictionary<string, object?>
        {
            ["repositories"] = new Dictionary<string, object?> { ["self"] = new { refName = ToRef(branch) } },
        };
        if (pipelineResources is { Count: > 0 })
            resources["pipelines"] = pipelineResources.ToDictionary(
                kv => kv.Key, kv => (object)new { version = kv.Value });
        if (containerResources is { Count: > 0 })
            resources["containers"] = containerResources.ToDictionary(
                kv => kv.Key, kv => (object)new { version = kv.Value });

        var body = new Dictionary<string, object?> { ["resources"] = resources };
        if (templateParameters is { Count: > 0 })
            body["templateParameters"] = templateParameters;
        if (variables is { Count: > 0 })
            body["variables"] = variables.ToDictionary(
                kv => kv.Key, kv => (object)new { value = kv.Value, isSecret = false });

        using var doc = await SendJsonAsync(
            HttpMethod.Post,
            $"{OrgBase}/{Uri.EscapeDataString(project)}/_apis/pipelines/{pipelineId}/runs?api-version={ApiVersion}",
            null, null, body, ct);

        var runId = doc.RootElement.GetProperty("id").GetInt32();
        await TryTagRunAsync(project, runId, ct);
        // pipelines run id == build id; fetch the richer build view
        return await GetRunAsync(project, runId, ct);
    }

    /// <summary>Best-effort: tag a run so launchpad-triggered runs are identifiable. Never fatal.</summary>
    private async Task TryTagRunAsync(string project, int buildId, CancellationToken ct)
    {
        try
        {
            using var _ = await SendJsonAsync(
                HttpMethod.Post,
                $"{OrgBase}/{Uri.EscapeDataString(project)}/_apis/build/builds/{buildId}/tags?api-version={ApiVersion}",
                null, null, new[] { LaunchpadTag }, ct);
        }
        catch { /* tagging is a nicety, not a requirement */ }
    }

    /// <summary>Sentinel branch value meaning "resolve to the user's most recent branch at run time".</summary>
    public const string SmartBranch = "__smart__";

    /// <summary>Cheap lookup of a pipeline's default branch (no YAML scrape).</summary>
    public async Task<string?> GetDefaultBranchAsync(string project, int pipelineId, CancellationToken ct)
    {
        using var doc = await SendJsonAsync(
            HttpMethod.Get,
            $"{OrgBase}/{Uri.EscapeDataString(project)}/_apis/build/definitions/{pipelineId}?api-version={ApiVersion}",
            null, null, null, ct);
        if (doc.RootElement.TryGetProperty("repository", out var repo)
            && repo.TryGetProperty("defaultBranch", out var db))
            return db.GetString()?.Replace("refs/heads/", "");
        return null;
    }

    /// <summary>The connected user's most recently worked-on branch for a pipeline's repo, else the default branch.</summary>
    public async Task<string?> GetMyRecentBranchAsync(string project, int pipelineId, CancellationToken ct)
    {
        using var doc = await SendJsonAsync(
            HttpMethod.Get,
            $"{OrgBase}/{Uri.EscapeDataString(project)}/_apis/build/definitions/{pipelineId}?api-version={ApiVersion}",
            null, null, null, ct);
        string? repoId = null, defaultBranch = null;
        if (doc.RootElement.TryGetProperty("repository", out var repo))
        {
            repoId = repo.TryGetProperty("id", out var ri) ? ri.GetString() : null;
            defaultBranch = repo.TryGetProperty("defaultBranch", out var db) ? db.GetString() : null;
        }
        var def = defaultBranch?.Replace("refs/heads/", "");
        if (repoId is null) return def;
        var branches = await GetBranchesAsync(project, repoId, defaultBranch, ct);
        return branches.FirstOrDefault(b => b.Mine)?.Name ?? def;
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

    /// <summary>Resolves a pipeline by name (as declared in a resource's `source`) and lists its recent runs.</summary>
    public async Task<List<RunDto>> GetRunsByPipelineNameAsync(string project, string name, int top, CancellationToken ct)
    {
        using var defs = await SendJsonAsync(
            HttpMethod.Get,
            $"{OrgBase}/{Uri.EscapeDataString(project)}/_apis/build/definitions" +
            $"?name={Uri.EscapeDataString(name)}&api-version={ApiVersion}",
            null, null, null, ct);

        var value = defs.RootElement.GetProperty("value");
        if (value.GetArrayLength() == 0) return new();
        var id = value[0].GetProperty("id").GetInt32();
        return await GetRunsAsync(project, id, top, ct);
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

        if (!doc.RootElement.TryGetProperty("records", out var records))
            return new();

        // Index every timeline record by id so we can walk parent chains to the owning job.
        var byId = new Dictionary<string, JsonElement>();
        foreach (var r in records.EnumerateArray())
            if (r.TryGetProperty("id", out var idEl) && idEl.GetString() is { } rid) byId[rid] = r;

        static int Order(JsonElement e) =>
            e.TryGetProperty("order", out var o) && o.ValueKind == JsonValueKind.Number ? o.GetInt32() : 0;

        JsonElement? Parent(JsonElement e) =>
            e.TryGetProperty("parentId", out var p) && p.ValueKind == JsonValueKind.String
            && p.GetString() is { } pid && byId.TryGetValue(pid, out var parent) ? parent : null;

        // The nearest ancestor-or-self record of the given type — the Job a task belongs to, or
        // the Stage that job belongs to.
        string? AncestorName(JsonElement r, string type)
        {
            var cur = r;
            for (var depth = 0; depth < 12; depth++)
            {
                if (string.Equals(cur.TryGetProperty("type", out var t) ? t.GetString() : null, type,
                        StringComparison.OrdinalIgnoreCase))
                    return cur.TryGetProperty("name", out var n) ? n.GetString() : null;
                if (Parent(cur) is not { } next) break;
                cur = next;
            }
            return null;
        }

        /*
         * A sort key built from the record's whole ancestry, root first.
         *
         * `order` in a timeline is only unique *among siblings*: the first job of every stage is
         * order 1, and so is the first task of every job. Sorting on (jobOrder, taskOrder) alone
         * therefore interleaved parallel jobs — stage A's step 1, then stage B's step 1, then
         * stage A's step 2 — which is the scattered list this replaces. Comparing whole paths
         * nests the records the way the timeline actually is, and the way Azure DevOps shows
         * them: stages in order, each job's steps contiguous beneath it.
         *
         * Zero-padded so an ordinal comparison sorts numerically, and so a shorter path sorts
         * ahead of the longer ones descending from it.
         */
        string PathKey(JsonElement r)
        {
            var chain = new List<int>();
            var cur = r;
            for (var depth = 0; depth < 12; depth++)
            {
                chain.Add(Order(cur));
                if (Parent(cur) is not { } next) break;
                cur = next;
            }
            chain.Reverse();
            return string.Join("/", chain.Select(o => o.ToString("D6")));
        }

        /*
         * Only tasks are steps. Stage, Phase and Job records carry logs of their own — the job's
         * being the concatenation of its tasks — so including them listed the job's name two or
         * three times before its actual steps. Azure DevOps shows tasks, so this does too.
         *
         * Falling back to every logged record if a timeline somehow has no tasks, rather than
         * rendering an empty panel.
         */
        static bool IsTask(JsonElement e) =>
            string.Equals(e.TryGetProperty("type", out var t) ? t.GetString() : null, "Task",
                StringComparison.OrdinalIgnoreCase);

        var logged = records.EnumerateArray()
            .Where(r => r.TryGetProperty("log", out var l) && l.ValueKind == JsonValueKind.Object)
            .ToList();
        var considered = logged.Any(IsTask) ? logged.Where(IsTask) : logged;

        var rows = new List<(string path, LogEntryDto entry)>();
        foreach (var r in considered)
        {
            var log = r.GetProperty("log");
            rows.Add((PathKey(r), new LogEntryDto(
                log.GetProperty("id").GetInt32(),
                r.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "",
                r.TryGetProperty("state", out var st) ? st.GetString() ?? "" : "",
                r.TryGetProperty("result", out var rs) && rs.ValueKind != JsonValueKind.Null ? rs.GetString() : null,
                r.TryGetProperty("lineCount", out var lc) && lc.ValueKind == JsonValueKind.Number ? lc.GetInt32() : null,
                AncestorName(r, "Job"),
                AncestorName(r, "Stage"))));
        }

        return rows
            .OrderBy(x => x.path, StringComparer.Ordinal)
            .Select(x => x.entry)
            .ToList();
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
