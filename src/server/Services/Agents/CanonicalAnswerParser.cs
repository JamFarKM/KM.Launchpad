using System.Text;
using System.Text.Json;

namespace PipelineLaunchpad.Server.Services.Agents;

/// <summary>
/// Reads a canonical answer (§5.2) out of JSON that arrives in fragments.
///
/// Why this exists rather than a <c>JsonSerializer.Deserialize</c> at the end: under streaming the
/// object arrives a few characters at a time, and the reviewer should see prose while the trailing
/// metadata is still being produced. So <c>answer</c> is extracted incrementally, and
/// <c>provenance</c> / <c>citations</c> / <c>inference_note</c> are applied when the object closes.
///
/// Three things it must do that a naive implementation gets wrong:
///
/// <list type="bullet">
/// <item>
/// <b>Decode escapes without splitting them.</b> A fragment can end mid-escape — <c>"…\</c>, or
/// <c>"…\u00</c> — and emitting those raw would put backslashes in the reviewer's prose. Partial
/// escapes are held back until the rest arrives.
/// </item>
/// <item>
/// <b>Never depend on key order.</b> §5.2 asks providers to emit <c>answer</c> first, but that is
/// a request and not a guarantee of any provider's API. If the object closes without prose having
/// been emitted, the finished answer is returned in one go. Progressive rendering degrades; it
/// never blocks.
/// </item>
/// <item>
/// <b>Track strings when counting braces.</b> A <c>{</c> inside the answer's own prose must not
/// look like a nested object, or the parser waits forever for a close that already happened.
/// </item>
/// </list>
/// </summary>
public sealed class CanonicalAnswerParser
{
    private readonly StringBuilder _raw = new();

    // How far into _raw the answer-string scanner has consumed. Distinct from the brace scanner's
    // cursor because the two walk the buffer for different reasons and at different rates.
    private int _answerCursor;
    private int _depthCursor;

    private int _depth;
    private bool _inString;
    private bool _escaped;
    private bool _sawObject;

    private State _state = State.SeekingAnswer;
    private readonly StringBuilder _answer = new();

    private enum State { SeekingAnswer, InAnswer, PastAnswer }

    /// <summary>Prose emitted so far, decoded.</summary>
    public string AnswerSoFar => _answer.ToString();

    /// <summary>True once the top-level object has closed.</summary>
    public bool ObjectClosed { get; private set; }

    /// <summary>
    /// Feed the next fragment. Returns any newly decoded prose — possibly empty, which is normal
    /// while the metadata keys are streaming past.
    /// </summary>
    public string Feed(string chunk)
    {
        if (string.IsNullOrEmpty(chunk)) return "";
        _raw.Append(chunk);
        TrackDepth();
        return _state == State.PastAnswer ? "" : ScanAnswer();
    }

    /// <summary>
    /// Finish, and produce the canonical answer.
    ///
    /// <paramref name="fallbackProse"/> is used when the payload turned out not to be the schema
    /// at all — mode 3 of §5.4, where the connector answered in plain prose. In that case there is
    /// no asserted provenance, and saying so is the whole point: nothing here guesses one.
    /// </summary>
    public CanonicalAnswer Finish(string? fallbackProse = null, IReadOnlyCollection<string>? knownPaths = null)
    {
        var text = _raw.ToString();

        try
        {
            using var doc = JsonDocument.Parse(text);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return Unverified(fallbackProse ?? text);

            var answer = root.TryGetProperty("answer", out var a) && a.ValueKind == JsonValueKind.String
                ? a.GetString() ?? ""
                : "";

            // The object parsed but carries no prose. Not a schema response — treat it as mode 3
            // rather than showing the reviewer an empty answer with a confident badge on it.
            if (answer.Length == 0) return Unverified(fallbackProse ?? "");

            var provenance = root.TryGetProperty("provenance", out var p) && p.ValueKind == JsonValueKind.String
                ? ProvenanceNames.Parse(p.GetString())
                : null;

            var note = root.TryGetProperty("inference_note", out var n) && n.ValueKind == JsonValueKind.String
                ? n.GetString()
                : null;

            var citations = ReadCitations(root, knownPaths);

            // §5.2: inference_note is required when provenance is inferred. A hedge with nothing
            // in the box is worse than no badge, so an inferred answer missing its note drops to
            // unverified rather than rendering an empty dashed box.
            if (provenance == Provenance.Inferred && string.IsNullOrWhiteSpace(note))
                return new CanonicalAnswer(answer, null, [], null, StructuredMode.Unverified);

            // A note on a non-inferred answer is a contradiction in the agent's own output. Keep
            // the answer, drop the note — the badge is the claim we render, so it wins.
            if (provenance != Provenance.Inferred) note = null;

            return new CanonicalAnswer(answer, provenance, citations, note,
                provenance is null ? StructuredMode.Unverified : StructuredMode.Structured);
        }
        catch (JsonException)
        {
            // Not JSON at all, or truncated. Either way there is no asserted provenance to render.
            // Prefer whatever prose we did manage to decode over showing the reviewer raw JSON.
            var prose = fallbackProse ?? (_answer.Length > 0 ? _answer.ToString() : text);
            return Unverified(prose);
        }
    }

    private static CanonicalAnswer Unverified(string prose) =>
        new(prose.Trim(), null, [], null, StructuredMode.Unverified);

