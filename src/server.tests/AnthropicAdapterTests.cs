using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using PipelineLaunchpad.Server.Services;
using PipelineLaunchpad.Server.Services.Agents;

namespace PipelineLaunchpad.Server.Tests;

/// <summary>
/// Exercises §5.B through a fake transport.
///
/// These are the tests that prove the adapter boundary is real rather than decorative: they assert
/// the four things Anthropic genuinely does differently from the canonical shape, and that nothing
/// Anthropic-shaped escapes the adapter.
/// </summary>
public class AnthropicAdapterTests
{
    private sealed class CapturingHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        public HttpRequestMessage? LastRequest { get; private set; }
        public string? LastBody { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            LastRequest = request;
            LastBody = request.Content is null ? null : await request.Content.ReadAsStringAsync(ct);
            return respond(request);
        }
    }

    private sealed class FakeFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler) { Timeout = Timeout.InfiniteTimeSpan };
    }

    private static HttpResponseMessage Json(HttpStatusCode status, string body) =>
        new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    private static HttpResponseMessage Sse(string body) =>
        new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "text/event-stream") };

    private static AgentTarget Target => new(ConnectorProviders.Anthropic, "https://api.anthropic.com", "sk-ant-test");

    private static CanonicalRequest Request(params AgentTurn[] history) => new(
        SystemPrompt: "the task prompt",
        Context: "<pull-request-context><files><file path=\"a.sql\"/></files></pull-request-context>",
        History: history,
        Question: "What does this PR change?",
        Model: "claude-sonnet-4-5",
        Stream: true);

    private static async Task<List<AgentEvent>> Drain(IAsyncEnumerable<AgentEvent> events)
    {
        var list = new List<AgentEvent>();
        await foreach (var e in events) list.Add(e);
        return list;
    }

    // ---------- auth and request shape ----------

    [Fact]
    public async Task Authenticates_with_x_api_key_and_a_pinned_version_not_bearer()
    {
        var handler = new CapturingHandler(_ => Json(HttpStatusCode.OK, """{"data":[{"id":"claude-sonnet-4-5"}]}"""));
        var adapter = new AnthropicAdapter(new FakeFactory(handler));

        await adapter.ProbeAsync(Target, CancellationToken.None);

        var headers = handler.LastRequest!.Headers;
        Assert.Equal("sk-ant-test", headers.GetValues("x-api-key").Single());
        Assert.Equal("2023-06-01", headers.GetValues("anthropic-version").Single());
        // A Bearer token gets a straightforward 401 rather than a hang, which is exactly why this
        // header pair has to be right from the first request.
        Assert.Null(headers.Authorization);
    }

    [Fact]
    public async Task Probe_reads_model_ids_from_anthropics_own_list_shape()
    {
        var handler = new CapturingHandler(_ => Json(HttpStatusCode.OK,
            """{"data":[{"id":"claude-opus-4-1"},{"id":"claude-sonnet-4-5"}],"has_more":false}"""));
        var probe = await new AnthropicAdapter(new FakeFactory(handler)).ProbeAsync(Target, CancellationToken.None);

        Assert.True(probe.Ok);
        Assert.Equal(["claude-opus-4-1", "claude-sonnet-4-5"], probe.Models);
        Assert.EndsWith("/v1/models", handler.LastRequest!.RequestUri!.AbsolutePath);
    }

    [Fact]
    public async Task Probe_reports_a_rejected_key_through_the_taxonomy_rather_than_throwing()
    {
        var handler = new CapturingHandler(_ => Json(HttpStatusCode.Unauthorized,
            """{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"""));
        var probe = await new AnthropicAdapter(new FakeFactory(handler)).ProbeAsync(Target, CancellationToken.None);

        Assert.False(probe.Ok);
        Assert.Equal(AgentErrorCode.Auth, probe.Error!.Code);
        Assert.Equal(401, probe.Error.HttpStatus);
    }

    [Fact]
    public async Task Probe_treats_a_200_with_no_models_as_a_failure_not_an_empty_dropdown()
    {
        var handler = new CapturingHandler(_ => Json(HttpStatusCode.OK, """{"data":[]}"""));
        var probe = await new AnthropicAdapter(new FakeFactory(handler)).ProbeAsync(Target, CancellationToken.None);

        Assert.False(probe.Ok);
        Assert.Equal(AgentErrorCode.Upstream, probe.Error!.Code);
    }

    [Fact]
    public async Task Sends_the_prompt_as_a_top_level_system_field_never_as_a_message()
    {
        var handler = new CapturingHandler(_ => Sse("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"));
        await Drain(new AnthropicAdapter(new FakeFactory(handler)).CompleteAsync(Target, Request(), CancellationToken.None));

        var body = JsonNode.Parse(handler.LastBody!)!.AsObject();
        Assert.Equal("the task prompt", body["system"]!.GetValue<string>());

        // The single biggest §5.A/§5.B difference: no system-role message exists here.
        var roles = body["messages"]!.AsArray().Select(m => m!["role"]!.GetValue<string>()).ToList();
        Assert.DoesNotContain("system", roles);
    }

    [Fact]
    public async Task Obtains_structure_by_forcing_a_tool_call_and_sends_no_response_format()
    {
        var handler = new CapturingHandler(_ => Sse("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"));
        await Drain(new AnthropicAdapter(new FakeFactory(handler)).CompleteAsync(Target, Request(), CancellationToken.None));

        var body = JsonNode.Parse(handler.LastBody!)!.AsObject();

        Assert.False(body.ContainsKey("response_format"));
        Assert.Equal("tool", body["tool_choice"]!["type"]!.GetValue<string>());

        var tool = body["tools"]!.AsArray().Single()!;
        Assert.Equal(body["tool_choice"]!["name"]!.GetValue<string>(), tool["name"]!.GetValue<string>());

        // The tool's input_schema is the canonical schema verbatim — not a second copy that could
        // drift from the one the parser validates against.
        Assert.Equal(
            CanonicalSchema.Build().ToJsonString(),
            tool["input_schema"]!.ToJsonString());
    }

    [Fact]
    public async Task Always_sends_max_tokens_because_anthropic_requires_it()
    {
        var handler = new CapturingHandler(_ => Sse("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"));
        await Drain(new AnthropicAdapter(new FakeFactory(handler)).CompleteAsync(Target, Request(), CancellationToken.None));

        var body = JsonNode.Parse(handler.LastBody!)!.AsObject();
        Assert.True(body["max_tokens"]!.GetValue<int>() > 0);
        // Unlike §5.A there is no deprecated sibling to fall back to, so there must be no dance.
        Assert.False(body.ContainsKey("max_completion_tokens"));
    }

    [Fact]
    public async Task Attaches_the_context_block_to_the_first_user_message_only()
    {
        var handler = new CapturingHandler(_ => Sse("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"));
        var history = new[] { new AgentTurn("What does this PR change?", "It adds five procedures.") };

        await Drain(new AnthropicAdapter(new FakeFactory(handler))
            .CompleteAsync(Target, Request(history), CancellationToken.None));

        var messages = JsonNode.Parse(handler.LastBody!)!["messages"]!.AsArray();
        var contents = messages.Select(m => m!["content"]!.GetValue<string>()).ToList();

        Assert.Equal(3, messages.Count);
        Assert.Contains("<pull-request-context>", contents[0]);
        // The replayed assistant turn is prose only — no envelope keys.
        Assert.DoesNotContain("provenance", contents[1]);
        // The later question rides alone, which is what lets an agent budget its context window.
        Assert.DoesNotContain("<pull-request-context>", contents[2]);
    }

    // ---------- streaming ----------

    /// <summary>
    /// A real Anthropic tool-use stream: the answer arrives as <c>partial_json</c> fragments of the
    /// tool argument string, which is nothing like OpenAI's coherent-object-per-event.
    /// </summary>
    private const string ToolUseStream = """
        event: message_start
        data: {"type":"message_start","message":{"id":"msg_1","role":"assistant"}}

        event: content_block_start
        data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"record_pr_answer","input":{}}}

        event: ping
        data: {"type":"ping"}

        event: content_block_delta
        data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"answer\":\"It adds five "}}

        event: content_block_delta
        data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"procedures.\",\"provenance\":\"code\","}}

        event: content_block_delta
        data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"citations\":[{\"path\":\"a.sql\",\"line\":22,\"end_line\":null}],\"inference_note\":null}"}}

        event: content_block_stop
        data: {"type":"content_block_stop","index":0}

        event: message_delta
        data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":48}}

        event: message_stop
        data: {"type":"message_stop"}

        """;

    [Fact]
    public async Task Accumulates_partial_json_into_a_canonical_answer()
    {
        var handler = new CapturingHandler(_ => Sse(ToolUseStream));
        var events = await Drain(new AnthropicAdapter(new FakeFactory(handler))
            .CompleteAsync(Target, Request(), CancellationToken.None));

        var complete = Assert.IsType<AgentEvent.Complete>(events.Last());
        Assert.Equal("It adds five procedures.", complete.Answer.Answer);
        Assert.Equal(Provenance.Code, complete.Answer.Provenance);
        Assert.Equal(StructuredMode.Structured, complete.Answer.Mode);

        var citation = Assert.Single(complete.Answer.Citations);
        Assert.Equal("a.sql", citation.Path);
        Assert.Equal(22, citation.Line);
        Assert.Null(citation.EndLine);
    }

    [Fact]
    public async Task Emits_prose_progressively_rather_than_in_one_lump()
    {
        var handler = new CapturingHandler(_ => Sse(ToolUseStream));
        var events = await Drain(new AnthropicAdapter(new FakeFactory(handler))
            .CompleteAsync(Target, Request(), CancellationToken.None));

        var deltas = events.OfType<AgentEvent.Delta>().ToList();
        Assert.True(deltas.Count >= 2, "the answer should arrive in fragments, not one block");
        Assert.Equal("It adds five procedures.", string.Concat(deltas.Select(d => d.Text)));
    }

    [Fact]
    public async Task No_anthropic_shaped_event_escapes_the_adapter()
    {
        var handler = new CapturingHandler(_ => Sse(ToolUseStream));
        var events = await Drain(new AnthropicAdapter(new FakeFactory(handler))
            .CompleteAsync(Target, Request(), CancellationToken.None));

        // Everything is one of Launchpad's own three events. message_start, ping, content_block_*
        // and message_delta all stopped here, which is what §6 means by normalising before the
        // client sees a byte.
        Assert.All(events, e => Assert.True(e is AgentEvent.Delta or AgentEvent.Complete or AgentEvent.Failed));
        Assert.Single(events.Where(e => e is AgentEvent.Complete or AgentEvent.Failed));
    }

    [Fact]
    public async Task An_error_event_mid_stream_becomes_a_typed_failure_after_the_partial_prose()
    {
        var stream = """
            event: content_block_delta
            data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"answer\":\"I was explaining the "}}

            event: error
            data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}

            """;

        var handler = new CapturingHandler(_ => Sse(stream));
        var events = await Drain(new AnthropicAdapter(new FakeFactory(handler))
            .CompleteAsync(Target, Request(), CancellationToken.None));

        // §6: the partial answer *and* an error row — never a partial that looks complete.
        Assert.Contains("I was explaining the", string.Concat(events.OfType<AgentEvent.Delta>().Select(d => d.Text)));
        var failed = Assert.IsType<AgentEvent.Failed>(events.Last());
        Assert.Equal(AgentErrorCode.Upstream, failed.Error.Code);
        Assert.DoesNotContain(events, e => e is AgentEvent.Complete);
    }

    [Fact]
    public async Task A_400_on_the_forced_tool_call_is_reported_as_unsupported()
    {
        // §5.4: this is the capability probe's answer, and what puts the panel on the ladder rather
        // than showing the reviewer an error.
        var handler = new CapturingHandler(_ => Json(HttpStatusCode.BadRequest,
            """{"type":"error","error":{"type":"invalid_request_error","message":"tools not supported"}}"""));

        var events = await Drain(new AnthropicAdapter(new FakeFactory(handler))
            .CompleteAsync(Target, Request(), CancellationToken.None));

        var failed = Assert.IsType<AgentEvent.Failed>(Assert.Single(events));
        Assert.Equal(AgentErrorCode.Unsupported, failed.Error.Code);
    }

    [Fact]
    public async Task Falls_back_to_prose_when_the_model_answers_with_text_despite_the_forced_tool()
    {
        // text_delta rather than input_json_delta. No provenance was asserted, so none is claimed.
        var stream = """
            event: content_block_delta
            data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"It adds five procedures."}}

            event: message_stop
            data: {"type":"message_stop"}

            """;

        var handler = new CapturingHandler(_ => Sse(stream));
        var events = await Drain(new AnthropicAdapter(new FakeFactory(handler))
            .CompleteAsync(Target, Request(), CancellationToken.None));

        var complete = Assert.IsType<AgentEvent.Complete>(events.Last());
        Assert.Equal(StructuredMode.Unverified, complete.Answer.Mode);
        Assert.Null(complete.Answer.Provenance);
        Assert.Contains("five procedures", complete.Answer.Answer);
    }

    [Fact]
    public async Task Renders_in_one_go_when_the_tool_input_puts_answer_last()
    {
        var stream = """
            event: content_block_delta
            data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"provenance\":\"code\",\"citations\":[],\"inference_note\":null,\"answer\":\"metadata first\"}"}}

            event: message_stop
            data: {"type":"message_stop"}

            """;

        var handler = new CapturingHandler(_ => Sse(stream));
        var events = await Drain(new AnthropicAdapter(new FakeFactory(handler))
            .CompleteAsync(Target, Request(), CancellationToken.None));

        // Nothing rendered progressively, so the finished answer is emitted once rather than the
        // panel showing an empty bubble.
        Assert.Equal("metadata first", string.Concat(events.OfType<AgentEvent.Delta>().Select(d => d.Text)));
        Assert.Equal(Provenance.Code, Assert.IsType<AgentEvent.Complete>(events.Last()).Answer.Provenance);
    }

    [Fact]
    public async Task A_malformed_keep_alive_does_not_fail_a_good_answer()
    {
        var stream = """
            data: not json at all

            event: content_block_delta
            data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"answer\":\"fine\",\"provenance\":\"code\",\"citations\":[],\"inference_note\":null}"}}

            """;

        var handler = new CapturingHandler(_ => Sse(stream));
        var events = await Drain(new AnthropicAdapter(new FakeFactory(handler))
            .CompleteAsync(Target, Request(), CancellationToken.None));

        Assert.Equal("fine", Assert.IsType<AgentEvent.Complete>(events.Last()).Answer.Answer);
    }
}
