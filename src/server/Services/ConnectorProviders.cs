namespace PipelineLaunchpad.Server.Services;

/// <summary>How a credential is supplied for a given provider (DESIGN_SPEC_CONNECTORS.md §3.0).</summary>
public enum ConnectorAuth { ApiKey, OAuth }

/// <summary>
/// Everything that varies per provider and is not a wire concern — the table in §3.0, in one
/// place, so no other file has to know which providers exist.
/// </summary>
/// <param name="Key">The stored <c>provider</c> value.</param>
/// <param name="DisplayName">Default for a new connector's free-text name.</param>
/// <param name="FixedBaseUrl">
/// Populated at creation time for the providers whose host is not the user's business, so no
/// adapter ever has to reconcile "provider says X but URL says Y". Null means the user supplies it.
/// </param>
/// <param name="Tag">The <c>.ptag</c> text beside the connector's name on the Review panel (§7.1).</param>
/// <param name="CredentialLabel">
/// "API key" or "API token" — §3.2 keeps these distinct because the words mean specific, different
/// things to people who have used both kinds.
/// </param>
public record ProviderInfo(
    string Key,
    string DisplayName,
    ConnectorAuth Auth,
    string? FixedBaseUrl,
    string Tag,
    string CredentialLabel);

public static class ConnectorProviders
{
    public const string Anthropic = "anthropic";
    public const string OpenAi = "openai";
    public const string GitHubCopilot = "github_copilot";
    public const string Custom = "custom";

    /// <summary>The only capability defined so far (§2).</summary>
    public const string PrQuestions = "pr.questions";

    private static readonly Dictionary<string, ProviderInfo> All = new(StringComparer.Ordinal)
    {
        [Anthropic] = new(Anthropic, "Claude", ConnectorAuth.ApiKey,
            "https://api.anthropic.com", "ANTHROPIC", "API key"),

        // OpenAI is not a separate contract — it is the Custom adapter with the host pinned
        // (§5.A), which is why it needed no dedicated mockup state.
        [OpenAi] = new(OpenAi, "ChatGPT", ConnectorAuth.ApiKey,
            "https://api.openai.com/v1", "OPENAI", "API key"),

        // No URL concept from the user's side, and no key field at all — the credential is an
        // OAuth grant, so base_url stays null (§2).
        [GitHubCopilot] = new(GitHubCopilot, "GitHub Copilot", ConnectorAuth.OAuth,
            null, "GITHUB", "GitHub account"),

        // The only provider where the reviewer supplies a host.
        [Custom] = new(Custom, "Custom agent", ConnectorAuth.ApiKey,
            null, "CUSTOM", "API token"),
    };

    public static bool IsKnown(string? provider) => provider is not null && All.ContainsKey(provider);

    public static ProviderInfo Info(string provider) =>
        All.TryGetValue(provider, out var info)
            ? info
            : throw new ArgumentOutOfRangeException(nameof(provider), provider, "Unknown provider.");

    /// <summary>
    /// Providers this build can actually talk to. Copilot is deliberately absent: §5.C is an
    /// unvalidated sketch pending a spike against a seated account, and offering a card that
    /// leads nowhere is worse than not offering it.
    /// </summary>
    public static IReadOnlyList<ProviderInfo> Selectable() =>
        [All[Anthropic], All[OpenAi], All[Custom]];

    public static string AuthTypeOf(string provider) =>
        Info(provider).Auth == ConnectorAuth.OAuth ? "oauth" : "api_key";

    /// <summary>
    /// The base URL to store for a new connector: the provider's fixed host where it has one,
    /// otherwise the user's, normalised. §3.2 normalises the trailing slash off on save so two
    /// connectors differing only by it don't read as different hosts.
    /// </summary>
    public static string? ResolveBaseUrl(string provider, string? supplied)
    {
        var info = Info(provider);
        if (info.FixedBaseUrl is not null) return info.FixedBaseUrl;
        if (info.Auth == ConnectorAuth.OAuth) return null;
        var trimmed = (supplied ?? "").Trim().TrimEnd('/');
        return trimmed.Length == 0 ? null : trimmed;
    }
}
