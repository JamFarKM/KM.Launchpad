using PipelineLaunchpad.Server.Services;

namespace PipelineLaunchpad.Server.Endpoints;

public static class ImportExportEndpoints
{
    public static void MapImportExport(this WebApplication app)
    {
        var api = app.MapGroup("/api");

        // Replace the user's dashboards + sequences from an uploaded config file.
        api.MapPost("/import", async (HttpRequest http, string? format, AdoContext ctx, ConfigService cfg, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) return Results.Json(new { error = "Not connected to Azure DevOps." }, statusCode: 401);

            using var reader = new StreamReader(http.Body);
            var text = await reader.ReadToEndAsync(ct);
            if (string.IsNullOrWhiteSpace(text))
                return Results.BadRequest(new { error = "The configuration file was empty." });

            try
            {
                var doc = ConfigService.Parse(text, format);
                var (sequences, views) = await cfg.ReplaceAsync(ctx.UserId!, doc, ct);
                return Results.Ok(new { sequences, views });
            }
            catch (ConfigService.ConfigException ex)
            {
                return Results.BadRequest(new { error = ex.Message });
            }
        });

        // Export the user's current dashboards + sequences as a portable JSON config.
        api.MapGet("/export", async (AdoContext ctx, ConfigService cfg, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) return Results.Unauthorized();
            var doc = await cfg.ExportAsync(ctx.UserId!, ct);
            return Results.Ok(doc);
        });
    }
}
