using System.Text.Json;
using PipelineLaunchpad.Server.Services.Agents;

namespace PipelineLaunchpad.Server.Tests;

public class CanonicalAnswerParserTests
{
    /// <summary>Feed a payload one character at a time — the worst case a real stream can produce.</summary>
    private static (string Prose, CanonicalAnswer Answer) FeedByChar(
        string payload, IReadOnlyCollection<string>? knownPaths = null)
    {
        var parser = new CanonicalAnswerParser();
        var prose = "";
        foreach (var ch in payload) prose += parser.Feed(ch.ToString());
        return (prose, parser.Finish(knownPaths: knownPaths));
    }

    private static string Payload(
        string answer = "It adds five procedures.",
        string provenance = "code",
        object? citations = null,
        string? note = null) =>
        JsonSerializer.Serialize(new Dictionary<string, object?>
        {
            ["answer"] = answer,
            ["provenance"] = provenance,
            ["citations"] = citations ?? Array.Empty<object>(),
            ["inference_note"] = note,
        });

    [Fact]
    public void Emits_prose_progressively_before_the_object_closes()
    {
        var parser = new CanonicalAnswerParser();
        // Everything up to and including part of the answer string, but no closing brace.
        parser.Feed("{\"answer\":\"It adds five");

        Assert.Equal("It adds five", parser.AnswerSoFar);
        Assert.False(parser.ObjectClosed);
    }

    [Fact]
    public void Reassembles_the_whole_answer_when_fed_one_character_at_a_time()
    {
        var (prose, answer) = FeedByChar(Payload());

        Assert.Equal("It adds five procedures.", prose);
        Assert.Equal("It adds five procedures.", answer.Answer);
        Assert.Equal(Provenance.Code, answer.Provenance);
        Assert.Equal(StructuredMode.Structured, answer.Mode);
    }

    [Fact]
    public void Decodes_escapes_that_arrive_split_across_fragments()
    {
        // The failure this guards: a fragment ending on the backslash, so a naive parser emits it
        // literally and the reviewer sees `line one\nline two`.
        var parser = new CanonicalAnswerParser();
        parser.Feed("{\"answer\":\"line one\\");
        parser.Feed("nline two\",\"provenance\":\"code\",\"citations\":[],\"inference_note\":null}");

        Assert.Equal("line one\nline two", parser.Finish().Answer);
    }

    [Fact]
    public void Holds_back_a_unicode_escape_until_all_four_digits_arrive()
    {
        var parser = new CanonicalAnswerParser();
        var first = parser.Feed("{\"answer\":\"caf\\u00");

        // Nothing of the escape may be emitted yet — half a code point is not a character.
        Assert.Equal("caf", first);

        var second = parser.Feed("e9 latte\"}");
        Assert.Equal("é latte", second);
        Assert.Equal("café latte", parser.AnswerSoFar);
    }

    [Fact]
    public void Keeps_an_escaped_quote_inside_the_prose()
    {
        // Pass the real text and let the serialiser escape it — pre-escaping here would test the
        // test's own quoting rather than the parser's decoding.
        var (_, answer) = FeedByChar(Payload(answer: "the \"V2\" procedures"));
        Assert.Equal("the \"V2\" procedures", answer.Answer);
    }

    [Fact]
    public void A_brace_in_the_prose_does_not_look_like_a_nested_object()
    {
        // If the depth tracker ignored strings it would still be waiting for a close here.
        var (_, answer) = FeedByChar(Payload(answer: "use ${BrandId} in the predicate {like this}"));

        Assert.Equal("use ${BrandId} in the predicate {like this}", answer.Answer);
        Assert.Equal(StructuredMode.Structured, answer.Mode);
    }

    [Fact]
    public void Renders_in_one_go_when_answer_arrives_last()
    {
        // §5.2: key order is a request, not a guarantee. Progressive rendering must degrade rather
        // than break — and it must never hang waiting for a key that already went past.
        var payload = JsonSerializer.Serialize(new Dictionary<string, object?>
        {
            ["provenance"] = "code",
            ["citations"] = Array.Empty<object>(),
            ["inference_note"] = null,
            ["answer"] = "metadata came first",
        });

        var (_, answer) = FeedByChar(payload);
        Assert.Equal("metadata came first", answer.Answer);
        Assert.Equal(Provenance.Code, answer.Provenance);
    }

    [Fact]
    public void Caps_citations_at_eight_rather_than_failing_the_response()
    {
        var many = Enumerable.Range(1, 20)
            .Select(i => new { path = "a.sql", line = i, end_line = (int?)null })
            .ToArray();

        var (_, answer) = FeedByChar(Payload(citations: many));

        Assert.Equal(CanonicalSchema.MaxCitations, answer.Citations.Count);
        Assert.Equal(1, answer.Citations[0].Line);
    }

