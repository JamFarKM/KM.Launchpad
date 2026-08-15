using System.Runtime.CompilerServices;

namespace PipelineLaunchpad.Server.Services.Agents;

/// <summary>What the panel is told while the agent is working, on top of the answer itself.</summary>
public abstract record ConversationEvent
{
    /// <summary>One closed claim. The streaming unit (§5.2).</summary>
    public sealed record Segment(AnswerSegment Value) : ConversationEvent;

    /// <summary>Unlabelled prose, from a connector with no structure at all (§5.4 mode 3).</summary>
    public sealed record Delta(string Text) : ConversationEvent;

    /// <summary>The agent asked for something. Surfaced so an answer's basis is visible.</summary>
    public sealed record Reading(string Tool, string Detail) : ConversationEvent;

    public sealed record Complete(CanonicalAnswer Answer, AgentUsage? Usage, IReadOnlyList<string> Reads)
        : ConversationEvent;

    /// <summary>The change map, already validated against the paths the agent actually had (§2).</summary>
    public sealed record MapComplete(ChangeMap Map, AgentUsage? Usage, IReadOnlyList<string> Reads)
        : ConversationEvent;

    public sealed record Failed(AgentError Error) : ConversationEvent;
}

/// <summary>
/// Runs one question to completion, servicing whatever the agent asks for along the way.
///
/// <b>The loop lives here, not in an adapter.</b> An adapter does one exchange and reports either an
/// answer or a set of tool calls; this class services them and asks again. That is what keeps the
/// iteration cap, the cumulative byte budget and the read guardrails in a single provider-agnostic
/// place — a third provider inherits all of it by existing, and none of it can drift between two
/// copies.
/// </summary>
public class AgentConversation(RepoTools tools)
{
    /// <param name="citablePaths">
    /// Paths a citation may name: the pull request's changed files. Anything else the agent cites is
    /// resolved against what it actually read (below) before being kept.
    /// </param>
    public async IAsyncEnumerable<ConversationEvent> RunAsync(
        IAgentAdapter adapter,
        AgentTarget target,
        CanonicalRequest request,
        RepoScope scope,
        AgentBudget budget,
        IReadOnlyCollection<string> citablePaths,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var exchanges = new List<AgentToolExchange>();
        AgentUsage? usage = null;

        for (var iteration = 1; ; iteration++)
        {
            // On the last permitted iteration the tools are withdrawn, which is what actually ends
            // the loop: telling a model "this is your last chance" while still offering it a way to
            // read is an invitation to spend the turn reading and never answer.
            var lastChance = iteration >= budget.MaxIterations;
            var offered = lastChance || budget.Exhausted ? null : request.Tools;

            var exchange = request with
            {
                Tools = offered,
                ToolExchanges = exchanges,
                SystemPrompt = lastChance || budget.Exhausted
                    ? request.SystemPrompt + LastChanceNote
                    : request.SystemPrompt,
            };

            AgentEvent.ToolCalls? pending = null;
            var finished = false;

            await foreach (var ev in adapter.CompleteAsync(target, exchange, ct))
            {
                switch (ev)
                {
                    case AgentEvent.Segment s:
                        yield return new ConversationEvent.Segment(Resolve(s.Value, citablePaths));
                        break;

                    case AgentEvent.Delta d:
                        yield return new ConversationEvent.Delta(d.Text);
                        break;

                    case AgentEvent.Complete c:
                        usage = Merge(usage, c.Usage);

                        /* An answer with nothing in it is a failure, not an answer.
                           `{"segments":[]}` is schema-valid and a model does produce one — most often
                           on a short conversational follow-up. Recorded as an answer it became a
                           provenance badge floating over no text, which tells the reviewer nothing and
                           looks like the agent said something unreadable. As a typed error it says
                           what happened and offers Retry, which is what §6 asks for everywhere else. */
                        if (c.Answer.IsEmpty)
                        {
                            yield return new ConversationEvent.Failed(new AgentError(
                                AgentErrorCode.Upstream,
                                Detail: "The agent returned an empty answer. Asking again usually works."));
                            finished = true;
                            break;
                        }

                        yield return new ConversationEvent.Complete(
                            c.Answer with { Segments = [..c.Answer.Segments.Select(s => Resolve(s, citablePaths))] },
                            usage, tools.Reads);
                        finished = true;
                        break;

                    case AgentEvent.MapComplete mc:
                        usage = Merge(usage, mc.Usage);

                        // Same reasoning as the empty-answer check above, aimed at a graph instead of
                        // a segment list: no partial diagram, ever (§7). A map that fails to parse or
                        // validate is reported as a typed failure with Retry, never as an empty sheet.
                        var map = ChangeMapParser.Parse(mc.Json, KnownPaths(citablePaths));
                        if (map is null)
                        {
                            yield return new ConversationEvent.Failed(new AgentError(
                                AgentErrorCode.Upstream,
                                Detail: "The agent's change map could not be read. Asking again usually works."));
                        }
                        else
                        {
                            yield return new ConversationEvent.MapComplete(map, usage, tools.Reads);
                        }
                        finished = true;
                        break;

                    case AgentEvent.Failed f:
                        yield return new ConversationEvent.Failed(f.Error);
                        finished = true;
                        break;

                    case AgentEvent.ToolCalls t:
                        usage = Merge(usage, t.Usage);
                        pending = t;
                        break;
                }
            }

            if (finished) yield break;

            if (pending is null)
            {
                // Neither an answer nor a request: the exchange produced nothing usable. Reported
                // rather than looped on, since asking again would produce the same nothing.
                yield return new ConversationEvent.Failed(new AgentError(
                    AgentErrorCode.Upstream, Detail: "The agent returned neither an answer nor a request."));
                yield break;
            }

            foreach (var call in pending.Calls)
            {
                yield return new ConversationEvent.Reading(call.Name, Describe(call));
                var result = await tools.ExecuteAsync(call, scope, budget, ct);
                exchanges.Add(new AgentToolExchange(call, result));
            }
        }
    }

