using System.Net;
using System.Net.Sockets;
using System.Security.Authentication;
using PipelineLaunchpad.Server.Services.Agents;

namespace PipelineLaunchpad.Server.Tests;

public class AgentErrorMapperTests
{
    private const string OpenAiEnvelope =
        """{"error":{"type":"rate_limit_exceeded","message":"Per-token quota exhausted","code":"quota"}}""";

    private const string AnthropicEnvelope =
        """{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}""";

    [Fact]
    public void Maps_dns_failure_and_names_the_host()
    {
        var ex = new HttpRequestException("no such host",
            new SocketException((int)SocketError.HostNotFound));

        var error = AgentErrorMapper.FromTransport(ex, "betbot.internal.example.com");

        Assert.Equal(AgentErrorCode.Dns, error.Code);
        Assert.Equal("betbot.internal.example.com", error.Detail);
    }

    [Fact]
    public void Maps_connection_refused()
    {
        var ex = new HttpRequestException("refused",
            new SocketException((int)SocketError.ConnectionRefused));

        Assert.Equal(AgentErrorCode.Refused, AgentErrorMapper.FromTransport(ex).Code);
    }

    [Fact]
    public void Maps_a_tls_handshake_failure()
    {
        var ex = new HttpRequestException("handshake", new AuthenticationException("untrusted root"));
        var error = AgentErrorMapper.FromTransport(ex);

        Assert.Equal(AgentErrorCode.Tls, error.Code);
        Assert.Contains("untrusted root", error.Detail);
    }

    [Fact]
    public void Maps_a_timeout()
    {
        Assert.Equal(AgentErrorCode.Timeout,
            AgentErrorMapper.FromTransport(new TaskCanceledException("too slow")).Code);
    }

    [Fact]
    public void An_unrecognised_transport_failure_is_upstream_rather_than_a_guess()
    {
        Assert.Equal(AgentErrorCode.Upstream,
            AgentErrorMapper.FromTransport(new InvalidOperationException("something odd")).Code);
    }

    [Fact]
    public void Maps_401_to_auth_and_never_shows_the_providers_message()
    {
        var error = AgentErrorMapper.FromResponse(HttpStatusCode.Unauthorized, AnthropicEnvelope);

        Assert.Equal(AgentErrorCode.Auth, error.Code);
        Assert.Equal(401, error.HttpStatus);
        // §4.1: an auth message is rarely more useful than ours and may echo the credential back.
        Assert.Null(error.Detail);
    }

    [Fact]
    public void Maps_403_to_auth_as_well()
    {
        Assert.Equal(AgentErrorCode.Auth,
            AgentErrorMapper.FromResponse(HttpStatusCode.Forbidden, null).Code);
    }

    [Fact]
    public void Refines_401_to_expired_from_an_openai_shaped_code()
    {
        var body = """{"error":{"type":"invalid_request_error","code":"expired","message":"key expired"}}""";
        Assert.Equal(AgentErrorCode.Expired,
            AgentErrorMapper.FromResponse(HttpStatusCode.Unauthorized, body).Code);
    }

    [Fact]
    public void Refines_401_to_expired_from_an_anthropic_shaped_message()
    {
        // Anthropic has no error.code, so the signal can only come from type or message. Both are
        // checked, which is why the same refinement works across two different envelopes.
        var body = """{"type":"error","error":{"type":"authentication_error","message":"This key has expired"}}""";
        Assert.Equal(AgentErrorCode.Expired,
            AgentErrorMapper.FromResponse(HttpStatusCode.Unauthorized, body).Code);
    }

    [Fact]
    public void Maps_404_to_not_found()
    {
        Assert.Equal(AgentErrorCode.NotFound,
            AgentErrorMapper.FromResponse(HttpStatusCode.NotFound, null).Code);
    }

    [Fact]
    public void Maps_429_and_keeps_retry_after()
    {
        var error = AgentErrorMapper.FromResponse(HttpStatusCode.TooManyRequests, OpenAiEnvelope, "42");

        Assert.Equal(AgentErrorCode.RateLimited, error.Code);
        Assert.Equal(42, error.RetryAfterSeconds);
    }

    [Fact]
    public void A_429_with_an_empty_body_is_still_rate_limited()
    {
        // §4.1: an unparseable body is not itself an error.
        Assert.Equal(AgentErrorCode.RateLimited,
            AgentErrorMapper.FromResponse(HttpStatusCode.TooManyRequests, "").Code);
    }

    [Fact]
    public void Maps_5xx_to_upstream_and_shows_the_providers_message()
    {
        var error = AgentErrorMapper.FromResponse(HttpStatusCode.InternalServerError, OpenAiEnvelope);

        Assert.Equal(AgentErrorCode.Upstream, error.Code);
        // The one place §4.1 allows the provider's own message through, attributed to the agent.
        Assert.Equal("Per-token quota exhausted", error.Detail);
    }

    [Fact]
    public void Falls_back_to_a_body_snippet_when_a_5xx_does_not_parse()
    {
        var html = new string('x', 400);
        var error = AgentErrorMapper.FromResponse(HttpStatusCode.BadGateway, html);

        Assert.Equal(AgentErrorCode.Upstream, error.Code);
        Assert.Equal(200, error.Detail!.Length);
    }

    [Fact]
    public void A_400_on_a_structured_request_is_unsupported_not_broken()
    {
        // This is how the capability probe tells "can't do structured answers" from "is broken",
        // and it is what puts the panel onto the §5.4 ladder instead of showing an error.
        var error = AgentErrorMapper.FromResponse(HttpStatusCode.BadRequest, null, structuredRequest: true);
        Assert.Equal(AgentErrorCode.Unsupported, error.Code);
    }

    [Fact]
    public void A_400_on_an_ordinary_request_is_not_unsupported()
    {
        var error = AgentErrorMapper.FromResponse(HttpStatusCode.BadRequest, null, structuredRequest: false);
        Assert.NotEqual(AgentErrorCode.Unsupported, error.Code);
    }

    [Fact]
    public void The_status_decides_before_the_providers_own_code()
    {
        // §4.1: error.code only *refines*. A rate-limit code on a 401 must not win over the status,
        // or a connector sending an odd refinement would send the reviewer down the wrong path.
        var error = AgentErrorMapper.FromResponse(HttpStatusCode.Unauthorized, OpenAiEnvelope);
        Assert.Equal(AgentErrorCode.Auth, error.Code);
    }

    [Fact]
    public void Both_envelope_shapes_reach_the_same_code()
    {
        // The point of mapping in one place: nothing above this line knows the shapes differ.
        var openAi = AgentErrorMapper.FromResponse(HttpStatusCode.InternalServerError,
            """{"error":{"type":"api_error","message":"boom"}}""");
        var anthropic = AgentErrorMapper.FromResponse(HttpStatusCode.InternalServerError,
            """{"type":"error","error":{"type":"api_error","message":"boom"}}""");

        Assert.Equal(openAi.Code, anthropic.Code);
        Assert.Equal(openAi.Detail, anthropic.Detail);
    }
}
