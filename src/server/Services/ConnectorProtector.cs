using Microsoft.AspNetCore.DataProtection;

namespace PipelineLaunchpad.Server.Services;

/// <summary>
/// Encrypts connector credentials before they touch the database (DESIGN_SPEC_CONNECTORS.md §3.3).
///
/// A separate purpose string from <see cref="PatProtector"/> on purpose: Data Protection purposes
/// are an isolation boundary, so ciphertext written for an Azure DevOps PAT cannot be decrypted
/// through this protector even though both use the same key ring. Distinct purposes per credential
/// kind mean a bug that reaches for the wrong protector fails loudly instead of quietly succeeding.
///
/// There is deliberately no method here that takes a connector and hands back a plaintext for
/// display. The only caller that unprotects is the adapter making an outbound request, and
/// nothing in that path returns to a client.
/// </summary>
public class ConnectorProtector(IDataProtectionProvider provider)
{
    private readonly IDataProtector _apiKey = provider.CreateProtector("PipelineLaunchpad.ConnectorKey.v1");
    private readonly IDataProtector _oauth = provider.CreateProtector("PipelineLaunchpad.ConnectorOAuth.v1");

    public string ProtectApiKey(string key) => _apiKey.Protect(key);
    public string UnprotectApiKey(string ciphertext) => _apiKey.Unprotect(ciphertext);

    public string ProtectOAuthToken(string token) => _oauth.Protect(token);
    public string UnprotectOAuthToken(string ciphertext) => _oauth.Unprotect(ciphertext);

    /// <summary>
    /// The last four characters of a credential — the only part of it the UI is ever shown (§3.3).
    /// Short or malformed values yield fewer than four rather than throwing, since a validation
    /// failure should come from the connection test with its own copy, not from a formatting call.
    /// </summary>
    public static string Last4(string credential)
    {
        var trimmed = (credential ?? "").Trim();
        return trimmed.Length <= 4 ? trimmed : trimmed[^4..];
    }
}
