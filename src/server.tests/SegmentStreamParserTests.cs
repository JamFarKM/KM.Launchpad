using System.Text.Json;
using PipelineLaunchpad.Server.Services.Agents;

namespace PipelineLaunchpad.Server.Tests;

/// <summary>
/// Exercises §5.2's parser.
///
/// The character-level cases the old flat-answer parser needed — split escapes, a held-back
/// <c>\u00</c>, an escaped quote inside prose — are gone, and their absence is the point: nothing is
/// emitted until it is valid JSON, so decoding is <see cref="JsonDocument"/>'s problem rather than
/// ours. What is left is the boundary detection, the caps, and the per-segment honesty rules.
/// </summary>
public class SegmentStreamParserTests
{
    /// <summary>Feed a payload one character at a time — the worst case a real stream can produce.</summary>
    private static (List<AnswerSegment> Streamed, CanonicalAnswer Answer) FeedByChar(string payload)
    {
        var parser = new SegmentStreamParser();
        var streamed = new List<AnswerSegment>();
        foreach (var ch in payload) streamed.AddRange(parser.Feed(ch.ToString()));
        return (streamed, parser.Finish());
    }

    private static object Segment(
        string text = "It adds five procedures.",
        string? provenance = "code",
        object? citations = null,
        string? note = null,
        string? severity = "info") => new
    {
        text,
        provenance,
        severity,
        citations = citations ?? Array.Empty<object>(),
        inference_note = note,
    };

    private static string Payload(params object[] segments) =>
        JsonSerializer.Serialize(new { segments });

    // ---------- boundaries ----------

    [Fact]
    public void Emits_a_segment_as_soon_as_its_element_closes_without_waiting_for_the_array()
    {
        var parser = new SegmentStreamParser();
        var first = parser.Feed("""{"segments":[{"text":"One.","provenance":"code","citations":[],"inference_note":nu""");

        // The element's own closing brace hasn't arrived yet, so there is nothing to render: half a
        // claim is not a claim.
        Assert.Empty(first);

        var second = parser.Feed("ll},");
        Assert.Single(second);
        Assert.Equal("One.", second[0].Text);
        // Rendered while the array is still open — the whole reason this is the streaming unit.
        Assert.False(parser.ArrayClosed);
    }

    [Fact]
    public void Reassembles_every_segment_when_fed_one_character_at_a_time()
    {
        var (streamed, answer) = FeedByChar(Payload(
            Segment("It adds five procedures."),
            Segment("Nothing is deleted.", "doc")));

        Assert.Equal(2, streamed.Count);
        Assert.Equal(["It adds five procedures.", "Nothing is deleted."], answer.Segments.Select(s => s.Text));
        Assert.Equal(Provenance.Doc, answer.Segments[1].Provenance);
    }

    [Fact]
    public void A_brace_in_a_segments_prose_does_not_look_like_a_nested_object()
    {
        var (streamed, answer) = FeedByChar(Payload(Segment("Use `${env}` here, not `{env}`.")));

        Assert.Single(streamed);
        Assert.Equal("Use `${env}` here, not `{env}`.", answer.Segments[0].Text);
    }

    [Fact]
    public void The_word_segments_inside_prose_is_not_mistaken_for_the_key()
    {
        var (_, answer) = FeedByChar(Payload(Segment("The proc returns \"segments\": rows, oddly.")));

        Assert.Single(answer.Segments);
        Assert.Contains("oddly", answer.Segments[0].Text);
    }

    [Fact]
    public void A_stream_that_dies_between_segments_keeps_the_ones_that_closed()
    {
        var parser = new SegmentStreamParser();
        parser.Feed("""{"segments":[{"text":"One.","provenance":"code","citations":[],"inference_note":null},""");
        // Cut off mid-second-segment, exactly as a killed connection would be.
        parser.Feed("""{"text":"Two, unfin""");

        var answer = parser.Finish();

        Assert.False(parser.ArrayClosed);
        Assert.Single(answer.Segments);
        Assert.Equal("One.", answer.Segments[0].Text);
        // §6: what arrived is kept. The caller renders it *plus* the typed error.
        Assert.Equal(StructuredMode.Structured, answer.Mode);
    }

    [Fact]
    public void Renders_in_one_go_when_everything_arrives_at_once()
    {
        // A non-streaming adapter, or one that can't split elements: same code path, same result.
        var parser = new SegmentStreamParser();
        var streamed = parser.Feed(Payload(Segment("One."), Segment("Two.", "doc")));

        Assert.Equal(2, streamed.Count);
        Assert.Equal(2, parser.Finish().Segments.Count);
    }

    // ---------- caps ----------

