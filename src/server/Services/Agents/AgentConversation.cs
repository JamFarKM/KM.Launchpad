using System.Runtime.CompilerServices;

namespace PipelineLaunchpad.Server.Services.Agents;

/// <summary>What the panel is told while the agent is working, on top of the answer itself.</summary>
public abstract record ConversationEvent
{
    public sealed record Delta(string Text) : ConversationEvent;

    /// <summary>The agent asked for something. Surfaced so an answer's basis is visible.</summary>
    public sealed record Reading(string Tool, string Detail) : ConversationEvent;

    public sealed record Complete(CanonicalAnswer Answer, AgentUsage? Usage, IReadOnlyList<string> Reads)
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
    public async IAsyncEnumerable<ConversationEvent> RunAsync(
        IAgentAdapter adapter,
        AgentTarget target,
        CanonicalRequest request,
        RepoScope scope,
        AgentBudget budget,
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
                    case AgentEvent.Delta d:
                        yield return new ConversationEvent.Delta(d.Text);
                        break;

                    case AgentEvent.Complete c:
                        usage = Merge(usage, c.Usage);
                        yield return new ConversationEvent.Complete(c.Answer, usage, tools.Reads);
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
