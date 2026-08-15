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

/// <summary>
/// How much a claim should worry the reviewer — a separate axis from where it came from.
///
/// <b>Provenance and severity answer different questions and neither implies the other.</b> "This
/// adds five procedures" is grounded in the diff and entirely harmless; "this will deadlock under
/// load" may be an educated guess and still the most important thing on the page. Collapsing them
/// into one label would force the badge to lie about one of the two.
///
/// Three levels, and no more, for the reason <c>BETBOT_INTEGRATION_PLAN.md</c> §4 gives for its two:
/// each needs a glyph that survives 12px, and a five-level scale does not have five such glyphs.
/// </summary>
public enum Severity
{
    /// <summary>Describing what the change does. The default, and most claims.</summary>
    Info,

    /// <summary>Worth checking before approving — a risk, or something that may be wrong.</summary>
    Warning,

    /// <summary>Wrong, and should be fixed before this merges.</summary>
    Error,
}

/// <summary>A line range in a file the agent says its answer rests on.</summary>
/// <param name="EndLine">
/// Nullable, and <em>required</em>. Strict structured output has no optional properties, so the
/// optionality has to be carried by the type union rather than by absence — see
/// <see cref="CanonicalSchema"/>.
/// </param>
public record Citation(string Path, int Line, int? EndLine);

/// <summary>
/// One claim, with its own sources attached (§5.2).
///
/// <b>A citation belongs to a claim, not to an answer.</b> The first version of this shape had one
/// <c>answer</c> string and a flat citation list at the end, and with several claims in one answer
/// there was no way to tell which citation backed which sentence — no amount of layout invents that
/// link if the model doesn't state it. So the model states it: one segment per claim, carrying its
/// own citations <em>and</em> its own provenance. One answer can honestly hold a segment grounded in
/// the diff next to a segment that is a guess, which a single badge for the whole turn was already
/// lying about.
/// </summary>
/// <param name="Text">
/// Markdown, restricted to paragraphs, unordered lists, bold and inline code — typically a sentence
/// or two, not the whole answer.
/// </param>
/// <param name="InferenceNote">
/// Required when this segment's <paramref name="Provenance"/> is <see cref="Provenance.Inferred"/>,
/// null otherwise. Rendered in a dashed box under this segment, and the reason the `inferred` badge
/// is honest rather than a shrug.
/// </param>
/// <param name="Severity">
/// How much this claim should worry the reviewer. Defaults to <see cref="Severity.Info"/>, which is
/// also what an unrecognised or missing value becomes — a claim nobody graded is not thereby urgent.
/// </param>
public record AnswerSegment(
    string Text,
    Provenance? Provenance,
    List<Citation> Citations,
    string? InferenceNote,
    Severity Severity = Severity.Info);

/// <summary>
/// The only answer shape the Review panel, the provenance badge and "Post as comment…" ever see,
/// whichever provider produced it (§5.2).
/// </summary>
/// <param name="Mode">
/// Which rung of the §5.4 ladder produced this. Mode 3 carries exactly one synthetic segment with no
/// asserted provenance, and is not postable as a PR comment (§7.4) — so the panel needs to know, but
/// the renderer never needs an "unstructured" branch.
/// </param>
public record CanonicalAnswer(
    List<AnswerSegment> Segments,
    StructuredMode Mode = StructuredMode.Structured)
{
    /// <summary>
    /// The segments' prose, joined the way §5.A asks a replayed assistant turn to be joined.
    ///
    /// This is the one place an answer is allowed to become a single string, and both its uses are
    /// deliberate: replaying history to the model, and the reviewer's own "Copy all". Nothing renders
    /// from it — rendering is per segment, or the badge and the citations go back to being pooled.
    /// </summary>
    public string PlainText => string.Join("\n\n", Segments.Select(s => s.Text).Where(t => t.Length > 0));

    /// <summary>True when nothing usable came back, whatever the mode claims.</summary>
    public bool IsEmpty => Segments.All(s => s.Text.Trim().Length == 0);
}

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
    /// Prose only, no asserted provenance. Badge reads SOURCE NOT STATED, citation strip hidden,
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
/// A tool the <b>server</b> services on the agent's behalf.
///
/// The agent never receives a credential: it names a file and Launchpad reads it with the
/// reviewer's own PAT. That is what lets repository access exist without breaking
/// BETBOT_INTEGRATION_PLAN.md's rule that the chat route gets no repo credentials — the connector
/// still has none.
/// </summary>
public record AgentToolDefinition(string Name, string Description, JsonObject InputSchema);

