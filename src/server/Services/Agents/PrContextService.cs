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
    /// How many Azure DevOps reads may be in flight at once while assembling a context block.
    ///
    /// Small on purpose. The point is to stop the round-trips being strictly serial, not to get as
    /// close to the rate limit as possible — Azure DevOps meters per user, and the PAT doing this
    /// work is the same one the rest of the app needs.
    /// </summary>
    private const int MaxConcurrentReads = 5;

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

        /* Bounded, not sequential and not unbounded.
         *
         * Two round-trips per file, all of it on the critical path before the agent sees anything,
         * so one-at-a-time made a forty-file pull request eighty serial calls to Azure DevOps —
         * comfortably the slowest thing about asking a question. The original reasoning against
         * concurrency stands and is preserved: firing all 200 files at once gets the request
         * throttled, which reads as "the agent is broken" rather than "we were rude". That is an
         * argument against an unbounded fan-out, not against a small window.
         *
         * Results land in their own slot rather than being appended, so file order still follows
         * `changes` — §5.1's truncation drops from the end, and a reordered list would silently
         * change which files survive it.
         */
        var slots = new FileDiff?[changes.Count];
        await Parallel.ForEachAsync(
            Enumerable.Range(0, changes.Count),
            new ParallelOptions { MaxDegreeOfParallelism = MaxConcurrentReads, CancellationToken = ct },
            async (i, token) => slots[i] = await FileDiffAsync(project, repoId, pr, changes[i], token));

        var files = slots.Where(d => d is not null).Select(d => d!).ToList();

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
            PathsWithFindings: pathsWithFindings,
            NearbyPaths: await NearbyPathsAsync(project, repoId, pr, changes, ct)), question);
    }

    /// <summary>
    /// Unchanged files sitting beside the change, for orientation.
    ///
    /// Bounded deliberately: the directories the change touches, plus the repository root. A full
    /// tree of a large repo is hundreds of KB of paths, which would spend the agent's whole reading
    /// budget before it read a line of code. This is enough to see the V1 file beside the V2 one and
    /// to ask for a real path instead of guessing at one; anything deeper is a list_files call.
    /// </summary>
    private async Task<List<string>> NearbyPathsAsync(
        string project, string repoId, PullRequestDto pr, List<PrChangeDto> changes, CancellationToken ct)
    {
        if (pr.SourceCommit is null) return [];

        var changed = changes.Select(c => c.Path.TrimStart('/'))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        var directories = changed
            .Select(p => p.Contains('/') ? p[..p.LastIndexOf('/')] : "")
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(6)   // a sprawling change should not turn orientation into a directory dump
            .ToList();
        if (!directories.Contains("")) directories.Add("");

        /* Fetched concurrently, assembled sequentially. The 120-path cap below is order-dependent —
           it keeps the earliest directories and drops the rest — so the listings are gathered into
           position first and only then walked in order. Doing the cap inside the parallel loop
           would make which paths survive depend on which response arrived first. */
        var listings = new List<(string Path, bool IsFolder)>?[directories.Count];
        await Parallel.ForEachAsync(
            Enumerable.Range(0, directories.Count),
            new ParallelOptions { MaxDegreeOfParallelism = MaxConcurrentReads, CancellationToken = ct },
            async (i, token) =>
            {
                // A directory we cannot list is not worth failing over.
                try { listings[i] = await ado.ListRepoItemsAsync(project, repoId, directories[i], pr.SourceCommit, token); }
                catch (AdoService.AdoException) { listings[i] = null; }
            });

        var nearby = new List<string>();
        foreach (var entries in listings)
        {
            if (entries is null) continue;
            foreach (var (path, isFolder) in entries)
            {
                // Folders are listed with a trailing slash so the agent can tell what it can
                // descend into from what it can read.
                var display = isFolder ? path + "/" : path;
                if (!isFolder && changed.Contains(path)) continue;   // already in the diff
                if (nearby.Count >= 120) return nearby;              // hard stop on orientation
                nearby.Add(display);
            }
        }
        return nearby;
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
