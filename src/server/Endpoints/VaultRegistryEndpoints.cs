using Microsoft.EntityFrameworkCore;
using PipelineLaunchpad.Server.Data;
using PipelineLaunchpad.Server.Models;
using PipelineLaunchpad.Server.Services;

namespace PipelineLaunchpad.Server.Endpoints;

public static class VaultRegistryEndpoints
{
    public static void MapVaultRegistries(this WebApplication app)
    {
        var api = app.MapGroup("/api");

        api.MapGet("/vault-registries", async (AdoContext ctx, AppDbContext db, PatProtector protector, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) return Results.Unauthorized();
            var regs = await db.VaultRegistries.Where(r => r.UserId == ctx.UserId).OrderBy(r => r.Name).ToListAsync(ct);
            return Results.Ok(regs.Select(r => new VaultRegistryDto(r.Id, r.Name, SafeUri(r, protector))).ToList());
        });

        api.MapPost("/vault-registries", async (
            UpsertVaultRegistryRequest body, AdoContext ctx, AppDbContext db, PatProtector protector, VaultStoreService store, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) return Results.Unauthorized();
            if (string.IsNullOrWhiteSpace(body.VaultUri) || !body.VaultUri.Trim().StartsWith("http", StringComparison.OrdinalIgnoreCase))
                return Results.BadRequest(new { error = "A vault URI is required, e.g. https://my-vault.vault.azure.net" });

            // Validate by listing secret names before saving.
            try { await store.ListNamesAsync(body.VaultUri.Trim(), ct); }
            catch (VaultStoreService.VaultException ex)
            {
                return Results.BadRequest(new { error = $"Could not connect to that vault: {ex.Message}" });
            }

            var reg = new VaultRegistry
            {
                Id = Guid.NewGuid().ToString("N"),
                UserId = ctx.UserId!,
                Name = string.IsNullOrWhiteSpace(body.Name) ? VaultStoreService.EndpointOf(body.VaultUri) : body.Name.Trim(),
                Secret = protector.Protect(body.VaultUri.Trim()),
                CreatedAt = DateTime.UtcNow,
            };
            db.VaultRegistries.Add(reg);
            await db.SaveChangesAsync(ct);
            return Results.Ok(new VaultRegistryDto(reg.Id, reg.Name, VaultStoreService.EndpointOf(body.VaultUri.Trim())));
        });

        api.MapDelete("/vault-registries/{id}", async (string id, AdoContext ctx, AppDbContext db, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) return Results.Unauthorized();
            await db.VaultRegistries.Where(r => r.Id == id && r.UserId == ctx.UserId).ExecuteDeleteAsync(ct);
            return Results.NoContent();
        });

        // Secret NAMES only — values are never returned here.
        api.MapGet("/vault-registries/{id}/secrets", async (
            string id, AdoContext ctx, AppDbContext db, PatProtector protector, VaultStoreService store, CancellationToken ct) =>
        {
            var uri = await ResolveUri(id, ctx, db, protector);
            if (uri is null) return Results.NotFound();
            try { return Results.Ok(await store.ListNamesAsync(uri, ct)); }
            catch (VaultStoreService.VaultException ex) { return Results.Json(new { error = ex.Message }, statusCode: 502); }
        });

        // A single secret's value — fetched only when the user reveals it.
        api.MapGet("/vault-registries/{id}/secrets/{name}", async (
            string id, string name, AdoContext ctx, AppDbContext db, PatProtector protector, VaultStoreService store, CancellationToken ct) =>
        {
            var uri = await ResolveUri(id, ctx, db, protector);
            if (uri is null) return Results.NotFound();
            try { return Results.Ok(new VaultSecretValueDto(name, await store.GetSecretAsync(uri, name, ct))); }
            catch (VaultStoreService.VaultException ex) { return Results.Json(new { error = ex.Message }, statusCode: 502); }
        });
    }

    private static async Task<string?> ResolveUri(string id, AdoContext ctx, AppDbContext db, PatProtector protector)
    {
        if (!ctx.IsAuthenticated) return null;
        var reg = await db.VaultRegistries.FirstOrDefaultAsync(r => r.Id == id && r.UserId == ctx.UserId);
        if (reg is null) return null;
        try { return protector.Unprotect(reg.Secret); } catch { return null; }
    }

    private static string SafeUri(VaultRegistry r, PatProtector protector)
    {
        try { return VaultStoreService.EndpointOf(protector.Unprotect(r.Secret)); }
        catch { return "(unavailable)"; }
    }
}