/// <summary>The agent asking for something. <paramref name="Id"/> correlates the result back.</summary>
public record AgentToolCall(string Id, string Name, string ArgumentsJson);

/// <param name="IsError">
/// A failure is returned <em>to the model</em> rather than thrown, so it can say "I couldn't read
/// that" instead of the whole answer dying on a missing file.
/// </param>
public record AgentToolResult(string Id, string Content, bool IsError = false);

/// <summary>One completed request/response pair, replayed so the model sees its own prior work.</summary>
public record AgentToolExchange(AgentToolCall Call, AgentToolResult Result);

/// <summary>
/// Everything an adapter is given, in provider-agnostic form (§5.0).
///
/// An adapter's whole job is turning this into one provider's native wire format and turning what
/// comes back into a <see cref="CanonicalAnswer"/>, a set of <see cref="AgentToolCall"/>s, or an
/// <see cref="AgentErrorCode"/>. Nothing upstream of an adapter, and nothing in the Review page,
/// may know which provider is configured.
/// </summary>
/// <param name="SystemPrompt">The task prompt from §5.3. Launchpad owns it, not the connector.</param>
/// <param name="Context">The assembled &lt;pull-request-context&gt; block (§5.1). Untrusted input.</param>
/// <param name="History">Prior turns, already capped and ordered oldest-first.</param>
/// <param name="Question">The reviewer's current question.</param>
/// <param name="Model">A value the provider's own model list reported.</param>
/// <param name="Tools">
/// Read-only tools offered for this exchange. Empty disables tool use entirely, which is what makes
/// the feature switchable without touching an adapter.
/// </param>
/// <param name="ToolExchanges">
/// Tool calls already serviced in <em>this</em> question, oldest first. The adapter replays them in
/// its provider's native shape so the model can see what it already asked for and got — without
/// which it asks for the same file repeatedly.
/// </param>
/// <summary>
/// Which schema a completion is being asked to fill (DESIGN_SPEC_CHANGE_MAP.md §2).
///
/// Not a provider concept. An adapter picks its tool name and schema from this instead of always
/// reaching for the answer shape, which is what lets the change map share every adapter, every
/// timeout and the whole tool loop rather than duplicating them for a second request shape.
/// </summary>
public enum ResponseKind { Answer, ChangeMap }

public record CanonicalRequest(
    string SystemPrompt,
    string Context,
    IReadOnlyList<AgentTurn> History,
    string Question,
    string Model,
    bool Stream = true,
    IReadOnlyList<AgentToolDefinition>? Tools = null,
    IReadOnlyList<AgentToolExchange>? ToolExchanges = null,
    ResponseKind ResponseKind = ResponseKind.Answer);

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
/// Wire names for <see cref="AgentErrorCode"/>, kept next to the enum that declares them — the same
/// arrangement as <see cref="ProvenanceNames"/> and <see cref="SeverityNames"/>.
///
/// <b>Not <c>ToString().ToLowerInvariant()</c>.</b> That yields <c>ratelimited</c> and
/// <c>notfound</c>, while §4 — and every client written against it — names them
/// <c>rate_limited</c> and <c>not_found</c>. The two drifted apart silently, because a code that
/// matches no branch still renders: it just falls through to the generic copy §4 calls a defect.
/// One conversion in one place is what stops that recurring.
/// </summary>
public static class AgentErrorNames
{
    public static string ToWire(AgentErrorCode code) => code switch
    {
        AgentErrorCode.NotFound => "not_found",
        AgentErrorCode.RateLimited => "rate_limited",
        AgentErrorCode.NotOpenAi => "not_openai",
        AgentErrorCode.OAuthDenied => "oauth_denied",
        AgentErrorCode.OAuthExpired => "oauth_expired",
        AgentErrorCode.NoSeat => "no_seat",
        // The single-word codes are already their own wire form.
        _ => code.ToString().ToLowerInvariant(),
    };
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
/// What a turn cost, as the provider reported it. Both nullable: not every provider reports both,
/// and a guessed number is worse than a missing one when the point is attributing spend.
/// </summary>
public record AgentUsage(int? PromptTokens, int? CompletionTokens);

/// <summary>
/// The §5.5 budget. Uniform across adapters on purpose: an adapter that cannot meet these has a
/// problem the timeout is correctly surfacing, not a reason for its own numbers.
///
/// <b>Raised from the spec's table, because the spec's table predates two things it was written
/// without.</b> §5.5 assumed one question was one call with a short prompt. It is now a loop of up to
/// five exchanges, each carrying a diff that can run to hundreds of kilobytes — and a large prompt
/// genuinely takes a long time to produce a first token, because the model reads it all before saying
/// anything. Timing that out reported "the agent didn't answer" for an agent that was working
/// correctly, which is the failure mode a timeout exists to distinguish from.
///
/// <see cref="ConnectionTest"/> is deliberately unchanged. It is a model-list call on the diagnostic
/// path — the thing a reviewer hits when something looks broken — and it must stay fast enough that
/// waiting on it is never itself the problem.
/// </summary>
public static class AgentTimeouts
{
    public static readonly TimeSpan ConnectionTest = TimeSpan.FromSeconds(10);

