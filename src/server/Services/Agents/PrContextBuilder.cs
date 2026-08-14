using System.Text;
using System.Xml;

namespace PipelineLaunchpad.Server.Services.Agents;

/// <summary>Everything §5.1's block is built from. Launchpad already has all of it from ADO.</summary>
public record PrContextInput(
    string Repo,
    int PullRequestId,
    string? SourceRef,
    string? TargetRef,
    string? Commit,
    string Title,
    string? Description,
    IReadOnlyList<(string Id, string Title)> WorkItems,
    IReadOnlyList<FileDiff> Files,
    /// <summary>Paths with existing review threads — second in the keep-order when truncating.</summary>
    IReadOnlyCollection<string> PathsWithFindings,
    /// <summary>
    /// Unchanged files sitting beside the change, for orientation only. Never their contents — the
    /// agent asks for those.
    /// </summary>
    IReadOnlyList<string> NearbyPaths);

/// <summary>The assembled block, plus what had to be left out of it.</summary>
/// <param name="Paths">
/// Every changed file's path, including ones whose diff was truncated away — the set a citation is
/// allowed to name (§5.2). Carried as a field rather than re-parsed out of <paramref name="Xml"/>,
/// because the block is a wire format and reading it back would quietly make it an API.
/// </param>
public record PrContext(
    string Xml,
    bool Truncated,
    IReadOnlyList<string> OmittedPaths,
    int DiffBytes,
    IReadOnlyList<string> Paths);

/// <summary>
/// Assembles the <c>&lt;pull-request-context&gt;</c> block (§5.1).
///
/// Built once, in canonical form, and handed to whichever adapter is configured — none of this is
/// provider-specific, which is what lets a thread survive swapping the provider underneath it.
///
/// <b>Everything inside the block is untrusted input.</b> A PR description, a branch name or a
/// source comment can carry text aimed at the agent. The mitigation is two-sided and both halves
/// are required: the system prompt says to treat the block as data (§5.3), and nothing the agent
/// produces reaches the pull request without a human pressing a button (§7.4). Escaping is not
/// part of that mitigation — it stops the XML being malformed, not the text being persuasive.
/// </summary>
public static class PrContextBuilder
{
    /// <summary>
    /// The diff cap, in bytes — bytes rather than tokens because that is what a token budget
    /// approximates and what we can actually measure before sending.
    ///
    /// <b>Raised from §5.1's 200 KB to 700 KB.</b> 200 KB was chosen when the number that mattered
    /// was "what will an unknown internal endpoint accept", and against a real pull request it
    /// truncated far too eagerly: reviewers saw an answer working from a partial diff on changes that
    /// were nowhere near a model's actual limit. 700 KB is roughly 175k tokens of diff, which fits
    /// inside a 200k-token context alongside the prompt, the history and the tool results — with
    /// enough headroom that the model isn't refusing the request instead of truncating it.
    ///
    /// The truncation machinery below is unchanged and still matters. A cap that is never hit is not
    /// an argument for having no cap: <see cref="SelectFiles"/> is what makes the overflow case a
    /// stated, prioritised partial answer rather than a rejected request.
    /// </summary>
    public const int MaxDiffBytes = 700 * 1024;

    public static PrContext Build(PrContextInput input, string? question = null)
    {
        var (kept, omitted, truncated) = SelectFiles(input, question);

        var sb = new StringBuilder();
        sb.AppendLine("<pull-request-context>");
        sb.Append("  <repo>").Append(Esc(input.Repo)).AppendLine("</repo>");

        sb.Append("  <pull-request id=\"").Append(input.PullRequestId).Append('"');
        if (ShortRef(input.SourceRef) is { } src) sb.Append(" source=\"").Append(Esc(src)).Append('"');
        if (ShortRef(input.TargetRef) is { } tgt) sb.Append(" target=\"").Append(Esc(tgt)).Append('"');
        // Full 40 characters on the wire, abbreviated only for display — the reviewed SHA drives
        // the stale-commit banner and re-run matching, so a variable-length value breaks both.
        if (!string.IsNullOrWhiteSpace(input.Commit)) sb.Append(" commit=\"").Append(Esc(input.Commit)).Append('"');
        sb.AppendLine("/>");

        sb.Append("  <title>").Append(Esc(input.Title)).AppendLine("</title>");

        // Verbatim, including any instruction someone put in it. Rewriting it would hide the
        // attack rather than defend against it, and would also lose legitimate content.
        sb.Append("  <description>").Append(Esc(input.Description ?? "")).AppendLine("</description>");

        if (input.WorkItems.Count > 0)
        {
            sb.AppendLine("  <work-items>");
            foreach (var (id, title) in input.WorkItems)
                sb.Append("    <item id=\"").Append(Esc(id)).Append("\">").Append(Esc(title)).AppendLine("</item>");
            sb.AppendLine("  </work-items>");
        }

        sb.AppendLine("  <files>");
        foreach (var f in kept)
            sb.Append("    <file path=\"").Append(Esc(f.Path))
              .Append("\" change=\"").Append(Esc(f.ChangeType))
              .Append("\" added=\"").Append(f.Added)
              .Append("\" removed=\"").Append(f.Removed)
              .AppendLine("\"/>");
        sb.AppendLine("  </files>");

        var diff = string.Join("\n", kept.Where(f => f.Text.Length > 0)
            .Select(f => $"--- a/{f.Path}\n+++ b/{f.Path}\n{f.Text}"));
        var diffBytes = Encoding.UTF8.GetByteCount(diff);

        sb.Append("  <diff truncated=\"").Append(truncated ? "true" : "false")
          .Append("\" bytes=\"").Append(diffBytes).Append("\">")
          .Append(Esc(diff)).AppendLine("</diff>");

        // Orientation, not content. A full repository tree can be hundreds of KB of paths on its
        // own — enough to spend the whole reading budget before a line of code is read — so this is
        // deliberately just the directories the change touches plus the root. Enough for the agent
        // to see the V1 file sitting beside the V2 one, and to ask for the right path instead of
        // guessing; anything deeper is a list_files call away.
        if (input.NearbyPaths.Count > 0)
        {
            sb.AppendLine("  <nearby-files note=\"not changed by this pull request; readable on request\">");
            foreach (var path in input.NearbyPaths)
                sb.Append("    <file path=\"").Append(Esc(path)).AppendLine("\"/>");
            sb.AppendLine("  </nearby-files>");
        }

        if (omitted.Count > 0)
        {
            sb.AppendLine("  <omitted reason=\"size\">");
            foreach (var f in omitted)
                sb.Append("    <file path=\"").Append(Esc(f.Path))
                  .Append("\" added=\"").Append(f.Added)
                  .Append("\" removed=\"").Append(f.Removed)
                  .AppendLine("\"/>");
            sb.AppendLine("  </omitted>");
        }

        sb.Append("</pull-request-context>");

        return new PrContext(
            sb.ToString(),
            truncated,
            omitted.Select(f => f.Path).ToList(),
            diffBytes,
            input.Files.Select(f => f.Path).ToList());
    }

