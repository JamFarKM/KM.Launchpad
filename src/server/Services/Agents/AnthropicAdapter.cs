using System.Diagnostics;
using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace PipelineLaunchpad.Server.Services.Agents;

/// <summary>
/// The Anthropic Messages API adapter (DESIGN_SPEC_CONNECTORS.md §5.B).
///
/// A real translation rather than a pass-through, which is exactly why it was worth building first:
/// the canonical shapes were modelled on OpenAI's, so an OpenAI-shaped adapter can look like a
/// working abstraction while actually being that shape wearing a hat. Four things genuinely differ:
///
/// <list type="bullet">
/// <item><b>Auth headers.</b> <c>x-api-key</c> plus a pinned <c>anthropic-version</c>, not
/// <c>Authorization: Bearer</c>. Getting this wrong yields a clean 401 rather than a hang, which
/// is why it matters from the first request.</item>
/// <item><b><c>system</c> is a top-level field</b>, not a message. The context block still travels
/// as the first user message — only the prompt's placement moves.</item>
/// <item><b>No <c>response_format</c>.</b> Structure comes from forcing a single tool call whose
/// <c>input_schema</c> is the canonical schema verbatim. The completed tool input *is* the
/// canonical response, so there is no second parse path.</item>
/// <item><b>A different SSE vocabulary.</b> <c>content_block_delta</c> carries
/// <c>partial_json</c> — fragments of the tool argument string, not a coherent object per event.
/// Accumulating those into the shared tolerant parser is the whole job; nothing Anthropic-shaped
/// crosses this class's boundary.</item>
/// </list>
///
/// <c>max_tokens</c> is required rather than being an optional field with a deprecated sibling, so
/// unlike §5.A there is no fallback dance here — one field, always sent.
/// </summary>
public sealed class AnthropicAdapter(IHttpClientFactory httpFactory) : IAgentAdapter
{
    /// <summary>Pinned deliberately. Bumping it is a tested change, not a drive-by edit.</summary>
    private const string AnthropicVersion = "2023-06-01";

    private const string ToolName = "record_pr_answer";
    private const int MaxTokens = 2048;

    public string Provider => ConnectorProviders.Anthropic;

    private static string BaseOf(AgentTarget target) =>
        (target.BaseUrl ?? "https://api.anthropic.com").TrimEnd('/');

    private HttpRequestMessage Request(HttpMethod method, AgentTarget target, string path, object? body = null)
    {
        var req = new HttpRequestMessage(method, $"{BaseOf(target)}{path}");
        req.Headers.Add("x-api-key", target.Credential);
        req.Headers.Add("anthropic-version", AnthropicVersion);
        if (body is not null)
            req.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        return req;
    }

    /// <summary>
    /// <c>GET /v1/models</c> — cheap, and the diagnostic behind "Test connection". Returns ids
    /// directly usable in a request's <c>model</c> field, so the editor's select can be populated
    /// from it and a model name never has to be typed.
    /// </summary>
    public async Task<AgentProbe> ProbeAsync(AgentTarget target, CancellationToken ct)
    {
        var client = httpFactory.CreateClient("agent");
        var sw = Stopwatch.StartNew();

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(AgentTimeouts.ConnectionTest);

        try
        {
            using var req = Request(HttpMethod.Get, target, "/v1/models");
            using var resp = await client.SendAsync(req, timeout.Token);
            var body = await resp.Content.ReadAsStringAsync(timeout.Token);
            sw.Stop();

            if (!resp.IsSuccessStatusCode)
                return new AgentProbe(false, sw.ElapsedMilliseconds, [], AgentErrorMapper.FromResponse(
                    resp.StatusCode, body, resp.Headers.RetryAfter?.Delta?.TotalSeconds.ToString("F0")));

            var models = ReadModelIds(body);

            // A 200 that isn't a model list means something else answered — a proxy, or a login
            // page. Anthropic's host is fixed so this shouldn't happen, but reporting it as an
            // upstream oddity beats presenting an empty dropdown as success.
            return models.Count == 0
                ? new AgentProbe(false, sw.ElapsedMilliseconds, [],
                    new AgentError(AgentErrorCode.Upstream, 200, "The models endpoint returned no models."))
                : new AgentProbe(true, sw.ElapsedMilliseconds, models, null);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            sw.Stop();
            // A cancellation that isn't the caller's is our own 10s budget expiring.
            return new AgentProbe(false, sw.ElapsedMilliseconds, [],
                AgentErrorMapper.FromTransport(ex, new Uri(BaseOf(target)).Host));
        }
    }

