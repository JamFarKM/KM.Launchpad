using Azure.Core;
using Azure.Data.AppConfiguration;
using Azure.Identity;
using PipelineLaunchpad.Server.Models;

namespace PipelineLaunchpad.Server.Services;

/// <summary>
/// Reads key/values from an Azure App Configuration store. Accepts either a full
/// connection string (Endpoint=…;Id=…;Secret=…) or a bare endpoint URL, in which
/// case it authenticates with the ambient Azure identity (DefaultAzureCredential).
/// </summary>
public class ConfigStoreService
{
    public class ConfigStoreException(string message) : Exception(message);

    /// <summary>The display endpoint for a stored secret (never reveals the secret).</summary>
    public static string EndpointOf(string connection)
    {
        connection = connection.Trim();
        if (connection.StartsWith("http", StringComparison.OrdinalIgnoreCase))
            return connection.TrimEnd('/');

        foreach (var part in connection.Split(';'))
        {
            var kv = part.Split('=', 2);
            if (kv.Length == 2 && kv[0].Trim().Equals("Endpoint", StringComparison.OrdinalIgnoreCase))
                return kv[1].Trim().TrimEnd('/');
        }
        return "(unknown endpoint)";
    }

    private static ConfigurationClient CreateClient(string connection, AzureSp? sp)
    {
        connection = connection.Trim();
        if (!connection.StartsWith("http", StringComparison.OrdinalIgnoreCase))
            return new ConfigurationClient(connection);

        TokenCredential cred = sp is not null
            ? new ClientSecretCredential(sp.TenantId, sp.ClientId, sp.ClientSecret)
            : new DefaultAzureCredential();
        return new ConfigurationClient(new Uri(connection), cred);
    }

    /// <summary>
    /// Backstop against a pathological store, not an expected limit. App Configuration returns
    /// settings in key order, so a cap that bites drops the tail of the alphabet — the old
    /// 2000 stopped a real store dead at "Placement", losing everything from RiskAssessmentOptions
    /// to Wallet with nothing on screen to say so. Hitting this now sets Truncated, which the
    /// page shows.
    /// </summary>
    private const int MaxSettings = 25_000;

    /// <summary>
    /// Checks a connection is usable by reading a single setting. Validating with a full ListAsync
    /// would pull the entire store just to save a registry entry.
    /// </summary>
    public async Task ProbeAsync(string connection, AzureSp? sp, CancellationToken ct)
    {
        try
        {
            var client = CreateClient(connection, sp);
            await foreach (var _ in client.GetConfigurationSettingsAsync(new SettingSelector(), ct)) break;
        }
        catch (Exception ex)
        {
            throw new ConfigStoreException(ex.Message);
        }
    }

    public async Task<ConfigSettingsDto> ListAsync(string connection, AzureSp? sp, CancellationToken ct)
    {
        try
        {
            var client = CreateClient(connection, sp);
            var list = new List<ConfigSettingDto>();
            var truncated = false;
            await foreach (var s in client.GetConfigurationSettingsAsync(new SettingSelector(), ct))
            {
                if (list.Count >= MaxSettings) { truncated = true; break; }
                list.Add(new ConfigSettingDto(s.Key, s.Value, s.Label, s.ContentType, s.LastModified));
            }
            return new ConfigSettingsDto(
                list.OrderBy(s => s.Key, StringComparer.OrdinalIgnoreCase)
                    .ThenBy(s => s.Label, StringComparer.OrdinalIgnoreCase)
                    .ToList(),
                truncated,
                MaxSettings);
        }
        catch (Exception ex)
        {
            throw new ConfigStoreException(ex.Message);
        }
    }
}
