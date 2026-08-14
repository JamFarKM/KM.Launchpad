using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using PipelineLaunchpad.Server.Data;
using PipelineLaunchpad.Server.Services.Agents;

namespace PipelineLaunchpad.Server.Tests;

public class ThreadStoreTests : IDisposable
{
    private readonly SqliteConnection _connection;
    private readonly AppDbContext _db;
    private readonly ThreadStore _store;

    public ThreadStoreTests()
    {
        // A real SQLite database in memory, not an in-memory provider: the foreign keys and the
        // cascade behaviour are the things under test, and the fake provider enforces neither.
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();
        _db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
        _db.Database.EnsureCreated();
        _store = new ThreadStore(_db);
    }

    public void Dispose()
    {
        _db.Dispose();
        _connection.Dispose();
    }

    private static Connector Agent(string name = "Claude") => new()
    {
        Id = Guid.NewGuid().ToString("N"),
        UserId = "u1",
        Provider = "anthropic",
        Name = name,
        Model = "claude-sonnet-4-5",
        AuthType = "api_key",
        TokenCiphertext = "x",
        CreatedAt = DateTime.UtcNow,
    };

    private static CanonicalAnswer Answer(
        string text = "It adds five procedures.",
        Provenance? provenance = Provenance.Code,
        StructuredMode mode = StructuredMode.Structured,
        string? note = null) =>
        new(text, provenance, [new Citation("a.sql", 22, null)], note, mode);

    private Task<AgentThread> Thread() => _store.GetOrCreateAsync("u1", "Account", "Account", 80494, default);

    [Fact]
    public async Task Creates_one_thread_per_reviewer_and_pull_request()
    {
        var first = await Thread();
        var again = await Thread();

        Assert.Equal(first.Id, again.Id);
        Assert.Single(_db.AgentThreads);
    }

    [Fact]
    public async Task Two_reviewers_on_one_pull_request_get_separate_threads()
    {
        var mine = await Thread();
        var theirs = await _store.GetOrCreateAsync("u2", "Account", "Account", 80494, default);

        // Threads are private to the reviewer, so these must never merge.
        Assert.NotEqual(mine.Id, theirs.Id);
    }

    [Fact]
    public async Task Numbers_turns_in_order()
    {
        var thread = await Thread();
        await _store.AppendAsync(thread, "one", Answer(), Agent(), "sha", null, false, null, default);
        await _store.AppendAsync(thread, "two", Answer(), Agent(), "sha", null, false, null, default);

        var turns = await _store.TurnsAsync(thread.Id, default);
        Assert.Equal([1, 2], turns.Select(t => t.Ordinal));
        Assert.Equal(["one", "two"], turns.Select(t => t.Question));
    }

    [Fact]
    public async Task Records_the_commit_each_turn_was_answered_against()
    {
        // The stale-commit banner compares this to the PR head, so it has to be per turn rather
        // than per thread — a thread outlives several pushes.
        var thread = await Thread();
        await _store.AppendAsync(thread, "q", Answer(), Agent(), "a3f9c21", null, false, null, default);

        var turn = (await _store.TurnsAsync(thread.Id, default)).Single();
        Assert.Equal("a3f9c21", turn.CommitSha);
    }

    [Fact]
    public async Task Records_token_usage_when_the_provider_reports_it()
    {
        var thread = await Thread();
        await _store.AppendAsync(thread, "q", Answer(), Agent(), "sha",
            new AgentUsage(1200, 340), false, null, default);

        var turn = (await _store.TurnsAsync(thread.Id, default)).Single();
        Assert.Equal(1200, turn.PromptTokens);
        Assert.Equal(340, turn.CompletionTokens);
    }

    [Fact]
    public async Task Keeps_the_connector_name_so_attribution_survives_its_deletion()
    {
        var thread = await Thread();
        var connector = Agent("BetBot");
        _db.Connectors.Add(connector);
        await _db.SaveChangesAsync();

        await _store.AppendAsync(thread, "q", Answer(), connector, "sha", null, false, null, default);

        // Remove the agent, exactly as §7.5 says a reviewer may.
        _db.Connectors.Remove(connector);
        await _db.SaveChangesAsync();

        var turn = (await _store.TurnsAsync(thread.Id, default)).Single();
        // The turn survives — a thread is a record of what the reviewer asked, and removing an
        // agent does not un-ask it.
        Assert.Equal("BetBot", turn.ConnectorName);
        Assert.Equal("It adds five procedures.", turn.Answer);
    }

