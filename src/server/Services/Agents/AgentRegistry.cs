using PipelineLaunchpad.Server.Data;

namespace PipelineLaunchpad.Server.Services.Agents;

/// <summary>
/// Resolves a provider to its adapter, and a stored connector to a usable target.
///
/// The one place in the codebase that knows the mapping. Everything else asks for "the adapter for
/// this connector" — which is what stops a provider check leaking upward into the Review page or
/// the schema parser, the failure mode CLAUDE.md's invariant warns about.
/// </summary>
public class AgentRegistry(IEnumerable<IAgentAdapter> adapters, ConnectorProtector protector)
{
    private readonly Dictionary<string, IAgentAdapter> _byProvider =
        adapters.ToDictionary(a => a.Provider, StringComparer.Ordinal);

    public bool Supports(string provider) => _byProvider.ContainsKey(provider);

    /// <summary>
    /// The adapter for a provider, or null when none is built yet — Copilot, whose §5.C adapter is
    /// pending a spike. Null rather than an exception, because "not built yet" is a state the UI
    /// has to render, not a bug to crash on.
    /// </summary>
    public IAgentAdapter? For(string provider) =>
        _byProvider.TryGetValue(provider, out var adapter) ? adapter : null;

    /// <summary>
    /// Decrypts a connector's credential into a target for one call.
    ///
    /// Nothing caches the result: a plaintext credential exists for the life of the outbound
    /// request and nowhere else. A connector whose ciphertext cannot be unprotected — a key ring
    /// rotated out from under it, say — returns null rather than throwing, so the caller can report
    /// it through the taxonomy instead of as a 500.
    /// </summary>
    public AgentTarget? TargetFor(Connector connector)
    {
        if (connector.AuthType != "api_key" || connector.TokenCiphertext is null) return null;

        try
        {
            return new AgentTarget(
                connector.Provider,
                connector.BaseUrl,
                protector.UnprotectApiKey(connector.TokenCiphertext));
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>A target for a credential that hasn't been saved yet — the pre-save test in §4.</summary>
    public static AgentTarget TargetFor(string provider, string? baseUrl, string credential) =>
        new(provider, ConnectorProviders.ResolveBaseUrl(provider, baseUrl), credential);
}
