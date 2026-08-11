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

    public void Start(string sequenceRunId, string org, string pat, Dictionary<string, string> inputs)
    {
        var cts = new CancellationTokenSource();
        _running[sequenceRunId] = cts;
        _ = Task.Run(() => ExecuteAsync(sequenceRunId, org, pat, inputs, cts.Token));
    }

    /// <summary>Stored sequence definition: pre-run inputs + run steps.</summary>
    public record SeqDef(List<SequenceInputDto> Inputs, List<SequenceStepDto> Steps);

    public static SeqDef ParseDef(string? json)
    {
        var t = (json ?? "").TrimStart();
        if (t.StartsWith("["))
            return new SeqDef(new(), JsonSerializer.Deserialize<List<SequenceStepDto>>(t, Json) ?? new());
        if (t.Length == 0) return new SeqDef(new(), new());
        return JsonSerializer.Deserialize<SeqDef>(t, Json) ?? new SeqDef(new(), new());
    }

    public bool Cancel(string sequenceRunId) =>
        _running.TryGetValue(sequenceRunId, out var cts) && Try(() => cts.Cancel());

    private async Task ExecuteAsync(string runId, string org, string pat, Dictionary<string, string> inputOverrides, CancellationToken ct)
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

            // Needed so "smart" branch detection can identify the user's own branches.
            adoCtx.UniqueName = (await db.Users.FindAsync([run.UserId], ct))?.UniqueName;

            var steps = JsonSerializer.Deserialize<List<SequenceRunStepDto>>(run.StepsJson, Json) ?? new();
            var parsed = ParseDef((await db.Sequences.FindAsync([run.SequenceId], ct))?.StepsJson);
            var def = parsed.Steps;

            // Resolve pre-run inputs: caller overrides win over the stored defaults.
            var resolvedInputs = new Dictionary<string, string>();
            foreach (var input in parsed.Inputs)
                resolvedInputs[input.Id] = inputOverrides.TryGetValue(input.Id, out var ov) ? ov : (input.Default ?? "");

            // A branch input set to "smart" resolves to the user's most recent branch on its source pipeline's repo.
            foreach (var input in parsed.Inputs)
            {
                if (!resolvedInputs.TryGetValue(input.Id, out var v) || v != AdoService.SmartBranch) continue;
                resolvedInputs[input.Id] =
                    (input.SourcePipelineId is int pid && !string.IsNullOrEmpty(input.SourceProject)
                        ? await ado.GetMyRecentBranchAsync(input.SourceProject, pid, ct)
                        : null) ?? "";
            }

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
                    // Branch: a pre-run input wins, else the step's branch (which may be the
                    // "smart" sentinel → the user's most recent branch), else the default.
                    string? branch = null;
                    if (!string.IsNullOrEmpty(step.BranchInputId) && resolvedInputs.TryGetValue(step.BranchInputId, out var bIn) && bIn != "")
                        branch = bIn;
                    branch ??= step.Branch;
                    if (branch == AdoService.SmartBranch)
                        branch = await ado.GetMyRecentBranchAsync(step.Project, step.PipelineId, ct);
                    if (string.IsNullOrWhiteSpace(branch))
                        branch = await ado.GetDefaultBranchAsync(step.Project, step.PipelineId, ct) ?? "main";

                    var tps = new Dictionary<string, string>(step.TemplateParameters ?? new());
                    var vars = new Dictionary<string, string>(step.Variables ?? new());
                    var resources = new Dictionary<string, string>();
                    var containers = new Dictionary<string, string>();

                    // Bindings: pre-run input values plugged into this step's params/variables.
                    foreach (var b in step.Bindings ?? new())
                    {
                        if (!resolvedInputs.TryGetValue(b.InputId, out var val) || val == "") continue;
                        if (b.Target == "variable") vars[b.Name] = val;
                        else tps[b.Name] = val;
                    }

                    ApplyLink(step.Link, previous, tps, vars, resources, containers);

                    triggered = await ado.RunPipelineAsync(
                        step.Project, step.PipelineId, branch!, tps, vars,
                        resources.Count > 0 ? resources : null,
                        containers.Count > 0 ? containers : null, ct);
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
            await SafeMarkFailedAsync(runId, ex.Message);
        }
        finally
        {
            _running.TryRemove(runId, out _);
        }
    }

    /// <summary>Best-effort: finalize a run as failed if the runner crashed mid-flight.</summary>
    private async Task SafeMarkFailedAsync(string runId, string message)
    {
        try
        {
            using var scope = scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var run = await db.SequenceRuns.FindAsync(runId);
            if (run is null || run.Status != "running") return;

            var steps = JsonSerializer.Deserialize<List<SequenceRunStepDto>>(run.StepsJson, Json) ?? new();
            for (var i = 0; i < steps.Count; i++)
            {
                var s = steps[i];
                if (s.State is "running" or "inProgress" or "notStarted")
                    steps[i] = s with { State = "completed", Result = "failed", Message = Trim(message), FinishedAt = DateTime.UtcNow };
                else if (s.State == "pending")
                    steps[i] = s with { State = "skipped" };
            }
            run.StepsJson = JsonSerializer.Serialize(steps, Json);
            run.Status = "failed";
            run.FinishedAt = DateTime.UtcNow;
            await db.SaveChangesAsync();
        }
        catch { /* nothing more we can do */ }
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
        Dictionary<string, string> tps, Dictionary<string, string> vars,
        Dictionary<string, string> resources, Dictionary<string, string> containers)
    {
        if (link is null || previous is null || string.IsNullOrWhiteSpace(link.Key)) return;

        // The value passed for parameter/variable/container modes. "tag" composes the image
        // tag the way a build does: <SourceBranchName>.<BuildNumber> (last branch segment + build number).
        static string LastSeg(string? b) => string.IsNullOrEmpty(b) ? "" : b.Split('/')[^1];
        var value = link.Source switch
        {
            "buildNumber" => previous.BuildNumber ?? previous.Id.ToString(),
            "tag" => $"{LastSeg(previous.Branch)}.{previous.BuildNumber}",
            "branch" => previous.Branch ?? "",
            _ => previous.Id.ToString(), // runId (default)
        };

        switch (link.Mode)
        {
            case "resource":
                // ADO pipeline resources are versioned by the run's name (build number).
                resources[link.Key!] = previous.BuildNumber ?? previous.Id.ToString();
                break;
            case "container":
                // Container resources are versioned by image tag (e.g. branch.buildNumber).
                containers[link.Key!] = value;
                break;
            case "parameter":
                tps[link.Key!] = value;
                break;
            case "variable":
                vars[link.Key!] = value;
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
