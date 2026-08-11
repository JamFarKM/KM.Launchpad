using System.Collections.Concurrent;
using System.Text.Json;
using PipelineLaunchpad.Server.Data;
using PipelineLaunchpad.Server.Models;

namespace PipelineLaunchpad.Server.Services;

/// <summary>
/// Executes pipeline sequences server-side: triggers each step, waits for it to
/// finish, injects the previous run into the next step per its link mode, and
/// stops the whole sequence if any step does not succeed. Runs detached from the
/// request so a closed browser doesn't interrupt it.
/// </summary>
public class SequenceRunner(IServiceScopeFactory scopeFactory, ILogger<SequenceRunner> log)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan StepTimeout = TimeSpan.FromHours(1);

    private readonly ConcurrentDictionary<string, CancellationTokenSource> _running = new();

    public void Start(string sequenceRunId, string org, string pat)
    {
        var cts = new CancellationTokenSource();
        _running[sequenceRunId] = cts;
        _ = Task.Run(() => ExecuteAsync(sequenceRunId, org, pat, cts.Token));
    }

    public bool Cancel(string sequenceRunId) =>
        _running.TryGetValue(sequenceRunId, out var cts) && Try(() => cts.Cancel());

    private async Task ExecuteAsync(string runId, string org, string pat, CancellationToken ct)
    {
        try
        {
            using var scope = scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var adoCtx = scope.ServiceProvider.GetRequiredService<AdoContext>();
            adoCtx.Org = org;
            adoCtx.Pat = pat;
            var ado = scope.ServiceProvider.GetRequiredService<AdoService>();

            var run = await db.SequenceRuns.FindAsync([runId], ct);
            if (run is null) return;

            var steps = JsonSerializer.Deserialize<List<SequenceRunStepDto>>(run.StepsJson, Json) ?? new();
            var def = JsonSerializer.Deserialize<List<SequenceStepDto>>(
                (await db.Sequences.FindAsync([run.SequenceId], ct))?.StepsJson ?? "[]", Json) ?? new();

            RunDto? previous = null;

            for (var i = 0; i < steps.Count && i < def.Count; i++)
            {
                if (ct.IsCancellationRequested) { await FinishAsync(db, run, steps, "canceled", i, ct); return; }

                var step = def[i];
                steps[i] = steps[i] with { State = "running", StartedAt = DateTime.UtcNow };
                await SaveAsync(db, run, steps, "running", ct);

                RunDto triggered;
                try
                {
                    var branch = step.Branch;
                    if (string.IsNullOrWhiteSpace(branch))
                        branch = await ado.GetDefaultBranchAsync(step.Project, step.PipelineId, ct) ?? "main";

                    var tps = new Dictionary<string, string>(step.TemplateParameters ?? new());
                    var vars = new Dictionary<string, string>(step.Variables ?? new());
                    var resources = new Dictionary<string, string>();
                    ApplyLink(step.Link, previous, tps, vars, resources);

                    triggered = await ado.RunPipelineAsync(
                        step.Project, step.PipelineId, branch!, tps, vars,
                        resources.Count > 0 ? resources : null, ct);
                }
                catch (Exception ex)
                {
                    steps[i] = steps[i] with { State = "completed", Result = "failed", FinishedAt = DateTime.UtcNow, Message = Trim(ex.Message) };
                    await FinishAsync(db, run, steps, "failed", i + 1, ct);
                    return;
                }

                steps[i] = steps[i] with { BuildId = triggered.Id, WebUrl = triggered.WebUrl, State = triggered.State };
                await SaveAsync(db, run, steps, "running", ct);

                var final = await PollToTerminalAsync(ado, step.Project, triggered.Id, steps, i, db, run, ct);
                if (final is null) { await FinishAsync(db, run, steps, "canceled", i + 1, ct); return; }

                steps[i] = steps[i] with
                {
                    State = "completed",
                    Result = final.Result,
                    WebUrl = final.WebUrl,
                    FinishedAt = final.FinishTime ?? DateTime.UtcNow,
                };

                if (!string.Equals(final.Result, "succeeded", StringComparison.OrdinalIgnoreCase))
                {
                    await FinishAsync(db, run, steps, "failed", i + 1, ct);
                    return;
                }

                previous = final;
                await SaveAsync(db, run, steps, "running", ct);
            }

            await FinishAsync(db, run, steps, "succeeded", steps.Count, ct);
        }
        catch (Exception ex)
        {
            log.LogError(ex, "Sequence run {RunId} crashed", runId);
        }
        finally
        {
            _running.TryRemove(runId, out _);
        }
    }

    private async Task<RunDto?> PollToTerminalAsync(
        AdoService ado, string project, int buildId,
        List<SequenceRunStepDto> steps, int i, AppDbContext db, SequenceRun run, CancellationToken ct)
    {
        var deadline = DateTime.UtcNow + StepTimeout;
        while (true)
        {
            if (ct.IsCancellationRequested) return null;
            RunDto current;
            try { current = await ado.GetRunAsync(project, buildId, ct); }
            catch { await DelayAsync(ct); if (ct.IsCancellationRequested) return null; continue; }

            if (current.State != steps[i].State)
            {
                steps[i] = steps[i] with { State = current.State, WebUrl = current.WebUrl };
                await SaveAsync(db, run, steps, "running", ct);
            }

            if (current.State == "completed") return current;
            if (DateTime.UtcNow > deadline)
                return current with { Result = "failed" };

            await DelayAsync(ct);
        }
    }

    private static void ApplyLink(
        StepLinkDto? link, RunDto? previous,
        Dictionary<string, string> tps, Dictionary<string, string> vars, Dictionary<string, string> resources)
    {
        if (link is null || previous is null || string.IsNullOrWhiteSpace(link.Key)) return;
        switch (link.Mode)
        {
            case "resource":
                resources[link.Key!] = previous.BuildNumber ?? previous.Id.ToString();
                break;
            case "parameter":
                tps[link.Key!] = previous.Id.ToString();
                break;
            case "variable":
                vars[link.Key!] = previous.Id.ToString();
                break;
        }
    }

    private static async Task SaveAsync(
        AppDbContext db, SequenceRun run, List<SequenceRunStepDto> steps, string status, CancellationToken ct)
    {
        run.StepsJson = JsonSerializer.Serialize(steps, Json);
        run.Status = status;
        await db.SaveChangesAsync(ct);
    }

    private static async Task FinishAsync(
        AppDbContext db, SequenceRun run, List<SequenceRunStepDto> steps, string status, int fromIndex, CancellationToken ct)
    {
        for (var j = fromIndex; j < steps.Count; j++)
            if (steps[j].State == "pending")
                steps[j] = steps[j] with { State = "skipped" };
        run.StepsJson = JsonSerializer.Serialize(steps, Json);
        run.Status = status;
        run.FinishedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(CancellationToken.None);
    }

    private static async Task DelayAsync(CancellationToken ct)
    {
        try { await Task.Delay(PollInterval, ct); } catch (OperationCanceledException) { }
    }

    private static string Trim(string s) => s.Length > 300 ? s[..300] : s;
    private static bool Try(Action a) { try { a(); return true; } catch { return false; } }
}