    [Fact]
    public async Task Deleting_a_thread_takes_its_turns_with_it()
    {
        var thread = await Thread();
        await _store.AppendAsync(thread, "q", Answer(), Agent(), "sha", null, false, null, default);

        _db.AgentThreads.Remove(thread);
        await _db.SaveChangesAsync();

        Assert.Empty(_db.AgentThreadTurns);
    }

    [Fact]
    public async Task Replays_only_the_last_twelve_exchanges()
    {
        var thread = await Thread();
        for (var i = 1; i <= 15; i++)
            await _store.AppendAsync(thread, $"q{i}", Answer($"a{i}"), Agent(), "sha", null, false, null, default);

        var replay = await _store.ReplayAsync(thread.Id, default);

        Assert.Equal(ThreadStore.ReplayTurnLimit, replay.Count);
        // The *recent* ones, and the record still holds all fifteen.
        Assert.Equal("q4", replay[0].Question);
        Assert.Equal("q15", replay[^1].Question);
        Assert.Equal(15, (await _store.TurnsAsync(thread.Id, default)).Count);
    }

    [Fact]
    public async Task Never_replays_a_failed_or_stopped_turn()
    {
        var thread = await Thread();
        await _store.AppendAsync(thread, "good", Answer("real answer"), Agent(), "sha", null, false, null, default);
        await _store.AppendAsync(thread, "failed", null, Agent(), "sha", null, false, AgentErrorCode.Upstream, default);
        await _store.AppendAsync(thread, "stopped", Answer("half an ans"), Agent(), "sha", null, true, null, default);

        var replay = await _store.ReplayAsync(thread.Id, default);

        // Replaying half an answer as though the agent had finished it would teach it to continue
        // from something it never said.
        Assert.Single(replay);
        Assert.Equal("good", replay[0].Question);
    }

    [Fact]
    public async Task Replays_the_prose_only_never_the_envelope()
    {
        var thread = await Thread();
        await _store.AppendAsync(thread, "q", Answer("just the prose", note: null), Agent(), "sha", null, false, null, default);

        var replay = await _store.ReplayAsync(thread.Id, default);

        Assert.Equal("just the prose", replay[0].Answer);
        Assert.DoesNotContain("provenance", replay[0].Answer);
        Assert.DoesNotContain("citations", replay[0].Answer);
    }

    [Fact]
    public async Task Round_trips_citations()
    {
        var thread = await Thread();
        await _store.AppendAsync(thread, "q", Answer(), Agent(), "sha", null, false, null, default);

        var turn = (await _store.TurnsAsync(thread.Id, default)).Single();
        var citations = ThreadStore.Citations(turn);

        Assert.Equal("a.sql", Assert.Single(citations).Path);
        Assert.Equal(22, citations[0].Line);
        Assert.Null(citations[0].EndLine);
    }

    // ---------- postability (§7.4) ----------

    [Fact]
    public async Task A_structured_answer_is_postable()
    {
        var thread = await Thread();
        var turn = await _store.AppendAsync(thread, "q", Answer(), Agent(), "sha", null, false, null, default);
        Assert.True(ThreadStore.IsPostable(turn));
    }

    [Fact]
    public async Task A_mode_three_answer_is_not_postable()
    {
        // An answer whose source the agent never asserted should not become a permanent PR comment
        // carrying its name. The reviewer can still copy it.
        var thread = await Thread();
        var turn = await _store.AppendAsync(thread, "q",
            Answer(provenance: null, mode: StructuredMode.Unverified), Agent(), "sha", null, false, null, default);

        Assert.False(ThreadStore.IsPostable(turn));
    }

    [Fact]
    public async Task A_stopped_answer_is_not_postable()
    {
        var thread = await Thread();
        var turn = await _store.AppendAsync(thread, "q", Answer(), Agent(), "sha", null, true, null, default);
        Assert.False(ThreadStore.IsPostable(turn));
    }

    [Fact]
    public async Task A_failed_answer_is_not_postable()
    {
        var thread = await Thread();
        var turn = await _store.AppendAsync(thread, "q", null, Agent(), "sha", null, false,
            AgentErrorCode.Timeout, default);

        Assert.False(ThreadStore.IsPostable(turn));
        Assert.Equal("timeout", turn.ErrorCode);
    }
}
