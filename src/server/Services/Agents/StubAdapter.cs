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
/// a mid-stream failure, or an answer whose keys arrive in the wrong order.
///
/// Registered but never selectable as a provider: <see cref="ConnectorProviders.Selectable"/>
/// doesn't list it, so it cannot be created from the UI and cannot be reached by accident.
/// </summary>
public sealed class StubAdapter : IAgentAdapter
{
    public const string ProviderKey = "stub";

    /// <summary>How the stub should behave, chosen by the credential string so a test can pick.</summary>
    public enum Script { Structured, Inferred, KeysOutOfOrder, Prose, FailMidStream }

    public string Provider => ProviderKey;

    private readonly TimeSpan _delay;

    public StubAdapter(TimeSpan? deltaDelay = null) => _delay = deltaDelay ?? TimeSpan.Zero;

    public Task<AgentProbe> ProbeAsync(AgentTarget target, CancellationToken ct) =>
        Task.FromResult(new AgentProbe(true, 1, ["stub-1", "stub-2"], null));

    public async IAsyncEnumerable<AgentEvent> CompleteAsync(
        AgentTarget target, CanonicalRequest request, [EnumeratorCancellation] CancellationToken ct)
    {
        var script = ScriptOf(target.Credential);

        if (script == Script.Prose)
        {
            // Mode 3: no JSON at all. The parser has to reach "unverified" on its own rather than
            // being told, which is what makes this worth testing.
            foreach (var chunk in Chunk("This pull request adds five stored procedures. "
                + "I can't say where that came from in a structured way.", 12))
            {
                ct.ThrowIfCancellationRequested();
                if (_delay > TimeSpan.Zero) await Task.Delay(_delay, ct);
                yield return new AgentEvent.Delta(chunk);
            }
            yield return new AgentEvent.Complete(
                new CanonicalAnswer("This pull request adds five stored procedures. "
                    + "I can't say where that came from in a structured way.",
                    null, [], null, StructuredMode.Unverified));
            yield break;
        }

        var payload = PayloadFor(script, request);
        var parser = new CanonicalAnswerParser();

        var emitted = 0;
        foreach (var chunk in Chunk(payload, 17))
        {
            ct.ThrowIfCancellationRequested();
            if (_delay > TimeSpan.Zero) await Task.Delay(_delay, ct);

            var prose = parser.Feed(chunk);
            if (prose.Length > 0)
            {
                emitted++;
                yield return new AgentEvent.Delta(prose);
            }

            // Die once there is visible prose, so the panel has a partial answer to keep beside
            // the error — the case §6 cares about.
            if (script == Script.FailMidStream && emitted >= 2)
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
        "out-of-order" => Script.KeysOutOfOrder,
        "prose" => Script.Prose,
        "fail" => Script.FailMidStream,
        _ => Script.Structured,
    };

    private static string PayloadFor(Script script, CanonicalRequest request)
    {
        // Cite the first path the context actually lists, so the parser's "drop citations whose
        // path isn't in <files>" rule is exercised against a real value rather than a made-up one.
        var path = FirstPath(request.Context) ?? "unknown.sql";

        var answer = script == Script.Inferred
            ? "Every join carries `WITH (NOLOCK)`, and the procedures this replaces do the same, "
              + "so the pattern is inherited rather than introduced here."
            : "It adds five stored procedures under `Scripts/tps-user`. Nothing is modified or "
              + "deleted, and each one returns `COALESCE(u.Email, uev.Email)`.";

        var obj = new Dictionary<string, object?>();

        if (script == Script.KeysOutOfOrder)
        {
            // Metadata first, prose last — legal JSON, and the case that must degrade to
            // rendering in one go rather than hanging.
            obj["provenance"] = "code";
            obj["citations"] = new[] { new { path, line = 22, end_line = (int?)null } };
            obj["inference_note"] = null;
            obj["answer"] = answer;
        }
        else
        {
            obj["answer"] = answer;
            obj["provenance"] = script == Script.Inferred ? "inferred" : "code";
            obj["citations"] = new[] { new { path, line = 27, end_line = (int?)34 } };
            obj["inference_note"] = script == Script.Inferred
                ? "The usual reason is avoiding reader-writer blocking on hot tables, at the cost "
                  + "of dirty reads. Whether that was deliberate here is not recorded. Ask the author."
                : null;
        }

        return JsonSerializer.Serialize(obj);
    }

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