    /// <summary>
    /// Two minutes to the first token. Long, and it has to be: with a 700 KB diff the model reads the
    /// whole thing before it emits a character, and 20 seconds was killing perfectly good answers.
    /// </summary>
    public static readonly TimeSpan FirstToken = TimeSpan.FromMinutes(2);

    /// <summary>
    /// Per exchange, not per question. Five exchanges of a tool loop can legitimately exceed any single
    /// figure here, which is why the loop is bounded by its iteration count and its byte budget rather
    /// than by a wall clock: a cap that cannot tell "reading five files" from "hung" would have to be
    /// set high enough to be useless as either.
    /// </summary>
    public static readonly TimeSpan WholeCompletion = TimeSpan.FromMinutes(5);

    /// <summary>
    /// Silence between deltas. Raised less than the others: once tokens are flowing, a two-minute gap
    /// really is a hang, and this is the timeout that catches a stalled stream while the answer still
    /// looks like it is coming.
    /// </summary>
    public static readonly TimeSpan IdleBetweenDeltas = TimeSpan.FromSeconds(60);
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
    /// <summary>
    /// One segment closed and validated — the streaming unit (§5.2).
    ///
    /// Emitted as each array element completes, so the panel renders a whole claim with its badge and
    /// its citations rather than growing a string. An adapter that cannot detect element boundaries
    /// simply emits none of these and the finished list renders in one go from
    /// <see cref="Complete"/>; degrading is allowed, blocking is not.
    /// </summary>
    public sealed record Segment(AnswerSegment Value) : AgentEvent;

    /// <summary>
    /// Raw prose, for a connector with no structure at all (§5.4 mode 3). Fragments concatenate.
    ///
    /// Kept distinct from <see cref="Segment"/> because these two mean different things: a segment is
    /// a claim the agent labelled, this is text nobody vouched for. Conflating them is how an
    /// unverified answer would end up wearing a provenance badge.
    /// </summary>
    public sealed record Delta(string Text) : AgentEvent;

    /// <summary>The answer closed and validated. Terminal.</summary>
    /// <param name="Usage">
    /// Token counts, when the provider reports them. Carried through the boundary because it can
    /// only be captured as the answer happens — and BETBOT_INTEGRATION_PLAN.md's third ask wants
    /// per-reviewer cost, which is unanswerable from data nobody recorded.
    /// </param>
    public sealed record Complete(CanonicalAnswer Answer, AgentUsage? Usage = null) : AgentEvent;

    /// <summary>
    /// The answer failed. Terminal. Any prose already emitted stays on screen with this beside it
    /// — §6: a stream that dies at 80% renders the partial plus an error, never a partial that
    /// looks complete.
    /// </summary>
    public sealed record Failed(AgentError Error) : AgentEvent;

    /// <summary>
    /// The model wants files before it can answer. Terminal <em>for this exchange</em>, not for the
    /// question.
    ///
    /// The adapter stops here rather than looping internally. Servicing the calls and asking again
    /// is the orchestrator's job, which is what keeps the iteration cap, the byte budget and the
    /// path guardrails in one provider-agnostic place instead of duplicated per adapter — and it is
    /// why adding a third provider does not mean rewriting any of that.
    /// </summary>
    public sealed record ToolCalls(IReadOnlyList<AgentToolCall> Calls, AgentUsage? Usage = null) : AgentEvent;