    [Fact]
    public void Caps_citations_at_four_per_segment_rather_than_failing_the_response()
    {
        var many = Enumerable.Range(1, 9).Select(i => new { path = "a.sql", line = i, end_line = (int?)null });
        var (_, answer) = FeedByChar(Payload(Segment(citations: many)));

        Assert.Equal(CanonicalSchema.MaxCitations, answer.Segments[0].Citations.Count);
        Assert.Equal(1, answer.Segments[0].Citations[0].Line);
    }

    [Fact]
    public void Caps_segments_at_six_and_says_so_on_the_last_one_it_kept()
    {
        var seven = Enumerable.Range(1, 7).Select(i => Segment($"Claim {i}.")).ToArray();
        var (streamed, answer) = FeedByChar(Payload(seven));

        Assert.Equal(CanonicalSchema.MaxSegments, answer.Segments.Count);
        Assert.Equal(CanonicalSchema.MaxSegments, streamed.Count);
        // A dropped citation can go quietly; a dropped claim cannot, so the reviewer is told.
        Assert.StartsWith("Claim 6.", answer.Segments[^1].Text);
        Assert.Contains("dropped", answer.Segments[^1].Text);
    }

    [Fact]
    public void Discards_a_reversed_line_range_but_keeps_the_anchor()
    {
        var (_, answer) = FeedByChar(Payload(Segment(
            citations: new[] { new { path = "a.sql", line = 40, end_line = (int?)12 } })));

        var citation = answer.Segments[0].Citations.Single();
        Assert.Equal(40, citation.Line);
        Assert.Null(citation.EndLine);
    }

    [Fact]
    public void Keeps_a_null_end_line_which_is_the_normal_single_line_case()
    {
        // TryGetInt32 throws on a JSON null rather than returning false, so the obvious-looking
        // version of this crashes on the first real citation an agent ever sends.
        var (_, answer) = FeedByChar(Payload(Segment(
            citations: new[] { new { path = "a.sql", line = 22, end_line = (int?)null } })));

        Assert.Null(answer.Segments[0].Citations.Single().EndLine);
    }

    // ---------- per-segment honesty ----------

    [Fact]
    public void An_inferred_segment_keeps_its_note()
    {
        var (_, answer) = FeedByChar(Payload(Segment(provenance: "inferred", note: "Nobody wrote it down.")));

        Assert.Equal(Provenance.Inferred, answer.Segments[0].Provenance);
        Assert.Equal("Nobody wrote it down.", answer.Segments[0].InferenceNote);
    }

    [Fact]
    public void An_inferred_segment_with_no_note_degrades_rather_than_showing_an_empty_hedge()
    {
        var (_, answer) = FeedByChar(Payload(Segment(provenance: "inferred", note: null)));

        Assert.Null(answer.Segments[0].Provenance);
        Assert.Null(answer.Segments[0].InferenceNote);
    }

    [Fact]
    public void A_note_on_a_grounded_segment_is_dropped_because_the_badge_is_the_claim()
    {
        var (_, answer) = FeedByChar(Payload(Segment(provenance: "code", note: "A stray hedge.")));

        Assert.Equal(Provenance.Code, answer.Segments[0].Provenance);
        Assert.Null(answer.Segments[0].InferenceNote);
    }

    [Fact]
    public void An_unrecognised_provenance_value_is_not_promoted_to_a_badge()
    {
        var (_, answer) = FeedByChar(Payload(Segment(provenance: "probably")));

        Assert.Null(answer.Segments[0].Provenance);
    }

    [Fact]
    public void One_segments_hedge_does_not_taint_another_in_the_same_answer()
    {
        // The specific defect the segment shape exists to prevent: a single badge over an answer that
        // holds both a grounded claim and a guess describes neither honestly.
        var (_, answer) = FeedByChar(Payload(
            Segment("It adds five procedures.", "code"),
            Segment("The NOLOCK pattern looks inherited.", "inferred", note: "Not recorded. Ask the author.")));

        Assert.Equal(Provenance.Code, answer.Segments[0].Provenance);
        Assert.Null(answer.Segments[0].InferenceNote);
        Assert.Equal(Provenance.Inferred, answer.Segments[1].Provenance);
        Assert.NotNull(answer.Segments[1].InferenceNote);
    }

    [Fact]
    public void A_connective_segment_with_no_citation_is_legal()
    {
        var (_, answer) = FeedByChar(Payload(Segment("A couple of things worth checking:", "doc")));

        Assert.Single(answer.Segments);
        Assert.Empty(answer.Segments[0].Citations);
        Assert.Equal(Provenance.Doc, answer.Segments[0].Provenance);
    }

    [Fact]
    public void A_segment_with_no_prose_is_not_a_claim_and_is_dropped()
    {
        var (_, answer) = FeedByChar(Payload(Segment(""), Segment("The real one.")));

        Assert.Single(answer.Segments);
        Assert.Equal("The real one.", answer.Segments[0].Text);
    }

    // ---------- severity, the other axis ----------

