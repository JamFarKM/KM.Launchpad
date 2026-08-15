using System.Text;
using System.Text.Json;

namespace PipelineLaunchpad.Server.Services.Agents;

/// <summary>
/// Reads a canonical answer (§5.2) out of JSON that arrives in fragments, one segment at a time.
///
/// <b>This replaced a character-level parser, and the shape change is what made it simpler rather
/// than harder.</b> When an answer was one <c>answer</c> string, progressive rendering meant decoding
/// that string as it grew — which meant holding back partial <c>\u00</c> escapes, tracking whether a
/// brace was inside prose, and hoping the provider emitted keys in schema order. Now the streaming
/// unit is a closed array element, so nothing is emitted until it is valid JSON and every one of
/// those problems is somebody else's: <see cref="JsonDocument"/>'s.
///
/// What it still has to get right:
///
/// <list type="bullet">
/// <item>
/// <b>Track strings when counting braces.</b> A <c>{</c> inside a segment's own prose must not look
/// like a nested object, or the element never appears to close and the segment never renders.
/// </item>
/// <item>
/// <b>Never require the array to close.</b> A stream that dies at 80% has already delivered whole
/// segments; those are kept and rendered, with the failure beside them (§6). Only the segment that
/// was mid-flight is lost, because it was never a complete claim.
/// </item>
/// <item>
/// <b>Degrade, never block.</b> An adapter that can't stream element boundaries feeds everything at
/// the end; the same code path finds the same segments, just all at once (§5.2).
/// </item>
/// </list>
/// </summary>
public sealed class SegmentStreamParser
{
    private readonly StringBuilder _raw = new();
    private readonly List<AnswerSegment> _segments = [];

    private int _cursor;
    private bool _inArray;
    private int _elementStart = -1;
    private int _depth;
    private bool _inString;
    private bool _escaped;
    private bool _overflowed;

    /// <summary>Segments closed so far, in arrival order.</summary>
    public IReadOnlyList<AnswerSegment> Segments => _segments;

    /// <summary>True once the segments array has closed.</summary>
    public bool ArrayClosed { get; private set; }

    /// <summary>
    /// Feed the next fragment. Returns the segments that closed within it — usually none, since a
    /// segment spans many fragments.
    /// </summary>
    public IReadOnlyList<AnswerSegment> Feed(string chunk)
    {
        if (string.IsNullOrEmpty(chunk)) return [];
        _raw.Append(chunk);
        return Scan();
    }

    /// <summary>
    /// Finish, and produce the canonical answer.
    ///
    /// <paramref name="fallbackProse"/> is used when the payload turned out not to be the schema at
    /// all — mode 3 of §5.4, where the connector answered in plain prose. That becomes exactly one
    /// synthetic segment with no asserted provenance, which is why the renderer never needs an
    /// "unstructured" branch: it already knows how to draw one segment. Nothing here guesses a
    /// provenance value.
    /// </summary>
    public CanonicalAnswer Finish(string? fallbackProse = null)
    {
        if (_segments.Count == 0)
        {
            var prose = (fallbackProse ?? _raw.ToString()).Trim();

            /* Nothing usable at all: no segments, and no prose to fall back on. That is the agent
               returning an empty answer — `{"segments":[]}` is schema-valid, and a conversational
               follow-up ("this is fine though, right?") is exactly when a model produces one.

               Returned as an answer with no segments rather than as one empty segment. The empty
               segment was the bug: it stored and rendered as a provenance badge floating over nothing,
               which reads as the agent having said something unverifiable rather than as it having
               said nothing at all. The caller turns this into a typed failure. */
            if (prose.Length == 0) return new CanonicalAnswer([], StructuredMode.Unverified);

            return Unverified(prose);
        }

        if (_overflowed)
        {
            // Appended to the last kept segment rather than dropped silently: a reviewer who can see
            // that something was cut can ask for it, and one who can't will assume they read all of it.
            var last = _segments[^1];
            _segments[^1] = last with
            {
                Text = last.Text.TrimEnd()
                     + $"\n\n_This answer had more than {CanonicalSchema.MaxSegments} parts; the rest were "
                     + "dropped. Ask a narrower question to see them._",
            };
        }

        var answer = new CanonicalAnswer([.._segments]);
        if (!answer.IsEmpty) return answer;

        // Segments arrived but every one of them was empty. Same reasoning as above: fall back to
        // prose if there is any, and otherwise report nothing rather than a badge over nothing.
        var salvage = (fallbackProse ?? "").Trim();
        return salvage.Length == 0
            ? new CanonicalAnswer([], StructuredMode.Unverified)
            : Unverified(salvage);
    }

