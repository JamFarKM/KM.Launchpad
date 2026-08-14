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

    private const int MaxCompletionTokens = 2048;

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

        return new JsonObject
        {
            ["model"] = request.Model,
            ["stream"] = request.Stream,
            // max_completion_tokens, not max_tokens: the latter is deprecated in Chat Completions
            // and rejected outright by some endpoints (§5.A).
            ["max_completion_tokens"] = MaxCompletionTokens,
            ["messages"] = messages,
            ["response_format"] = new JsonObject
            {
                ["type"] = "json_schema",
                ["json_schema"] = new JsonObject
                {
                    ["name"] = CanonicalSchema.Name,
                    ["strict"] = true,
                    ["schema"] = CanonicalSchema.Build(),
                },
            },
        };
    }

    /// <summary>
    /// Reads an OpenAI-shaped SSE stream: <c>data: {chunk}</c> per delta, terminated by
    /// <c>data: [DONE]</c>. Only <c>choices[0].delta.content</c> is read; everything else is ignored.
    /// </summary>
    private static async IAsyncEnumerable<AgentEvent> ReadStreamAsync(
        HttpResponseMessage resp, CancellationTokenSource whole, [EnumeratorCancellation] CancellationToken ct)
    {
        var parser = new CanonicalAnswerParser();
        var sawAnyDelta = false;
        AgentError? failure = null;
        int? promptTokens = null;
        int? completionTokens = null;

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

                var finished = await Task.WhenAny(readTask, Task.Delay(remaining, ct));
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

            string? fragment = null;
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
                    fragment = choice.TryGetProperty("delta", out var delta)
                            && delta.TryGetProperty("content", out var content)
                            && content.ValueKind == JsonValueKind.String
                        ? content.GetString()
                        // Non-streaming responses, and some endpoints' final frame, put the whole
                        // thing in message.content instead.
                        : choice.TryGetProperty("message", out var msg)
                            && msg.TryGetProperty("content", out var mc)
                            && mc.ValueKind == JsonValueKind.String
                            ? mc.GetString()
                            : null;
                }

                promptTokens = ReadTokens(root, "prompt_tokens") ?? promptTokens;
                completionTokens = ReadTokens(root, "completion_tokens") ?? completionTokens;
            }
            catch (JsonException)
            {
                continue;
            }

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
            yield return new AgentEvent.Failed(failure);
            yield break;
        }

        var answer = parser.Finish();
        if (!sawAnyDelta && answer.Answer.Length > 0)
            yield return new AgentEvent.Delta(answer.Answer);

        yield return new AgentEvent.Complete(answer, new AgentUsage(promptTokens, completionTokens));
    }

    private static int? ReadTokens(JsonElement parent, string field) =>
        parent.TryGetProperty("usage", out var usage)
        && usage.ValueKind == JsonValueKind.Object
        && usage.TryGetProperty(field, out var v)
        && v.ValueKind == JsonValueKind.Number
        && v.TryGetInt32(out var n)
            ? n : null;
}
