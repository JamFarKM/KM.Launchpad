using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace PipelineLaunchpad.Server.Services.Agents;

/// <summary>
/// The Custom / OpenAI-compatible adapter (DESIGN_SPEC_CONNECTORS.md §5.A).
///
/// Near a pass-through, because the canonical shapes were modelled on this wire format to begin
/// with — which is exactly why it was worth building the Anthropic adapter first. This one would
/// have made the abstraction look real without testing it.
///
/// <b>OpenAI is not a separate contract.</b> It is this adapter with <c>base_url</c> pinned to
/// <c>api.openai.com/v1</c> and no Base URL field to edit, which is why §3.0 gives it no dedicated
/// mockup state. One class serves both providers, and the only difference is where the host comes
/// from.
/// </summary>
public sealed class OpenAiCompatibleAdapter : IAgentAdapter
{
    private readonly IHttpClientFactory _httpFactory;

    /// <summary>
    /// One instance per provider key, since <see cref="IAgentAdapter.Provider"/> is how the registry
    /// finds it — two registrations of the same class, not two classes.
    /// </summary>
    public OpenAiCompatibleAdapter(IHttpClientFactory httpFactory, string provider)
    {
        _httpFactory = httpFactory;
        Provider = provider;
    }

    public string Provider { get; }

    /// <summary>Ceiling on one answer. Kept level with the Anthropic adapter's, so the same question
    /// does not get a shorter answer purely because of which connector holds the capability.</summary>
    private const int MaxCompletionTokens = 8192;

    /// <summary>The function the model calls to record its answer when tools are in play.</summary>
    private const string AnswerToolName = "record_pr_answer";

    private static string BaseOf(AgentTarget target) => (target.BaseUrl ?? "").TrimEnd('/');

    private HttpRequestMessage Request(HttpMethod method, AgentTarget target, string path, object? body = null)
    {
        var req = new HttpRequestMessage(method, $"{BaseOf(target)}{path}");
        // Bearer, unlike §5.B's x-api-key. The whole auth difference between the two adapters.
        req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", target.Credential);
        if (body is not null)
            req.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        return req;
    }

    public async Task<AgentProbe> ProbeAsync(AgentTarget target, CancellationToken ct)
    {
        var client = _httpFactory.CreateClient("agent");
        var sw = Stopwatch.StartNew();

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(AgentTimeouts.ConnectionTest);

        try
        {
            using var req = Request(HttpMethod.Get, target, "/models");
            using var resp = await client.SendAsync(req, timeout.Token);
            var body = await resp.Content.ReadAsStringAsync(timeout.Token);
            sw.Stop();

            if (!resp.IsSuccessStatusCode)
                return new AgentProbe(false, sw.ElapsedMilliseconds, [], AgentErrorMapper.FromResponse(
                    resp.StatusCode, body, resp.Headers.RetryAfter?.Delta?.TotalSeconds.ToString("F0")));

            var models = ReadModelIds(body);

            // §4's `not_openai`: a 200 that isn't a model list. Almost always a proxy or a login page
            // answering instead of the service, which is worth saying rather than showing an empty
            // dropdown as though the test had passed. This code is Custom/OpenAI-only by definition.
            return models is null
                ? new AgentProbe(false, sw.ElapsedMilliseconds, [], new AgentError(
                    AgentErrorCode.NotOpenAi, 200,
                    resp.Content.Headers.ContentType?.ToString()))
                : new AgentProbe(true, sw.ElapsedMilliseconds, models, null);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            sw.Stop();
            var host = Uri.TryCreate(BaseOf(target), UriKind.Absolute, out var u) ? u.Authority : BaseOf(target);
            return new AgentProbe(false, sw.ElapsedMilliseconds, [], AgentErrorMapper.FromTransport(ex, host));
        }
    }

