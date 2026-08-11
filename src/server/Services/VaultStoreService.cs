using Azure.Identity;
using Azure.Security.KeyVault.Secrets;

namespace PipelineLaunchpad.Server.Services;

/// <summary>
/// Reads secret names/values from an Azure Key Vault, authenticating with the ambient
/// Azure identity (DefaultAzureCredential). Secret values are only fetched on demand.
/// </summary>
public class VaultStoreService
{
    public class VaultException(string message) : Exception(message);

    public static string EndpointOf(string vaultUri) => vaultUri.Trim().TrimEnd('/');

    private static SecretClient CreateClient(string vaultUri) =>
        new(new Uri(vaultUri.Trim()), new DefaultAzureCredential());

    /// <summary>Lists secret names only (never values).</summary>
    public async Task<List<string>> ListNamesAsync(string vaultUri, CancellationToken ct)
    {
        try
        {
            var client = CreateClient(vaultUri);
            var names = new List<string>();
            await foreach (var p in client.GetPropertiesOfSecretsAsync(ct))
            {
                if (p.Enabled == false) continue;
                names.Add(p.Name);
                if (names.Count >= 5000) break;
            }
            names.Sort(StringComparer.OrdinalIgnoreCase);
            return names;
        }
        catch (Exception ex)
        {
            throw new VaultException(ex.Message);
        }
    }

    /// <summary>Fetches a single secret's value (revealed on demand).</summary>
    public async Task<string?> GetSecretAsync(string vaultUri, string name, CancellationToken ct)
    {
        try
        {
            var client = CreateClient(vaultUri);
            var secret = await client.GetSecretAsync(name, cancellationToken: ct);
            return secret.Value.Value;
        }
        catch (Exception ex)
        {
            throw new VaultException(ex.Message);
        }
    }
}