    private static CanonicalAnswer Unverified(string prose) =>
        new([new AnswerSegment(prose, null, [], null)], StructuredMode.Unverified);

    /// <summary>
    /// Walk newly arrived characters, closing elements as their braces balance.
    ///
    /// One pass, resumable: the cursor and the string/depth state persist across fragments, so a
    /// segment split down the middle costs nothing to reassemble.
    /// </summary>
    private List<AnswerSegment> Scan()
    {
        var closed = new List<AnswerSegment>();
        var text = _raw.ToString();

        if (!_inArray)
        {
            var at = FindSegmentsArrayStart(text, _cursor);
            if (at < 0) return closed;
            _cursor = at;
            _inArray = true;
        }

        while (_cursor < text.Length)
        {
            var ch = text[_cursor];

            if (_elementStart < 0)
            {
                /* Between elements, strings are tracked exactly as they are inside one. The schema
                   says every element is an object, but a degraded payload can put a bare string
                   here — and a ']' or '{' inside it must not read as the array closing or an
                   element opening, or every real segment after it is thrown away. */
                if (_inString)
                {
                    if (_escaped) _escaped = false;
                    else if (ch == '\\') _escaped = true;
                    else if (ch == '"') _inString = false;
                }
                else if (ch == '"') _inString = true;
                else if (ch == '{')
                {
                    _elementStart = _cursor;
                    _depth = 1;
                }
                else if (ch == ']')
                {
                    ArrayClosed = true;
                    _cursor++;
                    break;
                }
                _cursor++;
                continue;
            }

            if (_inString)
            {
                if (_escaped) _escaped = false;
                else if (ch == '\\') _escaped = true;
                else if (ch == '"') _inString = false;
            }
            else if (ch == '"') _inString = true;
            else if (ch is '{' or '[') _depth++;
            else if (ch is '}' or ']')
            {
                _depth--;
                if (_depth == 0)
                {
                    var json = text[_elementStart..(_cursor + 1)];
                    _elementStart = -1;
                    var segment = Read(json);
                    if (segment is not null)
                    {
                        if (_segments.Count >= CanonicalSchema.MaxSegments) _overflowed = true;
                        else { _segments.Add(segment); closed.Add(segment); }
                    }
                }
            }

            _cursor++;
        }

        return closed;
    }

    /// <summary>
    /// One element, validated. Returns null for an element that isn't a claim at all — a segment with
    /// no prose has nothing to render and nothing to badge.
    /// </summary>
    private static AnswerSegment? Read(string json)
    {
        JsonElement root;
        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(json);
            root = doc.RootElement;
        }
        catch (JsonException)
        {
            return null;
        }