    /// <summary>
    /// Drops citations to paths that were never in front of the agent (§5.2).
    ///
    /// This lives here rather than in the parser because it is the only place that knows both halves:
    /// the changed files, and the files the agent went and read. The spec says a citation must match a
    /// path in <c>&lt;files&gt;</c>, which was written before the agent could read anything — a
    /// citation to a caller it looked up is now a legitimate answer to "is this still used?", so reads
    /// count too. What is still dropped is a path from neither set, because that is a path the agent
    /// invented, and a chip that scrolls nowhere is worse than no chip.
    ///
    /// Leading slashes are normalised off both sides: the context block declares paths without one and
    /// Azure DevOps hands them back with one, and a citation should not be discarded over a character
    /// the reviewer never sees.
    /// </summary>
    private AnswerSegment Resolve(AnswerSegment segment, IReadOnlyCollection<string> citablePaths)
    {
        if (segment.Citations.Count == 0) return segment;

        var known = KnownPaths(citablePaths);

        // No file list at all means nothing to check against, and dropping every citation would be
        // worse than keeping them: they'd all disappear on a PR whose files failed to load.
        if (known.Count == 0) return segment;

        var kept = segment.Citations.Where(c => known.Contains(Normalise(c.Path))).ToList();
        return kept.Count == segment.Citations.Count ? segment : segment with { Citations = kept };
    }

    /// <summary>
    /// Every path a citation — or a change-map file — may legitimately name: the pull request's
    /// changed files, plus whatever the agent went and read. Shared between <see cref="Resolve"/> and
    /// the change-map validation above, since both are the same rule applied to a different shape.
    /// </summary>
    private HashSet<string> KnownPaths(IReadOnlyCollection<string> citablePaths)
    {
        var known = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var p in citablePaths) known.Add(Normalise(p));
        foreach (var p in tools.Reads) known.Add(Normalise(p));
        return known;
    }

    private static string Normalise(string path) => path.TrimStart('/');

    /// <summary>
    /// Appended when the agent can no longer read — so it answers with what it has and says what it
    /// could not check, rather than stopping or pretending it looked.
    /// </summary>
    private const string LastChanceNote = """


        # No more reading

        You cannot request any more files for this question. Answer from what you already have, and
        say plainly which parts you could not verify.
        """;

    /// <summary>A short human-readable label for the panel: the path or query, not the raw JSON.</summary>
    private static string Describe(AgentToolCall call)
    {
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(
                string.IsNullOrWhiteSpace(call.ArgumentsJson) ? "{}" : call.ArgumentsJson);
            var root = doc.RootElement;
            foreach (var field in new[] { "path", "query" })
                if (root.TryGetProperty(field, out var v) && v.ValueKind == System.Text.Json.JsonValueKind.String)
                    return v.GetString() ?? "";
        }
        catch (System.Text.Json.JsonException) { /* fall through */ }
        return "";
    }

    /// <summary>
    /// Token counts accumulate across the loop. A five-exchange question that reported only its
    /// last exchange's usage would understate its cost several-fold, which defeats the point of
    /// recording it.
    /// </summary>
    private static AgentUsage? Merge(AgentUsage? running, AgentUsage? next)
    {
        if (next is null) return running;
        if (running is null) return next;
        return new AgentUsage(
            (running.PromptTokens ?? 0) + (next.PromptTokens ?? 0),
            (running.CompletionTokens ?? 0) + (next.CompletionTokens ?? 0));
    }
}