    [Fact]
    public void Drops_citations_whose_path_is_not_in_the_context()
    {
        var citations = new object[]
        {
            new { path = "real.sql", line = 4, end_line = (int?)null },
            new { path = "invented.sql", line = 9, end_line = (int?)null },
        };

        var (_, answer) = FeedByChar(Payload(citations: citations), knownPaths: new[] { "real.sql" });

        Assert.Single(answer.Citations);
        Assert.Equal("real.sql", answer.Citations[0].Path);
    }

    [Fact]
    public void Keeps_every_citation_when_no_path_list_is_supplied()
    {
        var citations = new object[] { new { path = "anything.sql", line = 1, end_line = (int?)null } };
        var (_, answer) = FeedByChar(Payload(citations: citations));
        Assert.Single(answer.Citations);
    }

    [Fact]
    public void Discards_a_reversed_line_range_but_keeps_the_anchor()
    {
        var citations = new object[] { new { path = "a.sql", line = 40, end_line = (int?)12 } };
        var (_, answer) = FeedByChar(Payload(citations: citations));

        Assert.Equal(40, answer.Citations[0].Line);
        Assert.Null(answer.Citations[0].EndLine);
    }

    [Fact]
    public void An_inferred_answer_keeps_its_note()
    {
        var (_, answer) = FeedByChar(Payload(provenance: "inferred", note: "Not recorded anywhere."));

        Assert.Equal(Provenance.Inferred, answer.Provenance);
        Assert.Equal("Not recorded anywhere.", answer.InferenceNote);
    }

    [Fact]
    public void An_inferred_answer_with_no_note_degrades_rather_than_showing_an_empty_hedge()
    {
        var (_, answer) = FeedByChar(Payload(provenance: "inferred", note: null));

        Assert.Null(answer.Provenance);
        Assert.Equal(StructuredMode.Unverified, answer.Mode);
    }

    [Fact]
    public void A_note_on_a_grounded_answer_is_dropped_because_the_badge_is_the_claim()
    {
        var (_, answer) = FeedByChar(Payload(provenance: "code", note: "shouldn't be here"));

        Assert.Equal(Provenance.Code, answer.Provenance);
        Assert.Null(answer.InferenceNote);
    }

    [Fact]
    public void An_unrecognised_provenance_value_is_not_promoted_to_a_badge()
    {
        var (_, answer) = FeedByChar(Payload(provenance: "vibes"));

        Assert.Null(answer.Provenance);
        Assert.Equal(StructuredMode.Unverified, answer.Mode);
    }

    [Fact]
    public void Plain_prose_becomes_unverified_with_no_guessed_provenance()
    {
        var parser = new CanonicalAnswerParser();
        parser.Feed("This connector can't do structured output, so here's some prose.");

        var answer = parser.Finish();

        Assert.Null(answer.Provenance);
        Assert.Empty(answer.Citations);
        Assert.Equal(StructuredMode.Unverified, answer.Mode);
        Assert.StartsWith("This connector", answer.Answer);
    }

    [Fact]
    public void A_stream_that_dies_mid_answer_keeps_the_prose_it_managed()
    {
        var parser = new CanonicalAnswerParser();
        parser.Feed("{\"answer\":\"I was explaining the NOLOCK hints when");

        var answer = parser.Finish();

        Assert.Contains("NOLOCK", answer.Answer);
        // Nothing was asserted, so nothing is claimed — and §7.4 makes this unpostable.
        Assert.Null(answer.Provenance);
        Assert.Equal(StructuredMode.Unverified, answer.Mode);
    }

    [Fact]
    public void The_word_answer_inside_the_prose_is_not_mistaken_for_the_key()
    {
        var payload = JsonSerializer.Serialize(new Dictionary<string, object?>
        {
            ["provenance"] = "code",
            ["inference_note"] = "the \"answer\" is not recorded",
            ["citations"] = Array.Empty<object>(),
            ["answer"] = "the real answer",
        });

        var (_, answer) = FeedByChar(payload);
        Assert.Equal("the real answer", answer.Answer);
    }

    [Fact]
    public void An_empty_answer_string_is_treated_as_no_structured_answer()
    {
        var (_, answer) = FeedByChar(Payload(answer: ""));
        Assert.Equal(StructuredMode.Unverified, answer.Mode);
    }

    [Fact]
    public void Reports_the_object_as_closed_once_the_final_brace_arrives()
    {
        var parser = new CanonicalAnswerParser();
        parser.Feed(Payload(citations: new object[] { new { path = "a.sql", line = 1, end_line = (int?)null } }));
        Assert.True(parser.ObjectClosed);
    }
}