    /// <summary>Null means "this wasn't a model list at all" — distinct from an empty one.</summary>
    private static List<string>? ReadModelIds(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (!doc.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array)
                return null;

            return data.EnumerateArray()
                .Select(m => m.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String
                    ? id.GetString() : null)
                .Where(id => !string.IsNullOrWhiteSpace(id))
                .Select(id => id!)
                .ToList();
        }
        catch (JsonException) { return null; }
    }

    public async IAsyncEnumerable<AgentEvent> CompleteAsync(
        AgentTarget target, CanonicalRequest request, [EnumeratorCancellation] CancellationToken ct)
    {
        var client = _httpFactory.CreateClient("agent");
        using var whole = CancellationTokenSource.CreateLinkedTokenSource(ct);
        whole.CancelAfter(AgentTimeouts.WholeCompletion);

        HttpResponseMessage? resp = null;
        AgentError? sendFailure = null;
        try
        {
            using var req = Request(HttpMethod.Post, target, "/chat/completions", BuildBody(request));
            resp = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, whole.Token);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            var host = Uri.TryCreate(BaseOf(target), UriKind.Absolute, out var u) ? u.Authority : BaseOf(target);
            sendFailure = AgentErrorMapper.FromTransport(ex, host);
        }

        if (sendFailure is not null)
        {
            yield return new AgentEvent.Failed(sendFailure);
            yield break;
        }

        using (resp!)
        {
            if (!resp.IsSuccessStatusCode)
            {
                var errorBody = await resp.Content.ReadAsStringAsync(ct);
                yield return new AgentEvent.Failed(AgentErrorMapper.FromResponse(
                    resp.StatusCode, errorBody,
                    resp.Headers.RetryAfter?.Delta?.TotalSeconds.ToString("F0"),
                    // §5.A asks agents to 400 rather than 500 on an unsupported parameter, so we can
                    // tell "can't do structured answers" from "broken" — that is the §5.4 probe.
                    structuredRequest: true));
                yield break;
            }

            await foreach (var ev in ReadStreamAsync(resp, whole, ct))
                yield return ev;
        }
    }

    private static object BuildBody(CanonicalRequest request)
    {
        var messages = new JsonArray
        {
            // Unlike §5.B, the prompt is a system-role *message* rather than a top-level field.
            new JsonObject { ["role"] = "system", ["content"] = request.SystemPrompt },
        };

        var first = true;
        foreach (var turn in request.History)
        {
            messages.Add(new JsonObject
            {
                ["role"] = "user",
                ["content"] = first ? $"{request.Context}\n\n{turn.Question}" : turn.Question,
            });
            messages.Add(new JsonObject { ["role"] = "assistant", ["content"] = turn.Answer });
            first = false;
        }

        messages.Add(new JsonObject
        {
            ["role"] = "user",
            ["content"] = first ? $"{request.Context}\n\n{request.Question}" : request.Question,
        });

        // Tool exchanges already serviced in this question, in OpenAI's shape: an assistant message
        // carrying tool_calls, then one role:tool message per result. Materially different from
        // §5.B's assistant/user pair, which is exactly the sort of difference the adapter exists to
        // absorb.
        foreach (var exchange in request.ToolExchanges ?? [])
        {
            messages.Add(new JsonObject
            {
                ["role"] = "assistant",
                ["content"] = null,
                ["tool_calls"] = new JsonArray(new JsonObject
                {
                    ["id"] = exchange.Call.Id,
                    ["type"] = "function",
                    ["function"] = new JsonObject
                    {
                        ["name"] = exchange.Call.Name,
                        ["arguments"] = exchange.Call.ArgumentsJson,
                    },
                }),
            });
            messages.Add(new JsonObject
            {
                ["role"] = "tool",
                ["tool_call_id"] = exchange.Result.Id,
                ["content"] = exchange.Result.Content,
            });
        }

        var body = new JsonObject
        {
            ["model"] = request.Model,
            ["stream"] = request.Stream,
            // max_completion_tokens, not max_tokens: the latter is deprecated in Chat Completions
            // and rejected outright by some endpoints (§5.A).
            ["max_completion_tokens"] = MaxCompletionTokens,
            ["messages"] = messages,
        };

        var repoTools = request.Tools ?? [];
        if (repoTools.Count == 0)
        {
            // No repository access: structure comes from response_format, exactly as before.
            body["response_format"] = new JsonObject
            {
                ["type"] = "json_schema",
                ["json_schema"] = new JsonObject
                {
                    ["name"] = CanonicalSchema.Name,
                    ["strict"] = true,
                    ["schema"] = CanonicalSchema.Build(),
                },
            };
            return body;
        }

        /* With tools offered, response_format cannot be used: an endpoint asked for both a forced
           JSON shape and a free choice of tool calls has no legal way to satisfy the first while
           doing the second, and several reject the combination outright. So structure moves to a
           function the model calls to record its answer — the same trick §5.B uses — and the
           canonical schema travels as that function's parameters. `tool_choice: required`
           guarantees a call without dictating which. */
        var tools = new JsonArray(new JsonObject
        {
            ["type"] = "function",
            ["function"] = new JsonObject
            {
                ["name"] = AnswerToolName,
                ["description"] = "Record the answer to the reviewer's question, with where it came "
                                + "from. Call this once you have everything you need.",
                ["parameters"] = CanonicalSchema.Build(),
            },
        });

        foreach (var tool in repoTools)
            tools.Add(new JsonObject
            {
                ["type"] = "function",
                ["function"] = new JsonObject
                {
                    ["name"] = tool.Name,
                    ["description"] = tool.Description,
                    ["parameters"] = tool.InputSchema.DeepClone(),
                },
            });

        body["tools"] = tools;
        // Guarantees a call without dictating which — the model can read first or answer now.
        body["tool_choice"] = "required";
        return body;
    }

    /// <summary>
    /// Reads an OpenAI-shaped SSE stream: <c>data: {chunk}</c> per delta, terminated by
    /// <c>data: [DONE]</c>.
    ///
    /// Two shapes now arrive here. Without tools the answer is <c>choices[0].delta.content</c>, as
    /// before. With tools it is the <c>record_pr_answer</c> function's streamed arguments, alongside
    /// any repository calls — so tool calls accumulate by index and the answer function's fragments
    /// are routed to the segment parser exactly as content would be.
    ///
    /// <c>content</c> is the one place this adapter has to guess, because the same field carries both
    /// a `json_schema` object (mode 1) and plain prose (mode 3). The guess is made once, on the first
    /// non-whitespace character: a structured response always opens with <c>{</c>. Streaming content
    /// blind would show the reviewer raw JSON as it typed itself, and waiting for the object to close
    /// before showing anything would make mode 3 look like a hang.
    /// </summary>
    private static async IAsyncEnumerable<AgentEvent> ReadStreamAsync(
        HttpResponseMessage resp, CancellationTokenSource whole, [EnumeratorCancellation] CancellationToken ct)
    {
        var parser = new SegmentStreamParser();
        var prose = new StringBuilder();
        bool? contentIsJson = null;
        AgentError? failure = null;
        int? promptTokens = null;
        int? completionTokens = null;

        // Tool calls by their index in the stream. OpenAI sends the id and name once, then argument
        // fragments, so the accumulator has to persist across chunks.
        var calls = new Dictionary<int, (string Id, string Name, StringBuilder Args)>();

        var stream = await resp.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(stream, Encoding.UTF8);

        var deadline = DateTime.UtcNow + AgentTimeouts.FirstToken;

        while (true)
        {
            string? line;
            try
            {
                var readTask = reader.ReadLineAsync(whole.Token).AsTask();
                var remaining = deadline - DateTime.UtcNow;
                if (remaining <= TimeSpan.Zero) { failure = new AgentError(AgentErrorCode.Timeout); break; }

                /* Cancelled once the race resolves so the loser's timer is released rather than left
                   armed for its full span, and cancellation checked explicitly so pressing Stop can't
                   be misread as silence — `whole` is linked to `ct`, so a Stop completes both tasks
                   and WhenAny's choice would otherwise decide between "Stopped" and "timed out".
                   Same reasoning as AnthropicAdapter; see the longer note there. */
                using var idle = CancellationTokenSource.CreateLinkedTokenSource(ct);
                var finished = await Task.WhenAny(readTask, Task.Delay(remaining, idle.Token));
                idle.Cancel();

                ct.ThrowIfCancellationRequested();

                if (finished != readTask) { failure = new AgentError(AgentErrorCode.Timeout); break; }

                line = await readTask;
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                failure = AgentErrorMapper.FromTransport(ex);
                break;
            }

            if (line is null) break;
            if (line.Length == 0) continue;
            if (!line.StartsWith("data:", StringComparison.Ordinal)) continue;

            var payload = line["data:".Length..].Trim();
            if (payload.Length == 0) continue;
            if (payload == "[DONE]") break;

            string? answerFragment = null;
            string? contentFragment = null;
            /* Any content fragment, tool arguments included — a model spelling out a `read_file` path
               is working, not idle. Same reasoning as AnthropicAdapter. */
            var progressed = false;
            /* Set from `finish_reason`, acted on at the end of the loop body. See
               AgentErrorMapper.Truncated for why this is read rather than inferred. */
            var truncated = false;
            try
            {
                using var doc = JsonDocument.Parse(payload);
                var root = doc.RootElement;

                // A mid-stream error arrives as an envelope in the data frame rather than a status.
                if (root.TryGetProperty("error", out _))
                {
                    failure = AgentErrorMapper.FromResponse(
                        System.Net.HttpStatusCode.InternalServerError, payload);
                    break;
                }

                if (root.TryGetProperty("choices", out var choices)
                    && choices.ValueKind == JsonValueKind.Array
                    && choices.GetArrayLength() > 0)
                {
                    var choice = choices[0];

                    if (choice.TryGetProperty("delta", out var delta))
                    {
                        if (delta.TryGetProperty("content", out var content)
                            && content.ValueKind == JsonValueKind.String)
                        {
                            contentFragment = content.GetString();
                            if (!string.IsNullOrEmpty(contentFragment)) progressed = true;
                        }

                        if (delta.TryGetProperty("tool_calls", out var toolCalls)
                            && toolCalls.ValueKind == JsonValueKind.Array)
                        {
                            foreach (var tc in toolCalls.EnumerateArray())
                            {
                                var index = tc.TryGetProperty("index", out var ix) && ix.TryGetInt32(out var i) ? i : 0;
                                if (!calls.TryGetValue(index, out var entry))
                                    entry = calls[index] = ("", "", new StringBuilder());

                                var id = tc.TryGetProperty("id", out var idv) && idv.ValueKind == JsonValueKind.String
                                    ? idv.GetString() : null;
                                var name = tc.TryGetProperty("function", out var fn)
                                    && fn.TryGetProperty("name", out var nv) && nv.ValueKind == JsonValueKind.String
                                    ? nv.GetString() : null;
                                var args = tc.TryGetProperty("function", out var fn2)
                                    && fn2.TryGetProperty("arguments", out var av) && av.ValueKind == JsonValueKind.String
                                    ? av.GetString() : null;

                                if (!string.IsNullOrEmpty(id) || !string.IsNullOrEmpty(name))
                                    calls[index] = entry = (id ?? entry.Id, name ?? entry.Name, entry.Args);

                                if (!string.IsNullOrEmpty(args))
                                {
                                    progressed = true;
                                    entry.Args.Append(args);
                                    // The answer function's arguments *are* the canonical response,
                                    // so they render progressively just as content would.
                                    if (entry.Name == AnswerToolName) answerFragment = args;
                                }
                            }
                        }
                    }

                    // The provider's own verdict on why it stopped. "length" is the truncation signal;
                    // "stop", "tool_calls" and a null mid-stream value are all normal.
                    if (choice.TryGetProperty("finish_reason", out var fr)
                        && fr.ValueKind == JsonValueKind.String
                        && fr.GetString() == "length")
                        truncated = true;

                    // Non-streaming responses, and some endpoints' final frame, put the whole thing
                    // in message.content instead.
                    if (answerFragment is null && contentFragment is null
                        && choice.TryGetProperty("message", out var msg)
                        && msg.TryGetProperty("content", out var mc)
                        && mc.ValueKind == JsonValueKind.String)
                    {
                        contentFragment = mc.GetString();
                    }
                }

                promptTokens = ReadTokens(root, "prompt_tokens") ?? promptTokens;
                completionTokens = ReadTokens(root, "completion_tokens") ?? completionTokens;
            }
            catch (JsonException)
            {
                continue;
            }

            if (!string.IsNullOrEmpty(contentFragment))
            {
                // Decided once, from the first character that isn't whitespace, and never revisited:
                // a fragment boundary must not be able to flip the verdict mid-answer.
                contentIsJson ??= FirstMeaningfulChar(contentFragment) switch
                {
                    '{' => true,
                    null => null,      // still nothing but whitespace — ask again next fragment
                    _ => false,
                };

                if (contentIsJson == false)
                {
                    prose.Append(contentFragment);
                    yield return new AgentEvent.Delta(contentFragment);
                }
                else
                {
                    answerFragment = contentFragment;
                }
            }

            // One place, and it covers tool arguments as well as the two visible kinds.
            if (progressed) deadline = DateTime.UtcNow + AgentTimeouts.IdleBetweenDeltas;

            if (!string.IsNullOrEmpty(answerFragment))
            {
                foreach (var segment in parser.Feed(answerFragment))
                    yield return new AgentEvent.Segment(segment);
            }

            // Last, so this frame's content is delivered before the answer is called incomplete.
            if (truncated) { failure = AgentErrorMapper.Truncated(); break; }
        }

        var usage = new AgentUsage(promptTokens, completionTokens);

        if (failure is not null)
        {
            yield return new AgentEvent.Failed(failure);
            yield break;
        }

        var repoCalls = calls.Values
            .Where(c => c.Name != AnswerToolName && c.Name.Length > 0)
            .Select(c => new AgentToolCall(c.Id, c.Name, c.Args.ToString()))
            .ToList();

        if (repoCalls.Count > 0)
        {
            yield return new AgentEvent.ToolCalls(repoCalls, usage);
            yield break;
        }

        yield return new AgentEvent.Complete(parser.Finish(prose.ToString()), usage);
    }

    /// <summary>First non-whitespace character of a fragment, or null if it has none.</summary>
    private static char? FirstMeaningfulChar(string text)
    {
        foreach (var ch in text)
            if (!char.IsWhiteSpace(ch)) return ch;
        return null;
    }

    private static int? ReadTokens(JsonElement parent, string field) =>
        parent.TryGetProperty("usage", out var usage)
        && usage.ValueKind == JsonValueKind.Object
        && usage.TryGetProperty(field, out var v)
        && v.ValueKind == JsonValueKind.Number
        && v.TryGetInt32(out var n)
            ? n : null;
}
