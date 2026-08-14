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
        new([new AnswerSegment(text, provenance, [new Citation("a.sql", 22, null)], note)], mode);

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
    public async Task Round_trips_segments_with_their_own_citations()
    {
        var thread = await Thread();
        var answer = new CanonicalAnswer([
            new AnswerSegment("Grounded.", Provenance.Code, [new Citation("a.sql", 22, 30)], null),
            new AnswerSegment("A guess.", Provenance.Inferred, [], "Nobody wrote it down."),
        ]);
        await _store.AppendAsync(thread, "q", answer, Agent(), "sha", null, false, null, default);

        var turn = (await _store.TurnsAsync(thread.Id, default)).Single();
        var segments = ThreadStore.Segments(turn);

        Assert.Equal(2, segments.Count);
        Assert.Equal(Provenance.Code, segments[0].Provenance);
        Assert.Equal(30, Assert.Single(segments[0].Citations).EndLine);
        // The hedge stays on its own claim rather than becoming the whole turn's.
        Assert.Equal("Nobody wrote it down.", segments[1].InferenceNote);
        Assert.Empty(segments[1].Citations);
    }

    [Fact]
    public async Task Provenance_survives_the_round_trip_as_a_name_not_a_number()
    {
        var thread = await Thread();
        await _store.AppendAsync(thread, "q", Answer(provenance: Provenance.Doc), Agent(), "sha", null, false, null, default);

        var turn = (await _store.TurnsAsync(thread.Id, default)).Single();

        // Serialising the enum by value would store 1 here, and reordering the enum's members would
        // silently repaint every stored badge.
        Assert.Contains("\"doc\"", turn.SegmentsJson);
        Assert.Equal(Provenance.Doc, ThreadStore.Segments(turn)[0].Provenance);
    }

    [Fact]
    public async Task A_turn_written_before_the_segment_shape_still_reads_back()
    {
        // Turns already in a reviewer's thread have the old flat columns and no SegmentsJson. They
        // come back as one segment carrying the old whole-answer provenance and citations, which is
        // exactly what the panel used to show — so nothing is migrated and nothing is lost.
        var thread = await Thread();
        _db.AgentThreadTurns.Add(new AgentThreadTurn
        {
            Id = "legacy", ThreadId = thread.Id, Ordinal = 1,
            Question = "q",
            Answer = "It adds five procedures.",
            SegmentsJson = null,
            Provenance = "code",
            CitationsJson = """[{"path":"a.sql","line":22,"endLine":null}]""",
            Mode = "structured",
            CreatedAt = DateTime.UtcNow,
        });
        await _db.SaveChangesAsync();

        var segments = ThreadStore.Segments(_db.AgentThreadTurns.Single(t => t.Id == "legacy"));

        var only = Assert.Single(segments);
        Assert.Equal("It adds five procedures.", only.Text);
        Assert.Equal(Provenance.Code, only.Provenance);
        Assert.Equal("a.sql", Assert.Single(only.Citations).Path);
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

    // ---------- inline annotations (§7.6) ----------

    private Task<AgentThread> Annotation(string path = "a.sql", int line = 22, string? seed = "The claim.") =>
        _store.GetOrCreateAnnotationAsync("u1", "Account", "Account", 80494, path, line, null, "sha1", seed, default);

    [Fact]
    public async Task Opening_the_same_line_twice_returns_one_conversation()
    {
        var first = await Annotation();
        var again = await Annotation(seed: "A different claim, later.");

        // Two claims can cite the same line, and they belong in one conversation about that spot
        // rather than two cards fighting over one gutter marker. The seed is whichever opened it.
        Assert.Equal(first.Id, again.Id);
        Assert.Equal("The claim.", again.Seed);
        Assert.Single(_db.AgentThreads.Where(t => t.Kind == AgentThreadKinds.Annotation));
    }

    [Fact]
    public async Task A_leading_slash_does_not_create_a_second_annotation_on_the_same_line()
    {
        // The context block declares paths without one and Azure DevOps hands them back with one, so
        // the same line arrives in both shapes depending on where the citation came from.
        var bare = await Annotation("Scripts/a.sql");
        var slashed = await Annotation("/Scripts/a.sql");

        Assert.Equal(bare.Id, slashed.Id);
    }

    [Fact]
    public async Task An_annotation_is_not_the_main_conversation()
    {
        var main = await Thread();
        var annotation = await Annotation();

        Assert.NotEqual(main.Id, annotation.Id);
        // The main-thread lookup must not return an annotation, or the dock would start rendering a
        // conversation about one line as though it were the whole PR's.
        Assert.Equal(main.Id, (await _store.FindAsync("u1", "Account", "Account", 80494, default))!.Id);
    }

    [Fact]
    public async Task Annotations_are_private_to_the_reviewer_who_made_them()
    {
        await Annotation();

        // Not a default — a hard rule. These are never written to Azure DevOps and never shown to
        // another reviewer on the same pull request; the query filter is what stops that being an
        // accident rather than a decision.
        var mine = await _store.AnnotationsAsync("u1", "Account", "Account", 80494, default);
        var theirs = await _store.AnnotationsAsync("u2", "Account", "Account", 80494, default);

        Assert.Single(mine);
        Assert.Empty(theirs);
        Assert.Null(await _store.FindAnnotationAsync("u2", mine[0].Id, default));
    }

    [Fact]
    public async Task Resolving_keeps_the_annotation_and_its_turns()
    {
        var annotation = await Annotation();
        await _store.AppendAsync(annotation, "What about this line?", Answer(), Agent(), "sha1", null, false, null, default);

        await _store.SetStatusAsync(annotation, AgentThreadStatus.Resolved, default);

        // Resolving dims a marker and drops it from the cycle. It never deletes — same principle as
        // §7.5, and what makes `Show resolved` possible at all.
        Assert.Equal(AgentThreadStatus.Resolved, annotation.Status);
        Assert.Single(await _store.TurnsAsync(annotation.Id, default));

        await _store.SetStatusAsync(annotation, AgentThreadStatus.Open, default);
        Assert.Equal(AgentThreadStatus.Open, annotation.Status);
    }

    [Fact]
    public async Task An_annotations_replay_is_its_own_turns_not_the_main_conversations()
    {
        var main = await Thread();
        await _store.AppendAsync(main, "What does this PR change?", Answer("It adds five procedures."),
            Agent(), "sha1", null, false, null, default);

        var annotation = await Annotation();
        await _store.AppendAsync(annotation, "Why NOLOCK here?", Answer("Inherited, probably."),
            Agent(), "sha1", null, false, null, default);

        var replay = await _store.ReplayAsync(annotation.Id, default);

        // Pouring the dock's history into a line-scoped conversation would answer the wrong question.
        Assert.Single(replay);
        Assert.Equal("Why NOLOCK here?", replay[0].Question);
    }

    [Fact]
    public void The_annotation_prompt_note_names_the_line_and_quotes_the_claim()
    {
        var note = TaskPrompt.AnnotationScope("Scripts/a.sql", 22, "Every join carries NOLOCK.");

        Assert.Contains("Scripts/a.sql", note);
        Assert.Contains("line 22", note);
        // The seed is stated as something the agent already said, not replayed as a question nobody
        // asked — a fabricated user turn is a small lie the model then reasons from.
        Assert.Contains("You had already said", note);
        Assert.Contains("Every join carries NOLOCK.", note);
    }

    [Fact]
    public void The_annotation_prompt_note_omits_the_quote_when_there_is_no_claim()
    {
        var note = TaskPrompt.AnnotationScope("Scripts/a.sql", 22, null);

        Assert.Contains("line 22", note);
        Assert.DoesNotContain("You had already said", note);
    }
}
