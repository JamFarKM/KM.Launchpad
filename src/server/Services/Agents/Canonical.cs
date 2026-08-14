using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace PipelineLaunchpad.Server.Services.Agents;

/// <summary>
/// Where an answer came from (DESIGN_SPEC_CONNECTORS.md §5.2).
///
/// Only ever a value the agent asserted. Never derived from whether citations happen to be
/// present, never carried over from a previous turn — the whole point of the label is that it is
/// the agent's claim, so inventing one would make the badge a decoration.
/// </summary>
public enum Provenance { Code, Doc, Inferred }

/// <summary>A line range in a file the agent says its answer rests on.</summary>
/// <param name="EndLine">
/// Nullable, and <em>required</em>. Strict structured output has no optional properties, so the
/// optionality has to be carried by the type union rather than by absence — see
/// <see cref="CanonicalSchema"/>.
/// </param>
public record Citation(string Path, int Line, int? EndLine);

/// <summary>
/// The only answer shape the Review panel, the provenance badge and "Post as comment…" ever see,
/// whichever provider produced it (§5.2).
/// </summary>
/// <param name="InferenceNote">
/// Required when <paramref name="Provenance"/> is <see cref="Provenance.Inferred"/>, null
/// otherwise. Rendered in a dashed box, and the reason the `inferred` badge is honest rather than
/// a shrug.
/// </param>
/// <param name="Mode">
/// Which rung of the §5.4 ladder produced this. Mode 3 answers carry no asserted provenance and
/// are not postable as a PR comment (§7.4), so the panel needs to know.
/// </param>
public record CanonicalAnswer(
    string Answer,
    Provenance? Provenance,
    List<Citation> Citations,
    string? InferenceNote,
    StructuredMode Mode = StructuredMode.Structured);

/// <summary>
/// The rungs of the fallback ladder in §5.4. Modes 2 and 3 are real degradations and must look
/// like ones — this enum is what stops that being a judgement call further up.
/// </summary>
public enum StructuredMode
{
    /// <summary>Provider produced the canonical schema natively. Full badge and citations.</summary>
    Structured,

    /// <summary>A fenced JSON block in prose, parsed and validated by us. Same UI as structured.</summary>
    FencedJson,

    /// <summary>
    /// Prose only, no asserted provenance. Badge reads UNVERIFIED SOURCE, citation strip hidden,
    /// and the answer cannot be posted to the pull request.
    /// </summary>
    Unverified,
}

/// <summary>One prior exchange, replayed on every request so connectors stay stateless (§5.A).</summary>
/// <param name="Answer">
/// The <c>answer</c> field only, never the JSON envelope. Re-feeding the envelope teaches the
/// model to talk about its own metadata.
/// </param>
public record AgentTurn(string Question, string Answer);

/// <summary>
/// Everything an adapter is given, in provider-agnostic form (§5.0).
///
/// An adapter's whole job is turning this into one provider's native wire format and turning what
/// comes back into a <see cref="CanonicalAnswer"/> or an <see cref="AgentErrorCode"/>. Nothing
/// upstream of an adapter, and nothing in the Review page, may know which provider is configured.
/// </summary>
/// <param name="SystemPrompt">The task prompt from §5.3. Launchpad owns it, not the connector.</param>
/// <param name="Context">The assembled &lt;pull-request-context&gt; block (§5.1). Untrusted input.</param>
/// <param name="History">Prior turns, already capped and ordered oldest-first.</param>
/// <param name="Question">The reviewer's current question.</param>
/// <param name="Model">A value the provider's own model list reported.</param>
public record CanonicalRequest(
    string SystemPrompt,
    string Context,
    IReadOnlyList<AgentTurn> History,
    string Question,
    string Model,
    bool Stream = true);

/// <summary>
/// The §4 taxonomy, as an enum so a failure cannot reach the UI as free text.
///
/// Each adapter maps its provider's native error shape onto this; the UI copy is chosen from the
/// code, never from an exception message. The three OAuth codes are here for completeness even
/// though no OAuth adapter exists yet — leaving them out would invite a second enum later.
/// </summary>
public enum AgentErrorCode
{
    Dns, Refused, Tls, Timeout, Auth, Expired, NotFound,
    Unsupported, RateLimited, Upstream, NotOpenAi,
    OAuthDenied, OAuthExpired, NoSeat,
}

/// <summary>
/// A typed failure. <paramref name="Detail"/> carries only values the §4 table says may be shown —
/// a host, a status, a duration — never a credential and never a raw exception.
/// </summary>
public record AgentError(
    AgentErrorCode Code,
    int? HttpStatus = null,
    string? Detail = null,
    int? RetryAfterSeconds = null);

/// <summary>Result of the cheap model-list call behind "Test connection" (§4).</summary>
public record AgentProbe(bool Ok, long LatencyMs, List<string> Models, AgentError? Error);

/// <summary>
/// The §5.5 budget. Uniform across adapters on purpose: an adapter that cannot meet these has a
/// problem the timeout is correctly surfacing, not a reason for its own numbers.
/// </summary>
public static class AgentTimeouts
{
    public static readonly TimeSpan ConnectionTest = TimeSpan.FromSeconds(10);
    public static readonly TimeSpan FirstToken = TimeSpan.FromSeconds(20);
    public static readonly TimeSpan WholeCompletion = TimeSpan.FromSeconds(120);
    public static readonly TimeSpan IdleBetweenDeltas = TimeSpan.FromSeconds(30);
}

