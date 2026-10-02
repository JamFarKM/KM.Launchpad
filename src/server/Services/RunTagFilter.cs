namespace PipelineLaunchpad.Server.Services;

/// <summary>
/// A shelf card's tag filter over its pipeline's runs. <see cref="Include"/> is all-of and is sent
/// to Azure DevOps as <c>tagFilters</c>; <see cref="Exclude"/> is any-of and has no server-side
/// equivalent there, so excluding over-fetches and filters here. Both are applied here regardless,
/// so the result is right even where Azure DevOps can't express the query (a tag containing a
/// comma). Tags compare case-insensitively, as Azure DevOps treats them.
/// </summary>
public sealed record RunTagFilter(IReadOnlyList<string> Include, IReadOnlyList<string> Exclude)
{
    /// <summary>How many runs to scan per run wanted when excluding. Capped at <see cref="MaxFetch"/>.</summary>
    public const int ExcludeOverfetch = 10;
    public const int MaxFetch = 100;

    public static readonly RunTagFilter None = new([], []);

    public static RunTagFilter From(IEnumerable<string>? include, IEnumerable<string>? exclude) =>
        new(Clean(include), Clean(exclude));

    public bool IsEmpty => Include.Count == 0 && Exclude.Count == 0;

    public bool Matches(IReadOnlyCollection<string> tags) =>
        Include.All(t => tags.Contains(t, StringComparer.OrdinalIgnoreCase))
        && !Exclude.Any(t => tags.Contains(t, StringComparer.OrdinalIgnoreCase));

    /// <summary>The <c>$top</c> to ask Azure DevOps for so that <paramref name="top"/> survive filtering.</summary>
    public int FetchSize(int top) => Exclude.Count == 0 ? top : Math.Min(MaxFetch, top * ExcludeOverfetch);

    /// <summary>The <c>tagFilters</c> query fragment, or empty. A tag with a comma can't be expressed in it.</summary>
    public string QuerySuffix
    {
        get
        {
            var sendable = Include.Where(t => !t.Contains(',')).ToList();
            return sendable.Count == 0 ? "" : "&tagFilters=" + Uri.EscapeDataString(string.Join(',', sendable));
        }
    }

    private static List<string> Clean(IEnumerable<string>? tags) =>
        (tags ?? [])
            .Select(t => t.Trim())
            .Where(t => t.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
}
