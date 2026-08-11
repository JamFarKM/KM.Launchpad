using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using PipelineLaunchpad.Server.Data;
using PipelineLaunchpad.Server.Models;
using PipelineLaunchpad.Server.Services;

namespace PipelineLaunchpad.Server.Endpoints;

public static class SequenceEndpoints
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static void MapSequences(this WebApplication app)
    {
        var api = app.MapGroup("/api");

        // ---- CRUD ----
        api.MapGet("/sequences", async (AdoContext ctx, AppDbContext db, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) return Results.Unauthorized();
            var seqs = await db.Sequences.Where(s => s.UserId == ctx.UserId)
                .OrderBy(s => s.Name).ToListAsync(ct);
            return Results.Ok(seqs.Select(ToDto).ToList());
        });

        api.MapPost("/sequences", async (UpsertSequenceRequest body, AdoContext ctx, AppDbContext db, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) return Results.Unauthorized();
            var now = DateTime.UtcNow;
            var seq = new Sequence
            {
                Id = Guid.NewGuid().ToString("N"),
                UserId = ctx.UserId!,
                Name = body.Name.Trim(),
                StepsJson = JsonSerializer.Serialize(body.Steps ?? new(), Json),
                CreatedAt = now,
                UpdatedAt = now,
            };
            db.Sequences.Add(seq);
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToDto(seq));
        });

        api.MapPut("/sequences/{id}", async (string id, UpsertSequenceRequest body, AdoContext ctx, AppDbContext db, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) return Results.Unauthorized();
            var seq = await db.Sequences.FirstOrDefaultAsync(s => s.Id == id && s.UserId == ctx.UserId, ct);
            if (seq is null) return Results.NotFound();
            seq.Name = body.Name.Trim();
            seq.StepsJson = JsonSerializer.Serialize(body.Steps ?? new(), Json);
            seq.UpdatedAt = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToDto(seq));
        });

        api.MapDelete("/sequences/{id}", async (string id, AdoContext ctx, AppDbContext db, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) return Results.Unauthorized();
            await db.Sequences.Where(s => s.Id == id && s.UserId == ctx.UserId).ExecuteDeleteAsync(ct);
            return Results.NoContent();
        });

        // ---- execution ----
        api.MapPost("/sequences/{id}/run", async (
            string id, AdoContext ctx, AppDbContext db, SequenceRunner runner, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) return Results.Json(new { error = "Not connected to Azure DevOps." }, statusCode: 401);
            var seq = await db.Sequences.FirstOrDefaultAsync(s => s.Id == id && s.UserId == ctx.UserId, ct);
            if (seq is null) return Results.NotFound();

            var steps = JsonSerializer.Deserialize<List<SequenceStepDto>>(seq.StepsJson, Json) ?? new();
            if (steps.Count == 0) return Results.BadRequest(new { error = "This sequence has no steps." });

            var runSteps = steps.Select((s, i) =>
                new SequenceRunStepDto(i, s.Project, s.PipelineId, s.Name, null, "pending", null, null, null, null, null)).ToList();

            var run = new SequenceRun
            {
                Id = Guid.NewGuid().ToString("N"),
                SequenceId = seq.Id,
                UserId = ctx.UserId!,
                Status = "running",
                StepsJson = JsonSerializer.Serialize(runSteps, Json),
                StartedAt = DateTime.UtcNow,
            };
            db.SequenceRuns.Add(run);
            await db.SaveChangesAsync(ct);

            runner.Start(run.Id, ctx.Org!, ctx.Pat!);
            return Results.Ok(ToRunDto(run));
        });

        api.MapGet("/sequences/{id}/runs", async (string id, int? top, AdoContext ctx, AppDbContext db, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) return Results.Unauthorized();
            var n = Math.Clamp(top ?? 5, 1, 50);
            var runs = await db.SequenceRuns
                .Where(r => r.SequenceId == id && r.UserId == ctx.UserId)
                .OrderByDescending(r => r.StartedAt).Take(n).ToListAsync(ct);
            return Results.Ok(runs.Select(ToRunDto).ToList());
        });

        api.MapGet("/sequence-runs/{runId}", async (string runId, AdoContext ctx, AppDbContext db, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) return Results.Unauthorized();
            var run = await db.SequenceRuns.FirstOrDefaultAsync(r => r.Id == runId && r.UserId == ctx.UserId, ct);
            return run is null ? Results.NotFound() : Results.Ok(ToRunDto(run));
        });

        api.MapPost("/sequence-runs/{runId}/cancel", async (string runId, AdoContext ctx, AppDbContext db, SequenceRunner runner, CancellationToken ct) =>
        {
            if (!ctx.IsAuthenticated) return Results.Unauthorized();
            var run = await db.SequenceRuns.FirstOrDefaultAsync(r => r.Id == runId && r.UserId == ctx.UserId, ct);
            if (run is null) return Results.NotFound();
            runner.Cancel(runId);
            return Results.NoContent();
        });
    }

    private static SequenceDto ToDto(Sequence s) =>
        new(s.Id, s.Name, JsonSerializer.Deserialize<List<SequenceStepDto>>(s.StepsJson, Json) ?? new());

    private static SequenceRunDto ToRunDto(SequenceRun r) =>
        new(r.Id, r.SequenceId, r.Status,
            JsonSerializer.Deserialize<List<SequenceRunStepDto>>(r.StepsJson, Json) ?? new(),
            r.StartedAt, r.FinishedAt);
}
