using System.Runtime.CompilerServices;
using System.Text.Json;

namespace PipelineLaunchpad.Server.Services.Agents;

/// <summary>
/// An adapter that answers from a canned canonical response, without calling anything.
///
/// §8 step 2 builds the shared server code against exactly this, so the canonical shapes, the
/// parser, the fallback ladder and the SSE relay can be finished and tested before any real
/// provider is reachable. It also stays useful afterwards: it is the only way to exercise the
/// panel's states deterministically, including the ones that are awkward to provoke on purpose —
/// a mid-stream failure, an answer that mixes a grounded claim with a guess, or one that overruns
/// the segment cap.
///
/// Registered but never selectable as a provider: <see cref="ConnectorProviders.Selectable"/>
/// doesn't list it, so it cannot be created from the UI and cannot be reached by accident.
/// </summary>
public sealed class StubAdapter : IAgentAdapter
{
    public const string ProviderKey = "stub";

    /// <summary>How the stub should behave, chosen by the credential string so a test can pick.</summary>
    public enum Script { Structured, Inferred, Mixed, Overflow, Prose, FailMidStream }

    public string Provider => ProviderKey;

    private readonly TimeSpan _delay;

    public StubAdapter(TimeSpan? deltaDelay = null) => _delay = deltaDelay ?? TimeSpan.Zero;

    public Task<AgentProbe> ProbeAsync(AgentTarget target, CancellationToken ct) =>
        Task.FromResult(new AgentProbe(true, 1, ["stub-1", "stub-2"], null));

    public async IAsyncEnumerable<AgentEvent> CompleteAsync(
        AgentTarget target, CanonicalRequest request, [EnumeratorCancellation] CancellationToken ct)
    {
        var script = ScriptOf(target.Credential);

        if (request.ResponseKind == ResponseKind.ChangeMap)
        {
            var path = FirstPath(request.Context) ?? "unknown.sql";
            var json = JsonSerializer.Serialize(new
            {
                style = "unknown",
                style_basis = "inferred",
                groups = new[] { new { id = "g1", name = "Changed area", depth = 0, summary = "Everything changed here.", files = new[] { new { path, added = 1, removed = 0 } } } },
                edges = Array.Empty<object>(),
                flow = Array.Empty<object>(),
            });
            foreach (var chunk in Chunk(json, 17))
            {
                ct.ThrowIfCancellationRequested();
                if (_delay > TimeSpan.Zero) await Task.Delay(_delay, ct);
            }
            yield return new AgentEvent.MapComplete(json);
            yield break;
        }

        if (script == Script.Prose)
        {
            // Mode 3: no JSON at all. The parser has to reach "unverified" on its own rather than
            // being told, which is what makes this worth testing.
            const string text = "This pull request adds five stored procedures. "
                              + "I can't say where that came from in a structured way.";
            foreach (var chunk in Chunk(text, 12))
            {
                ct.ThrowIfCancellationRequested();
                if (_delay > TimeSpan.Zero) await Task.Delay(_delay, ct);
                yield return new AgentEvent.Delta(chunk);
            }
            yield return new AgentEvent.Complete(
                new CanonicalAnswer([new AnswerSegment(text, null, [], null)], StructuredMode.Unverified));
            yield break;
        }

        var payload = PayloadFor(script, request);
        var parser = new SegmentStreamParser();

        // 17 characters at a time, which lands mid-token and mid-escape often enough to be a real
        // test of the boundary detection rather than a formality.
        var closed = 0;
        foreach (var chunk in Chunk(payload, 17))
        {
            ct.ThrowIfCancellationRequested();
            if (_delay > TimeSpan.Zero) await Task.Delay(_delay, ct);

            foreach (var segment in parser.Feed(chunk))
            {
                closed++;
                yield return new AgentEvent.Segment(segment);
            }

            // Die once a whole segment has landed, so the panel has a real partial answer to keep
            // beside the error — the case §6 cares about.
            if (script == Script.FailMidStream && closed >= 1)
            {
                yield return new AgentEvent.Failed(new AgentError(AgentErrorCode.Upstream, 500,
                    "The stub was asked to fail mid-stream."));
                yield break;
            }
        }

        yield return new AgentEvent.Complete(parser.Finish());
    }

    private static Script ScriptOf(string credential) => credential switch
    {
        "inferred" => Script.Inferred,
        "mixed" => Script.Mixed,
        "overflow" => Script.Overflow,
        "prose" => Script.Prose,
        "fail" => Script.FailMidStream,
        _ => Script.Structured,
    };

    private static string PayloadFor(Script script, CanonicalRequest request)
    {
        // Cite the first path the context actually lists, so a citation resolves to a real file
        // rather than to a made-up one the panel would have to refuse.
        var path = FirstPath(request.Context) ?? "unknown.sql";

        var grounded = Segment(
            "It adds five stored procedures under `Scripts/tps-user`. Nothing is modified or deleted.",
            "code", path, 27, 34, null);

        var guess = Segment(
            "Every join carries `WITH (NOLOCK)`, and the procedures this replaces do the same, so the "
            + "pattern looks inherited rather than introduced here.",
            "inferred", path, 22, null,
            "The usual reason is avoiding reader-writer blocking on hot tables, at the cost of dirty "
            + "reads. Whether that was deliberate here is not recorded anywhere I can see. Ask the author.",
            "warning");

        var broken = Segment(
            "`@SearchTerm` is interpolated into the `WHERE` clause rather than parameterised.",
            "code", path, 31, null, null, "error");

        var segments = script switch
        {
            Script.Inferred => new[] { guess },

            /* The case the segment shape exists for: one answer, three claims, three different
               sources *and* three different severities. A single badge over all of them would be
               lying about two, and grading them all the same would bury the one that matters. */
            Script.Mixed => [grounded, guess, broken,
                Segment("A couple of things worth checking:", "doc", null, 0, null, null)],

            // Seven segments against a cap of six, so the caveat on the last kept one is exercised.
            Script.Overflow => Enumerable.Range(1, 7)
                .Select(i => Segment($"Claim number {i}.", "code", path, i, null, null))
                .ToArray(),

            _ => [grounded],
        };

        return JsonSerializer.Serialize(new { segments });
    }

    private static object Segment(
        string text, string provenance, string? path, int line, int? endLine, string? note,
        string severity = "info") => new
    {
        text,
        provenance,
        severity,
        citations = path is null
            ? Array.Empty<object>()
            : [new { path, line, end_line = endLine }],
        inference_note = note,
    };

    private static string? FirstPath(string context)
    {
        const string marker = "<file path=\"";
        var at = context.IndexOf(marker, StringComparison.Ordinal);
        if (at < 0) return null;
        var from = at + marker.Length;
        var to = context.IndexOf('"', from);
        return to < 0 ? null : context[from..to];
    }

    private static IEnumerable<string> Chunk(string text, int size)
    {
        for (var i = 0; i < text.Length; i += size)
            yield return text.Substring(i, Math.Min(size, text.Length - i));
    }
}
