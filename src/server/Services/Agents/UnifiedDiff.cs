using System.Text;
using DiffPlex;
using DiffPlex.DiffBuilder;
using DiffPlex.DiffBuilder.Model;

namespace PipelineLaunchpad.Server.Services.Agents;

/// <summary>A file's diff, rendered once and reused for both the counts and the context block.</summary>
/// <param name="Added">Lines added — also what the <c>added</c> attribute in §5.1 reports.</param>
/// <param name="Text">Unified diff with hunk headers, or empty when nothing changed.</param>
public record FileDiff(string Path, string ChangeType, int Added, int Removed, string Text)
{
    public int Bytes => Encoding.UTF8.GetByteCount(Text);
}

/// <summary>
/// Turns the before/after pair Launchpad already fetches into a unified diff.
///
/// The app didn't need one until now: Monaco diffs both sides in the browser. But an agent has to
/// be *told* what changed, and line numbers only mean something to a reviewer if they match what
/// Monaco shows — so hunks are numbered against the new file, which is Monaco's right-hand side
/// and the side a citation chip scrolls to.
///
/// Diffing itself is DiffPlex rather than hand-rolled: a wrong diff would produce citations that
/// point at the wrong lines, which is worse than no citations, and Myers' algorithm is not
/// something to reimplement from memory for a feature whose whole value is being trustworthy.
/// </summary>
public static class UnifiedDiff
{
    private const int ContextLines = 3;

    public static FileDiff Build(string path, string changeType, string? before, string? after)
    {
        before ??= "";
        after ??= "";

        // Positional: whitespace is significant here. A reindented line is a real change to a
        // reviewer, and hiding it would make the diff disagree with what Monaco shows.
        var model = InlineDiffBuilder.Diff(new Differ(), before, after, false);

        var added = model.Lines.Count(l => l.Type == ChangeType.Inserted);
        var removed = model.Lines.Count(l => l.Type == ChangeType.Deleted);
        if (added == 0 && removed == 0) return new FileDiff(path, changeType, 0, 0, "");

        return new FileDiff(path, changeType, added, removed, Render(model));
    }

    /// <summary>
    /// Group changed lines into hunks with <see cref="ContextLines"/> either side, and emit them
    /// in unified format. Unchanged runs longer than twice the context are elided, which is what
    /// keeps a large file's diff proportional to what actually changed rather than to its size.
    /// </summary>
    private static string Render(DiffPaneModel model)
    {
        var lines = model.Lines;
        var interesting = new bool[lines.Count];
        for (var i = 0; i < lines.Count; i++)
        {
            if (lines[i].Type is ChangeType.Inserted or ChangeType.Deleted or ChangeType.Modified)
                for (var j = Math.Max(0, i - ContextLines); j <= Math.Min(lines.Count - 1, i + ContextLines); j++)
                    interesting[j] = true;
        }

        var sb = new StringBuilder();
        var oldLine = 0;
        var newLine = 0;

        // Line numbers advance across the whole file, including the elided runs, so a hunk header
        // still describes where in the file the reviewer is looking.
        var i2 = 0;
        while (i2 < lines.Count)
        {
            if (!interesting[i2])
            {
                Advance(lines[i2], ref oldLine, ref newLine);
                i2++;
                continue;
            }

            var start = i2;
            var hunkOldStart = oldLine + 1;
            var hunkNewStart = newLine + 1;
            var body = new StringBuilder();
            var oldCount = 0;
            var newCount = 0;

            while (i2 < lines.Count && interesting[i2])
            {
                var line = lines[i2];
                switch (line.Type)
                {
                    case ChangeType.Inserted:
                        body.Append('+').AppendLine(line.Text);
                        newCount++;
                        break;
                    case ChangeType.Deleted:
                        body.Append('-').AppendLine(line.Text);
                        oldCount++;
                        break;
                    default:
                        body.Append(' ').AppendLine(line.Text);
                        oldCount++;
                        newCount++;
                        break;
                }
                Advance(line, ref oldLine, ref newLine);
                i2++;
            }

            if (i2 == start) i2++;  // defensive: never fail to advance

            sb.Append("@@ -").Append(hunkOldStart).Append(',').Append(oldCount)
              .Append(" +").Append(hunkNewStart).Append(',').Append(newCount).AppendLine(" @@");
            sb.Append(body);
        }

        return sb.ToString();
    }

    private static void Advance(DiffPiece line, ref int oldLine, ref int newLine)
    {
        switch (line.Type)
        {
            case ChangeType.Inserted: newLine++; break;
            case ChangeType.Deleted: oldLine++; break;
            default: oldLine++; newLine++; break;
        }
    }
}