    private static List<string> ReadModelIds(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (!doc.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array)
                return [];

            return data.EnumerateArray()
                .Select(m => m.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String
                    ? id.GetString() : null)
                .Where(id => !string.IsNullOrWhiteSpace(id))
                .Select(id => id!)
                .ToList();
        }
        catch (JsonException) { return []; }
    }

    public async IAsyncEnumerable<AgentEvent> CompleteAsync(
        AgentTarget target, CanonicalRequest request, [EnumeratorCancellation] CancellationToken ct)
    {
        var body = BuildBody(request);

        var client = httpFactory.CreateClient("agent");
        using var whole = CancellationTokenSource.CreateLinkedTokenSource(ct);
        whole.CancelAfter(AgentTimeouts.WholeCompletion);

        // The send is wrapped rather than yielded from directly: C# forbids `yield return` inside a
        // catch, so the failure is captured and surfaced immediately after.
        HttpResponseMessage? resp = null;
        AgentError? sendFailure = null;
        try
        {
            using var req = Request(HttpMethod.Post, target, "/v1/messages", body);
            // ResponseHeadersRead, or HttpClient buffers the whole response and streaming becomes
            // a lie that looks exactly like a hang.
            resp = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, whole.Token);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            sendFailure = AgentErrorMapper.FromTransport(ex, new Uri(BaseOf(target)).Host);
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
                    // Every completion carries the forced tool call, so a 400 here is the
                    // capability probe's answer rather than a broken request.
                    structuredRequest: true));
                yield break;
            }

            await foreach (var ev in ReadStreamAsync(resp, whole, ct))
                yield return ev;
        }
    }

    private static object BuildBody(CanonicalRequest request)
    {
        var messages = new JsonArray();

        // The context block rides on the first user message only; later turns are the bare
        // question. That is what lets an agent budget its context window: one large message at the
        // head, then short ones.
        var first = true;
        foreach (var turn in request.History)
        {
            messages.Add(new JsonObject
            {
                ["role"] = "user",
                ["content"] = first ? $"{request.Context}\n\n{turn.Question}" : turn.Question,
            });
            // Replayed assistant turns carry the answer prose only, never the JSON envelope —
            // re-feeding the envelope teaches the model to talk about its own metadata.
            messages.Add(new JsonObject { ["role"] = "assistant", ["content"] = turn.Answer });
            first = false;
        }

        messages.Add(new JsonObject
        {
            ["role"] = "user",
            ["content"] = first ? $"{request.Context}\n\n{request.Question}" : request.Question,
        });

        return new JsonObject
        {
            ["model"] = request.Model,
            ["max_tokens"] = MaxTokens,
            // Top-level, not a message. The one placement difference from §5.A.
            ["system"] = request.SystemPrompt,
            ["messages"] = messages,
            ["tools"] = new JsonArray(new JsonObject
            {
                ["name"] = ToolName,
                ["description"] = "Record the answer to the reviewer's question, with where it came from.",
                ["input_schema"] = CanonicalSchema.Build(),
            }),
            // Forcing the tool is how structure is obtained without response_format. The completed
            // input object is the canonical response.
            ["tool_choice"] = new JsonObject { ["type"] = "tool", ["name"] = ToolName },
            ["stream"] = request.Stream,
        };
    }

    /// <summary>
    /// Reads Anthropic's SSE stream and yields Launchpad's own events.
    ///
    /// The §5.5 budget is enforced here rather than on <see cref="HttpClient.Timeout"/>, which
    /// applies to the whole operation including the body and would therefore kill a legitimately
    /// long stream: 20 s to first token, 30 s idle between deltas, 120 s overall.
    /// </summary>
    private static async IAsyncEnumerable<AgentEvent> ReadStreamAsync(
        HttpResponseMessage resp, CancellationTokenSource whole, [EnumeratorCancellation] CancellationToken ct)
    {
        var parser = new CanonicalAnswerParser();
        var sawAnyDelta = false;
        AgentError? failure = null;

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
                if (remaining <= TimeSpan.Zero)
                {
                    failure = new AgentError(AgentErrorCode.Timeout);
                    break;
                }

                var finished = await Task.WhenAny(readTask, Task.Delay(remaining, ct));
                if (finished != readTask)
                {
                    // Silence past the budget. §6: this must reach the panel as a typed error, not
                    // as a truncated answer that looks complete.
                    failure = new AgentError(AgentErrorCode.Timeout);
                    break;
                }

                line = await readTask;
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                failure = AgentErrorMapper.FromTransport(ex);
                break;
            }

            if (line is null) break;              // stream ended
            if (line.Length == 0) continue;       // SSE record separator
            if (!line.StartsWith("data:", StringComparison.Ordinal)) continue;  // event: / id: / retry:

            var payload = line["data:".Length..].Trim();
            if (payload.Length == 0) continue;

            string? fragment = null;
            try
            {
                using var doc = JsonDocument.Parse(payload);
                var root = doc.RootElement;
                var type = root.TryGetProperty("type", out var t) ? t.GetString() : null;

                switch (type)
                {
                    case "content_block_delta":
                        // input_json_delta for a tool call; text_delta if the model answered in
                        // prose despite tool_choice, which the tolerant parser handles as mode 3.
                        if (root.TryGetProperty("delta", out var delta))
                            fragment = delta.TryGetProperty("partial_json", out var pj) ? pj.GetString()
                                     : delta.TryGetProperty("text", out var tx) ? tx.GetString()
                                     : null;
                        break;

                    case "error":
                        failure = AgentErrorMapper.FromResponse(
                            System.Net.HttpStatusCode.InternalServerError, payload);
                        break;

                    // message_start / content_block_start / content_block_stop / message_delta /
                    // message_stop / ping carry no prose. Ignored rather than enumerated, so a new
                    // event type Anthropic adds cannot break the stream.
                }
            }
            catch (JsonException)
            {
                continue;   // a malformed keep-alive is not worth failing a good answer over
            }

            if (failure is not null) break;

            if (!string.IsNullOrEmpty(fragment))
            {
                var prose = parser.Feed(fragment);
                deadline = DateTime.UtcNow + AgentTimeouts.IdleBetweenDeltas;
                if (prose.Length > 0)
                {
                    sawAnyDelta = true;
                    yield return new AgentEvent.Delta(prose);
                }
            }
        }

        if (failure is not null)
        {
            // Whatever prose arrived stays: the caller renders the partial answer *and* this error.
            yield return new AgentEvent.Failed(failure);
            yield break;
        }

        var answer = parser.Finish();

        // Keys can arrive in any order (§5.2). If nothing rendered progressively, the panel gets
        // the finished answer in one go rather than an empty bubble.
        if (!sawAnyDelta && answer.Answer.Length > 0)
            yield return new AgentEvent.Delta(answer.Answer);

        yield return new AgentEvent.Complete(answer);
    }
}
