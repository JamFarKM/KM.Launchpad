using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using PipelineLaunchpad.Server.Data;

namespace PipelineLaunchpad.Server.Services.Agents;

/// <summary>
/// Reads and appends conversations (DESIGN_SPEC_CONNECTORS.md §7.5).
///
/// Launchpad owns the thread; connectors stay stateless and therefore interchangeable. The whole
/// history is replayed on every request in canonical form, before any adapter sees it, which is
/// what lets the provider underneath a thread change mid-conversation.
/// </summary>
public class ThreadStore(AppDbContext db)
{
    /// <summary>
    /// §5.A's cap. Older turns are dropped from the replay rather than from the record: the
    /// reviewer still sees their whole thread, the agent just isn't re-fed all of it.
    /// </summary>
    public const int ReplayTurnLimit = 12;

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public async Task<AgentThread?> FindAsync(
        string userId, string project, string repoId, int prId, CancellationToken ct) =>
        await db.AgentThreads.FirstOrDefaultAsync(t =>
            t.UserId == userId && t.Project == project && t.RepoId == repoId && t.PullRequestId == prId, ct);

    public async Task<AgentThread> GetOrCreateAsync(
        string userId, string project, string repoId, int prId, CancellationToken ct)
    {
        var existing = await FindAsync(userId, project, repoId, prId, ct);
        if (existing is not null) return existing;

        var thread = new AgentThread
        {
            Id = Guid.NewGuid().ToString("N"),
            UserId = userId,
            Project = project,
            RepoId = repoId,
            PullRequestId = prId,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow,
        };
        db.AgentThreads.Add(thread);
        await db.SaveChangesAsync(ct);
        return thread;
    }

    public async Task<List<AgentThreadTurn>> TurnsAsync(string threadId, CancellationToken ct) =>
        await db.AgentThreadTurns
            .Where(t => t.ThreadId == threadId)
            .OrderBy(t => t.Ordinal)
            .ToListAsync(ct);

    /// <summary>
    /// The history to replay, oldest first.
    ///
    /// Turns that failed, were stopped, or produced no prose are skipped: replaying half an answer
    /// as though the agent had said it would teach it to continue from something it never finished.
    /// Only the last <see cref="ReplayTurnLimit"/> exchanges are sent.
    /// </summary>
    public async Task<List<AgentTurn>> ReplayAsync(string threadId, CancellationToken ct)
    {
        var turns = await TurnsAsync(threadId, ct);

        return turns
            .Where(t => t.ErrorCode is null && !t.Stopped && t.Answer.Length > 0)
            .TakeLast(ReplayTurnLimit)
            .Select(t => new AgentTurn(t.Question, t.Answer))
            .ToList();
    }

    /// <summary>Appends a turn, whatever its outcome — including a failure, which is part of the record.</summary>
    public async Task<AgentThreadTurn> AppendAsync(
        AgentThread thread,
        string question,
        CanonicalAnswer? answer,
        Connector? connector,
        string? commitSha,
        AgentUsage? usage,
        bool stopped,
        AgentErrorCode? errorCode,
        CancellationToken ct)
    {
        var last = await db.AgentThreadTurns
            .Where(t => t.ThreadId == thread.Id)
            .OrderByDescending(t => t.Ordinal)
            .Select(t => (int?)t.Ordinal)
            .FirstOrDefaultAsync(ct) ?? 0;

        var turn = new AgentThreadTurn
        {
            Id = Guid.NewGuid().ToString("N"),
            ThreadId = thread.Id,
            Ordinal = last + 1,
            Question = question,
            Answer = answer?.Answer ?? "",
            Provenance = answer?.Provenance is { } p ? ProvenanceNames.ToWire(p) : null,
            CitationsJson = JsonSerializer.Serialize(answer?.Citations ?? [], Json),
            InferenceNote = answer?.InferenceNote,
            Mode = (answer?.Mode ?? StructuredMode.Unverified).ToString().ToLowerInvariant(),
            ConnectorId = connector?.Id,
            // Denormalised so §7.4's attribution survives the connector's deletion.
            ConnectorName = connector?.Name,
            Model = connector?.Model,
            CommitSha = commitSha,
            PromptTokens = usage?.PromptTokens,
            CompletionTokens = usage?.CompletionTokens,
            Stopped = stopped,
            ErrorCode = errorCode?.ToString().ToLowerInvariant(),
            CreatedAt = DateTime.UtcNow,
        };

        db.AgentThreadTurns.Add(turn);
        thread.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        return turn;
    }

    /// <summary>
    /// Whether a turn's answer may be posted to the pull request (§7.4).
    ///
    /// Three kinds are not postable, and in each case the button is absent rather than disabled,
    /// because there is nothing the reviewer can do to make it postable: stopped, failed, or
    /// produced in mode 3, where the agent never asserted a source and so the text should not
    /// become a permanent comment carrying its name.
    /// </summary>
    public static bool IsPostable(AgentThreadTurn turn) =>
        !turn.Stopped && turn.ErrorCode is null && turn.Mode != "unverified" && turn.Answer.Length > 0;

    public static List<Citation> Citations(AgentThreadTurn turn)
    {
        try { return JsonSerializer.Deserialize<List<Citation>>(turn.CitationsJson, Json) ?? []; }
        catch (JsonException) { return []; }
    }
}