    /// <summary>
    /// §5.1's keep-order, applied only when the diff exceeds the cap: files named in the question
    /// first, then files that already have review findings, then the rest by ascending size until
    /// the budget is spent.
    ///
    /// Ascending size on purpose — it maximises the number of files the agent can see, on the
    /// reasoning that one enormous generated file is usually less interesting to a reviewer than
    /// the six small ones it would otherwise crowd out.
    /// </summary>
    private static (List<FileDiff> Kept, List<FileDiff> Omitted, bool Truncated) SelectFiles(
        PrContextInput input, string? question)
    {
        var all = input.Files.ToList();
        var total = all.Sum(f => f.Bytes);
        if (total <= MaxDiffBytes) return (all, [], false);

        var mentioned = all.Where(f => IsMentioned(f.Path, question)).ToHashSet();
        var withFindings = all.Where(f => !mentioned.Contains(f)
            && input.PathsWithFindings.Contains(f.Path, StringComparer.OrdinalIgnoreCase)).ToHashSet();

        var ordered = mentioned.OrderBy(f => f.Bytes)
            .Concat(withFindings.OrderBy(f => f.Bytes))
            .Concat(all.Where(f => !mentioned.Contains(f) && !withFindings.Contains(f)).OrderBy(f => f.Bytes))
            .ToList();

        var kept = new List<FileDiff>();
        var omitted = new List<FileDiff>();
        var spent = 0;
        foreach (var f in ordered)
        {
            if (spent + f.Bytes <= MaxDiffBytes)
            {
                kept.Add(f);
                spent += f.Bytes;
            }
            else omitted.Add(f);
        }

        // Restore the caller's order for the ones we kept: the priority above decides *what*
        // survives, not what order the agent reads it in, and file order carries meaning.
        var keptSet = kept.ToHashSet();
        return (all.Where(keptSet.Contains).ToList(), omitted, omitted.Count > 0);
    }

    /// <summary>
    /// Whether a question names a file. Matches on the filename rather than the full path, since
    /// that is how people refer to files — "what's in SearchUsersByEmail_V2" and not the whole
    /// Scripts/tps-user prefix.
    /// </summary>
    private static bool IsMentioned(string path, string? question)
    {
        if (string.IsNullOrWhiteSpace(question)) return false;
        var name = path.Split('/').LastOrDefault();
        if (string.IsNullOrEmpty(name)) return false;

        if (question.Contains(name, StringComparison.OrdinalIgnoreCase)) return true;

        // Also match without the extension, so "SearchUsersByEmail_V2" finds the .sql file.
        var stem = Path.GetFileNameWithoutExtension(name);
        return stem.Length >= 4 && question.Contains(stem, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>refs/heads/feature/x → feature/x. The full ref is noise in a prompt.</summary>
    private static string? ShortRef(string? refName) =>
        string.IsNullOrWhiteSpace(refName) ? null
            : refName.StartsWith("refs/heads/", StringComparison.Ordinal) ? refName["refs/heads/".Length..]
            : refName;

    /// <summary>
    /// XML-escape. Keeps the block parseable when a diff contains &lt; or &amp; — which SQL and
    /// C# both do constantly — and drops characters XML cannot represent at all rather than
    /// emitting a document no parser will accept.
    /// </summary>
    private static string Esc(string value)
    {
        var sb = new StringBuilder(value.Length + 16);
        foreach (var ch in value)
        {
            if (XmlConvert.IsXmlChar(ch))
                sb.Append(ch switch
                {
                    '&' => "&amp;",
                    '<' => "&lt;",
                    '>' => "&gt;",
                    '"' => "&quot;",
                    _ => ch.ToString(),
                });
        }
        return sb.ToString();
    }
}
