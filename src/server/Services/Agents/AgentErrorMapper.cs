using System.Net;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Text.Json;

namespace PipelineLaunchpad.Server.Services.Agents;

/// <summary>
/// Maps what actually went wrong onto the §4 taxonomy.
///
/// Every adapter routes its failures through here, so the fourteen codes are the only vocabulary
/// the UI ever sees regardless of whose wire error was underneath. "Something went wrong" and raw
/// exception text are both defects, and the way to prevent them is to leave no path that produces
/// either.
///
/// §4.1: <b>the HTTP status decides first.</b> A provider's own error code only refines it, and the
/// single refinement defined is 401 plus an expiry signal becoming <c>expired</c> rather than
/// <c>auth</c> — because "check you pasted the whole value" is the wrong advice for a credential
/// that worked yesterday. Everything else maps by status, so an unrecognised refinement value from
/// some future provider still gets correct handling.
/// </summary>
public static class AgentErrorMapper
{
    /// <summary>
    /// A transport failure, before any HTTP status exists. These three — DNS, refused, TLS — are
    /// the ones people lose an afternoon to, which is why §4 insists each says explicitly that
    /// resolution and certificate trust happen on the Launchpad server rather than on the
    /// reviewer's machine.
    /// </summary>
    public static AgentError FromTransport(Exception ex, string? host = null)
    {
        // Walk the chain: HttpRequestException wraps the interesting one.
        for (var e = ex; e is not null; e = e.InnerException)
        {
            switch (e)
            {
                case SocketException { SocketErrorCode: SocketError.HostNotFound or SocketError.NoData
                    or SocketError.TryAgain }:
                    return new AgentError(AgentErrorCode.Dns, Detail: host);

                case SocketException { SocketErrorCode: SocketError.ConnectionRefused }:
                    return new AgentError(AgentErrorCode.Refused, Detail: host);

                case AuthenticationException:
                    return new AgentError(AgentErrorCode.Tls, Detail: e.Message);

                case TaskCanceledException or OperationCanceledException:
                    return new AgentError(AgentErrorCode.Timeout, Detail: host);
            }
        }

        if (ex is HttpRequestException { HttpRequestError: HttpRequestError.NameResolutionError })
            return new AgentError(AgentErrorCode.Dns, Detail: host);
        if (ex is HttpRequestException { HttpRequestError: HttpRequestError.ConnectionError })
            return new AgentError(AgentErrorCode.Refused, Detail: host);
        if (ex is HttpRequestException { HttpRequestError: HttpRequestError.SecureConnectionError })
            return new AgentError(AgentErrorCode.Tls, Detail: ex.Message);

        // Anything genuinely unrecognised is reported as an upstream failure rather than being
        // dressed up as something more specific we cannot actually diagnose.
        return new AgentError(AgentErrorCode.Upstream, Detail: null);
    }

    /// <summary>
    /// An HTTP failure. <paramref name="body"/> is read for the expiry refinement and for the one
    /// case §4.1 allows a provider's own message to be shown: a 5xx.
    /// </summary>
    /// <param name="structuredRequest">
    /// True when the request carried forced structure or streaming. §4 maps a 400 on such a request
    /// to <c>unsupported</c> rather than a generic failure — that is how the capability probe tells
    /// "this agent can't do structured answers" from "this agent is broken".
    /// </param>
    public static AgentError FromResponse(
        HttpStatusCode status, string? body, string? retryAfter = null, bool structuredRequest = false)
    {
        var code = (int)status;
        var (providerType, providerMessage) = ReadEnvelope(body);

        if (code == 400 && structuredRequest)
            return new AgentError(AgentErrorCode.Unsupported, code, providerMessage);

        if (code is 401 or 403)
        {
            // The only refinement in §4.1. Checked against both the provider's error type and its
            // message, since providers signal expiry in either.
            var expired = Mentions(providerType, "expired") || Mentions(providerMessage, "expired");
            return expired
                ? new AgentError(AgentErrorCode.Expired, code)
                // §4.1: error.message is never displayed for auth — an auth message is rarely more
                // useful than ours and may echo the credential back.
                : new AgentError(AgentErrorCode.Auth, code);
        }

        if (code == 404) return new AgentError(AgentErrorCode.NotFound, code);

        if (code == 429)
        {
            var seconds = int.TryParse(retryAfter, out var s) ? s : (int?)null;
            return new AgentError(AgentErrorCode.RateLimited, code, RetryAfterSeconds: seconds);
        }

        if (code >= 500)
        {
            // The one place a provider's own message is shown, attributed to the agent rather than
            // to Launchpad. Falls back to the body's first 200 characters when it doesn't parse.
            var detail = providerMessage ?? Snippet(body);
            return new AgentError(AgentErrorCode.Upstream, code, detail);
        }

        return new AgentError(AgentErrorCode.Upstream, code, providerMessage ?? Snippet(body));
    }

    /// <summary>
    /// Reads a provider error envelope, accepting both shapes §4.1 names.
    ///
    /// OpenAI-shaped: <c>{ "error": { "type", "message", "code" } }</c>.
    /// Anthropic-shaped: <c>{ "type": "error", "error": { "type", "message" } }</c>.
    /// Both land on the same two strings, which is the whole point of doing it here — nothing above
    /// this line needs to know the shape differs.
    /// </summary>
    private static (string? Type, string? Message) ReadEnvelope(string? body)
    {
        if (string.IsNullOrWhiteSpace(body)) return (null, null);

        try
        {
            using var doc = JsonDocument.Parse(body);
            if (!doc.RootElement.TryGetProperty("error", out var err) || err.ValueKind != JsonValueKind.Object)
                return (null, null);

            var type = err.TryGetProperty("type", out var t) && t.ValueKind == JsonValueKind.String
                ? t.GetString() : null;

            // OpenAI's refinement lives in error.code; Anthropic has no equivalent, so type does
            // double duty. Either can carry the expiry signal.
            var codeField = err.TryGetProperty("code", out var c) && c.ValueKind == JsonValueKind.String
                ? c.GetString() : null;

            var message = err.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String
                ? m.GetString() : null;

            return (codeField ?? type, message);
        }
        catch (JsonException)
        {
            // An unparseable body is not itself an error — a 429 with an empty body is still
            // rate-limited (§4.1). Only a 200 with an unparseable body means anything, and that is
            // the Custom/OpenAI-only `not_openai` case handled by that adapter.
            return (null, null);
        }
    }

    private static bool Mentions(string? value, string needle) =>
        value is not null && value.Contains(needle, StringComparison.OrdinalIgnoreCase);

    private static string? Snippet(string? body) =>
        string.IsNullOrWhiteSpace(body) ? null : body.Trim()[..Math.Min(200, body.Trim().Length)];
}
