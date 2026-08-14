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
            // Both, and they are not redundant: the joined prose is what gets replayed to the model
            // and what "Copy all" copies, the segments are what the panel renders.
            Answer = answer?.PlainText ?? "",
            SegmentsJson = answer is null ? null : JsonSerializer.Serialize(Wire(answer.Segments), Json),
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

    /// <summary>
    /// The turn's segments, as the panel renders them.
    ///
    /// A turn written before the shape changed has no <c>SegmentsJson</c>, and is read back as one
    /// segment carrying its old whole-answer provenance, citations and note. That is exactly what the
    /// old UI showed, so an existing thread reads the same as it always did — and the renderer never
    /// needs to know two shapes exist, which is the point of doing the fallback here.
    /// </summary>
    public static List<AnswerSegment> Segments(AgentThreadTurn turn)
    {
        if (!string.IsNullOrWhiteSpace(turn.SegmentsJson))
        {
            try
            {
                var wire = JsonSerializer.Deserialize<List<WireSegment>>(turn.SegmentsJson, Json);
                if (wire is { Count: > 0 })
                    return wire.Select(w => new AnswerSegment(
                        w.Text ?? "",
                        ProvenanceNames.Parse(w.Provenance),
                        w.Citations ?? [],
                        w.InferenceNote)).ToList();
            }
            catch (JsonException)
            {
                // Fall through to the legacy shape rather than losing the turn.
            }
        }

        if (turn.Answer.Length == 0) return [];

        return [new AnswerSegment(
            turn.Answer,
            ProvenanceNames.Parse(turn.Provenance),
            LegacyCitations(turn),
            turn.InferenceNote)];
    }

    private static List<Citation> LegacyCitations(AgentThreadTurn turn)
    {
        try { return JsonSerializer.Deserialize<List<Citation>>(turn.CitationsJson, Json) ?? []; }
        catch (JsonException) { return []; }
    }

    /// <summary>
    /// The stored shape, in wire naming rather than CLR naming.
    ///
    /// Written explicitly instead of serialising <see cref="AnswerSegment"/> directly, because that
    /// record's <c>Provenance</c> is an enum: the default serialiser writes it as a number, and a
    /// stored <c>0</c> would silently become "code" if the enum's members were ever reordered.
    /// </summary>
    private record WireSegment(string? Text, string? Provenance, List<Citation>? Citations, string? InferenceNote);

    private static List<WireSegment> Wire(IEnumerable<AnswerSegment> segments) =>
        segments.Select(s => new WireSegment(
            s.Text,
            s.Provenance is { } p ? ProvenanceNames.ToWire(p) : null,
            s.Citations,
            s.InferenceNote)).ToList();
}