    [Fact]
    public void Reads_each_severity_level()
    {
        var (_, answer) = FeedByChar(Payload(
            Segment("Describes the change.", severity: "info"),
            Segment("Worth a look.", severity: "warning"),
            Segment("This is broken.", severity: "error")));

        Assert.Equal([Severity.Info, Severity.Warning, Severity.Error],
            answer.Segments.Select(s => s.Severity));
    }

    [Fact]
    public void An_ungraded_or_unrecognised_segment_is_information_not_a_problem()
    {
        var (_, answer) = FeedByChar(Payload(
            Segment("No severity at all.", severity: null),
            Segment("A made-up level.", severity: "critical")));

        // Defaulting the other way would make every schema slip look like a problem in the code being
        // reviewed, which is the one direction this must not fail in.
        Assert.All(answer.Segments, s => Assert.Equal(Severity.Info, s.Severity));
    }

    [Fact]
    public void Severity_and_provenance_are_independent()
    {
        var (_, answer) = FeedByChar(Payload(
            // Grounded in the diff and harmless.
            Segment("It adds five procedures.", "code", severity: "info"),
            // A hypothesis, and the most important thing on the page.
            Segment("This will deadlock under load.", "inferred", note: "Not recorded. Ask the author.",
                severity: "error")));

        Assert.Equal(Provenance.Code, answer.Segments[0].Provenance);
        Assert.Equal(Severity.Info, answer.Segments[0].Severity);
        Assert.Equal(Provenance.Inferred, answer.Segments[1].Provenance);
        Assert.Equal(Severity.Error, answer.Segments[1].Severity);
    }

    [Fact]
    public void A_hedge_with_no_note_loses_its_provenance_but_keeps_its_severity()
    {
        var (_, answer) = FeedByChar(Payload(
            Segment("This will deadlock.", "inferred", note: null, severity: "error")));

        // Losing confidence in where a claim came from is no reason to stop telling the reviewer it
        // might break something.
        Assert.Null(answer.Segments[0].Provenance);
        Assert.Equal(Severity.Error, answer.Segments[0].Severity);
    }

    // ---------- mode 3 ----------

    [Fact]
    public void Plain_prose_becomes_one_unverified_segment_with_no_guessed_provenance()
    {
        var parser = new SegmentStreamParser();
        parser.Feed("It adds five procedures, I think.");
        var answer = parser.Finish();

        // Mode 3 is not a second rendering path — it is one segment, so the renderer needs no branch.
        var only = Assert.Single(answer.Segments);
        Assert.Equal("It adds five procedures, I think.", only.Text);
        Assert.Null(only.Provenance);
        Assert.Empty(only.Citations);
        Assert.Equal(StructuredMode.Unverified, answer.Mode);
    }

    [Fact]
    public void An_object_that_is_not_the_schema_falls_back_to_the_prose_it_was_given()
    {
        var parser = new SegmentStreamParser();
        parser.Feed("""{"reply":"It adds five procedures."}""");
        var answer = parser.Finish("It adds five procedures.");

        Assert.Equal(StructuredMode.Unverified, answer.Mode);
        Assert.Equal("It adds five procedures.", answer.Segments[0].Text);
    }

    [Fact]
    public void An_empty_segments_array_falls_back_to_prose_when_there_is_any()
    {
        var parser = new SegmentStreamParser();
        parser.Feed("""{"segments":[]}""");
        var answer = parser.Finish("Fell back to this.");

        Assert.True(parser.ArrayClosed);
        Assert.Equal(StructuredMode.Unverified, answer.Mode);
        Assert.Equal("Fell back to this.", answer.Segments[0].Text);
    }

    [Fact]
    public void An_empty_answer_produces_no_segments_rather_than_one_empty_one()
    {
        // `{"segments":[]}` is schema-valid — there is no minItems in strict structured output — and a
        // model does return it, most often on a short conversational follow-up. This used to become a
        // single segment with no text, which stored and rendered as a provenance badge floating over
        // nothing: it told the reviewer the agent had said something unreadable, when it had said
        // nothing at all. No segments is the honest shape, and the caller turns it into an error.
        var parser = new SegmentStreamParser();
        parser.Feed("""{"segments":[]}""");
        var answer = parser.Finish("");

        Assert.Empty(answer.Segments);
        Assert.True(answer.IsEmpty);
    }

    [Fact]
    public void Segments_that_are_all_blank_are_treated_the_same_way()
    {
        var parser = new SegmentStreamParser();
        parser.Feed(Payload(Segment("   "), Segment("")));

        Assert.Empty(parser.Finish("").Segments);
    }

    // ---------- the one place an answer may become a string ----------

    [Fact]
    public void Plain_text_joins_the_segments_the_way_a_replayed_turn_is_joined()
    {
        var (_, answer) = FeedByChar(Payload(Segment("One."), Segment("Two.", "doc")));

        Assert.Equal("One.\n\nTwo.", answer.PlainText);
    }
}