/// <summary>
/// The one shape every adapter implements (§5.0). Deliberately tiny: a probe and a completion.
/// Anything richer would be an invitation to leak a provider concept through it.
/// </summary>
public interface IAgentAdapter
{
    /// <summary>The provider key this adapter serves.</summary>
    string Provider { get; }

    /// <summary>
    /// The provider's own model-list call — cheap, and the diagnostic behind "Test connection".
    /// Never throws for a provider-side failure; returns an <see cref="AgentError"/> instead, so
    /// the taxonomy is the only path a failure can take.
    /// </summary>
    Task<AgentProbe> ProbeAsync(AgentTarget target, CancellationToken ct);

    /// <summary>
    /// Ask a question. Emits zero or more prose fragments as they arrive, then exactly one
    /// terminal result. Implementations must not buffer the whole answer before yielding.
    /// </summary>
    IAsyncEnumerable<AgentEvent> CompleteAsync(AgentTarget target, CanonicalRequest request, CancellationToken ct);
}

/// <summary>
/// Where to send a request and what to authenticate with — the decrypted half of a connector.
///
/// Built at the point of use and never stored, so a plaintext credential exists only for the life
/// of one outbound call. Deliberately not the <c>Connector</c> entity: an adapter has no business
/// with capability assignments, display names or error history.
/// </summary>
public record AgentTarget(string Provider, string? BaseUrl, string Credential);

/// <summary>
/// What flows out of an adapter while an answer is being produced. Launchpad's own vocabulary —
/// no adapter may surface a provider-shaped event, which is what §6 means by normalising the
/// difference away before a byte reaches the client.
/// </summary>
public abstract record AgentEvent
{
    /// <summary>More prose. Fragments concatenate; each is already-decoded text, not JSON.</summary>
    public sealed record Delta(string Text) : AgentEvent;

    /// <summary>The answer closed and validated. Terminal.</summary>
    public sealed record Complete(CanonicalAnswer Answer) : AgentEvent;

    /// <summary>
    /// The answer failed. Terminal. Any prose already emitted stays on screen with this beside it
    /// — §6: a stream that dies at 80% renders the partial plus an error, never a partial that
    /// looks complete.
    /// </summary>
    public sealed record Failed(AgentError Error) : AgentEvent;
}

/// <summary>
/// The canonical response schema (§5.2), built once so no adapter hand-writes its own copy.
///
/// Two constraints here are easy to miss and make the schema <em>invalid</em> rather than merely
/// loose, and both are load-bearing for every provider that validates strictly:
///
/// <list type="bullet">
/// <item>
/// Every property appears in <c>required</c>. Strict structured output has no optional
/// properties, which is why <c>end_line</c> is required and carries its optionality in a
/// <c>["integer","null"]</c> union instead, and the same for <c>inference_note</c>.
/// </item>
/// <item>
/// No <c>maxItems</c>. Array length keywords are unsupported by several strict implementations,
/// so the 8-citation cap is enforced in our parser — see <see cref="CanonicalAnswerParser"/>.
/// Encoding it here would reject the whole response rather than trimming a list.
/// </item>
/// </list>
///
/// <c>answer</c> is first deliberately: under streaming the object arrives as fragments, so a
/// provider emitting keys in schema order lets prose render while the trailing metadata is still
/// being produced. That is a request, never a guarantee — see the parser's degradation path.
/// </summary>
public static class CanonicalSchema
{
    public const string Name = "pr_answer";

    /// <summary>Maximum citations kept. Enforced here rather than in the schema, per above.</summary>
    public const int MaxCitations = 8;

    public static JsonObject Build() => new()
    {
        ["type"] = "object",
        ["additionalProperties"] = false,
        ["required"] = new JsonArray("answer", "provenance", "citations", "inference_note"),
        ["properties"] = new JsonObject
        {
            ["answer"] = new JsonObject
            {
                ["type"] = "string",
                ["description"] = "Markdown. Restricted subset: paragraphs, unordered lists, bold, inline code.",
            },
            ["provenance"] = new JsonObject
            {
                ["type"] = "string",
                ["enum"] = new JsonArray("code", "doc", "inferred"),
            },
            ["citations"] = new JsonObject
            {
                ["type"] = "array",
                ["items"] = new JsonObject
                {
                    ["type"] = "object",
                    ["additionalProperties"] = false,
                    ["required"] = new JsonArray("path", "line", "end_line"),
                    ["properties"] = new JsonObject
                    {
                        ["path"] = new JsonObject { ["type"] = "string" },
                        ["line"] = new JsonObject { ["type"] = "integer" },
                        ["end_line"] = new JsonObject { ["type"] = new JsonArray("integer", "null") },
                    },
                },
            },
            ["inference_note"] = new JsonObject
            {
                ["type"] = new JsonArray("string", "null"),
                ["description"] = "Required when provenance is 'inferred'; null otherwise.",
            },
        },
    };

    public static string ToJson() => Build().ToJsonString(new JsonSerializerOptions { WriteIndented = true });
}

/// <summary>Wire names for <see cref="Provenance"/>, kept next to the schema that declares them.</summary>
public static class ProvenanceNames
{
    public static Provenance? Parse(string? value) => value switch
    {
        "code" => Provenance.Code,
        "doc" => Provenance.Doc,
        "inferred" => Provenance.Inferred,
        _ => null,
    };

    public static string ToWire(Provenance p) => p switch
    {
        Provenance.Code => "code",
        Provenance.Doc => "doc",
        _ => "inferred",
    };
}
