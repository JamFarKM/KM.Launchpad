using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using PipelineLaunchpad.Server.Data;
using PipelineLaunchpad.Server.Models;
using PipelineLaunchpad.Server.Services;

namespace PipelineLaunchpad.Server.Endpoints;

public static class ApiEndpoints
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static void MapApi(this WebApplication app)
    {
        var api = app.MapGroup("/api");

        // ---------------------------------------------------------- config
        api.MapGet("/config", (IConfiguration cfg) =>
            Results.Ok(new { defaultOrg = cfg["ADO_DEFAULT_ORG"] ?? "" }));

        // ------------------------------------------------------------ auth
        api.MapPost("/auth/connect", async (
            ConnectRequest body, HttpContext http, AppDbContext db,
            AdoService ado, PatProtector protector, IConfiguration cfg, CancellationToken ct) =>
        {
            var org = string.IsNullOrWhiteSpace(body.Org) ? cfg["ADO_DEFAULT_ORG"] : body.Org!.Trim();
            if (string.IsNullOrWhiteSpace(org))
                return Results.BadRequest(new { error = "An organization is required." });
            if (string.IsNullOrWhiteSpace(body.Pat))
                return Results.BadRequest(new { error = "A personal access token is required." });

            UserDto identity;
            try { identity = await ado.ValidateAsync(org, body.Pat.Trim(), ct); }
            catch (AdoService.AdoException ex) { return Results.Json(new { error = ex.Message }, statusCode: ex.Status); }

            var now = DateTime.UtcNow;
            var user = await db.Users.FindAsync([identity.Id], ct);
            if (user is null)
            {
                user = new AppUser { Id = identity.Id, CreatedAt = now };
                db.Users.Add(user);
            }
            user.DisplayName = identity.DisplayName;
            user.UniqueName = identity.UniqueName;
            user.Org = org;
            user.EncryptedPat = protector.Protect(body.Pat.Trim());
            user.UpdatedAt = now;

            var session = new Session
            {
                Token = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N"),
                UserId = user.Id,
                CreatedAt = now,
                LastSeenAt = now,
            };
            db.Sessions.Add(session);
            await db.SaveChangesAsync(ct);

            http.Response.Cookies.Append(SessionMiddleware.CookieName, session.Token, new CookieOptions
            {
                HttpOnly = true,
                SameSite = SameSiteMode.Lax,
                Secure = http.Request.IsHttps,
                Path = "/",
                Expires = now.AddDays(30),
            });

            return Results.Ok(identity);
        });

        api.MapGet("/auth/me", (AdoContext ctx, AppDbContext db) =>
        {
            if (!ctx.IsAuthenticated || ctx.UserId is null) return Results.Unauthorized();
            var u = db.Users.Find(ctx.UserId);
            return u is null
                ? Results.Unauthorized()
                : Results.Ok(new UserDto(u.Id, u.DisplayName, u.UniqueName, u.Org));
        });

        api.MapPost("/auth/disconnect", async (HttpContext http, AppDbContext db, CancellationToken ct) =>
        {
            if (http.Request.Cookies.TryGetValue(SessionMiddleware.CookieName, out var token))
            {
                await db.Sessions.Where(s => s.Token == token).ExecuteDeleteAsync(ct);
                http.Response.Cookies.Delete(SessionMiddleware.CookieName);
            }
            return Results.NoContent();
        });

        // ------------------------------------------------------- discovery
        api.MapGet("/projects", (AdoContext ctx, AdoService ado, CancellationToken ct) =>
            Guarded(ctx, () => ado.GetProjectsAsync(ct)));

        api.MapGet("/projects/{project}/pipelines", (string project, AdoContext ctx, AdoService ado, CancellationToken ct) =>
            Guarded(ctx, () => ado.GetPipelinesAsync(project, ct)));

        api.MapGet("/projects/{project}/pipelines/{id:int}", (string project, int id, AdoContext ctx, AdoService ado, CancellationToken ct) =>
            Guarded(ctx, () => ado.GetPipelineDetailAsync(project, id, ct)));

        // ------------------------------------------------------------ runs
        api.MapPost("/projects/{project}/pipelines/{id:int}/run", (
            string project, int id, RunRequest body, AdoContext ctx, AdoService ado, CancellationToken ct) =>
            Guarded(ctx, () => ado.RunPipelineAsync(project, id, body, ct)));

        api.MapGet("/projects/{project}/pipelines/{id:int}/runs", (
            string project, int id, int? top, AdoContext ctx, AdoService ado, CancellationToken ct) =>
            Guarded(ctx, () => ado.GetRunsAsync(project, id, Math.Clamp(top ?? 15, 1, 100), ct)));

        api.MapGet("/projects/{project}/runs/{buildId:int}", (
            string project, int buildId, AdoContext ctx, AdoService ado, CancellationToken ct) =>
            Guarded(ctx, () => ado.GetRunAsync(project, buildId, ct)));

        // Recent runs of an upstream pipeline (resolved by name) — for picking a resource artifact.
        api.MapGet("/projects/{project}/resource-runs", (
            string project, string name, int? top, AdoContext ctx, AdoService ado, CancellationToken ct) =>
            Guarded(ctx, () => ado.GetRunsByPipelineNameAsync(project, name, Math.Clamp(top ?? 15, 1, 50), ct)));

        api.MapGet("/projects/{project}/runs/{buildId:int}/logs", (
            string project, int buildId, AdoContext ctx, AdoService ado, CancellationToken ct) =>
            Guarded(ctx, () => ado.GetRunLogsAsync(project, buildId, ct)));

        api.MapGet("/projects/{project}/runs/{buildId:int}/logs/{logId:int}", (
            string project, int buildId, int logId, AdoContext ctx, AdoService ado, CancellationToken ct) =>
            Guarded(ctx, () => ado.GetLogContentAsync(project, buildId, logId, ct)));

        // --------------------------------------------------- pull requests
        api.MapGet("/projects/{project}/repos", (string project, AdoContext ctx, AdoService ado, CancellationToken ct) =>
            Guarded(ctx, () => ado.GetRepositoriesAsync(project, ct)));

        api.MapGet("/projects/{project}/repos/{repoId}/pullrequests", (
            string project, string repoId, string? status, int? top,
            AdoContext ctx, AdoService ado, CancellationToken ct) =>
            Guarded(ctx, () => ado.GetPullRequestsAsync(
                project, repoId, string.IsNullOrWhiteSpace(status) ? "active" : status,
                Math.Clamp(top ?? 30, 1, 100), ct)));

        api.MapGet("/projects/{project}/repos/{repoId}/pullrequests/{prId:int}/changes", (
            string project, string repoId, int prId, AdoContext ctx, AdoService ado, CancellationToken ct) =>
            Guarded(ctx, () => ado.GetPullRequestChangesAsync(project, repoId, prId, ct)));

        // Both sides of one file. Fetched in parallel; a missing side means the file was
        // added or deleted, and comes back as null for the diff to render as empty.
        api.MapGet("/projects/{project}/repos/{repoId}/filediff", async (
            string project, string repoId, string path, string beforeCommit, string afterCommit,
            AdoContext ctx, AdoService ado, CancellationToken ct) =>
            await Guarded(ctx, async () =>
            {
                var before = ado.GetFileAtCommitAsync(project, repoId, path, beforeCommit, ct);
                var after = ado.GetFileAtCommitAsync(project, repoId, path, afterCommit, ct);
                await Task.WhenAll(before, after);
                return new PrFileDiffDto(path, before.Result, after.Result);
            }));

        // ----------------------------------------------------------- views
        api.MapGet("/views", async (AdoContext ctx, AppDbContext db, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) return Results.Unauthorized();
            var views = await db.Views.Where(v => v.UserId == ctx.UserId)
                .OrderBy(v => v.SortOrder).ToListAsync(ct);
            return Results.Ok(views.Select(ToDto).ToList());
        });

        api.MapPost("/views", async (UpsertViewRequest body, AdoContext ctx, AppDbContext db, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) return Results.Unauthorized();
            var now = DateTime.UtcNow;
            var view = new SavedView
            {
                Id = Guid.NewGuid().ToString("N"),
                UserId = ctx.UserId!,
                Name = body.Name.Trim(),
                SortOrder = body.SortOrder,
                ItemsJson = SerializeLayout(body.Shelves, body.ShelfColors, body.ShelfLayout, body.Items),
                CreatedAt = now,
                UpdatedAt = now,
            };
            db.Views.Add(view);
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToDto(view));
        });

        api.MapPut("/views/{id}", async (string id, UpsertViewRequest body, AdoContext ctx, AppDbContext db, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) return Results.Unauthorized();
            var view = await db.Views.FirstOrDefaultAsync(v => v.Id == id && v.UserId == ctx.UserId, ct);
            if (view is null) return Results.NotFound();
            view.Name = body.Name.Trim();
            view.SortOrder = body.SortOrder;
            view.ItemsJson = SerializeLayout(body.Shelves, body.ShelfColors, body.ShelfLayout, body.Items);
            view.UpdatedAt = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToDto(view));
        });

        api.MapDelete("/views/{id}", async (string id, AdoContext ctx, AppDbContext db, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) return Results.Unauthorized();
            await db.Views.Where(v => v.Id == id && v.UserId == ctx.UserId).ExecuteDeleteAsync(ct);
            return Results.NoContent();
        });
    }

    private static async Task<IResult> Guarded<T>(AdoContext ctx, Func<Task<T>> fn)
    {
        if (!ctx.IsAuthenticated)
            return Results.Json(new { error = "Not connected to Azure DevOps." }, statusCode: 401);
        try { return Results.Ok(await fn()); }
        catch (AdoService.AdoException ex) { return Results.Json(new { error = ex.Message }, statusCode: ex.Status); }
    }

    // Layout (shelves + colours + grid placement + items) is stored in the single ItemsJson
    // column so no schema change is needed. Tolerates the legacy shape (bare array) and the
    // older object shape (which carried a now-removed ShelfWidths field — simply ignored).
    private record ViewLayout(List<string> Shelves, Dictionary<string, string>? ShelfColors, Dictionary<string, GridPosDto>? ShelfLayout, List<ViewItemDto> Items);

    private static string SerializeLayout(List<string>? shelves, Dictionary<string, string>? shelfColors, Dictionary<string, GridPosDto>? shelfLayout, List<ViewItemDto>? items) =>
        JsonSerializer.Serialize(new ViewLayout(shelves ?? new(), shelfColors ?? new(), shelfLayout ?? new(), items ?? new()), Json);

    private static SavedViewDto ToDto(SavedView v)
    {
        var json = (v.ItemsJson ?? "").TrimStart();
        List<string> shelves = new();
        Dictionary<string, string> shelfColors = new();
        Dictionary<string, GridPosDto> shelfLayout = new();
        List<ViewItemDto> items = new();
        if (json.StartsWith("["))
        {
            // legacy: bare array of items
            items = JsonSerializer.Deserialize<List<ViewItemDto>>(json, Json) ?? new();
        }
        else if (json.Length > 0)
        {
            var layout = JsonSerializer.Deserialize<ViewLayout>(json, Json);
            shelves = layout?.Shelves ?? new();
            shelfColors = layout?.ShelfColors ?? new();
            shelfLayout = layout?.ShelfLayout ?? new();
            items = layout?.Items ?? new();
        }
        return new SavedViewDto(v.Id, v.Name, v.SortOrder, shelves, shelfColors, shelfLayout, items);
    }
}
