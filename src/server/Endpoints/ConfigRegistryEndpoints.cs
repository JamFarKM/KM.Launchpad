using Microsoft.EntityFrameworkCore;
using PipelineLaunchpad.Server.Data;
using PipelineLaunchpad.Server.Models;
using PipelineLaunchpad.Server.Services;

namespace PipelineLaunchpad.Server.Endpoints;

public static class ConfigRegistryEndpoints
{
    public static void MapConfigRegistries(this WebApplication app)
    {
        var api = app.MapGroup("/api");

        api.MapGet("/config-registries", async (AdoContext ctx, AppDbContext db, PatProtector protector, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) return Results.Unauthorized();
            var regs = await db.ConfigRegistries.Where(r => r.UserId == ctx.UserId).OrderBy(r => r.Name).ToListAsync(ct);
            return Results.Ok(regs.Select(r => new ConfigRegistryDto(r.Id, r.Name, SafeEndpoint(r, protector))).ToList());
        });

        api.MapPost("/config-registries", async (
            UpsertConfigRegistryRequest body, AdoContext ctx, AppDbContext db, PatProtector protector, ConfigStoreService store, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) return Results.Unauthorized();
            if (string.IsNullOrWhiteSpace(body.Connection))
                return Results.BadRequest(new { error = "A connection string or endpoint URL is required." });

            // Validate by attempting a read before saving.
            try { await store.ListAsync(body.Connection.Trim(), ct); }
            catch (ConfigStoreService.ConfigStoreException ex)
            {
                return Results.BadRequest(new { error = $"Could not connect to that store: {ex.Message}" });
            }

            var reg = new ConfigRegistry
            {
                Id = Guid.NewGuid().ToString("N"),
                UserId = ctx.UserId!,
                Name = string.IsNullOrWhiteSpace(body.Name) ? ConfigStoreService.EndpointOf(body.Connection) : body.Name.Trim(),
                Secret = protector.Protect(body.Connection.Trim()),
                CreatedAt = DateTime.UtcNow,
            };
            db.ConfigRegistries.Add(reg);
            await db.SaveChangesAsync(ct);
            return Results.Ok(new ConfigRegistryDto(reg.Id, reg.Name, ConfigStoreService.EndpointOf(body.Connection.Trim())));
        });

        api.MapDelete("/config-registries/{id}", async (string id, AdoContext ctx, AppDbContext db, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) return Results.Unauthorized();
            await db.ConfigRegistries.Where(r => r.Id == id && r.UserId == ctx.UserId).ExecuteDeleteAsync(ct);
            return Results.NoContent();
        });

        api.MapGet("/config-registries/{id}/settings", async (
            string id, AdoContext ctx, AppDbContext db, PatProtector protector, ConfigStoreService store, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) return Results.Unauthorized();
            var reg = await db.ConfigRegistries.FirstOrDefaultAsync(r => r.Id == id && r.UserId == ctx.UserId, ct);
            if (reg is null) return Results.NotFound();

            string connection;
            try { connection = protector.Unprotect(reg.Secret); }
            catch { return Results.Json(new { error = "Stored credential could not be read (encryption key changed)." }, statusCode: 500); }

            try { return Results.Ok(await store.ListAsync(connection, ct)); }
            catch (ConfigStoreService.ConfigStoreException ex) { return Results.Json(new { error = ex.Message }, statusCode: 502); }
        });
    }

    private static string SafeEndpoint(ConfigRegistry r, PatProtector protector)
    {
        try { return ConfigStoreService.EndpointOf(protector.Unprotect(r.Secret)); }
        catch { return "(unavailable)"; }
    }
}
