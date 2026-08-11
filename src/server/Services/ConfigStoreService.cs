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

    private static ConfigurationClient CreateClient(string connection)
    {
        connection = connection.Trim();
        return connection.StartsWith("http", StringComparison.OrdinalIgnoreCase)
            ? new ConfigurationClient(new Uri(connection), new DefaultAzureCredential())
            : new ConfigurationClient(connection);
    }

    public async Task<List<ConfigSettingDto>> ListAsync(string connection, CancellationToken ct)
    {
        try
        {
            var client = CreateClient(connection);
            var list = new List<ConfigSettingDto>();
            await foreach (var s in client.GetConfigurationSettingsAsync(new SettingSelector(), ct))
            {
                list.Add(new ConfigSettingDto(s.Key, s.Value, s.Label, s.ContentType, s.LastModified));
                if (list.Count >= 2000) break; // guardrail for very large stores
            }
            return list
                .OrderBy(s => s.Key, StringComparer.OrdinalIgnoreCase)
                .ThenBy(s => s.Label, StringComparer.OrdinalIgnoreCase)
                .ToList();
        }
        catch (Exception ex)
        {
            throw new ConfigStoreException(ex.Message);
        }
    }
}