    /// <summary>
    /// The change map's completed tool input, unparsed (DESIGN_SPEC_CHANGE_MAP.md §2). Terminal.
    ///
    /// Raw rather than a typed <c>ChangeMap</c> here, on purpose: an adapter's job stops at handing
    /// back what the provider said. Validating it against the paths the agent actually had in front
    /// of it needs <see cref="AgentConversation"/>'s view of the tool loop, which an adapter has no
    /// visibility into — the same reason citation resolution isn't done here either.
    /// </summary>
    public sealed record MapComplete(string Json, AgentUsage? Usage = null) : AgentEvent;
}

/// <summary>
/// What one question is allowed to spend (see the caps in this feature's commit message).
///
/// Cumulative on purpose: §5.1's 200 KB was a per-request cap when a question was a single call, and
/// carrying that reading forward would let a ten-step loop send ten times as much and call it the
/// same limit.
/// </summary>
public sealed class AgentBudget(int maxBytes = AgentBudget.DefaultMaxBytes, int maxIterations = AgentBudget.DefaultMaxIterations)
{
    /// <summary>
    /// Cumulative reading budget for one question, on top of the diff already sent.
    ///
    /// Raised alongside <see cref="PrContextBuilder.MaxDiffBytes"/>: a question that reads five files
    /// to answer "is this called anywhere" was hitting the old 200 KB before it had looked at enough
    /// to answer, and an agent that runs out of budget mid-search reports what it could not check —
    /// correct, but useless when the cause was a cap set for a smaller diff.
    /// </summary>
    public const int DefaultMaxBytes = 400 * 1024;
    public const int DefaultMaxIterations = 5;

    /// <summary>Per single read. A generated migration should not consume the whole question.</summary>
    public const int MaxLinesPerRead = 2000;

    /// <summary>
    /// Ceiling on one answer, shared by every adapter — the same question must not get a shorter
    /// answer purely because of which provider holds the capability. Hitting it is typed truncation
    /// (<c>stop_reason</c>/<c>finish_reason</c>, surfaced via <see cref="AgentErrorMapper.Truncated"/>),
    /// never a silent early ending. The §5.A fixtures quote this constant too, so the documented
    /// request and the real one cannot drift apart.
    /// </summary>
    public const int MaxAnswerTokens = 8192;

    public int MaxIterations { get; } = maxIterations;
    public int BytesSpent { get; private set; }
    public int BytesRemaining => Math.Max(0, maxBytes - BytesSpent);
    public bool Exhausted => BytesRemaining == 0;

    /// <summary>Records a spend and reports whether it fit. A refused read is told to the model.</summary>
    public bool TrySpend(int bytes)
    {
        if (bytes > BytesRemaining) return false;
        BytesSpent += bytes;
        return true;
    }
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
/// The streaming unit is a closed <em>segment</em>, not a character. Each array element is a
/// complete object, so segment <i>N</i> renders — text, badge and citations together — the moment it
/// closes, while <i>N+1</i> shows a placeholder. That reads like a person adding one thought at a
/// time rather than watching a document type itself, and it removes the old parser's whole
/// escape-decoding problem: nothing is emitted until it is valid JSON.
/// </summary>
public static class CanonicalSchema
{
    public const string Name = "pr_answer";

    /// <summary>
    /// Per segment, not per answer. Enforced here rather than in the schema, per above — and 4 rather
    /// than the old flat shape's 8, because a citation now sits with the one claim it supports and a
    /// claim resting on nine lines is not a claim.
    /// </summary>
    public const int MaxCitations = 4;

    /// <summary>
    /// Extra segments are dropped with a trace, not silently: unlike a citation, a whole missing
    /// claim is not a safe thing to lose without saying so (§5.2).
    /// </summary>
    public const int MaxSegments = 6;