        using (doc)
        {
            if (root.ValueKind != JsonValueKind.Object) return null;

            var text = root.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String
                ? t.GetString() ?? ""
                : "";
            if (text.Trim().Length == 0) return null;

            var provenance = root.TryGetProperty("provenance", out var p) && p.ValueKind == JsonValueKind.String
                ? ProvenanceNames.Parse(p.GetString())
                : null;

            // A separate axis from provenance, and read independently: a grounded claim can be
            // harmless and a guess can be the most important thing on the page.
            var severity = SeverityNames.Parse(
                root.TryGetProperty("severity", out var sv) && sv.ValueKind == JsonValueKind.String
                    ? sv.GetString()
                    : null);

            var note = root.TryGetProperty("inference_note", out var n) && n.ValueKind == JsonValueKind.String
                ? n.GetString()
                : null;

            // §5.2: inference_note is required when this segment's provenance is inferred. A hedge
            // with nothing in the box is worse than no badge, so the segment drops to unverified
            // rather than rendering an empty dashed box. Per segment — a hedge on one claim never
            // taints another in the same answer.
            // The severity survives this degradation: losing confidence in where a claim came from is
            // no reason to stop telling the reviewer it might break something.
            if (provenance == Provenance.Inferred && string.IsNullOrWhiteSpace(note))
                return new AnswerSegment(text, null, [], null, severity);

            // A note on a non-inferred segment is a contradiction in the agent's own output. Keep the
            // claim, drop the note: the badge is what we render, so it wins.
            if (provenance != Provenance.Inferred) note = null;

            return new AnswerSegment(text, provenance, ReadCitations(root), note, severity);
        }
    }

    /// <summary>
    /// This segment's citations, capped.
    ///
    /// §5.2: the cap lives here rather than in the schema, because <c>maxItems</c> is unsupported by
    /// several strict implementations — so extras are dropped instead of failing the whole response.
    /// Path filtering is deliberately <em>not</em> done here: whether a path is one the reviewer can
    /// click depends on the diff and on what the agent read, and this class knows neither. See
    /// <see cref="AgentConversation"/>, which knows both.
    /// </summary>
    private static List<Citation> ReadCitations(JsonElement root)
    {
        var citations = new List<Citation>();
        if (!root.TryGetProperty("citations", out var arr) || arr.ValueKind != JsonValueKind.Array)
            return citations;

        foreach (var c in arr.EnumerateArray())
        {
            if (citations.Count >= CanonicalSchema.MaxCitations) break;
            if (c.ValueKind != JsonValueKind.Object) continue;

            var path = c.TryGetProperty("path", out var pv) && pv.ValueKind == JsonValueKind.String
                ? pv.GetString()
                : null;
            if (string.IsNullOrWhiteSpace(path)) continue;

            // ValueKind must be checked before TryGetInt32: it *throws* on a JSON null rather than
            // returning false, and `end_line: null` is the documented normal case for a single-line
            // citation — so the obvious-looking version crashes on the first real citation.
            if (!c.TryGetProperty("line", out var lv)
                || lv.ValueKind != JsonValueKind.Number
                || !lv.TryGetInt32(out var line)) continue;

            int? end = c.TryGetProperty("end_line", out var ev)
                && ev.ValueKind == JsonValueKind.Number
                && ev.TryGetInt32(out var e)
                ? e : null;
            // A range that ends before it starts is a mistake, not a range. Keep the anchor line,
            // which is the part the chip and the gutter marker both use.
            if (end is not null && end < line) end = null;

            citations.Add(new Citation(path!, line, end));
        }

        return citations;
    }

    /// <summary>
    /// Index of the first character *inside* the <c>segments</c> array, or -1 if it hasn't arrived.
    /// Matches the key followed by a colon and a bracket, so the word "segments" occurring inside
    /// some other string can't be mistaken for the key itself.
    /// </summary>
    private static int FindSegmentsArrayStart(string text, int from)
    {
        const string key = "\"segments\"";
        var at = text.IndexOf(key, Math.Max(0, from), StringComparison.Ordinal);
        if (at < 0) return -1;

        var i = at + key.Length;
        while (i < text.Length && char.IsWhiteSpace(text[i])) i++;
        if (i >= text.Length || text[i] != ':') return -1;
        i++;
        while (i < text.Length && char.IsWhiteSpace(text[i])) i++;
        if (i >= text.Length) return -1;

        // Anything but an array here means this isn't the schema's segments field. Give up rather
        // than guessing; Finish() falls back to mode 3.
        return text[i] == '[' ? i + 1 : -1;
    }
}
