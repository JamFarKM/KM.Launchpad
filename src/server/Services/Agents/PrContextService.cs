using PipelineLaunchpad.Server.Models;

namespace PipelineLaunchpad.Server.Services.Agents;

/// <summary>
/// Builds a §5.1 context block from what Azure DevOps already gives us.
///
/// No adapter is ever expected to fetch anything — this is the seam between "Launchpad knows about
/// pull requests" and "an adapter knows about one provider", and it is deliberately the only place
/// the two meet.
/// </summary>
public class PrContextService(AdoService ado)
{
    /// <summary>
    /// Assemble the block for one pull request.
    ///
    /// <paramref name="question"/> feeds the truncation priority in §5.1 — files the reviewer
    /// named survive the cut first — so it is passed even though it is not itself part of the block.
    /// </summary>
    public async Task<PrContext> BuildAsync(
        string project, string repoId, PullRequestDto pr, string? question, CancellationToken ct)
    {
        var changes = await ado.GetPullRequestChangesAsync(project, repoId, pr.Id, ct);

        // Everything else is independent of the diff, so fetch it while the file work proceeds.
        var descriptionTask = SafeDescriptionAsync(project, repoId, pr.Id, ct);
        var workItemsTask = ado.GetPullRequestWorkItemsAsync(project, repoId, pr.Id, ct);
        var threadsTask = SafeThreadsAsync(project, repoId, pr.Id, ct);

        var files = new List<FileDiff>();
        foreach (var change in changes)
        {
            // Sequential on purpose: a PR with 200 files would otherwise open 200 concurrent
            // connections to Azure DevOps and get itself throttled, which reads as "the agent is
            // broken" rather than "we were rude".
            var diff = await FileDiffAsync(project, repoId, pr, change, ct);
            if (diff is not null) files.Add(diff);
        }

        var description = await descriptionTask;
        var workItems = await workItemsTask;
        var threads = await threadsTask;

        var pathsWithFindings = threads
            .Where(t => !string.IsNullOrEmpty(t.FilePath))
            .Select(t => t.FilePath!.TrimStart('/'))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

        return PrContextBuilder.Build(new PrContextInput(
            Repo: repoId,
            PullRequestId: pr.Id,
            SourceRef: pr.SourceRef,
            TargetRef: pr.TargetRef,
            Commit: pr.SourceCommit,
            Title: pr.Title,
            Description: description,
            WorkItems: workItems,
            Files: files,
            PathsWithFindings: pathsWithFindings), question);
    }

    /// <summary>
    /// One file's diff, from the two sides Launchpad already fetches for Monaco.
    ///
    /// A file we can't read is skipped rather than failing the whole request: a deleted binary or
    /// a permissions edge case shouldn't cost the reviewer their answer about the other forty.
    /// </summary>
    private async Task<FileDiff?> FileDiffAsync(
        string project, string repoId, PullRequestDto pr, PrChangeDto change, CancellationToken ct)
    {
        try
        {
            var path = change.Path.TrimStart('/');

            // An add has no before, a delete has no after — asking for the missing side would be
            // a guaranteed 404 per file.
            var isAdd = change.ChangeType.Contains("add", StringComparison.OrdinalIgnoreCase);
            var isDelete = change.ChangeType.Contains("delete", StringComparison.OrdinalIgnoreCase);

            var before = isAdd || pr.TargetCommit is null
                ? null
                : await ado.GetFileAtCommitAsync(project, repoId, path, pr.TargetCommit, ct);

            var after = isDelete || pr.SourceCommit is null
                ? null
                : await ado.GetFileAtCommitAsync(project, repoId, path, pr.SourceCommit, ct);

            if (before is null && after is null) return null;

            return UnifiedDiff.Build(path, change.ChangeType, before, after);
        }
        catch (AdoService.AdoException)
        {
            return null;
        }
    }

    private async Task<string?> SafeDescriptionAsync(string project, string repoId, int prId, CancellationToken ct)
    {
        try { return await ado.GetPullRequestDescriptionAsync(project, repoId, prId, ct); }
        catch (AdoService.AdoException) { return null; }
    }

    private async Task<List<PrThreadDto>> SafeThreadsAsync(string project, string repoId, int prId, CancellationToken ct)
    {
        try { return await ado.GetPullRequestThreadsAsync(project, repoId, prId, ct); }
        catch (AdoService.AdoException) { return []; }
    }
}