    public static JsonObject Build() => new()
    {
        ["type"] = "object",
        ["additionalProperties"] = false,
        ["required"] = new JsonArray("segments"),
        ["properties"] = new JsonObject
        {
            ["segments"] = new JsonObject
            {
                ["type"] = "array",
                ["items"] = new JsonObject
                {
                    ["type"] = "object",
                    ["additionalProperties"] = false,
                    ["required"] = new JsonArray("text", "provenance", "severity", "citations", "inference_note"),
                    ["properties"] = new JsonObject
                    {
                        ["text"] = new JsonObject
                        {
                            ["type"] = "string",
                            ["description"] = "Markdown. Restricted subset: paragraphs, unordered lists, bold, "
                                            + "inline code. One claim — typically a sentence or two, not the whole answer.",
                        },
                        ["provenance"] = new JsonObject
                        {
                            ["type"] = "string",
                            ["enum"] = new JsonArray("code", "doc", "inferred"),
                        },
                        ["severity"] = new JsonObject
                        {
                            ["type"] = "string",
                            ["enum"] = new JsonArray("info", "warning", "error"),
                            ["description"] = "info = describing what the change does, and most claims are this. "
                                            + "warning = worth checking before approving. "
                                            + "error = wrong, and should be fixed before merging.",
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
                            ["description"] = "Required when this segment's provenance is 'inferred'; null otherwise.",
                        },
                    },
                },
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

/// <summary>Wire names for <see cref="Severity"/>, kept next to the schema that declares them.</summary>
public static class SeverityNames
{
    /// <summary>
    /// Unrecognised and missing both become <see cref="Severity.Info"/>. A claim nobody graded is not
    /// thereby urgent, and defaulting the other way would make every schema slip look like a problem
    /// in the code being reviewed.
    /// </summary>
    public static Severity Parse(string? value) => value switch
    {
        "warning" => Severity.Warning,
        "error" => Severity.Error,
        _ => Severity.Info,
    };

    public static string ToWire(Severity s) => s switch
    {
        Severity.Warning => "warning",
        Severity.Error => "error",
        _ => "info",
    };
}

// ============================================================================================
// The change map (DESIGN_SPEC_CHANGE_MAP.md). A second, smaller schema beside the answer's: the
// model emits a typed graph — groups, edges, an optional flow — in a closed vocabulary, and every
// honesty rule §5.2 puts on a claim applies here too. Geometry belongs to the client; nothing here
// says where a box goes on screen.
// ============================================================================================

/// <summary>
/// Which architectural style the agent read the repository as (§2). <c>Unknown</c> is a real answer,
/// not an absence — a map that cannot be classified still groups by area, just without a depth axis.
/// </summary>
public enum ArchitectureStyle { Clean, Layers, Modules, Pipeline, Unknown }

/// <summary>Wire names for <see cref="ArchitectureStyle"/>, kept next to the schema that declares them.</summary>
public static class ArchitectureStyleNames
{
    public static ArchitectureStyle Parse(string? value) => value switch
    {
        "clean" => ArchitectureStyle.Clean,
        "layers" => ArchitectureStyle.Layers,
        "modules" => ArchitectureStyle.Modules,
        "pipeline" => ArchitectureStyle.Pipeline,
        _ => ArchitectureStyle.Unknown,
    };

    public static string ToWire(ArchitectureStyle s) => s switch
    {
        ArchitectureStyle.Clean => "clean",
        ArchitectureStyle.Layers => "layers",
        ArchitectureStyle.Modules => "modules",
        ArchitectureStyle.Pipeline => "pipeline",
        _ => "unknown",
    };
}

/// <summary>
/// Where the classification came from (§3) — the same <c>FROM STRUCTURE</c> / <c>INFERRED</c> pill
/// vocabulary as <see cref="Provenance"/>, because a reviewer who has learned one has learned both.
/// </summary>
public enum StyleBasis { Structure, Inferred }

/// <summary>Wire names for <see cref="StyleBasis"/>, kept next to the schema that declares them.</summary>
public static class StyleBasisNames
{
    /// <summary>Missing or unrecognised becomes <see cref="StyleBasis.Inferred"/> — the same
    /// direction <see cref="SeverityNames"/> defaults in, and for the same reason: the badge that
    /// claims a fact is the one that needs asserting, not the one that admits a guess.</summary>
    public static StyleBasis Parse(string? value) => value == "structure" ? StyleBasis.Structure : StyleBasis.Inferred;

    public static string ToWire(StyleBasis b) => b == StyleBasis.Structure ? "structure" : "inferred";
}

/// <summary>One changed file cited as part of a group's evidence.</summary>
public record ChangeMapFile(string Path, int Added, int Removed);

/// <summary>
/// A name for one depth on the outer-to-core axis (§2) — "Domain core", "Application",
/// "Infrastructure".
///
/// Asked for rather than derived, because only the agent knows what this repository calls its
/// layers. Deriving them from the depth number produced band labels reading "DEPTH 2", which names
/// the axis position and tells the reviewer nothing about what lives there.
/// </summary>
public record ChangeMapLayer(int Depth, string Name);

/// <summary>
/// One area of the change (§2). <paramref name="Depth"/> is 0 at the innermost (domain) layer and
/// increases outward — arithmetic the client uses to draw the dependency-rule overlay (§5), not a
/// display order.
/// </summary>
public record ChangeMapGroup(string Id, string Name, int Depth, string Summary, List<ChangeMapFile> Files);

/// <summary>
/// A dependency between two groups, in the direction of the call: <paramref name="From"/> depends on
/// or calls <paramref name="To"/>. The client's own arithmetic — not the model's — decides whether
/// that direction is a violation under the declared <see cref="ArchitectureStyle"/> (§5).
/// </summary>
public record ChangeMapEdge(string From, string To, string Label);

/// <summary>
/// One step of the user-facing flow this change serves, if it has one (§2). Optional: a pure
/// refactor or a schema-only change may have no single request/response path to narrate.
/// </summary>
/// <param name="Action">A short phrase. What the map's flow overlay and its step chips show.</param>
/// <param name="Detail">
/// The wizard's narration for this step (§8): what happens here, what this pull request changed
/// about it, and how that serves what the PR set out to do. A paragraph rather than a phrase —
/// <paramref name="Action"/> is the label, this is the slide.
/// </param>
public record ChangeMapFlowStep(int Step, string Group, string Action, string Detail);

/// <summary>
/// The whole map, validated and capped (§2, §7). Never partially valid on the wire: a group survives
/// entire or is dropped entire, and a map with zero surviving groups is a parser failure, not an
/// empty diagram — see <see cref="ChangeMapParser"/>.
/// </summary>
public record ChangeMap(
    ArchitectureStyle Style,
    StyleBasis StyleBasis,
    List<ChangeMapGroup> Groups,
    List<ChangeMapEdge> Edges,
    List<ChangeMapFlowStep> Flow,
    List<ChangeMapLayer> Layers);

/// <summary>
/// The change-map schema (§2), built once so the prompt, the forced tool call and the fixture all
/// quote the same caps.
///
/// Same two constraints as <see cref="CanonicalSchema"/> and for the same reason: every property is
/// in <c>required</c> because strict structured output has no optional properties, and there is no
/// <c>maxItems</c> because several strict implementations reject it outright — the caps below are
/// enforced by <see cref="ChangeMapParser"/> instead, which trims rather than failing the whole
/// response.
/// </summary>
public static class ChangeMapSchema
{
    public const string Name = "pr_change_map";

    /// <summary>A map with forty nodes is the diff again, with worse typography (§2).</summary>
    public const int MaxGroups = 8;
    public const int MaxEdges = 14;
    public const int MaxFlowSteps = 6;

    public static JsonObject Build() => new()
    {
        ["type"] = "object",
        ["additionalProperties"] = false,
        ["required"] = new JsonArray("style", "style_basis", "layers", "groups", "edges", "flow"),
        ["properties"] = new JsonObject
        {
            ["style"] = new JsonObject
            {
                ["type"] = "string",
                ["enum"] = new JsonArray("clean", "layers", "modules", "pipeline", "unknown"),
            },
            ["style_basis"] = new JsonObject
            {
                ["type"] = "string",
                ["enum"] = new JsonArray("structure", "inferred"),
                ["description"] = "structure = the folders, projects or a checked-in doc say so outright. "
                                + "inferred = you are reading the shape from convention, not from something stated.",
            },
            ["layers"] = new JsonObject
            {
                ["type"] = "array",
                ["items"] = new JsonObject
                {
                    ["type"] = "object",
                    ["additionalProperties"] = false,
                    ["required"] = new JsonArray("depth", "name"),
                    ["properties"] = new JsonObject
                    {
                        ["depth"] = new JsonObject { ["type"] = "integer" },
                        ["name"] = new JsonObject
                        {
                            ["type"] = "string",
                            ["description"] = "Short name for this depth, two or three words: "
                                            + "\"Domain core\", \"Application\", \"Infrastructure\".",
                        },
                    },
                },
                ["description"] = "One entry per distinct depth used by groups, naming what lives at "
                                + "that level in this repository's own vocabulary.",
            },
            ["groups"] = new JsonObject
            {
                ["type"] = "array",
                ["items"] = new JsonObject
                {
                    ["type"] = "object",
                    ["additionalProperties"] = false,
                    ["required"] = new JsonArray("id", "name", "depth", "summary", "files"),
                    ["properties"] = new JsonObject
                    {
                        ["id"] = new JsonObject { ["type"] = "string", ["description"] = "Short, stable, referenced by edges and flow." },
                        ["name"] = new JsonObject { ["type"] = "string" },
                        ["depth"] = new JsonObject
                        {
                            ["type"] = "integer",
                            ["description"] = "0 = innermost/domain layer. Increases outward, toward infrastructure and edges.",
                        },
                        ["summary"] = new JsonObject
                        {
                            ["type"] = "string",
                            ["description"] = "One sentence: what changed here and why it matters.",
                        },
                        ["files"] = new JsonObject
                        {
                            ["type"] = "array",
                            ["items"] = new JsonObject
                            {
                                ["type"] = "object",
                                ["additionalProperties"] = false,
                                ["required"] = new JsonArray("path", "added", "removed"),
                                ["properties"] = new JsonObject
                                {
                                    ["path"] = new JsonObject { ["type"] = "string" },
                                    ["added"] = new JsonObject { ["type"] = "integer" },
                                    ["removed"] = new JsonObject { ["type"] = "integer" },
                                },
                            },
                        },
                    },
                },
            },
            ["edges"] = new JsonObject
            {
                ["type"] = "array",
                ["items"] = new JsonObject
                {
                    ["type"] = "object",
                    ["additionalProperties"] = false,
                    ["required"] = new JsonArray("from", "to", "label"),
                    ["properties"] = new JsonObject
                    {
                        ["from"] = new JsonObject { ["type"] = "string", ["description"] = "A group id. The dependent side." },
                        ["to"] = new JsonObject { ["type"] = "string", ["description"] = "A group id. The depended-on side." },
                        ["label"] = new JsonObject { ["type"] = "string", ["description"] = "A short verb phrase: \"builds\", \"calls\", \"reads\"." },
                    },
                },
            },
            ["flow"] = new JsonObject
            {
                ["type"] = "array",
                ["items"] = new JsonObject
                {
                    ["type"] = "object",
                    ["additionalProperties"] = false,
                    ["required"] = new JsonArray("step", "group", "action", "detail"),
                    ["properties"] = new JsonObject
                    {
                        ["step"] = new JsonObject { ["type"] = "integer" },
                        ["group"] = new JsonObject { ["type"] = "string", ["description"] = "A group id." },
                        ["action"] = new JsonObject
                        {
                            ["type"] = "string",
                            ["description"] = "A short phrase — this is a label on a diagram, not a sentence.",
                        },
                        ["detail"] = new JsonObject
                        {
                            ["type"] = "string",
                            ["description"] = "Two to four sentences for the reviewer walking this change step by "
                                            + "step: what happens at this point, what this pull request changed "
                                            + "about it, and how that serves what the pull request set out to do.",
                        },
                    },
                },
                ["description"] = "Empty when this change has no single user-facing request/response path to "
                                + "narrate — a pure refactor or a schema-only change, for instance.",
            },
        },
    };
}

/// <summary>
/// Validates and caps a change map against what the agent actually had in front of it.
///
/// <b>No partial diagram, ever (§7).</b> A group whose every file fails validation is dropped whole,
/// never rendered with an empty file list; a map with zero surviving groups is reported as a parse
/// failure so the panel offers Retry, rather than an empty sheet that looks like a real answer with
/// nothing in it. This is the same reasoning <see cref="AgentConversation"/> applies to an empty
/// answer, applied to a graph instead of a list of segments.
/// </summary>
public static class ChangeMapParser
{
    public static ChangeMap? Parse(string json, IReadOnlyCollection<string> knownPaths)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;

        JsonDocument doc;
        try { doc = JsonDocument.Parse(json); }
        catch (JsonException) { return null; }

        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;

            var style = ArchitectureStyleNames.Parse(Str(root, "style"));
            var basis = StyleBasisNames.Parse(Str(root, "style_basis"));

            var known = new HashSet<string>(knownPaths.Select(Normalise), StringComparer.OrdinalIgnoreCase);

            var groups = new List<ChangeMapGroup>();
            if (root.TryGetProperty("groups", out var gs) && gs.ValueKind == JsonValueKind.Array)
            {
                foreach (var g in gs.EnumerateArray())
                {
                    if (groups.Count >= ChangeMapSchema.MaxGroups) break;
                    if (g.ValueKind != JsonValueKind.Object) continue;

                    var id = Str(g, "id");
                    if (string.IsNullOrWhiteSpace(id)) continue;

                    var files = new List<ChangeMapFile>();
                    if (g.TryGetProperty("files", out var fs) && fs.ValueKind == JsonValueKind.Array)
                        foreach (var f in fs.EnumerateArray())
                        {
                            if (f.ValueKind != JsonValueKind.Object) continue;
                            var path = Str(f, "path");
                            // The one hard rule: a citation to a file nobody showed the agent is
                            // invented, same as a citation on an answer segment (§5.2).
                            if (string.IsNullOrWhiteSpace(path) || !known.Contains(Normalise(path))) continue;
                            files.Add(new ChangeMapFile(path, Int(f, "added"), Int(f, "removed")));
                        }

                    // Every path failed validation: this group is not evidence of anything the
                    // agent could actually show, so it is dropped whole rather than rendered empty.
                    if (files.Count == 0) continue;

                    groups.Add(new ChangeMapGroup(id, Str(g, "name") ?? id, Int(g, "depth"), Str(g, "summary") ?? "", files));
                }
            }

            if (groups.Count == 0) return null;

            var groupIds = new HashSet<string>(groups.Select(g => g.Id), StringComparer.Ordinal);

            var edges = new List<ChangeMapEdge>();
            if (root.TryGetProperty("edges", out var es) && es.ValueKind == JsonValueKind.Array)
                foreach (var e in es.EnumerateArray())
                {
                    if (edges.Count >= ChangeMapSchema.MaxEdges) break;
                    if (e.ValueKind != JsonValueKind.Object) continue;
                    var from = Str(e, "from");
                    var to = Str(e, "to");
                    // Both ends have to survive group validation, or the edge points at a box that
                    // no longer exists on the map.
                    if (string.IsNullOrWhiteSpace(from) || string.IsNullOrWhiteSpace(to)) continue;
                    if (!groupIds.Contains(from) || !groupIds.Contains(to)) continue;
                    edges.Add(new ChangeMapEdge(from, to, Str(e, "label") ?? ""));
                }

            // Renumbered to array order rather than trusting the model's own step numbers, which are
            // free-form integers in the schema and not guaranteed to be sequential or unique.
            var flow = new List<ChangeMapFlowStep>();
            if (root.TryGetProperty("flow", out var fls) && fls.ValueKind == JsonValueKind.Array)
                foreach (var fl in fls.EnumerateArray())
                {
                    if (flow.Count >= ChangeMapSchema.MaxFlowSteps) break;
                    if (fl.ValueKind != JsonValueKind.Object) continue;
                    var group = Str(fl, "group");
                    if (string.IsNullOrWhiteSpace(group) || !groupIds.Contains(group)) continue;
                    flow.Add(new ChangeMapFlowStep(
                        flow.Count + 1, group, Str(fl, "action") ?? "", Str(fl, "detail") ?? ""));
                }

            // Only depths a surviving group actually occupies: a name for a band with nothing in it
            // would render an empty row.
            var usedDepths = new HashSet<int>(groups.Select(g => g.Depth));
            var layers = new List<ChangeMapLayer>();
            if (root.TryGetProperty("layers", out var ls) && ls.ValueKind == JsonValueKind.Array)
                foreach (var l in ls.EnumerateArray())
                {
                    if (l.ValueKind != JsonValueKind.Object) continue;
                    var depth = Int(l, "depth");
                    var lname = Str(l, "name");
                    if (string.IsNullOrWhiteSpace(lname) || !usedDepths.Contains(depth)) continue;
                    if (layers.Any(x => x.Depth == depth)) continue;
                    layers.Add(new ChangeMapLayer(depth, lname));
                }

            return new ChangeMap(style, basis, groups, edges, flow, layers);
        }
    }

    private static string Normalise(string path) => path.TrimStart('/');

    private static string? Str(JsonElement obj, string prop) =>
        obj.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static int Int(JsonElement obj, string prop) =>
        obj.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) ? n : 0;
}
