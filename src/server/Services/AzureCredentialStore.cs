using System.Text.Json;
using PipelineLaunchpad.Server.Data;

namespace PipelineLaunchpad.Server.Services;

/// <summary>An Azure service principal used to authenticate to Key Vault and endpoint-URL config stores.</summary>
public record AzureSp(string TenantId, string ClientId, string ClientSecret);

/// <summary>Loads/saves the per-user Azure service principal (encrypted at rest).</summary>
public static class AzureCredentialStore
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static async Task<AzureSp?> LoadAsync(AppDbContext db, PatProtector protector, string userId, CancellationToken ct)
    {
        var row = await db.AzureCredentials.FindAsync([userId], ct);
        if (row is null) return null;
        try { return JsonSerializer.Deserialize<AzureSp>(protector.Unprotect(row.Secret), Json); }
        catch { return null; }
    }

    public static string Serialize(AzureSp sp) => JsonSerializer.Serialize(sp, Json);
}