    /// <summary>
    /// Citations, capped and filtered.
    ///
    /// §5.2: the cap lives here rather than in the schema, because <c>maxItems</c> is unsupported
    /// by several strict implementations — so extras are dropped silently instead of failing the
    /// whole response. Paths absent from the context are dropped too: a chip that scrolls nowhere
    /// is worse than no chip.
    /// </summary>
    private static List<Citation> ReadCitations(JsonElement root, IReadOnlyCollection<string>? knownPaths)
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

            if (knownPaths is { Count: > 0 }
                && !knownPaths.Contains(path, StringComparer.OrdinalIgnoreCase))
                continue;

            // ValueKind must be checked before TryGetInt32: it *throws* on a JSON null rather
            // than returning false, and `end_line: null` is the documented normal case for a
            // single-line citation — so the obvious-looking version crashes on the first real
            // citation an agent ever sends.
            if (!c.TryGetProperty("line", out var lv)
                || lv.ValueKind != JsonValueKind.Number
                || !lv.TryGetInt32(out var line)) continue;

            int? end = c.TryGetProperty("end_line", out var ev)
                && ev.ValueKind == JsonValueKind.Number
                && ev.TryGetInt32(out var e)
                ? e : null;
            // A range that ends before it starts is a mistake, not a range. Keep the anchor line,
            // which is the part the citation chip actually scrolls to.
            if (end is not null && end < line) end = null;

            citations.Add(new Citation(path!, line, end));
        }

        return citations;
    }

    /// <summary>
    /// Walk newly arrived characters, maintaining brace depth outside of strings so we can tell
    /// when the top-level object closes. Cheap, and immune to braces inside the prose.
    /// </summary>
    private void TrackDepth()
    {
        for (; _depthCursor < _raw.Length; _depthCursor++)
        {
            var ch = _raw[_depthCursor];

            if (_inString)
            {
                if (_escaped) _escaped = false;
                else if (ch == '\\') _escaped = true;
                else if (ch == '"') _inString = false;
                continue;
            }

            switch (ch)
            {
                case '"': _inString = true; break;
                case '{' or '[': _depth++; _sawObject = true; break;
                case '}' or ']':
                    _depth--;
                    if (_depth <= 0 && _sawObject) ObjectClosed = true;
                    break;
            }
        }
    }

    /// <summary>
    /// Pull decoded prose out of the <c>answer</c> string as it grows.
    ///
    /// Returns only complete characters: a fragment ending mid-escape leaves the cursor before the
    /// backslash so the sequence is decoded once the rest arrives, rather than leaking a literal
    /// <c>\n</c> into the reviewer's prose.
    /// </summary>
    private string ScanAnswer()
    {
        var text = _raw;

        if (_state == State.SeekingAnswer)
        {
            var at = FindAnswerValueStart(text.ToString(), _answerCursor);
            if (at < 0) return "";
            _answerCursor = at;
            _state = State.InAnswer;
        }

        var emitted = new StringBuilder();

        while (_answerCursor < text.Length)
        {
            var ch = text[_answerCursor];

            if (ch == '"')
            {
                // Unescaped quote — the answer string is finished. Everything after it is metadata,
                // which Finish() reads from the complete buffer.
                _answerCursor++;
                _state = State.PastAnswer;
                break;
            }

            if (ch == '\\')
            {
                // Need the escape's payload before anything can be emitted. \u needs four more.
                if (_answerCursor + 1 >= text.Length) break;
                var esc = text[_answerCursor + 1];
                if (esc == 'u')
                {
                    if (_answerCursor + 5 >= text.Length) break;
                    var hex = text.ToString(_answerCursor + 2, 4);
                    if (!ushort.TryParse(hex, System.Globalization.NumberStyles.HexNumber,
                            System.Globalization.CultureInfo.InvariantCulture, out var code))
                    {
                        // Malformed — pass it through rather than dropping the reviewer's text.
                        emitted.Append(text.ToString(_answerCursor, 6));
                        _answerCursor += 6;
                        continue;
                    }
                    emitted.Append((char)code);
                    _answerCursor += 6;
                    continue;
                }

                emitted.Append(esc switch
                {
                    'n' => '\n', 't' => '\t', 'r' => '\r', 'b' => '\b', 'f' => '\f',
                    '"' => '"', '\\' => '\\', '/' => '/',
                    _ => esc,
                });
                _answerCursor += 2;
                continue;
            }

            emitted.Append(ch);
            _answerCursor++;
        }

        var chunk = emitted.ToString();
        _answer.Append(chunk);
        return chunk;
    }

    /// <summary>
    /// Index of the first character *inside* the <c>answer</c> string value, or -1 if the key
    /// hasn't arrived yet. Matches on the key followed by a colon and a quote so an occurrence of
    /// the word "answer" inside some other string can't be mistaken for the key itself.
    /// </summary>
    private static int FindAnswerValueStart(string text, int from)
    {
        var key = "\"answer\"";
        var at = text.IndexOf(key, Math.Max(0, from), StringComparison.Ordinal);
        if (at < 0) return -1;

        var i = at + key.Length;
        while (i < text.Length && char.IsWhiteSpace(text[i])) i++;
        if (i >= text.Length || text[i] != ':') return -1;
        i++;
        while (i < text.Length && char.IsWhiteSpace(text[i])) i++;
        if (i >= text.Length) return -1;

        // A non-string value here means this isn't the schema's answer field. Give up rather than
        // guessing; Finish() will fall back to mode 3.
        return text[i] == '"' ? i + 1 : -1;
    }
}
